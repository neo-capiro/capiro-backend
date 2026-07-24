import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import { ExecutionService, PENDING_ARTIFACT_REF } from './execution.service.js';
import { RunsService } from './runs.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import type { MeriService } from '../meri/meri.service.js';
import type { StewardService } from '../context/steward.service.js';
import type { StrategyFlagsService } from '../flags/strategy-flags.service.js';
import type { ExecutionArtifactClient } from './execution-artifact.client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ExecutionPlanDto } from './dto/agents.dto.js';

/*
 * ExecutionService tests over the in-memory fake tx (watcher.service.spec.ts
 * makeStore/makeTx pattern) with the REAL RunsService + REAL VersioningService
 * wired over it — so the run lifecycle, CAS transitions and every activity+outbox
 * write execute exactly as in prod. The MeriService stub exposes ONLY grounding()
 * and StewardService ONLY health(); the ExecutionArtifactClient is a jest stub so
 * NO real HTTP hop fires. The eligibility gate itself is unit-tested in
 * execution-eligibility.spec.ts — here we prove G0 PARKS without staging, the
 * happy plan produces a reviewed task list, execute is idempotent against the
 * sp_node_artifact triple, a create that commits upstream but whose back-link
 * write fails does NOT duplicate on retry (the write-ahead reservation parks the
 * run for reconciliation), outreach parks awaiting send approval (and NEVER
 * sends), a bearerless execute parks, and attribution/node-advance are correct.
 */

interface Rec {
  [k: string]: unknown;
  id: string;
}

const T = 'tenant-1';
const U = 'user-1';
const SID = 'S1';
const MID = 'M1';
const NID = 'N1';

