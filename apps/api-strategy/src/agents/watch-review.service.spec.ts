import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import { WatchReviewService } from './watch-review.service.js';
import { WatcherService } from './watcher.service.js';
import { RunsService } from './runs.service.js';
import { ChangeSetsService } from './change-sets.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import type { VersionService } from '../strategy/version.service.js';
import type { MeriService } from '../meri/meri.service.js';
import type { StrategyConversationService } from '../meri/strategy-conversation.service.js';
import type { StewardService } from '../context/steward.service.js';
import type { StrategyFlagsService } from '../flags/strategy-flags.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/*
 * Integration-style tests over the SAME in-memory fake tx pattern established
 * by change-sets.service.spec.ts / watcher.service.spec.ts, but wiring the
 * REAL WatcherService + RunsService + ChangeSetsService + VersioningService
 * underneath WatchReviewService — so revalidate()'s call into
 * WatcherService.runCheckNow exercises the actual dedup/refresh/dependency
 * logic, not a stub. Only MeriService (grounding/applyEditSet/
 * verifyAppliedPlan) and StewardService/StrategyFlagsService are stubs — the
 * same boundary watcher.service.spec.ts draws, since a check run that touched
 * an LLM would be a Stage F regression.
 *
 * Unlike the other two specs' fake txs (hand-coded per call site), this one
 * uses a small generic `matches`/`orderBy` engine: WatchReviewService alone
 * introduces well over a dozen distinct where-shapes against sp_change_set,
 * and hand-coding each would be its own source of mock bugs.
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
const CUR_FY = (() => {
  const now = new Date();
  return now.getUTCMonth() + 1 >= 10 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
})();

// ---- generic fake-tx query engine ---------------------------------------------

function matches(rec: Rec, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    const val = rec[key];
    if (cond === null) {
      if (val !== null && val !== undefined) return false;
      continue;
    }
    if (typeof cond === 'object' && !Array.isArray(cond)) {
      const c = cond as Record<string, unknown>;
      if ('not' in c) {
        const notVal = c.not;
        const isNotMatch = notVal === null ? val === null || val === undefined : val === notVal;
        if (isNotMatch) return false;
        continue;
      }
      if ('in' in c) {
        if (!Array.isArray(c.in) || !c.in.includes(val)) return false;
        continue;
      }
      throw new Error(`fake tx: unmodelled where operator for '${key}': ${JSON.stringify(cond)}`);
    }
    if (val !== cond) return false;
  }
  return true;
}

type OrderSpec = Record<string, 'asc' | 'desc'>;

function applyOrderBy(rows: Rec[], orderBy: OrderSpec | OrderSpec[]): Rec[] {
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      const [key, dir] = Object.entries(spec)[0]!;
      const av = a[key] as unknown;
      const bv = b[key] as unknown;
      let cmp = 0;
      if (av instanceof Date || bv instanceof Date) {
        cmp = new Date(av as string | Date).getTime() - new Date(bv as string | Date).getTime();
      } else if ((av as string | number) < (bv as string | number)) cmp = -1;
      else if ((av as string | number) > (bv as string | number)) cmp = 1;
      if (dir === 'desc') cmp = -cmp;
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
}

function findFirstGeneric(
  rows: Rec[],
  args: { where?: Record<string, unknown>; orderBy?: OrderSpec | OrderSpec[] },
): Rec | null {
  let filtered = rows.filter((r) => matches(r, args.where));
  if (args.orderBy) filtered = applyOrderBy(filtered, args.orderBy);
  return filtered[0] ?? null;
}

// ---- store -----------------------------------------------------------------

function makeStore() {
  const strategies = new Map<string, Rec>();
  const nodes = new Map<string, Rec>();
  const versions = new Map<string, Rec>();
  const missions = new Map<string, Rec>();
  const runs = new Map<string, Rec>();
  const changeSets = new Map<string, Rec>();
  const dismissals = new Map<string, Rec>();
  const activity: Rec[] = [];
  const outbox: Rec[] = [];
  // Phase 4: the Watch-acceptance chat confirmation. Appended OUTSIDE the fake
  // tx (mirrors the real service calling conversation.append after the
  // transaction commits), so it is deliberately NOT part of snapshot/restore.
  const chatMessages: Rec[] = [];
  const locks = new Map<string, Promise<void>>();
  let seq = 0;
  const nextId = (p: string) => `${p}-${++seq}`;
  const nodesFor = (sid: string) => [...nodes.values()].filter((n) => n.strategyId === sid);
  const liveNodesFor = (sid: string) => nodesFor(sid).filter((n) => n.archivedAt == null);
  return {
    strategies,
    nodes,
    versions,
    missions,
    runs,
    changeSets,
    dismissals,
    activity,
    outbox,
    chatMessages,
    locks,
    nextId,
    nodesFor,
    liveNodesFor,
  };
}
type Store = ReturnType<typeof makeStore>;

function seedStrategy(store: Store, overrides: Partial<Rec> = {}): void {
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
    ...overrides,
  });
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

function seedVersion(store: Store, id: string, createdAt: Date): void {
  store.versions.set(id, {
    id,
    tenantId: T,
    strategyId: SID,
    snapshot: { meta: {}, nodes: [] },
    authorKind: 'person',
    authorUserId: U,
    note: 'unrelated edit',
    restoredFromVersionId: null,
    coalescible: false,
    createdAt,
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
    targetRef: null,
    archivedAt: null,
    createdByUserId: U,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  });
}

// ---- fake tx -----------------------------------------------------------------

