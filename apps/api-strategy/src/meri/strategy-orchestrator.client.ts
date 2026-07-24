import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  ResolvedAiProvider,
  StewardExtractResponse,
  StrategyAssistantResponse,
  StrategyDraftResponse,
  StrategyReferenceAssistResponse,
} from './meri.types.js';

/**
 * Outbound client to the MeriV2 orchestrator's strategy surfaces
 * (POST /meri-api/strategy-draft, /meri-api/strategy-assistant). Forwards the
 * CALLER's Bearer JWT (the orchestrator's TenantGuard + delegated tool reads
 * ride it) ALWAYS, and the tenant's resolved AI provider as x-capiro-ai-provider
 * when present (D19 BYOK — key over authenticated TLS only, never logged/
 * persisted). Draft compiles the Client Context Pack + runs the LLM loop, so the
 * timeout is generous (STRATEGY_MERI_TIMEOUT_MS, default 60s; plan SLO ~30s p95).
 */
@Injectable()
export class StrategyOrchestratorClient {
  private readonly logger = new Logger(StrategyOrchestratorClient.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = (config.get<string>('MERIV2_ORCHESTRATOR_URL') ?? '').replace(/\/+$/, '');
    this.timeoutMs = Number(config.get<string>('STRATEGY_MERI_TIMEOUT_MS') ?? '60000');
  }

  get configured(): boolean {
    return this.baseUrl.length > 0;
  }

  draft(
    body: unknown,
    bearerToken: string | undefined,
    aiProvider?: ResolvedAiProvider,
  ): Promise<StrategyDraftResponse> {
    return this.post<StrategyDraftResponse>('strategy-draft', body, bearerToken, aiProvider);
  }

  assistant(
    body: unknown,
    bearerToken: string | undefined,
    aiProvider?: ResolvedAiProvider,
  ): Promise<StrategyAssistantResponse> {
    return this.post<StrategyAssistantResponse>('strategy-assistant', body, bearerToken, aiProvider);
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

  /** Stage E wire-contract (1): the Context Steward's fact-extraction surface. */
  stewardExtract(
    body: unknown,
    bearerToken: string | undefined,
    aiProvider?: ResolvedAiProvider,
  ): Promise<StewardExtractResponse> {
    return this.post<StewardExtractResponse>('steward-extract', body, bearerToken, aiProvider);
  }

  private async post<T>(
    path: string,
    body: unknown,
    bearerToken: string | undefined,
    aiProvider?: ResolvedAiProvider,
  ): Promise<T> {
    if (!this.baseUrl) {
      throw new ServiceUnavailableException('Meri orchestrator is not configured');
    }
    if (!bearerToken) {
      // The orchestrator authenticates + runs delegated client reads on this bearer.
      throw new ServiceUnavailableException('Meri request requires the caller bearer token');
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${bearerToken}`,
      'content-type': 'application/json',
    };
    if (aiProvider) {
      headers['x-capiro-ai-provider'] = JSON.stringify(aiProvider);
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
