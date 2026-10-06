import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { parseProviderUsage, recordAiUsageEvent, type TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiCredentialResolverService } from '../ai-credentials/ai-credential-resolver.service.js';
import { LlmCompletionService } from '../engagement/llm-completion.service.js';
import { extractJsonObject } from '../engagement/generation/json-extract.js';

/**
 * Resolves Deepgram diarization labels ("0", "1", …) on the one canonical
 * public transcript to real people, using the committee roster, the witness
 * list and the transcript's own cues (introductions, recognitions, titles).
 * Global enrichment: one row per (capture, label); manual renames always win.
 */

export const TERMINAL_CAPTURE_STATES = new Set([
  'COMPLETE',
  'COMPLETE_WITH_GAPS',
  'FAILED',
  'CANCELED',
  'BLOCKED',
]);

const ACTIVE_RERUN_INTERVAL_MS = 10 * 60_000;
const ATTEMPT_BACKOFF_MS = 10 * 60_000;
const MAX_SEGMENTS = 20_000;
const MAX_TURNS = 60;
const MAX_TURN_CHARS = 400;
const MAX_TOTAL_CHARS = 24_000;
const MIN_CONFIDENCE = 0.8;
const MIN_CONFIDENCE_OUTSIDE_ROSTER = 0.8;

const CUE =
  /chair(man|woman|person)?|ranking member|senator|congress(wo)?man|representative|\b(mr|ms|mrs|dr)\.|recogni[sz]e|yield|gentle(man|woman|lady) from|my name is|\bi am\b|\bi'm\b|the witness|testif|director|secretary|commissioner|mayor|governor/i;

export interface RosterEntry {
  name: string;
  role: string | null;
  personRef: string | null;
  party?: string | null;
}

export interface HearingRoster {
  members: RosterEntry[];
  witnesses: string[];
}

export interface SpeakerRecord {
  speakerLabel: string;
  displayName: string;
  role: string | null;
  personRef: string | null;
  confidence: number | null;
  source: 'llm' | 'manual';
}

export interface SpeakerTurn {
  label: string;
  sequence: number;
  startMs: number;
  text: string;
}

interface CaptureRow {
  id: string;
  hearingId: string;
  domainStatus: string | null;
  speakersResolvedAt: Date | null;
  throughSequence: number | null;
}

interface SegmentRow {
  sequence: number;
  startMs: number;
  text: string;
  speakerLabel: string | null;
}

interface RosterHearingRow {
  committeeSystemCode: string | null;
  subcommitteeSystemCode: string | null;
  stateCommitteeId: string | null;
  witnesses: string[];
}

export function isDiarizationIndex(label: string | null | undefined): boolean {
  return /^\d+$/.test((label ?? '').trim());
}

export function isAttributionDue(input: {
  capture: Pick<CaptureRow, 'domainStatus' | 'speakersResolvedAt' | 'throughSequence'>;
  maxSequence: number;
  unresolvedLabels: number;
  now: Date;
}): boolean {
  if (input.unresolvedLabels === 0) return false;
  const { capture } = input;
  if (!capture.speakersResolvedAt) return true;
  const newSegments = (capture.throughSequence ?? 0) < input.maxSequence;
  if (!newSegments) return false;
  const terminal = Boolean(capture.domainStatus && TERMINAL_CAPTURE_STATES.has(capture.domainStatus));
  if (terminal) return true;
  return input.now.getTime() - capture.speakersResolvedAt.getTime() >= ACTIVE_RERUN_INTERVAL_MS;
}

/** Contiguous same-label segments become one turn. */
export function groupTurns(segments: SegmentRow[]): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  for (const segment of segments) {
    const label = segment.speakerLabel?.trim();
    if (!label || !isDiarizationIndex(label)) continue;
    const text = segment.text.trim();
    if (!text) continue;
    const last = turns.at(-1);
    if (last && last.label === label) {
      last.text = `${last.text} ${text}`;
      continue;
    }
    turns.push({ label, sequence: segment.sequence, startMs: segment.startMs, text });
  }
  return turns;
}

/**
 * The turns worth showing the model: each label's first two turns plus the
 * turns carrying name cues (or immediately following one), bounded.
 */
