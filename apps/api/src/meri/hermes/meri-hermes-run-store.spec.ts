import type { TenantContext } from '@capiro/shared';
import type { MeriHermesAuthorizationEnvelope } from './hermes-runtime.contracts.js';
import { MeriHermesConsumerFencedError, MeriHermesRunStore } from './meri-hermes-run-store.js';

const actor: TenantContext = {
  tenantId: 't-1',
  tenantSlug: 'fixture',
  userId: 'u-a',
  clerkUserId: 'clerk-a',
  role: 'standard_user',
};

function envelope(
  over: Partial<MeriHermesAuthorizationEnvelope> = {},
): MeriHermesAuthorizationEnvelope {
  return {
    version: 1,
    tenantId: 't-1',
    actorType: 'user',
    actorId: 'u-a',
    conversationId: 'c-1',
    workspaceId: null,
    executionScopeId: 'tenant:t-1:user:u-a',
    audience: 'private',
    authorizedClientIds: [],
    authorizedMailboxConnectionIds: [],
    toolPolicy: { allow: [], deny: [], readOnly: true },
    authorizationVersion: 'v1',
    runId: 'run-1',
    traceId: 'trace-1',
    issuedAt: '2026-09-19T00:00:00Z',
    expiresAt: '2026-09-19T01:00:00Z',
    budget: { maxToolCalls: 10, maxOutputTokens: 1000, maxWallClockMs: 60000 },
    ...over,
  };
}

const create = (store: MeriHermesRunStore, key: string, over: Partial<MeriHermesAuthorizationEnvelope> = {}) =>
  store.create({ envelope: envelope(over), actorContext: actor, idempotencyKey: key, userMessageId: null });

const interaction = (requestId: string, prompt: string) => ({
  requestId,
  kind: 'clarification' as const,
  createdAt: 'now',
  expiresAt: null,
  prompt,
  choices: ['A', 'B'],
  multiSelect: false,
  continuation: 'durable_continuation' as const,
  resolution: null,
});

