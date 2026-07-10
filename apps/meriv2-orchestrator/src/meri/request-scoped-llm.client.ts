import { Logger } from '@nestjs/common';
import { AnthropicLlmClient, type LlmClient } from '@capiro/meriv2-core';
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
  private resolve(): { apiKey: string; model: string; usedTenantKey: boolean } {
    const cred = RequestCredentialsStore.get()?.aiProvider;
    const apiKey = cred?.apiKey ?? this.globalApiKey;
    if (!apiKey) {
      throw new Error(
        'No Anthropic credential available: no tenant credential on the request and no global key configured',
      );
    }
    const model = cred?.modelOverridden ? cred.model : this.defaultModel;
    const usedTenantKey = Boolean(cred?.usedTenantKey && cred.apiKey);
    return { apiKey, model, usedTenantKey };
  }

  async completeJson(params: {
    system: string;
    prompt: string;
    maxTokens?: number;
  }): Promise<Record<string, unknown>> {
    const { apiKey, model, usedTenantKey } = this.resolve();
    this.logger.debug(`LLM completion (model=${model}, usedTenantKey=${usedTenantKey})`);
    const client = new AnthropicLlmClient({
      apiKey,
      model,
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
    });
    return client.completeJson(params);
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
    const { apiKey, model, usedTenantKey } = this.resolve();
    this.logger.debug(`LLM schema completion (model=${model}, usedTenantKey=${usedTenantKey})`);
    const client = new AnthropicLlmClient({
      apiKey,
      model,
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
    });
    return client.completeWithSchema(params);
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
  }): Promise<ToolLoopResponse> {
    const { apiKey, model, usedTenantKey } = this.resolve();
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
          messages: params.messages,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Anthropic HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
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
      };
    } finally {
      clearTimeout(timer);
      params.signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}
