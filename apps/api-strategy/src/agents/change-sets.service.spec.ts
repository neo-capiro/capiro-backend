import { describe, expect, it, jest } from '@jest/globals';
import {
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ChangeSetsService } from './change-sets.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import type { VersionService } from '../strategy/version.service.js';
import type { MeriService } from '../meri/meri.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma-client/index.js';
import type { ApproveChangeSetDto, CreateChangeSetDto } from './dto/agents.dto.js';

/*
 * ChangeSetsService lifecycle tests: in-memory fake tx (meri.service.spec.ts
 * makeStore/makeTx pattern) + a STUBBED MeriService.applyEditSet and a STUBBED
 * VersionService.restore, but the REAL VersioningService — so apply's
 * cutVersion genuinely rebuilds a snapshot from the fake store and creates a
 * real sp_version row we can assert on, and every mutation's activity + outbox
 * writes hit the fake tx exactly as in prod. withTenantUser/withTenant
 * snapshot+restore the store on throw (modelling $transaction rollback), which
 * also proves the stale-marking write SURVIVES the post-commit 409.
 */

interface Rec {
  [k: string]: unknown;
  id: string;
}

const T = 'tenant-1';
const U = 'user-1';
const SID = 'S1';

const opA = { op: 'update', nodeId: 'N1', title: 'Node one (tightened)' };
const opB = { op: 'remove', nodeId: 'N2' };

function makeStore() {
  const strategies = new Map<string, Rec>();
  const nodes = new Map<string, Rec>();
  const versions = new Map<string, Rec>();
  const runs = new Map<string, Rec>();
  const changeSets = new Map<string, Rec>();
  const activity: Rec[] = [];
  const outbox: Rec[] = [];
  let seq = 0;
  const nextId = (p: string) => `${p}-${++seq}`;
  const nodesFor = (sid: string) => [...nodes.values()].filter((n) => n.strategyId === sid);
  // apply()'s FOR UPDATE row locks: key -> release promise of the HOLDING tx.
  // Shared across concurrent fake txs; a waiter parks until the holder settles.
  const locks = new Map<string, Promise<void>>();
  return { strategies, nodes, versions, runs, changeSets, activity, outbox, nextId, nodesFor, locks };
}
type Store = ReturnType<typeof makeStore>;

/** Full field set: the REAL VersioningService.cutVersion snapshots this row. */
function seedStrategy(store: Store): void {
  store.strategies.set(SID, {
    id: SID,
    tenantId: T,
    clientId: 'C1',
    title: 'Existing plan',
    type: 'appropriations',
    goal: 'Win the plus-up',
    meriContext: null,
    meriSummary: null,
    targetDate: null,
    ownerUserId: U,
    createdByUserId: U,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastEditedByUserId: null,
    lastEditedAt: null,
  });
}

/** A run this tenant owns (provenance target for change-set runId). */
function seedRun(store: Store, id: string): void {
  store.runs.set(id, { id, tenantId: T, missionId: 'M1', strategyId: SID, state: 'executing' });
}

function seedVersion(store: Store, id: string, createdAt: Date, coalescible = false): void {
  store.versions.set(id, {
    id,
    tenantId: T,
    strategyId: SID,
    snapshot: { meta: {}, nodes: [] },
    authorKind: 'person',
    authorUserId: U,
    note: 'seed',
    restoredFromVersionId: null,
    coalescible,
    createdAt,
  });
}

