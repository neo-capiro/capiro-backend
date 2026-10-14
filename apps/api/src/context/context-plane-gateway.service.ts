import {
  ForbiddenException,
  Injectable,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
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
  type ContextPlaneAuditCoverageSummary,
  type ContextPlaneAuditInput,
  type ContextPlaneAuditPacketSummary,
  type ContextPlaneAuditResolutionSummary,
} from './context-plane-audit.service.js';
import * as operationRegistry from './context-plane-operation-registry.js';
import type { ContextPlaneOperationRegistration } from './context-plane-operation-registry.js';
import {
  ContextPacketV2Service,
  type Phase17CompiledContextPacket,
} from './context-packet-v2.service.js';
import { ContextResolverService } from './context-resolver.service.js';
import type { ContextResolutionRequest, ContextRetrievalResult } from './context-resolver.types.js';
import { contextStageTimer } from './context-stage-timer.service.js';
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
export class ContextPlaneGatewayService implements OnApplicationBootstrap, OnApplicationShutdown {
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
    this.meetingsRuntime = new MeetingsContextPlaneRuntime(this, this.prisma, this.moduleRef);
    this.meetingsRuntime.install();
  }

  onApplicationShutdown(): void {
    this.meetingsRuntime?.restoreForTest();
    this.meetingsRuntime = null;
  }

  async requestContext(request: ContextPlaneGatewayRequest): Promise<ContextPlaneGatewayResult> {
    // One measurement scope per governed operation. Opened HERE, at the single
    // supported boundary, so every adopted operation is instrumented by
    // construction rather than by per-product opt-in.
    return contextStageTimer.run(() => this.requestContextInner(request));
  }

  private async requestContextInner(
    request: ContextPlaneGatewayRequest,
  ): Promise<ContextPlaneGatewayResult> {
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
    const packet = await contextStageTimer.time('compile', () =>
      this.packets.compile(request.contextRequest, context, request.resolverRequest.retrieval),
    );
    const decision = evaluateContextOperationEnforcement({
      operationId: request.operationId,
      requestedSurface: request.contextRequest.surface,
      registration: operation.registration,
      rolloutMode,
      packet,
      currentPhase: request.currentPhase ?? CONTEXT_PLANE_ENFORCEMENT_PHASE,
    });

    await this.auditDecision(
      request,
      operation,
      rolloutMode,
      decision,
      packetSummary(packet),
      context,
    );
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
    context?: ContextRetrievalResult,
  ): Promise<void> {
    await this.audit.record({
      tenantId: request.resolverRequest.tenantId,
      actorUserId: request.resolverRequest.actorUserId,
      requestId: request.requestId,
      traceId: request.contextRequest.traceId ?? null,
      product: operation?.registration.product ?? null,
      resolverSurface: operation?.resolverSurface ?? request.resolverRequest.surface,
      rolloutMode,
      decision,
      packet,
      timings: contextStageTimer.snapshot(),
      resolution: context ? resolutionSummary(context) : null,
      coverage: context ? coverageSummary(context) : null,
      requestedLayers: [...request.contextRequest.layers],
    });
  }
}

/**
 * Resolver outcome, IDs and enums only. Deliberately excludes the task string,
 * entity names and every retrieved body.
 */
function resolutionSummary(context: ContextRetrievalResult): ContextPlaneAuditResolutionSummary {
  const resolution = context.resolution;
  return {
    status: resolution.status ?? null,
    stopReason: resolution.stopReason ?? null,
    subjectScopeKind: resolution.subjectScope?.kind ?? null,
    subjectClientCount: resolution.subjectScope?.clientIds?.length ?? 0,
    retrievalAllowed: resolution.retrievalAllowed ?? null,
  };
}

/**
 * Coverage is reported as the full state vector, never collapsed into one
 * success boolean. `zero results !== complete coverage` is the whole point of
 * the manifest: an unavailable, unauthorized, degraded, pagination-incomplete,
 * truncated or unsupported source has to stay visibly distinct in telemetry, or
 * the Phase 27 baseline would score a blind operation as a healthy one.
 */
