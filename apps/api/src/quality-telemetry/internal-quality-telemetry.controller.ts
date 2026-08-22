import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  QUALITY_TELEMETRY_ARTIFACT_TYPES,
  QUALITY_TELEMETRY_EVENT_TYPES,
  QUALITY_TELEMETRY_SURFACES,
  type QualityTelemetryArtifactType,
  type QualityTelemetryEditMetrics,
  type QualityTelemetryEventType,
  type QualityTelemetrySurface,
} from '@capiro/meriv2-core';
import { InternalServiceGuard } from '../auth/internal-service.guard.js';
import {
  QualityTelemetryCaptureService,
  type RecordQualityTelemetryEventResult,
} from './quality-telemetry-capture.service.js';

interface RecordEventBody {
  tenantId?: string;
  actorUserId?: string | null;
  clientId?: string | null;
  surface?: string;
  operation?: string;
  eventType?: string;
  artifactType?: string | null;
  artifactId?: string | null;
  artifactVersionSeq?: number | null;
  contextPacketId?: string | null;
  editMetrics?: QualityTelemetryEditMetrics | null;
  provenance?: Record<string, unknown>;
  traceId?: string | null;
  generatedAt?: string | null;
  observedAt?: string;
}

/**
 * Backend-only Phase 27E bridge for the isolated Workspace and Strategies
 * services (separate databases from apps/api — see the Prisma model doc
 * comment on `artifactType`/`artifactId`). Mirrors
 * `InternalWorkspaceContextController`'s shape: same guard, same
 * `tenantId`-in-body pattern, because the caller has already authenticated
 * the end user against its own database and only needs to report a fact to
 * apps/api's centralized telemetry store.
 *
 * Never returns anything the caller could use to act on active memory or
 * governance — this endpoint's only effect is a `quality_telemetry_event`
 * row (or, on failure, nothing at all: see
 * `QualityTelemetryCaptureService.recordEvent`'s non-blocking contract).
 */
@Controller('internal/quality-telemetry')
@UseGuards(InternalServiceGuard)
export class InternalQualityTelemetryController {
  constructor(private readonly capture: QualityTelemetryCaptureService) {}

  @Post('events')
  async recordEvent(@Body() body: RecordEventBody): Promise<RecordQualityTelemetryEventResult> {
    const tenantId = required(body.tenantId, 'tenantId');
    const surface = requiredEnum(body.surface, 'surface', QUALITY_TELEMETRY_SURFACES);
    const eventType = requiredEnum(body.eventType, 'eventType', QUALITY_TELEMETRY_EVENT_TYPES);
    const operation = required(body.operation, 'operation');
    const observedAt = body.observedAt ? new Date(body.observedAt) : new Date();
    if (Number.isNaN(observedAt.getTime())) {
      throw new BadRequestException('observedAt must be a valid ISO date string');
    }
    const artifactType = body.artifactType
      ? requiredEnum(body.artifactType, 'artifactType', QUALITY_TELEMETRY_ARTIFACT_TYPES)
      : null;

    return this.capture.recordEvent({
      tenantId,
      actorUserId: body.actorUserId ?? null,
      clientId: body.clientId ?? null,
      surface,
      operation,
      eventType,
      artifactType,
      artifactId: body.artifactId ?? null,
      artifactVersionSeq: body.artifactVersionSeq ?? null,
      contextPacketId: body.contextPacketId ?? null,
      editMetrics: body.editMetrics ?? null,
      provenance: body.provenance ?? {},
      traceId: body.traceId ?? null,
      generatedAt: body.generatedAt ? new Date(body.generatedAt) : null,
      observedAt,
    });
  }
}

function required(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`${field} is required`);
  }
  return value.trim();
}

function requiredEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  const str = required(value, field);
  if (!(allowed as readonly string[]).includes(str)) {
    throw new BadRequestException(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return str as T;
}

// Re-exported so callers can narrow without importing the union types twice.
export type { QualityTelemetryArtifactType, QualityTelemetryEventType, QualityTelemetrySurface };