export function selectCueTurns(turns: SpeakerTurn[]): SpeakerTurn[] {
  const perLabelCount = new Map<string, number>();
  const perLabelCues = new Map<string, number>();
  const picked = new Set<number>();
  turns.forEach((turn, index) => {
    const seen = perLabelCount.get(turn.label) ?? 0;
    perLabelCount.set(turn.label, seen + 1);
    if (seen < 2) {
      picked.add(index);
      return;
    }
    const previous = turns[index - 1];
    const cued = CUE.test(turn.text) || (previous ? CUE.test(previous.text.slice(-240)) : false);
    const cues = perLabelCues.get(turn.label) ?? 0;
    if (cued && cues < 6) {
      perLabelCues.set(turn.label, cues + 1);
      picked.add(index);
    }
  });
  const selected: SpeakerTurn[] = [];
  let total = 0;
  for (const index of [...picked].sort((a, b) => a - b)) {
    if (selected.length >= MAX_TURNS) break;
    const turn = turns[index]!;
    const text = turn.text.length > MAX_TURN_CHARS ? `${turn.text.slice(0, MAX_TURN_CHARS)}…` : turn.text;
    if (total + text.length > MAX_TOTAL_CHARS) break;
    total += text.length;
    selected.push({ ...turn, text });
  }
  return selected;
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    speakers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string' },
          displayName: { type: 'string' },
          role: { type: ['string', 'null'] },
          personRef: { type: ['string', 'null'] },
          confidence: { type: 'number' },
        },
        required: ['label', 'displayName', 'role', 'personRef', 'confidence'],
      },
    },
  },
  required: ['speakers'],
} as const;

const SYSTEM_PROMPT = [
  'You identify who each diarization label in a legislative hearing transcript is.',
  'Use only the roster, the witness list and cues in the transcript itself: chairs open the',
  'hearing and recognize members; members are addressed by title and name; witnesses introduce',
  'themselves and are introduced before testifying; "the Senator from <state>" resolves through',
  'the roster. Prefer the exact roster or witness name. Never invent a person.',
  'A generic diarization label is not an identity and roster order is not evidence.',
  'Identify a label only from an explicit self-introduction or an immediately preceding named introduction or recognition.',
  'Mentioning or thanking another person does not identify the speaker as that person. Omit uncertain or conflicting identifications.',
  'Return one entry per label you can identify; omit labels you cannot. Confidence is 0–1 and',
  'must reflect real evidence in the excerpts. personRef must be a roster personRef or null.',
].join(' ');

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(sen|senator|rep|representative|hon|honorable|dr|mr|ms|mrs|chair|chairman|chairwoman)\.?\b/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameMatches(candidate: string, known: string[]): boolean {
  const target = normalizeName(candidate);
  if (!target) return false;
  return known.some((name) => {
    const n = normalizeName(name);
    if (!n) return false;
    if (n === target) return true;
    const targetLast = target.split(' ').at(-1)!;
    const knownLast = n.split(' ').at(-1)!;
    return targetLast.length > 2 && targetLast === knownLast && (n.includes(target) || target.includes(n));
  });
}

/**
 * Which labels have at least one deterministic textual naming cue — this
 * label's own turn matches CUE, or the immediately preceding (possibly
 * different-speaker) turn does, e.g. a chair recognizing the next speaker.
 * Independent of confidence, this is the one non-model-reported signal that
 * an identification has any basis in the transcript at all.
 */
export function labelsWithNamingCue(turns: SpeakerTurn[]): Set<string> {
  const result = new Set<string>();
  turns.forEach((turn, index) => {
    if (CUE.test(turn.text)) {
      result.add(turn.label);
      return;
    }
    const previous = turns[index - 1];
    if (previous && CUE.test(previous.text.slice(-240))) result.add(turn.label);
  });
  return result;
}

/** Candidate-specific identity evidence, not merely a nearby title or roster match.
 * Deliberately conservative: transcription misspellings and uncertain handoffs
 * remain unidentified until reviewed rather than being silently corrected. */
