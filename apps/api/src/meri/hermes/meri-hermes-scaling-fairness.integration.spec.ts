/**
 * S-2 — fairness: global / per-tenant / per-scope concurrency caps with bounded
 * per-tenant queues. Real local Postgres.
 *
 * Runs against the LOCAL fixture database only (container `capiro-postgres`) —
 * never a remote/production database. Two fixture tenants (the noisy-neighbour
 * test needs two), fresh scope ids per test, and every slot row this suite
 * creates is deleted in `afterEach`, so repeated runs are idempotent and safe
 * on a database shared with other local sessions and worktrees.
 *
 * SHARED-DATABASE NOTE. `meri_agent_admission_slots` is the one table here
 * whose GLOBAL row count is meaningful, and that count is shared with anything
 * else using this fixture database. The global-cap test therefore reads the
 * current global count first and sets its cap relative to that baseline,
 * instead of assuming it starts from zero and deleting rows that are not its
 * own. The per-tenant and per-scope tests need no such care: their fixture ids
 * are fresh UUIDs.
 */
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  MeriHermesAdmissionControlService,
  MeriHermesCapacityExhaustedError,
  MeriHermesQueueTimeoutError,
} from './meri-hermes-admission-control.service.js';
import { MeriHermesDbGovernor } from './meri-hermes-db-governor.js';

function assertLocalFixtureDatabase(url: string | undefined): void {
  if (!url) throw new Error('DATABASE_URL is required to run meri-hermes-scaling-fairness.integration.spec.ts');
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error(
      `meri-hermes-scaling-fairness.integration.spec.ts refuses to run against a non-local DATABASE_URL host (${parsed.hostname}). ` +
        'This suite writes and deletes rows and must only ever target the local fixture Postgres.',
    );
  }
}
assertLocalFixtureDatabase(process.env.DATABASE_URL);