function makeTx(store: Store, heldLocks: Array<() => void> = []) {
  const now = new Date();

  const acquireRowLock = async (key: string) => {
    while (store.locks.has(key)) await store.locks.get(key);
    let release!: () => void;
    store.locks.set(key, new Promise<void>((r) => (release = r)));
    heldLocks.push(() => {
      store.locks.delete(key);
      release();
    });
  };

  const attachIncludes = (rec: Rec, include?: { nodes?: unknown; artifacts?: unknown }): Rec => {
    const out: Rec = { ...rec };
    if (include?.nodes) out.nodes = store.liveNodesFor(rec.id);
    if (include?.artifacts) out.artifacts = [];
    return out;
  };

  const spStrategy = {
    findFirst: async (args: { where?: Record<string, unknown>; include?: { nodes?: unknown; artifacts?: unknown } }) => {
      const rec = findFirstGeneric([...store.strategies.values()], args);
      return rec ? attachIncludes(rec, args.include) : null;
    },
    findFirstOrThrow: async (args: { where?: Record<string, unknown>; include?: { nodes?: unknown; artifacts?: unknown } }) => {
      const rec = findFirstGeneric([...store.strategies.values()], args);
      if (!rec) throw new Error('strategy not found');
      return attachIncludes(rec, args.include);
    },
    update: async ({ where, data }: { where: { id: string }; data: Rec }) => {
      const rec = store.strategies.get(where.id);
      if (!rec) throw new Error('strategy not found');
      const merged = { ...rec, ...data, updatedAt: now };
      store.strategies.set(where.id, merged);
      return merged;
    },
  };

  const spNode = {
    findMany: async ({ where }: { where?: Record<string, unknown> }) =>
      [...store.nodes.values()].filter((n) => matches(n, where)),
  };

  const spVersion = {
    findFirst: async (args: { where?: Record<string, unknown>; orderBy?: OrderSpec | OrderSpec[] }) =>
      findFirstGeneric([...store.versions.values()], args),
    findMany: async (args: { where?: Record<string, unknown>; orderBy?: OrderSpec | OrderSpec[] }) => {
      let rows = [...store.versions.values()].filter((r) => matches(r, args.where));
      if (args.orderBy) rows = applyOrderBy(rows, args.orderBy);
      return rows;
    },
    create: async ({ data }: { data: Rec }) => {
      const id = store.nextId('version');
      const rec = { ...data, id };
      store.versions.set(id, rec);
      return rec;
    },
    updateMany: async ({ where, data }: { where: { id: string; coalescible?: boolean }; data: Rec }) => {
      const rec = store.versions.get(where.id);
      if (!rec || (where.coalescible !== undefined && rec.coalescible !== where.coalescible)) {
        return { count: 0 };
      }
      store.versions.set(where.id, { ...rec, ...data });
      return { count: 1 };
    },
  };

  const spAgentMission = {
    findFirst: async (args: { where?: Record<string, unknown>; orderBy?: OrderSpec | OrderSpec[] }) =>
      findFirstGeneric([...store.missions.values()], args),
  };

  const spAgentRun = {
    findFirst: async (args: { where?: Record<string, unknown>; orderBy?: OrderSpec | OrderSpec[] }) =>
      findFirstGeneric([...store.runs.values()], args),
    create: async ({ data }: { data: Rec }) => {
      const dup = [...store.runs.values()].some(
        (r) => r.tenantId === data.tenantId && r.idempotencyKey === data.idempotencyKey,
      );
      if (dup) {
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
    updateMany: async ({ where, data }: { where: { id: string; state?: string }; data: Rec }) => {
      const rec = store.runs.get(where.id);
      if (!rec || (where.state !== undefined && rec.state !== where.state)) return { count: 0 };
      store.runs.set(where.id, { ...rec, ...data, updatedAt: now });
      return { count: 1 };
    },
    count: async ({ where = {} }: { where?: { state?: { in?: string[] } } }) => {
      const states = where.state?.in;
      return [...store.runs.values()].filter((r) => states === undefined || states.includes(r.state as string))
        .length;
    },
  };

  const spChangeSet = {
    findMany: async (args: { where?: Record<string, unknown>; orderBy?: OrderSpec | OrderSpec[] }) => {
      let rows = [...store.changeSets.values()].filter((r) => matches(r, args.where));
      if (args.orderBy) rows = applyOrderBy(rows, args.orderBy);
      return rows;
    },
    findFirst: async (args: { where?: Record<string, unknown>; orderBy?: OrderSpec | OrderSpec[] }) =>
      findFirstGeneric([...store.changeSets.values()], args),
    create: async ({ data }: { data: Rec }) => {
      const id = store.nextId('cs');
      const rec: Rec = {
        approvedOps: null,
        appliedVersionId: null,
        approvedByUserId: null,
        approvedAt: null,
        rejectedByUserId: null,
        rejectedAt: null,
        appliedByUserId: null,
        appliedAt: null,
        undoneByUserId: null,
        undoneAt: null,
        watchKey: null,
        replacesChangeSetId: null,
        supersededByChangeSetId: null,
        recheckStatus: null,
        supersededReason: null,
        runId: null,
        ...data,
        id,
        createdAt: now,
        updatedAt: now,
      };
      store.changeSets.set(id, rec);
      return rec;
    },
    update: async ({ where, data }: { where: { id: string }; data: Rec }) => {
      const rec = store.changeSets.get(where.id);
      if (!rec) throw new Error('change-set not found');
      const merged = { ...rec, ...data, updatedAt: now };
      store.changeSets.set(where.id, merged);
      return merged;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Rec }) => {
      let count = 0;
      for (const rec of store.changeSets.values()) {
        if (!matches(rec, where)) continue;
        store.changeSets.set(rec.id, { ...rec, ...data, updatedAt: now });
        count++;
      }
      return { count };
    },
  };

  const spWatchDismissal = {
    findMany: async ({ where }: { where?: Record<string, unknown> }) =>
      [...store.dismissals.values()].filter((d) => matches(d, where)),
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { tenantId_strategyId_watchKey: { tenantId: string; strategyId: string; watchKey: string } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const key = where.tenantId_strategyId_watchKey;
      const existing = [...store.dismissals.entries()].find(
        ([, d]) => d.tenantId === key.tenantId && d.strategyId === key.strategyId && d.watchKey === key.watchKey,
      );
      if (existing) {
        const [id, rec] = existing;
        const merged = { ...rec, ...update };
        store.dismissals.set(id, merged);
        return merged;
      }
      const id = store.nextId('dismissal');
      const rec = { ...create, id };
      store.dismissals.set(id, rec);
      return rec;
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

  const $queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (/FROM sp_change_set/.test(sql)) {
      const [csId, tenantId] = values as [string, string];
      const rec = store.changeSets.get(csId);
      if (!rec || rec.tenantId !== tenantId) return [];
      await acquireRowLock(`sp_change_set:${csId}`);
      return [{ id: csId }];
    }
    if (/FROM sp_strategy/.test(sql)) {
      const [sid, tenantId] = values as [string, string];
      const rec = store.strategies.get(sid);
      if (!rec || rec.tenantId !== tenantId) return [];
      await acquireRowLock(`sp_strategy:${sid}`);
      return [{ id: sid }];
    }
    if (/FROM sp_agent_mission/.test(sql)) {
      const [missionId, tenantId] = values as [string, string];
      const m = store.missions.get(missionId);
      return m && m.tenantId === tenantId ? [{ id: m.id, state: m.state, strategyId: m.strategyId }] : [];
    }
    throw new Error(`fake tx got an unmodelled raw query: ${sql}`);
  };

  return {
    spStrategy,
    spNode,
    spVersion,
    spAgentMission,
    spAgentRun,
    spChangeSet,
    spWatchDismissal,
    spActivityLog,
    spEventOutbox,
    $queryRaw,
  } as unknown as Prisma.TransactionClient;
}

// ---- service wiring ------------------------------------------------------------

function makeService(store: Store) {
  const snapshot = () => ({
    strategies: new Map(store.strategies),
    nodes: new Map(store.nodes),
    versions: new Map(store.versions),
    missions: new Map(store.missions),
    runs: new Map(store.runs),
    changeSets: new Map(store.changeSets),
    dismissals: new Map(store.dismissals),
    activity: [...store.activity],
    outbox: [...store.outbox],
  });
  const restore = (snap: ReturnType<typeof snapshot>) => {
    store.strategies = snap.strategies;
    store.nodes = snap.nodes;
    store.versions = snap.versions;
    store.missions = snap.missions;
    store.runs = snap.runs;
    store.changeSets = snap.changeSets;
    store.dismissals = snap.dismissals;
    store.activity = snap.activity;
    store.outbox = snap.outbox;
  };
  const inTx = async (fn: (tx: unknown) => Promise<unknown>) => {
    const snap = snapshot();
    const held: Array<() => void> = [];
    try {
      return await fn(makeTx(store, held));
    } catch (e) {
      restore(snap);
      throw e;
    } finally {
      for (const release of held) release();
    }
  };
  const withTenantUser = jest.fn(async (_t: string, _u: string, fn: (tx: unknown) => Promise<unknown>) => inTx(fn));
  const withTenant = jest.fn(async (_t: string, fn: (tx: unknown) => Promise<unknown>) => inTx(fn));
  const prisma = { withTenantUser, withTenant } as unknown as PrismaService;

  const versioning = new VersioningService();
  const runs = new RunsService(prisma, versioning);
  const changeSets = new ChangeSetsService(
    prisma,
    versioning,
    {} as unknown as VersionService,
    {} as unknown as MeriService,
  );

  const groundingValue = {
    fiscal: {
      today: todayIso,
      fys: [CUR_FY - 1, CUR_FY, CUR_FY + 1],
      fyLabels: [CUR_FY - 1, CUR_FY, CUR_FY + 1].map((y) => `FY${String(y).slice(2)}`),
      focalFy: `FY${String(CUR_FY).slice(2)}`,
    },
    firmPhases: [],
    reference: { congress: [] as unknown[], ppbeLanes: [], ppbeCurrentPhases: [] },
  };
  const grounding = jest.fn(async (_t: string) => groundingValue);
  // Real-ish mutation (not a bare stub): subsequent snapshots/rechecks must
  // see an accepted proposal's actual effect, or the recheck-reconciliation
  // tests below (recalculated dates -> Updated) would be vacuous.
  const applyEditSet = jest.fn(
    async (
      _tx: unknown,
      _tenantId: string,
      strategyId: string,
      _actorUserId: string,
      edits: Array<Record<string, unknown>>,
    ) => {
      for (const edit of edits) {
        if (edit.op === 'add') {
          // Phase 4 §5's open_node-action test needs a real created id/title
          // to assert against — mirrors MeriService.applyEdit's create shape
          // just enough for that.
          const id = store.nextId('node');
          store.nodes.set(id, {
            id,
            tenantId: T,
            strategyId,
            kind: (edit.kind as string) ?? 'action',
            subject: (edit.subject as string) ?? 'deliverable',
            title: (edit.title as string) ?? 'New step',
            note: null,
            ownerUserId: null,
            status: (edit.status as string) ?? 'draft',
            startsOn: (edit.startsOn as string) ?? daysFromToday(30),
            endsOn: (edit.endsOn as string | null) ?? null,
            openEnded: false,
            meriAuthored: false,
            dependsOnIds: [],
            provenance: null,
            targetRef: null,
            archivedAt: null,
            createdByUserId: U,
            createdAt: new Date(),
          });
          continue;
        }
        if (edit.op !== 'retime' && edit.op !== 'update') continue;
        const node = store.nodes.get(edit.nodeId as string);
        if (!node) continue;
        if (edit.startsOn !== undefined) node.startsOn = edit.startsOn;
        if ('endsOn' in edit) node.endsOn = edit.endsOn as string | null;
        if (edit.status !== undefined) node.status = edit.status;
      }
    },
  );
  const verifyAppliedPlan = jest.fn(async (_tx: unknown, _t: string, _u: string, strategyId: string) => {
    const strat = store.strategies.get(strategyId)!;
    return {
      detail: { id: strategyId, title: strat.title, type: strat.type, nodes: store.liveNodesFor(strategyId) },
      violations: [] as unknown[],
    };
  });
  const meri = { grounding, applyEditSet, verifyAppliedPlan } as unknown as MeriService;

  const healthValue = {
    status: 'ok' as const,
    factCounts: { active: 0, superseded: 0, stale: 0, rejected: 0 },
    openConflicts: 0,
    openMaterialConflicts: [],
    staleDocs: [],
    missingRequired: [],
  };
  const steward = { health: jest.fn(async () => healthValue) } as unknown as StewardService;
  const flags = { isAgenticFlagEnabled: jest.fn(async () => true) } as unknown as StrategyFlagsService;

  // Phase 4: the real StrategyConversationService is not wired here (no
  // conversation/message store in this fake tx) — a plain jest.fn appending to
  // the store is enough to assert the chat-confirmation contract without
  // reimplementing StrategyConversationService's own (separately-tested)
  // validation/normalization.
  const conversationAppend = jest.fn(async (tenantId: string, input: Record<string, unknown>) => {
    const rec = { ...input, tenantId, id: store.nextId('chat'), createdAt: new Date() };
    store.chatMessages.push(rec);
    return rec;
  });
  const conversation = { append: conversationAppend } as unknown as StrategyConversationService;

  const watcher = new WatcherService(prisma, versioning, flags, runs, changeSets, meri, steward);
  const svc = new WatchReviewService(prisma, versioning, meri, watcher, conversation);

  return {
    svc,
    watcher,
    applyEditSet,
    verifyAppliedPlan,
    grounding,
    withTenant,
    withTenantUser,
    conversationAppend,
  };
}

async function seedOneOpenProposal(
  store: Store,
  nodeOverrides: Partial<Rec> & { id: string },
): Promise<{
  watcher: WatcherService;
  svc: WatchReviewService;
  csId: string;
  watchKey: string;
  conversationAppend: ReturnType<typeof makeService>['conversationAppend'];
}> {
  seedStrategy(store);
  seedMission(store);
  seedNode(store, {
    startsOn: daysFromToday(-14),
    endsOn: daysFromToday(-7),
    status: 'in_progress',
    ...nodeOverrides,
  });
  const { svc, watcher, conversationAppend } = makeService(store);
  const result = await watcher.runCheckNow(T, U, MID);
  const csId = result.changeSetsProposed[0]!;
  return { watcher, svc, csId, watchKey: store.changeSets.get(csId)!.watchKey as string, conversationAppend };
}

// ==== Scenario 5 =================================================================

describe('WatchReviewService.acceptOne — single accept', () => {
  it('cuts exactly ONE version, writes exactly ONE watch.change_applied event (no generic changeset.approved/applied rows), and applies the retime', async () => {
    const store = makeStore();
    const { svc, csId } = await seedOneOpenProposal(store, { id: 'N1' });
    const versionsBefore = store.versions.size;

    const { strategy, state, recheck } = await svc.acceptOne(T, U, csId);

    expect(store.versions.size).toBe(versionsBefore + 1);
    const watchApplied = store.activity.filter((a) => a.action === 'watch.change_applied');
    expect(watchApplied).toHaveLength(1);
    expect(store.activity.some((a) => a.action === 'changeset.applied')).toBe(false);
    expect(store.activity.some((a) => a.action === 'changeset.approved')).toBe(false);
    const cs = store.changeSets.get(csId)!;
    expect(cs.status).toBe('applied');
    expect(cs.approvedByUserId).toBe(U);
    expect(cs.appliedByUserId).toBe(U);
    expect(store.nodes.get('N1')!.startsOn).toBe(daysFromToday(1)); // retimed
    expect((strategy as Rec).id).toBe(SID);
    expect(state.headVersionId).not.toBe('v1');
    expect(recheck.state).toBe('complete');
  });

  it('rejects a non-Watch (no watchKey) change-set — the generic apply endpoint owns that path', async () => {
    const store = makeStore();
    seedStrategy(store);
    store.changeSets.set('cs-manual', {
      id: 'cs-manual',
      tenantId: T,
      strategyId: SID,
      summary: 'Person-authored proposal',
      ops: [],
      risk: 'low',
      status: 'proposed',
      strategyVersionId: 'v1',
      watchKey: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { svc } = makeService(store);

    const err = await svc.acceptOne(T, U, 'cs-manual').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
  });
});

// ==== Scenarios 6 + 7 =============================================================

describe('WatchReviewService — old-head proposals are superseded, never actionable, and unrelated ones reissue as unchanged', () => {
  it('accepting CS1 supersedes the OTHER open proposal (still pinned to the old head) and reissues it pinned to the new head, classified unchanged', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: 'N1', startsOn: daysFromToday(-14), endsOn: daysFromToday(-7), status: 'in_progress' });
    seedNode(store, { id: 'N2', startsOn: daysFromToday(-20), endsOn: daysFromToday(-12), status: 'in_progress' });
    const { svc, watcher } = makeService(store);
    const first = await watcher.runCheckNow(T, U, MID);
    expect(first.changeSetsProposed).toHaveLength(2);
    const cs1 = store.changeSets.get(first.changeSetsProposed.find((id) => store.changeSets.get(id)!.watchKey === 'overdue:N1')!)!;
    const cs2 = store.changeSets.get(first.changeSetsProposed.find((id) => store.changeSets.get(id)!.watchKey === 'overdue:N2')!)!;

    const { state } = await svc.acceptOne(T, U, cs1.id as string);

    // CS2 (N2's independent proposal) is untouched by the accept itself, but
    // the head moved — the post-accept revalidate must reconcile it: same
    // watchKey, IDENTICAL recomputed ops (N2 was never touched) -> unchanged,
    // reissued under a NEW id, old row superseded pointing forward.
    const oldCs2 = store.changeSets.get(cs2.id as string)!;
    expect(oldCs2.status).toBe('superseded');
    expect(oldCs2.supersededByChangeSetId).toBeTruthy();
    const reissued = store.changeSets.get(oldCs2.supersededByChangeSetId as string)!;
    expect(reissued.status).toBe('proposed');
    expect(reissued.recheckStatus).toBe('unchanged');
    expect(reissued.replacesChangeSetId).toBe(cs2.id);
    expect(reissued.strategyVersionId).toBe(state.headVersionId);

    // getState (old-head proposals must NEVER be actionable) shows ONLY the
    // reissued row, never the superseded original.
    expect(state.proposals.map((p) => p.id)).toEqual([reissued.id]);
    expect(state.proposals[0]!.recheckStatus).toBe('unchanged');
  });
});

// ==== Scenario 8 ==================================================================

describe('WatchReviewService — recalculated dates produce Updated', () => {
  it('a dependency-slippage proposal whose target date changes after the accept reissues as recheckStatus: updated', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    // N1: overdue (14..7 days ago, duration 7). N2: a point event that
    // slipped against N1's ORIGINAL end (7 days ago) — before N1 is retimed.
    seedNode(store, { id: 'N1', startsOn: daysFromToday(-14), endsOn: daysFromToday(-7), status: 'in_progress' });
    seedNode(store, { id: 'N2', kind: 'milestone', startsOn: daysFromToday(-10), endsOn: null, dependsOnIds: ['N1'] });
    const { svc, watcher } = makeService(store);
    const first = await watcher.runCheckNow(T, U, MID);
    const cs1 = store.changeSets.get(first.changeSetsProposed.find((id) => store.changeSets.get(id)!.watchKey === 'overdue:N1')!)!;
    const cs2Before = store.changeSets.get(
      first.changeSetsProposed.find((id) => (store.changeSets.get(id)!.watchKey as string).startsWith('dependency-slippage'))!,
    )!;
    // Before accept: N1 ends 7 days ago (past), so N2's slippage target
    // clamps to tomorrow.
    expect((cs2Before.ops as Array<Record<string, unknown>>)[0]!.startsOn).toBe(daysFromToday(1));

    const { state } = await svc.acceptOne(T, U, cs1.id as string);

    // N1 is now retimed to start tomorrow, ending 7 days later — N2's
    // dependency-slippage target is recalculated against N1's NEW (future)
    // end, which is no longer clamped to tomorrow.
    const oldCs2 = store.changeSets.get(cs2Before.id as string)!;
    expect(oldCs2.status).toBe('superseded');
    const reissued = store.changeSets.get(oldCs2.supersededByChangeSetId as string)!;
    expect(reissued.recheckStatus).toBe('updated');
    const newStartsOn = (reissued.ops as Array<Record<string, unknown>>)[0]!.startsOn;
    expect(newStartsOn).not.toBe(daysFromToday(1));
    expect(newStartsOn).toBe(daysFromToday(8)); // N1's new end (1 + 7 duration)
    expect(state.proposals.find((p) => p.id === reissued.id)!.recheckStatus).toBe('updated');
    expect(state.proposals.find((p) => p.id === reissued.id)!.badges).toContain('updated');
  });
});