describe('MeriHermesRunStore', () => {
  test('assigns monotonic sequence numbers and replays public events after a cursor', async () => {
    const store = new MeriHermesRunStore();
    const run = await create(store, 'meri:m1');
    await store.append(run.runId, 'message.delta', { delta: 'a' });
    await store.append(run.runId, 'run.status', { internal: true }, 'internal');
    await store.append(run.runId, 'message.delta', { delta: 'b' });
    expect((await store.eventsAfter(run.runId, 0)).map((e) => e.seq)).toEqual([1, 2, 4]);
    expect((await store.eventsAfter(run.runId, 2)).map((e) => e.payload.delta)).toEqual(['b']);
    expect(await store.eventsAfter(run.runId, 0, 'all')).toHaveLength(4);
  });

  test('idempotency: the same user message in the same scope maps to one run', async () => {
    const store = new MeriHermesRunStore();
    const a = await create(store, 'meri:m1');
    const b = await create(store, 'meri:m1', { runId: 'run-2' });
    expect(b.runId).toBe(a.runId);
    const other = await create(store, 'meri:m1', {
      runId: 'run-3',
      actorId: 'u-b',
      executionScopeId: 'tenant:t-1:user:u-b',
    });
    expect(other.runId).toBe('run-3');
  });

  test('new runs start with a pending dispatch status', async () => {
    const store = new MeriHermesRunStore();
    const run = await create(store, 'k');
    expect(run.dispatchStatus).toBe('pending');
    expect(run.dispatchAttempts).toBe(0);
  });

  test('ownership: another user or tenant cannot see the run even with the id', async () => {
    const store = new MeriHermesRunStore();
    const run = await create(store, 'k');
    expect((await store.requireOwned(run.runId, 't-1', 'u-a'))?.runId).toBe(run.runId);
    expect(await store.requireOwned(run.runId, 't-1', 'u-b')).toBeNull();
    expect(await store.requireOwned(run.runId, 't-2', 'u-a')).toBeNull();
  });

  test('hermes run id binding is indexed for broker lookups', async () => {
    const store = new MeriHermesRunStore();
    const run = await create(store, 'k');
    await store.update(run.runId, { hermesRunId: 'run_abc' });
    expect((await store.findByHermesRunId('run_abc'))?.runId).toBe(run.runId);
    expect(await store.findByHermesRunId('run_zzz')).toBeNull();
  });

  test('live subscribers receive appended events; terminal status stamps finishedAt', async () => {
    const store = new MeriHermesRunStore();
    const run = await create(store, 'k');
    const seen: number[] = [];
    const off = store.subscribe(run.runId, (e) => seen.push(e.seq));
    await store.append(run.runId, 'message.delta', { delta: 'x' });
    off();
    await store.append(run.runId, 'message.delta', { delta: 'y' });
    expect(seen).toEqual([2]);
    await store.update(run.runId, { status: 'completed' });
    expect((await store.get(run.runId))?.finishedAt).not.toBeNull();
    expect(await store.listActiveForScope('tenant:t-1:user:u-a')).toEqual([]);
  });

  test('worker status and its event cannot reopen a stopped run and still honor the consumer fence', async () => {
    const store = new MeriHermesRunStore();
    const run = await create(store, 'worker-status-stop');
    const fence = { consumerId: 'consumer-a' };
    expect(await store.claimConsumer(run.runId, fence.consumerId, 60_000)).toBe(true);
    const running = { event: { kind: 'tool.started' as const, payload: { tool: 'x' }, visibility: 'public' as const }, status: 'running' as const };
    expect(await store.publishWorkerProgressIfLive(run.runId, running, fence)).toBe('applied');
    await store.update(run.runId, { status: 'cancelling', stopRequestedAt: '2026-09-19T00:00:01Z' });
    expect(await store.publishWorkerProgressIfLive(run.runId, running, fence)).toBe('stopped');
    expect((await store.get(run.runId))?.status).toBe('cancelling');
    expect((await store.eventsAfter(run.runId, 1)).map((event) => event.kind)).toEqual(['tool.started']);
    await expect(store.publishWorkerProgressIfLive(run.runId, running, { consumerId: 'consumer-b' }))
      .rejects.toBeInstanceOf(MeriHermesConsumerFencedError);
    await store.update(run.runId, { status: 'cancelled' });
    await expect(store.publishWorkerProgressIfLive(run.runId, running, fence))
      .rejects.toBeInstanceOf(MeriHermesConsumerFencedError);
  });

  test('a committed Stop or worker cancelling state defeats terminal completion', async () => {
    const store = new MeriHermesRunStore();
    const stopped = await create(store, 'completion-after-stop');
    await store.update(stopped.runId, { status: 'running', output: 'Pre-Stop answer' });
    await store.update(stopped.runId, { status: 'cancelling', stopRequestedAt: '2026-09-19T00:00:01Z' });
    const late = await store.transitionTerminal(stopped.runId, {
      status: 'completed', finishReason: 'stop', output: 'Unsafe final answer',
    });
    expect(late.won).toBe(false);
    expect(late.run.status).toBe('cancelling');
    expect(late.run.output).toBe('Pre-Stop answer');
    expect((await store.update(stopped.runId, { status: 'completed', output: 'Unsafe final answer' })).status)
      .toBe('cancelling');
    const cancelled = await store.transitionTerminal(stopped.runId, {
      status: 'cancelled', finishReason: 'aborted', partial: true, output: late.run.output,
    });
    expect(cancelled.won).toBe(true);
    expect(cancelled.run.output).toBe('Pre-Stop answer');

    const workerStopping = await create(store, 'completion-after-worker-stopping');
    await store.update(workerStopping.runId, { status: 'cancelling' });
    expect((await store.transitionTerminal(workerStopping.runId, { status: 'completed', finishReason: 'stop' })).won)
      .toBe(false);

    const timestampOnly = await create(store, 'completion-after-stop-timestamp');
    await store.update(timestampOnly.runId, { status: 'running', stopRequestedAt: '2026-09-19T00:00:02Z' });
    expect((await store.transitionTerminal(timestampOnly.runId, { status: 'completed', finishReason: 'stop' })).won)
      .toBe(false);
  });

  test('Stop marker and cancelling event publish together exactly once', async () => {
    const store = new MeriHermesRunStore();
    const run = await create(store, 'atomic-stop-receipt');
    const observed: Array<{ status: string; requestedAt: string | null }> = [];
    store.subscribe(run.runId, (event) => {
      if (event.payload.status === 'cancelling') {
        observed.push({ status: run.status, requestedAt: run.stopRequestedAt });
      }
    });
    const first = await store.requestStopIfLive(run.runId, '2026-09-19T00:00:01Z');
    const second = await store.requestStopIfLive(run.runId, '2026-09-19T00:00:02Z', 'expired');
    expect(first.newlyRequested).toBe(true);
    expect(second.newlyRequested).toBe(false);
    expect(observed).toEqual([{ status: 'cancelling', requestedAt: '2026-09-19T00:00:01Z' }]);
    expect(second.run.finishReason).toBeNull();
    expect((await store.eventsAfter(run.runId, 1)).map((event) => event.payload.status))
      .toEqual(['cancelling']);
  });

  test('the fenced consumer may publish terminal receipts only after its winning claim', async () => {
    const store = new MeriHermesRunStore();
    const run = await create(store, 'fenced-finalization-publication');
    const fence = { consumerId: 'consumer-a' };
    expect(await store.claimConsumer(run.runId, fence.consumerId, 60_000)).toBe(true);
    expect((await store.transitionTerminal(run.runId, { status: 'completed', finishReason: 'stop' }, undefined, fence)).won)
      .toBe(true);
    await store.append(run.runId, 'run.completed', { frames: [] }, 'public', undefined, fence);
    await store.append(run.runId, 'run.status', { status: 'completed', final: true, frames: [] }, 'public', undefined, fence);
    await expect(store.append(run.runId, 'run.completed', { frames: [] }, 'public', undefined, fence))
      .rejects.toBeInstanceOf(MeriHermesConsumerFencedError);
  });

  test('a worker stopping frame publishes its own status event without an API Stop timestamp', async () => {
    const store = new MeriHermesRunStore();
    const run = await create(store, 'worker-stopping');
    const fence = { consumerId: 'consumer-a' };
    expect(await store.claimConsumer(run.runId, fence.consumerId, 60_000)).toBe(true);
    expect(await store.publishWorkerProgressIfLive(run.runId, {
      event: { kind: 'run.status', payload: { status: 'cancelling' }, visibility: 'public' },
      status: 'cancelling',
    }, fence)).toBe('applied');
    expect(await store.publishWorkerProgressIfLive(run.runId, {
      event: { kind: 'tool.started', payload: { tool: 'x' }, visibility: 'public' },
      status: 'running',
    }, fence)).toBe('stopped');
    expect((await store.get(run.runId))?.status).toBe('cancelling');
    expect((await store.eventsAfter(run.runId, 1)).map((event) => event.kind)).toEqual(['run.status']);
  });

  test('approval status, pending interaction, and public event publish together or not at all', async () => {
    const store = new MeriHermesRunStore();
    const run = await create(store, 'worker-approval');
    const fence = { consumerId: 'consumer-a' };
    expect(await store.claimConsumer(run.runId, fence.consumerId, 60_000)).toBe(true);
    const approval = {
      status: 'waiting_for_approval' as const,
      pendingInteraction: {
        ...interaction('req-1', 'Approve?'), kind: 'approval' as const,
        continuation: 'live_process' as const, expiresAt: '2026-10-01T00:00:00Z',
      },
      event: { kind: 'approval.requested' as const, payload: { requestId: 'req-1' }, visibility: 'public' as const },
    };
    const observed: Array<{ status: string; pending: number }> = [];
    store.subscribe(run.runId, (event) => {
      if (event.kind === 'approval.requested') {
        observed.push({ status: run.status, pending: run.pendingInteractions.length });
      }
    });
    expect(await store.publishWorkerProgressIfLive(run.runId, approval, fence)).toBe('applied');
    expect(observed).toEqual([{ status: 'waiting_for_approval', pending: 1 }]);
    await store.update(run.runId, { status: 'running', output: 'kept' });
    expect(await store.publishWorkerProgressIfLive(run.runId, {
      ...approval,
      pendingInteraction: { ...approval.pendingInteraction, prompt: 'Changed?', expiresAt: '2026-10-02T00:00:00Z' },
      outputSnapshot: 'discarded',
    }, fence)).toBe('duplicate');
    expect(run.status).toBe('running');
    expect(run.output).toBe('kept');
    expect(run.pendingInteractions.map((item) => ({ prompt: item.prompt, expiresAt: item.expiresAt })))
      .toEqual([{ prompt: 'Approve?', expiresAt: '2026-10-01T00:00:00Z' }]);
    expect(observed).toHaveLength(1);
    await store.update(run.runId, { status: 'cancelling', stopRequestedAt: new Date().toISOString() });
    expect(await store.publishWorkerProgressIfLive(run.runId, {
      ...approval,
      pendingInteraction: { ...interaction('req-2', 'Second?'), kind: 'approval' as const, continuation: 'live_process' as const },
      event: { ...approval.event, payload: { requestId: 'req-2' } },
    }, fence)).toBe('stopped');
    expect(run.pendingInteractions.map((item) => item.requestId)).toEqual(['req-1']);
    expect((await store.eventsAfter(run.runId, 1)).map((event) => event.kind)).toEqual(['approval.requested']);
  });

  test('worker progress and its output snapshot publish together before Stop and neither publishes afterward', async () => {
    const store = new MeriHermesRunStore();
    const run = await create(store, 'worker-progress-stop');
    const fence = { consumerId: 'consumer-a' };
    expect(await store.claimConsumer(run.runId, fence.consumerId, 60_000)).toBe(true);
    const observedSnapshots: string[] = [];
    store.subscribe(run.runId, (event) => {
      if (event.kind === 'message.delta') observedSnapshots.push(run.output);
    });
    const delta = { kind: 'message.delta' as const, payload: { delta: 'a' }, visibility: 'public' as const };
    expect(await store.publishWorkerProgressIfLive(run.runId, { event: delta, outputSnapshot: 'a' }, fence))
      .toBe('applied');
    expect(observedSnapshots).toEqual(['a']);
    expect(await store.publishWorkerProgressIfLive(run.runId, { event: null, outputSnapshot: 'ab' }, fence))
      .toBe('applied');
    const beforeStop = await store.get(run.runId);
    expect(beforeStop?.output).toBe('ab');
    expect(beforeStop?.outputSeq).toBe(2);
    await store.update(run.runId, { status: 'cancelling', stopRequestedAt: new Date().toISOString() });
    expect(await store.publishWorkerProgressIfLive(run.runId, { event: delta, outputSnapshot: 'abc' }, fence))
      .toBe('stopped');
    expect(await store.publishWorkerProgressIfLive(run.runId, { event: null, outputSnapshot: 'abc' }, fence))
      .toBe('stopped');
    await expect(store.publishWorkerProgressIfLive(run.runId, { event: delta }, { consumerId: 'consumer-b' }))
      .rejects.toBeInstanceOf(MeriHermesConsumerFencedError);
    expect((await store.get(run.runId))?.output).toBe('ab');
    expect((await store.get(run.runId))?.lastSeq).toBe(2);
    expect((await store.eventsAfter(run.runId, 0)).map((event) => event.kind))
      .toEqual(['run.accepted', 'message.delta']);
    expect(observedSnapshots).toEqual(['a']);
  });

  test('pending interactions survive and resolve exactly once', async () => {
    const store = new MeriHermesRunStore();
    const run = await create(store, 'k');
    await store.addInteraction(run.runId, interaction('req-1', 'Which client?'));
    await store.addInteraction(run.runId, interaction('req-1', 'dup'));
    expect((await store.get(run.runId))?.pendingInteractions).toHaveLength(1);
    expect(
      (
        await store.resolveInteraction(run.runId, 'req-1', {
          at: 'now',
          actorId: 'u-a',
          decision: 'answered',
          answer: 'A',
        })
      )?.resolution?.answer,
    ).toBe('A');
    expect(
      await store.resolveInteraction(run.runId, 'req-1', {
        at: 'now',
        actorId: 'u-a',
        decision: 'answered',
        answer: 'B',
      }),
    ).toBeNull();
  });

  test('lists a conversation history in creation order for the owning actor only', async () => {
    const store = new MeriHermesRunStore();
    await create(store, 'k1');
    await create(store, 'k2', { runId: 'run-2' });
    await create(store, 'k3', { runId: 'run-3', actorId: 'u-b', executionScopeId: 'tenant:t-1:user:u-b' });
    expect((await store.listForConversation('t-1', 'u-a', 'c-1')).map((r) => r.runId)).toEqual(['run-1', 'run-2']);
    expect((await store.listForConversation('t-1', 'u-b', 'c-1')).map((r) => r.runId)).toEqual(['run-3']);
  });

  test('sweeps terminal runs past the TTL only', async () => {
    let clock = new Date('2026-09-19T00:00:00Z');
    const store = MeriHermesRunStore.withClock(1000, () => clock);
    const done = await create(store, 'k1');
    const live = await create(store, 'k2', { runId: 'run-live' });
    await store.update(done.runId, { status: 'completed' });
    clock = new Date('2026-09-19T00:00:05Z');
    expect(await store.sweep()).toBe(1);
    expect(await store.get(done.runId)).toBeNull();
    expect(await store.get(live.runId)).not.toBeNull();
  });
});
