import {
  MeriRunBudget,
  MeriRunBudgetExhaustedError,
  isLegitimatePollingObservation,
} from './meriv3-run-budget.js';

const scope = {
  actorId: 'actor-a',
  tenantId: 'tenant-a',
  clientId: 'client-a',
  conversationId: 'conversation-a',
  runId: 'run-a',
};

function budget(overrides: Partial<ConstructorParameters<typeof MeriRunBudget>[0]> = {}) {
  return new MeriRunBudget({
    maxModelCalls: 8,
    maxToolCalls: 20,
    maxRetryCalls: 20,
    synthesisModelCallReserve: 2,
    noProgressLaps: 3,
    maxCyclePeriod: 4,
    ...overrides,
  });
}

function fail(
  controller: MeriRunBudget,
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
  repeatable = false,
) {
  const signature = controller.toolSignature(scope, tool, args);
  expect(controller.reserveToolBatch(1)).toBe(true);
  expect(controller.beginTool(signature)).toBe(true);
  controller.observeToolResult({ signature, result, failed: true, repeatable });
}

function exhaustAcquisition(
  controller: MeriRunBudget,
  reason: 'model_calls' | 'tool_calls' | 'no_progress',
) {
  if (reason === 'model_calls') {
    controller.reserveModelAttempt('acquisition');
    expect(() => controller.reserveModelAttempt('acquisition')).toThrow(
      MeriRunBudgetExhaustedError,
    );
    return;
  }
  if (reason === 'tool_calls') {
    expect(controller.reserveToolBatch(1)).toBe(false);
    return;
  }
  const signature = controller.toolSignature(scope, 'read_alpha', { query: 'same' });
  expect(controller.reserveToolBatch(1)).toBe(true);
  expect(controller.beginTool(signature)).toBe(true);
  controller.observeToolResult({ signature, result: { error: 'unchanged' }, failed: true });
}

