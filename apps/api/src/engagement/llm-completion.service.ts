/**
 * LlmCompletionService — the D1 hardened completion client (plan §3.1, Wave 3).
 *
 * One place that owns the *transport* for direct Anthropic/OpenAI completions:
 * per-provider request shaping, transient-error retries (429/5xx/network) with
 * backoff + Retry-After, typed failures, Anthropic prompt caching (cache_control
 * breakpoints), and usage+cache-token parsing. It replaces the two hand-rolled
 * fetch blocks in EngagementAiService so every outreach generation flows through
 * a single, tested client.
 *
 * Deliberately raw fetch, not an official SDK: the ENTIRE Capiro monorepo calls
 * Anthropic/OpenAI over raw fetch (there is no @anthropic-ai/sdk or openai
 * dependency anywhere), so this follows the established house pattern rather than
 * introducing a repo-wide new dependency. meriv2-core's weaker AnthropicLlmClient
 * converges onto this shape in W6.4.
 *
 * Scope split: this client handles TRANSPORT resilience only. Truncation POLICY
 * (per-template budget + the 1.5x retry-then-honest-fail) stays with the caller,
 * which is why `truncated` is reported rather than acted on here.
 */
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { parseProviderUsage, type ProviderUsage } from '@capiro/shared';

export type LlmProvider = 'openai' | 'anthropic';

export interface LlmCompletionRequest {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  /**
   * System prompt. Anthropic `system`; OpenAI `instructions`. Empty string ⇒
   * OpenAI omits `instructions` entirely (preserves the legacy v1 OpenAI path,
   * which had no system/user separation).
   */
  system: string;
  /** Byte-stable cacheable user prefix (may be ''); cached when `cacheUserStatic`. */
  userStatic: string;
  /** Volatile per-request user body. */
  userVolatile: string;
  /** Structured-output JSON schema (both providers). */
  jsonSchema: Record<string, unknown>;
  jsonSchemaName?: string;
  /**
   * Output budget. Anthropic `max_tokens` (defaults to 2400 — the legacy value —
   * when undefined). OpenAI `max_output_tokens` is set only when defined, so the
   * legacy v1 OpenAI request (no cap) is reproduced by leaving it undefined.
   */
  maxTokens?: number;
  /** Anthropic prompt caching: mark the system block cacheable. */
  cacheSystem?: boolean;
  /** Anthropic prompt caching: mark the static user prefix cacheable. */
  cacheUserStatic?: boolean;
  timeoutMs?: number;
  /** Transient-retry attempts after the first try (429/5xx/network). Default 2. */
  maxRetries?: number;
  /**
   * Sampling temperature (zero-trust Wave 1, RC8): figure-heavy synthesis passes
   * 0.2 to cut sampling variance on exactly the numeric paths that produced the
   * scramble errors. Applied on the ANTHROPIC branch only — OpenAI reasoning
   * models (o-series) reject a non-default temperature with a 400, and a BYOK
   * tenant's model id is not knowable here; Anthropic accepts 0–1 whenever no
   * thinking block is sent (this client never sends one). Undefined ⇒ provider
   * default (unchanged behavior).
   */
  temperature?: number;
}

export interface LlmCompletionResult {
  text: string;
  usage: ProviderUsage;
  stopReason: string | null;
  /** True when output hit the token ceiling (caller decides whether to retry). */
  truncated: boolean;
  raw: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

export interface LlmCompletionServiceOptions {
  /** Injectable for tests (fault injection). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests so backoff does not actually sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
  logger?: Pick<Logger, 'warn'>;
  /**
   * Engagement API Phase 1 — optional runtime policy guard.
   * When provided, complete() asserts outreach_generate before
   * creating an AbortController or fetch request.
   */
  runtimePolicy?: {
    assertExternalAction(action: 'outreach_generate'): void;
  };
}

export class LlmCompletionService {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Pick<Logger, 'warn'>;
  private readonly runtimePolicy?: { assertExternalAction(action: 'outreach_generate'): void };

