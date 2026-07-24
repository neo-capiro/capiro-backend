import { describe, expect, it } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import { VersionService } from './version.service.js';
import { VersioningService } from './versioning.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { StrategySnapshot } from './versioning.js';

/*
 * VersionService.restore() had ZERO dedicated tests despite: (a) being the one
 * path that recreates sp_node rows wholesale from a stored JSON blob, and (b)
 * carrying an explicit `?? []` guard (version.service.ts:98) for snapshots cut
 * BEFORE Stage A added depends_on_ids — a real backward-compatibility path
 * that has never been exercised. Uses the REAL VersioningService (not a mock)
 * so cutVersion's snapshot-rebuild + coalescible/restoredFromVersionId wiring
 * is genuinely verified, mirroring meri.service.spec.ts's "use the real
 * collaborator, fake only the DB" style.
 */

interface Rec {
  [k: string]: unknown;
  id: string;
}

const T = 'tenant-1';
const U = 'user-1';
const STRATEGY_ID = 'S1';

function makeStore() {
  const strategies = new Map<string, Rec>();
  const nodes = new Map<string, Rec>();
  const versions = new Map<string, Rec>();
  const activity: Rec[] = [];
  let seq = 0;
  const nextId = (p: string) => `${p}-${++seq}`;
  const nodesFor = (sid: string) =>
    [...nodes.values()]
      .filter((n) => n.strategyId === sid)
      .sort((a, b) => {
        const sa = (a.startsOn as Date).getTime();
        const sb = (b.startsOn as Date).getTime();
        if (sa !== sb) return sa - sb;
        return (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime();
      });
  return { strategies, nodes, versions, activity, nextId, nodesFor };
}
type Store = ReturnType<typeof makeStore>;

function seedStrategy(store: Store, sid = STRATEGY_ID): void {
  store.strategies.set(sid, {
    id: sid,
    tenantId: T,
    clientId: 'C1',
    title: 'Live title',
    type: 'appropriations',
    goal: 'live goal',
    meriContext: null,
    meriSummary: null,
    targetDate: null,
    ownerUserId: U,
    createdByUserId: U,
    createdAt: new Date('2027-01-01T00:00:00.000Z'),
    lastEditedByUserId: null,
    lastEditedAt: null,
  });
}

/** Seed a CURRENT node on the live strategy (to prove restore fully replaces
 *  the set, not merges into it). */
function seedCurrentNode(store: Store, id: string): void {
  store.nodes.set(id, {
    id,
    tenantId: T,
    strategyId: STRATEGY_ID,
    kind: 'action',
    subject: 'deliverable',
    title: 'Node added after the version being restored',
    note: null,
    ownerUserId: null,
    status: 'active',
    startsOn: new Date('2027-06-01T00:00:00.000Z'),
    endsOn: null,
    openEnded: false,
    dependsOnIds: [],
    meriAuthored: false,
    createdByUserId: U,
    createdAt: new Date('2027-06-01T00:00:00.000Z'),
  });
}

function seedVersion(store: Store, id: string, snapshot: unknown, extra: Partial<Rec> = {}): void {
  store.versions.set(id, {
    id,
    tenantId: T,
    strategyId: STRATEGY_ID,
    snapshot,
    authorKind: 'person',
    authorUserId: U,
    note: 'a prior version',
    restoredFromVersionId: null,
    coalescible: false,
    createdAt: new Date('2027-02-01T10:00:00.000Z'),
    ...extra,
  });
}

/** A snapshot node shape matching what buildSnapshot() emits TODAY. */
function snapNode(overrides: Partial<StrategySnapshot['nodes'][number]> = {}): StrategySnapshot['nodes'][number] {
  return {
    id: 'n-restored-1',
    kind: 'action',
    subject: 'deliverable',
    title: 'Snapshot node',
    note: null,
    ownerUserId: null,
    status: 'active',
    startsOn: '2027-03-01',
    endsOn: null,
    openEnded: false,
    dependsOnIds: [],
    meriAuthored: false,
    createdByUserId: U,
    createdAt: '2027-02-01T10:00:00.000Z',
    ...overrides,
  };
}

function baseSnapshot(nodes: StrategySnapshot['nodes']): StrategySnapshot {
  return {
    meta: {
      id: STRATEGY_ID,
      clientId: 'C1',
      title: 'Snapshotted title',
      type: 'appropriations',
      goal: 'snapshotted goal',
      meriContext: null,
      meriSummary: null,
      targetDate: null,
      ownerUserId: U,
      createdByUserId: U,
      createdAt: '2027-01-01T00:00:00.000Z',
    },
    nodes,
  };
}

function makeTx(store: Store) {
  const now = new Date();
  const spNode = {
    createMany: async ({ data }: { data: Rec[] }) => {
      for (const d of data) store.nodes.set(d.id as string, { ...d });
      return { count: data.length };
    },
    deleteMany: async ({ where }: { where: { strategyId: string } }) => {
      let count = 0;
      for (const [id, n] of store.nodes) {
        if (n.strategyId === where.strategyId) {
          store.nodes.delete(id);
          count += 1;
        }
      }
      return { count };
    },
  };
  const spVersion = {
    findFirst: async ({ where }: { where: { id?: string; strategyId?: string } }) => {
      const rows = [...store.versions.values()]
        .filter((v) => (where.strategyId ? v.strategyId === where.strategyId : true))
        .filter((v) => (where.id ? v.id === where.id : true))
        .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime());
      return rows[0] ?? null;
    },
    create: async ({ data }: { data: Rec }) => {
      const id = store.nextId('version');
      const rec = { ...data, id };
      store.versions.set(id, rec);
      return rec;
    },
    update: async ({ where, data }: { where: { id: string }; data: Rec }) => {
      const rec = store.versions.get(where.id);
      if (!rec) throw new Error('version not found');
      const merged = { ...rec, ...data };
      store.versions.set(where.id, merged);
      return merged;
    },
  };
  const attach = (rec: Rec, include?: { nodes?: unknown; artifacts?: unknown }) => {
    const out: Rec = { ...rec };
    if (include?.nodes) out.nodes = store.nodesFor(rec.id);
    if (include?.artifacts) out.artifacts = [];
    return out;
  };
  const spStrategy = {
    update: async ({ where, data }: { where: { id: string }; data: Rec }) => {
      const rec = store.strategies.get(where.id);
      if (!rec) throw new Error('strategy not found');
      const merged = { ...rec, ...data };
      store.strategies.set(where.id, merged);
      return merged;
    },
    findFirstOrThrow: async ({
      where,
      include,
    }: {
      where: { id: string };
      include?: { nodes?: unknown; artifacts?: unknown };
    }) => {
      const rec = store.strategies.get(where.id);
      if (!rec) throw new Error('strategy not found');
      return attach(rec, include);
    },
  };
  const spActivityLog = {
    create: async ({ data }: { data: Rec }) => {
      store.activity.push({ ...data, id: store.nextId('activity'), createdAt: now });
    },
  };
  // Stage C: logActivity unconditionally emits a transactional-outbox row in
  // the same tx — the fake tx must accept it.
  const spEventOutbox = {
    create: async ({ data }: { data: Rec }) => ({ ...data, id: store.nextId('outbox') }),
  };
  return { spNode, spVersion, spStrategy, spActivityLog, spEventOutbox } as unknown as Parameters<
    Parameters<PrismaService['withTenantUser']>[2]
  >[0];
}