function daysFromToday(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const CUR_FY = (() => {
  const now = new Date();
  return now.getUTCMonth() + 1 >= 10 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
})();

function makeStore() {
  const store = {
    missions: new Map<string, Rec>(),
    strategies: new Map<string, Rec>(),
    nodes: new Map<string, Rec>(),
    versions: new Map<string, Rec>(),
    runs: new Map<string, Rec>(),
    artifacts: new Map<string, Rec>(),
    facts: [] as Rec[],
    clients: new Map<string, Rec>(),
    activity: [] as Rec[],
    outbox: [] as Rec[],
    // Test hook: when set, the artifact-finalize tx (recordArtifact's deleteMany of
    // the write-ahead reservation) throws, simulating a DB blip AFTER a successful
    // external create — the exact non-atomic window the reservation guards.
    failFinalize: false,
    // Test hook: when set, spNodeArtifact.findFirst hides the PENDING_ARTIFACT_REF
    // sentinel (but reserveArtifact's INSERT still collides on it). This reproduces
    // the read-before-commit concurrency window (Window B) that findArtifact() alone
    // cannot serialize — a concurrent executor's reservation is not yet visible to
    // our read but already blocks our insert.
    hidePendingReservation: false,
    seq: 0,
    nextId(p: string) {
      return `${p}-${++this.seq}`;
    },
    nodesFor(sid: string) {
      return [...this.nodes.values()]
        .filter((n) => n.strategyId === sid)
        .sort((a, b) => String(a.startsOn).localeCompare(String(b.startsOn)));
    },
  };
  return store;
}
type Store = ReturnType<typeof makeStore>;

function seedStrategy(store: Store, over: Partial<Rec> = {}): void {
  store.strategies.set(SID, {
    id: SID,
    tenantId: T,
    clientId: 'C1',
    title: 'FY27 authorization plan',
    type: 'authorization',
    goal: 'Authorize the program',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  });
  store.clients.set('C1', { id: 'C1', tenantId: T, name: 'Acme Defense' });
  store.versions.set('v1', {
    id: 'v1',
    tenantId: T,
    strategyId: SID,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  });
}

function seedMission(store: Store, over: Partial<Rec> = {}): void {
  store.missions.set(MID, {
    id: MID,
    tenantId: T,
    strategyId: SID,
    clientId: null,
    name: 'Execute the plan',
    state: 'active',
    cadence: null,
    nextRunAt: null,
    createdByUserId: U,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    ...over,
  });
}

function seedNode(store: Store, over: Partial<Rec> & { id: string }): void {
  store.nodes.set(over.id, {
    tenantId: T,
    strategyId: SID,
    kind: 'action',
    subject: 'deliverable',
    title: 'File the FY27 one-pager',
    note: null,
    ownerUserId: 'u-owner',
    status: 'suggested',
    startsOn: daysFromToday(5),
    endsOn: daysFromToday(20),
    openEnded: false,
    meriAuthored: false,
    dependsOnIds: [],
    provenance: null,
    createdByUserId: U,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    ...over,
  });
}

function makeTx(store: Store) {
  const now = new Date();
  const $queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (/FROM sp_agent_mission/.test(sql)) {
      const [missionId, tenantId] = values as [string, string];
      const m = store.missions.get(missionId);
      return m && m.tenantId === tenantId
        ? [{ id: m.id, state: m.state, strategyId: m.strategyId }]
        : [];
    }
    if (/FROM clients/.test(sql)) {
      const [clientId, tenantId] = values as [string, string];
      const c = store.clients.get(clientId);
      return c && c.tenantId === tenantId ? [{ name: c.name }] : [];
    }
    throw new Error(`fake tx got an unmodelled raw query: ${sql}`);
  };
  const spAgentMission = {
    findFirst: async ({ where }: { where: { id: string } }) => {
      const m = store.missions.get(where.id);
      return m ? { ...m } : null;
    },
  };
  const spStrategy = {
    findFirst: async ({
      where,
      include,
    }: {
      where: { id: string };
      include?: { nodes?: unknown };
    }) => {
      const rec = store.strategies.get(where.id);
      if (!rec) return null;
      const out: Rec = { ...rec };
      if (include?.nodes) out.nodes = store.nodesFor(rec.id).map((n) => ({ ...n }));
      return out;
    },
  };
  const spNode = {
    findFirst: async ({ where }: { where: { id: string; strategyId?: string } }) => {
      const n = store.nodes.get(where.id);
      if (!n) return null;
      if (where.strategyId !== undefined && n.strategyId !== where.strategyId) return null;
      return { ...n };
    },
    update: async ({ where, data }: { where: { id: string }; data: Rec }) => {
      const n = store.nodes.get(where.id);
      if (!n) throw new Error('node not found');
      store.nodes.set(where.id, { ...n, ...data, updatedAt: now });
      return store.nodes.get(where.id)!;
    },
  };
  const spVersion = {
    findFirst: async ({ where }: { where: { id?: string; strategyId?: string } }) => {
      const rows = [...store.versions.values()]
        .filter((v) => (where.strategyId ? v.strategyId === where.strategyId : true))
        .filter((v) => (where.id ? v.id === where.id : true))
        .sort((a, b) => {
          const dt = (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime();
          return dt !== 0 ? dt : String(b.id).localeCompare(String(a.id));
        });
      return rows[0] ? { ...rows[0] } : null;
    },
  };
  const spAgentRun = {
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
      return { ...rec };
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
    updateMany: async ({ where, data }: { where: { id: string; state?: string }; data: Rec }) => {
      const rec = store.runs.get(where.id);
      if (!rec || (where.state !== undefined && rec.state !== where.state)) return { count: 0 };
      store.runs.set(where.id, { ...rec, ...data, updatedAt: now });
      return { count: 1 };
    },
    findMany: async ({
      where,
      take,
    }: {
      where?: { idempotencyKey?: { startsWith?: string }; strategyId?: string };
      orderBy?: unknown;
      take?: number;
    }) => {
      const prefix = where?.idempotencyKey?.startsWith;
      const rows = [...store.runs.values()]
        .filter((r) => (prefix === undefined ? true : String(r.idempotencyKey).startsWith(prefix)))
        .filter((r) => (where?.strategyId === undefined ? true : r.strategyId === where.strategyId))
        .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
        .slice(0, take ?? 50)
        .map((r) => ({ ...r }));
      return rows;
    },
  };
  const spNodeArtifact = {
    findFirst: async ({
      where,
    }: {
      where: { nodeId: string; artifactType: string };
      select?: unknown;
    }) => {
      const a = [...store.artifacts.values()].find(
        (r) =>
          r.nodeId === where.nodeId &&
          r.artifactType === where.artifactType &&
          !(store.hidePendingReservation && r.artifactRef === PENDING_ARTIFACT_REF),
      );
      return a ? { ...a } : null;
    },
    // Plain create used by reserveArtifact as the CAS guard — throws P2002 on the
    // unique triple so exactly one of two racing reservers wins (mirrors the DB
    // unique index; same shape as spAgentRun.create above).
    create: async ({ data }: { data: Rec }) => {
      const dup = [...store.artifacts.values()].some(
        (r) =>
          r.nodeId === data.nodeId &&
          r.artifactType === data.artifactType &&
          r.artifactRef === data.artifactRef,
      );
      if (dup) {
        const err = Object.assign(new Error('unique'), { code: 'P2002' });
        Object.setPrototypeOf(err, Prisma.PrismaClientKnownRequestError.prototype);
        throw err;
      }
      const id = store.nextId('art');
      const rec: Rec = { ...data, id, createdAt: now };
      store.artifacts.set(id, rec);
      return { ...rec };
    },
    upsert: async ({
      where,
      create,
    }: {
      where: { nodeId_artifactType_artifactRef: { nodeId: string; artifactType: string; artifactRef: string } };
      create: Rec;
      update: Rec;
    }) => {
      const k = where.nodeId_artifactType_artifactRef;
      const existing = [...store.artifacts.values()].find(
        (r) => r.nodeId === k.nodeId && r.artifactType === k.artifactType && r.artifactRef === k.artifactRef,
      );
      if (existing) return { ...existing };
      const id = store.nextId('art');
      const rec: Rec = { ...create, id, createdAt: now };
      store.artifacts.set(id, rec);
      return { ...rec };
    },
    // deleteMany is used only by recordArtifact to retire the write-ahead
    // reservation. The failFinalize hook makes it throw so a test can exercise a
    // finalize failure that leaves the reservation (create already committed).
    deleteMany: async ({
      where,
    }: {
      where: { nodeId: string; artifactType: string; artifactRef: string };
    }) => {
      if (store.failFinalize) throw new Error('DB blip during finalize');
      let count = 0;
      for (const [id, r] of [...store.artifacts.entries()]) {
        if (
          r.nodeId === where.nodeId &&
          r.artifactType === where.artifactType &&
          r.artifactRef === where.artifactRef
        ) {
          store.artifacts.delete(id);
          count++;
        }
      }
      return { count };
    },
  };
  // Faithfully evaluates the subset of Prisma `where` the service builds:
  // scalar equality (state/authority/clientId incl. null), AND/OR/NOT
  // composition, and a `fact` StringFilter (contains + insensitive mode). It
  // also HONORS `take` — the service must not depend on an arbitrary page cap
  // to find a do-not-contact fact, so a regression that reintroduces an
  // unordered cap is observable here.
  const factMatches = (f: Rec, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'AND') return (v as Array<Record<string, unknown>>).every((w) => factMatches(f, w));
      if (k === 'OR') return (v as Array<Record<string, unknown>>).some((w) => factMatches(f, w));
      if (k === 'NOT') return !factMatches(f, v as Record<string, unknown>);
      if (k === 'fact') {
        const cond = v as { contains?: string; mode?: string };
        if (cond.contains === undefined) return true;
        const hay = String(f.fact);
        return cond.mode === 'insensitive'
          ? hay.toLowerCase().includes(cond.contains.toLowerCase())
          : hay.includes(cond.contains);
      }
      return f[k] === v;
    });
  const spContextFact = {
    findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
      const rows = store.facts.filter((f) => factMatches(f, where)).map((f) => ({ fact: f.fact }));
      return typeof take === 'number' ? rows.slice(0, take) : rows;
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
    spNode,
    spVersion,
    spAgentRun,
    spNodeArtifact,
    spContextFact,
    spActivityLog,
    spEventOutbox,
  } as unknown as Prisma.TransactionClient;
}

