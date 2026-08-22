import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  assertNoConfidentialEvaluationContent,
  computeEvaluationIdempotencyKey,
  evaluationEnabled,
  learningTenantSelected,
  type EvaluationCost,
  type EvaluationDeterministicMetrics,
  type EvaluationJudgeResult,
  type EvaluationSkipReason,
  type RecordEvaluationInput,
} from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';

export type RecordEvaluationResult =
  | { status: 'recorded'; id: string }
  | { status: 'duplicate'; id: string }
  | { status: 'disabled' }
  | { status: 'failed'; reason: string };

const POSTGRES_UNIQUE_VIOLATION = 'P2002';

/**
 * The ONE writer of `evaluation_record` (Phase 27F). Same never-throw
 * contract as `QualityTelemetryCaptureService.recordEvent` and for the same
 * reason: an evaluation is a shadow of a real request, and recording (or
 * failing to record) that shadow must never affect the real request's
 * outcome. Every failure mode (disabled, invalid input, DB error) resolves
 * to a typed result; nothing throws into the caller.
 *
 * `recordDecision` is the ONLY entry point that can create a row — always
 * `pending` (eligible + sampled, replay about to run) or `skipped` (not
 * eligible, or eligible but not sampled). `markRunning`/`markCompleted`/
 * `markFailed` transition that SAME row once the detached control replay
 * finishes; none of the four methods runs the replay itself — that is the
 * surface-specific runner's job (e.g. `OutreachEvaluationRunner`), which
 * calls this service only to persist state.
 */
@Injectable()
export class EvaluationCaptureService {
  private readonly logger = new Logger(EvaluationCaptureService.name);

  constructor(private readonly prisma: PrismaService) {}

