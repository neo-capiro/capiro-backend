import { translateHermesWireEvent } from './meri-hermes-event-translator.js';

const ctx = {
  meriRunId: 'run-1',
  now: () => new Date('2026-09-19T12:00:00Z'),
  approvalTimeoutSeconds: 300,
};

describe('translateHermesWireEvent', () => {
  test('streams text deltas and accumulates them', () => {
    const t = translateHermesWireEvent({ event: 'message.delta', delta: 'Hello' }, ctx);
    expect(t.textDelta).toBe('Hello');
    expect(t.frames).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(t.event?.kind).toBe('message.delta');
  });

  test('maps tool lifecycle to tool_call/sources the web client already resolves', () => {
    const started = translateHermesWireEvent(
      { event: 'tool.started', tool: 'read_file', preview: '{"path":"x"}' },
      ctx,
    );
    expect(started.frames[0]).toEqual({ type: 'tool_call', tool: 'read_file', label: 'read file' });
    const done = translateHermesWireEvent(
      { event: 'tool.completed', tool: 'read_file', duration: 0.4, error: false },
      ctx,
    );
    expect(done.frames[0]).toMatchObject({
      type: 'sources',
      sources: [{ tool: 'read_file', confidence: 'high' }],
    });
    const failed = translateHermesWireEvent(
      { event: 'tool.completed', tool: 'terminal', duration: 1, error: true },
      ctx,
    );
    expect(failed.frames[0]).toMatchObject({ sources: [{ confidence: 'low' }] });
  });

  test('never forwards private reasoning', () => {
    const t = translateHermesWireEvent(
      { event: 'reasoning.available', text: 'secret chain of thought' },
      ctx,
    );
    expect(t.frames).toEqual([]);
    expect(t.event).toBeNull();
    expect(JSON.stringify(t)).not.toContain('secret chain');
  });

  test('native approval becomes a pending interaction with a live-process continuation', () => {
    const t = translateHermesWireEvent(
      {
        event: 'approval.request',
        request_id: 'req-9',
        command: 'rm -rf ./fixture',
        description: 'Dangerous command',
        choices: ['once', 'deny'],
      },
      ctx,
    );
    expect(t.status).toBe('waiting_for_approval');
    expect(t.pendingInteraction).toEqual({
      requestId: 'req-9',
      prompt: 'Dangerous command\n\nrm -rf ./fixture',
      choices: ['once', 'deny'],
      expiresAt: '2026-09-19T12:05:00.000Z',
    });
    expect(t.frames[0]).toMatchObject({
      type: 'pending_approval',
      runtime: 'hermes',
      proposalId: 'hermes:run-1:req-9',
      interaction: { requestId: 'req-9', continuation: 'live_process' },
    });
  });

  test('terminal frames carry finish reason, partiality and usage', () => {
    const done = translateHermesWireEvent(
      {
        event: 'run.completed',
        output: 'final',
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
      ctx,
    );
    expect(done.status).toBe('completed');
    expect(done.terminal).toEqual({
      finishReason: 'stop',
      partial: false,
      output: 'final',
      error: null,
    });
    expect(done.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: null });
    expect(done.frames[0]).toMatchObject({ type: 'usage' });
    const failed = translateHermesWireEvent({ event: 'run.failed', error: 'boom' }, ctx);
    expect(failed.terminal).toMatchObject({ finishReason: 'error', partial: true, error: 'boom' });
    expect(failed.frames[0]).toEqual({ type: 'error', message: 'boom' });
    expect(translateHermesWireEvent({ event: 'run.cancelled' }, ctx).terminal?.finishReason).toBe(
      'aborted',
    );
    expect(translateHermesWireEvent({ event: 'run.interrupted' }, ctx).status).toBe('interrupted');
  });

  test('unknown frames are logged internally and never shown as progress', () => {
    const t = translateHermesWireEvent({ event: 'something.new', foo: 1 }, ctx);
    expect(t.frames).toEqual([]);
    expect(t.event).toEqual({
      kind: 'run.status',
      visibility: 'internal',
      payload: { unknownWireEvent: 'something.new' },
    });
  });
});
