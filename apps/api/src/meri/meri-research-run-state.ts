/** Durable public progress only. Provider reasoning and bearer credentials never enter this record. */
export const RESEARCH_RUN_LEASE_MS = 120_000;
/**
 * Production PostgreSQL CAS for every owner-authored lease mutation. Keep this
 * statement exported so the embedded-Postgres contract suite executes the same
 * SQL used by the service rather than a test-only approximation.
 */
export const ACTIVE_RESEARCH_RUN_UPDATE_SQL = `
UPDATE clio_research_sessions
   SET metadata_jsonb = $10::jsonb,
       status = $11,
       updated_at = $12::timestamptz
 WHERE id = $1::uuid
   AND tenant_id = $2::uuid
   AND user_id = $3::uuid
   AND status = $4
   AND report_artifact_id IS NULL
   AND metadata_jsonb #>> '{run,id}' = $5
   AND metadata_jsonb #>> '{run,leaseEpoch}' = $6::bigint::text
   AND metadata_jsonb #>> '{run,phase}' = $7
   AND metadata_jsonb #>> '{run,status}' = 'running'
   AND (metadata_jsonb #>> '{run,heartbeatAt}')::timestamptz >= $8::timestamptz
   AND metadata_jsonb = $9::jsonb
 RETURNING metadata_jsonb`;

/** Lock and return a live lease without allowing an expired owner to touch it. */
export const ACTIVE_RESEARCH_RUN_FENCE_SQL = `
UPDATE clio_research_sessions
   SET updated_at = $9::timestamptz
 WHERE id = $1::uuid
   AND tenant_id = $2::uuid
   AND user_id = $3::uuid
   AND status = $4
   AND report_artifact_id IS NULL
   AND metadata_jsonb #>> '{run,id}' = $5
   AND metadata_jsonb #>> '{run,leaseEpoch}' = $6::bigint::text
   AND metadata_jsonb #>> '{run,phase}' = $7
   AND metadata_jsonb #>> '{run,status}' = 'running'
   AND (metadata_jsonb #>> '{run,heartbeatAt}')::timestamptz >= $8::timestamptz
 RETURNING metadata_jsonb`;

export function researchLeaseCutoff(now = new Date()): Date {
  return new Date(now.getTime() - RESEARCH_RUN_LEASE_MS);
}
export type ResearchRunPhase = 'plan' | 'research';
export type ResearchRunStatus =
  | 'running'
  | 'cancel_requested'
  | 'awaiting_clarification'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'partial';
export interface ResearchRunState {
  id: string;
  /** Monotonic ownership generation; the UUID remains the opaque fencing token. */
  leaseEpoch: number;
  /** Last durable public progress receipt committed for this session. */
  eventSequence: number;
  phase: ResearchRunPhase;
  status: ResearchRunStatus;
  stage: string;
  startedAt: string;
  heartbeatAt: string;
  finishedAt?: string;
  failureReason?: string;
  /** Accepted input waiting for its first provider phase, rather than a lost attempt. */
  readyToStart?: boolean;
}
export function researchMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function readResearchRun(value: unknown, now = Date.now()): ResearchRunState | null {
  const run = researchMetadata(researchMetadata(value).run);
  if (
    typeof run.id !== 'string' ||
    !['plan', 'research'].includes(String(run.phase)) ||
    ![
      'running',
      'cancel_requested',
      'awaiting_clarification',
      'complete',
      'failed',
      'cancelled',
      'interrupted',
      'partial',
    ].includes(String(run.status)) ||
    typeof run.startedAt !== 'string' ||
    typeof run.heartbeatAt !== 'string' ||
    typeof run.stage !== 'string'
  )
    return null;
  const result = {
    ...run,
    leaseEpoch:
      typeof run.leaseEpoch === 'number' &&
      Number.isSafeInteger(run.leaseEpoch) &&
      run.leaseEpoch >= 0
        ? run.leaseEpoch
        : 0,
    eventSequence:
      typeof run.eventSequence === 'number' &&
      Number.isSafeInteger(run.eventSequence) &&
      run.eventSequence >= 0
        ? run.eventSequence
        : 0,
  } as unknown as ResearchRunState;
  if (
    result.status === 'running' &&
    (!Number.isFinite(Date.parse(result.heartbeatAt)) ||
      now - Date.parse(result.heartbeatAt) > RESEARCH_RUN_LEASE_MS)
  ) {
    return {
      ...result,
      status: 'interrupted',
      stage: 'The worker stopped reporting progress. Resume to retry this saved research request.',
    };
  }
  return { ...result };
}
export function terminalResearchRun(
  run: ResearchRunState,
  status: Exclude<ResearchRunStatus, 'running'>,
  stage: string,
  now = new Date(),
): ResearchRunState {
  return { ...run, status, stage, heartbeatAt: now.toISOString(), finishedAt: now.toISOString() };
}
