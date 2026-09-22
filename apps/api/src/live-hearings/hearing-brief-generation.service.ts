import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { parseProviderUsage, recordAiUsageEvent, type TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiCredentialResolverService } from '../ai-credentials/ai-credential-resolver.service.js';
import { LlmCompletionService } from '../engagement/llm-completion.service.js';
import { extractJsonObject } from '../engagement/generation/json-extract.js';
import { LegiWatchWave1Service } from './legiwatch-wave1.service.js';
import {
  HearingSpeakerAttributionService,
  groupTurns,
  isDiarizationIndex,
  type HearingRoster,
  type SpeakerTurn,
} from './hearing-speaker-attribution.service.js';

/**
 * One grounded, client-specific hearing brief: a preparation brief before the
 * proceeding, a recap brief once a transcript exists. The context packet is
 * assembled server-side from canonical data; the model only writes prose.
 */

export type HearingBriefMode = 'preparation' | 'recap';

export interface HearingBriefSection {
  name: string;
  content: string;
}

export interface HearingBriefResult {
  title: string;
  mode: HearingBriefMode;
  sections: HearingBriefSection[];
  keyMoments: Array<{ startMs?: number; speaker?: string; summary: string }>;
  sources: Array<Record<string, unknown>>;
  contextPacket: Record<string, unknown>;
  lowConfidence: boolean;
}

interface PrefillFinding {
  id: string;
  insightType: string;
  title: string | null;
  summary: string | null;
  evidenceText: string | null;
  speakerName: string | null;
  segmentId: string | null;
  startMs: number | null;
}

interface BriefPrefill {
  draft: { docTitle: string; client?: string };
  context: {
    hearing: Record<string, unknown> & { title: string; witnesses?: string[] };
    client: { id: string; name: string | null } | null;
    findings: PrefillFinding[];
  };
  sources: Array<Record<string, unknown>>;
}

interface ClientProfileRow {
  id: string;
  name: string;
  description: string | null;
  productDescription: string | null;
  sectorTag: string | null;
  issueCodes: string[];
  intakeData: unknown;
}

const RECAP_SECTIONS = [
  'Executive summary',
  'Key exchanges',
  'What it means for the client',
  'Positions on the record',
  'Commitments, deadlines and open questions',
  'Recommended next steps',
  'Sources and limitations',
];

const PREPARATION_SECTIONS = [
  'Hearing overview',
  'Why it matters to the client',
  'Members to watch',
  'Witnesses and expected positions',
  'Likely questions and suggested asks',
  'Preparation checklist',
  'Sources and limitations',
];

const MAX_EXCERPT_TURNS = 120;
const MAX_EXCERPT_CHARS = 30_000;
const MAX_TURN_CHARS = 600;
const MAX_INTAKE_CHARS = 4_000;
const MAX_FOCUS_CHARS = 600;

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string' }, content: { type: 'string' } },
        required: ['name', 'content'],
      },
    },
    keyMoments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          startMs: { type: ['number', 'null'] },
          speaker: { type: ['string', 'null'] },
          summary: { type: 'string' },
        },
        required: ['startMs', 'speaker', 'summary'],
      },
    },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'sections', 'keyMoments', 'sources'],
} as const;

const SYSTEM_PROMPT = [
  'You are a senior legislative analyst writing for a government-relations client.',
  'Write a professional brief grounded ONLY in the packet you are given: hearing facts,',
  'committee roster, witnesses, transcript excerpts (with timestamps) and the client profile.',
  'Cite transcript moments inline as [h:mm:ss] or [mm:ss]. Where the packet is silent, say so',
  'in one short sentence instead of inventing. Be specific about names, positions and asks.',
  'Direct prose, short paragraphs, "- " bullets where they aid scanning, **bold** sparingly.',
  'Do not repeat the section name inside its content. Produce every requested section, in order.',
  'Return JSON matching the schema.',
].join(' ');

export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function resolveSpeaker(label: string | null | undefined, map: Map<string, string>): string | null {
  const key = (label ?? '').trim();
  if (!key) return null;
  return map.get(key) ?? (isDiarizationIndex(key) ? null : key);
}

/** Findings' turns first, then an even sample of the rest, within the budget. */
export function selectBriefExcerpt(
  turns: SpeakerTurn[],
  findingStarts: number[],
  speakers: Map<string, string>,
): string[] {
  if (!turns.length) return [];
  const picked = new Set<number>();
  for (const start of findingStarts) {
    let best = -1;
    for (let i = 0; i < turns.length; i++) {
      if (turns[i]!.startMs <= start) best = i;
      else break;
    }
    if (best >= 0) picked.add(best);
  }
  const remaining = Math.max(0, MAX_EXCERPT_TURNS - picked.size);
  if (remaining > 0 && turns.length > picked.size) {
    const step = Math.max(1, Math.floor(turns.length / remaining));
    for (let i = 0; i < turns.length && picked.size < MAX_EXCERPT_TURNS; i += step) picked.add(i);
  }
  const lines: string[] = [];
  let total = 0;
  for (const index of [...picked].sort((a, b) => a - b)) {
    const turn = turns[index]!;
    const text = turn.text.length > MAX_TURN_CHARS ? `${turn.text.slice(0, MAX_TURN_CHARS)}…` : turn.text;
    const line = `[${clock(turn.startMs)}] ${resolveSpeaker(turn.label, speakers) ?? `Speaker ${Number(turn.label) + 1}`}: ${text}`;
    if (total + line.length > MAX_EXCERPT_CHARS) break;
    total += line.length;
    lines.push(line);
  }
  return lines;
}

