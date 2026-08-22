import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

const CHECKPOINTS_MINUTES = [60, 15, 2, 0] as const;
const TERMINAL_CAPTURE_STATES = new Set([
  'COMPLETE',
  'COMPLETE_WITH_GAPS',
  'FAILED',
  'CANCELED',
  'BLOCKED',
]);
const TERMINAL_NON_SERVER_POLICIES = new Set([
  'BROWSER_CAPTURE_ONLY',
  'LICENSE_REQUIRED',
  'BLOCKED',
]);

interface PlannerRow {
  hearingId: string;
  startsAt: Date;
  title: string;
  eventStatus: string;
  visibility: string;
  captureId: string | null;
  captureStatus: string | null;
  demandCount: number;
  candidateCount: number;
  serverAllowedCount: number;
  reviewRequiredCount: number;
  terminalNonServerCount: number;
}

export interface LegiWatchPreflightPlanResult {
  scanned: number;
  eligible: number;
  capturesCreated: number;
  checkpointsInserted: number;
  checkpointsRearmed: number;
  checkpointsAlreadyActive: number;
  delayedStartCheckpoints: number;
  skippedNoDemand: number;
  skippedTerminalCapture: number;
  skippedExplicitNonServerPolicy: number;
  errors: Array<{ hearingId: string; error: string }>;
}

@Injectable()
export class LegiWatchPhase9PreflightService {
  constructor(private readonly prisma: PrismaService) {}

  async plan(input: {
    now?: Date;
    lookaheadDays?: number;
    delayedStartHours?: number;
    limit?: number;
  } = {}): Promise<LegiWatchPreflightPlanResult> {
    const now = validDate(input.now) ?? new Date();
    const lookaheadDays = boundedInteger(input.lookaheadDays ?? 14, 1, 60);
    const delayedStartHours = boundedInteger(input.delayedStartHours ?? 6, 1, 24);
    const limit = boundedInteger(input.limit ?? 2_000, 1, 10_000);
    const from = new Date(now.getTime() - delayedStartHours * 3_600_000);
    const to = new Date(now.getTime() + lookaheadDays * 86_400_000);
    const state = await this.prisma.$queryRawUnsafe<
      Array<{ captureAllPublicEvents: boolean }>
    >(
      `SELECT capture_all_public_events AS "captureAllPublicEvents"
       FROM legiwatch_cutover_state
       WHERE id='global'
       LIMIT 1`,
    );
    const captureAll = state[0]?.captureAllPublicEvents ?? false;
    const rows = await this.prisma.$queryRawUnsafe<PlannerRow[]>(
      `SELECT h.id AS "hearingId",
              h.starts_at AS "startsAt",
              h.title,
              h.event_status AS "eventStatus",
              h.visibility,
              c.id AS "captureId",
              c.domain_status AS "captureStatus",
              COUNT(DISTINCT s.id)::int AS "demandCount",
              COUNT(DISTINCT candidate.id)::int AS "candidateCount",
              COUNT(DISTINCT candidate.id) FILTER (
                WHERE candidate.capture_policy='SERVER_CAPTURE_ALLOWED'
              )::int AS "serverAllowedCount",
              COUNT(DISTINCT candidate.id) FILTER (
                WHERE candidate.capture_policy='REVIEW_REQUIRED'
                   OR candidate.resolution_state IN (
                     'NOT_CHECKED', 'WAITING_FOR_STREAM', 'SOURCE_ERROR'
                   )
              )::int AS "reviewRequiredCount",
              COUNT(DISTINCT candidate.id) FILTER (
                WHERE candidate.capture_policy IN (
                  'BROWSER_CAPTURE_ONLY', 'LICENSE_REQUIRED', 'BLOCKED'
                )
                  AND candidate.resolution_state IN (
                    'NO_PUBLIC_STREAM', 'POLICY_BLOCKED', 'ENDED'
                  )
              )::int AS "terminalNonServerCount"
       FROM committee_hearing h
       LEFT JOIN hearing_subscription s ON s.hearing_id=h.id
       LEFT JOIN public_hearing_capture c ON c.hearing_id=h.id
       LEFT JOIN hearing_stream_candidate candidate ON candidate.hearing_id=h.id
       WHERE h.visibility='public'
         AND h.event_status IN ('scheduled','postponed','in_progress')
         AND h.starts_at IS NOT NULL
         AND h.starts_at BETWEEN $1 AND $2
       GROUP BY h.id, h.starts_at, h.title, h.event_status, h.visibility,
                c.id, c.domain_status
       ORDER BY h.starts_at ASC, h.id ASC
       LIMIT $3`,
      from,
      to,
      limit,
    );

    const result: LegiWatchPreflightPlanResult = {
      scanned: rows.length,
      eligible: 0,
      capturesCreated: 0,
      checkpointsInserted: 0,
      checkpointsRearmed: 0,
      checkpointsAlreadyActive: 0,
      delayedStartCheckpoints: 0,
      skippedNoDemand: 0,
      skippedTerminalCapture: 0,
      skippedExplicitNonServerPolicy: 0,
      errors: [],
    };

    for (const row of rows) {
      try {
        if (!captureAll && row.demandCount === 0) {
          result.skippedNoDemand += 1;
          continue;
        }
        if (row.captureStatus && TERMINAL_CAPTURE_STATES.has(row.captureStatus)) {
          result.skippedTerminalCapture += 1;
          continue;
        }
        const explicitlyNonServer =
          row.candidateCount > 0 &&
          row.terminalNonServerCount === row.candidateCount &&
          row.serverAllowedCount === 0 &&
          row.reviewRequiredCount === 0;
        if (explicitlyNonServer) {
          result.skippedExplicitNonServerPolicy += 1;
          continue;
        }

        result.eligible += 1;
        const capture = await this.ensureCapture(row);
        if (capture.created) result.capturesCreated += 1;
        for (const minutes of CHECKPOINTS_MINUTES) {
          const dueAt = new Date(row.startsAt.getTime() - minutes * 60_000);
          if (dueAt.getTime() < now.getTime() - 10 * 60_000) continue;
          const checkpoint = minutes === 0 ? 'start' : `t${minutes}`;
          const state = await this.scheduleCheckpoint({
            hearingId: row.hearingId,
            dedupeKey: `hearing-stream-preflight:v2:${row.hearingId.toLowerCase()}:${checkpoint}`,
            dueAt: dueAt < now ? now : dueAt,
            checkpoint,
          });
          incrementCheckpoint(result, state);
        }

        if (
          row.startsAt <= now &&
          row.startsAt.getTime() >= from.getTime() &&
          ['scheduled', 'postponed', 'in_progress'].includes(row.eventStatus)
        ) {
          const bucket = Math.floor(now.getTime() / (5 * 60_000));
          const state = await this.scheduleCheckpoint({
            hearingId: row.hearingId,
            dedupeKey: `hearing-stream-preflight:v2:${row.hearingId.toLowerCase()}:delayed:${bucket}`,
            dueAt: now,
            checkpoint: 'delayed-start',
          });
          incrementCheckpoint(result, state);
          if (state !== 'active') result.delayedStartCheckpoints += 1;
        }
      } catch (error) {
        result.errors.push({ hearingId: row.hearingId, error: boundedError(error) });
      }
    }
    return result;
  }