// ==== Scenario 9 ==================================================================

describe('WatchReviewService — resolved finding is dropped with a plain-language reason', () => {
  it('a proposal whose finding no longer holds is superseded with a reason, and revalidate does NOT no-op (the head moved)', async () => {
    const store = makeStore();
    const { svc, csId, watchKey } = await seedOneOpenProposal(store, { id: 'N1' });
    // Simulate an unrelated human edit that also happens to resolve N1
    // (marking it active) — a NEW version exists, so CS1 becomes a zombie.
    store.nodes.get('N1')!.status = 'active';
    seedVersion(store, 'v2', new Date('2026-07-15T00:00:00.000Z'));

    const state = await svc.revalidate(T, U, SID, 'manual');

    expect(state.lastRecheck!.state).toBe('complete');
    expect(state.lastRecheck!.dropped).toEqual([{ watchKey, reason: expect.any(String), targetDeleted: false }]);
    expect(store.changeSets.get(csId)!.status).toBe('superseded');
    expect(store.changeSets.get(csId)!.supersededReason).toMatch(/no longer an issue/i);
    expect(state.proposals).toEqual([]);
  });
});

// ==== Scenario 10 =================================================================

describe('WatchReviewService — deleted target is dropped without a 404/error response', () => {
  it('archiving the proposal\'s target node drops the proposal with targetDeleted:true, no exception thrown', async () => {
    const store = makeStore();
    const { csId, watchKey } = await seedOneOpenProposal(store, { id: 'N1' });
    store.nodes.get('N1')!.archivedAt = new Date();
    seedVersion(store, 'v2', new Date('2026-07-15T00:00:00.000Z'));
    const { svc } = makeService(store);

    const state = await svc.revalidate(T, U, SID, 'manual');

    expect(state.lastRecheck!.dropped).toEqual([{ watchKey, reason: expect.any(String), targetDeleted: true }]);
    expect(store.changeSets.get(csId)!.status).toBe('superseded');
    expect(state.proposals).toEqual([]);
  });
});