function makeTx(store: Store, heldLocks: Array<() => void> = []) {
  const now = new Date();
  const attach = (rec: Rec, include?: { nodes?: unknown; artifacts?: unknown }) => {
    const out: Rec = { ...rec };
    if (include?.nodes) out.nodes = store.nodesFor(rec.id);
    if (include?.artifacts) out.artifacts = [];
    return out;
  };
  const spStrategy = {
    findFirst: async ({ where }: { where: { id: string } }) =>
      store.strategies.get(where.id) ?? null,
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
    update: async ({ where, data }: { where: { id: string }; data: Rec }) => {
      const rec = store.strategies.get(where.id);
      if (!rec) throw new Error('strategy not found');
      const merged = { ...rec, ...data, updatedAt: now };
      store.strategies.set(where.id, merged);
      return merged;
    },
  };
  // Not queried directly by ChangeSetsService (applyEditSet is stubbed), but the
  // include-nodes path above reads the node store; keep a minimal model anyway.
  const spNode = {
    findMany: async ({ where }: { where: { strategyId: string } }) =>
      store.nodesFor(where.strategyId),
  };
  const spVersion = {
    // headOf's total order: createdAt desc, id desc.
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
    create: async ({ data }: { data: Rec }) => {
      const id = store.nextId('version');
      const rec = { ...data, id };
      store.versions.set(id, rec);
      return rec;
    },
    // create()'s head seal: flip coalescible off on the pinned head.
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
  const spChangeSet = {
    create: async ({ data }: { data: Rec }) => {
      const id = store.nextId('cs');
      const rec: Rec = {
        // Schema defaults apply relies on (`cs.approvedOps ?? cs.ops`):
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
    findMany: async ({ where }: { where: { strategyId?: string; status?: string } }) =>
      [...store.changeSets.values()].filter(
        (c) =>
          (!where.strategyId || c.strategyId === where.strategyId) &&
          (!where.status || c.status === where.status),
      ),
    update: async ({ where, data }: { where: { id: string }; data: Rec }) => {
      const rec = store.changeSets.get(where.id);
      if (!rec) throw new Error('change-set not found');
      const merged = { ...rec, ...data, updatedAt: now };
      store.changeSets.set(where.id, merged);
      return merged;
    },
  };
  // Tenant-scoped in prod (query hook injects tenantId); the fake store only
  // holds tenant-1 rows, so a miss models both "nonexistent" and "other tenant".
  const spAgentRun = {
    findFirst: async ({ where }: { where: { id: string } }) => store.runs.get(where.id) ?? null,
  };
  // apply()'s two raw SELECT ... FOR UPDATE ordering locks, modelled as per-row
  // mutexes held until the owning tx settles (commit OR rollback) — the exact
  // property the concurrent-apply fix relies on: a second tx touching the same
  // row parks here until the first releases, then re-reads COMMITTED state.
  const acquireRowLock = async (key: string) => {
    while (store.locks.has(key)) await store.locks.get(key);
    let release!: () => void;
    store.locks.set(key, new Promise<void>((r) => (release = r)));
    heldLocks.push(() => {
      store.locks.delete(key);
      release();
    });
  };
  const $queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (/FROM sp_change_set/.test(sql)) {
      const [csId, tenantId] = values as [string, string];
      const rec = store.changeSets.get(csId);
      if (!rec || rec.tenantId !== tenantId) return []; // zero rows -> nothing locked
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
    throw new Error(`fake tx got an unmodelled raw query: ${sql}`);
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
    spStrategy,
    spNode,
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
    strategies: new Map(store.strategies),
    nodes: new Map(store.nodes),
    versions: new Map(store.versions),
    runs: new Map(store.runs),
    changeSets: new Map(store.changeSets),
    activity: [...store.activity],
    outbox: [...store.outbox],
  });
  const restore = (snap: ReturnType<typeof snapshot>) => {
    store.strategies = snap.strategies;
    store.nodes = snap.nodes;
    store.versions = snap.versions;
    store.runs = snap.runs;
    store.changeSets = snap.changeSets;
    store.activity = snap.activity;
    store.outbox = snap.outbox;
  };
  const inTx = async (fn: (tx: unknown) => Promise<unknown>) => {
    const snap = snapshot();
    const heldLocks: Array<() => void> = [];
    try {
      return await fn(makeTx(store, heldLocks));
    } catch (e) {
      restore(snap);
      throw e;
    } finally {
      // Row locks release at tx settle — commit or rollback — like Postgres.
      for (const release of heldLocks) release();
    }
  };
  const withTenantUser = jest.fn(
    async (_t: string, _u: string, fn: (tx: unknown) => Promise<unknown>) => inTx(fn),
  );
  const withTenant = jest.fn(async (_t: string, fn: (tx: unknown) => Promise<unknown>) => inTx(fn));
  const prisma = { withTenantUser, withTenant } as unknown as PrismaService;

  const applyEditSet = jest.fn(async (..._args: unknown[]) => undefined);
  // A6 parity plumbing: grounding is pre-fetched OUTSIDE the apply tx and fed
  // to verifyAppliedPlan. The stub honours the real contract — it loads the
  // detail through the CALLER's tx and returns it — so apply's return path and
  // the 422-rollback path are exercised (the verifier's own logic is covered by
  // MeriService.verifyAppliedPlan unit tests).
  const groundingValue = { fiscal: {}, firmPhases: [], reference: {} };
  const grounding = jest.fn(async (_t: string) => groundingValue);
  const verifyAppliedPlan = jest.fn(
    async (tx: unknown, _tenant: string, _user: string, strategyId: string) => ({
      detail: await (
        tx as { spStrategy: { findFirstOrThrow: (args: unknown) => Promise<Rec> } }
      ).spStrategy.findFirstOrThrow({
        where: { id: strategyId },
        include: { nodes: true, artifacts: true },
      }),
      violations: [] as unknown[],
    }),
  );
  const meri = { applyEditSet, grounding, verifyAppliedPlan } as unknown as MeriService;
  const restoreSpy = jest.fn(async (..._args: unknown[]) => ({ id: SID, title: 'restored' }));
  const versions = { restore: restoreSpy } as unknown as VersionService;

  const svc = new ChangeSetsService(prisma, new VersioningService(), versions, meri);
  return {
    svc,
    applyEditSet,
    restoreSpy,
    withTenant,
    withTenantUser,
    grounding,
    verifyAppliedPlan,
    groundingValue,
  };
}

function createDto(ops: unknown[] = [opA, opB]): CreateChangeSetDto {
  return { strategyId: SID, summary: 'Tighten the plan', ops, risk: 'low' } as CreateChangeSetDto;
}

describe('ChangeSetsService.create', () => {
  it('pins the LATEST version id as strategyVersionId', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedVersion(store, 'v-old', new Date('2026-01-01T00:00:00.000Z'));
    seedVersion(store, 'v-new', new Date('2026-02-01T00:00:00.000Z'));
    const { svc } = makeService(store);

    const cs = (await svc.create(T, U, createDto())) as Rec;

    expect(cs.strategyVersionId).toBe('v-new'); // not v-old
    expect(cs.status).toBe('proposed');
    expect(store.activity[store.activity.length - 1]!.action).toBe('changeset.proposed');
    expect(store.outbox[store.outbox.length - 1]!.type).toBe('changeset.proposed');
  });

  it('SEALS a coalescible pinned head (coalescible -> false) so later autosaves cannot rewrite it in place', async () => {
    const store = makeStore();
    seedStrategy(store);
    // Head is a person field-edit batch still inside the coalesce window —
    // without the seal the author's next autosave would fold INTO this row.
    seedVersion(store, 'v1', new Date(), /* coalescible */ true);
    const { svc } = makeService(store);

    const cs = (await svc.create(T, U, createDto())) as Rec;

    expect(cs.strategyVersionId).toBe('v1');
    expect(store.versions.get('v1')!.coalescible).toBe(false); // sealed
    const proposed = store.activity.find((a) => a.action === 'changeset.proposed')!;
    expect((proposed.after as Rec).pinnedHeadSealed).toBe(true);
  });

  it('rejects a dto.runId the tenant does not own (no spAgentRun row) and persists nothing', async () => {
    // SpChangeSet.runId has no FK — without the in-tx tenant-scoped check a
    // random / cross-tenant UUID (it passes @IsUUID) would commit as false
    // provenance and downstream run-keyed reads would silently miss it.
    const store = makeStore();
    seedStrategy(store);
    seedVersion(store, 'v1', new Date('2026-01-01T00:00:00.000Z'));
    const { svc } = makeService(store);

    const err = await svc
      .create(T, U, { ...createDto(), runId: 'not-this-tenants-run' } as CreateChangeSetDto)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(/Unknown run/);
    expect(store.changeSets.size).toBe(0);
    expect(store.activity).toHaveLength(0);
    expect(store.outbox).toHaveLength(0);
  });

  it('accepts an in-tenant runId and stores the provenance link', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedVersion(store, 'v1', new Date('2026-01-01T00:00:00.000Z'));
    seedRun(store, 'R1');
    const { svc } = makeService(store);

    const cs = (await svc.create(T, U, {
      ...createDto(),
      runId: 'R1',
    } as CreateChangeSetDto)) as Rec;

    expect(cs.runId).toBe('R1');
    expect(cs.status).toBe('proposed');
  });
});

