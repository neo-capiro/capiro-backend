import { meriTelemetryUsage } from '@capiro/meriv2-core';
import { prepareOpenAiResponsesRequest, upgradeTextModel } from '@capiro/shared/ai-model-policy';
import {
  captureProviderWireActive,
  prepareCaptureOpenAiBody,
} from '../meri-capture-provider-wire.js';
import { Injectable, Logger } from '@nestjs/common';
import { AI_PRICING, computeAiCostUsd, type ProviderUsage } from '@capiro/shared';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import {
  stableProviderOperationId,
  type MeriModelBudgetPhase,
  type MeriRunBudget,
} from './meriv3-run-budget.js';
import {
  emitMeriOrchestratorTelemetry,
  withMeriOrchestratorTelemetrySpan,
  noteMeriProviderUsage,
  noteMeriUnknownProviderUsage,
} from '../../telemetry/meri-telemetry.runtime.js';
import { MeriV3ResearchRuntimeStore } from './meriv3-research-runtime.store.js';
import type {
  MeriV3ReasoningEffort,
  MeriV3ReasoningProfile,
  MeriV3ProviderTelemetry,
  OpenAiResponsesFunctionCall,
  OpenAiResponsesFunctionTool,
  OpenAiResponsesOutputItem,
  OpenAiResponsesResult,
  OpenAiResponsesToolChoice,
} from './meriv3.types.js';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const MAX_RETRIES = 2;

const retryDelay = (attempt: number) => 300 * 2 ** attempt + Math.floor(Math.random() * 100);

/**
 * The provider's own back-off instruction, in milliseconds, or null when it
 * gave none. OpenAI sends `retry-after-ms`; standard HTTP sends `retry-after`
 * as seconds or an HTTP date. Retrying sooner only spends another throttled
 * attempt (program plan §4.5: a measured defect).
 */