interface ServiceOpts {
  flagEnabled?: boolean;
  openMaterialConflicts?: Rec[];
  createWorkspaceDraftRef?: string;
  createOutreachRecordRef?: string;
}

function makeService(store: Store, opts: ServiceOpts = {}) {
  const snapshot = () => ({
    missions: new Map(store.missions),
    strategies: new Map(store.strategies),
    nodes: new Map(store.nodes),
    versions: new Map(store.versions),
    runs: new Map(store.runs),
    artifacts: new Map(store.artifacts),
    facts: [...store.facts],
    clients: new Map(store.clients),
    activity: [...store.activity],
    outbox: [...store.outbox],
  });
  const restore = (snap: ReturnType<typeof snapshot>) => {
    Object.assign(store, snap);
  };
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

  const versioning = new VersioningService();
  const runs = new RunsService(prisma, versioning);

  const groundingValue = {
    fiscal: {
      today: daysFromToday(0),
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
    openMaterialConflicts: opts.openMaterialConflicts ?? [],
    staleDocs: [],
    missingRequired: [],
  };
  const health = jest.fn(async (_t: string, _c: string | null) => healthValue);
  const steward = { health } as unknown as StewardService;

  const isAgenticFlagEnabled = jest.fn(async (_t: string, _flag: string) => opts.flagEnabled ?? true);
  const flags = { isAgenticFlagEnabled } as unknown as StrategyFlagsService;

  const createWorkspaceDraft = jest.fn(async (_b: string | undefined, _i: unknown) => ({
    ref: opts.createWorkspaceDraftRef ?? 'wsd-1',
  }));
  const createOutreachRecord = jest.fn(async (_b: string | undefined, _i: unknown) => ({
    ref: opts.createOutreachRecordRef ?? 'or-1',
  }));
  const artifacts = { createWorkspaceDraft, createOutreachRecord } as unknown as ExecutionArtifactClient;

  const svc = new ExecutionService(prisma, versioning, runs, meri, steward, flags, artifacts);
  return { svc, runs, createWorkspaceDraft, createOutreachRecord, grounding, health, isAgenticFlagEnabled };
}

const wsPlan = (over: Partial<ExecutionPlanDto> = {}): ExecutionPlanDto =>
  ({ missionId: MID, nodeId: NID, kind: 'workspace', ...over }) as ExecutionPlanDto;
const outreachPlan = (over: Partial<ExecutionPlanDto> = {}): ExecutionPlanDto =>
  ({ missionId: MID, nodeId: NID, kind: 'outreach', ...over }) as ExecutionPlanDto;

describe('ExecutionService.listRuns', () => {
  it('returns only exec:-keyed runs, strategy-scoped, newest first', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: NID });
    const { svc } = makeService(store);
    // an execution run for this strategy
    await svc.plan(T, U, 'bearer-x', wsPlan());
    // a NON-execution run (watcher-style key) that must be excluded
    store.runs.set('other-run', {
      id: 'other-run',
      tenantId: T,
      missionId: MID,
      strategyId: SID,
      idempotencyKey: `watch:${MID}:2027-01-01`,
      state: 'ready_for_review',
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
    });

    const runs = await svc.listRuns(T, { strategyId: SID });

    expect(runs.length).toBe(1);
    expect(String(runs[0]!.idempotencyKey)).toBe(`exec:${NID}:workspace`);

    // a different strategy's execution run is excluded by the strategyId filter
    const scoped = await svc.listRuns(T, { strategyId: 'other-strategy' });
    expect(scoped.length).toBe(0);
  });
});

