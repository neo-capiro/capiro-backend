import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AiCredentialService, type ResolvedAiCredential } from '../generation/ai-credential.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assembleUnitPrompt, parseUnitOutput, type UnitPromptInput } from './generation-prompt.js';
import {
  DEFAULT_LOOKBACK_DAYS,
  buildCarryUnits,
  effectiveCarry,
  toThreadRef,
} from './hillday-context.service.js';
import { HillDaySourceService, type MessageRow, type StrategyRow } from './hillday-source.service.js';
import type {
  CalendarEvent,
  JobEvent,
  JobStatus,
  JobUnit,
  MeetingContextRecord,
  MeetingResolution,
  MeetingSection,
  SectionFlag,
  SourceSet,
  SourceStatus,
} from './hillday.types.js';
import { confirmationReason, emptyOffice, normalizeAddress, rollUpMeeting } from './resolution.rules.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const UNIT_TIMEOUT_MS = 90_000;
const UNIT_MAX_TOKENS = 1600;
/** Two units in flight: keeps a 12-meeting week under a minute without 429s. */
const UNIT_CONCURRENCY = 2;
const MAX_UNSUPPORTED_FLAGS = 5;

interface SharedRunContext {
  firmName: string;
  client: { name: string; description: string | null };
  objectives: { status: SourceStatus; items: StrategyRow[] };
  credential: ResolvedAiCredential | null;
  credentialError: string | null;
  userId: string | null;
  timeZone: string;
  lookbackDays: number;
}

interface MeetingRow {
  id: string;
  eventId: string;
  ordinal: number;
  event: unknown;
  resolution: unknown;
  context: unknown;
  section: unknown;
}

interface JobState {
  id: string;
  units: JobUnit[];
  events: JobEvent[];
  seq: number;
}

type ModelResult = { ok: true; text: string } | { ok: false; reason: string; detail: string };

async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (!items.length) return;
  let cursor = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        await worker(items[index]!, index);
      }
    }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generation (requirements §7): one job per document, one unit of work per
 * selected meeting. Focus and Background are drafted per meeting from the
 * objectives, the CARRIED Directory units, the user note (verbatim) and the
 * selected correspondence. A failed unit resolves its section to `unavailable`
 * with the reason attached — the document still assembles, the facts stay,
 * and single-section regeneration is offered in the editor.
 *
 * Progress is persisted on the job row (units + an ordered event log) so the
 * SSE stream and the poll fallback read the same truth.
 */
