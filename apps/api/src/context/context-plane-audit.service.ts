import { Injectable } from '@nestjs/common';
import type {
  ContextOperationEnforcementDecision,
  ContextPacketMode,
} from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ContextStageTimings } from './context-stage-timer.service.js';

export interface ContextPlaneAuditPacketSummary {
  version: number;
  packetId?: string | null;
  traceHash?: string | null;
  persisted?: boolean;
  retrievalCompleteness?: string | null;
  retrievalStopReason?: string | null;
  /** Packet health enum, e.g. healthy/degraded. Never a reason body. */
  health?: string | null;
  healthReasons?: string[] | null;
  itemCount?: number | null;
  exclusionCount?: number | null;
  /** Steering layers actually present in the compiled packet. */
  presentLayers?: string[] | null;
  /** Requested layers with no surviving item, and why they were dropped. */
  missingLayers?: string[] | null;
  exclusionReasonsByLayer?: Record<string, string[]> | null;
  tokenBudget?: number | null;
  tokensUsed?: number | null;
  blockChars?: number | null;
}

export interface ContextPlaneAuditResolutionSummary {
  status: string | null;
  stopReason: string | null;
  subjectScopeKind: string | null;
  subjectClientCount: number;
  retrievalAllowed: boolean | null;
}

export interface ContextPlaneAuditCoverageSummary {
  ran: boolean;
  complete: boolean;
  stopReason: string | null;
  requestedDomains: string[];
  searchedDomains: string[];
  missingDomains: string[];
  partialDomains: string[];
  unavailableDomains: string[];
  recordsEvaluated: number;
  recordsReturned: number;
  paginationComplete: boolean;
  truncated: boolean;
  sourceStatuses: Record<string, string>;
}

export interface ContextPlaneAuditInput {
  tenantId: string;
  actorUserId: string | null;
  requestId?: string | null;
  traceId?: string | null;
  product: string | null;
  resolverSurface: string | null;
  rolloutMode: ContextPacketMode | 'not_evaluated';
  decision: ContextOperationEnforcementDecision;
  packet?: ContextPlaneAuditPacketSummary | null;
  timings?: ContextStageTimings | null;
  resolution?: ContextPlaneAuditResolutionSummary | null;
  coverage?: ContextPlaneAuditCoverageSummary | null;
  requestedLayers?: string[] | null;
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
    const timings = input.timings ?? null;
    const metadata = {
      phase: 18,
      product: input.product,
      traceId: input.traceId ?? null,
      // ── Stage latency ────────────────────────────────────────────────────
      // A stage that did not run reports null, not 0: zero is a real "ran and
      // was instant" measurement, so collapsing the two would make an
      // un-instrumented path look like the fastest path in the fleet.
      // `compileMs` INCLUDES `persistenceMs` (persistence is nested inside
      // compilation), so the two must not be summed.
      durationMs: timings
        ? {
            resolver: timings.resolverMs,
            retrieval: timings.retrievalMs,
            compile: timings.compileMs,
            persistence: timings.persistenceMs,
            provider: timings.providerMs,
            total: timings.totalMs,
          }
        : null,
      stageCalls: timings?.calls ?? null,
      provider: timings?.provider ?? null,
      resolution: input.resolution ?? null,
      coverage: input.coverage ?? null,
      requestedLayers: input.requestedLayers ?? null,
      packetHealth: packet?.health ?? null,
      packetHealthReasons: packet?.healthReasons ?? null,
      packetItemCount: packet?.itemCount ?? null,
      packetExclusionCount: packet?.exclusionCount ?? null,
      packetPresentLayers: packet?.presentLayers ?? null,
      packetMissingLayers: packet?.missingLayers ?? null,
      packetExclusionReasonsByLayer: packet?.exclusionReasonsByLayer ?? null,
      packetTokenBudget: packet?.tokenBudget ?? null,
      packetTokensUsed: packet?.tokensUsed ?? null,
      packetBlockChars: packet?.blockChars ?? null,
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
