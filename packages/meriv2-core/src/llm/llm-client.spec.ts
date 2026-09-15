import {
  AnthropicLlmClient,
  OpenAiLlmClient,
  extractAnthropicUsage,
  extractOpenAiText,
  extractOpenAiToolArgs,
  extractOpenAiUsage,
  extractToolUseInput,
  fromOpenAiToolLoopResponse,
  modelSupportsManualThinking,
  modelSupportsStrictToolUse,
  schemaCompletionWire,
  strictToolInputSchema,
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

describe('modelSupportsManualThinking (reasoning capability — exact allowlist)', () => {
  it('matches only the qualified Sonnet 4.5 alias and its pinned revision', () => {
    expect(modelSupportsManualThinking('claude-sonnet-4-5')).toBe(true);
    expect(modelSupportsManualThinking('claude-sonnet-4-5-20250929')).toBe(true);
  });

  it('rejects lookalike, prefixed, suffixed and other models — no accidental opt-in', () => {
    expect(modelSupportsManualThinking('claude-sonnet-4-5-x')).toBe(false);
    expect(modelSupportsManualThinking('x-claude-sonnet-4-5')).toBe(false);
    expect(modelSupportsManualThinking('claude-sonnet-4-5-20250929-extra')).toBe(false);
    expect(modelSupportsManualThinking('CLAUDE-SONNET-4-5')).toBe(false); // case-sensitive exact
    expect(modelSupportsManualThinking('claude-sonnet-4-6')).toBe(false);
    expect(modelSupportsManualThinking('claude-opus-4-8')).toBe(false);
    expect(modelSupportsManualThinking('gpt-5')).toBe(false);
    expect(modelSupportsManualThinking('')).toBe(false);
  });
});

describe('schemaCompletionWire (reasoning wire shape — pure)', () => {
  it('returns the forced tool choice when reasoning is absent (default unchanged)', () => {
    expect(
      schemaCompletionWire({
        model: 'claude-sonnet-4-5',
        toolName: 'submit',
        maxTokens: 6000,
        reasoning: undefined,
      }),
    ).toEqual({ tool_choice: { type: 'tool', name: 'submit' } });
  });

  it('returns thinking enabled with budget 1024 + auto tool choice on the approved hearing shape (1024 < 6000)', () => {
    expect(
      schemaCompletionWire({
        model: 'claude-sonnet-4-5-20250929',
        toolName: 'submit_hearing_claims',
        maxTokens: 6000,
        reasoning: { effort: 'low' },
      }),
    ).toEqual({
      thinking: { type: 'enabled', budget_tokens: 1024 },
      tool_choice: { type: 'auto' },
    });
  });

  it('keeps the forced tool choice on an unsupported/lookalike model even when reasoning is requested', () => {
    for (const model of ['claude-sonnet-4-5-x', 'claude-opus-4-8', 'gpt-5']) {
      expect(
        schemaCompletionWire({
          model,
          toolName: 'submit',
          maxTokens: 6000,
          reasoning: { effort: 'low' },
        }),
      ).toEqual({ tool_choice: { type: 'tool', name: 'submit' } });
    }
  });

  it('refuses the thinking shape when the ceiling cannot hold the budget (default 1024 maxTokens vs 1024 budget)', () => {
    // maxTokens omitted → defaults to 1024, which is NOT > budget 1024.
    expect(
      schemaCompletionWire({
        model: 'claude-sonnet-4-5',
        toolName: 'submit',
        maxTokens: undefined,
        reasoning: { effort: 'low' },
      }),
    ).toEqual({ tool_choice: { type: 'tool', name: 'submit' } });
  });

  it('refuses on non-finite / fractional / insufficient ceilings — never emits budget >= max_tokens', () => {
    for (const maxTokens of [
      1024,
      1000,
      1024.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -5,
    ] as number[]) {
      expect(
        schemaCompletionWire({
          model: 'claude-sonnet-4-5',
          toolName: 'submit',
          maxTokens,
          reasoning: { effort: 'low' },
        }),
      ).toEqual({ tool_choice: { type: 'tool', name: 'submit' } });
    }
  });

  it('a higher effort (larger budget) requires proportionally more ceiling', () => {
    // high = 4096 budget: 4096 ceiling is not > 4096 → forced; 6000 > 4096 → thinking.
    expect(
      schemaCompletionWire({
        model: 'claude-sonnet-4-5',
        toolName: 'submit',
        maxTokens: 4096,
        reasoning: { effort: 'high' },
      }),
    ).toEqual({ tool_choice: { type: 'tool', name: 'submit' } });
    expect(
      schemaCompletionWire({
        model: 'claude-sonnet-4-5',
        toolName: 'submit',
        maxTokens: 6000,
        reasoning: { effort: 'high' },
      }),
    ).toEqual({
      thinking: { type: 'enabled', budget_tokens: 4096 },
      tool_choice: { type: 'auto' },
    });
  });
});

describe('AnthropicLlmClient.completeWithSchema — reasoning mode wire (mocked fetch)', () => {
  function client(model: string, fetchImpl: typeof fetch) {
    return new AnthropicLlmClient({ apiKey: 'sk-test', model, fetchImpl });
  }
  const okToolResponse = async () =>
    ({
      ok: true,
      json: async () => ({
        content: [
          { type: 'tool_use', id: 't1', name: 'submit_hearing_claims', input: { claims: [] } },
        ],
        usage: { input_tokens: 500, output_tokens: 1300 },
      }),
    }) as Response;

  it('Sonnet 4.5 + reasoning opt-in sends thinking:1024, tool_choice auto, unchanged model/schema/max_tokens', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return okToolResponse();
    }) as typeof fetch;
    await client('claude-sonnet-4-5', fetchImpl).completeWithSchema({
      system: 'sys',
      prompt: 'p',
      toolName: 'submit_hearing_claims',
      toolDescription: 'd',
      inputSchema: { type: 'object' },
      maxTokens: 6000,
      reasoning: { effort: 'low' },
    });
    expect(body.model).toBe('claude-sonnet-4-5');
    expect(body.max_tokens).toBe(6000);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect((body.tools as Array<{ name: string }>)[0]!.name).toBe('submit_hearing_claims');
  });

  it('unsupported model + reasoning opt-in sends NO thinking field and keeps the forced tool choice', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return okToolResponse();
    }) as typeof fetch;
    await client('claude-opus-4-8', fetchImpl).completeWithSchema({
      system: 'sys',
      prompt: 'p',
      toolName: 'submit_hearing_claims',
      toolDescription: 'd',
      inputSchema: { type: 'object' },
      maxTokens: 6000,
      reasoning: { effort: 'low' },
    });
    expect(body.thinking).toBeUndefined();
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'submit_hearing_claims' });
  });

  it('reasoning absent → byte-identical prior wire (forced tool, no thinking field)', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return okToolResponse();
    }) as typeof fetch;
    await client('claude-sonnet-4-5', fetchImpl).completeWithSchema({
      system: 'sys',
      prompt: 'p',
      toolName: 'submit_hearing_claims',
      toolDescription: 'd',
      inputSchema: { type: 'object' },
      maxTokens: 6000,
    });
    expect(body.thinking).toBeUndefined();
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'submit_hearing_claims' });
    expect(body.max_tokens).toBe(6000);
  });

  it('parses a thinking block followed by the named tool into the same output contract (thinking NOT surfaced)', async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        json: async () => ({
          content: [
            { type: 'thinking', thinking: 'secret chain-of-thought', signature: 'sig' },
            { type: 'text', text: 'draft note' },
            {
              type: 'tool_use',
              id: 't1',
              name: 'submit_hearing_claims',
              input: { claims: [{ id: 'c1' }] },
            },
          ],
          usage: { input_tokens: 500, output_tokens: 1500 },
        }),
      }) as Response) as typeof fetch;
    const out = await client('claude-sonnet-4-5', fetchImpl).completeWithSchema({
      system: 'sys',
      prompt: 'p',
      toolName: 'submit_hearing_claims',
      toolDescription: 'd',
      inputSchema: { type: 'object' },
      maxTokens: 6000,
      reasoning: { effort: 'low' },
    });
    // Only the tool input + aggregate usage are returned — the thinking/text
    // blocks are never parsed into the result or exposed.
    expect(out.input).toEqual({ claims: [{ id: 'c1' }] });
    expect(out.usage).toEqual({ inputTokens: 500, outputTokens: 1500 });
    expect(JSON.stringify(out)).not.toContain('secret chain-of-thought');
  });

  it('a text-only response (no final tool) still throws — no automatic second request', async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        json: async () => ({ content: [{ type: 'thinking', thinking: 'x' }] }),
      }) as Response) as typeof fetch;
    await expect(
      client('claude-sonnet-4-5', fetchImpl).completeWithSchema({
        system: 'sys',
        prompt: 'p',
        toolName: 'submit_hearing_claims',
        toolDescription: 'd',
        inputSchema: { type: 'object' },
        maxTokens: 6000,
        reasoning: { effort: 'low' },
      }),
    ).rejects.toThrow('did not return a "submit_hearing_claims" tool_use block');
  });
});

