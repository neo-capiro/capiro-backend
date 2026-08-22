import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { StrategyGovernedTurnContext } from './strategy-governed-context.types.js';
import type {
  NodeDocumentDraftResponse,
  ResolvedAiProvider,
  StewardExtractResponse,
  StrategyAssistantResponse,
  StrategyDraftResponse,
  StrategyReferenceAssistResponse,
} from './meri.types.js';
import { currentStrategyGovernedContext } from './strategy-governed-context.runtime.js';

/**
 * Explicit identity delegation for the governed hops. Paired with
 * INTERNAL_SERVICE_SECRET so a governed call does not depend on a ~60s Clerk
 * session token still being valid after the Context Plane compile. The
 * orchestrator re-resolves the tenant and re-checks ACTIVE membership, so this
 * conveys identity, never authorization.
 */
export interface ServiceDelegation {
  tenantId: string;
  clerkUserId: string;
}

/**
 * Outbound client to the MeriV2 orchestrator's Strategy surfaces.
 *
 * Draft/edit/document methods are fail-closed: they require the request-scoped
 * governed bundle established by the exported MeriService wrapper, inject it in
 * the body, and mark the hop with INTERNAL_SERVICE_SECRET. Reference-calendar
 * assistance and Steward extraction are separate operations and keep their
 * existing authenticated transport.
 */
@Injectable()
export class StrategyOrchestratorClient {
  private readonly logger = new Logger(StrategyOrchestratorClient.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly sharedSecret?: string;

  constructor(config: ConfigService) {
    this.baseUrl = (config.get<string>('MERIV2_ORCHESTRATOR_URL') ?? '').replace(/\/+$/, '');
    this.timeoutMs = Number(config.get<string>('STRATEGY_MERI_TIMEOUT_MS') ?? '60000');
    this.sharedSecret = config.get<string>('INTERNAL_SERVICE_SECRET');
  }

  get configured(): boolean {
    return this.baseUrl.length > 0;
  }

  /**
   * These three governed hops are `async` deliberately. `governedBody()` throws
   * when the request-scoped bundle is missing or mismatched; from a non-async
   * method that throw would escape SYNCHRONOUSLY out of a Promise-returning API,
   * so a caller using `.catch()` would miss the fail-closed error entirely.
   */
  async draft(
    body: unknown,
    bearerToken: string | undefined,
    aiProvider?: ResolvedAiProvider,
    delegation?: ServiceDelegation,
  ): Promise<StrategyDraftResponse> {
    return this.post<StrategyDraftResponse>(
      'strategy-draft',
      this.governedBody(body, ['strategies.generate']),
      bearerToken,
      aiProvider,
      true,
      delegation,
    );
  }

  async assistant(
    body: unknown,
    bearerToken: string | undefined,
    aiProvider?: ResolvedAiProvider,
    delegation?: ServiceDelegation,
  ): Promise<StrategyAssistantResponse> {
    return this.post<StrategyAssistantResponse>(
      'strategy-assistant',
      this.governedBody(body, ['strategies.generate']),
      bearerToken,
      aiProvider,
      true,
      delegation,
    );
  }

  referenceAssist(
    body: unknown,
    bearerToken: string | undefined,
    aiProvider?: ResolvedAiProvider,
  ): Promise<StrategyReferenceAssistResponse> {
    return this.post<StrategyReferenceAssistResponse>(
      'strategy-reference-assist',
      body,
      bearerToken,
      aiProvider,
    );
  }

  async nodeDocumentDraft(
    body: unknown,
    bearerToken: string | undefined,
    aiProvider?: ResolvedAiProvider,
    delegation?: ServiceDelegation,
  ): Promise<NodeDocumentDraftResponse> {
    const value = objectValue(body);
    const expected: StrategyGovernedTurnContext['operationId'] =
      value.kind === 'workspace_draft' ? 'workspace.generate' : 'outreach.generate';
    return this.post<NodeDocumentDraftResponse>(
      'strategy-document-draft',
      this.governedBody(body, [expected]),
      bearerToken,
      aiProvider,
      true,
      delegation,
    );
  }

  /** Stage E fact extraction is not Strategy plan generation. */
  stewardExtract(
    body: unknown,
    bearerToken: string | undefined,
    aiProvider?: ResolvedAiProvider,
  ): Promise<StewardExtractResponse> {
    return this.post<StewardExtractResponse>('steward-extract', body, bearerToken, aiProvider);
  }

  private governedBody(
    body: unknown,
    allowedOperations: readonly StrategyGovernedTurnContext['operationId'][],
  ): Record<string, unknown> {
    const governed = currentStrategyGovernedContext();
    const value = objectValue(body);
    const clientId = typeof value.clientId === 'string' ? value.clientId : null;
    if (
      !governed ||
      governed.version !== 1 ||
      !allowedOperations.includes(governed.operationId) ||
      !clientId ||
      governed.contextPacket.clientId !== clientId ||
      typeof governed.prompt !== 'string' ||
      !governed.prompt.trim()
    ) {
      throw new ServiceUnavailableException('Strategy reasoning requires governed Context Plane input');
    }
    return { ...value, governedContext: governed };
  }

  private async post<T>(
    path: string,
    body: unknown,
    bearerToken: string | undefined,
    aiProvider?: ResolvedAiProvider,
    requireInternalContext = false,
    delegation?: ServiceDelegation,
  ): Promise<T> {
    if (!this.baseUrl) {
      throw new ServiceUnavailableException('Meri orchestrator is not configured');
    }
    // A governed hop authenticates with the shared secret PLUS an explicitly
    // delegated identity, exactly like intel-api's live-hearing calls. The
    // caller bearer is a Clerk SESSION token (~60s TTL): by the time the
    // Context Plane compile + grounding fan-out has finished it is routinely
    // expired, and the orchestrator's Clerk path then 403s the whole draft.
    // Delegation is not a bypass — MeriTenantGuard still re-resolves the tenant
    // and requires an ACTIVE local membership for the delegated user.
    const delegated =
      requireInternalContext && delegation?.tenantId && delegation?.clerkUserId
        ? { tenantId: delegation.tenantId, clerkUserId: delegation.clerkUserId }
        : null;
    if (!bearerToken && !delegated) {
      throw new ServiceUnavailableException('Meri request requires the caller bearer token');
    }
    if (requireInternalContext && !this.sharedSecret) {
      throw new ServiceUnavailableException('Strategy governed-context transport is not configured');
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (bearerToken) {
      headers.authorization = bearerToken.startsWith('Bearer ')
        ? bearerToken
        : `Bearer ${bearerToken}`;
    }
    if (aiProvider) headers['x-capiro-ai-provider'] = JSON.stringify(aiProvider);
    if (requireInternalContext && this.sharedSecret) {
      headers['x-internal-service-secret'] = this.sharedSecret;
      if (delegated) {
        headers['x-capiro-delegated-tenant'] = delegated.tenantId;
        headers['x-capiro-delegated-user'] = delegated.clerkUserId;
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/meri-api/${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`orchestrator ${path} failed: ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      const msg = (err as Error).name === 'AbortError' ? 'timed out' : (err as Error).message;
      this.logger.warn(`Meri ${path} error: ${msg}`);
      throw new ServiceUnavailableException(`Meri ${path} is unavailable`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
