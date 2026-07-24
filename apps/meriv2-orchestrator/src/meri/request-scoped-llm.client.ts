import { Logger } from '@nestjs/common';
import { AnthropicLlmClient, OpenAiLlmClient, type LlmClient } from '@capiro/meriv2-core';
import { parseProviderUsage, type ProviderUsage } from '@capiro/shared';
import { RequestCredentialsStore } from '../request/request-credentials.store.js';

/**
 * BYOK2 — the orchestrator's LLM credential resolver (the ONE place a global
 * env key may be read; every LLM-backed tool binds THIS client, never a raw
 * `AnthropicLlmClient` on `process.env`).
 *
 * At completion time it resolves, in order:
 *   1. The caller-passed tenant credential (`RequestCredentialsStore.aiProvider`,
 *      BYOK option c — apps/api resolves via its AiCredentialResolverService and
 *      forwards over the already-authenticated TLS request). Model: the tenant's
 *      explicit `modelOverridden` model wins; otherwise the orchestrator's
 *      configured default (mirrors apps/api's meri.service model rule).
 *   2. The global env key (constructor-injected) — the explicit fallback the
 *      BYOK directive permits ONLY inside a resolver.
 * Neither present → throws; callers (intel-api extraction) gracefully degrade.
 *
 * The tenant key is held in-process for the single completion and is never
 * logged or persisted — observability records only `usedTenantKey`.
 */
export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: string; [k: string]: unknown };

export interface AnthropicToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** A7: constrained decoding (structured outputs). Sent only to models that
   *  support it — stripped otherwise (see modelSupportsStrict). */
  strict?: boolean;
}

export interface ToolLoopResponse {
  content: AnthropicContentBlock[];
  stopReason: string | null;
  /** Token usage for THIS round — Phase 1 M5.0 (H-1): the caller meters one `ai_usage_events` row per round. */
  usage: ProviderUsage;
  model: string;
  usedTenantKey: boolean;
  /** True when the text was already streamed to `onTextDelta` (Anthropic stream
   *  path) — the caller must NOT re-emit the round's text. False/undefined for
   *  the non-streaming (JSON) and OpenAI paths (caller emits the whole text). */
  streamed?: boolean;
}

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

/** A7: models with GA structured-outputs / strict tool use. Strict is stripped
 *  for anything else (e.g. the current Sonnet 4.6 default) so a tenant's model
 *  choice never 400s — server-side re-validation remains the invariant. */
const STRICT_TOOL_MODELS = /claude-(sonnet-5|opus-4-8|opus-4-7|haiku-4-5|fable-5|mythos-5)/i;
export function modelSupportsStrict(model: string): boolean {
  return STRICT_TOOL_MODELS.test(model);
}

/** Shared params for one tool-use round (completeWithTools + its per-attempt helper). */
export interface CompleteWithToolsParams {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
  tools: AnthropicToolSchema[];
  maxTokens: number;
  timeoutMs?: number;
  /** 'auto' (default) · 'none' (text-only) · {type:'tool',name} forces that tool (A7). */
  toolChoice?: 'auto' | 'none' | { type: 'tool'; name: string };
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
}

/** A resolved provider credential for one attempt. */
interface ResolvedCred {
  apiKey: string;
  model: string;
  usedTenantKey: boolean;
  provider: 'anthropic' | 'openai';
}

/** Optional global other-provider fallback (activated only when configured). */
export interface GlobalLlmFallback {
  apiKey: string;
  model: string;
  provider: 'anthropic' | 'openai';
}

const MAX_LLM_RETRIES = 2; // same-provider retries on transient failures (keep small — chat latency)

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const retryBackoffMs = (attempt: number) =>
  Math.min(2000, 250 * 2 ** attempt) + Math.floor(Math.random() * 100);

/**
 * Classify an LLM call failure for resilience (pure — unit-tested).
 * - retryable: transient, safe to retry the SAME provider/key (overload / 5xx / network).
 * - failover: worth trying the OTHER provider (transient errors AND hard
 *   credit/quota exhaustion — the 2026-07-15 fleet-wide outage: a 400 "credit
 *   balance too low" is NOT retryable on the same key but IS the trigger to fail
 *   over to the fallback provider).
 * A bare AbortError is deliberately NOT classified (our timeout vs. a user
 * client-disconnect are indistinguishable here; never retry a user disconnect).
 */
