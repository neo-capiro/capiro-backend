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

export class RequestScopedLlmClient implements LlmClient {
  private readonly logger = new Logger(RequestScopedLlmClient.name);

  constructor(
    private readonly globalApiKey: string | undefined,
    private readonly defaultModel: string,
    private readonly timeoutMs?: number,
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

  async completeJson(params: {
    system: string;
    prompt: string;
    maxTokens?: number;
  }): Promise<Record<string, unknown>> {
    const { apiKey, model, usedTenantKey, provider } = this.resolve();
    this.logger.debug(
      `LLM completion (provider=${provider}, model=${model}, usedTenantKey=${usedTenantKey})`,
    );
    return this.buildClient(apiKey, model, provider).completeJson(params);
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
    const { apiKey, model, usedTenantKey, provider } = this.resolve();
    this.logger.debug(
      `LLM schema completion (provider=${provider}, model=${model}, usedTenantKey=${usedTenantKey})`,
    );
    return this.buildClient(apiKey, model, provider).completeWithSchema(params);
  }

  /**
   * One round of a tool-use loop: send system + messages + tool schemas and
   * return the model's content blocks + stop_reason (the caller drives the loop,
   * executing tool_use blocks through the registry and feeding tool_result back).
   * Uses the same request-scoped credential resolution as completeJson, so the
   * whole in-editor loop runs on the tenant's key. Throws on a non-2xx/timeout;
   * the caller degrades gracefully.
   */
  async completeWithTools(params: {
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
    tools: AnthropicToolSchema[];
    maxTokens: number;
    timeoutMs?: number;
    /**
     * Force the model's use of tools this call. Omit (default) = Anthropic
     * `auto`. `'none'` sends `tool_choice: {type:'none'}` so the model MUST
     * answer in text — the mechanism the loop uses to force a final synthesis
     * turn when the tool-round budget is spent (never end on a bare tool call).
     */
    toolChoice?: 'auto' | 'none';
    /** Optional external cancellation (streaming client disconnect) — composed with the timeout. */
    signal?: AbortSignal;
    /**
     * When provided (Anthropic provider only), stream the response and invoke
     * this for each text delta as it arrives — the chat surface types
     * token-by-token instead of in per-round bursts (2.4). The full content
     * blocks + usage + stopReason are still returned at the end. Ignored for the
     * OpenAI adapter (non-streaming), so `streamed` is false there.
     */
    onTextDelta?: (delta: string) => void;
  }): Promise<ToolLoopResponse> {
    const { apiKey, model, usedTenantKey, provider } = this.resolve();
    // Phase 4 LLM-gateway convergence (4.5.1): the loop's wire shape stays
    // Anthropic (content blocks, tool_use/tool_result, stop_reason); for an
    // OpenAI credential the OpenAiLlmClient adapter translates both directions,
    // so the loop drivers (chat, in-editor) run unchanged on either provider.
    if (provider === 'openai') {
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
          tools: params.tools,
          // Default (undefined) = Anthropic `auto`. `'none'` forces a text-only
          // synthesis turn (the loop's forced-completion mechanism).
          ...(params.toolChoice === 'none' ? { tool_choice: { type: 'none' } } : {}),
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