describe('OpenAiLlmClient.completeWithSchema — reasoning option is a no-op', () => {
  it('sends no thinking field and keeps the forced function choice when reasoning is passed', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({
          choices: [
            { message: { tool_calls: [{ function: { name: 'submit', arguments: '{}' } }] } },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      } as Response;
    }) as typeof fetch;
    await new OpenAiLlmClient({ apiKey: 'sk-test', model: 'gpt-5', fetchImpl }).completeWithSchema({
      system: 'sys',
      prompt: 'p',
      toolName: 'submit',
      toolDescription: 'd',
      inputSchema: { type: 'object' },
      reasoning: { effort: 'low' },
    });
    expect(body.thinking).toBeUndefined();
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'submit' } });
    expect(body.model).toBe('gpt-5');
  });

  it('strict opt-in is a no-op on OpenAI: original schema + keywords, no strict field, same model', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return {
        ok: true,
        json: async () => ({
          choices: [
            { message: { tool_calls: [{ function: { name: 'submit', arguments: '{}' } }] } },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      } as Response;
    }) as typeof fetch;
    const inputSchema = {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1, maxLength: 100 } },
    };
    await new OpenAiLlmClient({ apiKey: 'sk-test', model: 'gpt-5', fetchImpl }).completeWithSchema({
      system: 'sys',
      prompt: 'p',
      toolName: 'submit',
      toolDescription: 'd',
      inputSchema,
      strict: true,
    });
    const tool = (body.tools as Array<Record<string, unknown>>)[0]!;
    expect(tool.strict).toBeUndefined();
    expect((tool.function as Record<string, unknown>).strict).toBeUndefined();
    expect((tool.function as { parameters: unknown }).parameters).toEqual(inputSchema);
    expect(body.model).toBe('gpt-5');
  });
});