describe('S-2 fairness: concurrency caps and bounded queues (real local Postgres)', () => {
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    tenantA = randomUUID();
    tenantB = randomUUID();
    await prisma.withSystem(async (tx) => {
      for (const [id, label] of [
        [tenantA, 'A'],
        [tenantB, 'B'],
      ] as const) {
        await tx.tenant.create({
          data: {
            id,
            slug: `meri-hermes-fairness-spec-${id}`,
            name: `Meri Hermes fairness spec fixture ${label}`,
            status: 'active',
          },
        });
      }
    });
  });

  afterEach(async () => {
    // Only this suite's own rows. Never a blanket DELETE on a shared table.
    await prisma.withSystem(
      (tx) => tx.$executeRaw`
        DELETE FROM meri_agent_admission_slots WHERE tenant_id IN (${tenantA}::uuid, ${tenantB}::uuid)
      `,
    );
  });

  afterAll(async () => {
    for (const id of [tenantA, tenantB]) {
      await prisma.withSystem((tx) => tx.tenant.delete({ where: { id } })).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  function admissionService(overrides: Record<string, string>): MeriHermesAdmissionControlService {
    const governor = new MeriHermesDbGovernor();
    governor.env = { ...process.env, MERI_HERMES_DB_MAX_CONCURRENCY: '24' };
    const service = new MeriHermesAdmissionControlService(prisma, governor);
    service.env = { ...process.env, ...overrides };
    return service;
  }

  const ROOMY = {
    MERI_HERMES_MAX_CONCURRENT_RUNS_GLOBAL: '64',
    MERI_HERMES_MAX_CONCURRENT_RUNS_TENANT: '64',
    MERI_HERMES_MAX_CONCURRENT_RUNS_SCOPE: '64',
    MERI_HERMES_TENANT_QUEUE_DEPTH: '64',
  };

  function slot(tenantId: string, scopeId: string) {
    return { runId: randomUUID(), tenantId, scopeId, conversationId: randomUUID() };
  }

  // -------------------------------------------------------------------------

  test('1. PER-SCOPE cap: a third run in one execution scope queues rather than running, and is promoted when a slot frees', async () => {
    const admission = admissionService({ ...ROOMY, MERI_HERMES_MAX_CONCURRENT_RUNS_SCOPE: '2' });
    const scopeId = `tenant:${tenantA}:user:${randomUUID()}`;

    const first = await admission.admit(slot(tenantA, scopeId));
    const second = await admission.admit(slot(tenantA, scopeId));
    const third = await admission.admit(slot(tenantA, scopeId));

    expect(first.state).toBe('active');
    expect(second.state).toBe('active');
    expect(third.state).toBe('queued');
    expect(third.queuePosition).toBe(1);

    // The queued state is discoverable, not implicit.
    await expect(admission.slotState(third.runId)).resolves.toEqual({ state: 'queued', queuePosition: 1 });

    const release = await admission.release(first.runId);
    expect(release.released).toBe(true);
    expect(release.promoted).toEqual([third.runId]);
    await expect(admission.slotState(third.runId)).resolves.toEqual({ state: 'active', queuePosition: null });
  });

  test('2. PER-TENANT cap binds across DIFFERENT scopes of the same tenant', async () => {
    const admission = admissionService({
      ...ROOMY,
      MERI_HERMES_MAX_CONCURRENT_RUNS_TENANT: '2',
      MERI_HERMES_MAX_CONCURRENT_RUNS_SCOPE: '2',
    });
    const results = [];
    for (let i = 0; i < 3; i += 1) {
      results.push(await admission.admit(slot(tenantA, `tenant:${tenantA}:user:${randomUUID()}`)));
    }
    expect(results.map((r) => r.state)).toEqual(['active', 'active', 'queued']);
  });

  test('3. GLOBAL cap binds across tenants, measured against the live global count rather than an assumed empty table', async () => {
    const baselineProbe = admissionService(ROOMY);
    const baseline = (await baselineProbe.counts(randomUUID(), 'probe')).globalActive;
    const admission = admissionService({
      ...ROOMY,
      MERI_HERMES_MAX_CONCURRENT_RUNS_GLOBAL: String(baseline + 2),
    });

    const a1 = await admission.admit(slot(tenantA, `tenant:${tenantA}:user:${randomUUID()}`));
    const b1 = await admission.admit(slot(tenantB, `tenant:${tenantB}:user:${randomUUID()}`));
    const b2 = await admission.admit(slot(tenantB, `tenant:${tenantB}:user:${randomUUID()}`));

    expect(a1.state).toBe('active');
    expect(b1.state).toBe('active');
    // Neither tenant nor scope is anywhere near its own cap: this one is
    // stopped by the global ceiling alone.
    expect(b2.state).toBe('queued');
  });

  test('4. beyond the bounded queue, admission is REFUSED with an actionable conflict — nothing is dropped and no extra row is written', async () => {
    const admission = admissionService({
      ...ROOMY,
      MERI_HERMES_MAX_CONCURRENT_RUNS_SCOPE: '1',
      MERI_HERMES_TENANT_QUEUE_DEPTH: '2',
    });
    const scopeId = `tenant:${tenantA}:user:${randomUUID()}`;
    await admission.admit(slot(tenantA, scopeId)); // active
    await admission.admit(slot(tenantA, scopeId)); // queued 1
    await admission.admit(slot(tenantA, scopeId)); // queued 2

    const refusal = await admission.admit(slot(tenantA, scopeId)).catch((e) => e);
    expect(refusal).toBeInstanceOf(MeriHermesCapacityExhaustedError);
    const error = refusal as MeriHermesCapacityExhaustedError;
    expect(error.code).toBe('hermes_capacity_exhausted');
    expect(error.counts.tenantQueued).toBe(2);
    expect(error.message).toMatch(/waiting queue for this workspace is full/);
    expect(error.message).toMatch(/Nothing was started and nothing was charged/);
    expect(error.message).toMatch(/Stop a run you no longer need/);

    // Exactly the three that were accepted. The refused one left no trace, and
    // no accepted one was silently discarded to make room for it.
    const rows = await prisma.withSystem((tx) =>
      tx.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM meri_agent_admission_slots WHERE tenant_id = ${tenantA}::uuid
      `,
    );
    expect(Number(rows[0]!.count)).toBe(3);
  });

  test('5. NOISY TENANT: one tenant saturating its own cap AND filling its queue does not block another tenant', async () => {
    const admission = admissionService({
      MERI_HERMES_MAX_CONCURRENT_RUNS_GLOBAL: '64',
      MERI_HERMES_MAX_CONCURRENT_RUNS_TENANT: '4',
      MERI_HERMES_MAX_CONCURRENT_RUNS_SCOPE: '4',
      MERI_HERMES_TENANT_QUEUE_DEPTH: '8',
    });

    // Tenant A goes as noisy as the envelope lets it: 4 active + 8 queued.
    const noisy = [];
    for (let i = 0; i < 12; i += 1) {
      noisy.push(await admission.admit(slot(tenantA, `tenant:${tenantA}:user:${randomUUID()}`)));
    }
    expect(noisy.filter((r) => r.state === 'active')).toHaveLength(4);
    expect(noisy.filter((r) => r.state === 'queued')).toHaveLength(8);
    // And it cannot take any more than that — its own queue is the wall.
    await expect(admission.admit(slot(tenantA, `tenant:${tenantA}:user:${randomUUID()}`))).rejects.toBeInstanceOf(
      MeriHermesCapacityExhaustedError,
    );

    // Tenant B, arriving after all of that, starts IMMEDIATELY. It is not
    // queued behind A's twelve, and it is not refused.
    const quiet = await admission.admit(slot(tenantB, `tenant:${tenantB}:user:${randomUUID()}`));
    expect(quiet.state).toBe('active');
    expect(quiet.queuePosition).toBeNull();
    // `counts` reports the state AFTER the decision: B now has exactly the
    // one run it just started, and none of A's twelve are B's problem.
    expect(quiet.counts.tenantActive).toBe(1);

    // And B's second run is admitted too, still while A is saturated.
    const quiet2 = await admission.admit(slot(tenantB, `tenant:${tenantB}:user:${randomUUID()}`));
    expect(quiet2.state).toBe('active');
  });

  test('6. promotion is OLDEST-WAITING FIRST, as decisions.md §4 declares', async () => {
    const admission = admissionService({ ...ROOMY, MERI_HERMES_MAX_CONCURRENT_RUNS_SCOPE: '1' });
    const scopeId = `tenant:${tenantA}:user:${randomUUID()}`;
    const active = await admission.admit(slot(tenantA, scopeId));
    const oldest = await admission.admit(slot(tenantA, scopeId));
    // Distinct queued_at values: the ordering is by time, and two inserts in
    // the same millisecond would make the assertion about nothing.
    await new Promise((r) => setTimeout(r, 15));
    const newest = await admission.admit(slot(tenantA, scopeId));
    expect([oldest.state, newest.state]).toEqual(['queued', 'queued']);
    expect(newest.queuePosition).toBe(2);

    const release = await admission.release(active.runId);
    expect(release.promoted).toEqual([oldest.runId]);
    await expect(admission.slotState(newest.runId)).resolves.toEqual({ state: 'queued', queuePosition: 1 });
  });

  test('7. a queued run WAITS and then starts: awaitActivation reports its position while waiting and resolves on promotion', async () => {
    const admission = admissionService({
      ...ROOMY,
      MERI_HERMES_MAX_CONCURRENT_RUNS_SCOPE: '1',
      MERI_HERMES_QUEUE_WAIT_MS: '5000',
      MERI_HERMES_QUEUE_POLL_MS: '20',
    });
    const scopeId = `tenant:${tenantA}:user:${randomUUID()}`;
    const active = await admission.admit(slot(tenantA, scopeId));
    const waiter = await admission.admit(slot(tenantA, scopeId));
    expect(waiter.state).toBe('queued');

    const positions: Array<number | null> = [];
    const waiting = admission.awaitActivation(waiter.runId, { onWait: (p) => positions.push(p) });
    // Free the slot a moment later, the way a finishing run does.
    setTimeout(() => void admission.release(active.runId), 60);

    await expect(waiting).resolves.toMatchObject({ activated: true });
    expect(positions.length).toBeGreaterThan(0);
    expect(positions[0]).toBe(1);
  });

  test('8. a queue wait that times out RELEASES its place instead of leaking capacity, and says so', async () => {
    const admission = admissionService({
      ...ROOMY,
      MERI_HERMES_MAX_CONCURRENT_RUNS_SCOPE: '1',
      MERI_HERMES_QUEUE_WAIT_MS: '120',
      MERI_HERMES_QUEUE_POLL_MS: '20',
    });
    const scopeId = `tenant:${tenantA}:user:${randomUUID()}`;
    await admission.admit(slot(tenantA, scopeId));
    const waiter = await admission.admit(slot(tenantA, scopeId));

    const error = await admission.awaitActivation(waiter.runId).catch((e) => e);
    expect(error).toBeInstanceOf(MeriHermesQueueTimeoutError);
    expect((error as MeriHermesQueueTimeoutError).code).toBe('hermes_queue_timeout');
    expect((error as MeriHermesQueueTimeoutError).message).toMatch(/nothing was charged/i);
    // The place in the queue is gone — a caller that gave up does not keep one.
    await expect(admission.slotState(waiter.runId)).resolves.toBeNull();
  });

  test('9. a slot whose holder stopped heart-beating is REAPED, and the reclaimed capacity promotes a waiter', async () => {
    const admission = admissionService({
      ...ROOMY,
      MERI_HERMES_MAX_CONCURRENT_RUNS_SCOPE: '1',
      MERI_HERMES_SLOT_STALE_MS: '1000',
      // Long enough that the waiter below is nowhere near ITS backstop when we
      // look 60 s into the future — the point of the test is that the dead
      // ACTIVE holder is reaped and the healthy WAITER is not.
      MERI_HERMES_QUEUE_WAIT_MS: '600000',
    });
    const scopeId = `tenant:${tenantA}:user:${randomUUID()}`;
    const dead = await admission.admit(slot(tenantA, scopeId));
    const waiter = await admission.admit(slot(tenantA, scopeId));
    expect(waiter.state).toBe('queued');

    // Nothing reaped while the holder is fresh.
    expect((await admission.reapStaleSlots()).reaped).toBe(0);

    // Now look at the world from far enough in the future that the holder's
    // heartbeat is stale. (`reapStaleSlots` takes `now` precisely so this does
    // not need a sleep.)
    const later = new Date(Date.now() + 60_000);
    const reap = await admission.reapStaleSlots(later);
    // Exactly one: the dead active holder. The queued waiter is NOT reaped —
    // nobody heartbeats a queued slot, so reaping it on the heartbeat rule
    // would evict a run that is waiting exactly as designed.
    expect(reap.reaped).toBe(1);
    expect(reap.promoted).toContain(waiter.runId);
    await expect(admission.slotState(dead.runId)).resolves.toBeNull();
    await expect(admission.slotState(waiter.runId)).resolves.toEqual({ state: 'active', queuePosition: null });
  });

  test('10. admission is IDEMPOTENT by run id: a resubmit gets its own slot back and consumes no second unit of capacity', async () => {
    const admission = admissionService({ ...ROOMY, MERI_HERMES_MAX_CONCURRENT_RUNS_SCOPE: '2' });
    const scopeId = `tenant:${tenantA}:user:${randomUUID()}`;
    const args = slot(tenantA, scopeId);

    const first = await admission.admit(args);
    const again = await admission.admit(args);
    expect(first.state).toBe('active');
    expect(again).toMatchObject({ state: 'active', reused: true });

    expect((await admission.counts(tenantA, scopeId)).scopeActive).toBe(1);
  });

  test('11. this service COMPOSES WITH the conversation invariant rather than duplicating it: two runs on one conversation are not its business', async () => {
    const admission = admissionService({ ...ROOMY, MERI_HERMES_MAX_CONCURRENT_RUNS_SCOPE: '2' });
    const scopeId = `tenant:${tenantA}:user:${randomUUID()}`;
    const conversationId = randomUUID();

    const first = await admission.admit({ runId: randomUUID(), tenantId: tenantA, scopeId, conversationId });
    const second = await admission.admit({ runId: randomUUID(), tenantId: tenantA, scopeId, conversationId });

    // Both get capacity. That is CORRECT and deliberate: "one active run per
    // conversation" is enforced by the durable run repository
    // (`meri_agent_runs_conversation_single_writer_idx` + the conversation
    // advisory lock in `create()`, proved by
    // meri-hermes-prisma-run-repository.spec.ts test 2), and the adapter calls
    // that BEFORE it asks for capacity. A second owner of the same rule here
    // would be a second source of truth, not defence in depth.
    expect([first.state, second.state]).toEqual(['active', 'active']);
  });

  test('12. concurrent admissions do not oversubscribe: 10 racing admissions against a scope cap of 3 produce exactly 3 active', async () => {
    const admission = admissionService({
      ...ROOMY,
      MERI_HERMES_MAX_CONCURRENT_RUNS_SCOPE: '3',
      MERI_HERMES_TENANT_QUEUE_DEPTH: '32',
    });
    const scopeId = `tenant:${tenantA}:user:${randomUUID()}`;

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => admission.admit(slot(tenantA, scopeId))),
    );
    expect(outcomes.filter((o) => o.state === 'active')).toHaveLength(3);
    expect(outcomes.filter((o) => o.state === 'queued')).toHaveLength(7);
    expect((await admission.counts(tenantA, scopeId)).scopeActive).toBe(3);
  });
});