describe('MeriRunBudget', () => {
  test('bounds an unchanged alternating A/B failure cycle across rounds', () => {
    const controller = budget();
    for (let lap = 0; lap < 3; lap += 1) {
      fail(controller, 'read_alpha', { query: 'same' }, { error: 'unchanged-a' });
      fail(controller, 'read_beta', { query: 'same' }, { error: 'unchanged-b' });
    }
    expect(controller.snapshot()).toMatchObject({
      acquisitionStopped: true,
      stopReason: 'no_progress',
      toolCalls: 6,
    });
    expect(controller.reserveToolBatch(1)).toBe(false);
  });

  test('a changed artifact revision is a new bounded experiment', () => {
    const controller = budget();
    for (let lap = 0; lap < 2; lap += 1) {
      fail(controller, 'read_alpha', { artifactRevision: 'rev-1' }, { error: 'a' });
      fail(controller, 'read_beta', { artifactRevision: 'rev-1' }, { error: 'b' });
    }
    const oldSignature = controller.toolSignature(scope, 'read_alpha', {
      artifactRevision: 'rev-1',
    });
    const newSignature = controller.toolSignature(scope, 'read_alpha', {
      artifactRevision: 'rev-2',
    });
    expect(newSignature).not.toBe(oldSignature);
    fail(controller, 'read_alpha', { artifactRevision: 'rev-2' }, { error: 'a' });
    expect(controller.acquisitionStopped).toBe(false);
  });

  test('changed pagination routes and explicit pending polling do not false-block', () => {
    const controller = budget({ maxToolCalls: 30 });
    for (const cursor of ['page:0', 'page:10', 'page:20', 'page:30']) {
      const args = { cursor };
      const signature = controller.toolSignature(scope, 'read_pages', args);
      expect(controller.reserveToolBatch(1)).toBe(true);
      expect(controller.beginTool(signature)).toBe(true);
      controller.observeToolResult({ signature, result: { rows: [cursor] }, failed: false });
    }
    const pollArgs = { jobId: 'job-a', pollToken: 'poll-a' };
    const pending = { status: 'running', pollToken: 'poll-a', nextPollAfterMs: 500 };
    expect(isLegitimatePollingObservation(pollArgs, pending)).toBe(true);
    for (let index = 0; index < 8; index += 1) {
      fail(controller, 'read_job', pollArgs, pending, true);
    }
    expect(controller.acquisitionStopped).toBe(false);
    expect(controller.snapshot().toolCalls).toBe(12);
  });

  test('rejects a parallel/provider batch atomically when it would oversubscribe', () => {
    const controller = budget({ maxToolCalls: 3 });
    expect(controller.reserveToolBatch(2)).toBe(true);
    expect(controller.reserveToolBatch(2)).toBe(false);
    expect(controller.snapshot()).toMatchObject({
      toolCalls: 2,
      acquisitionStopped: true,
      stopReason: 'tool_calls',
    });
  });

  test('Stop closes acquisition and permits no later tool admission', () => {
    const abort = new AbortController();
    const controller = new MeriRunBudget(
      {
        maxModelCalls: 6,
        maxToolCalls: 6,
        maxRetryCalls: 3,
        synthesisModelCallReserve: 2,
        noProgressLaps: 3,
        maxCyclePeriod: 4,
      },
      { signal: abort.signal },
    );
    abort.abort(new DOMException('Stopped', 'AbortError'));
    expect(controller.reserveToolBatch(1)).toBe(false);
    expect(controller.snapshot().stopReason).toBe('cancelled');
    expect(() => controller.reserveModelAttempt('acquisition')).toThrow(
      MeriRunBudgetExhaustedError,
    );
  });

  test.each([
    ['model_calls', 'cancelled'],
    ['tool_calls', 'cancelled'],
    ['no_progress', 'cancelled'],
    ['model_calls', 'deadline'],
    ['tool_calls', 'deadline'],
    ['no_progress', 'deadline'],
  ] as const)(
    '%s exhaustion cannot mask a later %s control boundary',
    (acquisitionReason, terminalReason) => {
      const abort = new AbortController();
      const control = { signal: abort.signal, deadlineAt: Date.now() + 60_000 };
      const controller = new MeriRunBudget(
        {
          maxModelCalls: 3,
          maxToolCalls: acquisitionReason === 'tool_calls' ? 0 : 3,
          maxRetryCalls: 3,
          synthesisModelCallReserve: 2,
          noProgressLaps: acquisitionReason === 'no_progress' ? 1 : 3,
          maxCyclePeriod: 1,
        },
        control,
      );

      exhaustAcquisition(controller, acquisitionReason);
      expect(controller.snapshot().stopReason).toBe(acquisitionReason);
      const modelCallsAtBoundary = controller.snapshot().modelCalls;

      if (terminalReason === 'cancelled') abort.abort(new DOMException('Stopped', 'AbortError'));
      else control.deadlineAt = Date.now() - 1;

      expect(controller.snapshot().stopReason).toBe(terminalReason);
      expect(controller.reserveToolBatch(1)).toBe(false);
      expect(controller.beginTool('after-terminal-control')).toBe(false);
      for (const phase of ['synthesis', 'finalization', 'repair'] as const) {
        try {
          controller.reserveModelAttempt(phase);
          throw new Error(`${phase} was admitted after ${terminalReason}`);
        } catch (error) {
          expect(error).toBeInstanceOf(MeriRunBudgetExhaustedError);
          expect((error as MeriRunBudgetExhaustedError).reason).toBe(terminalReason);
        }
      }
      expect(controller.snapshot().modelCalls).toBe(modelCallsAtBoundary);
    },
  );

  test('shares retry calls while retaining dedicated synthesis attempts', () => {
    const controller = budget({ maxModelCalls: 5, synthesisModelCallReserve: 2, maxRetryCalls: 1 });
    controller.reserveModelAttempt('acquisition');
    controller.reserveModelAttempt('acquisition', true);
    expect(() => controller.reserveModelAttempt('acquisition', true)).toThrow(
      MeriRunBudgetExhaustedError,
    );
    expect(controller.snapshot().stopReason).toBe('retry_calls');
    controller.reserveModelAttempt('synthesis');
    expect(controller.snapshot().modelCalls).toBe(3);
  });

  test('reserves at the actual JEV fetch boundary and accounts a 429 retry separately', async () => {
    const reserve = jest
      .fn()
      .mockResolvedValueOnce({
        reservationId: 'r1',
        dispatchAllowed: true,
        deadlineAt: '2099-01-01T00:00:00.000Z',
      })
      .mockResolvedValueOnce({
        reservationId: 'r2',
        dispatchAllowed: true,
        deadlineAt: '2099-01-01T00:00:00.000Z',
      });
    const settle = jest.fn(async () => undefined);
    const controller = new MeriRunBudget(
      {
        maxModelCalls: 8,
        maxToolCalls: 8,
        maxRetryCalls: 4,
        synthesisModelCallReserve: 2,
        noProgressLaps: 3,
        maxCyclePeriod: 4,
      },
      {},
      { reserve, settle },
    );
    const providerFetch = jest
      .fn()
      .mockResolvedValueOnce(new Response('{"error":"rate_limited"}', { status: 429 }))
      .mockResolvedValueOnce(
        new Response('{"usage":{"input_tokens":12,"output_tokens":7}}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const bounded = controller.budgetedFetch('selection', providerFetch as typeof fetch);
    await bounded('https://jev.test/evaluate', {
      method: 'POST',
      body: JSON.stringify({ model: 'jev-1.13.0', claim: 'bounded' }),
    });
    await bounded('https://jev.test/evaluate', {
      method: 'POST',
      body: JSON.stringify({ model: 'jev-1.13.0', claim: 'bounded' }),
    });

    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ kind: 'jev', maxOutputTokens: 8_000 }),
    );
    expect((settle.mock.calls as unknown[][]).map((call) => call[1])).toEqual([
      { kind: 'uncertain' },
      { kind: 'known', inputTokens: 12, outputTokens: 7 },
    ]);
    const bindings = reserve.mock.calls.map(([value]) => value);
    expect(bindings[0]).toMatchObject({ retryOfAttemptId: null, maxOutputTokens: 8_000 });
    expect(bindings[1]).toMatchObject({
      logicalOperationId: bindings[0]!.logicalOperationId,
      retryOfAttemptId: bindings[0]!.attemptId,
    });
  });

  test('retains a conservative uncertain reservation after a lost provider response', async () => {
    const settle = jest.fn(async () => undefined);
    const controller = new MeriRunBudget(
      {
        maxModelCalls: 4,
        maxToolCalls: 4,
        maxRetryCalls: 2,
        synthesisModelCallReserve: 1,
        noProgressLaps: 3,
        maxCyclePeriod: 4,
      },
      {},
      {
        reserve: jest.fn(async () => ({
          reservationId: 'lost',
          dispatchAllowed: true,
          deadlineAt: '2099-01-01T00:00:00.000Z',
        })),
        settle,
      },
    );
    const bounded = controller.budgetedFetch(
      'selection',
      jest.fn(async () => {
        throw new Error('socket closed after dispatch');
      }) as unknown as typeof fetch,
    );
    await expect(
      bounded('https://jev.test/evaluate', { method: 'POST', body: '{"model":"jev"}' }),
    ).rejects.toThrow('socket closed after dispatch');
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ reservationId: 'lost' }), {
      kind: 'uncertain',
    });
  });

  test('bounds the actual fetch by the durable deadline and releases no late response', async () => {
    const settle = jest.fn(async () => undefined);
    const fetchImpl = jest.fn(
      async () =>
        new Promise<Response>((resolve) =>
          setTimeout(
            () =>
              resolve(
                new Response('{"usage":{"input_tokens":4,"output_tokens":2}}', { status: 200 }),
              ),
            100,
          ),
        ),
    ) as unknown as typeof fetch;
    const controller = new MeriRunBudget(
      {
        maxModelCalls: 4,
        maxToolCalls: 4,
        maxRetryCalls: 2,
        synthesisModelCallReserve: 1,
        noProgressLaps: 3,
        maxCyclePeriod: 4,
      },
      {},
      {
        reserve: jest.fn(async () => ({
          reservationId: 'deadline',
          dispatchAllowed: true,
          deadlineAt: new Date(Date.now() + 20).toISOString(),
        })),
        settle,
      },
    );
    const before = Date.now();
    await expect(
      controller.budgetedFetch('repair', fetchImpl)('https://jev.test/evaluate', {
        method: 'POST',
        body: '{"model":"jev-1.13.0"}',
      }),
    ).rejects.toBeDefined();
    expect(Date.now() - before).toBeLessThan(80);
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ reservationId: 'deadline' }), {
      kind: 'uncertain',
    });
  });
});
