import {
  AnthropicLlmClient,
  OpenAiLlmClient,
  extractAnthropicUsage,
  extractOpenAiText,
  extractOpenAiToolArgs,
  extractOpenAiUsage,
  extractToolUseInput,
  fromOpenAiToolLoopResponse,
  toOpenAiToolLoopBody,
} from './llm-client';

describe('tool-loop translation (4.5.1 — Anthropic wire ⇄ Chat Completions)', () => {
  const tools = [{ name: 'search_bills', description: 'd', input_schema: { type: 'object' } }];

  it('translates a full loop history: system, text, tool_use → tool_calls, tool_result → role:tool', () => {
    const body = toOpenAiToolLoopBody({
      model: 'gpt-test',
      system: 'sys',
      maxTokens: 256,
      tools,
      messages: [
        { role: 'user', content: 'find bills' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'on it' },
            { type: 'tool_use', id: 'call_1', name: 'search_bills', input: { q: 'ndaa' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"rows":[]}' }],
        },
      ],
    });
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'find bills' },
      {
        role: 'assistant',
        content: 'on it',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'search_bills', arguments: '{"q":"ndaa"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"rows":[]}' },
    ]);
    expect((body.tools as Array<{ function: { name: string } }>)[0]!.function.name).toBe(
      'search_bills',
    );
    expect(body.tool_choice).toBeUndefined(); // default = auto
  });

  it("toolChoice 'none' forces a text-only synthesis turn; tool-less assistant keeps null content rule", () => {
    const body = toOpenAiToolLoopBody({
      model: 'gpt-test',
      system: 's',
      maxTokens: 10,
      tools,
      toolChoice: 'none',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'c1', name: 'search_bills', input: {} }],
        },
      ],
    });
    expect(body.tool_choice).toBe('none');
    // Assistant message with tool_calls and no text carries content: null.
    expect((body.messages as Array<Record<string, unknown>>)[1]).toMatchObject({
      role: 'assistant',
      content: null,
    });
  });

  it('toolChoice {type:"tool",name} forces that function via tool_choice:{type:"function",function:{name}}', () => {
    const body = toOpenAiToolLoopBody({
      model: 'gpt-test',
      system: 's',
      maxTokens: 10,
      tools,
      toolChoice: { type: 'tool', name: 'search_bills' },
      messages: [{ role: 'user', content: 'go' }],
    });
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'search_bills' } });
  });

  it('translates the response back: tool_calls → tool_use blocks, finish_reason mapped', () => {
    const r = fromOpenAiToolLoopResponse({
      choices: [
        {
          message: {
            content: 'checking',
            tool_calls: [
              {
                id: 'call_9',
                type: 'function',
                function: { name: 'search_bills', arguments: '{"q":"ndaa"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    expect(r.stopReason).toBe('tool_use');
    expect(r.content).toEqual([
      { type: 'text', text: 'checking' },
      { type: 'tool_use', id: 'call_9', name: 'search_bills', input: { q: 'ndaa' } },
    ]);
  });

  it("maps 'stop'→'end_turn', 'length'→'max_tokens'; malformed tool args degrade to {}", () => {
    expect(
      fromOpenAiToolLoopResponse({
        choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
      }).stopReason,
    ).toBe('end_turn');
    expect(
      fromOpenAiToolLoopResponse({
        choices: [{ message: { content: 'x' }, finish_reason: 'length' }],
      }).stopReason,
    ).toBe('max_tokens');
    const r = fromOpenAiToolLoopResponse({
      choices: [
        {
          message: {
            tool_calls: [{ id: 'c', function: { name: 'search_bills', arguments: '{oops' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    expect(r.content).toEqual([{ type: 'tool_use', id: 'c', name: 'search_bills', input: {} }]);
  });
});

describe('OpenAiLlmClient (Phase 4 LLM-gateway convergence)', () => {
  const client = (fetchImpl: typeof fetch) =>
    new OpenAiLlmClient({ apiKey: 'k', model: 'gpt-test', fetchImpl });

  it('completeWithSchema forces the named function and returns parsed args + usage', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                tool_calls: [
                  { function: { name: 'emit_brief', arguments: '{"headline":"Grounded"}' } },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 80, completion_tokens: 30 },
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
    expect(capturedBody.tool_choice).toEqual({
      type: 'function',
      function: { name: 'emit_brief' },
    });
  });

  it('completeJson requests JSON mode and parses the object', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }),
      } as Response;
    }) as typeof fetch;

    const out = await client(fetchImpl).completeJson({ system: 'sys', prompt: 'p' });
    expect(out).toEqual({ ok: true });
    expect(capturedBody.response_format).toEqual({ type: 'json_object' });
  });

  it('throws on a non-2xx response', async () => {
    const fetchImpl = (async () =>
      ({
        ok: false,
        json: async () => ({ error: { message: 'bad key' } }),
      }) as Response) as typeof fetch;
    await expect(client(fetchImpl).completeJson({ system: 's', prompt: 'p' })).rejects.toThrow(
      'bad key',
    );
  });
});

describe('OpenAI response extractors', () => {
  it('extractOpenAiText reads choices[0].message.content', () => {
    expect(extractOpenAiText({ choices: [{ message: { content: 'hi' } }] })).toBe('hi');
    expect(extractOpenAiText({})).toBe('');
  });
  it('extractOpenAiToolArgs parses the named function call arguments', () => {
    const raw = {
      choices: [{ message: { tool_calls: [{ function: { name: 'f', arguments: '{"a":1}' } }] } }],
    };
    expect(extractOpenAiToolArgs(raw, 'f')).toEqual({ a: 1 });
    expect(extractOpenAiToolArgs(raw, 'other')).toBeUndefined();
    expect(extractOpenAiToolArgs({}, 'f')).toBeUndefined();
  });
  it('extractOpenAiUsage maps prompt/completion tokens', () => {
    expect(extractOpenAiUsage({ usage: { prompt_tokens: 12, completion_tokens: 3 } })).toEqual({
      inputTokens: 12,
      outputTokens: 3,
    });
    expect(extractOpenAiUsage({})).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

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