// ==== Scenarios 11 + 12 ===========================================================

describe('WatchReviewService.revalidate — panel-open fast no-op vs refresh-after-edit', () => {
  it('is a no-op (does not call runCheckNow again) when every proposal is already pinned to the current head and the run is fresh', async () => {
    const store = makeStore();
    const { svc, watcher } = await seedOneOpenProposal(store, { id: 'N1' });
    const spy = jest.spyOn(watcher, 'runCheckNow');

    const state = await svc.revalidate(T, U, SID, 'panel-open');

    expect(spy).not.toHaveBeenCalled();
    expect(state.lastRecheck).toEqual({ state: 'complete', elapsedMs: expect.any(Number), unchanged: [], updated: [], dropped: [] });
    expect(state.proposals).toHaveLength(1);
  });

  it('DOES run a fresh check when a human edit moved the head since the last check', async () => {
    const store = makeStore();
    const { svc, watcher } = await seedOneOpenProposal(store, { id: 'N1' });
    const spy = jest.spyOn(watcher, 'runCheckNow');
    seedVersion(store, 'v2', new Date('2026-07-20T00:00:00.000Z'));

    const state = await svc.revalidate(T, U, SID, 'panel-open');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(state.lastRecheck!.state).toBe('complete');
  });

  it('returns a no-mission, no-op state gracefully when Watch has never been turned on for this strategy', async () => {
    const store = makeStore();
    seedStrategy(store);
    const { svc } = makeService(store);

    const state = await svc.revalidate(T, U, SID, 'panel-open');

    expect(state.mission).toBeNull();
    expect(state.proposals).toEqual([]);
    expect(state.lastRecheck!.state).toBe('complete');
  });
});

