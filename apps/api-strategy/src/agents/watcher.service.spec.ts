import { describe, expect, it, jest } from '@jest/globals';
import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import { WatcherService, computeArtifactMismatches } from './watcher.service.js';
import { RunsService } from './runs.service.js';
import { ChangeSetsService } from './change-sets.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import type { VersionService } from '../strategy/version.service.js';
import type { MeriService } from '../meri/meri.service.js';
import type { StewardService } from '../context/steward.service.js';
import type { StrategyFlagsService } from '../flags/strategy-flags.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/*
 * WatcherService tests over the in-memory fake tx (change-sets.service.spec.ts
 * makeStore/makeTx pattern) with the REAL RunsService, REAL ChangeSetsService
 * and REAL VersioningService wired over it — so the run lifecycle, the
 * change-set head-pin/seal and every activity+outbox write execute exactly as
 * in prod. The ONLY MeriService member the stub exposes is grounding() and the
 * only StewardService member is health(): a check run that touched an LLM (or
 * any orchestrator surface) would crash the test — F1 is deterministic by
 * construction.
 */

interface Rec {
  [k: string]: unknown;
  id: string;
}

const T = 'tenant-1';
const U = 'user-1';
const SID = 'S1';
const MID = 'M1';

const todayIso = new Date().toISOString().slice(0, 10);
function daysFromToday(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Current federal FY (Oct–Dec -> next year), for an always-in-window fiscal frame. */
const CUR_FY = (() => {
  const now = new Date();
  return now.getUTCMonth() + 1 >= 10 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
})();

function makeStore() {
  const missions = new Map<string, Rec>();
  const strategies = new Map<string, Rec>();
  const nodes = new Map<string, Rec>();
  const artifacts = new Map<string, Rec>();
  const versions = new Map<string, Rec>();
  const runs = new Map<string, Rec>();
  const changeSets = new Map<string, Rec>();
  const activity: Rec[] = [];
  const outbox: Rec[] = [];
  let seq = 0;
  const nextId = (p: string) => `${p}-${++seq}`;
  const nodesFor = (sid: string) => [...nodes.values()].filter((n) => n.strategyId === sid);
  const artifactsFor = (sid: string) =>
    [...artifacts.values()].filter((a) => a.strategyId === sid);
  return {
    missions,
    strategies,
    nodes,
    artifacts,
    versions,
    runs,
    changeSets,
    activity,
    outbox,
    nextId,
    nodesFor,
    artifactsFor,
  };
}
type Store = ReturnType<typeof makeStore>;

function seedStrategy(store: Store): void {
  store.strategies.set(SID, {
    id: SID,
    tenantId: T,
    clientId: 'C1',
    title: 'FY27 authorization plan',
    type: 'authorization',
    goal: 'Authorize the program',
    meriContext: null,
    meriSummary: null,
    targetDate: null,
    ownerUserId: U,
    createdByUserId: U,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastEditedByUserId: null,
    lastEditedAt: null,
  });
  // ChangeSetsService.create pins the version head — every strategy has a v1.
  store.versions.set('v1', {
    id: 'v1',
    tenantId: T,
    strategyId: SID,
    snapshot: { meta: {}, nodes: [] },
    authorKind: 'person',
    authorUserId: U,
    note: 'seed',
    restoredFromVersionId: null,
    coalescible: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  });
}

function seedMission(store: Store, overrides: Partial<Rec> = {}): void {
  store.missions.set(MID, {
    id: MID,
    tenantId: T,
    strategyId: SID,
    clientId: null,
    name: 'Watch the plan',
    description: null,
    state: 'active',
    cadence: null,
    nextRunAt: null,
    createdByUserId: U,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  });
}

function seedNode(store: Store, overrides: Partial<Rec> & { id: string }): void {
  store.nodes.set(overrides.id, {
    tenantId: T,
    strategyId: SID,
    kind: 'action',
    subject: 'deliverable',
    title: `Step ${overrides.id}`,
    note: null,
    ownerUserId: 'u-owner',
    status: 'in_progress',
    startsOn: daysFromToday(5),
    endsOn: daysFromToday(10),
    openEnded: false,
    meriAuthored: false,
    dependsOnIds: [],
    provenance: null,
    createdByUserId: U,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  });
}

function makeTx(store: Store, lock: (key: string) => Promise<void> = async () => {}) {
  const now = new Date();
  const spAgentMission = {
    findFirst: async ({ where }: { where: { id: string } }) =>
      store.missions.get(where.id) ?? null,
  };
  // Raw SELECT ... FOR UPDATE gates (explicit tenant_id): the mission gate in
  // RunsService.createRun (locking modelled as a no-op — nothing here contends
  // on it) and the WatcherService.proposeChangeSets strategy-row serialization
  // lock, which IS modelled: `lock` suspends until the holder's fake tx
  // settles (see makeService.inTx), like Postgres row locks.
  const $queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (/FROM sp_agent_mission/.test(sql)) {
      const [missionId, tenantId] = values as [string, string];
      const m = store.missions.get(missionId);
      return m && m.tenantId === tenantId
        ? [{ id: m.id, state: m.state, strategyId: m.strategyId }]
        : [];
    }
    if (/FROM sp_strategy/.test(sql)) {
      const [strategyId, tenantId] = values as [string, string];
      await lock(`sp_strategy:${strategyId}`);
      const s = store.strategies.get(strategyId);
      return s && s.tenantId === tenantId ? [{ id: s.id }] : [];
    }
    throw new Error(`fake tx got an unmodelled raw query: ${sql}`);
  };
  const spStrategy = {
    findFirst: async ({
      where,
      include,
    }: {
      where: { id: string };
      include?: { nodes?: unknown; artifacts?: unknown };
    }) => {
      const rec = store.strategies.get(where.id);
      if (!rec) return null;
      const out: Rec = { ...rec };
      if (include?.nodes) out.nodes = store.nodesFor(rec.id);
      if (include?.artifacts) out.artifacts = store.artifactsFor(rec.id);
      return out;
    },
  };
  const spVersion = {
    // ChangeSetsService.headOf total order: createdAt desc, id desc.
    findFirst: async ({ where }: { where: { id?: string; strategyId?: string } }) => {
      const rows = [...store.versions.values()]
        .filter((v) => (where.strategyId ? v.strategyId === where.strategyId : true))
        .filter((v) => (where.id ? v.id === where.id : true))
        .sort((a, b) => {
          const dt = (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime();
          if (dt !== 0) return dt;
          return String(b.id).localeCompare(String(a.id));
        });
      return rows[0] ?? null;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; coalescible?: boolean };
      data: Rec;
    }) => {
      const rec = store.versions.get(where.id);
      if (!rec || (where.coalescible !== undefined && rec.coalescible !== where.coalescible)) {
        return { count: 0 };
      }
      store.versions.set(where.id, { ...rec, ...data });
      return { count: 1 };
    },
  };
  const spAgentRun = {
    create: async ({ data }: { data: Rec }) => {
      const dup = [...store.runs.values()].some(
        (r) => r.tenantId === data.tenantId && r.idempotencyKey === data.idempotencyKey,
      );
      if (dup) {
        // @@unique([tenantId, idempotencyKey]) — graft the Prisma error class
        // prototype so the service's P2002 instanceof check passes.
        const err = Object.assign(new Error('unique'), { code: 'P2002' });
        Object.setPrototypeOf(err, Prisma.PrismaClientKnownRequestError.prototype);
        throw err;
      }
      const id = store.nextId('run');
      const rec: Rec = {
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
      return rec ? { ...rec } : null;
    },
    // CAS write (RunsService.transition AND the watcher's refresh path): the
    // where carries the expected state; a mismatch is count 0 like Postgres.
    updateMany: async ({ where, data }: { where: { id: string; state?: string }; data: Rec }) => {
      const rec = store.runs.get(where.id);
      if (!rec || (where.state !== undefined && rec.state !== where.state)) return { count: 0 };
      store.runs.set(where.id, { ...rec, ...data, updatedAt: now });
      return { count: 1 };
    },
  };
  const spChangeSet = {
    create: async ({ data }: { data: Rec }) => {
      const id = store.nextId('cs');
      const rec: Rec = {
        approvedOps: null,
        appliedVersionId: null,
        ...data,
        id,
        createdAt: now,
        updatedAt: now,
      };
      store.changeSets.set(id, rec);
      return rec;
    },
    findFirst: async ({ where }: { where: { id: string } }) =>
      store.changeSets.get(where.id) ?? null,
    findMany: async ({
      where,
    }: {
      where: { strategyId?: string; status?: string | { in?: string[] } };
    }) =>
      [...store.changeSets.values()].filter((c) => {
        if (where.strategyId && c.strategyId !== where.strategyId) return false;
        if (typeof where.status === 'string') return c.status === where.status;
        if (where.status?.in) return where.status.in.includes(c.status as string);
        return true;
      }),
    // CAS write (ChangeSetsService.refreshProposedOps): the where carries the
    // expected status; a mismatch is count 0 like Postgres.
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; status?: string };
      data: Rec;
    }) => {
      const rec = store.changeSets.get(where.id);
      if (!rec || (where.status !== undefined && rec.status !== where.status)) return { count: 0 };
      store.changeSets.set(where.id, { ...rec, ...data, updatedAt: now });
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
    spAgentMission,
    spStrategy,
    spVersion,
    spAgentRun,
    spChangeSet,
    spActivityLog,
    spEventOutbox,
    $queryRaw,
  } as unknown as Prisma.TransactionClient;
}