  async recordDecision(input: RecordEvaluationInput): Promise<RecordEvaluationResult> {
    if (!evaluationEnabled(process.env.LEARNING_EVALUATION)) {
      return { status: 'disabled' };
    }
    try {
      validate(input);
      // Phase 27G rollout bound — see learningTenantSelected. Checked after
      // validate() for the same reason as QualityTelemetryCaptureService,
      // and before write() so a tenant outside the allowlist produces no
      // evaluation_record row at all — not even a skipped/not_sampled one.
      if (!learningTenantSelected(input.tenantId)) {
        return { status: 'disabled' };
      }
      return await this.write(input);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`EvaluationCaptureService.recordDecision failed: ${reason}`);
      return { status: 'failed', reason };
    }
  }

  /** pending -> running. Never throws; a failed transition is logged only. */
  async markRunning(tenantId: string, id: string): Promise<void> {
    try {
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.evaluationRecord.updateMany({
          where: { id, tenantId, status: 'pending' },
          data: { status: 'running', startedAt: new Date() },
        }),
      );
    } catch (error) {
      this.logger.warn(
        `EvaluationCaptureService.markRunning failed for ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** running -> completed, with the replay's results. Never throws. */
  async markCompleted(
    tenantId: string,
    id: string,
    result: {
      readonly treatmentOutputHash?: string | null;
      readonly controlOutputHash?: string | null;
      readonly controlProjectionPolicy?: string | null;
      readonly metrics?: EvaluationDeterministicMetrics | null;
      readonly judge?: EvaluationJudgeResult | null;
      readonly cost?: EvaluationCost | null;
    },
  ): Promise<void> {
    try {
      assertNoConfidentialEvaluationContent({
        metrics: result.metrics,
        judge: result.judge,
        cost: result.cost,
      });
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.evaluationRecord.updateMany({
          where: { id, tenantId, status: 'running' },
          data: {
            status: 'completed',
            completedAt: new Date(),
            treatmentOutputHash: result.treatmentOutputHash ?? null,
            controlOutputHash: result.controlOutputHash ?? null,
            controlProjectionPolicy: result.controlProjectionPolicy ?? null,
            metricsJsonb: toJsonInput(result.metrics),
            judgeJsonb: toJsonInput(result.judge),
            costJsonb: toJsonInput(result.cost),
          },
        }),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`EvaluationCaptureService.markCompleted failed for ${id}: ${reason}`);
      await this.markFailed(tenantId, id, `record_completed_failed:${reason.slice(0, 120)}`);
    }
  }

  /** running (or pending, if the replay never started) -> failed. Never throws. */
  async markFailed(tenantId: string, id: string, failureReason: string): Promise<void> {
    try {
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.evaluationRecord.updateMany({
          where: { id, tenantId, status: { in: ['pending', 'running'] } },
          data: {
            status: 'failed',
            completedAt: new Date(),
            failureReason: failureReason.slice(0, 160),
          },
        }),
      );
    } catch (error) {
      this.logger.error(
        `EvaluationCaptureService.markFailed failed for ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async write(input: RecordEvaluationInput): Promise<RecordEvaluationResult> {
    const idempotencyKey = computeEvaluationIdempotencyKey({
      surface: input.surface,
      operation: input.operation,
      treatmentArtifactId: input.treatmentArtifactId,
      treatmentArtifactVersionSeq: input.treatmentArtifactVersionSeq,
      evaluationType: input.evaluationType,
      configVersion: input.configVersion,
    });
    try {
      const created = await this.prisma.withTenant(input.tenantId, async (tx) => {
        return tx.evaluationRecord.create({
          data: {
            tenantId: input.tenantId,
            clientId: input.clientId ?? null,
            surface: input.surface,
            operation: input.operation,
            evaluationType: input.evaluationType,
            status: input.status,
            skipReason: input.skipReason ?? null,
            failureReason: input.failureReason ?? null,
            contextPacketId: input.contextPacketId ?? null,
            qualityTelemetryEventId: input.qualityTelemetryEventId ?? null,
            treatmentArtifactType: input.treatmentArtifactType ?? null,
            treatmentArtifactId: input.treatmentArtifactId,
            treatmentArtifactVersionSeq: input.treatmentArtifactVersionSeq ?? null,
            treatmentOutputHash: input.treatmentOutputHash ?? null,
            controlOutputHash: input.controlOutputHash ?? null,
            controlProjectionPolicy: input.controlProjectionPolicy ?? null,
            metricsJsonb: toJsonInput(input.metrics),
            judgeJsonb: toJsonInput(input.judge),
            costJsonb: toJsonInput(input.cost),
            samplingKey: input.samplingKey,
            configVersion: input.configVersion,
            traceId: input.traceId ?? null,
            observedAt: input.observedAt,
            idempotencyKey,
          },
          select: { id: true },
        });
      });
      return { status: 'recorded', id: created.id };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.prisma.withTenant(input.tenantId, (tx) =>
        tx.evaluationRecord.findFirst({
          where: { tenantId: input.tenantId, idempotencyKey },
          select: { id: true },
        }),
      );
      if (existing) return { status: 'duplicate', id: existing.id };
      throw error;
    }
  }
}

function validate(input: RecordEvaluationInput): void {
  if (!input.tenantId) throw new Error('EvaluationCaptureService.recordDecision: tenantId is required');
  if (!input.surface) throw new Error('EvaluationCaptureService.recordDecision: surface is required');
  if (!input.operation) throw new Error('EvaluationCaptureService.recordDecision: operation is required');
  if (!input.treatmentArtifactId) {
    throw new Error('EvaluationCaptureService.recordDecision: treatmentArtifactId is required');
  }
  if (input.status === 'skipped' && !input.skipReason) {
    throw new Error('EvaluationCaptureService.recordDecision: skipReason is required when status is skipped');
  }
  assertNoConfidentialEvaluationContent({ metrics: input.metrics, judge: input.judge, cost: input.cost });
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

/** Re-exported for tests that need the skip-reason union without a second import path. */
export type { EvaluationSkipReason };