@Injectable()
export class HillDayGenerationService {
  private readonly logger = new Logger(HillDayGenerationService.name);
  /** Documents with a run in flight in THIS process (single-task service). */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly source: HillDaySourceService,
    private readonly credentials: AiCredentialService,
  ) {}

  async start(tenantId: string, actorId: string, documentId: string): Promise<{ jobId: string; status: 'queued' | 'running' }> {
    const doc = await this.assertDoc(tenantId, documentId);
    if (doc.ownerId !== actorId) throw new ForbiddenException('Only the document owner can generate it');
    const meetings = await this.prisma.wsHillDayMeeting.findMany({
      where: { tenantId, documentId },
      orderBy: { ordinal: 'asc' },
      select: { id: true },
    });
    if (!meetings.length) throw new BadRequestException('Select at least one meeting before generating');

    const active = await this.prisma.wsHillDayJob.findFirst({
      where: { tenantId, documentId, status: { in: ['queued', 'running'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (active) {
      if (this.inFlight.has(documentId)) {
        return { jobId: active.id, status: active.status as 'queued' | 'running' };
      }
      // A job row left behind by a restart: nothing is running it, fail it honestly.
      await this.prisma.wsHillDayJob.update({
        where: { id: active.id },
        data: { status: 'failed', error: 'interrupted', completedAt: new Date() },
      });
    }

    const now = new Date().toISOString();
    const units: JobUnit[] = meetings.map((m) => ({
      meetingId: m.id,
      state: 'queued',
      sectionId: m.id,
      reason: null,
      at: now,
    }));
    const job = await this.prisma.wsHillDayJob.create({
      data: { tenantId, documentId, actorId, status: 'queued', units: units as never, events: [] as never },
    });
    await this.prisma.wsHillDayDocument.update({
      where: { id: documentId },
      data: { status: 'generating' },
    });
    this.inFlight.add(documentId);
    setImmediate(() => {
      this.run(job.id, tenantId, documentId, actorId).catch((err) => {
        this.logger.error(`Hill Day job ${job.id} crashed: ${(err as Error).message}`);
      });
    });
    return { jobId: job.id, status: 'queued' };
  }

  async jobStatus(tenantId: string, documentId: string, jobId: string): Promise<JobStatus> {
    const job = await this.prisma.wsHillDayJob.findFirst({ where: { id: jobId, tenantId, documentId } });
    if (!job) throw new NotFoundException('Generation job not found');
    return {
      jobId: job.id,
      documentId,
      status: job.status as JobStatus['status'],
      units: (job.units as JobUnit[] | null) ?? [],
      quality: job.quality,
      error: job.error,
      startedAt: job.startedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
    };
  }

  async jobEvents(
    tenantId: string,
    documentId: string,
    jobId: string,
    afterSeq: number,
  ): Promise<{ status: JobStatus['status']; events: JobEvent[] }> {
    const job = await this.prisma.wsHillDayJob.findFirst({ where: { id: jobId, tenantId, documentId } });
    if (!job) throw new NotFoundException('Generation job not found');
    const events = ((job.events as JobEvent[] | null) ?? []).filter((e) => e.seq > afterSeq);
    return { status: job.status as JobStatus['status'], events };
  }

  /** Redraft one section against the current context; clears any user edit on it. */
  async regenerateSection(
    tenantId: string,
    actorId: string,
    documentId: string,
    sectionId: string,
  ): Promise<{ section: MeetingSection; sourceSet: SourceSet }> {
    const doc = await this.assertDoc(tenantId, documentId);
    if (doc.ownerId !== actorId) throw new ForbiddenException('Only the document owner can regenerate it');
    if (this.inFlight.has(documentId)) throw new ConflictException('A generation job is already running');
    const meeting = (await this.prisma.wsHillDayMeeting.findFirst({
      where: { id: sectionId, tenantId, documentId },
    })) as MeetingRow | null;
    if (!meeting) throw new NotFoundException('Section not found');
    const shared = await this.sharedContext(tenantId, actorId, doc);
    const result = await this.generateUnit(tenantId, meeting, shared);
    return { section: result.section, sourceSet: result.sourceSet };
  }

  // ── run loop ──────────────────────────────────────────────────────────────

  private async run(jobId: string, tenantId: string, documentId: string, actorId: string): Promise<void> {
    const state: JobState = { id: jobId, units: [], events: [], seq: 0 };
    try {
      const job = await this.prisma.wsHillDayJob.findUnique({ where: { id: jobId } });
      if (!job) return;
      state.units = (job.units as JobUnit[] | null) ?? [];
      const doc = await this.prisma.wsHillDayDocument.findUnique({ where: { id: documentId } });
      if (!doc) return;
      await this.prisma.wsHillDayJob.update({
        where: { id: jobId },
        data: { status: 'running', startedAt: new Date() },
      });
      const meetings = (await this.prisma.wsHillDayMeeting.findMany({
        where: { tenantId, documentId },
        orderBy: { ordinal: 'asc' },
      })) as MeetingRow[];
      const shared = await this.sharedContext(tenantId, actorId, doc);

      let failed = 0;
      await forEachBounded(meetings, UNIT_CONCURRENCY, async (meeting) => {
        const section = meeting.section as MeetingSection | null;
        if (section?.edited?.focus || section?.edited?.background) {
          // Edited sections are excluded from bulk regeneration (requirements §6 PATCH).
          await this.emit(state, 'unit', {
            meetingId: meeting.id,
            state: 'done',
            sectionId: meeting.id,
            reason: 'edited_preserved',
          });
          return;
        }
        await this.emit(state, 'unit', { meetingId: meeting.id, state: 'running', sectionId: meeting.id });
        const result = await this.generateUnit(tenantId, meeting, shared);
        if (result.section.status === 'done') {
          await this.emit(state, 'unit', { meetingId: meeting.id, state: 'done', sectionId: meeting.id });
        } else {
          failed += 1;
          await this.emit(state, 'unit', {
            meetingId: meeting.id,
            state: 'failed',
            sectionId: meeting.id,
            reason: result.section.reason ?? 'unknown',
          });
        }
      });

      const total = meetings.length;
      const quality = total ? Number(((total - failed) / total).toFixed(2)) : 0;
      const completedAt = new Date();
      await this.prisma.wsHillDayJob.update({
        where: { id: jobId },
        data: { status: 'complete', quality, completedAt },
      });
      await this.prisma.wsHillDayDocument.update({
        where: { id: documentId },
        data: {
          status: failed > 0 ? 'partial' : 'generated',
          generatedAt: completedAt,
          provenance: {
            jobId,
            generatedAt: completedAt.toISOString(),
            model: shared.credential?.model ?? null,
            credentialSource: shared.credential ? (shared.credential.usedTenantKey ? 'tenant' : 'platform') : null,
            sections: total,
            failed,
            quality,
          } as never,
        },
      });
      await this.emit(state, 'complete', { documentId, sections: total, failed, quality });
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`Hill Day job ${jobId} failed: ${message}`);
      await this.prisma.wsHillDayJob
        .update({ where: { id: jobId }, data: { status: 'failed', error: message, completedAt: new Date() } })
        .catch(() => undefined);
      await this.prisma.wsHillDayDocument
        .update({ where: { id: documentId }, data: { status: 'partial' } })
        .catch(() => undefined);
      await this.emit(state, 'failed', { documentId, reason: message }).catch(() => undefined);
    } finally {
      this.inFlight.delete(documentId);
    }
  }

  private async emit(state: JobState, event: JobEvent['event'], data: Record<string, unknown>): Promise<void> {
    state.seq += 1;
    const at = new Date().toISOString();
    const payload: JobEvent = { seq: state.seq, event, data: { ...data, at } };
    state.events.push(payload);
    if (event === 'unit') {
      const meetingId = String(data.meetingId ?? '');
      const idx = state.units.findIndex((u) => u.meetingId === meetingId);
      const next: JobUnit = {
        meetingId,
        state: (data.state as JobUnit['state']) ?? 'queued',
        sectionId: (data.sectionId as string | undefined) ?? meetingId,
        reason: (data.reason as string | undefined) ?? null,
        at,
      };
      if (idx >= 0) state.units[idx] = next;
      else state.units.push(next);
    }
    const status = event === 'complete' ? 'complete' : event === 'failed' ? 'failed' : 'running';
    await this.prisma.wsHillDayJob.update({
      where: { id: state.id },
      data: { units: state.units as never, events: state.events as never, status },
    });
  }

  // ── one unit ──────────────────────────────────────────────────────────────

  private async sharedContext(
    tenantId: string,
    actorId: string,
    doc: { clientId: string; clientName: string; timeZone: string; lookbackDays: number },
  ): Promise<SharedRunContext> {
    const userId = await this.source.resolveUserId(actorId).catch(() => null);
    const firmName = (await this.source.tenantName(tenantId).catch(() => null)) ?? 'Your firm';
    let client = { name: doc.clientName, description: null as string | null };
    try {
      const row = await this.source.getClient(tenantId, userId, doc.clientId);
      if (row) {
        client = {
          name: row.name,
          description: [row.sectorTag, row.description ?? row.productDescription].filter(Boolean).join(' — ') || null,
        };
      }
    } catch (err) {
      this.logger.warn(`client read failed: ${(err as Error).message}`);
    }
    let objectives: SharedRunContext['objectives'] = { status: 'unavailable', items: [] };
    try {
      objectives = { status: 'ok', items: await this.source.listStrategies(tenantId, doc.clientId) };
    } catch (err) {
      this.logger.warn(`objectives read failed: ${(err as Error).message}`);
    }
    let credential: ResolvedAiCredential | null = null;
    let credentialError: string | null = null;
    try {
      credential = await this.credentials.resolveAnthropic(tenantId);
      if (!credential) credentialError = 'model_credential_missing';
    } catch (err) {
      credentialError = `model_credential_error: ${(err as Error).message}`;
    }
    return {
      firmName,
      client,
      objectives,
      credential,
      credentialError,
      userId,
      timeZone: doc.timeZone || 'America/New_York',
      lookbackDays: doc.lookbackDays || DEFAULT_LOOKBACK_DAYS,
    };
  }

  private async generateUnit(
    tenantId: string,
    meeting: MeetingRow,
    shared: SharedRunContext,
  ): Promise<{ section: MeetingSection; sourceSet: SourceSet }> {
    const event = meeting.event as CalendarEvent;
    const resolution = (meeting.resolution as MeetingResolution | null) ?? minimalResolution(meeting.id, event);
    const record = meeting.context as MeetingContextRecord | null;
    const units = buildCarryUnits(resolution, record);
    const carry = effectiveCarry(units);
    const note = record?.note ?? '';
    const lookbackDays = record?.lookbackDays ?? shared.lookbackDays;
    const doc = await this.prisma.wsHillDayDocument.findFirst({
      where: { id: (await this.prisma.wsHillDayMeeting.findUnique({ where: { id: meeting.id }, select: { documentId: true } }))?.documentId ?? '' },
      select: { clientId: true },
    });
    const clientId = doc?.clientId ?? '';

    // Correspondence: only the selected threads, and only inside the window.
    const threads: UnitPromptInput['threads'] = { status: 'ok', items: [] };
    const selectedThreadIds = record?.threadIds ?? [];
    if (selectedThreadIds.length) {
      try {
        const since = new Date(Date.now() - lookbackDays * 86_400_000);
        const addresses = resolution.attendees.map((a) => a.address).filter((a): a is string => Boolean(a));
        const rows = await this.source.listThreads(tenantId, shared.userId, clientId, addresses, since);
        const inWindow = rows.filter((r) => selectedThreadIds.includes(r.id));
        const messages = inWindow.length
          ? await this.source.threadMessages(tenantId, inWindow.map((r) => r.id))
          : [];
        const byThread = new Map<string, MessageRow[]>();
        for (const m of messages) {
          const list = byThread.get(m.threadId) ?? [];
          list.push(m);
          byThread.set(m.threadId, list);
        }
        threads.items = inWindow.map((r) => {
          const ref = toThreadRef(r, clientId);
          return { id: r.id, subject: r.subject, participants: ref.participants, messages: byThread.get(r.id) ?? [] };
        });
      } catch (err) {
        this.logger.warn(`correspondence read failed for meeting ${meeting.id}: ${(err as Error).message}`);
        threads.status = 'unavailable';
      }
    }

    let prior: UnitPromptInput['prior'] = [];
    try {
      const addresses = resolution.attendees
        .filter((a) => a.state === 'resolved')
        .map((a) => a.address)
        .filter((a): a is string => Boolean(a));
      prior = await this.source.priorMeetings(
        tenantId,
        shared.userId,
        clientId,
        addresses,
        new Date(event.startsAt),
        event.eventId,
      );
    } catch (err) {
      this.logger.warn(`prior engagement read failed: ${(err as Error).message}`);
    }

    const prompt = assembleUnitPrompt({
      firmName: shared.firmName,
      client: shared.client,
      event,
      timeZone: shared.timeZone,
      resolution,
      units,
      carry,
      note,
      objectives: shared.objectives,
      threads,
      prior,
      model: shared.credential?.model ?? null,
    });

    const flags: SectionFlag[] = [];
    if (resolution.state === 'partial') {
      flags.push({
        kind: 'partial_resolution',
        detail: resolution.office.memberId
          ? 'One or more attendees are not resolved to a Directory record.'
          : 'The office for this meeting is not resolved.',
      });
    }
    if (resolution.needsConfirmation) {
      const reason = confirmationReason(resolution);
      flags.push({
        kind: 'needs_confirmation',
        detail:
          reason === 'no_invite'
            ? 'Added manually from the Directory — confirm attendees before delivery.'
            : 'Scheduler-only invite — confirm attendees before delivery.',
      });
    }

    const generatedAt = new Date().toISOString();
    let section: MeetingSection;
    if (!shared.credential) {
      section = unavailableSection(meeting.id, shared.credentialError ?? 'model_credential_missing', flags, generatedAt, null);
    } else {
      const result = await this.callModel(shared.credential, prompt.system, prompt.user);
      if (!result.ok) {
        section = unavailableSection(meeting.id, result.reason, [...flags, { kind: 'generation_failed', detail: result.detail }], generatedAt, shared.credential.model);
      } else {
        let parsed = parseUnitOutput(result.text);
        if (!parsed) {
          const retry = await this.callModel(
            shared.credential,
            prompt.system,
            `${prompt.user}\n\nReturn ONLY the JSON object described in the instructions — no prose.`,
          );
          parsed = retry.ok ? parseUnitOutput(retry.text) : null;
        }
        if (!parsed) {
          section = unavailableSection(
            meeting.id,
            'provider_output_unparseable',
            [...flags, { kind: 'generation_failed', detail: 'The model did not return the expected JSON.' }],
            generatedAt,
            shared.credential.model,
          );
        } else {
          for (const sentence of parsed.unsupported.slice(0, MAX_UNSUPPORTED_FLAGS)) {
            flags.push({ kind: 'unsupported_claim', detail: sentence.trim().slice(0, 400) });
          }
          section = {
            sectionId: meeting.id,
            status: 'done',
            focus: parsed.focus || null,
            background: parsed.background || null,
            reason: null,
            flags,
            generatedAt,
            model: shared.credential.model,
            edited: { focus: false, background: false, at: null },
          };
        }
      }
    }

    await this.prisma.wsHillDayMeeting.update({
      where: { id: meeting.id },
      data: { section: section as never, sourceSet: prompt.sourceSet as never },
    });
    return { section, sourceSet: prompt.sourceSet };
  }

  private async callModel(cred: ResolvedAiCredential, system: string, user: string): Promise<ModelResult> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), UNIT_TIMEOUT_MS);
      try {
        const res = await fetch(ANTHROPIC_URL, {
          method: 'POST',
          headers: {
            'x-api-key': cred.secret,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: cred.model,
            max_tokens: UNIT_MAX_TOKENS,
            system,
            messages: [{ role: 'user', content: user }],
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          // Status only: a provider error body can echo the prompt (client context).
          this.logger.warn(`Hill Day generation: provider HTTP ${res.status}`);
          if (attempt === 1 && (res.status === 429 || res.status >= 500)) {
            await sleep(2_500);
            continue;
          }
          return { ok: false, reason: 'provider_unavailable', detail: `Generation provider failed (HTTP ${res.status})` };
        }
        const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
        const text = (data.content ?? [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('')
          .trim();
        return { ok: true, text };
      } catch (err) {
        const aborted = (err as Error).name === 'AbortError';
        if (attempt === 1 && !aborted) {
          await sleep(2_500);
          continue;
        }
        return {
          ok: false,
          reason: aborted ? 'provider_timeout' : 'provider_unavailable',
          detail: aborted ? `Generation timed out after ${UNIT_TIMEOUT_MS / 1000}s` : (err as Error).message,
        };
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private async assertDoc(tenantId: string, documentId: string) {
    const doc = await this.prisma.wsHillDayDocument.findFirst({ where: { id: documentId, tenantId } });
    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }
}

function unavailableSection(
  sectionId: string,
  reason: string,
  flags: SectionFlag[],
  generatedAt: string,
  model: string | null,
): MeetingSection {
  return {
    sectionId,
    status: 'unavailable',
    focus: null,
    background: null,
    reason,
    flags: flags.some((f) => f.kind === 'generation_failed')
      ? flags
      : [...flags, { kind: 'generation_failed', detail: reason }],
    generatedAt,
    model,
    edited: { focus: false, background: false, at: null },
  };
}

/** When generation is invoked before resolution ran: facts from the calendar only. */
function minimalResolution(meetingId: string, event: CalendarEvent): MeetingResolution {
  const attendees = (event.attendees ?? [])
    .map((a) => normalizeAddress(a.address))
    .filter((a): a is string => Boolean(a))
    .map((address) => ({
      attendeeId: `att_${address}`,
      address,
      state: 'unresolved' as const,
      stafferId: null,
      name: address,
      role: null,
      issueAreas: [],
      topics: [],
      directoryOffice: null,
      inviteOffice: null,
      committee: null,
      detail: 'Resolution has not run for this meeting.',
      manual: false,
      correction: null,
      directoryRecord: null,
    }));
  const office = { ...emptyOffice(), room: event.location ?? null };
  const roll = rollUpMeeting(attendees, office);
  return {
    meetingId,
    eventId: event.eventId,
    state: 'partial',
    office,
    attendees,
    internalParticipants: [],
    needsConfirmation: roll.needsConfirmation,
    resolvedAt: new Date().toISOString(),
    sources: [{ source: 'directory', status: 'unavailable', detail: 'Resolution has not run' }],
  };
}