function makeService(store: Store) {
  const snapshot = () => ({
    missions: new Map(store.missions),
    strategies: new Map(store.strategies),
    nodes: new Map(store.nodes),
    artifacts: new Map(store.artifacts),
    versions: new Map(store.versions),
    runs: new Map(store.runs),
    changeSets: new Map(store.changeSets),
    activity: [...store.activity],
    outbox: [...store.outbox],
  });
  const restore = (snap: ReturnType<typeof snapshot>) => {
    store.missions = snap.missions;
    store.strategies = snap.strategies;
    store.nodes = snap.nodes;
    store.artifacts = snap.artifacts;
    store.versions = snap.versions;
    store.runs = snap.runs;
    store.changeSets = snap.changeSets;
    store.activity = snap.activity;
    store.outbox = snap.outbox;
  };
  // FOR UPDATE row locks with Postgres semantics: an acquire suspends until
  // the current holder's fake tx SETTLES (commit or rollback) — this is what
  // lets the concurrency test below exercise the proposeChangeSets
  // serialization for real instead of asserting on call shapes.
  const lockTails = new Map<string, Promise<void>>();
  const acquireLock = async (key: string): Promise<() => void> => {
    const prev = lockTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const cur = new Promise<void>((resolve) => (release = resolve));
    lockTails.set(key, cur);
    await prev;
    return release;
  };
  const inTx = async (fn: (tx: unknown) => Promise<unknown>) => {
    const snap = snapshot();
    const held: Array<() => void> = [];
    try {
      return await fn(
        makeTx(store, async (key) => {
          held.push(await acquireLock(key));
        }),
      );
    } catch (e) {
      restore(snap);
      throw e;
    } finally {
      for (const release of held) release();
    }
  };
  const withTenantUser = jest.fn(
    async (_t: string, _u: string, fn: (tx: unknown) => Promise<unknown>) => inTx(fn),
  );
  const withTenant = jest.fn(async (_t: string, fn: (tx: unknown) => Promise<unknown>) => inTx(fn));
  const prisma = { withTenantUser, withTenant } as unknown as PrismaService;

  const versioning = new VersioningService();
  const runs = new RunsService(prisma, versioning);
  // ChangeSetsService's apply-path collaborators are irrelevant to create();
  // empty stubs make any accidental apply/undo call crash loudly.
  const changeSets = new ChangeSetsService(
    prisma,
    versioning,
    {} as unknown as VersionService,
    {} as unknown as MeriService,
  );

  // The ONLY Meri surface a check run may touch: grounding (fiscal + reference).
  const groundingValue = {
    fiscal: {
      today: todayIso,
      fys: [CUR_FY - 1, CUR_FY, CUR_FY + 1],
      fyLabels: [CUR_FY - 1, CUR_FY, CUR_FY + 1].map((y) => `FY${String(y).slice(2)}`),
      focalFy: `FY${String(CUR_FY).slice(2)}`,
    },
    firmPhases: [],
    reference: { congress: [], ppbeLanes: [], ppbeCurrentPhases: [] },
  };
  const grounding = jest.fn(async (_t: string) => groundingValue);
  const meri = { grounding } as unknown as MeriService;

  const healthValue = {
    status: 'ok' as const,
    factCounts: { active: 0, superseded: 0, stale: 0, rejected: 0 },
    openConflicts: 0,
    openMaterialConflicts: [],
    staleDocs: [],
    missingRequired: [],
  };
  const health = jest.fn(async (_t: string, _c: string | null) => healthValue);
  const steward = { health } as unknown as StewardService;

  const isAgenticFlagEnabled = jest.fn(async (_t: string, _flag: string) => true);
  const flags = { isAgenticFlagEnabled } as unknown as StrategyFlagsService;

  const svc = new WatcherService(prisma, versioning, flags, runs, changeSets, meri, steward);
  return { svc, grounding, health, healthValue, isAgenticFlagEnabled, withTenant, withTenantUser };
}

