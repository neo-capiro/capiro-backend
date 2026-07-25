import { describe, expect, it } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import { VersionService } from './version.service.js';
import { VersioningService } from './versioning.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { StrategySnapshot } from './versioning.js';

/*
 * VersionService.restore() — P0-1 NON-DESTRUCTIVE restore.
 *
 * The pre-P0-1 implementation did `DELETE FROM sp_node WHERE strategy_id = $1`
 * and re-created the node set from the snapshot, which cascaded away the
 * sp_node_artifact back-links of every node the snapshot omitted and left agent
 * runs pointing at dead node ids. These tests pin the replacement contract, and
 * they are written straight off the audit's acceptance criteria:
 *
 *   - restore never deletes a Workspace or Outreach artifact
 *   - historical runs remain readable
 *   - detached artifacts remain discoverable
 *   - activity history records who restored which version and when
 *   - tests include linked artifacts, active runs, approvals, facts and
 *     watcher findings
 *
 * Uses the REAL VersioningService (not a mock) so cutVersion's snapshot-rebuild
 * + coalescible/restoredFromVersionId wiring is genuinely verified, mirroring
 * meri.service.spec.ts's "use the real collaborator, fake only the DB" style.
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
  const artifacts = new Map<string, Rec>();
  const runs = new Map<string, Rec>();
  const changeSets = new Map<string, Rec>();
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
  /** Only the nodes still in the live plan (archivedAt null) — what the API returns. */
  const liveNodesFor = (sid: string) => nodesFor(sid).filter((n) => n.archivedAt == null);
  return {
    strategies,
    nodes,
    versions,
    artifacts,
    runs,
    changeSets,
    activity,
    nextId,
    nodesFor,
    liveNodesFor,
  };
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

/** Seed a CURRENT node on the live strategy (to prove restore ARCHIVES rather
 *  than deletes the nodes a snapshot omits). */
function seedCurrentNode(store: Store, id: string, extra: Partial<Rec> = {}): void {
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
    provenance: null,
    targetRef: null,
    archivedAt: null,
    archivedByUserId: null,
    archivedReason: null,
    meriAuthored: false,
    createdByUserId: U,
    createdAt: new Date('2027-06-01T00:00:00.000Z'),
    ...extra,
  });
}

/** A staged Workspace draft / Outreach record back-link on a node. */
function seedArtifact(
  store: Store,
  id: string,
  nodeId: string,
  artifactType: 'workspace_draft' | 'outreach_record',
): void {
  store.artifacts.set(id, {
    id,
    tenantId: T,
    strategyId: STRATEGY_ID,
    nodeId,
    artifactType,
    artifactRef: `${artifactType}-ref-${id}`,
    detachedAt: null,
    detachedReason: null,
    createdByUserId: U,
    createdAt: new Date('2027-06-02T00:00:00.000Z'),
  });
}

/**
 * An Execution-Agent run for a node. `findings` deliberately carries BOTH a
 * sendApproval token (an APPROVAL) and watcher-style findings, so the
 * "operational history survives" assertion covers approvals and findings too.
 */