// ==== Scenario 13 =================================================================

describe('WatchReviewService.acceptAll — atomic batch', () => {
  it('applies one dependency-ordered edit-set, cuts exactly ONE version, and writes exactly ONE watch.batch_applied event', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: 'N1', startsOn: daysFromToday(-14), endsOn: daysFromToday(-7), status: 'in_progress' });
    seedNode(store, { id: 'N2', startsOn: daysFromToday(-20), endsOn: daysFromToday(-12), status: 'in_progress' });
    const { svc, watcher } = makeService(store);
    const first = await watcher.runCheckNow(T, U, MID);
    expect(first.changeSetsProposed).toHaveLength(2);
    const versionsBefore = store.versions.size;

    const { state, recheck } = await svc.acceptAll(T, U, SID, 'v1', first.changeSetsProposed);

    expect(store.versions.size).toBe(versionsBefore + 1);
    const batchEvents = store.activity.filter((a) => a.action === 'watch.batch_applied');
    expect(batchEvents).toHaveLength(1);
    expect((batchEvents[0]!.after as Rec).proposalIds).toEqual(first.changeSetsProposed);
    expect(store.activity.some((a) => a.action === 'watch.change_applied')).toBe(false);
    for (const id of first.changeSetsProposed) {
      expect(store.changeSets.get(id)!.status).toBe('applied');
    }
    expect(store.nodes.get('N1')!.startsOn).toBe(daysFromToday(1));
    expect(store.nodes.get('N2')!.startsOn).toBe(daysFromToday(1));
    expect(recheck.state).toBe('complete');
    expect(state.proposals).toEqual([]); // both accepted, nothing left open
  });

  it('orders the combined ops dependency-safely before applying (wiring check — pure ordering itself is covered by watch-batch-order.spec.ts)', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    // B depends on A; both overdue, so both get independent retime proposals
    // with NO natural ordering constraint from the finding shape alone — the
    // point is that acceptAll consults the LIVE graph, not proposal order.
    seedNode(store, { id: 'A', startsOn: daysFromToday(-14), endsOn: daysFromToday(-7), status: 'in_progress' });
    seedNode(store, {
      id: 'B',
      startsOn: daysFromToday(-14),
      endsOn: daysFromToday(-7),
      status: 'in_progress',
      dependsOnIds: ['A'],
    });
    const { svc, watcher, applyEditSet } = makeService(store);
    const first = await watcher.runCheckNow(T, U, MID);
    // Submit in B-then-A order deliberately.
    const csB = first.changeSetsProposed.find((id) => store.changeSets.get(id)!.watchKey === 'overdue:B')!;
    const csA = first.changeSetsProposed.find((id) => store.changeSets.get(id)!.watchKey === 'overdue:A')!;

    await svc.acceptAll(T, U, SID, 'v1', [csB, csA]);

    const appliedOps = applyEditSet.mock.calls[0]![4] as Array<{ nodeId: string }>;
    const order = appliedOps.map((o) => o.nodeId);
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'));
  });
});

