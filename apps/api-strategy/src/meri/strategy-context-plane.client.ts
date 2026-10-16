import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { digest, SHA256, UUID, SAFE_FAILURES, type ObjectiveAdmission } from './objective-generation.types.js';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type {
  StrategyGovernedOperation,
  StrategyGovernedTurnContext,
} from './strategy-governed-context.types.js';

export type StrategyContextMode = 'draft' | 'assistant' | 'document';
export type StrategyArtifactKind = 'workspace_draft' | 'outreach_record';

export interface StrategyContextPlaneRequest {
  objective?: { objectiveId: string; objectiveVersion: number };
  generationRequestId?: string;
  generationType?: string;
  tenantId: string;
  clerkUserId: string;
  clientId: string;
  mode: StrategyContextMode;
  query?: string | null;
  strategyId?: string | null;
  nodeId?: string | null;
  traceId?: string | null;
  artifactKind?: StrategyArtifactKind | null;
}

interface CompileResponse {
  objectiveTypedContext?: unknown;
  objectiveAdmission?: ObjectiveAdmission;
  kind?: 'governed_packet' | 'release_switch_rollback';
  governedContext?: StrategyGovernedTurnContext;
}

/**
 * api-strategy's only cross-service Context Plane client.
 *
 * It does not resolve identity, query product tables, compile memory, or write a
 * ContextPacket. The main API re-resolves the Clerk actor, membership, ethical
 * wall and mailbox envelope, then returns the runtime-only governed projection.
 */