export function classifyLlmError(err: unknown): { retryable: boolean; failover: boolean } {
  const msg = err instanceof Error ? err.message : String(err);
  // Two wire-error shapes reach here: the completeWithTools raw-fetch loop's
  // "Anthropic HTTP 529: ..." and the meriv2-core clients' (completeJson /
  // completeWithSchema, via runWithFailover) "Anthropic/OpenAI request failed
  // (529): ..." — match the status in either.
  const statusMatch = msg.match(/HTTP (\d{3})/) ?? msg.match(/request failed \((\d{3})\)/);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;
  if (
    /credit balance|insufficient[_ ]?(quota|funds|credit)|billing|exceeded your current quota|payment required/i.test(
      msg,
    ) ||
    status === 402
  ) {
    return { retryable: false, failover: true };
  }
  if (status === 429 || status === 529) return { retryable: true, failover: true };
  if (status !== undefined && status >= 500) return { retryable: true, failover: true };
  if (
    /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network|fetch failed|terminated|timed out/i.test(
      msg,
    )
  ) {
    return { retryable: true, failover: true };
  }
  return { retryable: false, failover: false };
}

export class RequestScopedLlmClient implements LlmClient {
  private readonly logger = new Logger(RequestScopedLlmClient.name);

  constructor(
    private readonly globalApiKey: string | undefined,
    private readonly defaultModel: string,
    private readonly timeoutMs?: number,
    // Global other-provider fallback: used ONLY when the primary attempt ran on
    // the GLOBAL key (never a tenant BYOK key) and failed with a failover-worthy
    // error. Inert when undefined (today's behavior), so this is dark until a
    // global OpenAI key is wired to the orchestrator.
    private readonly globalFallback?: GlobalLlmFallback,
  ) {}

  /**
   * Resolve the credential for one call: request-scoped tenant credential first
   * (BYOK option c), else the constructor-injected global key. Model: the
   * tenant's explicit override wins, else the orchestrator default.
   */
  private resolve(): {
    apiKey: string;
    model: string;
    usedTenantKey: boolean;
    provider: 'anthropic' | 'openai';
  } {
    const cred = RequestCredentialsStore.get()?.aiProvider;
    const apiKey = cred?.apiKey ?? this.globalApiKey;
    if (!apiKey) {
      throw new Error(
        'No LLM credential available: no tenant credential on the request and no global key configured',
      );
    }
    const model = cred?.modelOverridden ? cred.model : this.defaultModel;
    const usedTenantKey = Boolean(cred?.usedTenantKey && cred.apiKey);
    // Phase 4 LLM-gateway convergence: honor the provider the credential
    // resolver already forwarded. The global fallback key is Anthropic, so a
    // missing/absent cred defaults to 'anthropic' (today's behavior unchanged).
    const provider = cred?.provider ?? 'anthropic';
    return { apiKey, model, usedTenantKey, provider };
  }

  /** Build the schema-capable client for the resolved provider (reasoning-tool
   *  paths only — completeJson / completeWithSchema). */
  private buildClient(apiKey: string, model: string, provider: 'anthropic' | 'openai'): LlmClient {
    const opts = {
      apiKey,
      model,
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
    };
    return provider === 'openai' ? new OpenAiLlmClient(opts) : new AnthropicLlmClient(opts);
  }

