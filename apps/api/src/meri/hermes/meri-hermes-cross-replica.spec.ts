/**
 * Cross-INSTANCE coordination acceptance spec for the Hermes runtime
 * (Phase 1 closeout ticket #2: P1-08 pruning-safe recovery, P1-09 durable
 * watch + consumer lease, P1-10 conversation discovery, P1-11 request
 * fingerprint idempotency).
 *
 * WHAT THIS PROVES, PRECISELY: that two independently constructed
 * repository/adapter instances — separate `PrismaService`s, separate in-process
 * event emitters, no shared JavaScript state whatsoever — coordinate correctly
 * THROUGH POSTGRES. That is the stand-in for two API replicas, and it is what
 * the production failure mode actually depends on (a browser attached to
 * replica B seeing events produced by replica A).
 *
 * WHAT THIS DOES NOT PROVE: it is not a two-process HTTP deployment test. Both
 * "replicas" run in this one Node process, so it does not exercise real network
 * partitions, real process death, or the HTTP layer. It deliberately never
 * shares an emitter between the two instances, which is exactly the property
 * that makes the in-process pub/sub incapable of carrying the result: every
 * delivery asserted below had to travel through the database.
 *
 * Runs against the LOCAL fixture database only (container `capiro-postgres`) —
 * never a remote/production database. Every fixture id is a fresh
 * `randomUUID()` and everything created is cascade-deleted via the fixture
 * tenant in `afterAll`, so repeated runs are idempotent and safe on a database
 * shared with other local sessions/worktrees.
 */
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  MeriHermesAuthorizationEnvelope,
  MeriHermesPendingInteraction,
  MeriHermesRunEvent,
} from './hermes-runtime.contracts.js';
import { MeriHermesPrismaRunRepository } from './meri-hermes-prisma-run-repository.js';
import { MeriHermesRuntimeAdapter } from './meri-hermes-runtime.adapter.js';
import type { MeriHermesRuntimeClient } from './meri-hermes-runtime.client.js';
import type { MeriHermesRunRecord } from './meri-hermes-run-store.js';

function assertLocalFixtureDatabase(url: string | undefined): void {
  if (!url) throw new Error('DATABASE_URL is required to run meri-hermes-cross-replica.spec.ts');
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error(
      `meri-hermes-cross-replica.spec.ts refuses to run against a non-local DATABASE_URL host (${parsed.hostname}). ` +
        'This suite writes and deletes rows and must only ever target the local fixture Postgres.',
    );
  }
}
assertLocalFixtureDatabase(process.env.DATABASE_URL);

// `watch()` reads its default poll interval from the process environment.
// 25 ms keeps the suite quick without changing any behaviour under test.
process.env.MERI_HERMES_WATCH_INTERVAL_MS = '25';

jest.setTimeout(60_000);

/**
 * `reconcileStuckDispatches` is a GLOBAL (cross-tenant) sweep, and this
 * Postgres is shared with other worktrees. The threshold used here is therefore
 * deliberately large (30 minutes, the same order as the existing repository
 * spec) and fixtures are backdated an hour, so the sweep can only ever touch
 * rows that are genuinely abandoned — never a run another session just created.
 */
