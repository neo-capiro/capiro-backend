import { Injectable, Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  assertKnownContextLayer,
  assertNoConfidentialContent,
  computeQualityTelemetryIdempotencyKey,
  qualityTelemetryEnabled,
  type RecordQualityTelemetryEventInput,
} from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';

export type RecordQualityTelemetryEventResult =
  | { status: 'recorded'; id: string }
  | { status: 'duplicate'; id: string }
  | { status: 'disabled' }
  | { status: 'failed'; reason: string };

const POSTGRES_UNIQUE_VIOLATION = 'P2002';

/**
 * The ONE writer of `quality_telemetry_event` / `quality_telemetry_memory_
 * item_use` (Phase 27E). Deliberately the opposite failure contract from
 * `LearningSignalCaptureService`: that service throws on bad input because a
 * signal must commit atomically with the product action it is evidence of.
 * Quality telemetry is observe-only with no such requirement, and the Phase
 * 27E handoff is explicit (§27): "telemetry must never break the user
 * workflow." So `recordEvent` NEVER throws — every failure mode (disabled,
 * invalid input, DB error) resolves to a typed result, and a write failure
 * is logged (safe metadata only) rather than swallowed silently (§27's other
 * half: "do not swallow errors invisibly").
 *
 * Runs on its own connection, not the caller's transaction — a telemetry
 * write must never be able to roll back or block the primary action, and a
 * primary-action rollback must not also erase the fact that the action was
 * attempted.
 */
@Injectable()
export class QualityTelemetryCaptureService {
  private readonly logger = new Logger(QualityTelemetryCaptureService.name);

  constructor(private readonly prisma: PrismaService) {}

  async recordEvent(
    input: RecordQualityTelemetryEventInput,
  ): Promise<RecordQualityTelemetryEventResult> {
    if (!qualityTelemetryEnabled(process.env.LEARNING_QUALITY_TELEMETRY)) {
      return { status: 'disabled' };
    }
    try {
      validate(input);
      return await this.write(input);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`QualityTelemetryCaptureService.recordEvent failed: ${reason}`);
      await this.recordFailureSafely(input, reason);
      return { status: 'failed', reason };
    }
  }

  private async write(
    input: RecordQualityTelemetryEventInput,
  ): Promise<RecordQualityTelemetryEventResult> {
    const idempotencyKey = computeQualityTelemetryIdempotencyKey(input);
    try {
      const created = await this.prisma.withTenant(input.tenantId, async (tx) => {
        return tx.qualityTelemetryEvent.create({
          data: {
            tenantId: input.tenantId,
            actorUserId: input.actorUserId ?? null,
            clientId: input.clientId ?? null,
            surface: input.surface,
            operation: input.operation,
            eventType: input.eventType,
            artifactType: input.artifactType ?? null,
            artifactId: input.artifactId ?? null,
            artifactVersionSeq: input.artifactVersionSeq ?? null,
            contextPacketId: input.contextPacketId ?? null,
            contextLayerCounts: toJsonInput(input.contextLayerCounts),
            learningSignalId: input.learningSignalId ?? null,
            memoryCandidateId: input.memoryCandidateId ?? null,
            editMetrics: toJsonInput(input.editMetrics),
            provenance: (input.provenance ?? {}) as unknown as Prisma.InputJsonValue,
            traceId: input.traceId ?? null,
            generatedAt: input.generatedAt ?? null,
            observedAt: input.observedAt,
            idempotencyKey,
            ...(input.memoryItemUses?.length
              ? {
                  memoryItemUses: {
                    create: input.memoryItemUses.map((use) => ({
                      tenantId: input.tenantId,
                      memoryItemId: use.memoryItemId,
                      contextLayer: use.contextLayer,
                    })),
                  },
                }
              : {}),
          },
          select: { id: true },
        });
      });
      return { status: 'recorded', id: created.id };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Duplicate delivery of the same logical event (retry, at-least-once
      // redelivery) — look the row back up rather than treating this as a
      // failure (§28: idempotency).
      const existing = await this.prisma.withTenant(input.tenantId, (tx) =>
        tx.qualityTelemetryEvent.findFirst({
          where: { tenantId: input.tenantId, idempotencyKey },
          select: { id: true },
        }),
      );
      if (existing) return { status: 'duplicate', id: existing.id };
      throw error;
    }
  }

  /**
   * Best-effort observability for a recording failure, itself wrapped so a
   * broken audit write can never surface as a second failure. Safe metadata
   * only (surface/operation/eventType/reason) — never the caller's raw
   * input, which may include values recordEvent rejected for exactly that
   * reason.
   */
  private async recordFailureSafely(
    input: RecordQualityTelemetryEventInput,
    reason: string,
  ): Promise<void> {
    try {
      await this.prisma.withTenant(input.tenantId, (tx) =>
        tx.auditLog.create({
          data: {
            tenantId: input.tenantId,
            action: 'quality_telemetry.record_failed',
            entityType: input.artifactType ?? 'unknown',
            entityId: input.artifactId ?? null,
            after: { surface: input.surface, operation: input.operation, eventType: input.eventType, reason },
          },
        }),
      );
    } catch (auditError) {
      this.logger.error(
        `QualityTelemetryCaptureService: failed to record failure audit row: ${
          auditError instanceof Error ? auditError.message : String(auditError)
        }`,
      );
    }
  }
}

function validate(input: RecordQualityTelemetryEventInput): void {
  if (!input.tenantId) {
    throw new Error('QualityTelemetryCaptureService.recordEvent: tenantId is required');
  }
  if (!input.surface) {
    throw new Error('QualityTelemetryCaptureService.recordEvent: surface is required');
  }
  if (!input.operation) {
    throw new Error('QualityTelemetryCaptureService.recordEvent: operation is required');
  }
  if (!input.eventType) {
    throw new Error('QualityTelemetryCaptureService.recordEvent: eventType is required');
  }
  assertNoConfidentialContent(input);
  for (const use of input.memoryItemUses ?? []) {
    assertKnownContextLayer(use.contextLayer);
  }
}

function toJsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value == null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === POSTGRES_UNIQUE_VIOLATION
  );
}

// Re-exported only for the resilience spec, which needs to construct a fake
// PrismaService without pulling in the full PrismaClient type.
export type QualityTelemetryPrismaTx = PrismaClient;