describe('ExecutionService.plan — G0 pre-execution re-check', () => {
  it('happy path: an eligible node produces a ready_for_review run with a workspace task list, staging NOTHING', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: NID });
    const { svc, createWorkspaceDraft } = makeService(store);

    const run = await svc.plan(T, U, 'bearer-x', wsPlan());

    expect(run.state).toBe('ready_for_review');
    const findings = run.findings as { tasks?: unknown[]; execution?: Rec; g0?: Rec };
    expect(findings.tasks).toEqual([
      { type: 'workspace_draft', nodeId: NID, detail: { docTitle: 'File the FY27 one-pager', product: 'authorization' } },
    ]);
    expect((findings.execution as Rec).kind).toBe('workspace');
    // Plan stages nothing — no external hop, no artifact rows.
    expect(createWorkspaceDraft).not.toHaveBeenCalled();
    expect(store.artifacts.size).toBe(0);
    // idempotencyKey shape.
    expect([...store.runs.values()][0]!.idempotencyKey).toBe(`exec:${NID}:workspace`);
  });

  it('PARKS on version drift (pinnedVersionId != head) without staging', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: NID });
    const { svc, createWorkspaceDraft } = makeService(store);

    const run = await svc.plan(T, U, 'bearer-x', wsPlan({ pinnedVersionId: 'v-old' }));

    expect(run.state).toBe('waiting_for_input');
    expect(run.waitingReason).toBe('plan changed since approval');
    expect((run.findings as { tasks?: unknown }).tasks).toBeUndefined();
    expect(createWorkspaceDraft).not.toHaveBeenCalled();
    expect(store.artifacts.size).toBe(0);
  });

  it('PARKS when the node is no longer eligible (missing owner) without staging', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: NID, ownerUserId: null });
    const { svc, createWorkspaceDraft } = makeService(store);

    const run = await svc.plan(T, U, 'bearer-x', wsPlan());

    expect(run.state).toBe('waiting_for_input');
    expect(run.waitingReason).toMatch(/^node no longer eligible: /);
    expect(run.waitingReason).toContain('node has no owner');
    expect(createWorkspaceDraft).not.toHaveBeenCalled();
    expect(store.artifacts.size).toBe(0);
  });

  it('PARKS on an unresolved material conflict without staging', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: NID });
    const { svc, createWorkspaceDraft } = makeService(store, {
      openMaterialConflicts: [{ id: 'cf-1', factAId: 'a', factBId: 'b', factA: 'x', factB: 'y' }],
    });

    const run = await svc.plan(T, U, 'bearer-x', outreachPlan({ nodeId: NID }));

    // (node subject is deliverable => also ineligible for outreach, but the
    // material-conflict reason takes precedence.)
    expect(run.state).toBe('waiting_for_input');
    expect(run.waitingReason).toBe('unresolved material conflict');
    expect(createWorkspaceDraft).not.toHaveBeenCalled();
    expect(store.artifacts.size).toBe(0);
  });

  it('fail-closed: a disabled per-kind flag throws Forbidden before any run is minted', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: NID });
    const { svc } = makeService(store, { flagEnabled: false });

    await expect(svc.plan(T, U, 'bearer-x', wsPlan())).rejects.toBeInstanceOf(ForbiddenException);
    expect(store.runs.size).toBe(0);
  });

  it('a repeated plan for the same node+kind returns the SAME reviewed run (idempotent claim)', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: NID });
    const { svc } = makeService(store);

    const first = await svc.plan(T, U, 'bearer-x', wsPlan());
    const again = await svc.plan(T, U, 'bearer-x', wsPlan());
    expect(again.id).toBe(first.id);
    expect(store.runs.size).toBe(1);
  });
});

