import { InEditorAssistantService, EDITOR_TOTAL_BUDGET_MS } from './in-editor-assistant.service.js';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { MAX_EDITOR_INPUT_CHARS } from './in-editor-prompt.js';
import { withGovernedEditorContext } from './in-editor-context.js';

const ctx = { tenantId: 'tenant', userId: 'user' } as never;
const dto = {
  messages: [{ role: 'user', text: 'Correct this section using its linked source.' }],
  document: { sections: [{ name: 'Summary', content: 'Draft' }] },
};
const proposed = {
  content: [
    {
      type: 'tool_use',
      id: 'edit',
      name: 'propose_document_edits',
      input: {
        reply: 'Corrected.',
        edits: [
          {
            op: 'replace_section',
            section: 'Summary',
            content: '<p>Source-supported correction.</p>',
          },
        ],
      },
    },
  ],
  stopReason: 'tool_use',
};

function harness(verifierEnabled = false) {
  const completeWithTools = jest.fn();
  const invoke = jest.fn(async (..._args: unknown[]) => ({ results: [] }));
  const service = new InEditorAssistantService(
    { registry: { invoke, list: () => [] }, llm: { completeWithTools } } as never,
    {
      get: (key: string) =>
        key === 'CLIO_VERIFIER_ENABLED' && verifierEnabled ? 'true' : undefined,
    } as never,
    {} as never,
  );
  jest.spyOn(service as any, 'meterRound').mockResolvedValue(undefined);
  return { service, completeWithTools, invoke };
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it.each(['document', 'linked context', 'governed context'] as const)(
  'rejects oversized %s with no edits before any schema, tool, or model call',
  async (kind) => {
    const { service, completeWithTools, invoke } = harness();
    const fetch = jest.spyOn(globalThis, 'fetch');
    const oversized = 'x'.repeat(MAX_EDITOR_INPUT_CHARS);
    const input =
      kind === 'document'
        ? { ...dto, document: { sections: [{ name: 'Summary', content: oversized }] } }
        : kind === 'linked context'
          ? { ...dto, context: [{ label: 'Transcript', text: oversized }] }
          : withGovernedEditorContext(dto, ctx, { prompt: oversized } as never);
    const result = await RequestCredentialsStore.run({ bearerToken: 'token' }, () =>
      service.run(ctx, input),
    );
    expect(result.edits).toEqual([]);
    expect(result.reply).toContain('No changes were applied');
    expect(result.reply).toContain('smaller document or reduce the linked context');
    expect(fetch).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(completeWithTools).not.toHaveBeenCalled();
  },
);

it('passes the full source HTML to the model and returns the complete long replacement unchanged', async () => {
  const { service, completeWithTools } = harness();
  const content = `<p>${'Retained paragraph '.repeat(200)}</p><p>Closing source deadline [1:23:14].</p>`;
  const corrected = content.replace('Closing source deadline', 'Two weeks after receipt');
  completeWithTools.mockResolvedValue({
    ...proposed,
    content: [
      {
        type: 'tool_use',
        id: 'edit',
        name: 'propose_document_edits',
        input: {
          reply: 'Corrected the deadline.',
          edits: [{ op: 'replace_section', section: 'Summary', content: corrected }],
        },
      },
    ],
  });
  const result = await service.run(ctx, {
    ...dto,
    document: { sections: [{ name: 'Summary', content }] },
  });
  expect(completeWithTools.mock.calls[0][0].system.dynamic).toContain(content);
  expect(result.edits[0]!.content).toBe(corrected);
});

it('returns a supplied-source edit in one round without invoking research', async () => {
  const { service, completeWithTools, invoke } = harness();
  completeWithTools.mockResolvedValue(proposed);
  const result = await service.run(ctx, dto);
  expect(result.edits).toHaveLength(1);
  expect(invoke).not.toHaveBeenCalled();
  expect(completeWithTools).toHaveBeenCalledTimes(1);
  expect(completeWithTools.mock.calls[0]![0]).toMatchObject({ anthropicEffort: 'low' });
});

it('reserves a forced terminal edit round and never spends the reserve on another research loop', async () => {
  jest.useFakeTimers();
  const { service, completeWithTools, invoke } = harness();
  completeWithTools
    .mockImplementationOnce(async () => {
      jest.setSystemTime(Date.now() + 40_000);
      return {
        content: [{ type: 'tool_use', id: 'a', name: 'search_congress_bills', input: {} }],
        stopReason: 'tool_use',
      };
    })
    .mockImplementationOnce(async () => {
      jest.setSystemTime(Date.now() + 15_000);
      return {
        content: [{ type: 'tool_use', id: 'b', name: 'search_congress_bills', input: {} }],
        stopReason: 'tool_use',
      };
    })
    .mockResolvedValueOnce(proposed);
  const result = await service.run(ctx, dto);
  expect(result.edits).toHaveLength(1);
  expect(invoke).toHaveBeenCalledTimes(2);
  const requests = completeWithTools.mock.calls.map((c) => c[0]);
  expect(requests.map((r) => r.timeoutMs)).toEqual([60_000, 20_000, 55_000]);
  expect(requests[2]).toMatchObject({
    toolChoice: { type: 'tool', name: 'propose_document_edits' },
    anthropicEffort: 'low',
  });
  expect(requests[2].tools.map((t: { name: string }) => t.name)).toEqual([
    'propose_document_edits',
  ]);
  expect(invoke.mock.calls[0]![3]).toMatchObject({
    signal: expect.any(AbortSignal),
    deadlineAt: expect.any(Number),
  });
});

it('withholds a truncated forced final edit, even when it contains an edit tool payload', async () => {
  const { service, completeWithTools } = harness();
  completeWithTools
    .mockResolvedValueOnce({ content: [], stopReason: 'pause_turn' })
    .mockResolvedValueOnce({ content: [], stopReason: 'pause_turn' })
    .mockResolvedValueOnce({ ...proposed, stopReason: 'max_tokens' });
  expect((await service.run(ctx, dto)).edits).toEqual([]);
  expect(completeWithTools).toHaveBeenCalledTimes(3);
});

it('bounds a schema fetch that never settles, then permits a source-supported direct edit', async () => {
  jest.useFakeTimers();
  const { service, completeWithTools } = harness();
  completeWithTools.mockResolvedValue(proposed);
  jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), ms);
    return abort.signal;
  });
  const fetch = jest.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(() => undefined));
  const result = RequestCredentialsStore.run({ bearerToken: 'token' }, () => service.run(ctx, dto));
  await jest.advanceTimersByTimeAsync(5_000);
  expect((await result).edits).toHaveLength(1);
  expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  expect(completeWithTools).toHaveBeenCalledTimes(1);
});

