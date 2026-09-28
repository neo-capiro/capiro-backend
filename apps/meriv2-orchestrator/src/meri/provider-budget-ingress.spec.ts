import { RequestScopedLlmClient } from './request-scoped-llm.client.js';
import { MeriRunBudget } from './meriv3/meriv3-run-budget.js';
import { OpenAiResponsesClient } from './meriv3/openai-responses.client.js';
import { resolveMeriV3ReasoningProfile } from './meriv3/meriv3-reasoning.js';

const LIMITS = {
  maxModelCalls: 8,
  maxToolCalls: 8,
  maxRetryCalls: 4,
  synthesisModelCallReserve: 1,
  noProgressLaps: 3,
  maxCyclePeriod: 4,
};

function budget(reserve: jest.Mock, settle: jest.Mock, signal?: AbortSignal) {
  return new MeriRunBudget(LIMITS, signal ? { signal } : {}, { reserve, settle });
}

describe('durable provider accounting at production ingress wrappers', () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
  });

  test('RequestScopedLlmClient schema dispatch reserves durably and settles measured usage once', async () => {
    const reserve = jest.fn(async () => ({
      reservationId: 'schema-reservation',
      dispatchAllowed: true,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const settle = jest.fn(async () => undefined);
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            {
              type: 'tool_use',
              name: 'submit_claim_revision',
              input: { replacementText: 'corrected', citedEvidenceIds: [] },
            },
          ],
          usage: { input_tokens: 17, output_tokens: 9 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = new RequestScopedLlmClient('not-a-real-credential', 'claude-sonnet-5');
    const result = await client
      .withProviderBudget(budget(reserve, settle), 'repair', 'claim-revision-test')
      .completeWithSchema({
        system: 'system',
        prompt: 'prompt',
        toolName: 'submit_claim_revision',
        toolDescription: 'submit',
        inputSchema: { type: 'object' },
        maxTokens: 64,
      });

    expect(result.usage).toEqual({ inputTokens: 17, outputTokens: 9 });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        logicalOperationId: expect.stringMatching(/^claim-revision-test:/),
        retryOfAttemptId: null,
        kind: 'anthropic_messages',
        phase: 'repair',
      }),
    );
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(expect.anything(), {
      kind: 'known',
      inputTokens: 17,
      outputTokens: 9,
    });
  });

  test('OpenAI 408 is ambiguous and its controlled retry links to the same logical operation', async () => {
    process.env.OPENAI_API_KEY = 'not-a-real-credential';
    let reservationSequence = 0;
    const reserve = jest.fn(async () => ({
      reservationId: `reservation-${reservationSequence++}`,
      dispatchAllowed: true,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const settle = jest.fn(async () => undefined);
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"request timeout"}}', { status: 408 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'response-id',
            status: 'completed',
            model: 'gpt-4.1',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
            usage: { input_tokens: 4, output_tokens: 2 },
          }),
          { status: 200 },
        ),
      );

    const result = await new OpenAiResponsesClient().complete({
      profile: { ...resolveMeriV3ReasoningProfile('fast'), model: 'gpt-4.1' },
      instructions: 'test',
      input: [{ role: 'user', content: 'hi' }],
      tools: [],
      budget: budget(reserve, settle),
    });

    expect(result.outputText).toBe('ok');
    expect((settle.mock.calls as unknown[][]).map(([, outcome]) => outcome)).toEqual([
      { kind: 'uncertain' },
      { kind: 'known', inputTokens: 4, outputTokens: 2 },
    ]);
    const [first, second] = (reserve.mock.calls as unknown[][]).map(
      ([binding]) => binding as Record<string, unknown>,
    );
    expect(second).toMatchObject({
      logicalOperationId: first!.logicalOperationId,
      retryOfAttemptId: first!.attemptId,
    });
  });

  test('Stop aborts a RequestScopedLlmClient provider dispatch and retains an uncertain charge', async () => {
    const abort = new AbortController();
    const reserve = jest.fn(async () => ({
      reservationId: 'stop-reservation',
      dispatchAllowed: true,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const settle = jest.fn(async () => undefined);
    jest.spyOn(global, 'fetch').mockImplementation(
      async (_request, init) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(init.signal.reason ?? new DOMException('Stopped', 'AbortError'));
            return;
          }
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Stopped', 'AbortError')),
            { once: true },
          );
        }),
    );
    const client = new RequestScopedLlmClient('not-a-real-credential', 'claude-sonnet-5');
    const pending = client
      .withProviderBudget(budget(reserve, settle, abort.signal), 'repair', 'stop-test')
      .completeWithSchema({
        system: 'system',
        prompt: 'prompt',
        toolName: 'submit',
        toolDescription: 'submit',
        inputSchema: { type: 'object' },
        maxTokens: 32,
      });
    abort.abort(new DOMException('Stopped', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(settle).toHaveBeenCalledWith(expect.anything(), { kind: 'uncertain' });
  });
});
