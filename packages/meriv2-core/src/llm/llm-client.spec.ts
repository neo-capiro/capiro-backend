import { AnthropicLlmClient, extractAnthropicUsage, extractToolUseInput } from './llm-client';

describe('extractToolUseInput (Phase 1 M5.0)', () => {
  it("returns the named tool_use block's input", () => {
    const raw = {
      content: [
        { type: 'text', text: 'thinking...' },
        { type: 'tool_use', id: 't1', name: 'emit_brief', input: { headline: 'x' } },
      ],
    };
    expect(extractToolUseInput(raw, 'emit_brief')).toEqual({ headline: 'x' });
  });

  it('returns undefined when no tool_use block matches the requested name', () => {
    const raw = { content: [{ type: 'tool_use', id: 't1', name: 'other_tool', input: {} }] };
    expect(extractToolUseInput(raw, 'emit_brief')).toBeUndefined();
  });

  it('returns undefined for a malformed/absent content array', () => {
    expect(extractToolUseInput({}, 'emit_brief')).toBeUndefined();
    expect(extractToolUseInput({ content: 'not an array' }, 'emit_brief')).toBeUndefined();
  });
});

describe('extractAnthropicUsage (Phase 1 M5.0)', () => {
  it('extracts input/output token counts', () => {
    expect(extractAnthropicUsage({ usage: { input_tokens: 120, output_tokens: 45 } })).toEqual({
      inputTokens: 120,
      outputTokens: 45,
    });
  });

  it('returns zeros for a malformed/absent usage object', () => {
    expect(extractAnthropicUsage({})).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(extractAnthropicUsage({ usage: 'nope' })).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('AnthropicLlmClient.completeWithSchema (Phase 1 M5.0)', () => {
  function client(fetchImpl: typeof fetch) {
    return new AnthropicLlmClient({ apiKey: 'k', model: 'claude-test', fetchImpl });
  }

  it('PINNED: forces the named tool via tool_choice and returns its input + usage', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({
          content: [
            { type: 'tool_use', id: 't1', name: 'emit_brief', input: { headline: 'Grounded' } },
          ],
          usage: { input_tokens: 80, output_tokens: 30 },
        }),
      } as Response;
    }) as typeof fetch;

    const out = await client(fetchImpl).completeWithSchema({
      system: 'sys',
      prompt: 'prompt',
      toolName: 'emit_brief',
      toolDescription: 'Emit the grounded brief',
      inputSchema: { type: 'object', properties: { headline: { type: 'string' } } },
    });

    expect(out.input).toEqual({ headline: 'Grounded' });
    expect(out.usage).toEqual({ inputTokens: 80, outputTokens: 30 });
    expect(capturedBody.tool_choice).toEqual({ type: 'tool', name: 'emit_brief' });
    expect(capturedBody.tools).toEqual([
      {
        name: 'emit_brief',
        description: 'Emit the grounded brief',
        input_schema: { type: 'object', properties: { headline: { type: 'string' } } },
      },
    ]);
  });

  it('throws when the response has no matching tool_use block', async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: 'no tool call' }] }),
      }) as Response) as typeof fetch;

    await expect(
      client(fetchImpl).completeWithSchema({
        system: 'sys',
        prompt: 'prompt',
        toolName: 'emit_brief',
        toolDescription: 'desc',
        inputSchema: {},
      }),
    ).rejects.toThrow('did not return a "emit_brief" tool_use block');
  });

  it('throws on a non-2xx response', async () => {
    const fetchImpl = (async () =>
      ({
        ok: false,
        json: async () => ({ error: { message: 'rate limited' } }),
      }) as Response) as typeof fetch;

    await expect(
      client(fetchImpl).completeWithSchema({
        system: 'sys',
        prompt: 'prompt',
        toolName: 'emit_brief',
        toolDescription: 'desc',
        inputSchema: {},
      }),
    ).rejects.toThrow('rate limited');
  });
});
