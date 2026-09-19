import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { StrategyGovernedTurnContext } from './strategy-governed-context.types.js';
import type {
  NodeDocumentDraftResponse,
  ResolvedAiProvider,
  StewardExtractResponse,
  StrategyAssistantResponse,
  StrategyDraftResponse,
  StrategyDraftStreamProgress,
  StrategyReferenceAssistResponse,
  StrategyReportNarrativeResponse,
} from './meri.types.js';
import { currentStrategyGovernedContext } from './strategy-governed-context.runtime.js';
import type { ContextImportAnalysis, ContextImportComparison } from '../context/context-import.types.js';

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

  /**
   * Streaming variant of draft() for the async draft-job worker (strategy
   * generation timeout fix). Same governed-context gate and request body shape
   * as draft(); the orchestrator responds NDJSON over a chunked HTTP response
   * (one JSON object per '\n'-terminated line — `{type:'progress',...}` |
   * `{type:'result',...}` (the exact draft() response shape) |
   * `{type:'error',message}`) instead of a single buffered JSON body, so a
   * background worker can stay attached for the orchestrator's full
   * repair/retry loop instead of needing one response inside a client-safe
   * timeout.
   *
   * `timeoutMs` should be the caller's REMAINING job budget (deadlineAt -
   * now()), not the fixed STRATEGY_MERI_TIMEOUT_MS draft() uses — a background
   * job has no client waiting on a fast response, only its own deadline.
   */
  async draftStreaming(
    body: unknown,
    bearerToken: string | undefined,
    aiProvider: ResolvedAiProvider | undefined,
    delegation: ServiceDelegation | undefined,
    onProgress: (evt: StrategyDraftStreamProgress) => void,
    timeoutMs = this.timeoutMs,
  ): Promise<StrategyDraftResponse> {
    if (!this.baseUrl) {
      throw new ServiceUnavailableException('Meri orchestrator is not configured');
    }
    const headers = this.transportHeaders(bearerToken, aiProvider, delegation, true);
    const payload = this.governedBody(body, ['strategies.generate']);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      const res = await fetch(`${this.baseUrl}/meri-api/strategy-draft-stream`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`orchestrator strategy-draft-stream failed: ${res.status} ${res.statusText}`);
      }
      if (!res.body) {
        throw new Error('orchestrator strategy-draft-stream returned no body');
      }
      return await this.consumeDraftStream(res.body as ReadableStream<Uint8Array>, onProgress);
    } catch (err) {
      // A stream-level error (an `{type:'error'}` line, or a stream that ended
      // without a terminal result) is already a specific, clear message — don't
      // flatten it into the generic transport failure below.
      if (err instanceof ServiceUnavailableException) throw err;
      const msg = (err as Error).name === 'AbortError' ? 'timed out' : (err as Error).message;
      this.logger.warn(`Meri strategy-draft-stream error: ${msg}`);
      throw new ServiceUnavailableException(
        msg === 'timed out'
          ? 'Meri strategy-draft-stream timed out'
          : 'Meri strategy-draft-stream is unavailable',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * NDJSON reader: buffers partial lines across chunks (mirrors the
   * orchestrator's own SSE buffering in request-scoped-llm.client.ts's
   * parseAnthropicToolStream — splitting on a single '\n' here instead of
   * '\n\n', since this wire format is one JSON object per line, not SSE
   * 'data:' frames). A line that fails to JSON.parse is skipped rather than
   * fatal (a torn chunk boundary is expected); only a missing terminal
   * result/error line fails the whole call.
   */
  private async consumeDraftStream(
    body: ReadableStream<Uint8Array>,
    onProgress: (evt: StrategyDraftStreamProgress) => void,
  ): Promise<StrategyDraftResponse> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let settled: StrategyDraftResponse | null = null;
    let streamError: string | null = null;

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed || streamError || settled) return;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return; // ignore a malformed/partial line
      }
      if (evt.type === 'progress') {
        onProgress(evt as unknown as StrategyDraftStreamProgress);
      } else if (evt.type === 'result') {
        const { type: _type, ...rest } = evt;
        settled = rest as unknown as StrategyDraftResponse;
      } else if (evt.type === 'error') {
        streamError =
          typeof evt.message === 'string' && evt.message.trim()
            ? evt.message
            : 'Meri strategy-draft-stream reported an error';
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf('\n')) !== -1) {
          handleLine(buf.slice(0, sep));
          buf = buf.slice(sep + 1);
        }
        if (settled || streamError) break;
      }
      if (!settled && !streamError && buf.trim()) handleLine(buf);
    } finally {
      void reader.cancel().catch(() => undefined);
    }

    if (streamError) throw new ServiceUnavailableException(streamError);
    if (!settled) {
      throw new ServiceUnavailableException('Meri strategy-draft-stream ended without a result');
    }
    return settled;
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

  /**
   * Executive-report narrative. Not a governed Context Plane operation: the
   * body IS the complete, already audience-filtered evidence packet built by
   * api-strategy's report snapshot, so there is no second pack to compile. The
   * hop is still internal-secret + delegated identity like the governed ones,
   * and api-strategy re-verifies every returned paragraph before rendering.
   */
  async reportNarrative(
    body: unknown,
    bearerToken: string | undefined,
    aiProvider?: ResolvedAiProvider,
    delegation?: ServiceDelegation,
    timeoutMs?: number,
  ): Promise<StrategyReportNarrativeResponse> {
    return this.post<StrategyReportNarrativeResponse>(
      'strategy-report-narrative',
      body,
      bearerToken,
      aiProvider,
      true,
      delegation,
      timeoutMs,
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

  /** Source-only context organization: authenticated internal transport, no plan mutation. */
  contextImport(
    body: unknown,
    bearerToken: string | undefined,
    aiProvider?: ResolvedAiProvider,
    delegation?: ServiceDelegation,
  ): Promise<ContextImportAnalysis> {
    return this.post<ContextImportAnalysis>(
      'strategy-context-import', body, bearerToken, aiProvider, true, delegation,
    );
  }

  contextCompare(
    body: unknown,
    bearerToken: string | undefined,
    aiProvider?: ResolvedAiProvider,
    delegation?: ServiceDelegation,
  ): Promise<ContextImportComparison> {
    return this.post<ContextImportComparison>(
      'strategy-context-compare', body, bearerToken, aiProvider, true, delegation,
    );
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

  /**
   * Shared header/identity gate for both post() and draftStreaming(). A
   * governed hop authenticates with the shared secret PLUS an explicitly
   * delegated identity, exactly like intel-api's live-hearing calls. The
   * caller bearer is a Clerk SESSION token (~60s TTL): by the time the
   * Context Plane compile + grounding fan-out has finished it is routinely
   * expired, and the orchestrator's Clerk path then 403s the whole draft — and
   * for the streaming path the job may not even START running until well after
   * the bearer expired. Delegation is not a bypass — MeriTenantGuard still
   * re-resolves the tenant and requires an ACTIVE local membership for the
   * delegated user.
   */
  private transportHeaders(
    bearerToken: string | undefined,
    aiProvider: ResolvedAiProvider | undefined,
    delegation: ServiceDelegation | undefined,
    requireInternalContext: boolean,
  ): Record<string, string> {
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
    return headers;
  }

  private async post<T>(
    path: string,
    body: unknown,
    bearerToken: string | undefined,
    aiProvider?: ResolvedAiProvider,
    requireInternalContext = false,
    delegation?: ServiceDelegation,
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    if (!this.baseUrl) {
      throw new ServiceUnavailableException('Meri orchestrator is not configured');
    }
    const headers = this.transportHeaders(bearerToken, aiProvider, delegation, requireInternalContext);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