describe('ExecutionService.execute — workspace staging', () => {
  it('stages a workspace draft, records the back-link, advances the node suggested->in_progress (NOT submitted), and completes', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: NID, status: 'suggested' });
    const { svc, createWorkspaceDraft } = makeService(store);

    const planned = await svc.plan(T, U, 'bearer-x', wsPlan());
    const done = await svc.execute(T, U, 'bearer-x', planned.id);

    expect(done.state).toBe('completed');
    expect(createWorkspaceDraft).toHaveBeenCalledTimes(1);
    // Workspace hop got the resolved client NAME + product.
    expect(createWorkspaceDraft.mock.calls[0]![1]).toMatchObject({
      docTitle: 'File the FY27 one-pager',
      clientName: 'Acme Defense',
      product: 'authorization',
    });
    // One back-link row for the unique triple.
    const arts = [...store.artifacts.values()];
    expect(arts).toHaveLength(1);
    expect(arts[0]).toMatchObject({ nodeId: NID, artifactType: 'workspace_draft', artifactRef: 'wsd-1' });
    // Node advanced exactly to in_progress — never past it to internal_review/active.
    expect(store.nodes.get(NID)!.status).toBe('in_progress');
    // Attribution: agent-staged artifact logged authorKind meri, actor = the interactive user.
    const staged = store.activity.find((a) => a.action === 'execution.artifact_staged')!;
    expect(staged.authorKind).toBe('meri');
    expect(staged.actorUserId).toBe(U);
  });

  it('is idempotent against the sp_node_artifact triple: a re-entered execute stages no duplicate', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: NID, status: 'draft' });
    const { svc, createWorkspaceDraft } = makeService(store);

    const planned = await svc.plan(T, U, 'bearer-x', wsPlan());
    await svc.execute(T, U, 'bearer-x', planned.id);
    expect(createWorkspaceDraft).toHaveBeenCalledTimes(1);
    expect(store.artifacts.size).toBe(1);

    // Simulate a crash-recovery re-entry: the run is left mid-execution.
    store.runs.get(planned.id)!.state = 'executing';
    const again = await svc.execute(T, U, 'bearer-x', planned.id);

    // The existing back-link short-circuits the external create — no duplicate.
    expect(createWorkspaceDraft).toHaveBeenCalledTimes(1);
    expect(store.artifacts.size).toBe(1);
    expect(again.state).toBe('completed');
  });

  it('write-ahead reservation makes a retry safe: a create that commits upstream but whose back-link write FAILS does NOT duplicate on retry — the run parks for reconciliation', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: NID, status: 'suggested' });
    const { svc, createWorkspaceDraft } = makeService(store);

    const planned = await svc.plan(T, U, 'bearer-x', wsPlan());

    // First execute: the external create succeeds (the WsDraft exists upstream)
    // but the back-link finalize fails (DB blip). The reservation is already
    // committed; the finalize tx (and its node-status advance) rolls back.
    store.failFinalize = true;
    await expect(svc.execute(T, U, 'bearer-x', planned.id)).rejects.toBeTruthy();
    expect(createWorkspaceDraft).toHaveBeenCalledTimes(1);
    // No real back-link committed — only the write-ahead reservation survives.
    const afterFail = [...store.artifacts.values()];
    expect(afterFail).toHaveLength(1);
    expect(afterFail[0]!.artifactRef).toBe(PENDING_ARTIFACT_REF);
    // The node was NOT advanced and the run is left mid-execution ('executing').
    expect(store.nodes.get(NID)!.status).toBe('suggested');
    expect(store.runs.get(planned.id)!.state).toBe('executing');

    // Retry — re-entry from 'executing' is a supported flow. The surviving
    // reservation short-circuits the external create (NO duplicate WsDraft), and
    // the run parks for reconciliation instead of blindly re-creating or completing.
    store.failFinalize = false; // irrelevant: the retry never reaches finalize
    const retried = await svc.execute(T, U, 'bearer-x', planned.id);
    expect(createWorkspaceDraft).toHaveBeenCalledTimes(1); // still exactly ONE create
    expect(retried.state).toBe('waiting_for_input');
    expect(retried.waitingReason).toMatch(/reconcile/i);
    // Still exactly the one reservation row — nothing duplicated.
    expect(store.artifacts.size).toBe(1);
    expect([...store.artifacts.values()][0]!.artifactRef).toBe(PENDING_ARTIFACT_REF);
  });

  it('CAS guard: a concurrent executor that reserved in the read-before-commit window cannot double-create — the losing attempt parks for reconciliation (no duplicate hop)', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: NID, status: 'suggested' });
    const { svc, createWorkspaceDraft } = makeService(store);

    const planned = await svc.plan(T, U, 'bearer-x', wsPlan());

    // Window B: a CONCURRENT executor has already committed its write-ahead
    // reservation, but that row is not yet visible to our findArtifact() read
    // (hidePendingReservation hides it from finds while it still collides on the
    // reserve INSERT) — the exact narrow race a plain find pre-check cannot
    // serialize and an idempotent upsert would silently let through.
    store.artifacts.set('concurrent-reservation', {
      id: 'concurrent-reservation',
      tenantId: T,
      strategyId: SID,
      nodeId: NID,
      artifactType: 'workspace_draft',
      artifactRef: PENDING_ARTIFACT_REF,
      createdByUserId: 'concurrent-user',
    });
    store.hidePendingReservation = true;

    // Re-entry from 'executing' (the unguarded path). Our reserve INSERT collides
    // with the concurrent reservation (P2002); the CAS guard makes us stand down.
    store.runs.get(planned.id)!.state = 'executing';
    const parked = await svc.execute(T, U, 'bearer-x', planned.id);

    expect(createWorkspaceDraft).not.toHaveBeenCalled(); // serialized — NO duplicate create
    expect(parked.state).toBe('waiting_for_input');
    expect(parked.waitingReason).toMatch(/reconcile/i);
    // No duplicate row: only the single concurrent reservation remains.
    expect(store.artifacts.size).toBe(1);
    expect([...store.artifacts.values()][0]!.artifactRef).toBe(PENDING_ARTIFACT_REF);
    // The node was NOT advanced — nothing was staged by the losing attempt.
    expect(store.nodes.get(NID)!.status).toBe('suggested');
  });

  it('bearerless execute PARKS in waiting_for_input and NEVER stages (no bearerless external hop)', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: NID });
    const { svc, createWorkspaceDraft } = makeService(store);

    const planned = await svc.plan(T, U, 'bearer-x', wsPlan());
    const parked = await svc.execute(T, U, undefined, planned.id);

    expect(parked.state).toBe('waiting_for_input');
    expect(parked.waitingReason).toBe('execution requires an interactive session');
    expect(createWorkspaceDraft).not.toHaveBeenCalled();
    expect(store.artifacts.size).toBe(0);

    // Resuming WITH a bearer continues to completion + stages exactly once.
    const resumed = await svc.resume(T, U, 'bearer-x', planned.id);
    expect(resumed.state).toBe('completed');
    expect(createWorkspaceDraft).toHaveBeenCalledTimes(1);
    expect(store.artifacts.size).toBe(1);
  });

  it('resume of a tasked (parked) run WITHOUT a bearer refuses — the run stays parked', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: NID });
    const { svc, createWorkspaceDraft } = makeService(store);

    const planned = await svc.plan(T, U, 'bearer-x', wsPlan());
    await svc.execute(T, U, undefined, planned.id); // park

    await expect(svc.resume(T, U, undefined, planned.id)).rejects.toBeInstanceOf(BadRequestException);
    expect(createWorkspaceDraft).not.toHaveBeenCalled();
    expect(store.runs.get(planned.id)!.state).toBe('waiting_for_input');
  });
});