  /**
   * Run a single NON-streaming LLM op (completeJson / completeWithSchema) with
   * the same same-provider retry + BYOK-safe provider failover as
   * completeWithTools — so the reasoning-tool paths (tag_live_policy_mentions,
   * generate_post_hearing_summary) survive a transient blip or a global-key
   * provider outage instead of throwing straight to intel-api's deterministic
   * fallback. No streaming here, so no mid-emit guard is needed. Failover fires
   * only when the primary ran on the GLOBAL key (a tenant BYOK key is never
   * crossed to Capiro's global account) and a fallback is configured — inert
   * otherwise, exactly like completeWithTools.
   */
  private async runWithFailover<T>(
    label: string,
    op: (client: LlmClient) => Promise<T>,
  ): Promise<T> {
    const primary = this.resolve();
    const attempts: ResolvedCred[] = [primary];
    if (
      !primary.usedTenantKey &&
      this.globalFallback &&
      this.globalFallback.provider !== primary.provider
    ) {
      attempts.push({
        apiKey: this.globalFallback.apiKey,
        model: this.globalFallback.model,
        usedTenantKey: false,
        provider: this.globalFallback.provider,
      });
    }
    let lastErr: unknown;
    for (let i = 0; i < attempts.length; i += 1) {
      const cred = attempts[i]!;
      const hasFallback = i < attempts.length - 1;
      for (let retry = 0; ; retry += 1) {
        try {
          this.logger.debug(
            `${label} (provider=${cred.provider}, model=${cred.model}, usedTenantKey=${cred.usedTenantKey})`,
          );
          return await op(this.buildClient(cred.apiKey, cred.model, cred.provider));
        } catch (err) {
          lastErr = err;
          const { retryable, failover } = classifyLlmError(err);
          if (retryable && retry < MAX_LLM_RETRIES) {
            await delay(retryBackoffMs(retry));
            continue;
          }
          if (hasFallback && failover) {
            this.logger.warn(
              `LLM ${cred.provider} ${label} failed (${(err as Error)?.message?.slice(0, 120)}); ` +
                `failing over to global ${attempts[i + 1]!.provider}`,
            );
            break; // stop retrying this provider; the outer loop tries the fallback
          }
          throw err;
        }
      }
    }
    throw lastErr;
  }

  async completeJson(params: {
    system: string;
    prompt: string;
    maxTokens?: number;
  }): Promise<Record<string, unknown>> {
    return this.runWithFailover('LLM completion', (client) => client.completeJson(params));
  }