@Injectable()
export class StrategyContextPlaneClient {
  private readonly logger = new Logger(StrategyContextPlaneClient.name);
  private readonly apiBaseUrl: string;
  private readonly sharedSecret?: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.apiBaseUrl = (
      config.get<string>('API_INTERNAL_URL') ??
      config.get<string>('API_BASE_URL') ??
      'https://app.capiro.ai'
    ).replace(/\/+$/, '');
    this.sharedSecret = config.get<string>('INTERNAL_SERVICE_SECRET');
    this.timeoutMs = Number.parseInt(
      config.get<string>('STRATEGY_CONTEXT_PLANE_TIMEOUT_MS') ?? '60000',
      10,
    );
  }

  async compile(request: StrategyContextPlaneRequest, onAdmission?: (admission: ObjectiveAdmission) => Promise<void>,
    onTypedContext?: (projection: unknown) => Promise<void>): Promise<StrategyGovernedTurnContext> {
    const expectedOperation = operationFor(request.mode, request.artifactKind ?? null);
    const expectedSurface = surfaceFor(expectedOperation);
    if (!this.sharedSecret) {
      throw new ServiceUnavailableException('Strategy Context Plane is not configured');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.apiBaseUrl}/api/internal/strategy/context/compile`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-service-secret': this.sharedSecret,
        },
        body: JSON.stringify({
          tenantId: request.tenantId,
          clerkUserId: request.clerkUserId,
          clientId: request.clientId,
          mode: request.mode,
          query: request.query ?? null,
          strategyId: request.strategyId ?? null,
          nodeId: request.nodeId ?? null,
          traceId: request.traceId ?? null,
          artifactKind: request.artifactKind ?? null,
          ...(request.objective ? { objective: request.objective, generationRequestId: request.generationRequestId, generationType: request.generationType } : {}),
          ...(request.objective && onTypedContext ? { objectiveTypedContext: true } : {}),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = (error as Error).name === 'AbortError';
      this.logger.warn(`Strategy Context Plane ${timedOut ? 'timed out' : 'request failed'}`);
      throw new ServiceUnavailableException(
        timedOut ? 'Strategy Context Plane timed out' : 'Strategy Context Plane is unavailable',
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      if (request.objective && response.status === 409) throw new ConflictException({ code: 'OBJECTIVE_VERSION_CONFLICT', message: SAFE_FAILURES.OBJECTIVE_VERSION_CONFLICT });
      if (request.objective && response.status === 400) {
        const failure = await response.json().catch(() => null) as any;
        if (failure?.code === 'OBJECTIVE_CONTEXT_INCOMPLETE') throw new BadRequestException({ code: failure.code, message: SAFE_FAILURES[failure.code], issues: failure.issues });
      }
      this.logger.warn(`Strategy Context Plane returned HTTP ${response.status}`);
      throw new ServiceUnavailableException(
        `Strategy Context Plane rejected the request (HTTP ${response.status})`,
      );
    }

    let body: CompileResponse;
    try {
      body = (await response.json()) as CompileResponse;
    } catch {
      throw new ServiceUnavailableException('Strategy Context Plane returned an invalid response');
    }

    const governed = body.governedContext;
    if (
      (body.kind !== 'governed_packet' && body.kind !== 'release_switch_rollback') ||
      !governed ||
      governed.version !== 1 ||
      governed.operationId !== expectedOperation ||
      typeof governed.prompt !== 'string' ||
      !governed.prompt.trim() ||
      !governed.contextPacket ||
      governed.contextPacket.clientId !== request.clientId ||
      governed.contextPacket.surface !== expectedSurface ||
      !governed.retrieval ||
      !governed.retrieval.coverage
    ) {
      throw new ServiceUnavailableException('Strategy Context Plane scope validation failed');
    }
    if (request.objective) {
      const admission = body.objectiveAdmission;
      if (!admission || admission.tenantId !== request.tenantId || admission.clerkUserId !== request.clerkUserId ||
          admission.requestId !== request.generationRequestId || admission.type !== request.generationType ||
          admission.source?.clientId !== request.clientId || admission.source.objectiveId !== request.objective.objectiveId ||
          admission.source.objectiveVersion !== request.objective.objectiveVersion || !UUID.test(admission.source.objectiveRevisionId) ||
          admission.context?.state !== 'complete' || admission.context.issues?.length !== 0 ||
          admission.context.reobservedAt !== null ||
          typeof admission.context.packetId !== 'string' || !admission.context.packetId.trim() ||
          typeof admission.context.compiledAt !== 'string' || !Number.isFinite(Date.parse(admission.context.compiledAt)) ||
          admission.context.packetId !== governed.contextPacket.packetId || admission.context.compiledAt !== governed.contextPacket.compiledAt ||
          !governed.contextPacket.persisted || governed.contextPacket.degraded || !governed.retrieval.coverage.complete ||
          !governed.retrieval.coverage.paginationComplete || governed.retrieval.coverage.truncated ||
          ![admission.localDigest, admission.externalDigest, admission.historyDigest, admission.context.sourceDigest, admission.context.coverageDigest, admission.context.inputDigest]
            .every(d => typeof d === 'string' && SHA256.test(d)) ||
          !Array.isArray(admission.contactIds) || !admission.contactIds.every(id => typeof id === 'string' && id.length <= 128) ||
          !Array.isArray(admission.coverage) ||
          typeof admission.historyObservedAt !== 'string' || !Number.isFinite(Date.parse(admission.historyObservedAt)) ||
          digest({ manifest: admission.coverage, history: governed.retrieval.coverage, policy: 'objective-v1-required-lossless' }) !== admission.context.coverageDigest ||
          digest({ sourceDigest: admission.context.sourceDigest, coverageDigest: admission.context.coverageDigest,
            packetId: admission.context.packetId, requestId: admission.requestId, type: admission.type,
            localDigest: admission.localDigest, externalDigest: admission.externalDigest,
            historyDigest: admission.historyDigest,
            promptDigest: digest(governed.prompt) }) !== admission.context.inputDigest ||
          digest({ source: admission.source, intent: admission.intent }) !== admission.context.sourceDigest || !onAdmission)
        throw new ServiceUnavailableException('Objective context scope validation failed');
      await onAdmission(admission);
      if (onTypedContext) {
        if (!body.objectiveTypedContext) throw new ServiceUnavailableException('Objective typed context unavailable');
        await onTypedContext(body.objectiveTypedContext);
      }
    }
    return governed;
  }

  /** Fresh external observation only. Does not compile/substitute another packet. */
  async recheckObjective(request: StrategyContextPlaneRequest, admission: ObjectiveAdmission): Promise<string> {
    if (!this.sharedSecret) throw new ServiceUnavailableException('Strategy Context Plane is not configured');
    let body: any;
    try {
      const response = await fetch(`${this.apiBaseUrl}/api/internal/strategy/context/objective-check`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-service-secret': this.sharedSecret },
        body: JSON.stringify(request), signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error('Objective check rejected');
      body = await response.json();
    } catch { throw new ServiceUnavailableException('Objective source check unavailable'); }
    if (!body?.complete || body.tenantId !== request.tenantId || body.clerkUserId !== request.clerkUserId ||
        body.requestId !== request.generationRequestId || digest(body.source) !== digest(admission.source) ||
        body.sourceDigest !== admission.context.sourceDigest || body.localDigest !== admission.localDigest ||
        body.externalDigest !== admission.externalDigest || body.historyDigest !== admission.historyDigest ||
        typeof body.checkedAt !== 'string' || !Number.isFinite(Date.parse(body.checkedAt)))
      throw new BadRequestException({ code: 'OBJECTIVE_CONTEXT_INCOMPLETE', message: SAFE_FAILURES.OBJECTIVE_CONTEXT_INCOMPLETE });
    return body.checkedAt;
  }
}

export function operationFor(
  mode: StrategyContextMode,
  artifactKind: StrategyArtifactKind | null,
): StrategyGovernedOperation {
  if (mode !== 'document') return 'strategies.generate';
  if (artifactKind === 'workspace_draft') return 'workspace.generate';
  if (artifactKind === 'outreach_record') return 'outreach.generate';
  throw new ServiceUnavailableException('Strategy document context requires an artifact kind');
}

function surfaceFor(operationId: StrategyGovernedOperation): string {
  if (operationId === 'workspace.generate') return 'workspace-gen';
  if (operationId === 'outreach.generate') return 'outreach';
  return 'strategy';
}