function seedRun(store: Store, id: string, nodeId: string, state: string): void {
  store.runs.set(id, {
    id,
    tenantId: T,
    strategyId: STRATEGY_ID,
    missionId: 'M1',
    state,
    trigger: 'manual',
    idempotencyKey: `exec:${nodeId}:outreach`,
    findings: {
      execution: { kind: 'outreach', nodeId, strategyId: STRATEGY_ID, missionId: 'M1' },
      sendApproval: { token: 'abc123', tokenRunId: id, status: 'pending' },
      findings: [{ code: 'OVERDUE', nodeIds: [nodeId] }],
    },
    createdAt: new Date('2027-06-03T00:00:00.000Z'),
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
function snapNode(
  overrides: Partial<StrategySnapshot['nodes'][number]> = {},
): StrategySnapshot['nodes'][number] {
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
    targetRef: null,
    provenance: null,
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

/** `{ in: [...] }` / scalar / undefined predicate matcher for the fake tx. */
function matches(value: unknown, pred: unknown): boolean {
  if (pred === undefined) return true;
  if (pred !== null && typeof pred === 'object' && 'in' in (pred as Record<string, unknown>)) {
    return (((pred as { in: unknown[] }).in ?? []) as unknown[]).includes(value);
  }
  if (pred !== null && typeof pred === 'object' && 'not' in (pred as Record<string, unknown>)) {
    return value !== (pred as { not: unknown }).not;
  }
  return value === pred;
}

function makeTx(store: Store) {
  const now = new Date();
  const spNode = {
    findMany: async ({
      where,
    }: {
      where: { strategyId?: string; id?: unknown; archivedAt?: unknown };
    }) =>
      store
        .nodesFor(where.strategyId ?? STRATEGY_ID)
        .filter((n) => matches(n.id, where.id))
        .filter((n) => matches(n.archivedAt, where.archivedAt))
        .map((n) => ({ ...n })),
    createMany: async ({ data }: { data: Rec[] }) => {
      for (const d of data) store.nodes.set(d.id as string, { archivedAt: null, ...d });
      return { count: data.length };
    },
    update: async ({ where, data }: { where: { id: string }; data: Rec }) => {
      const rec = store.nodes.get(where.id);
      if (!rec) throw new Error(`node ${where.id} not found`);
      const merged = { ...rec, ...data };
      store.nodes.set(where.id, merged);
      return merged;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { strategyId?: string; id?: unknown; archivedAt?: unknown };
      data: Rec;
    }) => {
      let count = 0;
      for (const n of store.nodesFor(where.strategyId ?? STRATEGY_ID)) {
        if (!matches(n.id, where.id)) continue;
        if (!matches(n.archivedAt, where.archivedAt)) continue;
        store.nodes.set(n.id, { ...n, ...data });
        count += 1;
      }
      return { count };
    },
    // Deliberately NOT provided: deleteMany/delete. If a future edit reintroduces
    // a destructive restore, these tests fail loudly instead of silently passing.
  };
  const spNodeArtifact = {
    findMany: async ({
      where,
    }: {
      where: { strategyId?: string; nodeId?: unknown; detachedAt?: unknown };
    }) =>
      [...store.artifacts.values()]
        .filter((a) => matches(a.strategyId, where.strategyId))
        .filter((a) => matches(a.nodeId, where.nodeId))
        .filter((a) => matches(a.detachedAt, where.detachedAt))
        .map((a) => ({ ...a })),
    updateMany: async ({
      where,
      data,
    }: {
      where: { strategyId?: string; nodeId?: unknown; detachedAt?: unknown };
      data: Rec;
    }) => {
      let count = 0;
      for (const a of [...store.artifacts.values()]) {
        if (!matches(a.strategyId, where.strategyId)) continue;
        if (!matches(a.nodeId, where.nodeId)) continue;
        if (!matches(a.detachedAt, where.detachedAt)) continue;
        store.artifacts.set(a.id, { ...a, ...data });
        count += 1;
      }
      return { count };
    },
  };
  const spAgentRun = {
    findMany: async ({ where }: { where: { strategyId?: string; OR?: unknown[] } }) =>
      [...store.runs.values()]
        .filter((r) => matches(r.strategyId, where.strategyId))
        .filter((r) => {
          if (!where.OR) return true;
          return where.OR.some((clause) => {
            const sw = (clause as { idempotencyKey?: { startsWith?: string } }).idempotencyKey
              ?.startsWith;
            return typeof sw === 'string' && String(r.idempotencyKey).startsWith(sw);
          });
        })
        .map((r) => ({ ...r })),
  };
  const spChangeSet = {
    create: async ({ data }: { data: Rec }) => {
      const id = store.nextId('changeset');
      const rec = { ...data, id };
      store.changeSets.set(id, rec);
      return rec;
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
    findMany: async ({ where }: { where: { strategyId?: string } }) =>
      [...store.versions.values()]
        .filter((v) => (where.strategyId ? v.strategyId === where.strategyId : true))
        .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
        .map((v) => ({ ...v })),
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
    updateMany: async ({ where, data }: { where: { id: string }; data: Rec }) => {
      const rec = store.versions.get(where.id);
      if (!rec) return { count: 0 };
      store.versions.set(where.id, { ...rec, ...data });
      return { count: 1 };
    },
  };
  /**
   * Honour the include filters the real Prisma applies, so `nodes`/`artifacts` on
   * the returned detail reflect the LIVE plan (P0-1) exactly as production does.
   */
  const attach = (
    rec: Rec,
    include?: {
      nodes?: { where?: { archivedAt?: unknown } } | boolean;
      artifacts?: { where?: { detachedAt?: unknown } } | boolean;
    },
  ) => {
    const out: Rec = { ...rec };
    if (include?.nodes) {
      const w = typeof include.nodes === 'object' ? include.nodes.where : undefined;
      out.nodes = store.nodesFor(rec.id).filter((n) => matches(n.archivedAt, w?.archivedAt));
    }
    if (include?.artifacts) {
      const w = typeof include.artifacts === 'object' ? include.artifacts.where : undefined;
      out.artifacts = [...store.artifacts.values()]
        .filter((a) => a.strategyId === rec.id)
        .filter((a) => matches(a.detachedAt, w?.detachedAt));
    }
    return out;
  };
  const spStrategy = {
    findFirst: async ({
      where,
      include,
    }: {
      where: { id: string };
      include?: Parameters<typeof attach>[1];
    }) => {
      const rec = store.strategies.get(where.id);
      return rec ? attach(rec, include) : null;
    },
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
      include?: Parameters<typeof attach>[1];
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
  return {
    spNode,
    spNodeArtifact,
    spAgentRun,
    spChangeSet,
    spVersion,
    spStrategy,
    spActivityLog,
    spEventOutbox,
  } as unknown as Parameters<Parameters<PrismaService['withTenantUser']>[2]>[0];
}

function makeService(store: Store): VersionService {
  const prisma = {
    withTenantUser: async (_t: string, _u: string, fn: (tx: unknown) => unknown) =>
      fn(makeTx(store)),
    withTenant: async (_t: string, fn: (tx: unknown) => unknown) => fn(makeTx(store)),
  } as unknown as PrismaService;
  return new VersionService(prisma, new VersioningService());
}

/** The single change-set row a restore records (there is exactly one per restore). */
function onlyChangeSet(store: Store): Rec {
  const rows = [...store.changeSets.values()];
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe('VersionService.restore', () => {
  it('throws NotFoundException for an unknown version and mutates nothing', async () => {
    const store = makeStore();
    seedStrategy(store);
    const svc = makeService(store);
    await expect(svc.restore(T, U, STRATEGY_ID, 'no-such-version')).rejects.toThrow(
      NotFoundException,
    );
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

  // ---- P0-1: the destructive behaviour this replaced ------------------------

  it('ARCHIVES (never deletes) a node added after the restored version, and drops it from the live plan', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedCurrentNode(store, 'n-newer');
    seedVersion(store, 'v1', baseSnapshot([snapNode({ id: 'n-old' })]));
    const svc = makeService(store);

    const detail = await svc.restore(T, U, STRATEGY_ID, 'v1');

    // The row SURVIVES — this is the whole point of P0-1.
    const archived = store.nodes.get('n-newer');
    expect(archived).toBeDefined();
    expect(archived!.archivedAt).toBeInstanceOf(Date);
    expect(archived!.archivedByUserId).toBe(U);
    expect(String(archived!.archivedReason)).toMatch(/^Archived by restore of the /);
    // ...but it is no longer part of the live plan the editor renders.
    expect(store.liveNodesFor(STRATEGY_ID).map((n) => n.id)).toEqual(['n-old']);
    expect((detail.nodes as Rec[]).map((n) => n.id)).toEqual(['n-old']);
  });

  it('handles an empty-node snapshot: every live node is archived, none deleted', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedCurrentNode(store, 'n-newer');
    seedVersion(store, 'v1', baseSnapshot([]));
    const svc = makeService(store);

    await svc.restore(T, U, STRATEGY_ID, 'v1');

    expect(store.liveNodesFor(STRATEGY_ID)).toHaveLength(0);
    expect(store.nodes.size).toBe(1); // still physically there
    expect(store.nodes.get('n-newer')!.archivedAt).toBeInstanceOf(Date);
  });

  it('NEVER deletes a Workspace or Outreach artifact — the links go detached instead', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedCurrentNode(store, 'n-staged');
    seedArtifact(store, 'a-ws', 'n-staged', 'workspace_draft');
    seedArtifact(store, 'a-or', 'n-staged', 'outreach_record');
    seedVersion(store, 'v1', baseSnapshot([snapNode({ id: 'n-old' })]));
    const svc = makeService(store);

    const detail = await svc.restore(T, U, STRATEGY_ID, 'v1');

    // Both artifact rows survive, marked historical rather than dropped.
    expect(store.artifacts.size).toBe(2);
    for (const id of ['a-ws', 'a-or']) {
      const a = store.artifacts.get(id)!;
      expect(a.detachedAt).toBeInstanceOf(Date);
      expect(String(a.detachedReason)).toMatch(/^Archived by restore of the /);
    }
    // The live editor payload no longer carries them.
    expect(detail.artifacts as Rec[]).toHaveLength(0);
  });

  it('leaves operational history readable: run rows (including their approval + findings) are untouched', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedCurrentNode(store, 'n-staged');
    seedRun(store, 'r-active', 'n-staged', 'waiting_for_input');
    seedRun(store, 'r-done', 'n-staged', 'completed');
    const before = JSON.stringify([...store.runs.values()]);
    seedVersion(store, 'v1', baseSnapshot([snapNode({ id: 'n-old' })]));
    const svc = makeService(store);

    await svc.restore(T, U, STRATEGY_ID, 'v1');

    // Approvals (findings.sendApproval) and watcher findings ride on the run row,
    // so "runs are byte-identical" is what makes them survive too.
    expect(JSON.stringify([...store.runs.values()])).toBe(before);
  });

  it('detached artifacts remain discoverable through listDetached', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedCurrentNode(store, 'n-staged');
    seedArtifact(store, 'a-ws', 'n-staged', 'workspace_draft');
    seedVersion(store, 'v1', baseSnapshot([snapNode({ id: 'n-old' })]));
    const svc = makeService(store);

    await svc.restore(T, U, STRATEGY_ID, 'v1');
    const detached = await svc.listDetached(T, STRATEGY_ID);

    expect(detached.nodes.map((n) => n.id)).toEqual(['n-staged']);
    expect(detached.artifacts.map((a) => a.id)).toEqual(['a-ws']);
  });

  it('REVIVES an archived node (and re-attaches its artifacts) when a later restore contains it', async () => {
    const store = makeStore();
    seedStrategy(store);
    // The node is already archived by an earlier restore, its artifact detached.
    seedCurrentNode(store, 'n-back', {
      archivedAt: new Date('2027-07-01T00:00:00.000Z'),
      archivedByUserId: 'someone-else',
      archivedReason: 'Archived by restore of the earlier version',
    });
    store.artifacts.set('a-back', {
      id: 'a-back',
      tenantId: T,
      strategyId: STRATEGY_ID,
      nodeId: 'n-back',
      artifactType: 'workspace_draft',
      artifactRef: 'ws-1',
      detachedAt: new Date('2027-07-01T00:00:00.000Z'),
      detachedReason: 'Archived by restore of the earlier version',
      createdByUserId: U,
      createdAt: new Date('2027-06-02T00:00:00.000Z'),
    });
    seedVersion(store, 'v-has-it', baseSnapshot([snapNode({ id: 'n-back' })]));
    const svc = makeService(store);

    await svc.restore(T, U, STRATEGY_ID, 'v-has-it');

    const revived = store.nodes.get('n-back')!;
    expect(revived.archivedAt).toBeNull();
    expect(revived.archivedByUserId).toBeNull();
    expect(revived.archivedReason).toBeNull();
    expect(store.artifacts.get('a-back')!.detachedAt).toBeNull();
    expect(store.liveNodesFor(STRATEGY_ID).map((n) => n.id)).toEqual(['n-back']);
  });

  // ---- provenance ----------------------------------------------------------

  it('does NOT erase provenance added after a snapshot that predates provenance capture', async () => {
    const store = makeStore();
    seedStrategy(store);
    const live = { sources: ['fact:f1'] };
    seedCurrentNode(store, 'n-same', {
      title: 'Snapshot node',
      startsOn: new Date('2027-03-01T00:00:00.000Z'),
      status: 'active',
      provenance: live,
    });
    // A pre-P0-1 snapshot: the provenance KEY is absent (not null).
    const legacy = snapNode({ id: 'n-same' });
    delete (legacy as Partial<typeof legacy>).provenance;
    seedVersion(store, 'v-legacy', baseSnapshot([legacy]));
    const svc = makeService(store);

    await svc.restore(T, U, STRATEGY_ID, 'v-legacy');

    expect(store.nodes.get('n-same')!.provenance).toEqual(live);
  });

  it('restores provenance from a snapshot that carries it, even when no other field changed', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedCurrentNode(store, 'n-same', {
      title: 'Snapshot node',
      startsOn: new Date('2027-03-01T00:00:00.000Z'),
      status: 'active',
      provenance: { sources: ['fact:drifted'] },
    });
    seedVersion(
      store,
      'v-prov',
      baseSnapshot([snapNode({ id: 'n-same', provenance: { sources: ['fact:original'] } })]),
    );
    const svc = makeService(store);

    await svc.restore(T, U, STRATEGY_ID, 'v-prov');

    expect(store.nodes.get('n-same')!.provenance).toEqual({ sources: ['fact:original'] });
  });

  // ---- history / audit -----------------------------------------------------

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

  it('logs a version.restored activity row with who/what/when and proof nothing was deleted', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedCurrentNode(store, 'n-newer');
    seedVersion(store, 'v-target', baseSnapshot([snapNode()]));
    const svc = makeService(store);

    await svc.restore(T, U, STRATEGY_ID, 'v-target');

    expect(store.activity).toHaveLength(1);
    const row = store.activity[0]!;
    expect(row.action).toBe('version.restored');
    expect(row.actorUserId).toBe(U);
    expect((row.before as Record<string, unknown>).restoredFromVersionId).toBe('v-target');
    const after = row.after as Record<string, unknown>;
    expect(after.archived).toBe(1);
    expect(after.created).toBe(1);
    expect(after.nodesDeleted).toBe(0);
    expect(after.artifactsDeleted).toBe(0);
  });

  it('records the restore as an APPLIED change-set pinned to the pre-restore head', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedVersion(store, 'v-old', baseSnapshot([snapNode({ id: 'n-old' })]), {
      createdAt: new Date('2027-02-01T10:00:00.000Z'),
    });
    seedVersion(store, 'v-head', baseSnapshot([snapNode({ id: 'n-head' })]), {
      createdAt: new Date('2027-05-01T10:00:00.000Z'),
    });
    const svc = makeService(store);

    await svc.restore(T, U, STRATEGY_ID, 'v-old');

    const cs = onlyChangeSet(store);
    expect(cs.status).toBe('applied');
    expect(cs.risk).toBe('high');
    // Pins the head BEFORE the restore, which is what makes Undo restore the
    // pre-restore plan; appliedVersionId is the version this restore cut, which
    // is what satisfies ChangeSetsService.undo's head guard.
    expect(cs.strategyVersionId).toBe('v-head');
    const cut = [...store.versions.values()].find((v) => v.restoredFromVersionId === 'v-old');
    expect(cs.appliedVersionId).toBe(cut!.id);
    expect(cs.appliedByUserId).toBe(U);
    expect((cs.ops as Array<Record<string, unknown>>)[0]!.op).toBe('restore_version');
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

describe('VersionService.restoreImpact', () => {
  it('throws NotFoundException for an unknown version', async () => {
    const store = makeStore();
    seedStrategy(store);
    const svc = makeService(store);
    await expect(svc.restoreImpact(T, STRATEGY_ID, 'nope')).rejects.toThrow(NotFoundException);
  });

  it('reports nodes, affected artifacts, active runs and provenance — and writes nothing', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedCurrentNode(store, 'n-going', { provenance: { sources: ['fact:f1'] } });
    seedArtifact(store, 'a-ws', 'n-going', 'workspace_draft');
    seedArtifact(store, 'a-or', 'n-going', 'outreach_record');
    seedRun(store, 'r-active', 'n-going', 'waiting_for_input');
    seedRun(store, 'r-done', 'n-going', 'completed');
    seedVersion(store, 'v1', baseSnapshot([snapNode({ id: 'n-coming' })]));
    const svc = makeService(store);

    const impact = await svc.restoreImpact(T, STRATEGY_ID, 'v1');

    expect(impact.nodes.removed.map((n) => n.id)).toEqual(['n-going']);
    expect(impact.nodes.added.map((n) => n.id)).toEqual(['n-coming']);
    expect(impact.nodes.changed).toEqual([]);
    expect(impact.artifacts.workspaceDraftsAffected).toBe(1);
    expect(impact.artifacts.outreachRecordsAffected).toBe(1);
    expect(impact.artifacts.deleted).toBe(0);
    expect(impact.artifacts.detaching).toHaveLength(2);
    expect(impact.runs.activeCount).toBe(1);
    expect(impact.runs.historicalCount).toBe(1);
    expect(impact.runs.active[0]!.nodeId).toBe('n-going');
    expect(impact.provenance.nodesArchivedWithProvenance).toBe(1);
    expect(impact.noOp).toBe(false);

    // Read-only: nothing archived, nothing detached, no version/change-set cut.
    expect(store.nodes.get('n-going')!.archivedAt).toBeNull();
    expect(store.artifacts.get('a-ws')!.detachedAt).toBeNull();
    expect(store.versions.size).toBe(1);
    expect(store.changeSets.size).toBe(0);
  });

  it('flags a restore that would change nothing as noOp', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedCurrentNode(store, 'n-same', {
      title: 'Snapshot node',
      startsOn: new Date('2027-03-01T00:00:00.000Z'),
      status: 'active',
    });
    seedVersion(store, 'v1', baseSnapshot([snapNode({ id: 'n-same' })]));
    const svc = makeService(store);

    const impact = await svc.restoreImpact(T, STRATEGY_ID, 'v1');

    expect(impact.noOp).toBe(true);
    expect(impact.nodes.unchangedCount).toBe(1);
  });

  it('separates a REVIVED node from an ADDED one', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedCurrentNode(store, 'n-archived', {
      archivedAt: new Date('2027-07-01T00:00:00.000Z'),
    });
    seedVersion(
      store,
      'v1',
      baseSnapshot([snapNode({ id: 'n-archived' }), snapNode({ id: 'n-never-existed' })]),
    );
    const svc = makeService(store);

    const impact = await svc.restoreImpact(T, STRATEGY_ID, 'v1');

    expect(impact.nodes.revived.map((n) => n.id)).toEqual(['n-archived']);
    expect(impact.nodes.added.map((n) => n.id)).toEqual(['n-never-existed']);
    // An already-archived node is never re-archived.
    expect(impact.nodes.removed).toEqual([]);
  });
});