describe('ExecutionService.execute — outreach staging (send hard-disabled)', () => {
  it('stages an outreach record then PARKS awaiting send approval with a run-bound token — and NEVER sends', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: NID, subject: 'member', title: 'Meet with Rep. Doe' });
    const { svc, createOutreachRecord } = makeService(store);

    const planned = await svc.plan(T, U, 'bearer-x', outreachPlan());
    expect((planned.findings as { tasks: Array<{ type: string }> }).tasks.map((t) => t.type)).toEqual([
      'outreach_record',
      'await_send_approval',
    ]);

    const parked = await svc.execute(T, U, 'bearer-x', planned.id);

    expect(parked.state).toBe('waiting_for_input');
    expect(parked.waitingReason).toBe('awaiting send approval');
    // The record was staged (creation only — the client has NO send path).
    expect(createOutreachRecord).toHaveBeenCalledTimes(1);
    const arts = [...store.artifacts.values()];
    expect(arts).toHaveLength(1);
    expect(arts[0]).toMatchObject({ artifactType: 'outreach_record', artifactRef: 'or-1' });
    // Send-approval token is computed, run-bound, and send stays disabled.
    const sa = (parked.findings as { sendApproval: Rec }).sendApproval;
    expect(String(sa.token)).toMatch(/^[0-9a-f]{64}$/);
    expect(sa.tokenRunId).toBe(planned.id);
    expect(sa.status).toBe('pending');
    expect(sa.sendEnabled).toBe(false);
    // NOT completed — a pending send never auto-completes.
    expect(parked.state).not.toBe('completed');
  });

  it('BLOCKS the outreach on a client do-not-contact constraint (client_approved fact) — nothing staged', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: NID, subject: 'committee' });
    store.facts.push({
      id: 'f-1',
      clientId: 'C1',
      state: 'active',
      authority: 'client_approved',
      fact: 'Do not contact committee staff directly this cycle.',
    });
    const { svc, createOutreachRecord } = makeService(store);

    const planned = await svc.plan(T, U, 'bearer-x', outreachPlan());
    const parked = await svc.execute(T, U, 'bearer-x', planned.id);

    expect(parked.state).toBe('waiting_for_input');
    expect(parked.waitingReason).toMatch(/do-not-contact/);
    expect(createOutreachRecord).not.toHaveBeenCalled();
    expect(store.artifacts.size).toBe(0);
    const results = (parked.findings as { results: Record<string, Rec> }).results;
    expect(results[`${NID}:outreach_record`]!.status).toBe('blocked');
    expect(results[`${NID}:await_send_approval`]!.status).toBe('skipped');
  });

  it('BLOCKS even when >200 client_approved facts are in scope and the do-not-contact fact sits beyond an arbitrary page — the gate must not depend on a row cap', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: NID, subject: 'committee' });
    // 250 active client_approved facts in scope that do NOT match do-not-contact
    // (half global clientId:null, which the OR aggregates across the tenant),
    // THEN the standing instruction pushed LAST. A prior version read an
    // unordered take:200 page then regex-scanned it in JS, so the matching fact
    // could fall outside the page and the gate would silently pass. The fake tx
    // honors `take`, so that regression is observable here.
    for (let i = 0; i < 250; i++) {
      store.facts.push({
        id: `noise-${i}`,
        clientId: i % 2 === 0 ? 'C1' : null,
        state: 'active',
        authority: 'client_approved',
        fact: `Prefer email over phone for scheduling — note ${i}.`,
      });
    }
    store.facts.push({
      id: 'dnc',
      clientId: 'C1',
      state: 'active',
      authority: 'client_approved',
      fact: 'Do not contact committee staff directly this cycle.',
    });
    const { svc, createOutreachRecord } = makeService(store);

    const planned = await svc.plan(T, U, 'bearer-x', outreachPlan());
    const parked = await svc.execute(T, U, 'bearer-x', planned.id);

    expect(parked.state).toBe('waiting_for_input');
    expect(parked.waitingReason).toMatch(/do-not-contact/);
    expect(createOutreachRecord).not.toHaveBeenCalled();
    expect(store.artifacts.size).toBe(0);
    const results = (parked.findings as { results: Record<string, Rec> }).results;
    expect(results[`${NID}:outreach_record`]!.status).toBe('blocked');
  });
});