  /**
   * Schema-forced completion (Phase 1 M5.0) — delegates to `AnthropicLlmClient`
   * on the SAME request-scoped credential as every other method here, so a
   * `GroundedJson` caller running through the orchestrator also runs on the
   * tenant's key.
   */
  async completeWithSchema(params: {
    system: string;
    prompt: string;
    toolName: string;
    toolDescription: string;
    inputSchema: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<{ input: unknown; usage: { inputTokens: number; outputTokens: number } }> {
    return this.runWithFailover('LLM schema completion', (client) =>
      client.completeWithSchema(params),
    );
  }

  /**
   * One round of a tool-use loop, with same-provider retry + BYOK-safe provider
   * failover. Resolves the primary credential and attempts it; on a transient
   * failure (overload / 5xx / network) it retries the same provider with backoff,
   * and on a failover-worthy failure (incl. credit/quota exhaustion — the
   * 2026-07-15 fleet-wide outage) it fails over to the global other-provider
   * fallback — but ONLY when the primary ran on the GLOBAL key (a tenant BYOK key
   * is never crossed to Capiro's global account) and a fallback is configured
   * (inert otherwise, so today's single-provider behavior is unchanged).
   *
   * Streaming-safe: once a text delta has been emitted, no retry/failover can
   * fire (it would double-emit); all retryable/failover errors surface at the
   * HTTP-status stage before streaming. Throws when all attempts fail; the caller
   * degrades gracefully.
   */
  async completeWithTools(params: CompleteWithToolsParams): Promise<ToolLoopResponse> {
    const primary = this.resolve();
    const attempts: ResolvedCred[] = [primary];
    if (
      !primary.usedTenantKey &&
      this.globalFallback &&
      this.globalFallback.provider !== primary.provider
    ) {
      attempts.push({
        apiKey: this.globalFallback.apiKey,
        model: this.globalFallback.model,
        usedTenantKey: false,
        provider: this.globalFallback.provider,
      });
    }

    let emitted = false;
    const attemptParams: CompleteWithToolsParams = params.onTextDelta
      ? {
          ...params,
          onTextDelta: (delta: string) => {
            emitted = true;
            params.onTextDelta!(delta);
          },
        }
      : params;

    let lastErr: unknown;
    for (let i = 0; i < attempts.length; i += 1) {
      const cred = attempts[i]!;
      const hasFallback = i < attempts.length - 1;
      for (let retry = 0; ; retry += 1) {
        try {
          return await this.attempt(cred, attemptParams);
        } catch (err) {
          lastErr = err;
          if (emitted) throw err; // mid-stream — recovery would double-emit
          const { retryable, failover } = classifyLlmError(err);
          if (retryable && retry < MAX_LLM_RETRIES) {
            await delay(retryBackoffMs(retry));
            continue;
          }
          if (hasFallback && failover) {
            this.logger.warn(
              `LLM ${cred.provider} failed (${(err as Error)?.message?.slice(0, 120)}); ` +
                `failing over to global ${attempts[i + 1]!.provider}`,
            );
            break; // stop retrying this provider; the outer loop tries the fallback
          }
          throw err;
        }
      }
    }
    throw lastErr;
  }

  /** One provider attempt (no retry/failover) — the resolved-provider wire logic. */
  private async attempt(
    cred: ResolvedCred,
    params: CompleteWithToolsParams,
  ): Promise<ToolLoopResponse> {
    const { apiKey, model, usedTenantKey, provider } = cred;
    // Phase 4 LLM-gateway convergence (4.5.1): the loop's wire shape stays
    // Anthropic (content blocks, tool_use/tool_result, stop_reason); for an
    // OpenAI credential the OpenAiLlmClient adapter translates both directions,
    // so the loop drivers (chat, in-editor) run unchanged on either provider.
    if (provider === 'openai') {
      // Vision (2.2): the OpenAI tool-loop translation only carries text +
      // tool_result blocks (toOpenAiToolLoopBody), so an image block would be
      // SILENTLY dropped and the model would answer as if no image was sent.
      // Fail loud instead — the tenant must use an Anthropic model for image turns.
      if (messagesContainImage(params.messages)) {
        throw new Error(
          'Vision (image inputs) is not supported on the OpenAI adapter — the tenant must use an Anthropic model for turns that include images.',
        );
      }
      this.logger.debug(
        `LLM tool round (provider=openai, model=${model}, usedTenantKey=${usedTenantKey})`,
      );
      const client = new OpenAiLlmClient({
        apiKey,
        model,
        ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
      });
      const r = await client.completeWithTools({
        system: params.system,
        messages: params.messages,
        tools: params.tools,
        maxTokens: params.maxTokens,
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
        ...(params.toolChoice !== undefined ? { toolChoice: params.toolChoice } : {}),
        ...(params.signal !== undefined ? { signal: params.signal } : {}),
      });
      return {
        content: r.content as AnthropicContentBlock[],
        stopReason: r.stopReason,
        usage: r.usage,
        model,
        usedTenantKey,
      };
    }
    this.logger.debug(`LLM tool round (model=${model}, usedTenantKey=${usedTenantKey})`);
    const controller = new AbortController();
    const timeout = params.timeoutMs ?? this.timeoutMs ?? 120_000;
    const timer = setTimeout(() => controller.abort(), timeout);
    const onExternalAbort = () => controller.abort();
    if (params.signal) {
      if (params.signal.aborted) controller.abort();
      else params.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    try {
      const res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: params.maxTokens,
          system: params.system,
          // A7: keep `strict` only for models that support structured outputs;
          // strip it otherwise so a non-supporting model never 400s on it.
          tools: modelSupportsStrict(model)
            ? params.tools
            : params.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.input_schema,
              })),
          // undefined/'auto' → Anthropic default; 'none' → no tool; {type:'tool',name} → force it (A7).
          ...(params.toolChoice === 'none'
            ? { tool_choice: { type: 'none' } }
            : params.toolChoice && typeof params.toolChoice === 'object'
              ? { tool_choice: params.toolChoice }
              : {}),
          ...(params.onTextDelta ? { stream: true } : {}),
          messages: params.messages,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Anthropic HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
      }
      if (params.onTextDelta) {
        const streamed = await parseAnthropicToolStream(res, params.onTextDelta);
        return { ...streamed, model, usedTenantKey, streamed: true };
      }
      const data = (await res.json()) as {
        content?: AnthropicContentBlock[];
        stop_reason?: string | null;
        usage?: unknown;
      };
      return {
        content: Array.isArray(data.content) ? data.content : [],
        stopReason: data.stop_reason ?? null,
        usage: parseProviderUsage(data),
        model,
        usedTenantKey,
        streamed: false,
      };
    } finally {
      clearTimeout(timer);
      params.signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

function sseNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** True if any message carries a vision (image) content block (2.2). */
function messagesContainImage(messages: Array<{ content: unknown }>): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      (m.content as Array<Record<string, unknown>>).some((b) => b?.type === 'image'),
  );
}

