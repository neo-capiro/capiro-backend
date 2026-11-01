import { createHash } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import {
  candidateKindForSource,
  type MemoryCandidateKind,
  type LearningSignalConflictResolution,
} from './memory-version.helpers.js';

type Actor = Pick<TenantContext, 'tenantId' | 'userId' | 'role'>;
export type MemoryDecisionAction = 'approve' | 'reject' | LearningSignalConflictResolution;
export interface RecordedMemoryDecision {
  candidateId: string;
  candidateKind: MemoryCandidateKind;
  outcome: 'activated' | 'rejected' | 'duplicate' | 'corroborated' | 'conflict';
  memoryId?: string;
  memoryItemId?: string;
  controllingItemId?: string;
  conflictGroupId?: string;
  decision?: LearningSignalConflictResolution;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hashReason = (reason: string) => createHash('sha256').update(reason.trim()).digest('hex');
const resolutions = [
  'duplicate',
  'corroborate_existing',
  'supersede_existing',
  'conflict_requires_review',
] as const;
const kinds = ['standard', 'learning_signal_conflict', 'correction', 'restore', 'contradiction'];

/** Content-free scalars appended by the existing immutable transition writer. */
export function memoryDecisionMetadata(
  action: MemoryDecisionAction,
  result: RecordedMemoryDecision,
  reason = '',
): Record<string, string | number | null> {
  return {
    decisionVersion: 1,
    decisionAction: action,
    decisionReasonHash: hashReason(reason),
    decisionKind: result.candidateKind,
    decisionOutcome: result.outcome,
    decisionMemoryId: result.memoryId ?? null,
    decisionMemoryItemId: result.memoryItemId ?? null,
    decisionControllingItemId: result.controllingItemId ?? null,
    decisionConflictGroupId: result.conflictGroupId ?? null,
  };
}

function decodeDecision(
  candidateId: string,
  value: unknown,
): {
  action: MemoryDecisionAction;
  reasonHash: string;
  result: RecordedMemoryDecision;
} {
  const unavailable = () =>
    new ServiceUnavailableException(
      'The original memory decision receipt is unavailable. Read its current status before continuing.',
    );
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  const data = value as Record<string, unknown>;
  const action = data.decisionAction;
  if (
    data.decisionVersion !== 1 ||
    !kinds.includes(String(data.decisionKind)) ||
    !['approve', 'reject', ...resolutions].includes(String(action)) ||
    typeof data.decisionReasonHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(data.decisionReasonHash) ||
    !['activated', 'rejected', 'duplicate', 'corroborated', 'conflict'].includes(
      String(data.decisionOutcome),
    )
  )
    throw unavailable();
  const result: RecordedMemoryDecision = {
    candidateId,
    candidateKind: data.decisionKind as MemoryCandidateKind,
    outcome: data.decisionOutcome as RecordedMemoryDecision['outcome'],
  };
  for (const key of ['memoryId', 'memoryItemId', 'controllingItemId', 'conflictGroupId'] as const) {
    const field = data['decision' + key[0]!.toUpperCase() + key.slice(1)];
    if (field == null) continue;
    if (typeof field !== 'string' || !uuid.test(field)) throw unavailable();
    result[key] = field;
  }
  validateDecisionResult(action as MemoryDecisionAction, result, unavailable);
  return { action: action as MemoryDecisionAction, reasonHash: data.decisionReasonHash, result };
}

function validateDecisionResult(
  action: MemoryDecisionAction,
  result: RecordedMemoryDecision,
  unavailable: () => Error,
) {
  if (action === 'reject') {
    if (result.outcome !== 'rejected' || Object.keys(result).length !== 3) throw unavailable();
  } else if (result.memoryId) {
    if (
      action !== 'approve' ||
      !['standard', 'learning_signal_conflict'].includes(result.candidateKind) ||
      result.outcome !== 'activated' ||
      Object.keys(result).length !== 4
    )
      throw unavailable();
  } else {
    if (
      !result.memoryItemId ||
      !result.controllingItemId ||
      result.outcome === 'rejected' ||
      (result.outcome === 'conflict') !== Boolean(result.conflictGroupId)
    )
      throw unavailable();
    if (result.outcome !== 'conflict' && result.memoryItemId !== result.controllingItemId)
      throw unavailable();
    if (action !== 'approve') {
      const outcomes = {
        duplicate: 'duplicate',
        corroborate_existing: 'corroborated',
        supersede_existing: 'activated',
        conflict_requires_review: 'conflict',
      };
      if (
        result.candidateKind !== 'learning_signal_conflict' ||
        outcomes[action as LearningSignalConflictResolution] !== result.outcome
      )
        throw unavailable();
      result.decision = action as LearningSignalConflictResolution;
    } else if (
      ['standard', 'learning_signal_conflict'].includes(result.candidateKind) ||
      result.outcome === 'corroborated'
    )
      throw unavailable();
  }
}

/** Read the original result only after the canonical pending-row lock found no work.
 * Never runs a publication, projection or embedding path. The caller retains the
 * candidate lock and current authorization for the entire receipt read. */
export async function recoverMemoryDecisionInTx(
  tx: Prisma.TransactionClient,
  ctx: Actor,
  authorization: MemoryAuthorizationService,
  candidateId: string,
  action: MemoryDecisionAction,
  reason = '',
): Promise<RecordedMemoryDecision> {
  const rows = await tx.$queryRaw<
    Array<{ status: string; decidedBy: string | null; sourceKind: string }>
  >`
    SELECT status, decided_by::text AS "decidedBy", source_kind AS "sourceKind"
    FROM memory_candidate WHERE tenant_id=${ctx.tenantId}::uuid AND id=${candidateId}::uuid
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row || row.status === 'pending') throw new NotFoundException('Memory decision unavailable.');
  const membership = await tx.$queryRaw<Array<{ role: string }>>`
    SELECT role::text AS role FROM tenant_memberships
    WHERE tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid AND status='active'
    FOR SHARE
  `;
  if (membership[0]?.role !== ctx.role || row.decidedBy !== ctx.userId)
    throw new ForbiddenException(
      'The original reviewer must still have current access to recover this decision.',
    );
  const subject = await authorization.loadCandidateInTx(tx, ctx.tenantId, candidateId);
  if (
    !subject ||
    !(await authorization.evaluateInTx(tx, ctx, subject, 'read', { emitDenialMetrics: false }))
      .allowed
  )
    throw new NotFoundException('Memory decision unavailable.');
  if (row.status !== (action === 'reject' ? 'rejected' : 'approved'))
    throw new ConflictException('This candidate already has a different disposition.');
  const audits = await tx.$queryRaw<Array<{ metadata: unknown }>>`
    SELECT metadata_jsonb AS metadata FROM memory_transition_audit
    WHERE tenant_id=${ctx.tenantId}::uuid AND memory_candidate_id=${candidateId}::uuid
      AND actor_user_id=${ctx.userId}::uuid AND metadata_jsonb->>'decisionVersion'='1'
    ORDER BY occurred_at,id LIMIT 2
  `;
  if (audits.length !== 1)
    throw new ServiceUnavailableException(
      'The original memory decision receipt is unavailable. Read its current status before continuing.',
    );
  const recorded = decodeDecision(candidateId, audits[0]!.metadata);
  if (recorded.action !== action || recorded.reasonHash !== hashReason(reason))
    throw new ConflictException('This candidate was decided with a different action or reason.');
  const kind = candidateKindForSource(row.sourceKind);
  if (
    recorded.result.candidateKind !== kind &&
    !(
      row.sourceKind === 'learning_signal' &&
      recorded.result.candidateKind === 'learning_signal_conflict'
    )
  )
    throw new ServiceUnavailableException('The original memory decision identity is inconsistent.');
  return recorded.result;
}