describe('ChangeSetsService.list', () => {
  it('BadRequests an invalid ?status= WITHOUT opening a tenant tx (no Prisma 500)', async () => {
    const store = makeStore();
    const { svc, withTenant } = makeService(store);

    const err = await svc.list(T, { status: 'bogus' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(/Invalid status 'bogus'/);
    expect((err as Error).message).toMatch(/proposed/); // lists the valid values
    expect(withTenant).not.toHaveBeenCalled();
  });

  it('a valid status filters rows', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedVersion(store, 'v1', new Date('2026-01-01T00:00:00.000Z'));
    const { svc } = makeService(store);
    const a = (await svc.create(T, U, createDto())) as Rec;
    const b = (await svc.create(T, U, createDto())) as Rec;
    await svc.approve(T, U, b.id, {} as ApproveChangeSetDto);

    const proposed = (await svc.list(T, { status: 'proposed' })) as Rec[];

    expect(proposed.map((r) => r.id)).toEqual([a.id]);
  });
});

describe('ChangeSetsService.approve', () => {
  it('opIndexes [1] stores approvedOps as exactly that subset', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedVersion(store, 'v1', new Date('2026-01-01T00:00:00.000Z'));
    const { svc } = makeService(store);
    const cs = (await svc.create(T, U, createDto([opA, opB]))) as Rec;

    const approved = await svc.approve(T, U, cs.id, { opIndexes: [1] } as ApproveChangeSetDto);

    expect(approved.approvedOps).toEqual([opB]);
    expect(approved.status).toBe('approved');
    expect(approved.approvedByUserId).toBe(U);
  });

  it('an EMPTY opIndexes subset BadRequests and leaves the change-set proposed (no zero-op approval)', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedVersion(store, 'v1', new Date('2026-01-01T00:00:00.000Z'));
    const { svc } = makeService(store);
    const cs = (await svc.create(T, U, createDto([opA, opB]))) as Rec;

    const err = await svc
      .approve(T, U, cs.id, { opIndexes: [] } as ApproveChangeSetDto)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(/at least one op/);
    // Rolled back: still proposed, no approvedOps=[] stored, no approval logged.
    expect(store.changeSets.get(cs.id)!.status).toBe('proposed');
    expect(store.changeSets.get(cs.id)!.approvedOps).toBeNull();
    expect(store.activity.some((a) => a.action === 'changeset.approved')).toBe(false);
  });

  it('an out-of-bounds opIndex BadRequests and leaves the change-set proposed', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedVersion(store, 'v1', new Date('2026-01-01T00:00:00.000Z'));
    const { svc } = makeService(store);
    const cs = (await svc.create(T, U, createDto([opA, opB]))) as Rec;

    const err = await svc
      .approve(T, U, cs.id, { opIndexes: [2] } as ApproveChangeSetDto)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(/out-of-range index: 2/);
    expect(store.changeSets.get(cs.id)!.status).toBe('proposed');
    expect(store.changeSets.get(cs.id)!.approvedOps).toBeNull();
  });
});