  private async ensureCapture(
    row: PlannerRow,
  ): Promise<{ id: string; created: boolean }> {
    if (row.captureId) return { id: row.captureId, created: false };
    const inserted = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO public_hearing_capture (
         id, hearing_id, status, domain_status, scheduled_start,
         created_at, updated_at
       ) VALUES (
         gen_random_uuid()::text, $1, 'scheduled', 'SCHEDULED', $2, now(), now()
       )
       ON CONFLICT (hearing_id) DO NOTHING
       RETURNING id`,
      row.hearingId,
      row.startsAt,
    );
    if (inserted[0]?.id) return { id: inserted[0].id, created: true };
    const existing = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM public_hearing_capture WHERE hearing_id=$1 LIMIT 1`,
      row.hearingId,
    );
    if (!existing[0]?.id) {
      throw new Error(`Canonical capture missing after ensure for ${row.hearingId}`);
    }
    return { id: existing[0].id, created: false };
  }

  private async scheduleCheckpoint(input: {
    hearingId: string;
    dedupeKey: string;
    dueAt: Date;
    checkpoint: string;
  }): Promise<'inserted' | 'rearmed' | 'active'> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ id: string; inserted: boolean; rearmed: boolean }>
    >(
      `INSERT INTO public_hearing_capture_job (
         job_type, dedupe_key, hearing_id, capture_id, status,
         due_at, payload, attempts, created_at, updated_at
       ) VALUES (
         'preflight', $1, $2, NULL, 'pending', $3,
         $4::jsonb, 0, now(), now()
       )
       ON CONFLICT (dedupe_key) DO UPDATE SET
         due_at=LEAST(public_hearing_capture_job.due_at, EXCLUDED.due_at),
         status=CASE
           WHEN public_hearing_capture_job.status IN ('completed','failed') THEN 'pending'
           ELSE public_hearing_capture_job.status
         END,
         attempts=CASE
           WHEN public_hearing_capture_job.status IN ('completed','failed') THEN 0
           ELSE public_hearing_capture_job.attempts
         END,
         lease_owner=CASE
           WHEN public_hearing_capture_job.status IN ('completed','failed') THEN NULL
           ELSE public_hearing_capture_job.lease_owner
         END,
         lease_expires_at=CASE
           WHEN public_hearing_capture_job.status IN ('completed','failed') THEN NULL
           ELSE public_hearing_capture_job.lease_expires_at
         END,
         completed_at=CASE
           WHEN public_hearing_capture_job.status IN ('completed','failed') THEN NULL
           ELSE public_hearing_capture_job.completed_at
         END,
         last_error=CASE
           WHEN public_hearing_capture_job.status IN ('completed','failed') THEN NULL
           ELSE public_hearing_capture_job.last_error
         END,
         payload=public_hearing_capture_job.payload || EXCLUDED.payload,
         updated_at=now()
       WHERE public_hearing_capture_job.status <> 'leased'
       RETURNING id,
                 (xmax = 0) AS inserted,
                 (xmax <> 0 AND status='pending') AS rearmed`,
      input.dedupeKey,
      input.hearingId,
      input.dueAt,
      JSON.stringify({
        mustReresolve: true,
        phase: 9,
        checkpoint: input.checkpoint,
      }),
    );
    const row = rows[0];
    if (!row) return 'active';
    if (row.inserted) return 'inserted';
    if (row.rearmed) return 'rearmed';
    return 'active';
  }
}

function incrementCheckpoint(
  result: LegiWatchPreflightPlanResult,
  state: 'inserted' | 'rearmed' | 'active',
): void {
  if (state === 'inserted') result.checkpointsInserted += 1;
  else if (state === 'rearmed') result.checkpointsRearmed += 1;
  else result.checkpointsAlreadyActive += 1;
}

function validDate(value: Date | undefined): Date | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 1_000);
}

export const LEGIWATCH_PHASE9_PREFLIGHT_CHECKPOINTS = CHECKPOINTS_MINUTES;
export const LEGIWATCH_PHASE9_TERMINAL_NON_SERVER_POLICIES = TERMINAL_NON_SERVER_POLICIES;
