/**
 * Meri jobs (program plan §5.1, Stage 2 Release A).
 *
 * A job is a durable research session with a kind. The research run state in
 * `metadata.run`, the fenced lease and the coordinator stay the single owner
 * of execution; this module only names what a user sees. The logical job
 * status is projected from the stored session and run state, so every old
 * status value stays readable and no writer changes.
 *
 * Non-research kinds are dark: they can be created only when the tenant flag
 * `meri.jobs` is on (default off).
 */
import { readDurableResearchCoordinator } from './meri-research-coordinator.js';
import { readResearchRun, type ResearchRunState } from './meri-research-run-state.js';
import { RESEARCH_OBSERVER_STATUS } from './research-observer-projection.js';

export const MERI_JOB_KINDS = ['research', 'deliverable', 'audit', 'scheduled'] as const;
export type MeriJobKind = (typeof MERI_JOB_KINDS)[number];

export const MERI_JOB_STATUSES = [
  'queued',
  'planning',
  'executing',
  'waiting_for_user',
  'finalizing',
  'completed',
  'partial',
  'failed',
  'cancel_requested',
  'cancelled',
] as const;
export type MeriJobStatus = (typeof MERI_JOB_STATUSES)[number];

export const MERI_JOB_DELIVERABLE_FORMATS = ['docx', 'xlsx', 'pptx', 'pdf', 'markdown'] as const;
export type MeriJobDeliverableFormat = (typeof MERI_JOB_DELIVERABLE_FORMATS)[number];

export interface MeriJobDeliverable {
  format: MeriJobDeliverableFormat;
  title: string;
  artifactId: string | null;
}

export interface MeriJobView {
  kind: MeriJobKind;
  status: MeriJobStatus;
  goalRevision: number;
  deliverables: MeriJobDeliverable[];
  /**
   * The job holds no live lease and continues only when a signed-in client
   * starts or resumes it (V3 turns need the user's session token).
   */
  awaitingStart: boolean;
}

const FINALIZING_STAGES = new Set<string>([
  RESEARCH_OBSERVER_STATUS.writingReport,
  RESEARCH_OBSERVER_STATUS.checkingReport,
  RESEARCH_OBSERVER_STATUS.savingReport,
  RESEARCH_OBSERVER_STATUS.preparingReport,
]);

export function isMeriJobKind(value: unknown): value is MeriJobKind {
  return typeof value === 'string' && (MERI_JOB_KINDS as readonly string[]).includes(value);
}

/** Unknown or missing kinds read as research, the only kind before Stage 2. */
export function meriJobKind(value: unknown): MeriJobKind {
  return isMeriJobKind(value) ? value : 'research';
}

export function meriJobDeliverables(value: unknown): MeriJobDeliverable[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    if (
      typeof row.format !== 'string' ||
      !(MERI_JOB_DELIVERABLE_FORMATS as readonly string[]).includes(row.format) ||
      typeof row.title !== 'string' ||
      !row.title.trim()
    )
      return [];
    return [
      {
        format: row.format as MeriJobDeliverableFormat,
        title: row.title.trim().slice(0, 200),
        artifactId: typeof row.artifactId === 'string' && row.artifactId ? row.artifactId : null,
      },
    ];
  });
}

function waitingForApproval(metadata: unknown): boolean {
  try {
    return (
      readDurableResearchCoordinator(metadata)?.steps.some(
        (step) => step.outcome === 'waiting_for_approval',
      ) ?? false
    );
  } catch {
    return false;
  }
}

/**
 * Map the stored session onto the logical job status. Precedence: an explicit
 * stop, then terminal outcomes, then waiting on the user, then live work.
 */
export function projectMeriJobStatus(
  session: { status: string; metadata: unknown },
  run: ResearchRunState | null = readResearchRun(session.metadata),
): MeriJobStatus {
  const column = session.status;
  const state = run?.status;
  if (state === 'cancel_requested') return 'cancel_requested';
  if (state === 'cancelled' || column === 'cancelled') return 'cancelled';
  if (state === 'complete' || column === 'complete') return 'completed';
  if (state === 'partial') return 'partial';
  if (state === 'awaiting_clarification' || column === 'awaiting_clarification')
    return 'waiting_for_user';
  if (waitingForApproval(session.metadata)) return 'waiting_for_user';
  if (state === 'running') {
    if (run?.phase === 'plan') return 'planning';
    return FINALIZING_STAGES.has(run?.stage ?? '') ? 'finalizing' : 'executing';
  }
  if (state === 'failed') return 'failed';
  if (state === 'interrupted') return 'queued';
  if (column === 'failed') return 'failed';
  if (column === 'researching') return 'executing';
  return 'queued';
}

export function meriJobView(session: {
  status: string;
  metadata: unknown;
  kind?: unknown;
  goalRevision?: unknown;
  deliverables?: unknown;
}): MeriJobView {
  const run = readResearchRun(session.metadata);
  const status = projectMeriJobStatus(session, run);
  return {
    kind: meriJobKind(session.kind),
    status,
    goalRevision:
      typeof session.goalRevision === 'number' &&
      Number.isSafeInteger(session.goalRevision) &&
      session.goalRevision >= 0
        ? session.goalRevision
        : 0,
    deliverables: meriJobDeliverables(session.deliverables),
    awaitingStart: status === 'queued',
  };
}