  constructor(opts: LlmCompletionServiceOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.logger = opts.logger ?? new Logger(LlmCompletionService.name);
    this.runtimePolicy = opts.runtimePolicy;
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
    // Engagement API Phase 1 — assert outreach_generate before any network call.
    this.runtimePolicy?.assertExternalAction('outreach_generate');
    const maxRetries = req.maxRetries ?? DEFAULT_MAX_RETRIES;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const { status, json, retryAfterMs } = await this.callOnce(req);
        if (status >= 200 && status < 300) {
          return this.parseResult(req.provider, json);
        }
        // Non-2xx. Retry transient statuses; fail typed otherwise.
        if (RETRYABLE_STATUS.has(status) && attempt < maxRetries) {
          const backoff = retryAfterMs ?? this.backoffMs(attempt);
          this.logger.warn(
            `${req.provider} completion ${status}; retry ${attempt + 1}/${maxRetries} in ${backoff}ms`,
          );
          await this.sleep(backoff);
          continue;
        }
        throw new ServiceUnavailableException(
          `${req.provider} completion failed: ${readError(json, status)}`,
        );
      } catch (err) {
        if (err instanceof ServiceUnavailableException) throw err;
        // Network/abort/parse error — transient; retry with backoff.
        lastError = err;
        if (attempt < maxRetries) {
          const backoff = this.backoffMs(attempt);
          this.logger.warn(
            `${req.provider} completion network error; retry ${attempt + 1}/${maxRetries} in ${backoff}ms: ${(err as Error).message}`,
          );
          await this.sleep(backoff);
          continue;
        }
      }
    }
    throw new ServiceUnavailableException(
      `${req.provider} completion failed after ${maxRetries + 1} attempts: ${
        (lastError as Error)?.message ?? 'unknown error'
      }`,
    );
  }

  private backoffMs(attempt: number): number {
    // Deterministic exponential backoff (no jitter — keeps tests reproducible):
    // 500ms, 1500ms, 3500ms…
    return 500 * (2 ** (attempt + 1) - 1);
  }

  private async callOnce(
    req: LlmCompletionRequest,
  ): Promise<{ status: number; json: Record<string, unknown>; retryAfterMs: number | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const { url, headers, body } = this.buildRequest(req);
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json = (await res.json()) as Record<string, unknown>;
      const retryAfter = res.headers?.get?.('retry-after');
      const retryAfterMs = retryAfter ? Math.max(0, Number(retryAfter) * 1000) || null : null;
      return { status: res.status, json, retryAfterMs };
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new ServiceUnavailableException(
          `${req.provider} request timed out after ${(req.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private buildRequest(req: LlmCompletionRequest): {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  } {
    if (req.provider === 'openai') {
      // OpenAI Responses: system → instructions, structured output via
      // text.format.json_schema, budget via max_output_tokens. Prompt caching is
      // automatic (no cache_control), so the static/volatile split is simply
      // joined here.
      const input = joinUser(req.userStatic, req.userVolatile);
      return {
        url: 'https://api.openai.com/v1/responses',
        headers: {
          Authorization: `Bearer ${req.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: {
          model: req.model,
          // Omit `instructions` when there is no system prompt (legacy v1 path).
          ...(req.system.trim() ? { instructions: req.system } : {}),
          input,
          // Omit `max_output_tokens` when uncapped (legacy v1 path).
          ...(req.maxTokens ? { max_output_tokens: req.maxTokens } : {}),
          text: {
            format: {
              type: 'json_schema',
              name: req.jsonSchemaName ?? 'result',
              strict: true,
              schema: req.jsonSchema,
            },
          },
        },
      };
    }
    // Anthropic Messages. Structured output is requested by appending the schema
    // to the user content (the repo's existing convention). Prompt caching marks
    // the system block and/or the static user prefix with cache_control.
    const schemaAppendix = `\n\nJSON schema:\n${JSON.stringify(req.jsonSchema)}`;
    const system = req.cacheSystem
      ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
      : req.system;
    let content: unknown;
    if (req.cacheUserStatic && req.userStatic) {
      content = [
        { type: 'text', text: req.userStatic, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `${req.userVolatile}${schemaAppendix}` },
      ];
    } else {
      content = `${joinUser(req.userStatic, req.userVolatile)}${schemaAppendix}`;
    }
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'x-api-key': req.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: {
        model: req.model,
        max_tokens: req.maxTokens ?? 2400,
        // See LlmCompletionRequest.temperature — Anthropic-only by design.
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        system,
        messages: [{ role: 'user', content }],
      },
    };
  }

  private parseResult(provider: LlmProvider, json: Record<string, unknown>): LlmCompletionResult {
    const usage = parseProviderUsage(json);
    if (provider === 'openai') {
      const status = typeof json.status === 'string' ? json.status : null;
      const truncated =
        status === 'incomplete' && toRec(json.incomplete_details).reason === 'max_output_tokens';
      return { text: extractOpenAiText(json), usage, stopReason: status, truncated, raw: json };
    }
    const stopReason = typeof json.stop_reason === 'string' ? json.stop_reason : null;
    return {
      text: extractAnthropicText(json),
      usage,
      stopReason,
      truncated: stopReason === 'max_tokens',
      raw: json,
    };
  }
}

function joinUser(userStatic: string, userVolatile: string): string {
  return userStatic ? `${userStatic}\n\n${userVolatile}` : userVolatile;
}

function extractOpenAiText(json: Record<string, unknown>): string {
  if (typeof json.output_text === 'string') return json.output_text;
  const output = Array.isArray(json.output) ? json.output : [];
  for (const item of output) {
    const content = toRec(item).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const text = toRec(part).text;
      if (typeof text === 'string') return text;
    }
  }
  return '';
}

function extractAnthropicText(json: Record<string, unknown>): string {
  const content = Array.isArray(json.content) ? json.content : [];
  return content
    .map((part) => {
      const record = toRec(part);
      return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .join('\n')
    .trim();
}

function readError(json: Record<string, unknown>, status: number): string {
  const error = toRec(json.error);
  if (typeof error.message === 'string') return error.message;
  if (typeof json.message === 'string') return json.message;
  return `HTTP ${status}`;
}

function toRec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
