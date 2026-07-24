import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import { RunsService } from './runs.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { CreateRunDto, TransitionRunDto } from './dto/agents.dto.js';

/*
 * RunsService lifecycle tests against an in-memory fake tx (adapted from the
 * meri.service.spec.ts makeStore/makeTx pattern). RunsService is constructed
 * from (prisma, versioning) ONLY — there is no orchestrator/LLM collaborator
 * to stub, so driving queued -> ... -> completed here proves the whole Stage C
 * run lifecycle needs ZERO LLM calls. Uses the REAL VersioningService so the
 * activity + transactional-outbox writes hit the fake tx exactly as in prod.
 * withTenantUser/withTenant snapshot+restore the store on throw, modelling the
 * real $transaction rollback.
 */

interface Rec {
  [k: string]: unknown;
  id: string;
}

const T = 'tenant-1';
const U = 'user-1';

function makeStore() {
  const missions = new Map<string, Rec>();
  const strategies = new Map<string, Rec>();
  const runs = new Map<string, Rec>();
  const activity: Rec[] = [];
  const outbox: Rec[] = [];
  let seq = 0;
  const nextId = (p: string) => `${p}-${++seq}`;
  // Test seams for the race tests (unset for every other test):
  // - afterRunFindFirst: fires right after a spAgentRun.findFirst result is
  //   materialized, modelling "another tx commits between our read and write".
  // - onMissionLock: fires when createRun's SELECT ... FOR UPDATE mission gate
  //   acquires the row lock, modelling a mission PATCH that committed while
  //   the locked read waited (Postgres re-evaluates the row post-commit, so
  //   the gate sees the NEW state).
  const hooks: { afterRunFindFirst?: () => void; onMissionLock?: () => void } = {};
  return { missions, strategies, runs, activity, outbox, nextId, hooks };
}
type Store = ReturnType<typeof makeStore>;

function seedStrategy(store: Store, id: string): void {
  store.strategies.set(id, { id, tenantId: T });
}

function seedMission(store: Store, id: string, state: string): void {
  store.missions.set(id, {
    id,
    tenantId: T,
    strategyId: 'S1',
    clientId: null,
    name: 'Watch the plan',
    description: null,
    state,
    cadence: null,
    nextRunAt: null,
    createdByUserId: U,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
  });
}

