import {
  anthropicEffort,
  anthropicSupportsAdaptiveThinking,
  openAiReasoningEffort,
  openAiSupportsReasoningEffort,
  supportsReasoning,
} from './reasoning-effort.js';
import { LlmCompletionService } from '../llm-completion.service.js';

/**
 * The point of every test below is the SAME failure this module exists to
 * prevent: a reasoning parameter reaching a model that answers it with a 400.
 * That already happened once with `temperature` and took down every outreach
 * generation, so "does the request stay byte-identical for unsupported models"
 * is the property under test, not an implementation detail.
 */
describe('reasoning capability gate', () => {
  it('sends nothing to the models actually configured in this repo today', () => {
    // OPENAI_MODEL / OUTREACH_V3_REASONING_MODEL default (and the live task-def
    // value) — a non-reasoning family.
    expect(openAiSupportsReasoningEffort('gpt-4.1-mini')).toBe(false);
    expect(openAiSupportsReasoningEffort('gpt-4o')).toBe(false);
    // ANTHROPIC_MODEL default — `output_config.effort` ERRORS on this family.
    expect(anthropicSupportsAdaptiveThinking('claude-haiku-4-5-20251001')).toBe(false);
    expect(anthropicSupportsAdaptiveThinking('claude-sonnet-4-5')).toBe(false);
    expect(anthropicSupportsAdaptiveThinking('claude-3-5-sonnet')).toBe(false);
  });

  it('recognizes the reasoning families', () => {
    expect(openAiSupportsReasoningEffort('gpt-5')).toBe(true);
    expect(openAiSupportsReasoningEffort('o3-mini')).toBe(true);
    expect(anthropicSupportsAdaptiveThinking('claude-opus-5')).toBe(true);
    expect(anthropicSupportsAdaptiveThinking('claude-opus-4-8')).toBe(true);
    expect(anthropicSupportsAdaptiveThinking('claude-sonnet-5')).toBe(true);
    expect(anthropicSupportsAdaptiveThinking('claude-fable-5')).toBe(true);
  });

  it('treats an unknown BYOK model as unsupported rather than guessing', () => {
    expect(supportsReasoning('openai', 'some-tenant-finetune')).toBe(false);
    expect(supportsReasoning('anthropic', 'some-tenant-finetune')).toBe(false);
    expect(supportsReasoning('openai', '')).toBe(false);
  });

  it('clamps xhigh DOWN on the 4.6 generation, which has no xhigh rung', () => {
    expect(anthropicEffort('claude-opus-4-6', 'xhigh')).toBe('high');
    expect(anthropicEffort('claude-sonnet-4-6', 'xhigh')).toBe('high');
    // max exists on 4.6, so it passes through untouched.
    expect(anthropicEffort('claude-sonnet-4-6', 'max')).toBe('max');
    expect(anthropicEffort('claude-opus-5', 'xhigh')).toBe('xhigh');
  });

  it('collapses xhigh/max onto high for OpenAI, whose ladder stops there', () => {
    expect(openAiReasoningEffort('max')).toBe('high');
    expect(openAiReasoningEffort('xhigh')).toBe('high');
    expect(openAiReasoningEffort('medium')).toBe('medium');
    expect(openAiReasoningEffort('low')).toBe('low');
  });
});

describe('LlmCompletionService request shaping', () => {
  /** Capture the outgoing body without a network call. */
  async function capture(req: Parameters<LlmCompletionService['complete']>[0]) {
    let body: Record<string, unknown> | undefined;
    const service = new LlmCompletionService({
      fetchImpl: (async (_url: string, init: { body?: string }) => {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            content: [{ type: 'text', text: '{}' }],
            output_text: '{}',
            stop_reason: 'end_turn',
          }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
      sleepImpl: async () => {},
      logger: { warn: () => {} },
    });
    await service.complete(req);
    return body!;
  }

  const base = {
    apiKey: 'k',
    system: 'sys',
    userStatic: '',
    userVolatile: 'u',
    jsonSchema: { type: 'object' } as Record<string, unknown>,
  };

  it('upgrades legacy OpenAI selections and preserves requested max effort', async () => {
    const body = await capture({
      ...base,
      provider: 'openai',
      model: 'gpt-4.1-mini',
      reasoningEffort: 'max',
    });
    expect(body.model).toBe('gpt-6-astra');
    expect(body.reasoning).toEqual({ effort: 'max' });
  });

  it('sends `reasoning.effort` for an OpenAI reasoning model', async () => {
    const body = await capture({
      ...base,
      provider: 'openai',
      model: 'gpt-5',
      reasoningEffort: 'max',
    });
    expect(body.reasoning).toEqual({ effort: 'max' });
  });

  it('upgrades Haiku to Sonnet 5 with adaptive thinking and output headroom', async () => {
    const body = await capture({
      ...base,
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      reasoningEffort: 'max',
    });
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'max' });
    expect(body.max_tokens).toBeGreaterThanOrEqual(16_000);
  });

  it('sends adaptive thinking + output_config.effort, and never budget_tokens', async () => {
    const body = await capture({
      ...base,
      provider: 'anthropic',
      model: 'claude-opus-5',
      reasoningEffort: 'max',
    });
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'max' });
    // budget_tokens is a 400 on this family; it must never be emitted.
    expect(JSON.stringify(body)).not.toContain('budget_tokens');
  });

  it('raises a caller cap that thinking would otherwise consume', async () => {
    // message-plan passes 2000; adaptive thinking spends from max_tokens, so
    // honouring that cap would truncate the plan instead of deepening it.
    const body = await capture({
      ...base,
      provider: 'anthropic',
      model: 'claude-opus-5',
      reasoningEffort: 'max',
      maxTokens: 2000,
    });
    expect(Number(body.max_tokens)).toBeGreaterThanOrEqual(16_000);
  });

  it('drops unsupported sampling parameters with or without explicit thinking', async () => {
    const thinking = await capture({
      ...base,
      provider: 'anthropic',
      model: 'claude-opus-5',
      reasoningEffort: 'high',
      temperature: 0.2,
    });
    expect(thinking.temperature).toBeUndefined();

    const plain = await capture({
      ...base,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      temperature: 0.2,
    });
    expect(plain.temperature).toBeUndefined();
  });

  it('leaves a request without reasoningEffort byte-identical to before', async () => {
    const withoutField = await capture({
      ...base,
      provider: 'anthropic',
      model: 'claude-opus-5',
    });
    expect(withoutField.thinking).toBeUndefined();
    expect(withoutField.output_config).toBeUndefined();
    expect(withoutField.max_tokens).toBe(2400);
  });
});