describe('ChangeSetsService.apply', () => {
  it('Conflicts on a non-approved (proposed) change-set without touching the pipeline', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedVersion(store, 'v1', new Date('2026-01-01T00:00:00.000Z'));
    const { svc, applyEditSet } = makeService(store);
    const cs = (await svc.create(T, U, createDto())) as Rec;

    const err = await svc.apply(T, U, cs.id).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/approve it before applying/);
    expect(applyEditSet).not.toHaveBeenCalled();
    expect(store.changeSets.get(cs.id)!.status).toBe('proposed');
  });

  it('marks the row stale AND Conflicts AND skips applyEditSet when the head moved since the proposal', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedVersion(store, 'v1', new Date('2026-01-01T00:00:00.000Z'));
    const { svc, applyEditSet } = makeService(store);
    const cs = (await svc.create(T, U, createDto())) as Rec; // pins v1
    await svc.approve(T, U, cs.id, {} as ApproveChangeSetDto);
    // Someone edits the plan after the proposal: a newer version becomes head.
    seedVersion(store, 'v2', new Date('2026-03-01T00:00:00.000Z'));

    const err = await svc.apply(T, U, cs.id).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/regenerate/);
    // The stale write happened INSIDE the committed tx — it survives the 409.
    expect(store.changeSets.get(cs.id)!.status).toBe('stale');
    expect(store.activity.some((a) => a.action === 'changeset.stale')).toBe(true);
    expect(applyEditSet).not.toHaveBeenCalled();
  });

  it('409s stale when the SAME author autosaves after pinning a coalescible head (seal forces a fresh version instead of an in-place fold)', async () => {
    // The confirmed Stage C bug: cutVersion COALESCES same-author field edits
    // within 5 minutes into the latest version row IN PLACE (same id, snapshot
    // overwritten), so before the seal the plan could materially change after
    // the pin with head.id never moving — apply would replay ops computed
    // against the OLD content straight over the user's fresh edits, no 409.
    const store = makeStore();
    seedStrategy(store);
    seedVersion(store, 'v1', new Date(), /* coalescible */ true); // fresh autosave head
    const { svc, applyEditSet } = makeService(store);
    const cs = (await svc.create(T, U, createDto())) as Rec; // pins v1 AND seals it
    await svc.approve(T, U, cs.id, {} as ApproveChangeSetDto);

    // The same user keeps editing inside the coalesce window — run the REAL
    // versioning fold path exactly as NodeService.update does (coalesce:true).
    const autosaveVersionId = await new VersioningService().cutVersion(makeTx(store), {
      tenantId: T,
      strategyId: SID,
      authorKind: 'person',
      authorUserId: U,
      note: 'Updated step',
      coalesce: true,
    });
    // The seal made v1 non-coalescible: the autosave cut a FRESH head...
    expect(autosaveVersionId).not.toBe('v1');
    expect(store.versions.get('v1')!.note).toBe('seed'); // pinned snapshot untouched

    const err = await svc.apply(T, U, cs.id).catch((e: unknown) => e);

    // ...so the head-id staleness check fires instead of clobbering the edits.
    expect(err).toBeInstanceOf(ConflictException);
    expect(store.changeSets.get(cs.id)!.status).toBe('stale');
    expect(applyEditSet).not.toHaveBeenCalled();
  });

  it('replays the approvedOps subset through applyEditSet, cuts exactly ONE meri version and stamps applied/appliedVersionId', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedVersion(store, 'v1', new Date('2026-01-01T00:00:00.000Z'));
    const { svc, applyEditSet } = makeService(store);
    const cs = (await svc.create(T, U, createDto([opA, opB]))) as Rec;
    await svc.approve(T, U, cs.id, { opIndexes: [1] } as ApproveChangeSetDto);
    const versionsBefore = store.versions.size;

    const detail = (await svc.apply(T, U, cs.id)) as Rec;

    // The Meri assistant pipeline got the APPROVED SUBSET, not all ops.
    expect(applyEditSet).toHaveBeenCalledTimes(1);
    expect(applyEditSet).toHaveBeenCalledWith(expect.anything(), T, SID, U, [opB]);

    // Exactly one new version, authored by meri (asserted via the store).
    expect(store.versions.size).toBe(versionsBefore + 1);
    const cut = [...store.versions.values()].find((v) => v.id !== 'v1')!;
    expect(cut.authorKind).toBe('meri');
    expect(String(cut.note)).toMatch(/^Applied change-set:/);

    const row = store.changeSets.get(cs.id)!;
    expect(row.status).toBe('applied');
    expect(row.appliedVersionId).toBe(cut.id);
    expect(row.appliedByUserId).toBe(U);
    expect(store.strategies.get(SID)!.lastEditedByUserId).toBe(U);
    expect(detail.id).toBe(SID); // returns the post-apply strategy detail
    expect(store.activity.some((a) => a.action === 'changeset.applied')).toBe(true);
  });

  it('runs the assistant A6 plan verifier on apply, with grounding pre-fetched OUTSIDE the tx', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedVersion(store, 'v1', new Date('2026-01-01T00:00:00.000Z'));
    const { svc, grounding, verifyAppliedPlan, groundingValue, withTenantUser } =
      makeService(store);
    const cs = (await svc.create(T, U, createDto())) as Rec;
    await svc.approve(T, U, cs.id, {} as ApproveChangeSetDto);

    await svc.apply(T, U, cs.id);

    // Grounding resolves BEFORE the apply tx opens (its reads run their own
    // withTenant txs — nesting inside a held tx stacks pool connections)...
    expect(grounding).toHaveBeenCalledTimes(1);
    expect(grounding).toHaveBeenCalledWith(T);
    const applyTxOrder =
      withTenantUser.mock.invocationCallOrder[withTenantUser.mock.calls.length - 1]!;
    expect(grounding.mock.invocationCallOrder[0]!).toBeLessThan(applyTxOrder);
    // ...and the verifier runs INSIDE the apply tx against the persisted plan,
    // exactly as the assistant path does (verify + gate + plan.verified row).
    expect(verifyAppliedPlan).toHaveBeenCalledTimes(1);
    expect(verifyAppliedPlan).toHaveBeenCalledWith(expect.anything(), T, U, SID, groundingValue);
  });

  it('rolls back the ENTIRE apply when the A6 verify gate blocks (STRATEGY_VERIFY_BLOCK 422): status, version, lastEdited, audit', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedVersion(store, 'v1', new Date('2026-01-01T00:00:00.000Z'));
    const { svc, verifyAppliedPlan } = makeService(store);
    const cs = (await svc.create(T, U, createDto())) as Rec;
    await svc.approve(T, U, cs.id, {} as ApproveChangeSetDto);
    const versionsBefore = store.versions.size;
    const activityBefore = store.activity.length;
    // The verifier finds hard errors with the block flag on — the real
    // MeriService.verifyAppliedPlan throws the 422 (that logic is covered by
    // its own unit tests; here we prove the gate unwinds the apply tx, which
    // the assistant path gets for free and agent applies were missing).
    verifyAppliedPlan.mockRejectedValueOnce(
      new UnprocessableEntityException('This change would break the plan — dependency order'),
    );

    const err = await svc.apply(T, U, cs.id).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as Error).message).toMatch(/would break the plan/);
    // FULL rollback, matching the assistant path: still approved (re-appliable
    // once the conflict is resolved), no version cut, no applied stamp, no
    // lastEdited bump and no applied/verified audit rows.
    const row = store.changeSets.get(cs.id)!;
    expect(row.status).toBe('approved');
    expect(row.appliedVersionId).toBeNull();
    expect(store.versions.size).toBe(versionsBefore);
    expect(store.strategies.get(SID)!.lastEditedByUserId).toBeNull();
    expect(store.activity.length).toBe(activityBefore);
    expect(store.activity.some((a) => a.action === 'changeset.applied')).toBe(false);
  });

  it('serializes a CONCURRENT second apply of the SAME change-set on the row lock: ops replay ONCE, loser 409s on the committed status', async () => {
    // Pre-lock bug: both txs read status='approved' before either committed
    // (plain READ COMMITTED reads; the first row lock only came at the late
    // spStrategy.update) and BOTH replayed the ops — duplicate nodes, two
    // version cuts, the second 'applied' stamp overwriting the first. The
    // sp_change_set FOR UPDATE makes the loser wait out the winner's tx, then
    // re-read the COMMITTED 'applied' status and 409.
    const store = makeStore();
    seedStrategy(store);
    seedVersion(store, 'v1', new Date('2026-01-01T00:00:00.000Z'));
    const { svc, applyEditSet } = makeService(store);
    const cs = (await svc.create(T, U, createDto())) as Rec;
    await svc.approve(T, U, cs.id, {} as ApproveChangeSetDto);

    // Hold tx1 open mid-apply (inside applyEditSet, both row locks held).
    let enteredApply!: () => void;
    const applyEntered = new Promise<void>((r) => (enteredApply = r));
    let releaseCommitGate!: () => void;
    const commitGate = new Promise<void>((r) => (releaseCommitGate = r));
    applyEditSet.mockImplementationOnce(async () => {
      enteredApply();
      await commitGate;
      return undefined;
    });

    const first = svc.apply(T, U, cs.id);
    await applyEntered;
    // tx2 starts while tx1 is mid-flight and UNCOMMITTED...
    const second = svc.apply(T, U, cs.id).catch((e: unknown) => e);
    // ...and gets to park on the change-set row lock before tx1 commits.
    await new Promise((r) => setTimeout(r, 0));
    releaseCommitGate();

    const detail = (await first) as Rec;
    const err = await second;

    expect(detail.id).toBe(SID); // the winner applied normally
    expect(err).toBeInstanceOf(ConflictException);
    // The loser observed the winner's COMMITTED status through the lock wait.
    expect((err as Error).message).toMatch(/Change-set is applied/);
    // THE regression under guard: the ops replayed exactly once, not twice.
    expect(applyEditSet).toHaveBeenCalledTimes(1);
    // (No final-store asserts here: the fake's whole-store rollback on the
    // loser's in-tx throw models single-tx rollback, not MVCC — the 409 plus
    // the single replay are the load-bearing facts.)
  });

  it('serializes a CONCURRENT apply of a DIFFERENT change-set pinned to the same head on the strategy lock: loser goes stale', async () => {
    // Pre-lock bug: neither tx saw the other's uncommitted version cut, so
    // BOTH passed the stale-head check and the second applied onto a plan the
    // first had already mutated — exactly the divergence the stale/409
    // mechanism exists to prevent. The sp_strategy FOR UPDATE before headOf
    // makes the loser wait for the winner's commit, re-read the moved head,
    // and take the stale path.
    const store = makeStore();
    seedStrategy(store);
    seedVersion(store, 'v1', new Date('2026-01-01T00:00:00.000Z'));
    const { svc, applyEditSet } = makeService(store);
    const cs1 = (await svc.create(T, U, createDto([opA]))) as Rec; // pins v1
    const cs2 = (await svc.create(T, U, createDto([opB]))) as Rec; // pins v1 too
    await svc.approve(T, U, cs1.id, {} as ApproveChangeSetDto);
    await svc.approve(T, U, cs2.id, {} as ApproveChangeSetDto);

    let enteredApply!: () => void;
    const applyEntered = new Promise<void>((r) => (enteredApply = r));
    let releaseCommitGate!: () => void;
    const commitGate = new Promise<void>((r) => (releaseCommitGate = r));
    applyEditSet.mockImplementationOnce(async () => {
      enteredApply();
      await commitGate;
      return undefined;
    });

    const first = svc.apply(T, U, cs1.id);
    await applyEntered;
    const second = svc.apply(T, U, cs2.id).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 0)); // tx2 parks on the strategy lock
    releaseCommitGate();

    const detail = (await first) as Rec;
    const err = await second;

    expect(detail.id).toBe(SID);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/regenerate/);
    expect(applyEditSet).toHaveBeenCalledTimes(1); // cs2's ops never replayed
    // tx2 COMMITTED its stale mark (the 409 is thrown post-tx — no rollback),
    // so full store asserts hold here: winner applied, loser stale, ONE cut.
    expect(store.changeSets.get(cs1.id)!.status).toBe('applied');
    expect(store.changeSets.get(cs2.id)!.status).toBe('stale');
    expect(store.versions.size).toBe(2); // v1 + the winner's single meri cut
    expect(store.activity.some((a) => a.action === 'changeset.stale')).toBe(true);
  });
});

