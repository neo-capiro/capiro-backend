import { upgradeTextModel, prepareOpenAiResponsesRequest, prepareAnthropicRequest } from '@capiro/shared/ai-model-policy';
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
import { Agent } from 'undici';
import { parseProviderUsage, type ProviderUsage } from '@capiro/shared';
import {
  anthropicEffort,
  anthropicSupportsAdaptiveThinking,
  openAiReasoningEffort,
  openAiSupportsReasoningEffort,
  type ReasoningEffort,
} from './generation/reasoning-effort.js';
import { contextStageTimer } from '../context/context-stage-timer.service.js';

export type LlmProvider = 'openai' | 'anthropic';

export interface LlmCompletionRequest {
  /** Runtime authority asserted immediately before the provider request. */
  runtimeAction?: 'outreach_generate' | 'outreach_v3_generate' | 'meeting_prep_generate';
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
  /** Server-authorized PDF bytes, bounded by the caller to the requested page. */
  pdfInput?: { filename: string; base64: string };
  /** Cancellation/deadline inherited from the originating tool request. */
  signal?: AbortSignal;
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
  /**
   * Requested reasoning depth.
   *
   * Applied ONLY when `model` is positively known to accept the corresponding
   * parameter shape (see reasoning-effort.ts for why that gate exists and what
   * it prevents). An unrecognized or non-reasoning model — `gpt-4.1-mini`,
   * `claude-haiku-4-5`, a tenant BYOK id — leaves the request byte-identical to
   * one without this field, so setting it can never turn a working generation
   * into a 400.
   */
  reasoningEffort?: ReasoningEffort;
}

/**
 * Output ceiling used when adaptive thinking is on.
 *
 * Anthropic counts thinking against `max_tokens`, so the legacy 2400 default
 * would let a deep-reasoning pass spend the entire budget on thinking and return
 * a truncated draft — a silent quality regression that looks like a bad model
 * rather than a bad ceiling. Raised only on the thinking path; the non-thinking
 * default stays exactly 2400.
 */
const THINKING_MAX_TOKENS = 16_000;

export interface LlmCompletionResult {
  text: string;
  usage: ProviderUsage;
  stopReason: string | null;
  /** True when output hit the token ceiling (caller decides whether to retry). */
  truncated: boolean;
  raw: Record<string, unknown>;
}

/** One streamOnce() attempt's outcome — mirrors the retry decision `completeInner` makes for the non-streaming path. */
type StreamOutcome =
  | { kind: 'ok'; result: LlmCompletionResult }
  | { kind: 'retryable'; status: number | null; retryAfterMs: number | null; message: string }
  | { kind: 'fatal'; status: number | null; message: string };

const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Per-call ceiling for the governed outreach generation path (message plan →
 * draft → author style), passed explicitly by those three call sites.
 *
 * The 90s default above is right for interactive assistant calls but far too low
 * here: these run gpt-5 at `max` reasoning effort, and an abort is deliberately
 * NOT retried (see complete()), so a slow-but-healthy call became a hard
 * `503 … request timed out after 90s`. Left as an explicit per-call override
 * rather than a higher global default so unrelated callers keep failing fast.
 *
 * Bounded, not unlimited: the ALB caps any single request at 4000s no matter what,
 * and a caller may make several of these sequentially.
 */
export const LLM_LONG_GENERATION_TIMEOUT_MS = 900_000;
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
    assertExternalAction(action: 'outreach_generate' | 'outreach_v3_generate' | 'meeting_prep_generate'): void;
  };
}

export class LlmCompletionService {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Pick<Logger, 'warn'>;
  private readonly runtimePolicy?: {
    assertExternalAction(action: 'outreach_generate' | 'outreach_v3_generate' | 'meeting_prep_generate'): void;
  };

  constructor(opts: LlmCompletionServiceOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.logger = opts.logger ?? new Logger(LlmCompletionService.name);
    this.runtimePolicy = opts.runtimePolicy;
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
    // Provider wall-clock is measured around the WHOLE call including retries,
    // because that is the latency the user actually waits for. The scope's call
    // counter distinguishes one slow call from several fast ones. Outside an
    // active Context Plane scope this is a no-op, so non-governed callers and
    // unit tests are unaffected.
    return contextStageTimer.time('provider', () => this.completeInner({ ...req, model: upgradeTextModel(req.model) }));
  }