// ==== Scenario 15 =================================================================

describe('WatchReviewService.acceptAll — one invalid/stale proposal rolls the whole batch back', () => {
  it('rejects and applies NOTHING when expectedVersionId is not the current head', async () => {
    const store = makeStore();
    const { csId } = await seedOneOpenProposal(store, { id: 'N1' });
    seedVersion(store, 'v2', new Date('2026-07-20T00:00:00.000Z')); // head moved
    const { svc } = makeService(store);

    const err = await svc.acceptAll(T, U, SID, 'v1', [csId]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(store.changeSets.get(csId)!.status).toBe('proposed');
  });

  it('rejects and applies NOTHING when one of several proposals is not proposed (e.g. already applied)', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: 'N1', startsOn: daysFromToday(-14), endsOn: daysFromToday(-7), status: 'in_progress' });
    seedNode(store, { id: 'N2', startsOn: daysFromToday(-20), endsOn: daysFromToday(-12), status: 'in_progress' });
    const { svc, watcher } = makeService(store);
    const first = await watcher.runCheckNow(T, U, MID);
    const [csA, csB] = first.changeSetsProposed;
    store.changeSets.get(csB!)!.status = 'applied'; // simulate a prior accept

    const err = await svc.acceptAll(T, U, SID, 'v1', [csA!, csB!]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(store.changeSets.get(csA!)!.status).toBe('proposed'); // NOT applied — whole batch rejected
  });

  it('requires at least one proposal id', async () => {
    const store = makeStore();
    seedStrategy(store);
    const { svc } = makeService(store);

    const err = await svc.acceptAll(T, U, SID, 'v1', []).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
  });
});

// ==== Scenario 16 =================================================================

describe('WatchReviewService — concurrent accept calls serialize on the change-set row lock', () => {
  it('two concurrent acceptOne calls on the SAME proposal: only one applies, the loser sees the committed status and 409s', async () => {
    const store = makeStore();
    const { csId } = await seedOneOpenProposal(store, { id: 'N1' });
    const { svc, applyEditSet } = makeService(store);

    let entered!: () => void;
    const entered$ = new Promise<void>((r) => (entered = r));
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => (releaseGate = r));
    applyEditSet.mockImplementationOnce(async () => {
      entered();
      await gate;
    });

    const first = svc.acceptOne(T, U, csId);
    await entered$;
    const second = svc.acceptOne(T, U, csId).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 0)); // let tx2 park on the row lock
    releaseGate();

    const firstResult = await first;
    const secondResult = await second;

    expect((firstResult.strategy as Rec).id).toBe(SID);
    expect(secondResult).toBeInstanceOf(ConflictException);
    // No final-store assert here: the fake's whole-store rollback on the
    // loser's in-tx throw models single-tx rollback, not real MVCC, so it
    // would also (incorrectly) revert the winner's already-committed write —
    // the SAME documented limitation change-sets.service.spec.ts's analogous
    // concurrent-apply test calls out. The promise outcomes plus the call
    // count are the load-bearing facts: the winner resolved, the loser saw a
    // real 409 off the committed row, and the edit-set replayed exactly once.
    expect(applyEditSet).toHaveBeenCalledTimes(1);
  });
});

// ==== Scenario 17 =================================================================

describe('WatchReviewService — concurrent single accept and batch accept cannot double-apply', () => {
  it('acceptOne(cs1) racing acceptAll([cs1, cs2]): the loser fails cleanly, cs1 is applied exactly once', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: 'N1', startsOn: daysFromToday(-14), endsOn: daysFromToday(-7), status: 'in_progress' });
    seedNode(store, { id: 'N2', startsOn: daysFromToday(-20), endsOn: daysFromToday(-12), status: 'in_progress' });
    const { svc, watcher, applyEditSet } = makeService(store);
    const first = await watcher.runCheckNow(T, U, MID);
    const [cs1, cs2] = first.changeSetsProposed;

    let entered!: () => void;
    const entered$ = new Promise<void>((r) => (entered = r));
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => (releaseGate = r));
    applyEditSet.mockImplementationOnce(async () => {
      entered();
      await gate;
    });

    const single = svc.acceptOne(T, U, cs1!);
    await entered$;
    const batch = svc.acceptAll(T, U, SID, 'v1', [cs1!, cs2!]).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 0));
    releaseGate();

    await single;
    const batchResult = await batch;

    // No final-store assert (see the scenario-16 test's comment — the fake's
    // whole-store rollback on the loser's in-tx throw isn't real MVCC).
    // Whichever wins the row lock, the edit-set replays exactly once — the
    // loser's precondition check (status !== 'proposed') rejects cleanly
    // rather than double-applying.
    expect(applyEditSet).toHaveBeenCalledTimes(1);
    if (batchResult instanceof Error) {
      expect(batchResult).toBeInstanceOf(ConflictException);
    }
  });
});

// ==== Scenario 18 =================================================================

describe('WatchReviewService.acceptOne — post-commit recheck failure', () => {
  it('the accept itself commits (version cut, node retimed) even when the FOLLOW-UP revalidate throws; returns recheck.state "failed"', async () => {
    const store = makeStore();
    const { svc, watcher, csId } = await seedOneOpenProposal(store, { id: 'N1' });
    jest.spyOn(watcher, 'runCheckNow').mockRejectedValueOnce(new Error('orchestrator unavailable'));

    const { state, recheck } = await svc.acceptOne(T, U, csId);

    expect(store.changeSets.get(csId)!.status).toBe('applied'); // NOT rolled back
    expect(store.nodes.get('N1')!.startsOn).toBe(daysFromToday(1));
    expect(recheck.state).toBe('failed');
    expect(state.lastRecheck!.state).toBe('failed');
  });
});

