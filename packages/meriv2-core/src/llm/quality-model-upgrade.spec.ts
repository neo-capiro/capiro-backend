import { describe, expect, it } from '@jest/globals';
import {
  anthropicResponseText,
  prepareAnthropicRequest,
  prepareOpenAiResponsesRequest,
  upgradeTextModel,
} from '@capiro/shared/ai-model-policy';
import { AnthropicLlmClient, OpenAiLlmClient } from './llm-client.js';

describe('quality model migration', () => {
  it.each([
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4o-2024-08-06',
    'gpt-5',
    'gpt-5-mini',
    'gpt-5.6',
    'gpt-5.6-luna',
    'gpt-5.6-terra',
    'gpt-5.6-sol',
  ])('upgrades saved OpenAI selection %s', (model) => {
    expect(upgradeTextModel(model)).toBe('gpt-6-astra');
  });
  it.each([
    'claude-3-haiku-20240307',
    'claude-3-5-haiku-20241022',
    'claude-3-5-sonnet-20241022',
    'claude-sonnet-4-5',
    'claude-sonnet-4-5-20250929',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
  ])('upgrades saved Claude selection %s', (model) => {
    expect(upgradeTextModel(model)).toBe('claude-sonnet-5');
  });
  it.each([
    'claude-opus-4-8',
    'text-embedding-3-small',
    'whisper-1',
    'nova-3',
    'amazon.titan-embed-text-v2:0',
    'gpt-image-1-mini',
    'custom-deployment',
  ])('preserves %s', (model) => {
    expect(upgradeTextModel(model)).toBe(model);
  });
  it('removes incompatible GPT-6 parameters without changing tools or max effort', () => {
    const tools = [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }];
    const source = {
      model: 'gpt-5',
      temperature: 0.2,
      top_p: 1,
      logprobs: true,
      reasoning: { effort: 'max' },
      max_output_tokens: 2000,
      tools,
      prompt_cache_retention: '24h',
      include: ['reasoning.encrypted_content', 'message.output_text.logprobs'],
    };
    const body = prepareOpenAiResponsesRequest(source);
    expect(body).toMatchObject({
      model: 'gpt-6-astra',
      reasoning: { effort: 'max' },
      max_output_tokens: 8192,
      prompt_cache_options: { ttl: '30m' },
      tools,
      include: ['reasoning.encrypted_content'],
    });
    for (const key of ['temperature', 'top_p', 'logprobs', 'prompt_cache_retention'])
      expect(body[key]).toBeUndefined();
    expect(source.temperature).toBe(0.2);
    expect(
      prepareOpenAiResponsesRequest({ model: 'gpt-6-astra', reasoning: { effort: 'none' } })
        .reasoning,
    ).toEqual({ effort: 'low' });
  });
  it('uses adaptive Sonnet thinking with output headroom and text-block parsing', () => {
    const body = prepareAnthropicRequest({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      temperature: 0.2,
      top_p: 0.8,
      top_k: 40,
      thinking: { type: 'enabled', budget_tokens: 2048 },
    });
    expect(body).toMatchObject({
      model: 'claude-sonnet-5',
      max_tokens: 16384,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    });
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.top_k).toBeUndefined();
    expect(
      anthropicResponseText({
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: 'Answer' },
        ],
      }),
    ).toBe('Answer');
  });
  it('preserves forced schema output by disabling incompatible implicit thinking', async () => {
    let sent: Record<string, unknown> = {};
    const client = new AnthropicLlmClient({
      apiKey: 'test-only',
      model: 'claude-sonnet-5',
      fetchImpl: (async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({ content: [{ type: 'tool_use', name: 'submit', input: { ok: true } }] }),
        );
      }) as typeof fetch,
    });
    const result = await client.completeWithSchema({
      system: 'Extract JSON.',
      prompt: 'ok',
      toolName: 'submit',
      toolDescription: 'Result',
      inputSchema: { type: 'object' },
      strict: true,
    });
    expect(sent.thinking).toEqual({ type: 'disabled' });
    expect(sent.tool_choice).toEqual({ type: 'tool', name: 'submit' });
    expect((sent.tools as Array<Record<string, unknown>>)[0]!.strict).toBe(true);
    expect(result.input).toEqual({ ok: true });
  });
  it('sends GPT-6 schema calls through Responses and returns parsed arguments and usage', async () => {
    let sent: Record<string, unknown> = {};
    let endpoint = '';
    const client = new OpenAiLlmClient({
      apiKey: 'test-only',
      model: 'gpt-4.1-mini',
      fetchImpl: (async (url, init) => {
        endpoint = String(url);
        sent = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            status: 'completed',
            model: 'gpt-6-astra',
            output: [
              {
                type: 'function_call',
                call_id: 'call_1',
                name: 'submit',
                arguments: '{"ok":true}',
              },
            ],
            usage: { input_tokens: 12, output_tokens: 24 },
          }),
        );
      }) as typeof fetch,
    });
    const result = await client.completeWithSchema({
      system: 'Extract.',
      prompt: 'ok',
      toolName: 'submit',
      toolDescription: 'Result',
      inputSchema: { type: 'object' },
    });
    expect(endpoint).toBe('https://api.openai.com/v1/responses');
    expect(sent.model).toBe('gpt-6-astra');
    expect(sent.tool_choice).toEqual({ type: 'function', name: 'submit' });
    expect(sent.store).toBe(false);
    expect(result).toEqual({ input: { ok: true }, usage: { inputTokens: 12, outputTokens: 24 } });
  });
  it('preserves function call IDs and outputs across GPT-6 tool rounds', async () => {
    let sent: Record<string, unknown> = {};
    const client = new OpenAiLlmClient({
      apiKey: 'test-only',
      model: 'gpt-6-astra',
      fetchImpl: (async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            status: 'completed',
            output: [
              { type: 'message', content: [{ type: 'output_text', text: 'Verified result.' }] },
            ],
          }),
        );
      }) as typeof fetch,
    });
    const result = await client.completeWithTools({
      system: 'Use evidence.',
      maxTokens: 4000,
      tools: [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object' } }],
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_42', name: 'lookup', input: { id: 7 } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_42', content: '{"found":true}' }],
        },
      ],
    });
    expect(sent.input).toEqual(
      expect.arrayContaining([
        { type: 'function_call', call_id: 'call_42', name: 'lookup', arguments: '{"id":7}' },
        { type: 'function_call_output', call_id: 'call_42', output: '{"found":true}' },
      ]),
    );
    expect(result.content).toEqual([{ type: 'text', text: 'Verified result.' }]);
    expect(result.stopReason).toBe('end_turn');
  });
});
