/** Durable public progress only. Provider reasoning and bearer credentials never enter this record. */
export const RESEARCH_RUN_LEASE_MS = 120_000;
export type ResearchRunPhase = 'plan' | 'research';
export type ResearchRunStatus =
  | 'running'
  | 'awaiting_clarification'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'partial';
export interface ResearchRunState {
  id: string;
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
  const result = run as unknown as ResearchRunState;
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