function makeTx(store: Store) {
  const now = new Date();
  // createRun's SELECT ... FOR UPDATE mission gate (raw SQL bypasses the model
  // hook, so the service passes tenant_id explicitly). Tagged-template args:
  // values = [missionId, tenantId]. Row locking is a no-op in-memory.
  const $queryRaw = async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const [missionId, tenantId] = values as [string, string];
    // Lock granted — the hook models a concurrent writer that committed while
    // we waited; the locked read below then sees the NEW committed row state.
    store.hooks.onMissionLock?.();
    const m = store.missions.get(missionId);
    return m && m.tenantId === tenantId
      ? [{ id: m.id, state: m.state, strategyId: m.strategyId }]
      : [];
  };
  const spAgentMission = {
    findFirst: async ({ where }: { where: { id: string } }) => store.missions.get(where.id) ?? null,
  };
  // Tenant-scoped in prod (RLS/query hook); the fake store only ever holds
  // tenant-1 rows, so a miss models both "nonexistent" and "other tenant".
  const spStrategy = {
    findFirst: async ({ where }: { where: { id: string } }) =>
      store.strategies.get(where.id) ?? null,
  };
  const spAgentRun = {
    create: async ({ data }: { data: Rec }) => {
      const dup = [...store.runs.values()].some(
        (r) => r.tenantId === data.tenantId && r.idempotencyKey === data.idempotencyKey,
      );
      if (dup) {
        // @@unique([tenantId, idempotencyKey]) violation. The service detects it
        // via `err instanceof Prisma.PrismaClientKnownRequestError && err.code
        // === 'P2002'` (runs.service.ts catch), so a bare {code} object is not
        // enough — graft the class prototype onto the plain Error carrying the
        // code so BOTH halves of the check pass without invoking Prisma's
        // constructor.
        const err = Object.assign(new Error('unique'), { code: 'P2002' });
        Object.setPrototypeOf(err, Prisma.PrismaClientKnownRequestError.prototype);
        throw err;
      }
      const id = store.nextId('run');
      const rec: Rec = {
        // Schema defaults the service relies on (sp_agent_run):
        state: 'queued',
        startedAt: null,
        finishedAt: null,
        findings: null,
        waitingReason: null,
        error: null,
        ...data,
        id,
        createdAt: now,
        updatedAt: now,
      };
      store.runs.set(id, rec);
      return rec;
    },
    findFirst: async ({ where }: { where: { id?: string; idempotencyKey?: string } }) => {
      const rec =
        [...store.runs.values()].find(
          (r) =>
            (where.id === undefined || r.id === where.id) &&
            (where.idempotencyKey === undefined || r.idempotencyKey === where.idempotencyKey),
        ) ?? null;
      // Copy BEFORE the hook fires so a hook-simulated concurrent commit
      // cannot leak into the already-materialized read (READ COMMITTED: the
      // caller keeps the state as of ITS read, not the racer's commit).
      const out = rec ? { ...rec } : null;
      store.hooks.afterRunFindFirst?.();
      return out;
    },
    // CAS write the service uses for transitions: the where carries the
    // expected state; a mismatch is count 0, exactly like Postgres
    // re-evaluating the predicate against the committed row.
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; state?: string };
      data: Rec;
    }) => {
      const rec = store.runs.get(where.id);
      if (!rec || (where.state !== undefined && rec.state !== where.state)) {
        return { count: 0 };
      }
      store.runs.set(where.id, { ...rec, ...data, updatedAt: now });
      return { count: 1 };
    },
  };
  const spActivityLog = {
    create: async ({ data }: { data: Rec }) => {
      store.activity.push({ ...data, id: store.nextId('activity') });
    },
  };
  const spEventOutbox = {
    create: async ({ data }: { data: Rec }) => {
      store.outbox.push({ ...data, id: store.nextId('outbox') });
    },
  };
  return {
    $queryRaw,
    spAgentMission,
    spStrategy,
    spAgentRun,
    spActivityLog,
    spEventOutbox,
  } as unknown as Prisma.TransactionClient;
}

function makeService(store: Store) {
  const snapshot = () => ({
    missions: new Map(store.missions),
    strategies: new Map(store.strategies),
    runs: new Map(store.runs),
    activity: [...store.activity],
    outbox: [...store.outbox],
  });
  const restore = (snap: ReturnType<typeof snapshot>) => {
    store.missions = snap.missions;
    store.strategies = snap.strategies;
    store.runs = snap.runs;
    store.activity = snap.activity;
    store.outbox = snap.outbox;
  };
  // Both tx entry points model the $transaction: snapshot, run, roll back on throw.
  const inTx = async (fn: (tx: unknown) => Promise<unknown>) => {
    const snap = snapshot();
    try {
      return await fn(makeTx(store));
    } catch (e) {
      restore(snap);
      throw e;
    }
  };
  const withTenantUser = jest.fn(
    async (_t: string, _u: string, fn: (tx: unknown) => Promise<unknown>) => inTx(fn),
  );
  const withTenant = jest.fn(async (_t: string, fn: (tx: unknown) => Promise<unknown>) => inTx(fn));
  const prisma = { withTenantUser, withTenant } as unknown as PrismaService;
  const svc = new RunsService(prisma, new VersioningService());
  return { svc, withTenantUser, withTenant };
}