// ==== Dismiss (Step 4) — end-to-end via WatchReviewService.dismiss ================

describe('WatchReviewService.dismiss', () => {
  it('permanently suppresses the finding: rejects the row, records the dismissal, and a later recheck never reissues it', async () => {
    const store = makeStore();
    const { svc, csId, watchKey } = await seedOneOpenProposal(store, { id: 'N1' });

    const state = await svc.dismiss(T, U, csId);

    expect(state.proposals).toEqual([]);
    const cs = store.changeSets.get(csId)!;
    expect(cs.status).toBe('rejected');
    const dismissal = [...store.dismissals.values()].find((d) => d.watchKey === watchKey);
    expect(dismissal).toBeDefined();
    expect(dismissal!.strategyId).toBe(SID);
    expect(store.activity.some((a) => a.action === 'watch.proposal_dismissed')).toBe(true);

    // A later re-check (head moved, so it's not a no-op) must never reissue it.
    seedVersion(store, 'v2', new Date('2026-07-20T00:00:00.000Z'));
    const after = await svc.revalidate(T, U, SID, 'manual');
    expect(after.proposals).toEqual([]);
    expect(store.changeSets.size).toBe(1); // still just the one, now-rejected row
  });

  it('a dismissal on a DIFFERENT strategy does not affect this one (scoped upsert key)', async () => {
    const store = makeStore();
    const { csId, watchKey } = await seedOneOpenProposal(store, { id: 'N1' });
    const { svc } = makeService(store);
    // A pre-existing dismissal for the SAME watchKey under a different strategy.
    store.dismissals.set('other', {
      id: 'other',
      tenantId: T,
      strategyId: 'OTHER-STRATEGY',
      watchKey,
      dismissedByUserId: U,
      dismissedAt: new Date(),
      sourceChangeSetId: null,
    });

    const state = await svc.dismiss(T, U, csId);

    expect(state.proposals).toEqual([]);
    expect(store.dismissals.size).toBe(2); // the pre-existing one, untouched, plus this strategy's new one
    const thisOne = [...store.dismissals.values()].find((d) => d.strategyId === SID)!;
    expect(thisOne.watchKey).toBe(watchKey);
  });

  it('rejects dismissing an already-resolved proposal', async () => {
    const store = makeStore();
    const { svc, csId } = await seedOneOpenProposal(store, { id: 'N1' });
    store.changeSets.get(csId)!.status = 'applied';

    const err = await svc.dismiss(T, U, csId).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
  });
});

// ==== getState display order (dependency sorts above calendar) ====================

describe('WatchReviewService.getState — display order', () => {
  it('sorts a dependency finding above a calendar (overdue) finding, and marks it out_of_order', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: 'CAL', startsOn: daysFromToday(-14), endsOn: daysFromToday(-7), status: 'in_progress' });
    seedNode(store, { id: 'DEP-A', startsOn: daysFromToday(20), endsOn: daysFromToday(30) });
    seedNode(store, { id: 'DEP-B', startsOn: daysFromToday(5), endsOn: daysFromToday(10), dependsOnIds: ['DEP-A'] });
    const { svc, watcher } = makeService(store);
    await watcher.runCheckNow(T, U, MID);

    const state = await svc.getState(T, SID);

    expect(state.proposals.length).toBeGreaterThanOrEqual(2);
    const depIdx = state.proposals.findIndex((p) => p.badges.includes('out_of_order'));
    const calIdx = state.proposals.findIndex((p) => p.watchKey === 'overdue:CAL');
    expect(depIdx).toBeGreaterThanOrEqual(0);
    expect(calIdx).toBeGreaterThanOrEqual(0);
    expect(depIdx).toBeLessThan(calIdx);
  });
});

// ==== Phase 4 §5: Watch-acceptance chat confirmation ===============================

describe('WatchReviewService — Watch chat confirmation (Phase 4 §5)', () => {
  it('acceptOne appends exactly ONE watch_applied chat message summarizing the change and recheck outcome', async () => {
    const store = makeStore();
    const { svc, csId } = await seedOneOpenProposal(store, { id: 'N1' });

    await svc.acceptOne(T, U, csId);

    expect(store.chatMessages).toHaveLength(1);
    const msg = store.chatMessages[0]!;
    expect(msg.strategyId).toBe(SID);
    expect(msg.nodeId).toBeNull();
    expect(msg.role).toBe('meri');
    expect(msg.kind).toBe('watch_applied');
    expect(msg.body).toContain('Accepted a Watch proposal');
    expect(msg.body).toContain('No other open proposals needed a recheck.');
    // The retime-only path creates no step, so no Open-node affordance.
    expect(msg.action).toBeNull();
  });

  it('acceptAll appends exactly ONE watch_applied message for the whole batch, never one per proposal', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: 'N1', startsOn: daysFromToday(-14), endsOn: daysFromToday(-7), status: 'in_progress' });
    seedNode(store, { id: 'N2', startsOn: daysFromToday(-20), endsOn: daysFromToday(-12), status: 'in_progress' });
    const { svc, watcher } = makeService(store);
    const first = await watcher.runCheckNow(T, U, MID);

    await svc.acceptAll(T, U, SID, 'v1', first.changeSetsProposed);

    expect(store.chatMessages).toHaveLength(1);
    expect(store.chatMessages[0]!.body).toContain('Accepted 2 Watch proposals');
  });

  it('a proposal whose op CREATES a step attaches the open_node action, pointing at the real created id', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    store.changeSets.set('cs-add', {
      id: 'cs-add',
      tenantId: T,
      strategyId: SID,
      runId: null,
      summary: '[watch:manual:add-step] Add a coalition letter',
      ops: [
        {
          op: 'add',
          kind: 'action',
          subject: 'deliverable',
          title: 'Coalition sign-on letter',
          startsOn: daysFromToday(30),
          status: 'draft',
        },
      ],
      approvedOps: null,
      risk: 'low',
      status: 'proposed',
      strategyVersionId: 'v1',
      appliedVersionId: null,
      approvedByUserId: null,
      approvedAt: null,
      rejectedByUserId: null,
      rejectedAt: null,
      appliedByUserId: null,
      appliedAt: null,
      undoneByUserId: null,
      undoneAt: null,
      watchKey: 'manual:add-step',
      replacesChangeSetId: null,
      supersededByChangeSetId: null,
      recheckStatus: null,
      supersededReason: null,
      createdByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { svc } = makeService(store);

    await svc.acceptOne(T, U, 'cs-add');

    expect(store.chatMessages).toHaveLength(1);
    expect(store.chatMessages[0]!.action).toEqual({
      type: 'open_node',
      nodeId: expect.any(String),
      title: 'Coalition sign-on letter',
    });
  });

  it('a chat-append failure does not fail the accept — the plan edit already committed', async () => {
    const store = makeStore();
    const { svc, csId, conversationAppend } = await seedOneOpenProposal(store, { id: 'N1' });
    conversationAppend.mockRejectedValueOnce(new Error('conversation service unavailable'));

    const { strategy } = await svc.acceptOne(T, U, csId);

    expect(strategy).toBeTruthy();
    expect(store.changeSets.get(csId)!.status).toBe('applied');
    expect(store.nodes.get('N1')!.startsOn).toBe(daysFromToday(1)); // the retime still landed
  });
});