/**
 * Parse an Anthropic tool-use STREAMING (SSE) response: fire `onTextDelta` for
 * each text delta as it arrives, and reconstruct the full content blocks
 * (text + tool_use with its input JSON assembled from input_json_delta chunks),
 * stop reason, and token usage — the SAME shape the non-streaming JSON path
 * returns, so the tool loop is agnostic to which path ran (2.4).
 */
export async function parseAnthropicToolStream(
  res: Response,
  onTextDelta: (delta: string) => void,
): Promise<{ content: AnthropicContentBlock[]; stopReason: string | null; usage: ProviderUsage }> {
  const body = res.body;
  if (!body) throw new Error('Anthropic stream response had no body');
  const blocks = new Map<
    number,
    { type: string; text: string; id?: string; name?: string; json: string }
  >();
  let stopReason: string | null = null;
  const usage: ProviderUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  const handleEvent = (rawEvent: string): void => {
    const json = rawEvent
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('');
    if (!json || json === '[DONE]') return;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return; // ignore a malformed/partial event line
    }
    switch (evt.type) {
      case 'message_start': {
        const u = ((evt.message as Record<string, unknown>)?.usage ?? {}) as Record<
          string,
          unknown
        >;
        usage.inputTokens = sseNumber(u.input_tokens);
        usage.cacheReadTokens = sseNumber(u.cache_read_input_tokens);
        usage.cacheCreationTokens = sseNumber(u.cache_creation_input_tokens);
        usage.outputTokens = sseNumber(u.output_tokens);
        break;
      }
      case 'content_block_start': {
        const cb = (evt.content_block ?? {}) as Record<string, unknown>;
        blocks.set(sseNumber(evt.index), {
          type: typeof cb.type === 'string' ? cb.type : 'text',
          text: typeof cb.text === 'string' ? cb.text : '',
          ...(typeof cb.id === 'string' ? { id: cb.id } : {}),
          ...(typeof cb.name === 'string' ? { name: cb.name } : {}),
          json: '',
        });
        break;
      }
      case 'content_block_delta': {
        const b = blocks.get(sseNumber(evt.index));
        if (!b) break;
        const d = (evt.delta ?? {}) as Record<string, unknown>;
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          b.text += d.text;
          onTextDelta(d.text);
        } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          b.json += d.partial_json;
        }
        break;
      }
      case 'message_delta': {
        const d = (evt.delta ?? {}) as Record<string, unknown>;
        if (typeof d.stop_reason === 'string') stopReason = d.stop_reason;
        const u = (evt.usage ?? {}) as Record<string, unknown>;
        if (u.output_tokens !== undefined) usage.outputTokens = sseNumber(u.output_tokens);
        break;
      }
      default:
        break; // content_block_stop / message_stop / ping — nothing to accumulate
    }
  };

  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      handleEvent(buf.slice(0, sep));
      buf = buf.slice(sep + 2);
    }
  }
  if (buf.trim()) handleEvent(buf);

  const content: AnthropicContentBlock[] = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, b]) => {
      if (b.type === 'tool_use') {
        let input: Record<string, unknown> = {};
        if (b.json.trim()) {
          try {
            input = JSON.parse(b.json) as Record<string, unknown>;
          } catch {
            input = {};
          }
        }
        return { type: 'tool_use', id: b.id ?? '', name: b.name ?? '', input };
      }
      return { type: 'text', text: b.text };
    });

  return { content, stopReason, usage };
}