describe('RunsService.createRun', () => {
  it('rejects a run on an inactive (draft) mission and persists nothing', async () => {
    const store = makeStore();
    seedMission(store, 'M1', 'draft');
    const { svc } = makeService(store);

    const err = await svc
      .createRun(T, U, 'M1', { trigger: 'manual', idempotencyKey: 'k1' } as CreateRunDto)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(/not active/);
    expect(store.runs.size).toBe(0);
    expect(store.activity).toHaveLength(0);
    expect(store.outbox).toHaveLength(0);
  });

  it('concurrent cancel: a mission PATCH committing while createRun waits on the FOR UPDATE row lock is seen — no run minted on the canceled mission', async () => {
    // The Stage C create/cancel race: the scheduler's createRun and a user
    // cancel land together. The mission gate reads under SELECT ... FOR
    // UPDATE, so when the racing cancel commits first the locked read returns
    // 'canceled' — an unlocked findFirst would have kept the stale 'active'
    // snapshot and minted a queued run on the canceled mission (which run
    // transitions never re-check).
    const store = makeStore();
    seedMission(store, 'M1', 'active');
    store.hooks.onMissionLock = () => {
      store.hooks.onMissionLock = undefined; // one-shot
      // Mutate the shared rec in place so the "commit" survives the loser's
      // snapshot rollback (the snapshot shallow-copies the map).
      store.missions.get('M1')!.state = 'canceled';
    };
    const { svc } = makeService(store);

    const err = await svc
      .createRun(T, null, 'M1', {
        trigger: 'scheduled',
        idempotencyKey: 'race-create-1',
      } as CreateRunDto)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(/not active/);
    expect(store.runs.size).toBe(0);
    expect(store.activity).toHaveLength(0);
    expect(store.outbox).toHaveLength(0);
  });

  it('idempotent replay: the same idempotencyKey returns the SAME run — one row, one run.created activity', async () => {
    const store = makeStore();
    seedMission(store, 'M1', 'active');
    const { svc } = makeService(store);
    const dto = { trigger: 'manual', idempotencyKey: 'trigger-abc' } as CreateRunDto;

    const first = await svc.createRun(T, U, 'M1', dto);
    const replay = await svc.createRun(T, U, 'M1', dto);

    expect(replay.id).toBe(first.id);
    expect(store.runs.size).toBe(1);
    // The failed second INSERT rolled back — no duplicate audit trail either.
    expect(store.activity.filter((a) => a.action === 'run.created')).toHaveLength(1);
    expect(store.outbox.filter((o) => o.type === 'run.created')).toHaveLength(1);
  });

  it('rejects an idempotencyKey reused on a DIFFERENT mission with 409 — never returns the other mission\'s run', async () => {
    // @@unique([tenantId, idempotencyKey]) is tenant-wide, not per-mission: a
    // key collision from another mission must NOT read as an idempotent replay,
    // or the caller (e.g. the F2 scheduler) would get a 200 with M1's run and
    // mis-associate state with M2.
    const store = makeStore();
    seedMission(store, 'M1', 'active');
    seedMission(store, 'M2', 'active');
    const { svc } = makeService(store);
    const key = 'shared-key';

    const first = await svc.createRun(T, U, 'M1', {
      trigger: 'manual',
      idempotencyKey: key,
    } as CreateRunDto);
    expect(first.missionId).toBe('M1');

    const err = await svc
      .createRun(T, U, 'M2', { trigger: 'manual', idempotencyKey: key } as CreateRunDto)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/different mission/);
    // Only M1's run survives; the failed M2 attempt left no row or audit trail.
    expect(store.runs.size).toBe(1);
    expect([...store.runs.values()][0]!.missionId).toBe('M1');
    expect(store.activity.filter((a) => a.action === 'run.created')).toHaveLength(1);
    expect(store.outbox.filter((o) => o.type === 'run.created')).toHaveLength(1);
  });

  it('rejects a dto.strategyId the tenant does not own (no spStrategy row) and persists nothing', async () => {
    // SpAgentRun.strategyId has no FK — without the in-tx tenant-scoped check
    // a random / cross-tenant UUID (it passes @IsUUID) would commit and later
    // per-strategy scoping (Watcher context, change-set linkage, listings)
    // would report against the wrong strategy.
    const store = makeStore();
    seedMission(store, 'M1', 'active');
    const { svc } = makeService(store);

    const err = await svc
      .createRun(T, U, 'M1', {
        trigger: 'manual',
        idempotencyKey: 'bad-strat-1',
        strategyId: 'not-this-tenants-strategy',
      } as CreateRunDto)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(/Unknown strategy/);
    expect(store.runs.size).toBe(0);
    expect(store.activity).toHaveLength(0);
    expect(store.outbox).toHaveLength(0);
  });

  it('accepts an in-tenant dto.strategyId override; omitting it falls back to mission.strategyId', async () => {
    const store = makeStore();
    seedMission(store, 'M1', 'active'); // mission.strategyId = 'S1'
    seedStrategy(store, 'S2');
    const { svc } = makeService(store);

    const overridden = await svc.createRun(T, U, 'M1', {
      trigger: 'manual',
      idempotencyKey: 'strat-override-1',
      strategyId: 'S2',
    } as CreateRunDto);
    expect(overridden.strategyId).toBe('S2');

    const defaulted = await svc.createRun(T, U, 'M1', {
      trigger: 'manual',
      idempotencyKey: 'strat-default-1',
    } as CreateRunDto);
    expect(defaulted.strategyId).toBe('S1');
  });

  it('attributes person-triggered runs: actorUserId set, authorKind person', async () => {
    const store = makeStore();
    seedMission(store, 'M1', 'active');
    const { svc, withTenantUser } = makeService(store);

    const run = await svc.createRun(T, U, 'M1', {
      trigger: 'manual',
      idempotencyKey: 'person-1',
    } as CreateRunDto);

    expect(run.createdByUserId).toBe(U);
    expect(withTenantUser).toHaveBeenCalled();
    const row = store.activity.find((a) => a.action === 'run.created')!;
    expect(row.actorUserId).toBe(U);
    expect(row.authorKind).toBe('person');
  });

  it('attributes system-triggered runs (userId null): authorKind meri, null actor, withTenant (not withTenantUser)', async () => {
    const store = makeStore();
    seedMission(store, 'M1', 'active');
    const { svc, withTenantUser, withTenant } = makeService(store);

    const run = await svc.createRun(T, null, 'M1', {
      trigger: 'scheduled',
      idempotencyKey: 'sched-1',
    } as CreateRunDto);

    expect(run.createdByUserId).toBeNull();
    expect(withTenantUser).not.toHaveBeenCalled();
    expect(withTenant).toHaveBeenCalled();
    const row = store.activity.find((a) => a.action === 'run.created')!;
    expect(row.actorUserId).toBeNull();
    expect(row.authorKind).toBe('meri');
  });
});

