import type { TenantContext } from '@capiro/shared';
import type { MeriHermesAuthorizationEnvelope } from './hermes-runtime.contracts.js';
import { MeriHermesRunStore } from './meri-hermes-run-store.js';

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