function coverageSummary(context: ContextRetrievalResult): ContextPlaneAuditCoverageSummary {
  const coverage = context.retrieval?.coverage;
  if (!coverage) {
    // Retrieval that never ran is NOT complete coverage.
    return {
      ran: false,
      complete: false,
      stopReason: 'retrieval_not_run',
      requestedDomains: [],
      searchedDomains: [],
      missingDomains: [],
      partialDomains: [],
      unavailableDomains: [],
      recordsEvaluated: 0,
      recordsReturned: 0,
      paginationComplete: false,
      truncated: false,
      sourceStatuses: {},
    };
  }
  const sources = coverage.sources ?? [];
  const statuses: Record<string, string> = {};
  const partial: string[] = [];
  // The manifest's own unavailable list is authoritative; per-source status adds
  // the ones a source self-reported without the manifest hoisting them.
  const unavailable: string[] = (coverage.unavailableSources ?? []).map(String);
  let truncated = false;
  for (const source of sources) {
    const status = String(source.sourceStatus);
    statuses[String(source.domain)] = status;
    if (source.truncated === true) truncated = true;
    if (status === 'unavailable' || status === 'unauthorized' || status === 'unsupported') {
      unavailable.push(String(source.domain));
    } else if (status === 'degraded' || source.coverageComplete === false) {
      partial.push(String(source.domain));
    }
  }
  const requested = (coverage.requestedDomains ?? []).map(String);
  const searched = (coverage.searchedDomains ?? []).map(String);
  return {
    ran: true,
    complete: coverage.complete === true,
    stopReason: coverage.stopReason ?? null,
    requestedDomains: requested,
    searchedDomains: searched,
    missingDomains: requested.filter((domain) => !searched.includes(domain)),
    partialDomains: [...new Set(partial)],
    unavailableDomains: [...new Set(unavailable)],
    recordsEvaluated: coverage.recordsEvaluated ?? 0,
    recordsReturned: coverage.recordsReturned ?? 0,
    paginationComplete: coverage.paginationComplete === true,
    truncated,
    sourceStatuses: statuses,
  };
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
  const health = asRecord(value.health);
  const items = Array.isArray(value.items) ? value.items : [];
  const exclusions = Array.isArray(value.exclusions) ? value.exclusions : [];
  const rendered = Array.isArray(value.rendered) ? value.rendered : [];

  // Which of the five layers actually SURVIVED into the packet, and for the
  // ones that did not, the recorded exclusion reasons. This is the difference
  // between 'firm identity was not requested' and 'firm identity was
  // requested and dropped as unapproved' — the distinction that made the
  // missing institutional layer diagnosable at all.
  const presentLayers = [...new Set(items.map((item) => layerOf(item)).filter(isText))];
  const reasonsByLayer: Record<string, string[]> = {};
  for (const exclusion of exclusions) {
    const record = asRecord(exclusion);
    const layer = isText(record.layer) ? record.layer : 'unknown';
    const reason = isText(record.reason) ? record.reason : 'unspecified';
    const seen = reasonsByLayer[layer] ?? [];
    if (!seen.includes(reason)) seen.push(reason);
    reasonsByLayer[layer] = seen;
  }
  const requiredLayers = Array.isArray(value.requiredLayers)
    ? value.requiredLayers.filter(isText)
    : [];
  const missingRequired = Array.isArray(health.missingRequiredLayers)
    ? health.missingRequiredLayers.filter(isText)
    : [];
  const missingLayers = [
    ...new Set([
      ...missingRequired,
      ...requiredLayers.filter((layer) => !presentLayers.includes(layer)),
    ]),
  ];

  return {
    version: packet.version,
    packetId: typeof value.packetId === 'string' ? value.packetId : null,
    traceHash: typeof value.traceHash === 'string' ? value.traceHash : null,
    persisted: typeof value.persisted === 'boolean' ? value.persisted : undefined,
    retrievalCompleteness:
      typeof value.retrievalCompleteness === 'string' ? value.retrievalCompleteness : null,
    retrievalStopReason:
      typeof value.retrievalStopReason === 'string' ? value.retrievalStopReason : null,
    health: isText(health.status) ? health.status : null,
    healthReasons: Array.isArray(health.reasons) ? health.reasons.filter(isText) : null,
    itemCount: items.length,
    exclusionCount: exclusions.length,
    presentLayers,
    missingLayers,
    exclusionReasonsByLayer: reasonsByLayer,
    tokenBudget: typeof value.totalTokenBudget === 'number' ? value.totalTokenBudget : null,
    tokensUsed: typeof value.usedTokens === 'number' ? value.usedTokens : null,
    // Rendered body LENGTH only. The bodies themselves never leave the packet.
    blockChars: rendered.reduce((sum, entry) => sum + bodyLength(entry), 0),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function layerOf(item: unknown): string | undefined {
  const layer = asRecord(item).layer;
  return isText(layer) ? layer : undefined;
}

function bodyLength(entry: unknown): number {
  const body = asRecord(entry).body;
  return typeof body === 'string' ? body.length : 0;
}