describe('ExecutionService.execute — G0 RE-CHECK at execute time (post-review blocker)', () => {
  it('PARKS without staging when a material conflict opens AFTER plan-review (the blocker is re-enforced at execute, not only at plan)', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: NID });
    const { svc, createWorkspaceDraft, health } = makeService(store);

    // plan() runs G0 clean (no conflicts) -> reviewed, staging nothing.
    const planned = await svc.plan(T, U, 'bearer-x', wsPlan());
    expect(planned.state).toBe('ready_for_review');

    // The Steward opens a material conflict for the strategy BEFORE the reviewer
    // clicks execute — the exact race the plan invariant guards against.
    health.mockResolvedValue({
      status: 'ok',
      factCounts: { active: 0, superseded: 0, stale: 0, rejected: 0 },
      openConflicts: 1,
      openMaterialConflicts: [{ id: 'cf-2', factAId: 'a', factBId: 'b', factA: 'x', factB: 'y' }],
      staleDocs: [],
      missingRequired: [],
    });

    const parked = await svc.execute(T, U, 'bearer-x', planned.id);

    // The execute-time G0 re-check catches it and parks — nothing is staged.
    expect(parked.state).toBe('waiting_for_input');
    expect(parked.waitingReason).toBe('unresolved material conflict');
    expect(createWorkspaceDraft).not.toHaveBeenCalled();
    expect(store.artifacts.size).toBe(0);
    // The gate genuinely re-ran at execute (health consulted a second time).
    expect(health).toHaveBeenCalledTimes(2);
  });

  it('PARKS without staging when the plan head advances past the pinned version AFTER review (version drift)', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: NID });
    const { svc, createWorkspaceDraft } = makeService(store);

    // Pin the reviewed plan to the current head (v1) — clean at plan time.
    const planned = await svc.plan(T, U, 'bearer-x', wsPlan({ pinnedVersionId: 'v1' }));
    expect(planned.state).toBe('ready_for_review');

    // The plan is edited after review: a newer version (v2) becomes head.
    store.versions.set('v2', {
      id: 'v2',
      tenantId: T,
      strategyId: SID,
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
    });

    const parked = await svc.execute(T, U, 'bearer-x', planned.id);

    expect(parked.state).toBe('waiting_for_input');
    expect(parked.waitingReason).toBe('plan changed since approval');
    expect(createWorkspaceDraft).not.toHaveBeenCalled();
    expect(store.artifacts.size).toBe(0);
  });

  it('PARKS without staging when the node loses its owner AFTER review (eligibility)', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: NID });
    const { svc, createWorkspaceDraft } = makeService(store);

    const planned = await svc.plan(T, U, 'bearer-x', wsPlan());
    expect(planned.state).toBe('ready_for_review');

    // The node's owner is cleared after review — it is no longer eligible.
    store.nodes.get(NID)!.ownerUserId = null;

    const parked = await svc.execute(T, U, 'bearer-x', planned.id);

    expect(parked.state).toBe('waiting_for_input');
    expect(parked.waitingReason).toMatch(/^node no longer eligible: /);
    expect(parked.waitingReason).toContain('node has no owner');
    expect(createWorkspaceDraft).not.toHaveBeenCalled();
    expect(store.artifacts.size).toBe(0);
  });
});