export function normalizeSections(
  raw: unknown,
  expected: string[],
): { sections: HearingBriefSection[]; complete: boolean } {
  const provided = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  const byKey = new Map<string, string>();
  for (const item of provided) {
    const name = String(item?.name ?? '').trim();
    const content = String(item?.content ?? '').trim();
    if (name && content) byKey.set(name.toLowerCase(), content);
  }
  let complete = true;
  const sections = expected.map((name) => {
    const content = byKey.get(name.toLowerCase());
    if (!content) complete = false;
    return { name, content: content ?? 'The packet did not contain enough information for this section.' };
  });
  return { sections, complete };
}

@Injectable()
export class HearingBriefGenerationService {
  private readonly logger = new Logger(HearingBriefGenerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wave1: LegiWatchWave1Service,
    private readonly credentials: AiCredentialResolverService,
    private readonly llm: LlmCompletionService,
    private readonly speakers: HearingSpeakerAttributionService,
  ) {}

  async generate(
    ctx: TenantContext,
    hearingId: string,
    input: { clientId?: string; focus?: string },
  ): Promise<HearingBriefResult> {
    const prefill = (await this.wave1.buildBriefPrefill(ctx, hearingId, {
      clientId: input.clientId,
    })) as unknown as BriefPrefill;
    const client = input.clientId ? await this.clientProfile(ctx, input.clientId) : null;
    const cred = await this.credentials.resolveProvider(ctx, 'anthropic');
    if (!cred) {
      throw new ServiceUnavailableException('No AI credential is configured for this tenant.');
    }

    const capture = await this.captureFor(hearingId);
    let turns: SpeakerTurn[] = [];
    let speakerMap = new Map<string, string>();
    if (capture) {
      await this.speakers.resolve(hearingId, { force: false, ctx }).catch(() => undefined);
      [speakerMap, turns] = await Promise.all([
        this.speakers.speakerMap(capture.id),
        this.segments(capture.id).then(groupTurns),
      ]);
    }
    const roster = await this.speakers.loadRoster(hearingId);
    const mode: HearingBriefMode = turns.length ? 'recap' : 'preparation';
    const clientName = client?.name ?? prefill.context.client?.name ?? 'the client';
    const expected = (mode === 'recap' ? RECAP_SECTIONS : PREPARATION_SECTIONS).map((name) =>
      name.replace('the client', clientName),
    );
    const findings = prefill.context.findings.map((finding) => ({
      ...finding,
      speakerName: resolveSpeaker(finding.speakerName, speakerMap),
    }));
    const excerpt = selectBriefExcerpt(
      turns,
      findings.map((f) => f.startMs).filter((v): v is number => typeof v === 'number'),
      speakerMap,
    );
    const focus = (input.focus ?? '').trim().slice(0, MAX_FOCUS_CHARS);

    const packet = {
      mode,
      hearing: prefill.context.hearing,
      client: client
        ? {
            id: client.id,
            name: client.name,
            description: client.description,
            productDescription: client.productDescription,
            sectorTag: client.sectorTag,
            issueCodes: client.issueCodes,
            intake: boundedJson(client.intakeData, MAX_INTAKE_CHARS),
          }
        : prefill.context.client,
      roster: roster.members,
      witnesses: roster.witnesses.length ? roster.witnesses : (prefill.context.hearing.witnesses ?? []),
      findings,
      transcriptExcerpt: excerpt,
      focus: focus || null,
    };

    let sections: HearingBriefSection[] = [];
    let keyMoments: HearingBriefResult['keyMoments'] = [];
    let modelSources: string[] = [];
    let title = prefill.draft.docTitle;
    let lowConfidence = false;
    let raw: Record<string, unknown> = {};
    try {
      const completion = await this.llm.complete({
        provider: 'anthropic',
        apiKey: cred.apiKey,
        model: cred.model,
        system: SYSTEM_PROMPT,
        userStatic: JSON.stringify({
          client: packet.client,
          hearing: packet.hearing,
          roster: packet.roster,
          witnesses: packet.witnesses,
        }),
        userVolatile: [
          mode === 'recap'
            ? `Write a RECAP brief of this hearing for ${clientName}, grounded in the transcript excerpts and findings below.`
            : `Write a PREPARATION brief for ${clientName} ahead of this hearing. No transcript exists yet; ground it in the agenda, roster, witnesses and client profile, and be explicit about what is not yet known.`,
          `Sections, in order: ${expected.join(' | ')}.`,
          focus ? `Client focus for this brief: ${focus}` : '',
          `Matched findings: ${JSON.stringify(findings)}`,
          excerpt.length ? `Transcript excerpts:\n${excerpt.join('\n')}` : 'Transcript excerpts: none.',
        ]
          .filter(Boolean)
          .join('\n\n'),
        jsonSchema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
        jsonSchemaName: 'hearing_brief',
        maxTokens: 4000,
        temperature: 0.3,
        timeoutMs: 120_000,
        cacheSystem: true,
        cacheUserStatic: true,
      });
      raw = completion.raw;
      const json = extractJsonObject(completion.text);
      const parsed = json ? (JSON.parse(json) as Record<string, unknown>) : {};
      const normalized = normalizeSections(parsed.sections, expected);
      sections = normalized.sections;
      lowConfidence = !normalized.complete || completion.truncated;
      title = String(parsed.title ?? '').trim().slice(0, 200) || title;
      keyMoments = Array.isArray(parsed.keyMoments)
        ? (parsed.keyMoments as Array<Record<string, unknown>>)
            .filter((m) => m && typeof m.summary === 'string' && m.summary.trim())
            .slice(0, 12)
            .map((m) => ({
              ...(typeof m.startMs === 'number' ? { startMs: m.startMs } : {}),
              ...(typeof m.speaker === 'string' && m.speaker ? { speaker: m.speaker } : {}),
              summary: String(m.summary).trim().slice(0, 400),
            }))
        : [];
      modelSources = Array.isArray(parsed.sources)
        ? (parsed.sources as unknown[]).filter((s): s is string => typeof s === 'string').slice(0, 20)
        : [];
    } catch (error) {
      this.logger.warn(
        `hearing brief generation failed for ${hearingId} (${error instanceof Error ? error.message : String(error)}); using scaffold`,
      );
      sections = scaffold(expected, prefill, findings, mode);
      lowConfidence = true;
    }

    await recordAiUsageEvent(
      { prisma: this.prisma, logger: this.logger },
      { tenantId: ctx.tenantId, userId: ctx.userId },
      'hearing_brief',
      {
        provider: 'anthropic',
        model: cred.model,
        usage: parseProviderUsage(raw),
        usedTenantKey: cred.usedTenantKey,
      },
    );

    return {
      title,
      mode,
      sections,
      keyMoments,
      sources: [
        ...prefill.sources,
        ...modelSources.map((label) => ({ kind: 'model_cited', label })),
      ],
      contextPacket: packet,
      lowConfidence,
    };
  }

