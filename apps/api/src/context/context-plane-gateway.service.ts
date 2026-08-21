import {
  ForbiddenException,
  Injectable,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import {
  CONTEXT_PLANE_ENFORCEMENT_PHASE,
  evaluateContextOperationEnforcement,
  type ContextOperationEnforcementDecision,
  type ContextRequest,
} from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';
import { ContextCompilerService } from './context-compiler.service.js';
import {
  ContextPlaneAuditService,
  type ContextPlaneAuditInput,
  type ContextPlaneAuditPacketSummary,
} from './context-plane-audit.service.js';
import * as operationRegistry from './context-plane-operation-registry.js';
import type { ContextPlaneOperationRegistration } from './context-plane-operation-registry.js';
import {
  ContextPacketV2Service,
  type Phase17CompiledContextPacket,
} from './context-packet-v2.service.js';
import { ContextResolverService } from './context-resolver.service.js';
import type {
  ContextResolutionRequest,
  ContextRetrievalResult,
} from './context-resolver.types.js';
import { MeetingsContextPlaneRuntime } from './meetings-context-plane.runtime.js';

export interface ContextPlaneGatewayRequest {
  operationId: string;
  resolverRequest: ContextResolutionRequest;
  contextRequest: ContextRequest;
  requestId?: string | null;
  /** Test-only / staged phase evaluation. Production callers omit this. */
  currentPhase?: number;
}

export type ContextPlaneGatewayResult =
  | {
      kind: 'migration_exception';
      operation: ContextPlaneOperationRegistration;
      decision: ContextOperationEnforcementDecision;
    }
  | {
      kind: 'governed_packet' | 'release_switch_rollback';
      operation: ContextPlaneOperationRegistration;
      decision: ContextOperationEnforcementDecision;
      context: ContextRetrievalResult;
      packet: Phase17CompiledContextPacket;
    };

/**
 * Phase 18's single supported application boundary for context-aware AI work.
 *
 * Registered legacy operations may temporarily exit through a reviewed,
 * phase-bounded migration exception. Once an operation is packet-required, its
 * path is fixed: Phase 15 resolver/retrieval -> Phase 16 layer bridge -> Phase
 * 17 ContextPacket V2. No provider-specific or feature-specific RAG is exposed
 * from this service.
 *
 * Phase 24 also installs the compatibility runtime that guards the two mature
 * meeting AI methods. The runtime is constructed here so it cannot exist without
 * the same gateway instance that enforces operation/scope/surface policy.
 */
@Injectable()
export class ContextPlaneGatewayService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private meetingsRuntime: MeetingsContextPlaneRuntime | null = null;

  constructor(
    private readonly resolver: ContextResolverService,
    private readonly packets: ContextPacketV2Service,
    private readonly compiler: ContextCompilerService,
    private readonly audit: ContextPlaneAuditService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  onApplicationBootstrap(): void {
    // Unit tests instantiate this service directly with the four historical
    // dependencies. The optional Nest-only dependencies are present in the real
    // application and own the Phase 24 runtime installation.
    if (!this.moduleRef) return;
    if (!this.prisma) throw new Error('phase24_meetings_prisma_dependency_required');
    this.meetingsRuntime = new MeetingsContextPlaneRuntime(
      this,
      this.prisma,
      this.moduleRef,
    );
    this.meetingsRuntime.install();
  }

  onApplicationShutdown(): void {
    this.meetingsRuntime?.restoreForTest();
    this.meetingsRuntime = null;
  }

  async requestContext(request: ContextPlaneGatewayRequest): Promise<ContextPlaneGatewayResult> {
    const operation = operationRegistry.contextPlaneOperation(request.operationId);

    // Tenant/actor equality is checked before ANY tenant-settings lookup. A
    // mismatched internal request must not cause the gateway to touch another
    // tenant merely to resolve a rollout flag before it is denied.
    if (!this.scopeEnvelopeMatches(request)) {
      const decision = rejectedOperation(
        request.operationId,
        operation,
        'operation_scope_mismatch',
      );
      await this.auditDecision(request, operation ?? null, 'not_evaluated', decision, null);
      throw denied(decision);
    }

    // Surface registration is also pure validation and therefore happens before
    // the rollout lookup or any resolver/retrieval work.
    if (operation && !this.operationSurfacesMatch(request, operation)) {
      const decision = rejectedOperation(
        request.operationId,
        operation,
        'operation_surface_mismatch',
      );
      await this.auditDecision(request, operation, 'not_evaluated', decision, null);
      throw denied(decision);
    }

    const rolloutMode = await this.compiler.modeFor(
      request.contextRequest.tenantId,
      request.contextRequest.surface,
    );

    if (!operation) {
      const decision = evaluateContextOperationEnforcement({
        operationId: request.operationId,
        requestedSurface: request.contextRequest.surface,
        rolloutMode,
      });
      await this.auditDecision(request, null, rolloutMode, decision, null);
      throw denied(decision);
    }

    // A legacy migration exception is evaluated BEFORE retrieval so an old
    // feature path cannot partially query the Context Plane and then fall back.
    if (operation.registration.mode === 'migration_exception') {
      const exceptionDecision = evaluateContextOperationEnforcement({
        operationId: request.operationId,
        requestedSurface: request.contextRequest.surface,
        registration: operation.registration,
        rolloutMode,
        currentPhase: request.currentPhase ?? CONTEXT_PLANE_ENFORCEMENT_PHASE,
      });
      await this.auditDecision(request, operation, rolloutMode, exceptionDecision, null);
      if (!exceptionDecision.allowed) throw denied(exceptionDecision);
      return {
        kind: 'migration_exception',
        operation,
        decision: exceptionDecision,
      };
    }

    // A packet-required operation is never allowed to assemble context itself.
    const context = await this.resolver.resolveAndRetrieve(request.resolverRequest);
    // The original retrieval directive is deliberately forwarded separately.
    // Entity resolution can fail/ambiguous before Phase 15 can construct a
    // RetrievalRequest. Phase 17 must still know that domains were requested so
    // it records them as unchecked/unavailable rather than falsely calling the
    // turn "not requested" and complete.
    const packet = await this.packets.compile(
      request.contextRequest,
      context,
      request.resolverRequest.retrieval,
    );
    const decision = evaluateContextOperationEnforcement({
      operationId: request.operationId,
      requestedSurface: request.contextRequest.surface,
      registration: operation.registration,
      rolloutMode,
      packet,
      currentPhase: request.currentPhase ?? CONTEXT_PLANE_ENFORCEMENT_PHASE,
    });

    await this.auditDecision(request, operation, rolloutMode, decision, packetSummary(packet));
    if (!decision.allowed) throw denied(decision);

    return {
      kind:
        decision.reason === 'release_switch_rollback'
          ? 'release_switch_rollback'
          : 'governed_packet',
      operation,
      decision,
      context,
      packet,
    };
  }

  private scopeEnvelopeMatches(request: ContextPlaneGatewayRequest): boolean {
    const effectiveTenantId =
      request.contextRequest.effectiveTenantId ?? request.contextRequest.tenantId;
    const contextActor = request.contextRequest.actorUserId ?? request.contextRequest.userId;
    return (
      request.contextRequest.tenantId === request.resolverRequest.tenantId &&
      effectiveTenantId === request.resolverRequest.tenantId &&
      !!contextActor &&
      contextActor === request.resolverRequest.actorUserId
    );
  }

  private operationSurfacesMatch(
    request: ContextPlaneGatewayRequest,
    operation: ContextPlaneOperationRegistration,
  ): boolean {
    return (
      request.contextRequest.surface === operation.registration.surface &&
      request.resolverRequest.surface === operation.resolverSurface
    );
  }

  private async auditDecision(
    request: ContextPlaneGatewayRequest,
    operation: ContextPlaneOperationRegistration | null,
    rolloutMode: ContextPlaneAuditInput['rolloutMode'],
    decision: ContextOperationEnforcementDecision,
    packet: ContextPlaneAuditPacketSummary | null,
  ): Promise<void> {
    await this.audit.record({
      tenantId: request.resolverRequest.tenantId,
      actorUserId: request.resolverRequest.actorUserId,
      requestId: request.requestId,
      product: operation?.registration.product ?? null,
      resolverSurface: operation?.resolverSurface ?? request.resolverRequest.surface,
      rolloutMode,
      decision,
      packet,
    });
  }
}

function rejectedOperation(
  operationId: string,
  operation: ContextPlaneOperationRegistration | undefined,
  reason: 'operation_surface_mismatch' | 'operation_scope_mismatch',
): ContextOperationEnforcementDecision {
  return {
    allowed: false,
    reason,
    operationId,
    surface: operation?.registration.surface ?? null,
    mode: operation?.registration.mode ?? null,
    migrationExceptionId: operation?.registration.migrationException?.id ?? null,
    migrationTargetPhase: operation?.registration.migrationException?.targetPhase ?? null,
  };
}

function denied(decision: ContextOperationEnforcementDecision): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    error: 'Context Plane operation denied',
    code: `context_plane_${decision.reason}`,
  });
}

function packetSummary(packet: Phase17CompiledContextPacket): ContextPlaneAuditPacketSummary {
  const value = packet as unknown as Record<string, unknown>;
  return {
    version: packet.version,
    packetId: typeof value.packetId === 'string' ? value.packetId : null,
    traceHash: typeof value.traceHash === 'string' ? value.traceHash : null,
    persisted: typeof value.persisted === 'boolean' ? value.persisted : undefined,
    retrievalCompleteness:
      typeof value.retrievalCompleteness === 'string' ? value.retrievalCompleteness : null,
    retrievalStopReason:
      typeof value.retrievalStopReason === 'string' ? value.retrievalStopReason : null,
  };
}