export function parseRetryAfterMs(
  headers: { get(name: string): string | null } | undefined,
  now = Date.now(),
): number | null {
  const ms = headers?.get('retry-after-ms')?.trim();
  if (ms && /^\d+(?:\.\d+)?$/.test(ms)) return Math.ceil(Number(ms));
  const value = headers?.get('retry-after')?.trim();
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.ceil(Number(value) * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Read only structured execution facts from a failed/cancelled provider request. */
export function readOpenAiResponsesErrorTelemetry(
  error: unknown,
): MeriV3ProviderTelemetry | undefined {
  return error instanceof Error || error instanceof DOMException
    ? (error as Error & { telemetry?: MeriV3ProviderTelemetry }).telemetry
    : undefined;
}

interface CompleteParams {
  profile: MeriV3ReasoningProfile;
  instructions: string;
  input: Array<Record<string, unknown>>;
  tools: OpenAiResponsesFunctionTool[];
  toolChoice?: OpenAiResponsesToolChoice;
  timeoutMs?: number;
  /** Absolute turn deadline, shared with tool execution and all retries. */
  deadlineAt?: number;
  signal?: AbortSignal;
  safetyIdentifier?: string;
  budget?: MeriRunBudget;
  budgetPhase?: MeriModelBudgetPhase;
}

interface RawResponsesBody {
  id?: string;
  status?: string;
  model?: string;
  output?: OpenAiResponsesOutputItem[];
  output_text?: string;
  incomplete_details?: { reason?: string | null } | null;
  error?: { code?: string | null } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
}

/** Raw observations stay nullable; the legacy ProviderUsage contract stays compatible. */
export function observedOpenAiResponsesUsage(body: RawResponsesBody) {
  const tokens = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    inputTokens: tokens(body.usage?.input_tokens),
    outputTokens: tokens(body.usage?.output_tokens),
    cacheReadTokens: tokens(body.usage?.input_tokens_details?.cached_tokens),
    cacheCreationTokens: null,
  };
}

export function parseOpenAiResponsesUsage(body: RawResponsesBody): ProviderUsage {
  const observed = observedOpenAiResponsesUsage(body);
  return {
    inputTokens: observed.inputTokens ?? 0,
    outputTokens: observed.outputTokens ?? 0,
    cacheReadTokens: observed.cacheReadTokens ?? 0,
    cacheCreationTokens: 0,
  };
}

function knownOpenAiResponsesUsage(
  body: RawResponsesBody,
): { inputTokens: number; outputTokens: number } | null {
  const inputTokens = body.usage?.input_tokens;
  const outputTokens = body.usage?.output_tokens;
  return Number.isSafeInteger(inputTokens) &&
    Number(inputTokens) >= 0 &&
    Number.isSafeInteger(outputTokens) &&
    Number(outputTokens) >= 0
    ? { inputTokens: Number(inputTokens), outputTokens: Number(outputTokens) }
    : null;
}

function combinedUsage(...values: ProviderUsage[]): ProviderUsage {
  return values.reduce<ProviderUsage>(
    (total, value) => ({
      inputTokens: total.inputTokens + value.inputTokens,
      outputTokens: total.outputTokens + value.outputTokens,
      cacheReadTokens: (total.cacheReadTokens ?? 0) + (value.cacheReadTokens ?? 0),
      cacheCreationTokens: (total.cacheCreationTokens ?? 0) + (value.cacheCreationTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  );
}

export function extractResponsesOutputText(output: OpenAiResponsesOutputItem[]): string {
  return output
    .filter(
      (item): item is Extract<OpenAiResponsesOutputItem, { type: 'message' }> =>
        item.type === 'message',
    )
    .flatMap((item) => item.content ?? [])
    .map((part) => {
      if (part.type === 'output_text' && typeof part.text === 'string') return part.text;
      if (part.type === 'refusal' && typeof part.refusal === 'string') return part.refusal;
      return '';
    })
    .filter(Boolean)
    .join('')
    .trim();
}

export function extractResponsesFunctionCalls(
  output: OpenAiResponsesOutputItem[],
): OpenAiResponsesFunctionCall[] {
  return output.filter(
    (item): item is OpenAiResponsesFunctionCall =>
      item.type === 'function_call' &&
      typeof item.call_id === 'string' &&
      typeof item.name === 'string' &&
      typeof item.arguments === 'string',
  );
}

/**
 * A text boundary is usable only when the provider closed the entire response.
 * Checking both the normalized call list and raw output prevents a malformed
 * tool item suppressed by the adapter from being mistaken for tool-free prose.
 */
export function completedTextResponseFailure(response: OpenAiResponsesResult): string | null {
  if (response.status !== 'completed') return `status_${response.status}`;
  if (response.incompleteReason !== null) {
    return `incomplete_${response.incompleteReason ?? 'unknown'}`;
  }
  if (response.telemetry.partial) return `partial_${response.telemetry.finishReason}`;
  if (response.telemetry.finishReason !== 'completed') {
    return `finish_${response.telemetry.finishReason}`;
  }
  if (
    response.functionCalls.length > 0 ||
    response.output.some((item) => item.type === 'function_call')
  ) {
    return 'unexpected_function_call';
  }
  if (!response.outputText.trim()) return 'empty_output';
  return null;
}

function validateResponsesFunctionCallBatch(output: OpenAiResponsesOutputItem[]): {
  calls: OpenAiResponsesFunctionCall[];
  failure?: 'incomplete_function_call' | 'malformed_function_call';
} {
  const items = output.filter((item) => item.type === 'function_call');
  if (!items.length) return { calls: [] };
  if (
    items.some(
      (item) => 'status' in item && item.status !== undefined && item.status !== 'completed',
    )
  ) {
    return { calls: [], failure: 'incomplete_function_call' };
  }
  const calls = extractResponsesFunctionCalls(output);
  if (calls.length !== items.length) return { calls: [], failure: 'malformed_function_call' };
  const callIds = new Set<string>();
  for (const call of calls) {
    if (!call.call_id.trim() || !call.name.trim() || callIds.has(call.call_id)) {
      return { calls: [], failure: 'malformed_function_call' };
    }
    callIds.add(call.call_id);
    try {
      const parsed = JSON.parse(call.arguments) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { calls: [], failure: 'malformed_function_call' };
      }
    } catch {
      return { calls: [], failure: 'malformed_function_call' };
    }
  }
  return { calls };
}

export function anthropicSchemaToResponsesTool(schema: {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}): OpenAiResponsesFunctionTool {
  return {
    type: 'function',
    name: schema.name,
    description: schema.description,
    parameters: schema.input_schema,
    // apps/api re-validates every invocation. Do not force strict mode onto
    // legacy schemas that were authored for Anthropic and may omit the strict
    // subset's all-properties-required/additionalProperties constraints.
    strict: false,
  };
}

function shouldRetry(status: number | undefined, error: unknown): boolean {
  if (status === 408 || status === 409 || status === 429) return true;
  if (status !== undefined && status >= 500) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|network|ECONNRESET|ETIMEDOUT|socket|terminated/i.test(message);
}

function sanitizedProviderError(status: number, raw: string): Error {
  let message = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string; code?: string } };
    message = parsed.error?.message || parsed.error?.code || raw;
  } catch {
    // Provider may return plain text. It is truncated below and never persisted.
  }
  return new Error(`OpenAI Responses HTTP ${status}: ${String(message).slice(0, 300)}`);
}

