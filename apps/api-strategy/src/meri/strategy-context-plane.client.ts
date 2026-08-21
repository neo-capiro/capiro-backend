import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  StrategyGovernedOperation,
  StrategyGovernedTurnContext,
} from './strategy-governed-context.types.js';

export type StrategyContextMode = 'draft' | 'assistant' | 'document';
export type StrategyArtifactKind = 'workspace_draft' | 'outreach_record';

export interface StrategyContextPlaneRequest {
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

  async compile(request: StrategyContextPlaneRequest): Promise<StrategyGovernedTurnContext> {
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
    return governed;
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