it('bounds all model rounds and discards a late response even when the provider ignores cancellation', async () => {
  jest.useFakeTimers();
  const { service, completeWithTools } = harness();
  let finish!: (value: unknown) => void;
  completeWithTools.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const result = service.run(ctx, dto);
  await jest.advanceTimersByTimeAsync(EDITOR_TOTAL_BUDGET_MS);
  expect((await result).edits).toEqual([]);
  expect(completeWithTools.mock.calls[0]![0].signal.aborted).toBe(true);
  finish(proposed);
  await Promise.resolve();
  expect(completeWithTools).toHaveBeenCalledTimes(2);
});

it('cancels a slow research attempt across retries while preserving time for the final evidence-bounded edit', async () => {
  jest.useFakeTimers();
  const { service, completeWithTools } = harness();
  completeWithTools
    .mockImplementationOnce(() => new Promise(() => undefined))
    .mockResolvedValueOnce(proposed);
  const result = service.run(ctx, dto);
  await jest.advanceTimersByTimeAsync(60_000);
  expect((await result).edits).toHaveLength(1);
  expect(completeWithTools).toHaveBeenCalledTimes(2);
  expect(completeWithTools.mock.calls[0]![0].signal.aborted).toBe(true);
  expect(completeWithTools.mock.calls[1]![0]).toMatchObject({
    toolChoice: { type: 'tool', name: 'propose_document_edits' },
    timeoutMs: 50_000,
  });
});

it('propagates the total deadline into verification and cannot return or persist a late verified edit', async () => {
  jest.useFakeTimers();
  const { service, completeWithTools } = harness(true);
  const persist = jest.spyOn(service as any, 'persistClaims');
  let finishVerifier!: (value: unknown) => void;
  completeWithTools.mockResolvedValueOnce(proposed).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishVerifier = resolve;
      }),
  );
  const result = service.run(ctx, dto);
  await jest.advanceTimersByTimeAsync(EDITOR_TOTAL_BUDGET_MS);
  expect((await result).edits).toEqual([]);
  expect(completeWithTools.mock.calls[1]![0]).toMatchObject({
    toolChoice: 'none',
    timeoutMs: EDITOR_TOTAL_BUDGET_MS,
  });
  expect(completeWithTools.mock.calls[1]![0].signal.aborted).toBe(true);
  finishVerifier({
    content: [
      { type: 'text', text: '{"claims":[{"claim":"x","supported":true,"sourceIds":[1]}]}' },
    ],
    stopReason: 'end_turn',
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(persist).not.toHaveBeenCalled();
});