function makeService(store: Store): VersionService {
  const prisma = {
    withTenantUser: async (_t: string, _u: string, fn: (tx: unknown) => unknown) => fn(makeTx(store)),
    withTenant: async (_t: string, fn: (tx: unknown) => unknown) => fn(makeTx(store)),
  } as unknown as PrismaService;
  return new VersionService(prisma, new VersioningService());
}

describe('VersionService.restore', () => {
  it('throws NotFoundException for an unknown version and mutates nothing', async () => {
    const store = makeStore();
    seedStrategy(store);
    const svc = makeService(store);
    await expect(svc.restore(T, U, STRATEGY_ID, 'no-such-version')).rejects.toThrow(NotFoundException);
    expect(store.nodes.size).toBe(0);
    expect(store.versions.size).toBe(0);
  });

  it('legacy-snapshot guard: a node with NO dependsOnIds key restores to [] instead of crashing/undefined', async () => {
    const store = makeStore();
    seedStrategy(store);
    const legacyNode = snapNode({ id: 'n-legacy' });
    delete (legacyNode as Partial<typeof legacyNode>).dependsOnIds; // simulate a pre-A2 snapshot blob
    seedVersion(store, 'v-old', baseSnapshot([legacyNode]));
    const svc = makeService(store);

    await svc.restore(T, U, STRATEGY_ID, 'v-old');

    const restored = store.nodes.get('n-legacy');
    expect(restored).toBeDefined();
    expect(restored!.dependsOnIds).toEqual([]);
  });

  it('preserves dependsOnIds when the snapshot has them', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedVersion(
      store,
      'v1',
      baseSnapshot([
        snapNode({ id: 'n-a', dependsOnIds: [] }),
        snapNode({ id: 'n-b', title: 'depends on a', dependsOnIds: ['n-a'] }),
      ]),
    );
    const svc = makeService(store);

    await svc.restore(T, U, STRATEGY_ID, 'v1');

    expect(store.nodes.get('n-b')!.dependsOnIds).toEqual(['n-a']);
  });

  it('preserves node ids from the snapshot (identity survives restore, per the class doc comment)', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedVersion(store, 'v1', baseSnapshot([snapNode({ id: 'stable-id-123' })]));
    const svc = makeService(store);

    await svc.restore(T, U, STRATEGY_ID, 'v1');

    expect(store.nodes.has('stable-id-123')).toBe(true);
  });

  it('fully replaces the node set — nodes added after the version was cut are gone post-restore', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedCurrentNode(store, 'n-newer');
    seedVersion(store, 'v1', baseSnapshot([snapNode({ id: 'n-old' })]));
    const svc = makeService(store);

    await svc.restore(T, U, STRATEGY_ID, 'v1');

    expect(store.nodes.has('n-newer')).toBe(false);
    expect(store.nodes.has('n-old')).toBe(true);
    expect(store.nodesFor(STRATEGY_ID)).toHaveLength(1);
  });

  it('handles an empty-node snapshot without crashing on createMany([])', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedCurrentNode(store, 'n-newer');
    seedVersion(store, 'v1', baseSnapshot([]));
    const svc = makeService(store);

    await svc.restore(T, U, STRATEGY_ID, 'v1');

    expect(store.nodesFor(STRATEGY_ID)).toHaveLength(0);
  });

  it('cuts a fresh, non-coalescible version stamped with restoredFromVersionId and a "Restored version from" note', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedVersion(store, 'v-target', baseSnapshot([snapNode()]));
    const svc = makeService(store);

    await svc.restore(T, U, STRATEGY_ID, 'v-target');

    const cut = [...store.versions.values()].find((v) => v.id !== 'v-target');
    expect(cut).toBeDefined();
    expect(cut!.restoredFromVersionId).toBe('v-target');
    expect(cut!.coalescible).toBe(false);
    expect(cut!.authorKind).toBe('person');
    expect(String(cut!.note)).toMatch(/^Restored version from/);
  });

  it('logs a version.restored activity row referencing the restored version', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedVersion(store, 'v-target', baseSnapshot([snapNode()]));
    const svc = makeService(store);

    await svc.restore(T, U, STRATEGY_ID, 'v-target');

    expect(store.activity).toHaveLength(1);
    expect(store.activity[0]!.action).toBe('version.restored');
    expect((store.activity[0]!.before as Record<string, unknown>).restoredFromVersionId).toBe('v-target');
  });

  it('updates the strategy meta fields (title/type/goal/etc.) from the snapshot', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedVersion(store, 'v1', baseSnapshot([snapNode()]));
    const svc = makeService(store);

    const result = await svc.restore(T, U, STRATEGY_ID, 'v1');

    expect(result.title).toBe('Snapshotted title');
    expect(result.goal).toBe('snapshotted goal');
  });
});