  /**
   * Same request/result contract as {@link complete}, but calls `onProgress`
   * with the RAW, still-incomplete response text as it streams in, so a
   * caller can extract a live preview of a structured-output field (see
   * `streaming-json-field.ts`) before the call finishes. The final
   * `LlmCompletionResult` is identical either way — this only adds a
   * side-channel of partial text, never changes what gets returned.
   *
   * OpenAI only today (the pinned outreach-generation provider). Anthropic
   * silently falls back to {@link complete} with no progress callbacks —
   * never an error — so a caller can always call this method regardless of
   * provider and simply get no live preview on the Anthropic path.
   *
   * `onProgress` receives the FULL accumulated text so far on every call, not
   * a delta, specifically so a retried attempt (which starts a fresh,
   * separately-accumulated stream) naturally supersedes a failed attempt's
   * partial text — the caller just overwrites its stored preview each time,
   * no explicit "reset" signal needed.
   */
  async completeStreaming(
    req: LlmCompletionRequest,
    onProgress: (rawTextSoFar: string) => void,
  ): Promise<LlmCompletionResult> {
    return contextStageTimer.time('provider', () => this.completeStreamingInner({ ...req, model: upgradeTextModel(req.model) }, onProgress));
  }

  private async completeStreamingInner(
    req: LlmCompletionRequest,
    onProgress: (rawTextSoFar: string) => void,
  ): Promise<LlmCompletionResult> {
    req.signal?.throwIfAborted();
    if (req.provider !== 'openai') {
      return this.completeInner(req);
    }
    this.runtimePolicy?.assertExternalAction(req.runtimeAction ?? 'outreach_generate');
    const maxRetries = req.maxRetries ?? DEFAULT_MAX_RETRIES;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      req.signal?.throwIfAborted();
      try {
        const outcome = await this.streamOnce(req, onProgress);
        req.signal?.throwIfAborted();
        if (outcome.kind === 'ok') {
          contextStageTimer.recordProvider({
            status: 'ok',
            model: req.model,
            inputTokens: outcome.result.usage.inputTokens,
            outputTokens: outcome.result.usage.outputTokens,
            cacheReadTokens: outcome.result.usage.cacheReadTokens ?? null,
            cacheWriteTokens: outcome.result.usage.cacheCreationTokens ?? null,
          });
          return outcome.result;
        }
        contextStageTimer.recordProvider({
          status: outcome.status ? `http_${outcome.status}` : 'stream_error',
          model: req.model,
        });
        if (outcome.kind === 'retryable' && attempt < maxRetries) {
          const backoff = outcome.retryAfterMs ?? this.backoffMs(attempt);
          this.logger.warn(
            `openai streaming completion ${outcome.status ?? 'stream error'}; retry ${attempt + 1}/${maxRetries} in ${backoff}ms: ${outcome.message}`,
          );
          await this.sleep(backoff);
          continue;
        }
        throw new ServiceUnavailableException(
          `openai streaming completion failed: ${outcome.message}`,
        );
      } catch (err) {
        req.signal?.throwIfAborted();
        if (err instanceof ServiceUnavailableException) throw err;
        lastError = err;
        if (attempt < maxRetries) {
          const backoff = this.backoffMs(attempt);
          this.logger.warn(
            `openai streaming completion network error; retry ${attempt + 1}/${maxRetries} in ${backoff}ms: ${(err as Error).message}`,
          );
          await this.sleep(backoff);
          continue;
        }
      }
    }
    throw new ServiceUnavailableException(
      `openai streaming completion failed after ${maxRetries + 1} attempts: ${
        (lastError as Error)?.message ?? 'unknown error'
      }`,
    );
  }

  /**
   * One streaming attempt. Reads Server-Sent Events off the OpenAI Responses
   * API's `stream: true` body: `response.output_text.delta` events feed
   * `onProgress` with the accumulated raw text; `response.completed` carries
   * the SAME full response shape the non-streaming path receives in one
   * shot, so it runs through the identical {@link parseResult} — nothing
   * about how the final result is parsed or validated differs by transport.
   *
   * A stream that ends without ever seeing `response.completed` (dropped
   * connection, a mid-stream provider error) is treated as retryable: no
   * partial result is ever returned as if it were final.
   */
  private async streamOnce(
    req: LlmCompletionRequest,
    onProgress: (rawTextSoFar: string) => void,
  ): Promise<StreamOutcome> {
    req.signal?.throwIfAborted();
    const controller = new AbortController();
    const onAbort = () => controller.abort(req.signal?.reason);
    req.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const { url, headers, body } = this.buildRequest(req);
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, stream: true }),
        signal: controller.signal,
      });
      if (res.status < 200 || res.status >= 300) {
        // Rejected before any streaming began — same shape as the
        // non-streaming failure path.
        let json: Record<string, unknown> = {};
        try {
          json = (await res.json()) as Record<string, unknown>;
        } catch {
          // Non-JSON error body — fall through with an empty object; readError
          // below falls back to a generic HTTP-status message.
        }
        const retryAfter = res.headers?.get?.('retry-after');
        const retryAfterMs = retryAfter ? Math.max(0, Number(retryAfter) * 1000) || null : null;
        const message = readError(json, res.status);
        return RETRYABLE_STATUS.has(res.status)
          ? { kind: 'retryable', status: res.status, retryAfterMs, message }
          : { kind: 'fatal', status: res.status, message };
      }
      if (!res.body) {
        return {
          kind: 'retryable',
          status: null,
          retryAfterMs: null,
          message: 'no response body for streaming request',
        };
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let rawTextSoFar = '';
      let finalResponseJson: Record<string, unknown> | null = null;
      let streamError: string | null = null;

      while (true) {
        req.signal?.throwIfAborted();
        const { done, value } = await reader.read();
        req.signal?.throwIfAborted();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? ''; // last (possibly incomplete) event stays buffered
        for (const rawEvent of events) {
          req.signal?.throwIfAborted();
          const dataLine = rawEvent.split('\n').find((line) => line.startsWith('data:'));
          if (!dataLine) continue;
          const jsonText = dataLine.slice(5).trim();
          if (!jsonText || jsonText === '[DONE]') continue;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(jsonText) as Record<string, unknown>;
          } catch {
            continue; // an unparseable/partial event line — ignore, not fatal
          }
          const type = typeof parsed.type === 'string' ? parsed.type : '';
          if (type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
            rawTextSoFar += parsed.delta;
            onProgress(rawTextSoFar);
          } else if (type === 'response.completed') {
            finalResponseJson = toRec(parsed.response);
          } else if (
            type === 'response.failed' ||
            type === 'response.incomplete' ||
            type === 'error'
          ) {
            const responseStatus = toRec(parsed.response).status;
            streamError =
              typeof responseStatus === 'string'
                ? responseStatus
                : typeof parsed.message === 'string'
                  ? parsed.message
                  : type;
          }
        }
      }

      if (finalResponseJson) {
        return { kind: 'ok', result: this.parseResult('openai', finalResponseJson) };
      }
      return {
        kind: 'retryable',
        status: null,
        retryAfterMs: null,
        message: streamError ?? 'stream ended without a completed event',
      };
    } catch (err) {
      req.signal?.throwIfAborted();
      if ((err as Error).name === 'AbortError') {
        throw new ServiceUnavailableException(
          `${req.provider} request timed out after ${(req.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
  }

  private async completeInner(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
    req.signal?.throwIfAborted();
    if (req.pdfInput && req.provider !== 'openai') {
      throw new ServiceUnavailableException('PDF input requires the OpenAI Responses provider');
    }
    // Assert the exact caller authority before any network call.
    this.runtimePolicy?.assertExternalAction(req.runtimeAction ?? 'outreach_generate');
    const maxRetries = req.maxRetries ?? DEFAULT_MAX_RETRIES;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      req.signal?.throwIfAborted();
      try {
        const { status, json, retryAfterMs } = await this.callOnce(req);
        req.signal?.throwIfAborted();
        if (status >= 200 && status < 300) {
          const parsed = this.parseResult(req.provider, json);
          // Counts and enums already available here. No prompt, no completion
          // text, no provider key.
          contextStageTimer.recordProvider({
            status: 'ok',
            model: req.model,
            inputTokens: parsed.usage.inputTokens,
            outputTokens: parsed.usage.outputTokens,
            cacheReadTokens: parsed.usage.cacheReadTokens ?? null,
            cacheWriteTokens: parsed.usage.cacheCreationTokens ?? null,
          });
          return parsed;
        }
        // A non-2xx that will be retried or raised is still provider latency and
        // still a provider status. Recording only successes would make the error
        // rate look like zero in exactly the incidents it matters for.
        contextStageTimer.recordProvider({ status: `http_${status}`, model: req.model });
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
        req.signal?.throwIfAborted();
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
    req.signal?.throwIfAborted();
    const controller = new AbortController();
    const onAbort = () => controller.abort(req.signal?.reason);
    req.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    // Native fetch has independent 5-minute headers/body limits. For prep only,
    // let the caller's abort timer govern the entire request. Override dispatch
    // options too: some bundled fetch versions supply their own 300s defaults.
    const prepAgent = req.runtimeAction === 'meeting_prep_generate' ? new Agent() : undefined;
    if (prepAgent) {
      const dispatch = prepAgent.dispatch.bind(prepAgent);
      prepAgent.dispatch = (options, handler) =>
        dispatch({ ...options, headersTimeout: 0, bodyTimeout: 0 }, handler);
    }
    try {
      const { url, headers, body } = this.buildRequest(req);
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        ...(prepAgent ? { dispatcher: prepAgent } : {}),
      });
      const json = (await res.json()) as Record<string, unknown>;
      const retryAfter = res.headers?.get?.('retry-after');
      const retryAfterMs = retryAfter ? Math.max(0, Number(retryAfter) * 1000) || null : null;
      return { status: res.status, json, retryAfterMs };
    } catch (err) {
      req.signal?.throwIfAborted();
      if ((err as Error).name === 'AbortError') {
        throw new ServiceUnavailableException(
          `${req.provider} request timed out after ${(req.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      await prepAgent?.destroy();
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
      const userText = joinUser(req.userStatic, req.userVolatile);
      // https://developers.openai.com/api/docs/guides/file-inputs
      // PDF inputs include page images, so a scanned page does not depend on
      // a text layer. No Files API upload or persistent provider file is needed.
      const input = req.pdfInput ? [{ role: 'user', content: [
        { type: 'input_file', filename: req.pdfInput.filename,
          file_data: `data:application/pdf;base64,${req.pdfInput.base64}` },
        { type: 'input_text', text: userText },
      ] }] : userText;
      // Reasoning families only. `gpt-4.1*`/`gpt-4o*` reject `reasoning`, so an
      // unconditional field would 400 the model this service runs on today.
      const openAiReasoning =
        req.reasoningEffort && openAiSupportsReasoningEffort(req.model)
          ? { reasoning: { effort: openAiReasoningEffort(req.reasoningEffort, req.model) } }
          : {};
      return {
        url: 'https://api.openai.com/v1/responses',
        headers: {
          Authorization: `Bearer ${req.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: prepareOpenAiResponsesRequest({
          model: req.model,
          ...(req.pdfInput ? { store: false } : {}),
          // Omit `instructions` when there is no system prompt (legacy v1 path).
          ...(req.system.trim() ? { instructions: req.system } : {}),
          input,
          ...openAiReasoning,
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
        }),
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
    // Adaptive thinking + output_config.effort is the CURRENT shape and the only
    // one sent. `budget_tokens` is deliberately never sent: deprecated on 4.6,
    // a 400 on 4.7+. Models outside the supported set (incl. this repo's
    // ANTHROPIC_MODEL default, claude-haiku-4-5) get no thinking field at all.
    const thinkingOn = Boolean(
      req.reasoningEffort && anthropicSupportsAdaptiveThinking(req.model),
    );
    const anthropicThinking = thinkingOn
      ? {
          thinking: { type: 'adaptive' },
          output_config: { effort: anthropicEffort(req.model, req.reasoningEffort!) },
        }
      : {};
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'x-api-key': req.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: prepareAnthropicRequest({
        model: req.model,
        // Thinking spends from max_tokens, so a caller's small explicit cap
        // (message-plan passes 2000) would otherwise be consumed by reasoning and
        // truncate the answer. Raise to the thinking floor rather than honouring a
        // cap that predates thinking; leave the non-thinking path exactly as it was.
        max_tokens: thinkingOn
          ? Math.max(req.maxTokens ?? 0, THINKING_MAX_TOKENS)
          : (req.maxTokens ?? 2400),
        ...anthropicThinking,
        // See LlmCompletionRequest.temperature — Anthropic-only by design, and
        // dropped entirely while thinking is on: sampling parameters were removed
        // alongside budget_tokens on 4.7+ and return a 400 there.
        ...(req.temperature !== undefined && !thinkingOn
          ? { temperature: req.temperature }
          : {}),
        system,
        messages: [{ role: 'user', content }],
      }),
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