describe('ChangeSetsService.undo', () => {
  it('on applied: restores the PINNED pre-apply strategyVersionId (not the applied version) and sets undone', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedVersion(store, 'v1', new Date('2026-01-01T00:00:00.000Z'));
    const { svc, restoreSpy } = makeService(store);
    const cs = (await svc.create(T, U, createDto())) as Rec;
    await svc.approve(T, U, cs.id, {} as ApproveChangeSetDto);
    await svc.apply(T, U, cs.id);
    const applied = store.changeSets.get(cs.id)!;
    expect(applied.appliedVersionId).not.toBe('v1'); // sanity: pin != applied cut

    const detail = await svc.undo(T, U, cs.id);

    expect(restoreSpy).toHaveBeenCalledTimes(1);
    expect(restoreSpy).toHaveBeenCalledWith(T, U, SID, 'v1');
    expect(store.changeSets.get(cs.id)!.status).toBe('undone');
    expect(store.changeSets.get(cs.id)!.undoneByUserId).toBe(U);
    expect(detail).toEqual({ id: SID, title: 'restored' });
    expect(store.activity.some((a) => a.action === 'changeset.undone')).toBe(true);
  });

  it('409s WITHOUT restoring when the head moved after apply (undo would revert later work)', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedVersion(store, 'v1', new Date('2026-01-01T00:00:00.000Z'));
    const { svc, restoreSpy } = makeService(store);
    const cs = (await svc.create(T, U, createDto())) as Rec;
    await svc.approve(T, U, cs.id, {} as ApproveChangeSetDto);
    await svc.apply(T, U, cs.id);
    // The user keeps editing after the apply: a NEWER version becomes head, so
    // head no longer equals this change-set's appliedVersionId.
    seedVersion(store, 'v-later', new Date('2027-01-01T00:00:00.000Z'));

    const err = await svc.undo(T, U, cs.id).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/restore from version history/);
    expect(restoreSpy).not.toHaveBeenCalled();
    // The row stays applied — nothing was restored, flipped, or logged.
    expect(store.changeSets.get(cs.id)!.status).toBe('applied');
    expect(store.activity.some((a) => a.action === 'changeset.undone')).toBe(false);
  });

  it('Conflicts on a proposed change-set without calling restore', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedVersion(store, 'v1', new Date('2026-01-01T00:00:00.000Z'));
    const { svc, restoreSpy } = makeService(store);
    const cs = (await svc.create(T, U, createDto())) as Rec;

    const err = await svc.undo(T, U, cs.id).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/only an applied change-set can be undone/);
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(store.changeSets.get(cs.id)!.status).toBe('proposed');
  });
});
