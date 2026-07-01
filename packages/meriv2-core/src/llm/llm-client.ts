import { z } from 'zod';

/**
 * Minimal Anthropic Messages client — the repo's house pattern (raw fetch to
 * api.anthropic.com, no SDK). Used by MeriV2 reasoning tools (hearing summary,
 * live policy-mention extraction). The orchestrator binds a concrete instance
 * with the resolved API key + model; meriv2-core stays dependency-light.
 *
 * Key resolution (tenant-key-first → global env) is the orchestrator's job; this
 * client just takes a usable key + model and returns parsed JSON.
 */
export interface LlmClient {
  /** Run a single JSON-returning completion. Returns parsed object or throws. */
  completeJson(params: {
    system: string;
    prompt: string;
    maxTokens?: number;
  }): Promise<Record<string, unknown>>;
}

export interface AnthropicLlmOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class AnthropicLlmClient implements LlmClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: AnthropicLlmOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }

  async completeJson(params: {
    system: string;
    prompt: string;
    maxTokens?: number;
  }): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: params.maxTokens ?? 1024,
          system: params.system,
          messages: [{ role: 'user', content: params.prompt }],
        }),
        signal: controller.signal,
      });
      const raw = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        throw new Error(`Anthropic request failed (${res.status}): ${readError(raw)}`);
      }
      return parseJsonObject(extractAnthropicText(raw));
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Pull the text content out of an Anthropic Messages API response. */
export function extractAnthropicText(raw: Record<string, unknown>): string {
  const content = raw.content;
  if (Array.isArray(content)) {
    const text = content
      .map((b) =>
        b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '',
      )
      .join('');
    if (text) return text;
  }
  return '';
}

/** Parse a JSON object from model text, tolerating ```json fences and prose. */
export function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readError(raw: Record<string, unknown>): string {
  const err = raw.error;
  if (err && typeof err === 'object' && 'message' in err)
    return String((err as { message: unknown }).message);
  return 'unknown error';
}

/** Schema helpers shared by reasoning tools. */
export const stanceSchema = z.enum(['supports', 'opposes', 'concerned', 'neutral']);
export const sentimentSchema = z.enum(['positive', 'negative', 'neutral']);
export const intensitySchema = z.enum(['low', 'medium', 'high']);
export const clientImpactSchema = z.enum(['favorable', 'unfavorable', 'monitor', 'no_action']);