export function hasExplicitSpeakerName(label: string, name: string, turns: SpeakerTurn[]): boolean {
  const normalized = normalizeName(name);
  const surname = normalizeName(name.includes(',') ? name.split(',')[0]! : name).split(' ').at(-1);
  if (!normalized || !surname || surname.length < 3) return false;
  const spoken = name.includes(',')
    ? normalizeName(`${name.split(',')[1]} ${name.split(',')[0]}`)
    : normalized;
  const names = [...new Set([normalized, spoken, surname])].map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const named = `(?:${names})\\b`;
  const self = new RegExp(`^(?:my name is|i am|i m)\\s+${named}`);
  const introduction = new RegExp(`\\b(?:recognize|recognise|next we have|welcome)\\s+(?:the\\s+)?${named}`);
  const recognition = new RegExp(`\\b${named}[^.!?]{0,120}\\b(?:you are recognized|you are recognised|you may begin|your opening statement)\\b`);
  return turns.some((turn, index) => {
    if (turn.label !== label) return false;
    if (turn.text.split(/(?<=[.!?])\s+/).some((sentence) => self.test(normalizeName(sentence)))) return true;
    const previous = turns[index - 1];
    if (!previous || previous.label === label) return false;
    // Keep sentence boundaries for the recognition pattern; normalizeName is
    // otherwise shared with official names so titles do not manufacture matches.
    const tail = previous.text.slice(-600).split(/(?<=[.!?])\s+/).map(normalizeName).filter(Boolean).at(-1) ?? '';
    return tail === surname || tail === normalized || introduction.test(tail) || recognition.test(tail);
  });
}

export function acceptSpeakerEntries(
  raw: unknown,
  labels: Set<string>,
  roster: HearingRoster,
  turns: SpeakerTurn[],
): Array<Omit<SpeakerRecord, 'source'>> {
  const entries = Array.isArray((raw as { speakers?: unknown })?.speakers)
    ? ((raw as { speakers: unknown[] }).speakers as Array<Record<string, unknown>>)
    : [];
  const known = [...roster.members.map((m) => m.name), ...roster.witnesses];
  const accepted = new Map<string, Omit<SpeakerRecord, 'source'>>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const label = String(entry.label ?? '').trim();
    const displayName = String(entry.displayName ?? '').trim().slice(0, 120);
    const confidence = Number(entry.confidence);
    if (!labels.has(label) || !displayName || !Number.isFinite(confidence)) continue;
    // Confidence is entirely self-reported by the model; never accept an
    // identification with no independent textual basis, however confident
    // the model claims to be.
    if (!hasExplicitSpeakerName(label, displayName, turns)) continue;
    const inRoster = nameMatches(displayName, known);
    if (confidence < (inRoster ? MIN_CONFIDENCE : MIN_CONFIDENCE_OUTSIDE_ROSTER)) continue;
    const role = typeof entry.role === 'string' && entry.role.trim() ? entry.role.trim().slice(0, 80) : null;
    const personRefRaw = typeof entry.personRef === 'string' ? entry.personRef.trim() : '';
    const personRef = personRefRaw && roster.members.some((member) =>
      member.personRef === personRefRaw && nameMatches(displayName, [member.name])) ? personRefRaw : null;
    accepted.set(label, {
      speakerLabel: label,
      displayName,
      role,
      personRef,
      confidence: Math.min(1, Math.max(0, confidence)),
    });
  }
  return [...accepted.values()];
}

