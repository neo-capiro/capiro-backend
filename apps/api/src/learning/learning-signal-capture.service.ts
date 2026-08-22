import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  assertEvidencePresentWhenProposingMemory,
  assertKnownSteeringLayer,
  assertNoAiSelfCorroboration,
  computeLearningSignalIdempotencyKey,
  learningSignalCaptureEnabled,
  learningTenantSelected,
  type CaptureLearningSignalInput,
} from '@capiro/meriv2-core';

export type CaptureLearningSignalResult =
  | { status: 'captured'; id: string }
  | { status: 'duplicate'; id: string }
  | { status: 'disabled' };

const POSTGRES_UNIQUE_VIOLATION = 'P2002';

/**
 * The ONE writer of `learning_signal` (Phase 27A). Mirrors
 * `MemoryTransitionAuditService`'s shape deliberately: it runs on the
 * CALLER's transaction — so a signal commits or rolls back atomically with
 * the product action it is evidence of — and has no constructor
 * dependencies of its own.
 *
 * Everything this service explicitly does NOT do in 27A:
 *  - never writes to memory_items / memory_candidate / clio_memory
 *  - never changes Context Plane recall, packet compilation, or any product
 *    operation's behavior
 *  - never promotes a signal into active memory (no such code path exists
 *    yet — that is 27B/27D)
 */
@Injectable()
export class LearningSignalCaptureService {
  async capture(
    tx: Prisma.TransactionClient,
    input: CaptureLearningSignalInput,
  ): Promise<CaptureLearningSignalResult> {
    // Operational kill switch, checked first and before any validation —
    // disabling capture must be a same-day, no-redeploy escape hatch, not
    // something that can itself throw.
    if (!learningSignalCaptureEnabled(process.env.LEARNING_SIGNAL_CAPTURE)) {
      return { status: 'disabled' };
    }
    if (!input.tenantId) {
      throw new Error('LearningSignalCaptureService.capture: tenantId is required');
    }
    // Phase 27G rollout bound. ANDed with — never a replacement for — the
    // kill switch above: capture stays off for any tenant not named in
    // LEARNING_TENANTS, and the kill switch still stops every tenant at
    // once. An unset allowlist selects nobody, so capture is armed by
    // naming a tenant rather than merely by deploying this code.
    if (!learningTenantSelected(input.tenantId)) {
      return { status: 'disabled' };
    }
    if (!input.actorUserId) {
      throw new Error('LearningSignalCaptureService.capture: actorUserId is required');
    }

    // Fail-closed invariants — see contract.ts. These throw rather than
    // silently downgrading the input, so a bug that tries to smuggle
    // AI-only provenance into a human-tier authority (or a sixth context
    // layer) is a loud failure, not a quietly wrong row.
    assertNoAiSelfCorroboration(input);
    assertKnownSteeringLayer(input.proposedMemoryLayer ?? null);
    assertEvidencePresentWhenProposingMemory(input);

    const idempotencyKey = computeLearningSignalIdempotencyKey(input);

    try {
      const created = await tx.learningSignal.create({
        data: {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          clientId: input.clientId ?? null,
          sourceSurface: input.sourceSurface,
          sourceObjectType: input.sourceObjectType,
          sourceObjectId: input.sourceObjectId,
          sourceRunId: input.sourceRunId ?? null,
          signalType: input.signalType,
          proposedMemoryLayer: input.proposedMemoryLayer ?? null,
          proposedMemoryClass: input.proposedMemoryClass ?? null,
          evidenceJsonb: (input.evidenceRefs ?? []) as unknown as Prisma.InputJsonValue,
          confidence: input.confidence ?? null,
          sourceAuthority: input.sourceAuthority ?? null,
          sensitivity: input.sensitivity ?? 'normal',
          provenanceKind: input.provenanceKind,
          provenanceJsonb: (input.provenance ?? {}) as unknown as Prisma.InputJsonValue,
          governanceRequirement: input.governanceRequirement ?? 'human_required',
          idempotencyKey,
          observedAt: input.observedAt,
        },
        select: { id: true },
      });
      return { status: 'captured', id: created.id };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Duplicate delivery of the same logical event (retry, double-submit).
      // Look the row back up rather than treating this as a failure.
      const existing = await tx.learningSignal.findFirst({
        where: { tenantId: input.tenantId, idempotencyKey },
        select: { id: true },
      });
      if (existing) return { status: 'duplicate', id: existing.id };
      throw error;
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === POSTGRES_UNIQUE_VIOLATION
  );
}
