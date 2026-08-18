import { Injectable } from '@nestjs/common';
import type {
  ContextOperationEnforcementDecision,
  ContextPacketMode,
} from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';

export interface ContextPlaneAuditPacketSummary {
  version: number;
  packetId?: string | null;
  traceHash?: string | null;
  persisted?: boolean;
  retrievalCompleteness?: string | null;
  retrievalStopReason?: string | null;
}

export interface ContextPlaneAuditInput {
  tenantId: string;
  actorUserId: string | null;
  requestId?: string | null;
  product: string | null;
  resolverSurface: string | null;
  rolloutMode: ContextPacketMode | 'not_evaluated';
  decision: ContextOperationEnforcementDecision;
  packet?: ContextPlaneAuditPacketSummary | null;
}

/**
 * Bounded governance evidence for the Phase 18 operation gate.
 *
 * The audit intentionally stores no prompt, response, retrieval payload, memory
 * body, evidence excerpt, or model input. Audit failure is fatal at this
 * boundary: an enforcement decision that cannot be recorded must not silently
 * become an unaudited bypass.
 */
@Injectable()
export class ContextPlaneAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: ContextPlaneAuditInput): Promise<void> {
    const packet = input.packet;
    const metadata = {
      phase: 18,
      product: input.product,
      resolverSurface: input.resolverSurface,
      packetSurface: input.decision.surface,
      operationMode: input.decision.mode,
      decision: input.decision.allowed ? 'allow' : 'deny',
      decisionReason: input.decision.reason,
      rolloutMode: input.rolloutMode,
      migrationExceptionId: input.decision.migrationExceptionId,
      migrationTargetPhase: input.decision.migrationTargetPhase,
      packetVersion: packet?.version ?? null,
      packetId: packet?.packetId ?? null,
      packetTraceHash: packet?.traceHash ?? null,
      packetPersisted: packet?.persisted ?? null,
      retrievalCompleteness: packet?.retrievalCompleteness ?? null,
      retrievalStopReason: packet?.retrievalStopReason ?? null,
    };

    await this.prisma.withTenant(input.tenantId, async (tx) => {
      const inserted = await tx.$executeRaw`
        INSERT INTO audit_logs (
          id,
          tenant_id,
          actor_user_id,
          action,
          entity_type,
          entity_id,
          after_jsonb,
          request_id,
          occurred_at
        ) VALUES (
          uuid_generate_v4(),
          ${input.tenantId}::uuid,
          ${input.actorUserId}::uuid,
          ${`context_plane.operation.${input.decision.reason}`},
          'context_operation',
          ${input.decision.operationId},
          ${JSON.stringify(metadata)}::jsonb,
          ${input.requestId ?? null},
          NOW()
        )
      `;
      if (inserted !== 1) throw new Error('context_plane_audit_write_failed');
    });
  }
}