@Injectable()
export class HearingSpeakerAttributionService {
  private readonly logger = new Logger(HearingSpeakerAttributionService.name);
  private readonly inFlight = new Set<string>();
  private readonly attemptedAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: AiCredentialResolverService,
    private readonly llm: LlmCompletionService,
  ) {}

  /** Fire-and-forget from read paths; never throws. */
  resolveIfDue(hearingId: string): void {
    void this.resolve(hearingId, { force: false }).catch((error: unknown) => {
      this.logger.warn(
        `speaker attribution skipped for ${hearingId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async resolve(
    hearingId: string,
    input: { force: boolean; ctx?: TenantContext; now?: Date } = { force: false },
  ): Promise<{ resolved: number; ran: boolean; reason?: string }> {
    const now = input.now ?? new Date();
    const capture = await this.captureFor(hearingId);
    if (!capture) return { resolved: 0, ran: false, reason: 'no_capture' };
    if (this.inFlight.has(capture.id)) return { resolved: 0, ran: false, reason: 'in_flight' };
    // Claim the slot synchronously, immediately after the check above and
    // before any further `await` — otherwise concurrent callers for the same
    // capture (e.g. several browser tabs polling the same live hearing) can
    // all pass the has()-check before the first one's claim is recorded, and
    // each fires its own LLM call.
    this.inFlight.add(capture.id);
    try {
      const lastAttempt = this.attemptedAt.get(capture.id);
      if (!input.force && lastAttempt && now.getTime() - lastAttempt < ATTEMPT_BACKOFF_MS) {
        return { resolved: 0, ran: false, reason: 'backoff' };
      }

      const segments = await this.segments(capture.id);
      const turns = groupTurns(segments);
      const labels = new Set(turns.map((turn) => turn.label));
      if (!labels.size) return { resolved: 0, ran: false, reason: 'no_labels' };
      const existing = await this.speakerRows(capture.id);
      const unresolvedLabels = [...labels].filter((label) => !existing.has(label)).length;
      const maxSequence = segments.at(-1)?.sequence ?? 0;
      if (
        !input.force &&
        !isAttributionDue({ capture, maxSequence, unresolvedLabels, now })
      ) {
        return { resolved: 0, ran: false, reason: 'not_due' };
      }
      this.attemptedAt.set(capture.id, now.getTime());

      const cred = await this.credentials.resolveProvider(input.ctx ?? null, 'anthropic');
      if (!cred) return { resolved: 0, ran: false, reason: 'no_credential' };
      const roster = await this.loadRoster(hearingId);
      const excerpt = selectCueTurns(turns);
      const completion = await this.llm.complete({
        provider: 'anthropic',
        apiKey: cred.apiKey,
        model: cred.model,
        system: SYSTEM_PROMPT,
        userStatic: JSON.stringify({ roster: roster.members, witnesses: roster.witnesses }),
        userVolatile: [
          `Labels present: ${[...labels].join(', ')}.`,
          'Transcript excerpts:',
          ...excerpt.map((turn) => `[${clock(turn.startMs)}] Speaker ${turn.label}: ${turn.text}`),
        ].join('\n'),
        jsonSchema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
        jsonSchemaName: 'hearing_speakers',
        maxTokens: 1500,
        temperature: 0,
        timeoutMs: 60_000,
        cacheSystem: true,
      });
      const json = extractJsonObject(completion.text);
      const accepted = json
        ? acceptSpeakerEntries(JSON.parse(json), labels, roster, turns)
        : [];
      await this.persist(capture.id, accepted, maxSequence);
      // Recorded even on the fire-and-forget path (no ctx): real provider
      // spend needs a usage record regardless of who triggered it.
      await recordAiUsageEvent(
        { prisma: this.prisma, logger: this.logger },
        { tenantId: input.ctx?.tenantId ?? null, userId: input.ctx?.userId ?? null },
        'hearing_speaker_attribution',
        {
          provider: 'anthropic',
          model: cred.model,
          usage: parseProviderUsage(completion.raw),
          usedTenantKey: cred.usedTenantKey,
        },
      );
      return { resolved: accepted.length, ran: true };
    } finally {
      this.inFlight.delete(capture.id);
    }
  }

  async rename(
    hearingId: string,
    label: string,
    displayName: string,
    by: { tenantId: string; userId: string },
  ): Promise<SpeakerRecord> {
    const capture = await this.captureFor(hearingId);
    if (!capture) throw new NotFoundException('No capture exists for this proceeding.');
    const name = displayName.trim().slice(0, 120);
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO public_hearing_speaker
         (capture_id, speaker_label, display_name, role, person_ref, confidence, source, updated_by)
       VALUES ($1, $2, $3, NULL, NULL, 1, 'manual', $4)
       ON CONFLICT (capture_id, speaker_label) DO UPDATE SET
         display_name=EXCLUDED.display_name,
         role=EXCLUDED.role,
         person_ref=EXCLUDED.person_ref,
         confidence=1,
         source='manual',
         updated_by=EXCLUDED.updated_by,
         updated_at=now()`,
      capture.id,
      label.trim(),
      name,
      `${by.tenantId}:${by.userId}`.slice(0, 200),
    );
    return {
      speakerLabel: label.trim(),
      displayName: name,
      role: null,
      personRef: null,
      confidence: 1,
      source: 'manual',
    };
  }

  /** label → display name for a capture. */
  async speakerMap(captureId: string): Promise<Map<string, string>> {
    const rows = await this.speakerRows(captureId);
    const eligible = [...rows].filter(([, row]) => row.source === 'manual' ||
      (row.source === 'llm' && row.confidence != null && row.confidence >= MIN_CONFIDENCE));
    const turns = eligible.some(([, row]) => row.source !== 'manual')
      ? groupTurns(await this.segments(captureId)) : [];
    return new Map(eligible.filter(([label, row]) => row.source === 'manual' ||
      hasExplicitSpeakerName(label, row.displayName, turns)).map(([label, row]) => [label, row.displayName]));
  }

  async loadRoster(hearingId: string): Promise<HearingRoster> {
    const rows = await this.prisma.$queryRawUnsafe<RosterHearingRow[]>(
      `SELECT committee_system_code AS "committeeSystemCode",
              subcommittee_system_code AS "subcommitteeSystemCode",
              state_committee_id AS "stateCommitteeId",
              witnesses
       FROM committee_hearing WHERE id=$1 LIMIT 1`,
      hearingId,
    );
    const hearing = rows[0];
    if (!hearing) return { members: [], witnesses: [] };
    const members: RosterEntry[] = [];
    const codes = [hearing.committeeSystemCode, hearing.subcommitteeSystemCode].filter(
      (code): code is string => Boolean(code),
    );
    if (codes.length) {
      const memberships = await this.prisma.congressCommitteeMembership.findMany({
        where: { systemCode: { in: codes } },
        orderBy: [{ rank: 'asc' }],
      });
      const people = memberships.length
        ? await this.prisma.congressMember.findMany({
            where: { bioguideId: { in: [...new Set(memberships.map((m) => m.bioguideId))] } },
          })
        : [];
      const byId = new Map(people.map((p) => [p.bioguideId, p]));
      const seen = new Set<string>();
      for (const m of memberships) {
        if (seen.has(m.bioguideId)) continue;
        seen.add(m.bioguideId);
        const person = byId.get(m.bioguideId);
        members.push({
          name: person?.fullName ?? m.bioguideId,
          role: m.title ?? null,
          personRef: m.bioguideId,
          party: person?.party ?? null,
        });
      }
    }
    if (hearing.stateCommitteeId) {
      const memberships = await this.prisma.stateCommitteeMembership.findMany({
        where: { committeeId: hearing.stateCommitteeId },
        include: { legislator: true },
      });
      for (const m of memberships) {
        members.push({
          name: m.legislator.name,
          role: m.role ?? null,
          personRef: m.legislator.id,
          party: m.legislator.party ?? null,
        });
      }
    }
    return { members, witnesses: (hearing.witnesses ?? []).filter(Boolean) };
  }

  private async captureFor(hearingId: string): Promise<CaptureRow | null> {
    const rows = await this.prisma.$queryRawUnsafe<CaptureRow[]>(
      `SELECT id,
              hearing_id AS "hearingId",
              domain_status AS "domainStatus",
              speakers_resolved_at AS "speakersResolvedAt",
              speakers_resolved_through_sequence AS "throughSequence"
       FROM public_hearing_capture WHERE hearing_id=$1 LIMIT 1`,
      hearingId,
    );
    return rows[0] ?? null;
  }

  private async segments(captureId: string): Promise<SegmentRow[]> {
    return this.prisma.$queryRawUnsafe<SegmentRow[]>(
      `SELECT sequence, start_ms AS "startMs", text, speaker_label AS "speakerLabel"
       FROM public_hearing_transcript_segment
       WHERE capture_id=$1 AND is_final
       ORDER BY sequence ASC, id ASC
       LIMIT $2`,
      captureId,
      MAX_SEGMENTS,
    );
  }

  private async speakerRows(captureId: string): Promise<Map<string, SpeakerRecord>> {
    const rows = await this.prisma.$queryRawUnsafe<SpeakerRecord[]>(
      `SELECT speaker_label AS "speakerLabel", display_name AS "displayName", role,
              person_ref AS "personRef", confidence, source
       FROM public_hearing_speaker WHERE capture_id=$1`,
      captureId,
    );
    return new Map(rows.map((row) => [row.speakerLabel, row]));
  }

  private async persist(
    captureId: string,
    accepted: Array<Omit<SpeakerRecord, 'source'>>,
    throughSequence: number,
  ): Promise<void> {
    for (const entry of accepted) {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO public_hearing_speaker
           (capture_id, speaker_label, display_name, role, person_ref, confidence, source)
         VALUES ($1, $2, $3, $4, $5, $6, 'llm')
         ON CONFLICT (capture_id, speaker_label) DO UPDATE SET
           display_name=EXCLUDED.display_name,
           role=EXCLUDED.role,
           person_ref=EXCLUDED.person_ref,
           confidence=EXCLUDED.confidence,
           updated_at=now()
         WHERE public_hearing_speaker.source <> 'manual'`,
        captureId,
        entry.speakerLabel,
        entry.displayName,
        entry.role,
        entry.personRef,
        entry.confidence,
      );
    }
    await this.prisma.$executeRawUnsafe(
      `UPDATE public_hearing_capture
       SET speakers_resolved_at=now(), speakers_resolved_through_sequence=$2
       WHERE id=$1`,
      captureId,
      throughSequence,
    );
  }
}
