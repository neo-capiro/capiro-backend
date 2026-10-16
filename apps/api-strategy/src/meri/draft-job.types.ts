import { createHash } from 'node:crypto';
import type { DraftStrategyDto } from './dto/meri.dto.js';
import type { SpDraftJob } from '../../generated/prisma-client/index.js';
import type { Prisma } from '../../generated/prisma-client/index.js';
import type { ObjectiveJobEnvelope, ObjectiveReceipt, ObjectiveAdmission } from './objective-generation.types.js';
import { publicObjectiveReceipt, validObjectiveOutcome, pendingReceipt, SAFE_FAILURES } from './objective-generation.types.js';

/** The api-strategy-side job stage (distinct from the orchestrator's own
 *  internal repair-loop `stage` carried on each streamed progress line). */
export type DraftJobStage =
  | 'compiling_context'
  | 'drafting'
  | 'verifying'
  | 'repairing'
  | 'persisting'
  | 'completed'
  | 'failed';

/** Plain-language progress text for each stage transition (plan default; a
 *  streamed delta or a repair-attempt number may refine it further). */
export const DRAFT_JOB_STAGE_TEXT: Record<DraftJobStage, string> = {
  compiling_context: 'Reading client context and Steward facts',
  drafting: 'Drafting the plan',
  verifying: 'Checking the plan for realism issues',
  repairing: 'Fixing issues found in the plan',
  persisting: 'Saving the strategy',
  completed: 'Done',
  failed: 'Failed',
};

/** Hooks MeriService.draft() calls at each real phase transition + on every
 *  streamed model-text delta, so the worker can persist stage/progressText/
 *  streamPreview without MeriService knowing anything about jobs or Prisma.
 *  Undefined (the synchronous HTTP path) means "don't report progress" —
 *  draft() falls back to the original non-streaming orchestrator call. */
export interface DraftJobRuntime {
  objective?: { envelope: ObjectiveJobEnvelope; onCompiled(admission: ObjectiveAdmission): Promise<void> };
  /** Application persistence only. Both hooks are awaited in the existing write transaction. */
  persistence?: {
    /** External as-of observation, after generation but before opening the transaction. */
    beforeTransaction?(): Promise<void>;
    beforeWrite(tx: Prisma.TransactionClient): Promise<void>;
    afterWrite(tx: Prisma.TransactionClient, saved: { strategyId: string; strategyVersionId: string }): Promise<void>;
  };
  /** Remaining budget for the orchestrator call (deadlineAt - now()), NOT the
   *  fixed STRATEGY_MERI_TIMEOUT_MS the synchronous path uses. */
  timeoutMs: number;
  onStage: (stage: DraftJobStage, progressText: string) => void;
  onStreamDelta: (delta: string) => void;
}

/**
 * Idempotency key for POST /strategies/draft (strategy generation timeout
 * fix): a stable hash of the fields that define what would be GENERATED, so a
 * double-submit (client retry after a dropped response, a double-click)
 * resolves to the SAME job instead of starting a second orchestrator run.
 * Deliberately excludes ownerUserId — two submissions of the identical draft
 * request by the same user are what this dedupes; nothing here is a
 * capability check (the job row is still tenant + owner scoped on read).
 */
export function computeDraftRequestKey(dto: Pick<DraftStrategyDto, 'clientId' | 'type' | 'goal' | 'meriContext' | 'targetDate' | 'attachmentIds'>): string {
  const normalized = {
    clientId: dto.clientId,
    type: dto.type,
    goal: dto.goal?.trim() || null,
    meriContext: dto.meriContext?.trim() || null,
    targetDate: dto.targetDate ?? null,
    attachmentIds: [...new Set(dto.attachmentIds ?? [])].sort(),
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/** Stored in sp_draft_job.input. `bearer` is the caller's session token,
 *  captured at submit time as a best-effort for the attachment-text resolve
 *  hop (StrategyAttachmentResolver — fails soft to no attachments without a
 *  live bearer) — the orchestrator call itself uses delegation
 *  (tenantId/ownerUserId), not this bearer, precisely because it may run long
 *  after a ~60s Clerk session token has expired. Never returned to the client
 *  (the public job DTO below omits it). */
export interface DraftJobInput {
  /** Only an authenticated server admission may set this private marker. The
   * legacy model worker must never claim/reclaim these canonical runs. */
  canonicalGeneration?: { admissionId: string };
  objectiveGeneration?: ObjectiveJobEnvelope;
  dto: DraftStrategyDto;
  bearer: string | null;
}

/** The shape GET /strategies/draft-jobs/:jobId returns — never `input`
 *  (carries the caller's bearer) or `claimedBy`/`ownerUserId` (worker/auth
 *  internals). */
export interface PublicDraftJob {
  objectiveGeneration?: ObjectiveReceipt;
  jobId: string;
  status: SpDraftJob['status'];
  stage: string | null;
  progressText: string | null;
  streamPreview: string | null;
  strategyId: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toPublicDraftJob(job: SpDraftJob): PublicDraftJob {
  const objective = (job.input as unknown as DraftJobInput).objectiveGeneration;
  const unconfirmed = objective && !validObjectiveOutcome(objective.receipt, job.status, job.strategyId, job.errorMessage);
  const receipt = objective ? (unconfirmed ? pendingReceipt(objective.request, objective.receipt.source) : publicObjectiveReceipt(objective.receipt)) : undefined;
  if (unconfirmed && receipt) {
    receipt.result = null;
    receipt.failure = { code: 'OBJECTIVE_GENERATION_OUTCOME_UNCONFIRMED', message: SAFE_FAILURES.OBJECTIVE_GENERATION_OUTCOME_UNCONFIRMED! };
  }
  return {
    jobId: job.id,
    status: unconfirmed ? 'failed' : job.status,
    stage: unconfirmed ? 'failed' : job.stage,
    progressText: unconfirmed ? null : job.progressText,
    streamPreview: objective ? null : job.streamPreview,
    strategyId: unconfirmed ? null : job.strategyId,
    errorMessage: unconfirmed ? SAFE_FAILURES.OBJECTIVE_GENERATION_OUTCOME_UNCONFIRMED! : job.errorMessage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(receipt ? { objectiveGeneration: receipt } : {}),
  };
}
