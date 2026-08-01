import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  assertMemoryTransition,
  type GovernedMemoryStatus,
  type GovernedMemorySourceType,
} from '@capiro/meriv2-core';
import {
  normalizeAuditReason,
  sanitizeAuditMetadata,
  type CandidateTransitionReasonCode,
} from './memory-governance-lifecycle.helpers.js';

/**
 * Exactly one subject, enforced by the TYPE as well as by the DB.
 *
 * `memory_transition_exact_subject_check` (20260729010000:288-290) requires
 * (memory_item_id IS NOT NULL)::int + (memory_candidate_id IS NOT NULL)::int = 1.
 * Modelling that as a discriminated union means a caller cannot even express the
 * violating shape, so the CHECK is a backstop rather than the primary guard —
 * a CHECK violation here would abort the caller's whole transaction and roll back
 * the very state change the audit row exists to evidence.
 */
export type MemoryTransitionSubject =
  | { memoryItemId: string; memoryCandidateId?: undefined }
  | { memoryCandidateId: string; memoryItemId?: undefined };

export interface MemoryTransitionAuditInput {
  subject: MemoryTransitionSubject;
  /** null for a system/scheduled transition (TTL expiry, backfill). */
  actorUserId?: string | null;
  /** Tenant the actor was acting AS (impersonation-aware). Defaults to tenantId. */
  effectiveTenantId?: string | null;
  clientId?: string | null;
  /** Omit for a creation event; when present the hop is state-machine validated. */
  fromStatus?: GovernedMemoryStatus | null;
  toStatus: GovernedMemoryStatus;
  reasonCode: CandidateTransitionReasonCode;
  /** One-line human explanation. NEVER a memory body. */
  reason?: string | null;
  sourceType?: GovernedMemorySourceType | null;
  sourceId?: string | null;
  proposalId?: string | null;
  impersonationSessionId?: string | null;
  /** Scalars only; bodies are stripped and the 32 KiB CHECK is pre-enforced. */
  metadata?: Record<string, unknown> | null;
}

/**
 * The ONE writer of memory_transition_audit.
 *
 * Before this service the table had a single writer in the whole repo — the
 * offline classifier apps/api/scripts/backfill-memory-governance-v2.ts — so every
 * live state change (approve, reject, forget, correct, conflict resolution) left
 * no transition evidence at all.
 *
 * `record` takes the CALLER'S transaction client on purpose: the audit row must
 * commit or roll back atomically with the state change it describes. A separate
 * transaction would let a committed status flip lose its evidence (or, worse,
 * leave evidence for a change that rolled back).
 */
@Injectable()
export class MemoryTransitionAuditService {
  /**
   * Append one immutable transition row. Returns its id.
   *
   * Runs on the caller's `tx`, so the caller is responsible for tenant scoping —
   * memory_transition_audit is RLS-FORCED, and every governed write path already
   * runs inside withTenant/withTenantUser.
   */
  async record(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: MemoryTransitionAuditInput,
  ): Promise<string> {
    const itemId = input.subject.memoryItemId ?? null;
    const candidateId = input.subject.memoryCandidateId ?? null;
    if ((itemId === null) === (candidateId === null)) {
      throw new Error(
        'memory_transition_audit requires exactly one of memoryItemId / memoryCandidateId',
      );
    }
    if (input.fromStatus) assertMemoryTransition(input.fromStatus, input.toStatus);

    const created = await tx.memoryTransitionAudit.create({
      data: {
        tenantId,
        memoryItemId: itemId,
        memoryCandidateId: candidateId,
        actorUserId: input.actorUserId ?? null,
        effectiveTenantId: input.effectiveTenantId ?? tenantId,
        clientId: input.clientId ?? null,
        fromStatus: input.fromStatus ?? null,
        toStatus: input.toStatus,
        reasonCode: input.reasonCode,
        reason: normalizeAuditReason(input.reason, input.reasonCode),
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        proposalId: input.proposalId ?? null,
        impersonationSessionId: input.impersonationSessionId ?? null,
        metadata: sanitizeAuditMetadata(input.metadata) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return created.id;
  }

  /** Convenience for a multi-hop path (see candidateTransitionPath). */
  async recordAll(
    tx: Prisma.TransactionClient,
    tenantId: string,
    inputs: readonly MemoryTransitionAuditInput[],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const input of inputs) ids.push(await this.record(tx, tenantId, input));
    return ids;
  }
}