const STUCK_DISPATCH_MS = 30 * 60 * 1000;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, label: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('Hermes cross-instance coordination through Postgres (real local Postgres)', () => {
  // Two fully independent stacks. `A` and `B` never share an object.
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
      tenantSlug: `meri-hermes-xrep-${tenantId}`,
      userId,
      clerkUserId: userId,
      role: 'standard_user',
    };
    await prismaA.withSystem(async (tx) => {
      await tx.tenant.create({
        data: {
          id: tenantId,
          slug: `meri-hermes-xrep-${tenantId}`,
          name: 'Meri Hermes cross-replica spec fixture',
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
      tx.clioConversation.create({ data: { id, tenantId, userId, title: 'Fixture conversation' } }),
    );
    return id;
  }

  function envelope(over: Partial<MeriHermesAuthorizationEnvelope> & { conversationId: string }): MeriHermesAuthorizationEnvelope {
    return {
      version: 1,
      tenantId,
      actorType: 'user',
      actorId: userId,
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
      ...over,
    };
  }

  function createRun(
    repo: MeriHermesPrismaRunRepository,
    conversationId: string,
    idempotencyKey: string,
  ): Promise<MeriHermesRunRecord> {
    return repo.create({
      envelope: envelope({ conversationId }),
      actorContext: actor,
      idempotencyKey,
      userMessageId: null,
    });
  }

  /** Commit a terminal event + the terminal status in ONE transaction, exactly as `finalize()` does. */
  async function finalizeAtomically(
    prisma: PrismaService,
    repo: MeriHermesPrismaRunRepository,
    runId: string,
    status: 'completed' | 'cancelled' = 'completed',
  ): Promise<void> {
    await prisma.withTenant(tenantId, async (tx) => {
      await repo.append(runId, 'run.status', { status, final: true, frames: [] }, 'public', tx);
      await repo.update(runId, { status, finishReason: status === 'completed' ? 'stop' : 'aborted' }, tx);
    });
  }

  /**
   * A `MeriHermesRuntimeAdapter` wired to ONE of the two stacks, with the
   * Hermes HTTP client and the surrounding Meri services stubbed. Everything
   * under test here (admission, idempotency, the durable watch, finalize,
   * takeover) is adapter + repository + Postgres; the stubs only stand in for
   * the parts this ticket does not touch.
   */
  function makeAdapter(
    prisma: PrismaService,
    repo: MeriHermesPrismaRunRepository,
    streamGate: Promise<void>,
    consumerId = `replica-${randomUUID().slice(0, 8)}`,
  ): MeriHermesRuntimeAdapter {
    const runtime = {
      createRun: async () => ({
        runId: `hermes-${randomUUID()}`,
        status: 'started',
        sessionId: null,
        replayed: false,
      }),
      // The event stream ends without a terminal frame; the adapter then asks
      // Hermes for the authoritative final status, which is the same path a
      // takeover uses.
      getRun: async (id: string) => ({ run_id: id, status: 'completed', output: 'Final answer from Hermes.' }),
      streamRunEvents: async () => {
        await streamGate;
      },
      stopRun: async () => ({}),
    };
    const client = { forScope: () => runtime } as unknown as MeriHermesRuntimeClient;
    const flags = {
      isMeriHermesRuntimeEnabled: async () => true,
      isEnabled: async () => false,
    };
    const security = {
      securityEnvelope: async () => ({ authorizedClientIds: [], authorizedMailboxConnectionIds: [] }),
    };
    const maintenance = { scheduleAfterTurnMaintenance: () => undefined };
    const adapter = new MeriHermesRuntimeAdapter(
      prisma,
      flags as never,
      client,
      repo,
      security as never,
      maintenance as never,
    );
    adapter.consumerId = consumerId;
    adapter.env = {
      ...process.env,
      MERI_HERMES_RUNTIME_URL: 'http://localhost:1/hermes-stub',
      MERI_HERMES_API_KEY: 'stub-key',
      MERI_HERMES_BROKER_SIGNING_KEY: 'x'.repeat(40),
      MERI_COMPLIANCE_BLOCK: 'false',
      MERI_HERMES_DISPATCH_STUCK_MS: String(STUCK_DISPATCH_MS),
      MERI_HERMES_CONSUMER_STALE_MS: '60000',
      MERI_HERMES_CONSUMER_HEARTBEAT_MS: '5000',
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

  // -------------------------------------------------------------------------
  // 1. Two-instance coordination
  // -------------------------------------------------------------------------

  test('1a. a watch() started on instance B receives every event instance A appends, in order, and observes the terminal state', async () => {
    const conversationId = await makeConversation();
    const run = await createRun(repoA, conversationId, `meri:${randomUUID()}`);

    const received: MeriHermesRunEvent[] = [];
    // Proof that delivery is NOT the in-process emitter: B's own emitter is
    // instrumented and must never fire, because every append happens on A.
    let bEmitterHits = 0;
    const offBEmitter = repoB.subscribe(run.runId, () => {
      bEmitterHits += 1;
    });

    const abort = new AbortController();
    const watching = repoB.watch(run.runId, 0, (event) => {
      received.push(event);
    }, abort.signal, { visibility: 'all' });

    await repoA.append(run.runId, 'message.delta', { delta: 'Hello ' });
    await repoA.append(run.runId, 'message.delta', { delta: 'world' });
    await repoA.update(run.runId, { status: 'running' });
    await finalizeAtomically(prismaA, repoA, run.runId);

    await watching;
    offBEmitter();

    expect(received.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(received.map((e) => e.kind)).toEqual(['run.accepted', 'message.delta', 'message.delta', 'run.status']);
    expect(received.at(-1)?.payload.final).toBe(true);
    expect(bEmitterHits).toBe(0);
    expect((await repoB.get(run.runId))?.status).toBe('completed');
  });

  test('1b. instance B can stop/finalize a run instance A created, and A\'s waitForTerminalOrDetach returns', async () => {
    const conversationId = await makeConversation();
    const run = await createRun(repoA, conversationId, `meri:${randomUUID()}`);
    await repoA.update(run.runId, { status: 'running' });

    const adapterA = makeAdapter(prismaA, repoA, Promise.resolve(), 'replica-a');
    const adapterB = makeAdapter(prismaB, repoB, Promise.resolve(), 'replica-b');

    // A is waiting on a run it "owns"; nothing on A will ever finalize it.
    const waiting = adapterA.waitForTerminalOrDetach((await repoA.get(run.runId))!);

    // B — a different instance, different Prisma client, different emitter —
    // stops it. The run was never dispatched to Hermes, so the stop finalizes
    // immediately through the fenced terminal transition.
    await adapterB.requestStop((await repoB.get(run.runId))!);

    await waiting; // would hang forever on the old in-process-emitter wait
    expect((await repoA.get(run.runId))?.status).toBe('cancelled');
    expect((await repoA.get(run.runId))?.finishReason).toBe('aborted');
  });

  // -------------------------------------------------------------------------
  // 2. Gap-free under concurrent production
  // -------------------------------------------------------------------------

  test('2. a watch() from seq 0 sees every seq exactly once, in order, while events are still being appended concurrently', async () => {
    const conversationId = await makeConversation();
    const run = await createRun(repoA, conversationId, `meri:${randomUUID()}`);

    const seen: number[] = [];
    const abort = new AbortController();
    const watching = repoB.watch(run.runId, 0, (event) => {
      seen.push(event.seq);
    }, abort.signal, { visibility: 'all', intervalMs: 5 });

    const concurrency = 25;
    await Promise.all(
      Array.from({ length: concurrency }, (_, i) => repoA.append(run.runId, 'message.delta', { i })),
    );
    await finalizeAtomically(prismaA, repoA, run.runId);
    await watching;

    // seq 1 = run.accepted, 2..(1+concurrency) = the concurrent appends,
    // 2+concurrency = the terminal event.
    const expected = Array.from({ length: concurrency + 2 }, (_, i) => i + 1);
    expect(seen).toEqual(expected); // in order, no gaps
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
  });

  // -------------------------------------------------------------------------
  // 3. Pruning-safe recovery
  // -------------------------------------------------------------------------

  test('3. the event cap never prunes above the output snapshot, and recovery from (outputSnapshot, outputSeq) is complete', async () => {
    const conversationId = await makeConversation();
    // SIMPLIFICATION (reported): the production cap is 5 000 events. Inserting
    // 5 000 rows to prove the rule is pure cost, so the existing
    // `maxEventsPerRun` seam is lowered to 8 for this test. The code path
    // exercised is byte-for-byte the production one.
    repoA.maxEventsPerRun = 8;
    try {
      const run = await createRun(repoA, conversationId, `meri:${randomUUID()}`);

      // Phase 1: deltas written the way the adapter's consume() writes them —
      // the event and the (output, outputSeq) snapshot in ONE transaction.
      let output = '';
      const snapshotChunks = 24;
      for (let i = 0; i < snapshotChunks; i += 1) {
        const chunk = `part${i}. `;
        output += chunk;
        const text = output;
        await prismaA.withTenant(tenantId, async (tx) => {
          const event = await repoA.append(
            run.runId,
            'message.delta',
            { delta: chunk, frames: [{ type: 'text', text: chunk }] },
            'public',
            tx,
          );
          await repoA.update(run.runId, { output: text, outputSeq: event.seq }, tx);
        });
      }

      // Phase 2: deltas that have NOT yet been folded into the snapshot. These
      // are the ones the old unconditional prune would happily delete, silently
      // truncating the assistant's answer on recovery.
      const tailChunks = ['tail-a. ', 'tail-b. ', 'tail-c. '];
      for (const chunk of tailChunks) {
        await repoA.append(run.runId, 'message.delta', { delta: chunk, frames: [{ type: 'text', text: chunk }] });
      }

      const record = (await repoA.get(run.runId))!;
      expect(record.output).toBe(output);
      expect(record.outputSeq).toBeGreaterThan(1);

      const all = await repoA.eventsAfter(run.runId, 0, 'all');
      // The cap really did prune (otherwise this test proves nothing).
      expect(all.length).toBeLessThan(1 + snapshotChunks + tailChunks.length);
      expect(all.some((e) => e.seq === 2)).toBe(false); // an early delta is gone
      expect(all.some((e) => e.seq === 1)).toBe(true); // the head is always kept

      // THE INVARIANT: nothing above the snapshot was pruned.
      const aboveSnapshot = all.filter((e) => e.seq > record.outputSeq).map((e) => e.seq);
      const expectedAbove = Array.from({ length: tailChunks.length }, (_, i) => record.outputSeq + 1 + i);
      expect(aboveSnapshot).toEqual(expectedAbove);

      // Recovery exactly as a client does it: snapshot, then `seq > outputSeq`.
      const tail = await repoB.eventsAfter(run.runId, record.outputSeq, 'public');
      const recovered =
        record.output +
        tail
          .filter((e) => e.kind === 'message.delta')
          .map((e) => String(e.payload.delta ?? ''))
          .join('');
      expect(recovered).toBe(output + tailChunks.join(''));
      expect(recovered.startsWith('part0. ')).toBe(true); // not truncated at the head
      expect(recovered.endsWith('tail-c. ')).toBe(true); // not truncated at the tail
    } finally {
      repoA.maxEventsPerRun = 5000;
    }
  });

  // -------------------------------------------------------------------------
  // 4. Terminal-run clarification vs. terminal-run native approval
  // -------------------------------------------------------------------------

  test('4. an unresolved clarification on a TERMINAL run is discoverable and still answerable; a native approval on it is refused explicitly', async () => {
    const conversationId = await makeConversation();
    const run = await createRun(repoA, conversationId, `meri:${randomUUID()}`);

    const clarificationId = `clar_${randomUUID()}`;
    const approvalId = `appr_${randomUUID()}`;
    const clarification: MeriHermesPendingInteraction = {
      requestId: clarificationId,
      kind: 'clarification',
      createdAt: new Date().toISOString(),
      expiresAt: null,
      prompt: 'Which client should I use?',
      choices: ['Acme', 'Globex'],
      multiSelect: false,
      continuation: 'durable_continuation',
      resolution: null,
    };
    const approval: MeriHermesPendingInteraction = {
      ...clarification,
      requestId: approvalId,
      kind: 'approval',
      prompt: 'Run `rm -rf build`?',
      choices: ['once', 'deny'],
      continuation: 'live_process',
    };
    await repoA.addInteraction(run.runId, clarification);
    await repoA.addInteraction(run.runId, approval);
    await finalizeAtomically(prismaA, repoA, run.runId);

    // Discovery (from the OTHER instance) surfaces both, even though the run
    // that produced them is terminal — the run itself is correctly not offered
    // as "active".
    const activity = await repoB.findConversationActivity(tenantId, userId, conversationId);
    expect(activity.run).toBeNull();
    expect(activity.pendingInteractions.map((i) => i.requestId).sort()).toEqual(
      [approvalId, clarificationId].sort(),
    );
    expect(activity.pendingInteractions.every((i) => i.runId === run.runId)).toBe(true);
    expect(activity.pendingInteractions.find((i) => i.requestId === clarificationId)?.continuation).toBe(
      'durable_continuation',
    );

    const adapterB = makeAdapter(prismaB, repoB, Promise.resolve(), 'replica-b');
    const terminalRun = (await repoB.get(run.runId))!;
    expect(terminalRun.status).toBe('completed');

    // The clarification is a durable continuation: answerable after its run ended.
    const answered = await adapterB.answerClarification(terminalRun, clarificationId, 'Acme', userId);
    expect(answered.nextAction).toBe('send_answer_as_next_message');
    const afterAnswer = (await repoB.get(run.runId))!;
    expect(afterAnswer.pendingInteractions.find((i) => i.requestId === clarificationId)?.resolution?.decision).toBe(
      'answered',
    );

    // The native approval is a live-process interaction: refused with an
    // explicit, actionable error rather than a silent no-op.
    await expect(adapterB.resolveApproval(terminalRun, approvalId, 'approve_once', userId)).rejects.toBeInstanceOf(
      ConflictException,
    );
    const afterRefusal = (await repoB.get(run.runId))!;
    expect(afterRefusal.pendingInteractions.find((i) => i.requestId === approvalId)?.resolution ?? null).toBeNull();

    // The answered clarification drops out of discovery; the approval stays.
    const activityAfter = await repoB.findConversationActivity(tenantId, userId, conversationId);
    expect(activityAfter.pendingInteractions.map((i) => i.requestId)).toEqual([approvalId]);
  });

  test('4b. discovery is owner-scoped: another actor sees nothing for the same conversation', async () => {
    const conversationId = await makeConversation();
    const run = await createRun(repoA, conversationId, `meri:${randomUUID()}`);
    await repoA.update(run.runId, { status: 'running' });
    const mine = await repoB.findConversationActivity(tenantId, userId, conversationId);
    expect(mine.run?.runId).toBe(run.runId);
    const theirs = await repoB.findConversationActivity(tenantId, randomUUID(), conversationId);
    expect(theirs.run).toBeNull();
    expect(theirs.pendingInteractions).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 5. Consumer takeover
  // -------------------------------------------------------------------------

  test('5a. exactly one of two concurrent takeover attempts claims a stale consumer lease; the loser observes the winner', async () => {
    const conversationId = await makeConversation();
    const run = await createRun(repoA, conversationId, `meri:${randomUUID()}`);
    await repoA.update(run.runId, {
      status: 'running',
      dispatchStatus: 'dispatched',
      hermesRunId: `hermes-${randomUUID()}`,
    });
    expect(await repoA.claimConsumer(run.runId, 'replica-dead', 60_000)).toBe(true);
    // The owning replica dies: its heartbeat stops advancing.
    await prismaA.withSystem((tx) =>
      tx.meriAgentRun.update({
        where: { id: run.runId },
        data: { consumerHeartbeatAt: new Date(Date.now() - 10 * 60 * 1000) },
      }),
    );

    const [wonA, wonB] = await Promise.all([
      repoA.claimConsumer(run.runId, 'replica-a', 60_000),
      repoB.claimConsumer(run.runId, 'replica-b', 60_000),
    ]);
    expect([wonA, wonB].filter(Boolean)).toHaveLength(1);

    const winner = wonA ? 'replica-a' : 'replica-b';
    const loser = wonA ? 'replica-b' : 'replica-a';
    const after = (await repoB.get(run.runId))!;
    expect(after.consumerId).toBe(winner);
    expect(after.consumerHeartbeatAt).not.toBeNull();
    // The loser observes the winner's claim: its heartbeat is rejected, so it
    // knows to stop rather than double-consume.
    expect(await repoB.heartbeatConsumer(run.runId, loser)).toBe(false);
    expect(await repoA.heartbeatConsumer(run.runId, winner)).toBe(true);
    // A fresh lease is no longer stale, so a third replica cannot barge in.
    expect(await repoB.claimConsumer(run.runId, 'replica-c', 60_000)).toBe(false);
  });

  test('5b. a run that cannot be taken over is finalized `interrupted`, never `completed`', async () => {
    const conversationId = await makeConversation();
    const run = await createRun(repoA, conversationId, `meri:${randomUUID()}`);
    // Dispatched, but with NO hermesRunId: there is no replayable Hermes run to
    // ask about, so the outcome is genuinely unknowable and must be honest.
    await repoA.update(run.runId, { status: 'running', dispatchStatus: 'dispatched' });
    expect(await repoA.claimConsumer(run.runId, 'replica-dead', 60_000)).toBe(true);
    await prismaA.withSystem((tx) =>
      tx.meriAgentRun.update({
        where: { id: run.runId },
        data: { consumerHeartbeatAt: new Date(Date.now() - 10 * 60 * 1000) },
      }),
    );

    const candidates = await repoB.listTakeoverCandidates(60_000);
    expect(candidates.map((c) => c.runId)).toContain(run.runId);

    const adapterB = makeAdapter(prismaB, repoB, Promise.resolve(), 'replica-b');
    const outcome = await adapterB.takeOverRun((await repoB.get(run.runId))!, 60_000);
    expect(outcome).toBe('interrupted');

    const after = (await repoB.get(run.runId))!;
    expect(after.status).toBe('interrupted');
    expect(after.status).not.toBe('completed');
    expect(after.finishReason).toBe('interrupted');
    expect(after.partial).toBe(true);
    expect(after.finishedAt).not.toBeNull();
    // Honest terminal state, not a fabricated success.
    expect(after.error).toContain('never admitted to Hermes');
  });

  // -------------------------------------------------------------------------
  // 6. Request-fingerprint idempotency
  // -------------------------------------------------------------------------

  test('6. an identical resubmission reattaches to the in-flight run (no second run, no second user message); a different body still conflicts', async () => {
    const conversationId = await makeConversation();
    const gate = deferred();
    const adapter = makeAdapter(prismaA, repoA, gate.promise, 'replica-a');
    const body = 'What is the status of the Acme proposal?';

    const first = sseCollector();
    const firstTurn = adapter.streamMessage(actor, conversationId, body, first.sse);

    const runId = await waitFor(async () => {
      const [record] = await repoA.listForConversation(tenantId, userId, conversationId);
      return record && record.dispatchStatus === 'dispatched' ? record.runId : null;
    }, 'the first turn to be dispatched');

    // The retry: same actor, same conversation, same body, same attachments,
    // same mode. Under the old `meri:<userMessageId>` key this minted a second
    // user message and a second run.
    const retry = sseCollector();
    const retryTurn = adapter.streamMessage(actor, conversationId, body, retry.sse);
    await waitFor(async () => retry.frames.some((f) => f.type === 'turn_accepted'), 'the retry to be accepted');

    const runs = await repoA.listForConversation(tenantId, userId, conversationId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.runId).toBe(runId);
    const userMessages = await prismaA.withTenant(tenantId, (tx) =>
      tx.clioMessage.count({ where: { conversationId, role: 'user' } }),
    );
    expect(userMessages).toBe(1);
    // The retry reattached to the SAME user message rather than minting one.
    expect(retry.frames.find((f) => f.type === 'turn_accepted')?.messageId).toBe(runs[0]!.userMessageId);

    // A genuinely different submission to the occupied conversation still hits
    // the single-writer conflict path.
    const other = sseCollector();
    await adapter.streamMessage(actor, conversationId, 'Completely different question about payroll.', other.sse);
    expect(other.frames.some((f) => f.type === 'error' && f.code === 'conversation_occupied')).toBe(true);
    expect(await repoA.listForConversation(tenantId, userId, conversationId)).toHaveLength(1);

    gate.resolve();
    await Promise.all([firstTurn, retryTurn]);
    const finished = (await repoA.get(runId))!;
    expect(finished.status).toBe('completed');
    // Both the original stream and the reattached one saw the terminal frame.
    expect(first.frames.some((f) => f.type === 'done')).toBe(true);
    expect(retry.frames.some((f) => f.type === 'done')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 7. Reconcile reachability
  // -------------------------------------------------------------------------

  test('7. an admitted-but-never-dispatched run is reconciled by the admission path before new work proceeds', async () => {
    const conversationId = await makeConversation();
    const stuck = await createRun(repoA, conversationId, `meri:${randomUUID()}`);
    expect(stuck.dispatchStatus).toBe('pending');
    // The replica died between "admitted" and "dispatch confirmed" an hour ago.
    await prismaA.withSystem((tx) =>
      tx.meriAgentRun.update({
        where: { id: stuck.runId },
        data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) },
      }),
    );
    // Without reconciliation this conversation is occupied forever.
    expect((await repoB.findConversationActivity(tenantId, userId, conversationId)).run?.runId).toBe(stuck.runId);

    const adapter = makeAdapter(prismaA, repoA, Promise.resolve(), 'replica-a');
    const collector = sseCollector();
    await adapter.streamMessage(actor, conversationId, 'A new turn after the crashed dispatch.', collector.sse);

    const reconciled = (await repoA.get(stuck.runId))!;
    expect(reconciled.status).toBe('interrupted');
    expect(reconciled.dispatchStatus).toBe('failed');

    // …and the new turn was admitted rather than rejected as occupied.
    expect(collector.frames.some((f) => f.type === 'error' && f.code === 'conversation_occupied')).toBe(false);
    const runs = await repoA.listForConversation(tenantId, userId, conversationId);
    expect(runs).toHaveLength(2);
    const fresh = runs.find((r) => r.runId !== stuck.runId)!;
    expect(fresh.status).toBe('completed');
    expect(fresh.output).toBe('Final answer from Hermes.');
    // The terminal snapshot points at a real event (P1-08).
    expect(fresh.outputSeq).toBe(fresh.lastSeq);
  });
});