// ==== Phase 4 §6: aggregate pending counts for the library nudge ===================

describe('WatchReviewService.getPendingCounts', () => {
  it('counts current-head open Watch proposals per strategy across the whole tenant', async () => {
    const store = makeStore();
    seedStrategy(store); // SID / v1
    seedNode(store, { id: 'N1', startsOn: daysFromToday(-14), endsOn: daysFromToday(-7), status: 'in_progress' });
    store.strategies.set('S2', { ...store.strategies.get(SID)!, id: 'S2' });
    store.versions.set('v2-head', { ...store.versions.get('v1')!, id: 'v2-head', strategyId: 'S2' });
    const mkCs = (id: string, strategyId: string, versionId: string, watchKey: string) =>
      store.changeSets.set(id, {
        id,
        tenantId: T,
        strategyId,
        runId: null,
        summary: `[watch:${watchKey}] test`,
        ops: [],
        approvedOps: null,
        risk: 'low',
        status: 'proposed',
        strategyVersionId: versionId,
        appliedVersionId: null,
        approvedByUserId: null,
        approvedAt: null,
        rejectedByUserId: null,
        rejectedAt: null,
        appliedByUserId: null,
        appliedAt: null,
        undoneByUserId: null,
        undoneAt: null,
        watchKey,
        replacesChangeSetId: null,
        supersededByChangeSetId: null,
        recheckStatus: null,
        supersededReason: null,
        createdByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    mkCs('cs1', SID, 'v1', 'k1');
    mkCs('cs2', SID, 'v1', 'k2');
    mkCs('cs3', 'S2', 'v2-head', 'k3');
    const { svc } = makeService(store);

    const counts = await svc.getPendingCounts(T);

    expect(counts).toEqual({ [SID]: 2, S2: 1 });
  });

  it('excludes a dismissed watchKey', async () => {
    const store = makeStore();
    const { csId, watchKey, svc } = await seedOneOpenProposal(store, { id: 'N1' });
    await svc.dismiss(T, U, csId);

    const counts = await svc.getPendingCounts(T);

    expect(counts[SID]).toBeUndefined();
    expect(store.dismissals.size).toBeGreaterThan(0);
    void watchKey;
  });

  it('excludes a proposal pinned to a version other than the current head', async () => {
    const store = makeStore();
    const { svc } = await seedOneOpenProposal(store, { id: 'N1' });
    seedVersion(store, 'v2', new Date('2026-08-01T00:00:00.000Z')); // moves the head past the proposal's pin

    const counts = await svc.getPendingCounts(T);

    expect(counts[SID]).toBeUndefined();
  });

  it('excludes a proposal whose target step is no longer live (deleted-target)', async () => {
    const store = makeStore();
    const { svc, csId } = await seedOneOpenProposal(store, { id: 'N1' });
    store.nodes.get('N1')!.archivedAt = new Date();

    const counts = await svc.getPendingCounts(T);

    expect(counts[SID]).toBeUndefined();
    void csId;
  });

  it('returns an empty object when nothing is open, without touching version/node/dismissal tables', async () => {
    const store = makeStore();
    const { svc } = makeService(store);
    const versionsSpy = jest.spyOn(store.versions, 'values');
    const nodesSpy = jest.spyOn(store.nodes, 'values');
    const dismissalsSpy = jest.spyOn(store.dismissals, 'values');

    const counts = await svc.getPendingCounts(T);

    expect(counts).toEqual({});
    // Short-circuits on the empty change-set scan — no reason to touch the rest.
    expect(versionsSpy).not.toHaveBeenCalled();
    expect(nodesSpy).not.toHaveBeenCalled();
    expect(dismissalsSpy).not.toHaveBeenCalled();
  });

  it('does ONE pass over each table regardless of strategy count — never N queries per row', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedNode(store, { id: 'N1', startsOn: daysFromToday(-14), endsOn: daysFromToday(-7), status: 'in_progress' });
    for (let i = 0; i < 5; i++) {
      const sid = `S-extra-${i}`;
      store.strategies.set(sid, { ...store.strategies.get(SID)!, id: sid });
      store.versions.set(`v-${sid}`, { ...store.versions.get('v1')!, id: `v-${sid}`, strategyId: sid });
      store.changeSets.set(`cs-${sid}`, {
        id: `cs-${sid}`,
        tenantId: T,
        strategyId: sid,
        runId: null,
        summary: '[watch:k] test',
        ops: [],
        approvedOps: null,
        risk: 'low',
        status: 'proposed',
        strategyVersionId: `v-${sid}`,
        appliedVersionId: null,
        approvedByUserId: null,
        approvedAt: null,
        rejectedByUserId: null,
        rejectedAt: null,
        appliedByUserId: null,
        appliedAt: null,
        undoneByUserId: null,
        undoneAt: null,
        watchKey: 'k',
        replacesChangeSetId: null,
        supersededByChangeSetId: null,
        recheckStatus: null,
        supersededReason: null,
        createdByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    const { svc } = makeService(store);
    const versionsSpy = jest.spyOn(store.versions, 'values');
    const nodesSpy = jest.spyOn(store.nodes, 'values');
    const dismissalsSpy = jest.spyOn(store.dismissals, 'values');
    const changeSetsSpy = jest.spyOn(store.changeSets, 'values');

    const counts = await svc.getPendingCounts(T);

    // SID itself has a node but no change-set — only the 5 extra strategies
    // (each with one open proposal) should appear.
    expect(Object.keys(counts)).toHaveLength(5);
    expect(changeSetsSpy).toHaveBeenCalledTimes(1);
    expect(versionsSpy).toHaveBeenCalledTimes(1);
    expect(nodesSpy).toHaveBeenCalledTimes(1);
    expect(dismissalsSpy).toHaveBeenCalledTimes(1);
  });
});
