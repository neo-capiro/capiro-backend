import { Injectable, Logger } from '@nestjs/common';
import type { ProviderUsage } from '@capiro/shared';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import type {
  MeriV3ReasoningProfile,
  OpenAiResponsesFunctionCall,
  OpenAiResponsesFunctionTool,
  OpenAiResponsesOutputItem,
  OpenAiResponsesResult,
} from './meriv3.types.js';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const MAX_RETRIES = 2;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const retryDelay = (attempt: number) => 300 * 2 ** attempt + Math.floor(Math.random() * 100);

interface CompleteParams {
  profile: MeriV3ReasoningProfile;
  instructions: string;
  input: Array<Record<string, unknown>>;
  tools: OpenAiResponsesFunctionTool[];
  toolChoice?: 'auto' | 'none';
  timeoutMs?: number;
  signal?: AbortSignal;
  safetyIdentifier?: string;
}

interface RawResponsesBody {
  id?: string;
  status?: string;
  model?: string;
  output?: OpenAiResponsesOutputItem[];
  output_text?: string;
  incomplete_details?: { reason?: string | null } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
}

export function parseOpenAiResponsesUsage(body: RawResponsesBody): ProviderUsage {
  return {
    inputTokens: Number(body.usage?.input_tokens ?? 0) || 0,
    outputTokens: Number(body.usage?.output_tokens ?? 0) || 0,
    cacheReadTokens: Number(body.usage?.input_tokens_details?.cached_tokens ?? 0) || 0,
    cacheCreationTokens: 0,
  };
}

export function extractResponsesOutputText(output: OpenAiResponsesOutputItem[]): string {
  return output
    .filter((item): item is Extract<OpenAiResponsesOutputItem, { type: 'message' }> =>
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

@Injectable()
export class OpenAiResponsesClient {
  private readonly logger = new Logger(OpenAiResponsesClient.name);

  async complete(params: CompleteParams): Promise<OpenAiResponsesResult> {
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
    const model =
      usedTenantKey && requestOpenAi?.modelOverridden
        ? requestOpenAi.model
        : params.profile.model;

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      if (params.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const controller = new AbortController();
      const timeoutMs = params.timeoutMs ?? params.profile.turnBudgetMs;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const abortFromCaller = () => controller.abort();
      params.signal?.addEventListener('abort', abortFromCaller, { once: true });
      let status: number | undefined;
      try {
        const toolFields = params.tools.length
          ? {
              tools: params.tools,
              tool_choice: params.toolChoice ?? 'auto',
              parallel_tool_calls: true,
            }
          : {};
        const response = await fetch(RESPONSES_URL, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            model,
            instructions: params.instructions,
            input: params.input,
            ...toolFields,
            reasoning: {
              effort: params.profile.effort,
              // Request a provider-authored bounded summary for continuity in
              // the current turn, but never emit or persist reasoning items.
              summary: 'auto',
            },
            max_output_tokens: params.profile.maxOutputTokens,
            store: false,
            ...(params.safetyIdentifier
              ? { safety_identifier: params.safetyIdentifier }
              : {}),
          }),
          signal: controller.signal,
        });
        status = response.status;
        const raw = await response.text();
        if (!response.ok) throw sanitizedProviderError(response.status, raw);
        const body = JSON.parse(raw) as RawResponsesBody;
        const output = Array.isArray(body.output) ? body.output : [];
        const outputText =
          typeof body.output_text === 'string'
            ? body.output_text.trim()
            : extractResponsesOutputText(output);
        return {
          id: String(body.id ?? ''),
          status: String(body.status ?? 'completed'),
          output,
          outputText,
          functionCalls: extractResponsesFunctionCalls(output),
          usage: parseOpenAiResponsesUsage(body),
          model: String(body.model ?? model),
          usedTenantKey,
          incompleteReason: body.incomplete_details?.reason ?? null,
        };
      } catch (error) {
        lastError = error;
        if (params.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new Error(`OpenAI Responses request timed out after ${timeoutMs}ms`);
        }
        if (attempt >= MAX_RETRIES || !shouldRetry(status, error)) throw error;
        this.logger.warn(
          `MeriV3 OpenAI retry ${attempt + 1}/${MAX_RETRIES} after ${
            error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180)
          }`,
        );
        await sleep(retryDelay(attempt));
      } finally {
        clearTimeout(timer);
        params.signal?.removeEventListener('abort', abortFromCaller);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('OpenAI Responses request failed');
  }
}