describe('modelSupportsStrictToolUse (H57 anchored allowlist)', () => {
  it('matches only the qualified Sonnet 4.5 alias and pinned revision', () => {
    expect(modelSupportsStrictToolUse('claude-sonnet-4-5')).toBe(true);
    expect(modelSupportsStrictToolUse('claude-sonnet-4-5-20250929')).toBe(true);
  });
  it('rejects lookalikes and every other model', () => {
    expect(modelSupportsStrictToolUse('claude-sonnet-4-5-x')).toBe(false);
    expect(modelSupportsStrictToolUse('claude-sonnet-4-6')).toBe(false);
    expect(modelSupportsStrictToolUse('claude-opus-4-8')).toBe(false);
    expect(modelSupportsStrictToolUse('gpt-5')).toBe(false);
    expect(modelSupportsStrictToolUse('')).toBe(false);
  });
});

describe('strictToolInputSchema (H57 non-mutating projection)', () => {
  it('removes minLength/maxLength/maxItems recursively, preserves everything else and never mutates the original', () => {
    const original = {
      type: 'object',
      additionalProperties: false,
      required: ['claims'],
      properties: {
        claims: {
          type: 'array',
          minItems: 1,
          maxItems: 40,
          items: {
            anyOf: [
              {
                type: 'object',
                required: ['id', 'text'],
                properties: {
                  id: { type: 'string', minLength: 1, maxLength: 100, description: 'id' },
                  text: { type: 'string', minLength: 1, maxLength: 2500 },
                },
              },
              {
                type: 'object',
                required: ['id'],
                properties: {
                  id: { type: 'string', minLength: 1, maxLength: 100 },
                  evidenceIds: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 1,
                    items: { type: 'string', enum: ['full-uuid-1', 'full-uuid-2'] },
                  },
                },
              },
            ],
          },
        },
      },
    };
    const snapshot = JSON.parse(JSON.stringify(original));
    const projected = strictToolInputSchema(original);
    // Original object untouched.
    expect(original).toEqual(snapshot);
    // Projection drops exactly the three unsupported keywords at every depth.
    const text = JSON.stringify(projected);
    expect(text).not.toContain('"minLength"');
    expect(text).not.toContain('"maxLength"');
    expect(text).not.toContain('"maxItems"');
    // Supported subset preserved byte-for-byte.
    expect(projected).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['claims'],
      properties: {
        claims: {
          type: 'array',
          minItems: 1,
          items: {
            anyOf: [
              {
                type: 'object',
                required: ['id', 'text'],
                properties: {
                  id: { type: 'string', description: 'id' },
                  text: { type: 'string' },
                },
              },
              {
                type: 'object',
                required: ['id'],
                properties: {
                  id: { type: 'string' },
                  evidenceIds: {
                    type: 'array',
                    minItems: 1,
                    items: { type: 'string', enum: ['full-uuid-1', 'full-uuid-2'] },
                  },
                },
              },
            ],
          },
        },
      },
    });
    // Property/required ordering is kept.
    expect(Object.keys((projected as any).properties.claims.items.anyOf[0].properties)).toEqual([
      'id',
      'text',
    ]);
  });

  it('passes through primitives and arrays unchanged', () => {
    expect(strictToolInputSchema('x')).toBe('x');
    expect(strictToolInputSchema(5)).toBe(5);
    expect(strictToolInputSchema(null)).toBe(null);
    expect(strictToolInputSchema([{ maxItems: 2, a: 1 }])).toEqual([{ a: 1 }]);
  });
});