  private async clientProfile(ctx: TenantContext, clientId: string): Promise<ClientProfileRow | null> {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId },
        select: {
          id: true,
          name: true,
          description: true,
          productDescription: true,
          sectorTag: true,
          issueCodes: true,
          intakeData: true,
        },
      }),
    );
  }

  private async captureFor(hearingId: string): Promise<{ id: string } | null> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM public_hearing_capture WHERE hearing_id=$1 LIMIT 1`,
      hearingId,
    );
    return rows[0] ?? null;
  }

  private async segments(captureId: string) {
    return this.prisma.$queryRawUnsafe<
      Array<{ sequence: number; startMs: number; text: string; speakerLabel: string | null }>
    >(
      `SELECT sequence, start_ms AS "startMs", text, speaker_label AS "speakerLabel"
       FROM public_hearing_transcript_segment
       WHERE capture_id=$1 AND is_final
       ORDER BY sequence ASC, id ASC
       LIMIT 20000`,
      captureId,
    );
  }
}

function boundedJson(value: unknown, limit: number): string | null {
  if (value == null) return null;
  try {
    const text = JSON.stringify(value);
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  } catch {
    return null;
  }
}

function scaffold(
  expected: string[],
  prefill: BriefPrefill,
  findings: PrefillFinding[],
  mode: HearingBriefMode,
): HearingBriefSection[] {
  const hearing = prefill.context.hearing;
  const overview = [
    `${hearing.title}`,
    [hearing.committeeName, hearing.chamber, hearing.calendarDate].filter(Boolean).join(' · '),
    `Status: ${String(hearing.eventStatus ?? 'unknown')}.`,
  ].join('\n\n');
  const findingLines = findings.length
    ? findings
        .map(
          (f) =>
            `- ${f.title ?? f.insightType}${f.speakerName ? ` — ${f.speakerName}` : ''}${f.startMs != null ? ` [${clock(f.startMs)}]` : ''}: ${f.summary ?? f.evidenceText ?? ''}`.trim(),
        )
        .join('\n')
    : 'No matched findings were available.';
  return expected.map((name, index) => ({
    name,
    content:
      index === 0
        ? overview
        : /exchange|position|commitment/i.test(name)
          ? findingLines
          : `Automatic drafting was unavailable for this ${mode} brief. Review the sources and complete this section.`,
  }));
}
