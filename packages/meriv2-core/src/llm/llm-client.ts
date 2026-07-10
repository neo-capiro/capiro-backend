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
  /**
   * Schema-forced completion (Phase 1 M5.0, agentic doc §5.3) — the
   * `GroundedJson` contract's "Anthropic tool-forcing where the provider
   * supports it" mechanism. Sends ONE synthetic tool with `input_schema` and
   * `tool_choice: {type:'tool', name}`, so Anthropic validates/coerces the
   * shape server-side before it ever reaches this process (stronger than a
   * JSON-mode prompt instruction the model can ignore). Returns the tool's
   * raw `input` (still untyped — the caller zod-validates) + usage for
   * metering. Throws on a non-2xx/timeout/missing-tool-use, same contract as
   * `completeJson`.
   */
  completeWithSchema(params: {
    system: string;
    prompt: string;
    toolName: string;
    toolDescription: string;
    inputSchema: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<{ input: unknown; usage: { inputTokens: number; outputTokens: number } }>;
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

  async completeWithSchema(params: {
    system: string;
    prompt: string;
    toolName: string;
    toolDescription: string;
    inputSchema: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<{ input: unknown; usage: { inputTokens: number; outputTokens: number } }> {
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
          tools: [
            {
              name: params.toolName,
              description: params.toolDescription,
              input_schema: params.inputSchema,
            },
          ],
          tool_choice: { type: 'tool', name: params.toolName },
          messages: [{ role: 'user', content: params.prompt }],
        }),
        signal: controller.signal,
      });
      const raw = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        throw new Error(`Anthropic request failed (${res.status}): ${readError(raw)}`);
      }
      const toolUse = extractToolUseInput(raw, params.toolName);
      if (toolUse === undefined) {
        throw new Error(`Anthropic did not return a "${params.toolName}" tool_use block`);
      }
      return { input: toolUse, usage: extractAnthropicUsage(raw) };
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

/** Pull a named tool's `input` out of an Anthropic Messages response's `content[]`; `undefined` if absent. */
export function extractToolUseInput(raw: Record<string, unknown>, toolName: string): unknown {
  const content = raw.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'tool_use' && b.name === toolName) return b.input;
  }
  return undefined;
}

/** Extract token usage from an Anthropic Messages response; zeros for a malformed/absent `usage`. */
export function extractAnthropicUsage(raw: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
} {
  const usage = raw.usage;
  if (!usage || typeof usage !== 'object') return { inputTokens: 0, outputTokens: 0 };
  const u = usage as Record<string, unknown>;
  const toCount = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  return { inputTokens: toCount(u.input_tokens), outputTokens: toCount(u.output_tokens) };
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