describe('AnthropicLlmClient.completeWithSchema — strict wire (H57 mocked fetch)', () => {
  const okToolResponse = async () =>
    ({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', id: 't1', name: 'submit', input: { claims: [] } }],
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    }) as Response;

  it('qualified model + strict:true emits strict:true and a projected schema; reasoning absent keeps forced tool choice byte-for-byte otherwise', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return okToolResponse();
    }) as typeof fetch;
    const inputSchema = {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1, maxLength: 100 } },
    };
    await new AnthropicLlmClient({
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-5',
      fetchImpl,
    }).completeWithSchema({
      system: 'sys',
      prompt: 'p',
      toolName: 'submit',
      toolDescription: 'd',
      inputSchema,
      maxTokens: 6000,
      strict: true,
    });
    const tool = (body.tools as Array<Record<string, unknown>>)[0]!;
    expect(tool.strict).toBe(true);
    expect(tool.input_schema).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
    });
    // No reasoning opt-in → the prior forced tool choice is unchanged.
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'submit' });
    expect(body.thinking).toBeUndefined();
    expect(body.max_tokens).toBe(6000);
  });

  it('strict absent on a qualified model keeps the previous wire byte-for-byte (no strict field, original schema)', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return okToolResponse();
    }) as typeof fetch;
    const inputSchema = {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1, maxLength: 100 } },
    };
    await new AnthropicLlmClient({
      apiKey: 'sk-test',
      model: 'claude-sonnet-4-5',
      fetchImpl,
    }).completeWithSchema({
      system: 'sys',
      prompt: 'p',
      toolName: 'submit',
      toolDescription: 'd',
      inputSchema,
      maxTokens: 6000,
    });
    const tool = (body.tools as Array<Record<string, unknown>>)[0]!;
    expect(tool.strict).toBeUndefined();
    expect(tool.input_schema).toEqual(inputSchema);
  });

  it('unsupported model + strict:true keeps the previous wire (no strict, original schema/model)', async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return okToolResponse();
    }) as typeof fetch;
    const inputSchema = {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1, maxLength: 100 } },
    };
    await new AnthropicLlmClient({
      apiKey: 'sk-test',
      model: 'claude-opus-4-8',
      fetchImpl,
    }).completeWithSchema({
      system: 'sys',
      prompt: 'p',
      toolName: 'submit',
      toolDescription: 'd',
      inputSchema,
      maxTokens: 6000,
      strict: true,
    });
    const tool = (body.tools as Array<Record<string, unknown>>)[0]!;
    expect(tool.strict).toBeUndefined();
    expect(tool.input_schema).toEqual(inputSchema);
    expect(body.model).toBe('claude-opus-4-8');
  });
});
