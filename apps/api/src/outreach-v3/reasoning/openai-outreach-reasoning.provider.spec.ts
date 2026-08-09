import { OpenAiOutreachReasoningProvider } from './openai-outreach-reasoning.provider.js';
import type { ReasoningProviderRequest } from './outreach-reasoning.contract.js';

const ctx = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  role: 'standard_user',
} as never;

function credentialResolver() {
  return {
    resolveProviderForOutreachReasoning: jest.fn(async () => ({
      provider: 'openai',
      apiKey: 'secret',
      model: 'gpt-5.6',
      usedTenantKey: false,
      modelOverridden: false,
    })),
  };
}

function request(overrides: Partial<ReasoningProviderRequest> = {}): ReasoningProviderRequest {
  return {
    ctx,
    provider: 'openai',
    stateMode: 'capiro_managed',
    model: 'gpt-5.6',
    reasoningEffort: 'medium',
    store: false,
    previousResponseId: null,
    instructions: 'rules every turn',
    userMessage: 'Help me set the campaign goal.',
    recentTranscript: [{ role: 'assistant', text: 'Previous visible answer.' }],
    tools: [
      {
        type: 'function',
        name: 'get_client_context',
        description: 'read client',
        strict: true,
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { clientId: { type: 'string' } },
          required: ['clientId'],
        },
      },
    ],
    executeTool: jest.fn(async () => ({ resultId: 'cap_1', output: { ok: true } })),
    ...overrides,
  };
}

function responseJson(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn(async () => body),
  } as unknown as Response;
}

function outputMessage(text: string) {
  return {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  };
}

function finalResponse(id = 'resp_final') {
  const payload = JSON.stringify({
    assistantMessage: 'I can update the goal after you confirm.',
    proposedCommands: [
      {
        type: 'SET_GOAL',
        schemaVersion: 1,
        payload: { value: 'Protect the program' },
      },
    ],
    openQuestions: [],
  });
  return {
    id,
    output: [outputMessage(payload)],
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      output_tokens_details: { reasoning_tokens: 5 },
    },
  };
}

describe('OpenAiOutreachReasoningProvider', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses store=false, requests encrypted reasoning, and sends explicit visible transcript in Capiro-managed mode', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(responseJson(finalResponse()));
    const credentials = credentialResolver();
    const provider = new OpenAiOutreachReasoningProvider(credentials as never);

    await expect(provider.respond(request())).resolves.toMatchObject({
      assistantMessage: 'I can update the goal after you confirm.',
      proposedCommands: [{ type: 'SET_GOAL' }],
      providerResponseRef: 'resp_final',
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body));
    expect(body.store).toBe(false);
    expect(body.include).toEqual(['reasoning.encrypted_content']);
    expect(body.previous_response_id).toBeUndefined();
    expect(body.instructions).toBe('rules every turn');
    expect(body.input).toEqual([
      { role: 'assistant', content: 'Previous visible answer.' },
      { role: 'user', content: 'Help me set the campaign goal.' },
    ]);
    expect(credentials.resolveProviderForOutreachReasoning).toHaveBeenCalledWith(ctx, 'openai');
  });

  it('uses previous_response_id only in provider-state mode and still sends instructions', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(responseJson(finalResponse('resp_next')));
    const provider = new OpenAiOutreachReasoningProvider(credentialResolver() as never);

    await provider.respond(
      request({
        stateMode: 'provider_state',
        store: true,
        previousResponseId: 'resp_prev',
        recentTranscript: [],
      }),
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.store).toBe(true);
    expect(body.include).toBeUndefined();
    expect(body.previous_response_id).toBe('resp_prev');
    expect(body.instructions).toBe('rules every turn');
    expect(body.input).toBe('Help me set the campaign goal.');
  });

  it('replays encrypted reasoning plus function-call output across a store=false tool loop', async () => {
    const encryptedReasoning = {
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'encrypted-reasoning-opaque-value',
      summary: [],
    };
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        responseJson({
          id: 'resp_tools',
          output: [
            encryptedReasoning,
            {
              type: 'function_call',
              name: 'get_client_context',
              call_id: 'call_1',
              arguments: JSON.stringify({
                clientId: '00000000-0000-4000-8000-000000000010',
              }),
            },
          ],
        }),
      )
      .mockResolvedValueOnce(responseJson(finalResponse('resp_after_tool')));
    const executeTool = jest.fn(async () => ({
      resultId: 'cap_result',
      output: { capability: 'get_client_context', data: { bounded: true } },
    }));
    const provider = new OpenAiOutreachReasoningProvider(credentialResolver() as never);

    const result = await provider.respond(request({ executeTool }));

    expect(executeTool).toHaveBeenCalledWith('get_client_context', {
      clientId: '00000000-0000-4000-8000-000000000010',
    });
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(firstBody.include).toEqual(['reasoning.encrypted_content']);
    expect(secondBody.include).toEqual(['reasoning.encrypted_content']);
    expect(secondBody.input).toEqual(
      expect.arrayContaining([
        encryptedReasoning,
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call_1',
        }),
      ]),
    );
    expect(result.referencedToolResults).toEqual([
      { resultId: 'cap_result', capability: 'get_client_context' },
    ]);
  });

  it('fails safely on malformed function arguments without calling a tool', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      responseJson({
        id: 'resp_bad_tool',
        output: [
          {
            type: 'function_call',
            name: 'get_client_context',
            call_id: 'call_bad',
            arguments: '{not-json',
          },
        ],
      }),
    );
    const executeTool = jest.fn();
    const provider = new OpenAiOutreachReasoningProvider(credentialResolver() as never);

    await expect(provider.respond(request({ executeTool }))).rejects.toMatchObject({
      code: 'OUTREACH_REASONING_OUTPUT_INVALID',
      httpStatus: 502,
    });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('turns retryable provider failure into a bounded 503', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(responseJson({}, 429));
    const provider = new OpenAiOutreachReasoningProvider(credentialResolver() as never);

    await expect(provider.respond(request())).rejects.toMatchObject({
      code: 'OUTREACH_REASONING_PROVIDER_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
    });
  });

  it('rejects malformed structured final output instead of fabricating a proposal', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      responseJson({ id: 'resp_invalid', output: [outputMessage('{"assistantMessage":42}')] }),
    );
    const provider = new OpenAiOutreachReasoningProvider(credentialResolver() as never);

    await expect(provider.respond(request())).rejects.toMatchObject({
      code: 'OUTREACH_REASONING_OUTPUT_INVALID',
      httpStatus: 502,
    });
  });
});