// Some model tiers intermittently reject the `reasoning` parameter outright
// depending on which backend or BYOK model serves a request. Detect that
// specific rejection so a turn can retry without the parameter rather than
// assume any configured model supports it.
function isReasoningEffortUnsupported(status: number | undefined, error: unknown): boolean {
  if (status !== 400) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /unsupported parameter.*reasoning\.effort|reasoning\.effort.*unsupported parameter/i.test(
    message,
  );
}

function isNamedEffortUnsupported(
  status: number | undefined,
  error: unknown,
  effort: 'max' | 'xhigh',
): boolean {
  if (status !== 400) return false;
  const message = error instanceof Error ? error.message : String(error);
  return (
    new RegExp(`(?:value|effort|reasoning)[^\\n]{0,100}\\b${effort}\\b`, 'i').test(message) &&
    /unsupported|invalid|not supported|not available|allowed values/i.test(message)
  );
}

function criticProfile(profile: MeriV3ReasoningProfile): MeriV3ReasoningProfile {
  return {
    ...profile,
    effort: profile.effort === 'max' ? 'xhigh' : profile.effort,
    maxOutputTokens: Math.min(profile.maxOutputTokens, 8_192),
  };
}

function qualifiedResearchDraft(text: string): string {
  return [
    text.trim(),
    'Research finalization was incomplete. This is the last closed grounded draft; requested sections or cross-checks may still be missing.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

@Injectable()
export class OpenAiResponsesClient {
  private readonly logger = new Logger(OpenAiResponsesClient.name);

  async complete(params: CompleteParams): Promise<OpenAiResponsesResult> {
    const requestStartedAt = Date.now();
    const deadlineAt = Math.min(
      params.deadlineAt ?? Number.POSITIVE_INFINITY,
      requestStartedAt + (params.timeoutMs ?? params.profile.turnBudgetMs),
    );
    const requestCredential = RequestCredentialsStore.get()?.aiProvider;
    const requestOpenAi = requestCredential?.provider === 'openai' ? requestCredential : undefined;
    // apps/api forwards either the tenant's OpenAI key OR Capiro's global key on
    // every canary request. The isolated service may also hold a global key, but
    // does not require one when the authenticated request already supplied it.
    const apiKey = requestOpenAi?.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'MeriV3 is not configured: no request-scoped OpenAI credential and no OPENAI_API_KEY',
      );
    }
    const usedTenantKey = Boolean(requestOpenAi?.usedTenantKey && requestOpenAi.apiKey);
    const model = upgradeTextModel(
      usedTenantKey && requestOpenAi?.modelOverridden ? requestOpenAi.model : params.profile.model,
    );

    const forcedTool = params.tools.length
      ? MeriV3ResearchRuntimeStore.consumeForcedFirstTool()
      : null;
    const forcedToolExists = forcedTool
      ? params.tools.some((tool) => tool.name === forcedTool)
      : false;
    if (forcedTool && !forcedToolExists) {
      this.logger.error(
        `Research Director requested unavailable first tool ${forcedTool}; falling back to the supplied tool choice.`,
      );
    }
    const effectiveToolChoice: OpenAiResponsesToolChoice = forcedToolExists
      ? { type: 'function', name: forcedTool! }
      : (params.toolChoice ?? 'auto');

    let lastError: unknown;
    let reasoningUnsupported = false;
    let activeReasoningEffort: MeriV3ReasoningEffort = params.profile.effort;
    const reasoningFallbackReasons: string[] = [];
    const failedRequest = (error: unknown, finishReason: string): Error =>
      Object.assign(
        error instanceof Error || error instanceof DOMException ? error : new Error(String(error)),
        {
          telemetry: {
            requestedModel: model,
            effectiveModel: null,
            requestedReasoningEffort: params.profile.effort,
            effectiveReasoningEffort: null,
            reasoningFallbackReasons: [...reasoningFallbackReasons],
            finishReason,
            partial: true,
          } satisfies MeriV3ProviderTelemetry,
        },
      );
    let wireAttempts = 0;
    const logicalOperationId = stableProviderOperationId('openai-responses', {
      model,
      phase: params.budgetPhase ?? 'acquisition',
      instructions: params.instructions,
      input: params.input,
      tools: params.tools,
      toolChoice: effectiveToolChoice,
      maxOutputTokens: params.profile.maxOutputTokens,
      ...(captureProviderWireActive() ? { serviceTier: 'default' } : {}),
    });
    let previousAttemptId: string | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (params.signal?.aborted) {
        throw failedRequest(new DOMException('Aborted', 'AbortError'), 'cancelled');
      }
      const toolFields = params.tools.length
        ? {
            tools: params.tools,
            tool_choice: effectiveToolChoice,
            parallel_tool_calls: true,
          }
        : {};
      const preparedRequest = prepareCaptureOpenAiBody(
        prepareOpenAiResponsesRequest(
          {
            model,
            instructions: params.instructions,
            input: params.input,
            ...toolFields,
            ...(reasoningUnsupported
              ? {}
              : {
                  reasoning: {
                    effort: activeReasoningEffort,
                    summary: 'auto',
                  },
                }),
            max_output_tokens: params.profile.maxOutputTokens,
            store: false,
            ...(params.safetyIdentifier ? { safety_identifier: params.safetyIdentifier } : {}),
          },
          { defaultReasoning: !reasoningUnsupported },
        ),
      );
      const requestBody = JSON.stringify(preparedRequest);
      // Reserve the final wire ceiling: model policy can raise a smaller
      // configured output limit before dispatch (for example GPT-6's minimum).
      const wireMaxOutputTokens = preparedRequest.max_output_tokens;
      if (
        typeof wireMaxOutputTokens !== 'number' ||
        !Number.isSafeInteger(wireMaxOutputTokens) ||
        wireMaxOutputTokens <= 0
      )
        throw new Error('openai_responses_output_bound_invalid');
      const attemptId = `${logicalOperationId}:${wireAttempts}`;
      const providerReservation = params.budget
        ? await params.budget.reserveProviderAttempt({
            logicalOperationId,
            attemptId,
            retryOfAttemptId: previousAttemptId,
            kind: 'openai_responses',
            phase: params.budgetPhase ?? 'acquisition',
            provider: 'openai',
            model,
            maxInputTokens: Buffer.byteLength(requestBody, 'utf8'),
            maxOutputTokens: wireMaxOutputTokens,
            retry: wireAttempts > 0,
          })
        : null;
      wireAttempts += 1;
      previousAttemptId = attemptId;
      const durableDeadline = providerReservation
        ? Date.parse(providerReservation.deadlineAt)
        : Number.POSITIVE_INFINITY;
      const attemptDeadline = Math.min(deadlineAt, durableDeadline);
      const timeoutMs = attemptDeadline - Date.now();
      if (timeoutMs <= 0) {
        await params.budget?.settleProviderAttempt(providerReservation, { kind: 'rejected' });
        throw failedRequest(
          new Error('OpenAI Responses turn deadline exceeded'),
          'deadline_exceeded',
        );
      }
      const controller = new AbortController();
      const attemptStartedAt = Date.now();
      let wireStarted = false;
      let wireUsageRecorded = false;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const abortFromCaller = () => controller.abort();
      params.signal?.addEventListener('abort', abortFromCaller, { once: true });
      let status: number | undefined;
      let retryAfterMs: number | null = null;
      let providerSettlementAttempted = false;
      try {
        wireStarted = true;
        const { draft, responseStatus, incompleteReason, callFailure, telemetry, functionCalls } =
          await withMeriOrchestratorTelemetrySpan(
            {
              name: 'meri.provider.attempt',
              boundary: 'orchestrator_provider',
              provider: 'openai',
              requestedModel: model,
              effectiveModel: model,
              attempt: wireAttempts,
              retry: wireAttempts > 1,
              usage: meriTelemetryUsage({ unknownAttempts: 1 }),
            },
            async () => {
              const response = await fetch(RESPONSES_URL, {
                method: 'POST',
                ...(captureProviderWireActive() ? { redirect: 'error' as const } : {}),
                headers: {
                  authorization: `Bearer ${apiKey}`,
                  'content-type': 'application/json',
                  accept: 'application/json',
                },
                body: requestBody,
                signal: controller.signal,
              });
              status = response.status;
              const raw = await response.text();
              if (params.signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
              }
              if (controller.signal.aborted || Date.now() >= attemptDeadline) {
                throw new DOMException('Timed out', 'AbortError');
              }
              if (!response.ok) {
                retryAfterMs = parseRetryAfterMs(response.headers);
                providerSettlementAttempted = true;
                await params.budget?.settleProviderAttempt(providerReservation, {
                  kind: 'uncertain',
                });
                throw sanitizedProviderError(response.status, raw);
              }
              const body = JSON.parse(raw) as RawResponsesBody;
              const output = Array.isArray(body.output) ? body.output : [];
              const outputText =
                typeof body.output_text === 'string'
                  ? body.output_text.trim()
                  : extractResponsesOutputText(output);
              const responseStatus = String(body.status ?? 'unknown');
              const incompleteReason = body.incomplete_details?.reason ?? null;
              const validatedCalls = validateResponsesFunctionCallBatch(output);
              const callFailure =
                responseStatus === 'completed' && incompleteReason === null
                  ? validatedCalls.failure
                  : undefined;
              const telemetry: MeriV3ProviderTelemetry = {
                requestedModel: model,
                effectiveModel: String(body.model ?? model),
                requestedReasoningEffort: params.profile.effort,
                effectiveReasoningEffort: reasoningUnsupported ? null : activeReasoningEffort,
                reasoningFallbackReasons: [...reasoningFallbackReasons],
                finishReason: callFailure ?? incompleteReason ?? body.error?.code ?? responseStatus,
                partial:
                  responseStatus !== 'completed' ||
                  incompleteReason !== null ||
                  callFailure !== undefined,
              };
              // Do not extract or return function calls when response is incomplete.
              // The provider may have emitted partial tool calls before hitting a limit.
              // Replay is required (output items stay request-local) and no tool should
              // dispatch from an unclosed turn.
              const functionCalls =
                responseStatus === 'completed' && !incompleteReason && !callFailure
                  ? validatedCalls.calls
                  : [];
              const parsedUsage = parseOpenAiResponsesUsage(body);
              const knownUsage = knownOpenAiResponsesUsage(body);
              providerSettlementAttempted = true;
              await params.budget?.settleProviderAttempt(
                providerReservation,
                knownUsage ? { kind: 'known', ...knownUsage } : { kind: 'uncertain' },
              );
              const draft: OpenAiResponsesResult = {
                id: String(body.id ?? ''),
                status: responseStatus,
                output,
                outputText,
                functionCalls,
                usage: parsedUsage,
                model: String(body.model ?? model),
                usedTenantKey,
                incompleteReason,
                telemetry,
                providerCalls: [telemetry],
              };
              const observedUsage = observedOpenAiResponsesUsage(body);
              const hasKnownPrice = Boolean(
                AI_PRICING[draft.model] ?? AI_PRICING[draft.model.replace(/-\d{8}$/, '')],
              );
              const estimatedCostUsd =
                hasKnownPrice &&
                observedUsage.inputTokens !== null &&
                observedUsage.outputTokens !== null
                  ? computeAiCostUsd(
                      draft.model,
                      observedUsage.inputTokens,
                      observedUsage.outputTokens,
                    )
                  : null;
              noteMeriProviderUsage({ ...observedUsage, estimatedCostUsd });
              emitMeriOrchestratorTelemetry({
                name: 'meri.provider.attempt.finalized',
                boundary: 'orchestrator_provider',
                provider: 'openai',
                requestedModel: model,
                effectiveModel: draft.model,
                attempt: wireAttempts,
                retry: wireAttempts > 1,
                outcome: telemetry.partial ? 'partial' : 'completed',
                durationMs: Date.now() - attemptStartedAt,
                usage: meriTelemetryUsage({
                  ...observedUsage,
                  knownEstimatedCostUsd: estimatedCostUsd,
                  unknownAttempts: estimatedCostUsd === null ? 1 : 0,
                }),
              });
              wireUsageRecorded = true;
              return {
                draft,
                responseStatus,
                incompleteReason,
                callFailure,
                telemetry,
                functionCalls,
              };
            },
            'client',
          );

        // Finalization may only transform a closed, valid provider draft. An
        // incomplete envelope or invalid function-call batch must return to the
        // assistant's bounded fresh-repair path without consuming the one-shot
        // research finalization or exposing its partial output to critic/synthesis.
        const draftCanFinalize =
          responseStatus === 'completed' &&
          incompleteReason === null &&
          callFailure === undefined &&
          !telemetry.partial;
        const researchFinalization =
          draftCanFinalize && functionCalls.length === 0
            ? MeriV3ResearchRuntimeStore.beginFinalization()
            : null;
        if (!researchFinalization) return draft;

        const remainingBudgetMs = deadlineAt - Date.now();
        if (remainingBudgetMs < 30_000 || params.signal?.aborted) {
          this.logger.warn(
            `Research Director finalization skipped because only ${Math.max(0, remainingBudgetMs)}ms remained.`,
          );
          if (params.signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
          return {
            ...draft,
            outputText: qualifiedResearchDraft(draft.outputText),
            telemetry: {
              ...draft.telemetry,
              finishReason: 'research_finalization_skipped',
              partial: true,
            },
          };
        }

        const criticBudgetMs = Math.max(
          15_000,
          Math.min(90_000, Math.floor(remainingBudgetMs * 0.3)),
        );
        const synthesisBudgetMs = Math.max(15_000, remainingBudgetMs - criticBudgetMs);
        const evidenceInput: Array<Record<string, unknown>> = [
          ...params.input,
          ...(draft.output as Array<Record<string, unknown>>),
        ];

        let criticResult: OpenAiResponsesResult | undefined;
        let synthesisResult: OpenAiResponsesResult | undefined;
        try {
          const critic = await this.complete({
            profile: criticProfile(params.profile),
            instructions: `${params.instructions}\n\n${researchFinalization.criticInstructions}`,
            input: evidenceInput,
            tools: [],
            toolChoice: 'none',
            timeoutMs: criticBudgetMs,
            deadlineAt,
            ...(params.signal ? { signal: params.signal } : {}),
            ...(params.safetyIdentifier ? { safetyIdentifier: params.safetyIdentifier } : {}),
            ...(params.budget
              ? { budget: params.budget, budgetPhase: 'finalization' as const }
              : {}),
          });
          criticResult = critic;
          const criticBoundaryFailure = completedTextResponseFailure(critic);
          if (criticBoundaryFailure) {
            throw new Error(`Research Director critic response rejected: ${criticBoundaryFailure}`);
          }
          const synthesisInput: Array<Record<string, unknown>> = [
            ...evidenceInput,
            {
              role: 'assistant',
              content:
                critic.outputText ||
                '{"missingSections":[],"unsupportedClaims":[],"contradictions":[],"overlookedLanes":[],"requiredCaveats":[],"synthesisPriorities":[]}',
            },
          ];
          const synthesis = await this.complete({
            profile: params.profile,
            instructions: `${params.instructions}\n\n${researchFinalization.synthesisInstructions}`,
            input: synthesisInput,
            tools: [],
            toolChoice: 'none',
            timeoutMs: synthesisBudgetMs,
            deadlineAt,
            ...(params.signal ? { signal: params.signal } : {}),
            ...(params.safetyIdentifier ? { safetyIdentifier: params.safetyIdentifier } : {}),
            ...(params.budget
              ? { budget: params.budget, budgetPhase: 'finalization' as const }
              : {}),
          });
          synthesisResult = synthesis;
          const synthesisBoundaryFailure = completedTextResponseFailure(synthesis);
          if (synthesisBoundaryFailure) {
            throw new Error(
              `Research Director synthesis response rejected: ${synthesisBoundaryFailure}`,
            );
          }
          const validatedSynthesis = MeriV3ResearchRuntimeStore.validateDraft(synthesis.outputText);
          if (validatedSynthesis.issueCount > 0) {
            this.logger.warn(
              JSON.stringify({
                event: 'meri.schedule_integrity',
                issueCount: validatedSynthesis.issueCount,
              }),
            );
          }
          return {
            ...synthesis,
            outputText: validatedSynthesis.text,
            usage: combinedUsage(draft.usage, critic.usage, synthesis.usage),
            usedTenantKey: draft.usedTenantKey || critic.usedTenantKey || synthesis.usedTenantKey,
            providerCalls: [
              ...(draft.providerCalls ?? [draft.telemetry]),
              ...(critic.providerCalls ?? [critic.telemetry]),
              ...(synthesis.providerCalls ?? [synthesis.telemetry]),
            ],
          };
        } catch (finalizationError) {
          if (params.signal?.aborted) throw finalizationError;
          this.logger.warn(
            `Research Director critic/synthesis failed; releasing the grounded draft instead: ${
              finalizationError instanceof Error
                ? finalizationError.message.slice(0, 240)
                : String(finalizationError).slice(0, 240)
            }`,
          );
          return {
            ...draft,
            outputText: qualifiedResearchDraft(draft.outputText),
            usage: combinedUsage(
              draft.usage,
              ...(criticResult ? [criticResult.usage] : []),
              ...(synthesisResult ? [synthesisResult.usage] : []),
            ),
            telemetry: {
              ...draft.telemetry,
              finishReason:
                Date.now() >= deadlineAt ? 'deadline_exceeded' : 'research_finalization_failed',
              partial: true,
            },
            providerCalls: [
              ...(draft.providerCalls ?? [draft.telemetry]),
              ...(criticResult?.providerCalls ?? (criticResult ? [criticResult.telemetry] : [])),
              ...(synthesisResult?.providerCalls ??
                (synthesisResult ? [synthesisResult.telemetry] : [])),
              ...(readOpenAiResponsesErrorTelemetry(finalizationError)
                ? [readOpenAiResponsesErrorTelemetry(finalizationError)!]
                : []),
            ],
          };
        }
      } catch (error) {
        if (!providerSettlementAttempted) {
          providerSettlementAttempted = true;
          await params.budget?.settleProviderAttempt(providerReservation, { kind: 'uncertain' });
        }
        lastError = error;
        if (wireStarted && !wireUsageRecorded) {
          noteMeriUnknownProviderUsage();
          emitMeriOrchestratorTelemetry({
            name: 'meri.provider.attempt.finalized',
            boundary: 'orchestrator_provider',
            provider: 'openai',
            requestedModel: model,
            effectiveModel: model,
            attempt: wireAttempts,
            retry: wireAttempts > 1,
            outcome: params.signal?.aborted ? 'aborted' : 'error',
            durationMs: Date.now() - attemptStartedAt,
            usage: {
              status: 'unknown',
              inputTokens: null,
              outputTokens: null,
              cacheReadTokens: null,
              cacheCreationTokens: null,
              knownEstimatedCostUsd: null,
              unknownAttempts: 1,
              owner: 'AiUsageEvent',
            },
          });
        }
        if (params.signal?.aborted) {
          throw failedRequest(new DOMException('Aborted', 'AbortError'), 'cancelled');
        }
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw failedRequest(
            new Error('OpenAI Responses turn deadline exceeded'),
            'deadline_exceeded',
          );
        }
        if (
          !reasoningUnsupported &&
          activeReasoningEffort === 'max' &&
          isNamedEffortUnsupported(status, error, 'max')
        ) {
          activeReasoningEffort = 'xhigh';
          reasoningFallbackReasons.push('max_unsupported');
          this.logger.warn(
            `MeriV3 model ${model} rejected max reasoning on this request; retrying the same turn with xhigh effort.`,
          );
          attempt -= 1;
          continue;
        }
        if (
          !reasoningUnsupported &&
          activeReasoningEffort === 'xhigh' &&
          isNamedEffortUnsupported(status, error, 'xhigh')
        ) {
          activeReasoningEffort = 'high';
          reasoningFallbackReasons.push('xhigh_unsupported');
          this.logger.warn(
            `MeriV3 model ${model} rejected xhigh reasoning on this request; retrying the same turn with high effort.`,
          );
          attempt -= 1;
          continue;
        }
        if (!reasoningUnsupported && isReasoningEffortUnsupported(status, error)) {
          reasoningUnsupported = true;
          reasoningFallbackReasons.push('reasoning_parameter_unsupported');
          this.logger.warn(
            `MeriV3 model ${model} rejected the reasoning parameter on this request; retrying the same turn without it.`,
          );
          attempt -= 1;
          continue;
        }
        if (attempt >= MAX_RETRIES || !shouldRetry(status, error)) {
          throw failedRequest(error, status ? `provider_http_${status}` : 'provider_error');
        }
        const remainingMs = deadlineAt - Date.now();
        if (retryAfterMs !== null && retryAfterMs >= remainingMs) {
          // The provider asked for a longer pause than this turn has left; a
          // retry inside the deadline would be throttled again.
          throw failedRequest(error, status ? `provider_http_${status}` : 'provider_error');
        }
        this.logger.warn(
          `MeriV3 OpenAI retry ${attempt + 1}/${MAX_RETRIES}${
            retryAfterMs !== null ? ` in ${retryAfterMs}ms (provider Retry-After)` : ''
          } after ${
            error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180)
          }`,
        );
        try {
          await waitForRetry(
            Math.max(0, Math.min(retryAfterMs ?? retryDelay(attempt), remainingMs)),
            params.signal,
          );
        } catch (retryError) {
          throw failedRequest(retryError, params.signal?.aborted ? 'cancelled' : 'provider_error');
        }
      } finally {
        clearTimeout(timer);
        params.signal?.removeEventListener('abort', abortFromCaller);
      }
    }
    throw failedRequest(
      lastError ?? new Error('OpenAI Responses request failed'),
      'provider_error',
    );
  }
}