/** All run.transitioned (before -> after) state pairs, in order. */
function transitions(store: Store): Array<[string, string]> {
  return store.activity
    .filter((a) => a.action === 'run.transitioned')
    .map((a) => [
      (a.before as { state: string }).state,
      (a.after as { state: string }).state,
    ]);
}

describe('WatcherService.runCheckNow — deterministic check run', () => {
  it('drives queued->planning->ready_for_review with ZERO LLM, persists findings, and proposes ONE change-set per actionable finding', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    // Overdue AND unowned: two findings, ONE actionable (the overdue retime).
    seedNode(store, {
      id: 'N1',
      title: 'File the one-pager',
      startsOn: daysFromToday(-14),
      endsOn: daysFromToday(-7),
      status: 'in_progress',
      ownerUserId: null,
    });
    const { svc, grounding, health } = makeService(store);

    const result = await svc.runCheckNow(T, U, MID);

    // Lifecycle: planning -> ready_for_review DIRECTLY — never 'executing'
    // (a check run has no external execution phase), and no LLM surface exists
    // on the stubs beyond grounding().
    expect(transitions(store)).toEqual([
      ['queued', 'planning'],
      ['planning', 'ready_for_review'],
    ]);
    const run = store.runs.get(result.runId)!;
    expect(run.state).toBe('ready_for_review');
    expect(run.trigger).toBe('manual'); // human-invoked (userId set)
    expect(run.startedAt).not.toBeNull();
    expect(grounding).toHaveBeenCalledTimes(1);
    expect(health).toHaveBeenCalledTimes(1);
    expect(health).toHaveBeenCalledWith(T, 'C1');

    // Findings computed AND persisted on the run (findings JSON).
    const codes = result.findings.map((f) => f.code).sort();
    expect(codes).toEqual(['missing-owner', 'overdue']);
    const persisted = run.findings as { checkedOn: string; findings: Array<{ code: string }> };
    expect(persisted.checkedOn).toBe(todayIso);
    expect(persisted.findings.map((f) => f.code).sort()).toEqual(['missing-owner', 'overdue']);

    // ONE change-set for the one actionable finding (missing-owner is advisory).
    expect(result.changeSetsProposed).toHaveLength(1);
    expect(store.changeSets.size).toBe(1);
    const cs = store.changeSets.get(result.changeSetsProposed[0]!)!;
    expect(cs.status).toBe('proposed');
    expect(cs.runId).toBe(result.runId);
    expect(cs.strategyId).toBe(SID);
    // RiskRouter classification: warning + retime-only (non-structural) => medium.
    expect(cs.risk).toBe('medium');
    expect(String(cs.summary)).toMatch(/^\[watch:overdue:N1\] /);
    const ops = cs.ops as Array<{ op: string; nodeId: string; startsOn: string }>;
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op).toBe('retime');
    expect(ops[0]!.nodeId).toBe('N1');
    expect(ops[0]!.startsOn > todayIso).toBe(true); // concrete FUTURE date
    expect(store.activity.some((a) => a.action === 'changeset.proposed')).toBe(true);
    expect(store.activity.some((a) => a.action === 'watch.noop')).toBe(false);
  });

  it('RE-RUN with the same idempotencyKey refreshes the run findings but NEVER duplicates a change-set', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, {
      id: 'N1',
      startsOn: daysFromToday(-14),
      endsOn: daysFromToday(-7),
      status: 'in_progress',
      ownerUserId: null,
    });
    const { svc } = makeService(store);

    const first = await svc.runCheckNow(T, U, MID);
    const second = await svc.runCheckNow(T, U, MID); // same day => same default key

    // Same run, refreshed — not a second run.
    expect(second.runId).toBe(first.runId);
    expect(store.runs.size).toBe(1);
    expect(store.runs.get(first.runId)!.state).toBe('ready_for_review');
    // The acceptance criterion: findings recomputed, but the store still has
    // EXACTLY ONE change-set — the open proposal was recognized by its
    // [watch:code:nodeIds] marker and skipped.
    expect(second.findings.map((f) => f.code).sort()).toEqual(['missing-owner', 'overdue']);
    expect(second.changeSetsProposed).toEqual([]);
    expect(store.changeSets.size).toBe(1);
    expect(store.activity.some((a) => a.action === 'watch.rechecked')).toBe(true);
    // Same-day recomputed ops are IDENTICAL, so the date-staleness path stays
    // quiet — no in-place rewrite, no changeset.refreshed audit noise.
    expect(store.activity.some((a) => a.action === 'changeset.refreshed')).toBe(false);
    // The refresh updated the persisted findings in place.
    const persisted = store.runs.get(first.runId)!.findings as { findings: unknown[] };
    expect(persisted.findings).toHaveLength(2);
  });

  it('a WIDE finding (12 slipped dependencies => 13 uuid nodeIds) keeps a complete, parseable marker inside the 500-char summary — re-runs still dedup instead of duplicating daily', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    // 12 owned, in-progress predecessors that all finish well in the future...
    const uuidLike = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const depIds = Array.from({ length: 12 }, (_, i) => uuidLike(i + 1));
    for (const id of depIds) {
      seedNode(store, { id, startsOn: daysFromToday(-5), endsOn: daysFromToday(20) });
    }
    // ...and ONE step that starts before ALL of them finish: a single
    // dependency-slippage finding carrying 13 uuid nodeIds, whose PLAIN
    // [watch:dependency-slippage:<13 uuids>] marker is ~508 chars — wider than
    // the ENTIRE 500-char summary budget (CreateChangeSetDto @MaxLength).
    seedNode(store, {
      id: 'ffffffff-0000-4000-8000-000000000000',
      startsOn: daysFromToday(2),
      endsOn: daysFromToday(30),
      dependsOnIds: depIds,
    });
    const { svc } = makeService(store);

    const first = await svc.runCheckNow(T, U, MID);

    // Exactly one actionable finding => one proposal, whose summary honors the
    // 500-char cap AND still opens with a COMPLETE marker (closing ']' intact,
    // hence parseWatchMarker-visible). The regression: the marker was embedded
    // via `summary.slice(0, 500)`, so a >500-char marker lost its ']' — later
    // runs extracted no marker from the stored summary and re-proposed forever.
    expect(first.changeSetsProposed).toHaveLength(1);
    const summary = String(store.changeSets.get(first.changeSetsProposed[0]!)!.summary);
    expect(summary.length).toBeLessThanOrEqual(500);
    expect(summary).toMatch(/^\[watch:dependency-slippage:[^\]]+\] /);

    // Same-day re-run (same default key): the open proposal is recognized by
    // its marker — no duplicate (this minted one duplicate per run before).
    const second = await svc.runCheckNow(T, U, MID);
    expect(second.changeSetsProposed).toEqual([]);
    expect(store.changeSets.size).toBe(1);
  });

  it('CONCURRENT manual + scheduled checks (DISTINCT idempotency keys) serialize on the strategy row lock — never a duplicate change-set', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, {
      id: 'N1',
      startsOn: daysFromToday(-14),
      endsOn: daysFromToday(-7),
      status: 'in_progress',
    });
    const { svc, health, healthValue } = makeService(store);

    // Two-party barrier on the steward-health read: BOTH runs finish loading
    // state before either reaches proposeChangeSets. Without the strategy-row
    // FOR UPDATE serialization both would then read the open markers before
    // either committed and BOTH would create — the WatchRail 'Run check now'
    // vs scheduler-tick race (an outbox-bumped nextRunAt claimed at the same
    // moment the user clicks the button).
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => (releaseBarrier = resolve));
    let arrived = 0;
    health.mockImplementation(async () => {
      if (++arrived === 2) releaseBarrier();
      await barrier;
      return healthValue;
    });

    const [manual, sched] = await Promise.all([
      svc.runCheckNow(T, U, MID), // WatchRail: watch:M1:<today>
      svc.runCheckNow(T, null, MID, { idempotencyKey: 'sched:M1:bucket-1' }),
    ]);

    // Distinct keys => two REAL runs (this is not the same-key replay path)...
    expect(manual.runId).not.toBe(sched.runId);
    expect(store.runs.size).toBe(2);
    expect(store.runs.get(manual.runId)!.state).toBe('ready_for_review');
    expect(store.runs.get(sched.runId)!.state).toBe('ready_for_review');
    // ...but the F1 acceptance criterion holds ACROSS them: exactly ONE
    // '[watch:overdue:N1]' proposal in total — the row-lock loser saw the
    // winner's committed proposal in its fresh dedup read and skipped.
    expect(store.changeSets.size).toBe(1);
    expect([...manual.changeSetsProposed, ...sched.changeSetsProposed]).toHaveLength(1);
    expect(store.activity.filter((a) => a.action === 'changeset.proposed')).toHaveLength(1);
  });

  it('a head-moved (ZOMBIE) open proposal does NOT block re-proposing — dedup only counts proposals pinned to the CURRENT head', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, {
      id: 'N1',
      startsOn: daysFromToday(-14),
      endsOn: daysFromToday(-7),
      status: 'in_progress',
    });
    const { svc } = makeService(store);

    // Day 1: the overdue finding yields CS1 pinned to the current head (v1).
    const first = await svc.runCheckNow(T, U, MID, { idempotencyKey: 'watch:M1:day-1' });
    expect(first.changeSetsProposed).toHaveLength(1);
    const cs1 = store.changeSets.get(first.changeSetsProposed[0]!)!;
    expect(cs1.strategyVersionId).toBe('v1');

    // A user edit (unrelated node) cuts a new version — the head moves to v2.
    // CS1 is now a zombie: still status 'proposed', but ChangeSetsService.apply
    // is GUARANTEED to 409-stale it; nothing flips it to 'stale' until someone
    // actually clicks Apply.
    store.versions.set('v2', {
      id: 'v2',
      tenantId: T,
      strategyId: SID,
      snapshot: { meta: {}, nodes: [] },
      authorKind: 'person',
      authorUserId: U,
      note: 'unrelated edit',
      restoredFromVersionId: null,
      coalescible: false,
      createdAt: new Date('2026-07-02T00:00:00.000Z'),
    });

    // Day 2: the finding is still true. The zombie's marker must NOT dedup it —
    // a FRESH, applicable proposal pinned to the new head is created.
    const second = await svc.runCheckNow(T, U, MID, { idempotencyKey: 'watch:M1:day-2' });
    expect(second.changeSetsProposed).toHaveLength(1);
    const cs2 = store.changeSets.get(second.changeSetsProposed[0]!)!;
    expect(cs2.id).not.toBe(cs1.id);
    expect(cs2.strategyVersionId).toBe('v2');
    expect(store.changeSets.size).toBe(2);
    // Same finding, same marker — only the head-pin distinguishes them; the
    // zombie is left for the human reject / apply-409-stale paths.
    expect(String(cs2.summary)).toMatch(/^\[watch:overdue:N1\] /);
    expect(store.changeSets.get(cs1.id as string)!.status).toBe('proposed');

    // Day 3, head unmoved: the FRESH open proposal now dedups as before —
    // zombie exclusion never disables the acceptance-criterion dedup.
    const third = await svc.runCheckNow(T, U, MID, { idempotencyKey: 'watch:M1:day-3' });
    expect(third.changeSetsProposed).toEqual([]);
    expect(store.changeSets.size).toBe(2);
  });

  it('a DATE-STALE open proposed retime is REWRITTEN in place with run-day-fresh dates — a late apply can no longer land an already-past window (the overdue re-flag loop)', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    // Node X: ended a week ago, still in_progress => overdue every run.
    seedNode(store, {
      id: 'N1',
      title: 'File the one-pager',
      startsOn: daysFromToday(-14),
      endsOn: daysFromToday(-7),
      status: 'in_progress',
    });
    // The Monday proposal, still open on Friday: its retime window (computed
    // as proposal-day + 1) has since drifted INTO THE PAST; nobody edited the
    // plan, so it is still pinned to the live head (v1) and apply's stale
    // guard would NOT block it — pre-fix, applying retimed N1 into a past
    // window that the next run immediately re-flagged overdue.
    store.changeSets.set('cs-monday', {
      id: 'cs-monday',
      tenantId: T,
      strategyId: SID,
      runId: 'run-monday',
      summary: `[watch:overdue:N1] "File the one-pager" ended ${daysFromToday(-7)} and is still in progress.`,
      ops: [{ op: 'retime', nodeId: 'N1', startsOn: daysFromToday(-3), endsOn: daysFromToday(4) }],
      approvedOps: null,
      risk: 'medium',
      status: 'proposed',
      strategyVersionId: 'v1',
      createdByUserId: null,
      createdAt: new Date(Date.now() - 4 * 86_400_000),
      updatedAt: new Date(Date.now() - 4 * 86_400_000),
    });
    const { svc } = makeService(store);

    const result = await svc.runCheckNow(T, U, MID);

    // Still ONE change-set (never a duplicate), same row, still reviewable...
    expect(result.changeSetsProposed).toEqual([]);
    expect(store.changeSets.size).toBe(1);
    const row = store.changeSets.get('cs-monday')!;
    expect(row.status).toBe('proposed');
    // ...but its ops now carry TODAY's strictly-in-the-future window with the
    // node's 7-day duration preserved — approving and applying it right now
    // converges instead of re-flagging.
    const ops = row.ops as Array<{ op: string; nodeId: string; startsOn: string; endsOn: string }>;
    expect(ops).toEqual([
      { op: 'retime', nodeId: 'N1', startsOn: daysFromToday(1), endsOn: daysFromToday(8) },
    ]);
    expect(String(row.summary)).toMatch(/^\[watch:overdue:N1\] /);
    // Audited as a refresh, NOT a new proposal.
    expect(store.activity.some((a) => a.action === 'changeset.refreshed')).toBe(true);
    expect(store.activity.some((a) => a.action === 'changeset.proposed')).toBe(false);
  });

  it('an APPROVED open proposal is IMMUTABLE — date drift never rewrites ops a human already approved', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, {
      id: 'N1',
      startsOn: daysFromToday(-14),
      endsOn: daysFromToday(-7),
      status: 'in_progress',
    });
    const staleOps = [
      { op: 'retime', nodeId: 'N1', startsOn: daysFromToday(-3), endsOn: daysFromToday(4) },
    ];
    store.changeSets.set('cs-approved', {
      id: 'cs-approved',
      tenantId: T,
      strategyId: SID,
      runId: 'run-old',
      summary: `[watch:overdue:N1] "Step N1" ended ${daysFromToday(-7)} and is still in progress.`,
      ops: staleOps,
      approvedOps: null,
      risk: 'medium',
      status: 'approved',
      strategyVersionId: 'v1',
      createdByUserId: null,
      approvedByUserId: U,
      createdAt: new Date(Date.now() - 4 * 86_400_000),
      updatedAt: new Date(Date.now() - 4 * 86_400_000),
    });
    const { svc } = makeService(store);

    const result = await svc.runCheckNow(T, U, MID);

    // Marker dedup still blocks a duplicate, and the approved ops are exactly
    // as the human approved them — worst case the late apply lands past dates
    // ONCE and the row leaves the open set for a fresh re-proposal.
    expect(result.changeSetsProposed).toEqual([]);
    expect(store.changeSets.size).toBe(1);
    expect(store.changeSets.get('cs-approved')!.ops).toEqual(staleOps);
    expect(store.activity.some((a) => a.action === 'changeset.refreshed')).toBe(false);
    expect(store.activity.some((a) => a.action === 'changeset.proposed')).toBe(false);
  });

  it('jsonb KEY ORDER alone never reads as a change — an up-to-date proposal round-tripped with scrambled keys is not rewritten daily', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, {
      id: 'N1',
      startsOn: daysFromToday(-14),
      endsOn: daysFromToday(-7),
      status: 'in_progress',
    });
    // Same values checkOverdue computes TODAY, but with the key order Postgres
    // jsonb storage imposes (length- then byte-ordered) rather than the op
    // literal's — a naive JSON.stringify comparison would call this "changed"
    // on every run and rewrite + audit daily.
    store.changeSets.set('cs-fresh', {
      id: 'cs-fresh',
      tenantId: T,
      strategyId: SID,
      runId: 'run-today',
      summary: `[watch:overdue:N1] "Step N1" ended ${daysFromToday(-7)} and is still in progress.`,
      ops: [{ op: 'retime', endsOn: daysFromToday(8), nodeId: 'N1', startsOn: daysFromToday(1) }],
      approvedOps: null,
      risk: 'medium',
      status: 'proposed',
      strategyVersionId: 'v1',
      createdByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { svc } = makeService(store);

    const result = await svc.runCheckNow(T, U, MID);

    expect(result.changeSetsProposed).toEqual([]);
    expect(store.changeSets.size).toBe(1);
    expect(store.activity.some((a) => a.action === 'changeset.refreshed')).toBe(false);
  });

  it('ZERO findings => ready_for_review with findings:[] + a watch.noop audit row, NO change-set, NO notification-shaped write', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    // Clean: future-dated, owned, healthy steward, no verifier violations.
    seedNode(store, { id: 'N1', startsOn: daysFromToday(5), endsOn: daysFromToday(10) });
    const { svc } = makeService(store);

    const result = await svc.runCheckNow(T, U, MID);

    expect(result.findings).toEqual([]);
    expect(result.changeSetsProposed).toEqual([]);
    const run = store.runs.get(result.runId)!;
    expect(run.state).toBe('ready_for_review');
    expect((run.findings as { findings: unknown[] }).findings).toEqual([]);
    expect(store.changeSets.size).toBe(0);
    // The quiet noop record — and nothing louder: no proposal, and the outbox
    // carries only the run's own lifecycle rows + the noop.
    expect(store.activity.some((a) => a.action === 'watch.noop')).toBe(true);
    expect(store.outbox.map((o) => o.type)).toEqual([
      'run.created',
      'run.transitioned',
      'run.transitioned',
      'watch.noop',
    ]);
  });

  it('BadRequests a firm-level mission (no strategyId) BEFORE minting a run — the F2 calendar-path seam', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store, { strategyId: null });
    const { svc } = makeService(store);

    const err = await svc.runCheckNow(T, U, MID).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(/firm-level/);
    expect(store.runs.size).toBe(0);
    expect(store.activity).toHaveLength(0);
  });

  it('an inactive (paused) mission is rejected by the RunsService gate — no run row survives', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store, { state: 'paused' });
    const { svc } = makeService(store);

    const err = await svc.runCheckNow(T, U, MID).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(/not active/);
    expect(store.runs.size).toBe(0);
  });

  it('403s FAIL-CLOSED when strategyWatcher.enabled is off (the scheduler path has no HTTP guard) — before any read or write', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    const { svc, isAgenticFlagEnabled, withTenant, withTenantUser } = makeService(store);
    isAgenticFlagEnabled.mockResolvedValueOnce(false);

    const err = await svc.runCheckNow(T, U, MID).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
    expect(isAgenticFlagEnabled).toHaveBeenCalledWith(T, 'strategyWatcher.enabled');
    expect(store.runs.size).toBe(0);
    expect(withTenant).not.toHaveBeenCalled();
    expect(withTenantUser).not.toHaveBeenCalled();
  });

  it('a mid-check failure transitions the run to failed (never stranded in planning) and rethrows', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: 'N1' });
    const { svc, health } = makeService(store);
    health.mockRejectedValueOnce(new Error('steward exploded'));

    const err = await svc.runCheckNow(T, U, MID).catch((e: unknown) => e);

    expect((err as Error).message).toBe('steward exploded');
    const run = [...store.runs.values()][0]!;
    expect(run.state).toBe('failed');
    expect(String(run.error)).toContain('steward exploded');
    expect(run.finishedAt).not.toBeNull();
    expect(store.changeSets.size).toBe(0);
  });

  it('system-triggered (userId null, the F2 scheduler shape) runs under withTenant and attributes activity to meri', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: 'N1', startsOn: daysFromToday(5), endsOn: daysFromToday(10) });
    const { svc, withTenant, withTenantUser } = makeService(store);

    const result = await svc.runCheckNow(T, null, MID, { idempotencyKey: 'sched:M1:bucket-1' });

    expect(store.runs.get(result.runId)!.state).toBe('ready_for_review');
    expect(store.runs.get(result.runId)!.idempotencyKey).toBe('sched:M1:bucket-1');
    // Run-ledger label follows the caller shape: userId null => 'scheduled',
    // never mislabeled 'manual' (RUN_TRIGGERS distinguishes them for audit).
    expect(store.runs.get(result.runId)!.trigger).toBe('scheduled');
    expect(withTenant).toHaveBeenCalled();
    expect(withTenantUser).not.toHaveBeenCalled();
    for (const a of store.activity) {
      expect(a.authorKind).toBe('meri');
      expect(a.actorUserId).toBeNull();
    }
  });

  it("an explicit opts.trigger (the scheduler pass-through) beats the caller-shape fallback on the run row AND the run.created audit", async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: 'N1', startsOn: daysFromToday(5), endsOn: daysFromToday(10) });
    const { svc } = makeService(store);

    // A user-invoked call whose caller labels it 'event' (SpRunTrigger's third
    // value — the future outbox-direct shape) must NOT fall back to 'manual':
    // opts.trigger is the explicit channel the F2 scheduler uses for
    // 'scheduled'.
    const result = await svc.runCheckNow(T, U, MID, {
      idempotencyKey: 'evt:M1:bucket-1',
      trigger: 'event',
    });

    expect(store.runs.get(result.runId)!.trigger).toBe('event');
    const created = store.activity.find((a) => a.action === 'run.created')!;
    expect((created.after as { trigger: string }).trigger).toBe('event');
  });
});

describe('computeArtifactMismatches (check-h seam input)', () => {
  it('flags orphaned back-links and status regressions, and nothing else', () => {
    const nodes = [
      { id: 'N1', status: 'draft' }, // regression: artifact exists but node re-drafted
      { id: 'N2', status: 'in_progress' }, // healthy
      { id: 'N3', status: 'suggested' }, // regression
    ];
    const artifacts = [
      { nodeId: 'N1' },
      { nodeId: 'N2' },
      { nodeId: 'N3' },
      { nodeId: 'ghost' }, // orphan: node no longer in the plan
      { nodeId: 'N1' }, // second artifact on N1 must not duplicate the id
    ];
    expect(computeArtifactMismatches(nodes, artifacts).sort()).toEqual(['N1', 'N3', 'ghost']);
  });

  it('is empty for a healthy plan (and for a plan with no artifacts)', () => {
    expect(
      computeArtifactMismatches([{ id: 'N1', status: 'active' }], [{ nodeId: 'N1' }]),
    ).toEqual([]);
    expect(computeArtifactMismatches([{ id: 'N1', status: 'draft' }], [])).toEqual([]);
  });
});