describe('ExecutionService — lifecycle guards', () => {
  it('execute on a run with no reviewed plan is rejected', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: NID, ownerUserId: null }); // G0 parks with no tasks
    const { svc } = makeService(store);

    const parked = await svc.plan(T, U, 'bearer-x', wsPlan());
    expect(parked.state).toBe('waiting_for_input');
    // No tasks were produced, so execute has nothing to run.
    await expect(svc.execute(T, U, 'bearer-x', parked.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a second plan() of a MID-EXECUTION parked run (staged + awaiting send approval) is REJECTED, not re-planned — resume() owns the continuation', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: NID, subject: 'member', title: 'Meet with Rep. Doe' });
    const { svc, createOutreachRecord } = makeService(store);

    // Stage the outreach record and park awaiting send approval (findings now
    // carry tasks + results + a pending sendApproval token).
    const planned = await svc.plan(T, U, 'bearer-x', outreachPlan());
    const parked = await svc.execute(T, U, 'bearer-x', planned.id);
    expect(parked.state).toBe('waiting_for_input');
    expect(parked.waitingReason).toBe('awaiting send approval');
    expect(createOutreachRecord).toHaveBeenCalledTimes(1);
    expect(store.artifacts.size).toBe(1);

    // A replay plan() for the SAME node+kind hits idempotency (returns the parked
    // run) — it must NOT rewind it to planning/ready_for_review.
    await expect(svc.plan(T, U, 'bearer-x', outreachPlan())).rejects.toBeInstanceOf(ConflictException);

    // The parked run is untouched: still awaiting send approval, staged results +
    // token intact, no re-plan, no duplicate hop/artifact.
    const after = store.runs.get(planned.id)!;
    expect(after.state).toBe('waiting_for_input');
    expect(after.waitingReason).toBe('awaiting send approval');
    const findings = after.findings as { results?: Record<string, Rec>; sendApproval?: Rec };
    expect(findings.results![`${NID}:outreach_record`]).toBeDefined();
    expect(findings.sendApproval!.status).toBe('pending');
    expect(createOutreachRecord).toHaveBeenCalledTimes(1);
    expect(store.artifacts.size).toBe(1);

    // The intended continuation still works: resume() drives it forward (and, with
    // the send hard-disabled, re-parks awaiting send approval — never sends).
    const resumed = await svc.resume(T, U, 'bearer-x', planned.id);
    expect(resumed.state).toBe('waiting_for_input');
    expect(resumed.waitingReason).toBe('awaiting send approval');
    expect(createOutreachRecord).toHaveBeenCalledTimes(1); // idempotent — no second hop
    expect(store.artifacts.size).toBe(1);
  });

  it('resume of a G0-parked run re-checks and, once the gap is fixed, produces a reviewed plan', async () => {
    const store = makeStore();
    seedStrategy(store);
    seedMission(store);
    seedNode(store, { id: NID, ownerUserId: null }); // ineligible -> G0 park
    const { svc } = makeService(store);

    const parked = await svc.plan(T, U, 'bearer-x', wsPlan());
    expect(parked.state).toBe('waiting_for_input');

    // Fix the eligibility gap, then resume -> re-plan -> ready_for_review.
    store.nodes.get(NID)!.ownerUserId = 'u-owner';
    const replanned = await svc.resume(T, U, 'bearer-x', parked.id);
    expect(replanned.state).toBe('ready_for_review');
    expect((replanned.findings as { tasks: unknown[] }).tasks).toHaveLength(1);
  });
});