describe('RunsService.transition', () => {
  it('drives the full lifecycle queued->planning->executing->ready_for_review->completed with zero LLM calls, stamping startedAt/finishedAt', async () => {
    const store = makeStore();
    seedMission(store, 'M1', 'active');
    const { svc } = makeService(store);

    const run = await svc.createRun(T, U, 'M1', {
      trigger: 'manual',
      idempotencyKey: 'lifecycle-1',
    } as CreateRunDto);
    expect(run.state).toBe('queued');
    expect(run.startedAt).toBeNull();
    expect(run.finishedAt).toBeNull();

    const planning = await svc.transition(T, U, run.id, { to: 'planning' } as TransitionRunDto);
    expect(planning.state).toBe('planning');
    expect(planning.startedAt).toBeInstanceOf(Date); // stamped on entering planning
    expect(planning.finishedAt).toBeNull();

    const executing = await svc.transition(T, U, run.id, { to: 'executing' } as TransitionRunDto);
    expect(executing.state).toBe('executing');

    const review = await svc.transition(T, U, run.id, {
      to: 'ready_for_review',
    } as TransitionRunDto);
    expect(review.state).toBe('ready_for_review');
    expect(review.finishedAt).toBeNull(); // not terminal yet

    const done = await svc.transition(T, U, run.id, { to: 'completed' } as TransitionRunDto);
    expect(done.state).toBe('completed');
    expect(done.finishedAt).toBeInstanceOf(Date); // stamped on the terminal move
    expect(done.startedAt).toEqual(planning.startedAt); // never re-stamped

    // Audit trail: 1 create + 4 transitions, each mirrored to the outbox.
    expect(store.activity.filter((a) => a.action === 'run.transitioned')).toHaveLength(4);
    expect(store.outbox.filter((o) => o.type === 'run.transitioned')).toHaveLength(4);
  });

  it('waiting_for_input stores the waitingReason', async () => {
    const store = makeStore();
    seedMission(store, 'M1', 'active');
    const { svc } = makeService(store);
    const run = await svc.createRun(T, U, 'M1', {
      trigger: 'manual',
      idempotencyKey: 'wait-1',
    } as CreateRunDto);
    await svc.transition(T, U, run.id, { to: 'planning' } as TransitionRunDto);

    const waiting = await svc.transition(T, U, run.id, {
      to: 'waiting_for_input',
      waitingReason: 'needs the FY27 budget memo',
    } as TransitionRunDto);

    expect(waiting.state).toBe('waiting_for_input');
    expect(waiting.waitingReason).toBe('needs the FY27 budget memo');
    expect(waiting.finishedAt).toBeNull(); // waiting is NOT terminal
  });

  it('clears waitingReason when the run leaves waiting_for_input and stays clear through completion', async () => {
    const store = makeStore();
    seedMission(store, 'M1', 'active');
    const { svc } = makeService(store);
    const run = await svc.createRun(T, U, 'M1', {
      trigger: 'manual',
      idempotencyKey: 'resume-1',
    } as CreateRunDto);
    await svc.transition(T, U, run.id, { to: 'planning' } as TransitionRunDto);
    const waiting = await svc.transition(T, U, run.id, {
      to: 'waiting_for_input',
      waitingReason: 'needs the FY27 budget memo',
    } as TransitionRunDto);
    expect(waiting.waitingReason).toBe('needs the FY27 budget memo');

    // Input arrives — the resumed run must no longer read as blocked.
    const resumed = await svc.transition(T, U, run.id, { to: 'executing' } as TransitionRunDto);
    expect(resumed.state).toBe('executing');
    expect(resumed.waitingReason).toBeNull();

    const review = await svc.transition(T, U, run.id, {
      to: 'ready_for_review',
    } as TransitionRunDto);
    expect(review.waitingReason).toBeNull();
    const done = await svc.transition(T, U, run.id, { to: 'completed' } as TransitionRunDto);
    expect(done.waitingReason).toBeNull();
  });

  it('findings shallow-merge accumulates keys across transitions; a later same-key write replaces only that key', async () => {
    const store = makeStore();
    seedMission(store, 'M1', 'active');
    const { svc } = makeService(store);
    const run = await svc.createRun(T, U, 'M1', {
      trigger: 'manual',
      idempotencyKey: 'findings-1',
    } as CreateRunDto);

    const planning = await svc.transition(T, U, run.id, {
      to: 'planning',
      findings: { stale_nodes: ['n1'] },
    } as TransitionRunDto);
    expect(planning.findings).toEqual({ stale_nodes: ['n1'] });

    const waiting = await svc.transition(T, U, run.id, {
      to: 'waiting_for_input',
      findings: { conflicts: ['c1'] },
    } as TransitionRunDto);
    // Earlier keys survive a later findings write (accumulate, not replace).
    expect(waiting.findings).toEqual({ stale_nodes: ['n1'], conflicts: ['c1'] });

    const resumed = await svc.transition(T, U, run.id, {
      to: 'executing',
      findings: { conflicts: ['c1', 'c2'] },
    } as TransitionRunDto);
    // A same-key write replaces just that key; sibling keys are untouched.
    expect(resumed.findings).toEqual({ stale_nodes: ['n1'], conflicts: ['c1', 'c2'] });
  });

  it('failed stores the error and stamps finishedAt', async () => {
    const store = makeStore();
    seedMission(store, 'M1', 'active');
    const { svc } = makeService(store);
    const run = await svc.createRun(T, U, 'M1', {
      trigger: 'manual',
      idempotencyKey: 'fail-1',
    } as CreateRunDto);
    await svc.transition(T, U, run.id, { to: 'planning' } as TransitionRunDto);

    const failed = await svc.transition(T, U, run.id, {
      to: 'failed',
      error: 'orchestrator exploded',
    } as TransitionRunDto);

    expect(failed.state).toBe('failed');
    expect(failed.error).toBe('orchestrator exploded');
    expect(failed.finishedAt).toBeInstanceOf(Date);
  });

  it('rejects the illegal jump queued->executing with a BadRequest naming both states and mutates nothing', async () => {
    const store = makeStore();
    seedMission(store, 'M1', 'active');
    const { svc } = makeService(store);
    const run = await svc.createRun(T, U, 'M1', {
      trigger: 'manual',
      idempotencyKey: 'jump-1',
    } as CreateRunDto);

    const err = await svc
      .transition(T, U, run.id, { to: 'executing' } as TransitionRunDto)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(/from 'queued' to 'executing'/);
    expect(store.runs.get(run.id)!.state).toBe('queued');
    expect(store.activity.filter((a) => a.action === 'run.transitioned')).toHaveLength(0);
  });

  it('CAS: losing a race to a concurrent cancel yields 409, never resurrecting the terminal run', async () => {
    // The read-validate-write race: orchestrator (planning->executing) reads
    // state='planning'; a user cancel COMMITS before the orchestrator's UPDATE
    // lands. Without state in the UPDATE's where, the stale write would flip a
    // canceled (terminal) run back to 'executing' — and the audit trail would
    // show only an innocuous planning->executing hop.
    const store = makeStore();
    seedMission(store, 'M1', 'active');
    const { svc } = makeService(store);
    const run = await svc.createRun(T, U, 'M1', {
      trigger: 'manual',
      idempotencyKey: 'race-1',
    } as CreateRunDto);
    await svc.transition(T, U, run.id, { to: 'planning' } as TransitionRunDto);

    // Simulate the cancel committing right after the loser's read. Mutate the
    // shared rec IN PLACE: the loser's snapshot-rollback shallow-copies the
    // map, so an in-place commit survives it — like a separate committed tx.
    const canceledAt = new Date('2026-07-23T12:00:00.000Z');
    store.hooks.afterRunFindFirst = () => {
      store.hooks.afterRunFindFirst = undefined; // one-shot
      Object.assign(store.runs.get(run.id)!, { state: 'canceled', finishedAt: canceledAt });
    };

    const err = await svc
      .transition(T, U, run.id, { to: 'executing' } as TransitionRunDto)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/changed concurrently/);
    // The terminal run stays canceled — not resurrected, finishedAt untouched.
    const final = store.runs.get(run.id)!;
    expect(final.state).toBe('canceled');
    expect(final.finishedAt).toBe(canceledAt);
    // And no planning->executing activity row papers over the lost race.
    expect(
      store.activity.filter(
        (a) =>
          a.action === 'run.transitioned' &&
          (a.after as { state?: string } | null)?.state === 'executing',
      ),
    ).toHaveLength(0);
  });

  it("CAS: concurrent findings writers cannot clobber each other — loser 409s, winner's keys survive, retry merges both", async () => {
    // The findings shallow-merge is read-modify-write: both writers read prev
    // findings in their own tx and merge onto that snapshot. Without state in
    // the UPDATE's where, whichever committed second would overwrite the whole
    // findings JSON and silently drop the first writer's keys (last committer
    // wins). The CAS makes the loser's predicate miss instead (the winner's
    // commit changed state — no legal transition is a self-transition), so it
    // gets a 409 and must re-read fresh findings before merging.
    const store = makeStore();
    seedMission(store, 'M1', 'active');
    const { svc } = makeService(store);
    const run = await svc.createRun(T, U, 'M1', {
      trigger: 'manual',
      idempotencyKey: 'findings-race-1',
    } as CreateRunDto);
    await svc.transition(T, U, run.id, { to: 'planning' } as TransitionRunDto);
    await svc.transition(T, U, run.id, { to: 'executing' } as TransitionRunDto);

    // The deterministic checker commits executing->waiting_for_input with ITS
    // findings right after the orchestrator's read (in place, so the commit
    // survives the loser's snapshot rollback — like a separate committed tx).
    store.hooks.afterRunFindFirst = () => {
      store.hooks.afterRunFindFirst = undefined; // one-shot
      Object.assign(store.runs.get(run.id)!, {
        state: 'waiting_for_input',
        waitingReason: 'checker found stale nodes',
        findings: { stale_nodes: ['n1'] },
      });
    };

    const err = await svc
      .transition(T, U, run.id, {
        to: 'waiting_for_input',
        findings: { conflicts: ['c1'] },
      } as TransitionRunDto)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    // The winner's findings are intact — the loser's stale {} + {conflicts}
    // merge never landed, so stale_nodes was not silently dropped.
    expect(store.runs.get(run.id)!.findings).toEqual({ stale_nodes: ['n1'] });

    // Retrying against fresh state accumulates BOTH writers' keys — no loss.
    const retried = await svc.transition(T, U, run.id, {
      to: 'executing',
      findings: { conflicts: ['c1'] },
    } as TransitionRunDto);
    expect(retried.findings).toEqual({ stale_nodes: ['n1'], conflicts: ['c1'] });
  });
});
