/**
 * Phase 1 ownership + finalization acceptance spec (real local Postgres).
 *
 * Three defects, each proved against the database rather than against a stub:
 *
 *  1. PUBLICATION FENCING AFTER TAKEOVER. P1-09 gave the consumer lease an
 *     atomic claim and a heartbeat, but nothing checked the lease on the WRITE
 *     path: a consumer whose heartbeat had already failed kept appending
 *     events and overwriting `output`, so a taken-over run's durable log
 *     interleaved two writers. Now every write the consume loop makes carries
 *     its consumerId and the database rejects it the moment it stops owning
 *     the run.
 *
 *  2. ATOMIC FINALIZATION. `finalize()` built the answer, persisted the
 *     assistant `ClioMessage`, and only THEN performed the fenced terminal
 *     transition — so competing completion / Stop / revocation paths could each
 *     publish an assistant message before discovering they had lost, producing
 *     duplicate assistant bubbles for one turn. The transition now happens
 *     FIRST, inside the same transaction, and only the winner publishes.
 *
 *  3. RECOVERY FROM A DEAD REPLICA, PROVED BY KILLING ONE. The takeover path
 *     was only ever exercised by calling it directly on a row whose heartbeat
 *     a test had backdated. Here a REAL separate OS process claims the lease
 *     through the production repository and is SIGKILLed, and the surviving
 *     replica recovers the run through `sweepStaleConsumers()` — the
 *     request-driven production caller, not the bare method.
 *
 * Runs against the LOCAL fixture database only. Every id is a fresh
 * `randomUUID()` and everything is cascade-deleted via the fixture tenant in
 * `afterAll`, so repeated runs are idempotent and safe on a Postgres shared
 * with other local worktrees.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { MeriHermesAuthorizationEnvelope } from './hermes-runtime.contracts.js';
import { MeriHermesPrismaRunRepository } from './meri-hermes-prisma-run-repository.js';
import { MeriHermesRuntimeAdapter } from './meri-hermes-runtime.adapter.js';
import type { MeriHermesRuntimeClient } from './meri-hermes-runtime.client.js';
import { MeriHermesConsumerFencedError, type MeriHermesRunRecord } from './meri-hermes-run-store.js';

function assertLocalFixtureDatabase(url: string | undefined): void {
  if (!url) throw new Error('DATABASE_URL is required to run meri-hermes-ownership-and-finalization.spec.ts');
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error(
      `meri-hermes-ownership-and-finalization.spec.ts refuses to run against a non-local DATABASE_URL host (${parsed.hostname}). ` +
        'This suite writes and deletes rows and must only ever target the local fixture Postgres.',
    );
  }
}
assertLocalFixtureDatabase(process.env.DATABASE_URL);

process.env.MERI_HERMES_WATCH_INTERVAL_MS = '25';

jest.setTimeout(120_000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await sleep(20);
  }
}

describe('Hermes consumer ownership and finalization (real local Postgres)', () => {
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let repoA: MeriHermesPrismaRunRepository;
  let repoB: MeriHermesPrismaRunRepository;
  let tenantId: string;
  let userId: string;
  let actor: TenantContext;

  beforeAll(async () => {
    prismaA = new PrismaService();
    prismaB = new PrismaService();
    await Promise.all([prismaA.$connect(), prismaB.$connect()]);
    repoA = new MeriHermesPrismaRunRepository(prismaA);
    repoB = new MeriHermesPrismaRunRepository(prismaB);
    tenantId = randomUUID();
    userId = randomUUID();
    actor = {
      tenantId,
      tenantSlug: `meri-hermes-own-${tenantId}`,
      userId,
      clerkUserId: userId,
      role: 'standard_user',
    };
    await prismaA.withSystem(async (tx) => {
      await tx.tenant.create({
        data: {
          id: tenantId,
          slug: `meri-hermes-own-${tenantId}`,
          name: 'Meri Hermes ownership spec fixture',
          status: 'active',
        },
      });
      await tx.user.create({ data: { id: userId, clerkUserId: userId, email: `${userId}@example.test` } });
    });
  });

  afterAll(async () => {
    await prismaA.withSystem((tx) => tx.tenant.delete({ where: { id: tenantId } })).catch(() => undefined);
    await prismaA.withSystem((tx) => tx.user.delete({ where: { id: userId } })).catch(() => undefined);
    await Promise.all([prismaA.$disconnect(), prismaB.$disconnect()]);
  });

  async function makeConversation(): Promise<string> {
    const id = randomUUID();
    await prismaA.withTenant(tenantId, (tx) =>
      tx.clioConversation.create({ data: { id, tenantId, userId, title: 'Ownership fixture conversation' } }),
    );
    return id;
  }

  function envelope(conversationId: string): MeriHermesAuthorizationEnvelope {
    return {
      version: 1,
      tenantId,
      actorType: 'user',
      actorId: userId,
      conversationId,
      workspaceId: null,
      executionScopeId: `tenant:${tenantId}:user:${userId}`,
      audience: 'private',
      authorizedClientIds: [],
      authorizedMailboxConnectionIds: [],
      toolPolicy: { allow: [], deny: [], readOnly: true },
      authorizationVersion: 'v1',
      runId: randomUUID(),
      traceId: randomUUID(),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      budget: { maxToolCalls: 10, maxOutputTokens: 1000, maxWallClockMs: 600_000 },
    };
  }

  function createRun(repo: MeriHermesPrismaRunRepository, conversationId: string): Promise<MeriHermesRunRecord> {
    return repo.create({
      envelope: envelope(conversationId),
      actorContext: actor,
      idempotencyKey: `meri:${randomUUID()}`,
      userMessageId: null,
    });
  }

  interface RuntimeStub {
    streamRunEvents?: (
      hermesRunId: string,
      onEvent: (wire: Record<string, unknown>) => Promise<void>,
      signal: AbortSignal,
    ) => Promise<void>;
    getRunStatus?: { status: string; output?: string };
    getRun?: (hermesRunId: string) => Promise<Record<string, unknown>>;
    stopRun?: (hermesRunId: string) => Promise<Record<string, unknown>>;
  }

  /**
   * A `MeriHermesRuntimeAdapter` on ONE of the two independent stacks, with the
   * Hermes HTTP client and the surrounding Meri services stubbed. Everything
   * under test (the consumer lease, the write fence, finalize) is
   * adapter + repository + Postgres.
   */
  function makeAdapter(
    prisma: PrismaService,
    repo: MeriHermesPrismaRunRepository,
    consumerId: string,
    stub: RuntimeStub = {},
  ): MeriHermesRuntimeAdapter {
    const runtime = {
      createRun: async () => ({
        runId: `hermes-${randomUUID()}`,
        status: 'started',
        sessionId: null,
        replayed: false,
      }),
      getRun: stub.getRun ?? (async (id: string) => ({
        run_id: id,
        status: stub.getRunStatus?.status ?? 'completed',
        output: stub.getRunStatus?.output ?? 'Final answer from Hermes.',
      })),
      streamRunEvents: stub.streamRunEvents ?? (async () => undefined),
      stopRun: stub.stopRun ?? (async () => ({})),
    };
    const client = { forScope: () => runtime } as unknown as MeriHermesRuntimeClient;
    const adapter = new MeriHermesRuntimeAdapter(
      prisma,
      { isMeriHermesRuntimeEnabled: async () => true, isEnabled: async () => false } as never,
      client,
      repo,
      { securityEnvelope: async () => ({ authorizedClientIds: [], authorizedMailboxConnectionIds: [] }) } as never,
      { scheduleAfterTurnMaintenance: () => undefined } as never,
    );
    adapter.consumerId = consumerId;
    adapter.env = {
      ...process.env,
      MERI_HERMES_RUNTIME_URL: 'http://localhost:1/hermes-stub',
      MERI_HERMES_API_KEY: 'stub-key',
      MERI_HERMES_BROKER_SIGNING_KEY: 'x'.repeat(40),
      MERI_COMPLIANCE_BLOCK: 'false',
      MERI_HERMES_CONSUMER_STALE_MS: '60000',
      // Fast enough to renew well inside the stale window, slow enough not to
      // turn a single consuming run into a connection-pool stress test.
      MERI_HERMES_CONSUMER_HEARTBEAT_MS: '2000',
      // The recovery sweep is throttled per tenant per process; these specs
      // call it deliberately and must not be throttled out.
      MERI_HERMES_TAKEOVER_SWEEP_MS: '1',
    };
    return adapter;
  }

  function sseCollector(): { sse: { write(data: string): void }; frames: Array<Record<string, unknown>> } {
    const frames: Array<Record<string, unknown>> = [];
    return {
      frames,
      sse: {
        write(data: string) {
          for (const line of data.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            frames.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
          }
        },
      },
    };
  }

  async function assistantMessages(conversationId: string): Promise<Array<{ id: string; body: string }>> {
    return prismaA.withTenant(tenantId, (tx) =>
      tx.clioMessage.findMany({
        where: { conversationId, role: 'assistant' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, body: true },
      }),
    );
  }

  // -------------------------------------------------------------------------
  // 1. Publication fencing after takeover
  // -------------------------------------------------------------------------

  test('1a. the repository REJECTS event appends and output writes from a consumer that no longer owns the lease, and allocates no seq for them', async () => {
    const conversationId = await makeConversation();
    const run = await createRun(repoA, conversationId);
    await repoA.update(run.runId, { status: 'running', dispatchStatus: 'dispatched', hermesRunId: `hermes-${randomUUID()}` });

    expect(await repoA.claimConsumer(run.runId, 'replica-a', 60_000)).toBe(true);
    // While A owns the run its fenced writes are ordinary writes.
    await repoA.append(run.runId, 'message.delta', { delta: 'owned by A' }, 'public', undefined, { consumerId: 'replica-a' });
    await repoA.update(run.runId, { output: 'owned by A' }, undefined, { consumerId: 'replica-a' });

    const beforeTakeover = (await repoA.get(run.runId))!;

    // B takes the lease (staleAfterMs 0 => any existing heartbeat is stale).
    expect(await repoB.claimConsumer(run.runId, 'replica-b', 0)).toBe(true);

    // A, which has not noticed yet, tries to keep writing. Both are rejected.
    await expect(
      repoA.append(run.runId, 'message.delta', { delta: 'A AFTER TAKEOVER' }, 'public', undefined, {
        consumerId: 'replica-a',
      }),
    ).rejects.toBeInstanceOf(MeriHermesConsumerFencedError);
    await expect(
      repoA.update(run.runId, { output: 'A AFTER TAKEOVER', outputSeq: 99 }, undefined, { consumerId: 'replica-a' }),
    ).rejects.toBeInstanceOf(MeriHermesConsumerFencedError);
    await expect(
      repoA.update(run.runId, { status: 'completed', finishReason: 'stop' }, undefined, { consumerId: 'replica-a' }),
    ).rejects.toBeInstanceOf(MeriHermesConsumerFencedError);

    const afterTakeover = (await repoB.get(run.runId))!;
    const events = await repoB.eventsAfter(run.runId, 0, 'all');
    expect(JSON.stringify(events)).not.toContain('A AFTER TAKEOVER');
    expect(afterTakeover.output).toBe('owned by A');
    expect(afterTakeover.status).toBe('running');
    // The rejected append never even allocated a sequence number.
    expect(afterTakeover.lastSeq).toBe(beforeTakeover.lastSeq);
    expect(afterTakeover.consumerId).toBe('replica-b');

    // B, the current owner, writes normally.
    await repoB.append(run.runId, 'message.delta', { delta: 'owned by B' }, 'public', undefined, { consumerId: 'replica-b' });
    expect((await repoB.get(run.runId))!.lastSeq).toBe(beforeTakeover.lastSeq + 1);
  });

  test('1b. a consumer taken over mid-stream stops consuming, writes nothing more to the durable log, and terminates cleanly without an unhandled rejection', async () => {
    const conversationId = await makeConversation();

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    let releaseSecondDelta: () => void = () => {};
    const secondDeltaGate = new Promise<void>((resolve) => {
      releaseSecondDelta = resolve;
    });
    let firstDeltaDelivered: () => void = () => {};
    const firstDelta = new Promise<void>((resolve) => {
      firstDeltaDelivered = resolve;
    });

    // A's Hermes stream: one delta, then it waits, then it tries to write more
    // — which is exactly the window in which B takes the run over.
    const adapterA = makeAdapter(prismaA, repoA, 'replica-a', {
      streamRunEvents: async (_hermesRunId, onEvent, signal) => {
        await onEvent({ event: 'message.delta', delta: 'BEFORE-TAKEOVER ' });
        firstDeltaDelivered();
        await secondDeltaGate;
        if (signal.aborted) return;
        await onEvent({ event: 'message.delta', delta: 'AFTER-TAKEOVER ' });
        await onEvent({ event: 'message.delta', delta: 'STILL-AFTER-TAKEOVER ' });
      },
    });
    const adapterB = makeAdapter(prismaB, repoB, 'replica-b', {
      getRunStatus: { status: 'completed', output: 'Final answer from Hermes.' },
    });

    const collector = sseCollector();
    const abort = new AbortController();
    const turn = adapterA.streamMessage(actor, conversationId, 'Consume until taken over.', collector.sse, abort.signal);

    await firstDelta;
    const runId = await waitFor(async () => {
      const [record] = await repoA.listForConversation(tenantId, userId, conversationId);
      return record?.dispatchStatus === 'dispatched' ? record.runId : null;
    }, 'the run to be dispatched');
    await waitFor(async () => ((await repoA.get(runId))?.output ?? '').includes('BEFORE-TAKEOVER'), 'the first delta to land');
    const atTakeover = (await repoA.get(runId))!;

    // B takes over while A is parked mid-stream.
    expect(await repoB.claimConsumer(runId, 'replica-b', 0)).toBe(true);
    releaseSecondDelta();

    // A discovers it no longer owns the run on its very next durable write and
    // stops; it must not reconcile, must not finalize, must not throw.
    await waitFor(async () => (await repoA.get(runId))!.consumerId === 'replica-b', 'B to hold the lease');
    await waitFor(async () => {
      const events = await repoB.eventsAfter(runId, 0, 'all');
      return !JSON.stringify(events).includes('AFTER-TAKEOVER') ? true : false;
    }, 'no post-takeover event from A');

    const afterA = (await repoB.get(runId))!;
    expect(afterA.output).toBe('BEFORE-TAKEOVER ');
    expect(afterA.outputSeq).toBe(atTakeover.outputSeq);
    expect(afterA.lastSeq).toBe(atTakeover.lastSeq);
    expect(afterA.status).not.toBe('completed');

    // The current owner finishes the run, and A's browser stream unblocks.
    const outcome = await adapterB.takeOverRun((await repoB.get(runId))!, 0);
    expect(outcome).toBe('finalized_from_hermes');
    await turn;

    const finished = (await repoB.get(runId))!;
    expect(finished.status).toBe('completed');
    expect(finished.finishReason).toBe('stop');
    const log = JSON.stringify(await repoB.eventsAfter(runId, 0, 'all'));
    expect(log).not.toContain('AFTER-TAKEOVER');
    expect(log).not.toContain('STILL-AFTER-TAKEOVER');
    // Exactly one assistant message, published by the owner.
    const messages = await assistantMessages(conversationId);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).not.toContain('AFTER-TAKEOVER');

    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });

  test('1c. a taken-over consumer cannot publish a terminal success as its next worker event', async () => {
    const conversationId = await makeConversation();
    let releaseTerminal: () => void = () => {};
    const terminalGate = new Promise<void>((resolve) => { releaseTerminal = resolve; });
    let terminalAttempted: () => void = () => {};
    const terminalAttempt = new Promise<void>((resolve) => { terminalAttempted = resolve; });
    const originalTransition = repoA.transitionTerminal.bind(repoA);
    repoA.transitionTerminal = async (runId, patch, tx, fence) => {
      try { return await originalTransition(runId, patch, tx, fence); }
      finally { terminalAttempted(); }
    };
    const oldOwner = makeAdapter(prismaA, repoA, 'old-terminal-owner', {
      streamRunEvents: async (_hermesRunId, onEvent) => {
        await terminalGate;
        await onEvent({ event: 'run.completed', output: 'STALE OWNER SUCCESS' });
      },
    });
    oldOwner.env.MERI_HERMES_CONSUMER_HEARTBEAT_MS = '60000';
    const newOwner = makeAdapter(prismaB, repoB, 'new-terminal-owner', {
      getRunStatus: { status: 'completed', output: 'New owner result' },
    });
    const collector = sseCollector();
    const turn = oldOwner.streamMessage(actor, conversationId, 'Take over before completion.', collector.sse);
    try {
      const runId = await waitFor(async () => {
        const [record] = await repoA.listForConversation(tenantId, userId, conversationId);
        return record?.consumerId === 'old-terminal-owner' ? record.runId : null;
      }, 'old consumer lease');
      expect(await repoB.claimConsumer(runId, 'new-terminal-owner', 0, new Date(Date.now() + 1000))).toBe(true);
      releaseTerminal();
      await terminalAttempt;
      expect((await repoB.get(runId))?.status).toBe('running');
      expect((await repoB.eventsAfter(runId, 0, 'all')).filter((event) => event.kind === 'run.completed'))
        .toHaveLength(0);
      expect(await assistantMessages(conversationId)).toHaveLength(0);

      expect(await newOwner.takeOverRun((await repoB.get(runId))!, 0)).toBe('finalized_from_hermes');
      await turn;
      expect((await repoA.get(runId))?.output).toBe('New owner result');
      expect((await assistantMessages(conversationId)).map((message) => message.body)).toEqual(['New owner result']);
      expect(JSON.stringify(await repoA.eventsAfter(runId, 0, 'all'))).not.toContain('STALE OWNER SUCCESS');
    } finally {
      repoA.transitionTerminal = originalTransition;
      releaseTerminal();
      await turn.catch(() => undefined);
    }
  });

  test('1d. a takeover that loses its lease during the status poll cannot finalize', async () => {
    const conversationId = await makeConversation();
    const run = await createRun(repoA, conversationId);
    const hermesRunId = `hermes-${randomUUID()}`;
    await repoA.update(run.runId, { status: 'running', dispatchStatus: 'dispatched', hermesRunId });
    let pollStarted: () => void = () => {};
    const atPoll = new Promise<void>((resolve) => { pollStarted = resolve; });
    let releasePoll: () => void = () => {};
    const pollGate = new Promise<void>((resolve) => { releasePoll = resolve; });
    const losingTakeover = makeAdapter(prismaA, repoA, 'losing-poll-owner', {
      getRun: async (id) => {
        pollStarted();
        await pollGate;
        return { run_id: id, status: 'completed', output: 'STALE POLL SUCCESS' };
      },
    });
    const recovery = losingTakeover.takeOverRun(run, 0);
    try {
      await atPoll;
      expect(await repoB.claimConsumer(run.runId, 'winning-poll-owner', 0, new Date(Date.now() + 1000))).toBe(true);
      releasePoll();
      expect(await recovery).toBe('not_claimed');
      expect((await repoA.get(run.runId))?.status).toBe('running');
      expect((await repoA.eventsAfter(run.runId, 0, 'all')).filter((event) => event.payload.final === true))
        .toHaveLength(0);
      const winner = makeAdapter(prismaB, repoB, 'winning-poll-owner', {
        getRunStatus: { status: 'completed', output: 'Winning poll result' },
      });
      expect(await winner.takeOverRun((await repoB.get(run.runId))!, 0)).toBe('finalized_from_hermes');
      expect((await assistantMessages(conversationId)).map((message) => message.body))
        .toEqual(['Winning poll result']);
    } finally {
      releasePoll();
      await recovery.catch(() => undefined);
    }
  });

  // -------------------------------------------------------------------------
  // 2. Atomic finalization
  // -------------------------------------------------------------------------

  test('2. completion, Stop and a revocation fence racing one run produce exactly ONE assistant message, ONE terminal event and one consistent terminal status', async () => {
    const conversationId = await makeConversation();
    const run = await createRun(repoA, conversationId);
    await repoA.update(run.runId, {
      status: 'running',
      dispatchStatus: 'dispatched',
      hermesRunId: `hermes-${randomUUID()}`,
      output: 'Partial answer so far.',
    });

    // Three independent replicas, three different production entry points into
    // finalize(), fired at the same run at the same time.
    const completion = makeAdapter(prismaA, repoA, 'replica-completion', {
      getRunStatus: { status: 'completed', output: 'Final answer from Hermes.' },
    });
    const revocation = makeAdapter(prismaB, repoB, 'replica-revocation');
    const stopper = makeAdapter(prismaB, repoB, 'replica-stop');

    const record = async (repo: MeriHermesPrismaRunRepository) => (await repo.get(run.runId))!;

    const results = await Promise.allSettled([
      // completion: the consume loop's outcome, reached through the public
      // takeover entry point (same finalize(), same terminal outcome).
      completion.takeOverRun(await record(repoA), 0),
      // revocation fence: exactly the call MeriHermesBrokerService.authorize()
      // makes when it finds membership revoked mid-run.
      revocation.stopWorkerAndFinalize(await record(repoB), {
        finishReason: 'interrupted',
        partial: true,
        output: null,
        error: 'authorization_downgrade: membership is no longer active.',
      }),
      // explicit user Stop.
      stopper.requestStop(await record(repoB)),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const messages = await assistantMessages(conversationId);
    expect(messages).toHaveLength(1);

    const events = await repoA.eventsAfter(run.runId, 0, 'all');
    const finalEvents = events.filter((e) => e.payload.final === true);
    expect(finalEvents).toHaveLength(1);

    const finished = (await repoA.get(run.runId))!;
    expect(['completed', 'cancelled', 'interrupted']).toContain(finished.status);
    expect(finished.finishedAt).not.toBeNull();
    expect(finished.assistantMessageId).toBe(messages[0]!.id);
    // status and finishReason agree — no path half-applied its own outcome.
    const expectedFinishReason = { completed: 'stop', cancelled: 'aborted', interrupted: 'interrupted' }[
      finished.status as 'completed' | 'cancelled' | 'interrupted'
    ];
    expect(finished.finishReason).toBe(expectedFinishReason);
    // The single final event describes the same status the row carries.
    expect(finalEvents[0]!.payload.status).toBe(finished.status);
    expect(finished.outputSeq).toBe(finalEvents[0]!.seq);
  });

  test('2b. a late non-terminal status write cannot resurrect an already-terminal run', async () => {
    const conversationId = await makeConversation();
    const run = await createRun(repoA, conversationId);
    await repoA.update(run.runId, { status: 'running' });
    const first = await repoA.transitionTerminal(run.runId, { status: 'completed', finishReason: 'stop' });
    expect(first.won).toBe(true);

    // A second terminal claim loses and changes nothing.
    const second = await repoB.transitionTerminal(run.runId, { status: 'cancelled', finishReason: 'aborted' });
    expect(second.won).toBe(false);
    expect(second.run.status).toBe('completed');

    // …and a plain `update()` carrying a status (an explicit Stop that lost the
    // race) cannot move a terminal run back to a live one either.
    await repoB.update(run.runId, { status: 'cancelling', stopRequestedAt: new Date().toISOString() });
    const after = (await repoA.get(run.runId))!;
    expect(after.status).toBe('completed');
    expect(after.finishReason).toBe('stop');
  });

  test.each([
    { finishReason: 'aborted' as const, status: 'cancelled' as const },
    { finishReason: 'expired' as const, status: 'expired' as const },
  ])('2c. completion after $finishReason Stop keeps pre-Stop output and no success receipt', async ({ finishReason, status }) => {
    const conversationId = await makeConversation();
    let firstDeltaDelivered: () => void = () => {};
    const firstDelta = new Promise<void>((resolve) => { firstDeltaDelivered = resolve; });
    let releaseCompletion: () => void = () => {};
    const completionGate = new Promise<void>((resolve) => { releaseCompletion = resolve; });
    const consumer = makeAdapter(prismaA, repoA, 'completion-after-stop', {
      streamRunEvents: async (_hermesRunId, onEvent) => {
        await onEvent({ event: 'message.delta', delta: 'Pre-Stop answer' });
        firstDeltaDelivered();
        await completionGate;
        await onEvent({
          event: 'run.completed', output: 'Unsafe final answer',
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        });
      },
    });
    const stopper = makeAdapter(prismaB, repoB, 'stopper');
    const collector = sseCollector();
    const turn = consumer.streamMessage(actor, conversationId, 'Stop before completion.', collector.sse);
    try {
      await firstDelta;
      const runId = await waitFor(async () => {
        const [record] = await repoA.listForConversation(tenantId, userId, conversationId);
        return record?.output === 'Pre-Stop answer' ? record.runId : null;
      }, 'pre-Stop output to become durable');
      await stopper.requestStop((await repoB.get(runId))!, finishReason === 'expired' ? 'expired' : null);
      releaseCompletion();
      await turn;

      const finalRun = (await repoA.get(runId))!;
      expect(finalRun.status).toBe(status);
      expect(finalRun.finishReason).toBe(finishReason);
      expect(finalRun.partial).toBe(true);
      expect(finalRun.output).toBe('Pre-Stop answer');
      expect(finalRun.usage?.totalTokens).toBe(15);
      const messages = await assistantMessages(conversationId);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.body).toBe('Pre-Stop answer');
      const events = await repoA.eventsAfter(runId, 0, 'all');
      expect(events.filter((event) => event.kind === 'run.completed')).toHaveLength(0);
      expect(events.filter((event) => event.payload.final === true)).toHaveLength(1);
      expect(events.find((event) => event.payload.final === true)?.payload.status).toBe(status);
      expect(JSON.stringify(events)).not.toContain('"type":"usage"');
      expect(JSON.stringify(collector.frames)).not.toContain('"finishReason":"stop"');
      expect(JSON.stringify(collector.frames)).not.toContain('Unsafe final answer');
    } finally {
      releaseCompletion();
      await turn.catch(() => undefined);
    }
  });

  test('2d. completion that commits first publishes its worker receipt, usage frame, and one final answer', async () => {
    const conversationId = await makeConversation();
    const consumer = makeAdapter(prismaA, repoA, 'completion-before-stop', {
      streamRunEvents: async (_hermesRunId, onEvent) => {
        await onEvent({
          event: 'run.completed', output: 'Finished before Stop',
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        });
      },
    });
    const collector = sseCollector();
    await consumer.streamMessage(actor, conversationId, 'Complete first.', collector.sse);
    const [run] = await repoA.listForConversation(tenantId, userId, conversationId);
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe('Finished before Stop');
    expect(run?.usage?.totalTokens).toBe(15);
    const events = await repoA.eventsAfter(run!.runId, 0, 'all');
    expect(events.filter((event) => event.kind === 'run.completed')).toHaveLength(1);
    expect(events.filter((event) => event.payload.final === true)).toHaveLength(1);
    expect(JSON.stringify(events)).toContain('"type":"usage"');
    expect((await assistantMessages(conversationId)).map((message) => message.body)).toEqual(['Finished before Stop']);
    const stopper = makeAdapter(prismaB, repoB, 'late-stopper');
    expect((await stopper.requestStop(run!)).status).toBe('completed');
    expect((await repoB.get(run!.runId))?.stopRequestedAt).toBeNull();
  });

  test('2e. a completed status poll after Stop cannot turn the run into success', async () => {
    const conversationId = await makeConversation();
    const run = await createRun(repoA, conversationId);
    await repoA.update(run.runId, {
      status: 'running', dispatchStatus: 'dispatched',
      hermesRunId: `hermes-${randomUUID()}`, output: 'Pre-Stop poll answer',
    });
    await repoB.update(run.runId, { status: 'cancelling', stopRequestedAt: new Date().toISOString() });
    const recovery = makeAdapter(prismaA, repoA, 'poll-after-stop', {
      getRunStatus: { status: 'completed', output: 'Unsafe polled final answer' },
    });
    expect(await recovery.takeOverRun((await repoA.get(run.runId))!, 0)).toBe('interrupted');
    const finalRun = (await repoB.get(run.runId))!;
    expect(finalRun.status).toBe('cancelled');
    expect(finalRun.finishReason).toBe('aborted');
    expect(finalRun.output).toBe('Pre-Stop poll answer');
    expect((await assistantMessages(conversationId)).map((message) => message.body))
      .toEqual(['Pre-Stop poll answer']);
    const events = await repoA.eventsAfter(run.runId, 0, 'all');
    expect(events.filter((event) => event.kind === 'run.completed')).toHaveLength(0);
    expect(events.find((event) => event.payload.final === true)?.payload.status).toBe('cancelled');
  });

  test('2f. Stop marker and cancelling event commit before a waiting finalizer can publish done', async () => {
    const conversationId = await makeConversation();
    const run = await createRun(repoA, conversationId);
    await repoA.update(run.runId, {
      status: 'running', dispatchStatus: 'dispatched',
      hermesRunId: `hermes-${randomUUID()}`, output: 'Pre-Stop answer',
    });
    let markerWritten: () => void = () => {};
    const atMarker = new Promise<void>((resolve) => { markerWritten = resolve; });
    let releaseStopEvent: () => void = () => {};
    const stopEventGate = new Promise<void>((resolve) => { releaseStopEvent = resolve; });
    const internals = repoB as unknown as { appendInTx: (...args: unknown[]) => Promise<unknown> };
    const originalAppend = internals.appendInTx.bind(repoB);
    internals.appendInTx = async (...args) => {
      if (args[2] === 'run.status' && (args[3] as Record<string, unknown>).status === 'cancelling') {
        markerWritten();
        await stopEventGate;
      }
      return originalAppend(...args);
    };
    const stopper = makeAdapter(prismaB, repoB, 'atomic-stopper');
    const recovery = makeAdapter(prismaA, repoA, 'waiting-finalizer', {
      getRunStatus: { status: 'completed', output: 'Unsafe final output' },
    });
    const stop = stopper.requestStop(run);
    try {
      await atMarker;
      // The marker is written but uncommitted while the cancelling event is
      // held. A competing completion must wait for this transaction to finish.
      const finalization = recovery.takeOverRun(run, 0);
      releaseStopEvent();
      await Promise.all([stop, finalization]);
      const events = await repoA.eventsAfter(run.runId, 0, 'all');
      const cancelling = events.find((event) => event.kind === 'run.status' && event.payload.status === 'cancelling');
      const done = events.find((event) => event.payload.final === true);
      expect(cancelling).toBeDefined();
      expect(done).toBeDefined();
      expect(cancelling!.seq).toBeLessThan(done!.seq);
      expect(done!.payload.status).toBe('cancelled');
      expect(events.filter((event) => event.kind === 'run.completed')).toHaveLength(0);
    } finally {
      releaseStopEvent();
      internals.appendInTx = originalAppend;
      await stop.catch(() => undefined);
    }
  });

  test('2g. Stop uses the newly bound Hermes run ID from its durable marker result', async () => {
    const run = await createRun(repoA, await makeConversation());
    const hermesRunId = `hermes-${randomUUID()}`;
    await repoA.update(run.runId, { status: 'running', dispatchStatus: 'dispatched', hermesRunId });
    const stoppedIds: string[] = [];
    const stopper = makeAdapter(prismaB, repoB, 'fresh-stop-binding', {
      stopRun: async (id) => { stoppedIds.push(id); return {}; },
    });
    const stopped = await stopper.requestStop(run);
    expect(stopped.status).toBe('cancelling');
    expect(stoppedIds).toEqual([hermesRunId]);
    expect((await repoA.get(run.runId))?.status).toBe('cancelling');
  });

  // -------------------------------------------------------------------------
  // 3. Recovery after the owning API process is KILLED
  // -------------------------------------------------------------------------

  test('3. a run whose owning API PROCESS is SIGKILLed is recovered by the surviving replica through the production sweep', async () => {
    const conversationId = await makeConversation();
    const run = await createRun(repoA, conversationId);
    await repoA.update(run.runId, {
      status: 'running',
      dispatchStatus: 'dispatched',
      hermesRunId: `hermes-${randomUUID()}`,
      output: 'Partial answer from the replica that died.',
    });

    const consumerId = `replica-child-${randomUUID().slice(0, 8)}`;
    const fixture = join(__dirname, 'meri-hermes-consumer-process.fixture.ts');
    const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
      process.execPath,
      [tsxCli, fixture, run.runId, consumerId],
      { cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const stderr: string[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));

    try {
      const ready = await new Promise<string>((resolve, reject) => {
        let buffered = '';
        const timer = setTimeout(
          () => reject(new Error(`consumer process never reported READY. stderr=${stderr.join('').slice(-800)}`)),
          90_000,
        );
        child.stdout.on('data', (chunk: Buffer) => {
          buffered += chunk.toString();
          const line = buffered.split('\n').find((l) => l.startsWith('READY ') || l.startsWith('FAILED '));
          if (!line) return;
          clearTimeout(timer);
          resolve(line.trim());
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(new Error(`consumer process could not be spawned: ${String(error)}`));
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`consumer process exited early with code ${code}. stderr=${stderr.join('').slice(-800)}`));
        });
      });
      expect(ready).toBe(`READY ${consumerId}`);

      // The lease is genuinely held by that other process.
      const owned = (await repoB.get(run.runId))!;
      expect(owned.consumerId).toBe(consumerId);
      expect(owned.consumerHeartbeatAt).not.toBeNull();

      // Another replica must NOT be able to steal a live, heartbeating lease.
      expect(await repoB.claimConsumer(run.runId, 'replica-survivor', 60_000)).toBe(false);

      // Kill it outright: no SIGTERM handler, no finally block, no lease release.
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
    } finally {
      if (!child.killed) child.kill('SIGKILL');
    }

    // Nothing will ever finish this run now. Wait past the stale window and let
    // the SURVIVING replica's production sweep notice.
    const survivor = makeAdapter(prismaB, repoB, 'replica-survivor', {
      getRunStatus: { status: 'completed', output: 'Final answer from Hermes.' },
    });
    survivor.env = { ...survivor.env, MERI_HERMES_CONSUMER_STALE_MS: '1000' };
    await sleep(1_500);

    const stillOrphaned = (await repoB.get(run.runId))!;
    expect(stillOrphaned.status).toBe('running');
    expect(stillOrphaned.consumerId).toBe(consumerId);

    // `sweepStaleConsumers` is the request-driven production caller wired into
    // GET /api/clio/hermes/conversations/:id/active — not the bare method.
    const recovered = await survivor.sweepStaleConsumers(tenantId);
    expect(recovered).toBeGreaterThanOrEqual(1);

    const finished = (await repoB.get(run.runId))!;
    expect(['completed', 'interrupted']).toContain(finished.status);
    expect(finished.finishedAt).not.toBeNull();
    expect(finished.consumerId).toBe('replica-survivor');
    // Exactly one assistant message for the recovered turn.
    expect(await assistantMessages(conversationId)).toHaveLength(1);
  });

  test('3b. the recovery sweep is tenant-scoped: it never touches another tenant\'s orphaned run', async () => {
    const otherTenantId = randomUUID();
    const otherUserId = randomUUID();
    await prismaA.withSystem(async (tx) => {
      await tx.tenant.create({
        data: { id: otherTenantId, slug: `meri-hermes-own-other-${otherTenantId}`, name: 'Other tenant', status: 'active' },
      });
      await tx.user.create({ data: { id: otherUserId, clerkUserId: otherUserId, email: `${otherUserId}@example.test` } });
    });
    try {
      const otherConversationId = randomUUID();
      await prismaA.withTenant(otherTenantId, (tx) =>
        tx.clioConversation.create({
          data: { id: otherConversationId, tenantId: otherTenantId, userId: otherUserId, title: 'Other tenant conversation' },
        }),
      );
      const otherEnvelope: MeriHermesAuthorizationEnvelope = {
        ...envelope(otherConversationId),
        tenantId: otherTenantId,
        actorId: otherUserId,
        executionScopeId: `tenant:${otherTenantId}:user:${otherUserId}`,
        runId: randomUUID(),
      };
      const otherRun = await repoA.create({
        envelope: otherEnvelope,
        actorContext: { ...actor, tenantId: otherTenantId, userId: otherUserId, clerkUserId: otherUserId },
        idempotencyKey: `meri:${randomUUID()}`,
        userMessageId: null,
      });
      await repoA.update(otherRun.runId, {
        status: 'running',
        dispatchStatus: 'dispatched',
        hermesRunId: `hermes-${randomUUID()}`,
      });
      // Orphaned: dispatched, never heartbeated, and untouched long enough
      // that the never-heartbeated case counts (a freshly dispatched run is
      // deliberately NOT a candidate — see the next test).
      expect((await repoA.get(otherRun.runId))!.consumerHeartbeatAt).toBeNull();
      await prismaA.withSystem((tx) =>
        tx.meriAgentRun.update({
          where: { id: otherRun.runId },
          data: { updatedAt: new Date(Date.now() - 10 * 60 * 1000) },
        }),
      );

      const survivor = makeAdapter(prismaB, repoB, `replica-scope-${randomUUID().slice(0, 8)}`);
      survivor.env = { ...survivor.env, MERI_HERMES_CONSUMER_STALE_MS: '1000' };
      await survivor.sweepStaleConsumers(tenantId);

      const untouched = (await repoA.get(otherRun.runId))!;
      expect(untouched.status).toBe('running');
      expect(untouched.consumerId).toBeNull();

      // Scoped to ITS tenant, the same sweep does recover it.
      const candidates = await repoB.listTakeoverCandidates(1000, undefined, { tenantId: otherTenantId });
      expect(candidates.map((c) => c.runId)).toContain(otherRun.runId);
    } finally {
      await prismaA.withSystem((tx) => tx.tenant.delete({ where: { id: otherTenantId } })).catch(() => undefined);
      await prismaA.withSystem((tx) => tx.user.delete({ where: { id: otherUserId } })).catch(() => undefined);
    }
  });

  /**
   * 3c — the regression that putting the recovery sweep on a REQUEST path
   * creates if the candidate rule is naive.
   *
   * `streamMessage` marks a run `dispatched` and only then does `consume()`
   * claim the consumer lease. In between, a perfectly healthy run that
   * started milliseconds ago has `dispatchStatus: 'dispatched'` and
   * `consumerHeartbeatAt: null`. A rule that reads "no heartbeat = orphaned"
   * would let the very next `GET .../conversations/:id/active` take that run
   * over and finalize it — killing a live turn in the name of recovering it.
   */
  test('3c. a run dispatched moments ago with no heartbeat yet is NOT a takeover candidate', async () => {
    const conversationId = await makeConversation();
    const run = await createRun(repoA, conversationId);
    await repoA.update(run.runId, {
      status: 'running',
      dispatchStatus: 'dispatched',
      hermesRunId: `hermes-${randomUUID()}`,
    });
    const fresh = (await repoA.get(run.runId))!;
    expect(fresh.consumerHeartbeatAt).toBeNull();

    const candidates = await repoB.listTakeoverCandidates(1000, undefined, { tenantId });
    expect(candidates.map((c) => c.runId)).not.toContain(run.runId);

    const survivor = makeAdapter(prismaB, repoB, `replica-window-${randomUUID().slice(0, 8)}`);
    survivor.env = { ...survivor.env, MERI_HERMES_CONSUMER_STALE_MS: '1000' };
    await survivor.sweepStaleConsumers(tenantId);

    const after = (await repoA.get(run.runId))!;
    expect(after.status).toBe('running');
    expect(after.finishedAt).toBeNull();
    expect(after.consumerId).toBeNull();

    // Once it really has been untouched for the stale window, it does qualify.
    await prismaA.withSystem((tx) =>
      tx.meriAgentRun.update({ where: { id: run.runId }, data: { updatedAt: new Date(Date.now() - 10 * 60 * 1000) } }),
    );
    const laterCandidates = await repoB.listTakeoverCandidates(1000, undefined, { tenantId });
    expect(laterCandidates.map((c) => c.runId)).toContain(run.runId);
  });
});
