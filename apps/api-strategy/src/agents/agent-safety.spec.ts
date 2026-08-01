import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';

// Real PURE modules — these probes are honest integration checks, not mock
// theater: the invariant is asserted against the code that actually ships.
import { assertTransition, isLegalTransition, RUN_TERMINAL_STATES } from './run-state.js';
import {
  computeSendToken,
  sendEnabled,
  verifySendToken,
  type SendTokenInput,
} from './send-approval.js';
import { fyQuarter } from '../context/current-plan-export.service.js';

// Real services + guards under safety probes.
import { AGENTIC_FLAGS, StrategyFlagsService } from '../flags/strategy-flags.service.js';
import { AgenticGuard } from '../flags/agentic.guard.js';
import { StrategyWatcherGuard } from '../flags/strategy-watcher.guard.js';
import { ContextStewardGuard } from '../flags/context-steward.guard.js';
import { ExecutionAgentGuard } from '../flags/execution-agent.guard.js';
import { ExecutionService, PENDING_ARTIFACT_REF } from './execution.service.js';
import { ChangeSetsService } from './change-sets.service.js';
import { StewardService } from '../context/steward.service.js';
import { RunsService } from './runs.service.js';
import { VersioningService } from '../strategy/versioning.service.js';

import type { PrismaService } from '../prisma/prisma.service.js';
import type { MeriService } from '../meri/meri.service.js';
import type { StewardService as StewardServiceType } from '../context/steward.service.js';
import type { StrategyFlagsService as FlagsType } from '../flags/strategy-flags.service.js';
import type { ExecutionArtifactClient } from './execution-artifact.client.js';
import type { VersionService } from '../strategy/version.service.js';
import type { StrategyAiCredentialResolver } from '../meri/strategy-ai-credential.resolver.js';
import type { StrategyOrchestratorClient } from '../meri/strategy-orchestrator.client.js';
import type { CreateChangeSetDto, ExecutionPlanDto, CreateRunDto } from './dto/agents.dto.js';

/*
 * Stage H CONSOLIDATED TRUST/SAFETY probe suite. Each it() is an INVARIANT the
 * agentic stack must uphold, framed as an ADVERSARIAL attempt that must fail
 * (or a leak that must not happen). Deterministic — zero live LLM/network/DB —
 * so it runs in CI alongside the other api-strategy specs. Pure invariants
 * import the real modules directly; stateful invariants drive the real services
 * over the in-memory fake tx shared by the other agent specs.
 */

const T = 'tenant-1';
const U = 'user-1';
const SID = 'S1';
const MID = 'M1';
const NID = 'N1';

interface Rec {
  [k: string]: unknown;
  id: string;
}

function daysFromToday(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const CUR_FY = (() => {
  const now = new Date();
  return now.getUTCMonth() + 1 >= 10 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
})();

// ---- shared unified fake store + tx ---------------------------------------

function makeStore() {
  const store = {
    missions: new Map<string, Rec>(),
    strategies: new Map<string, Rec>(),
    nodes: new Map<string, Rec>(),
    versions: new Map<string, Rec>(),
    runs: new Map<string, Rec>(),
    changeSets: new Map<string, Rec>(),
    artifacts: new Map<string, Rec>(),
    facts: [] as Rec[],
    conflicts: [] as Rec[],
    docs: [] as Rec[],
    clients: new Map<string, Rec>(),
    activity: [] as Rec[],
    outbox: [] as Rec[],
    failFinalize: false,
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

/** Generic Prisma-`where` evaluator: scalar equality (incl. null), OR/AND/NOT, {in}, {not}. */
function whereMatch(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v === undefined) return true;
    if (k === 'OR') return (v as Array<Record<string, unknown>>).some((w) => whereMatch(row, w));
    if (k === 'AND') return (v as Array<Record<string, unknown>>).every((w) => whereMatch(row, w));
    if (k === 'NOT') return !whereMatch(row, v as Record<string, unknown>);
    if (v && typeof v === 'object' && 'in' in (v as object)) {
      return ((v as { in: unknown[] }).in ?? []).includes(row[k]);
    }
    if (v && typeof v === 'object' && 'not' in (v as object)) {
      return row[k] !== (v as { not: unknown }).not;
    }
    return row[k] === v;
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
    if (/FROM sp_change_set/.test(sql)) {
      const [csId, tenantId] = values as [string, string];
      const rec = store.changeSets.get(csId);
      return rec && rec.tenantId === tenantId ? [{ id: csId }] : [];
    }
    if (/FROM sp_strategy/.test(sql)) {
      const [sid, tenantId] = values as [string, string];
      const rec = store.strategies.get(sid);
      return rec && rec.tenantId === tenantId ? [{ id: sid }] : [];
    }
    throw new Error(`fake tx got an unmodelled raw query: ${sql}`);
  };

  const spAgentMission = {
    findFirst: async ({ where }: { where: { id: string } }) => {
      const m = store.missions.get(where.id);
      return m ? { ...m } : null;
    },
  };

  const attachStrategy = (rec: Rec, include?: { nodes?: unknown; artifacts?: unknown }) => {
    const out: Rec = { ...rec };
    if (include?.nodes) out.nodes = store.nodesFor(rec.id).map((n) => ({ ...n }));
    if (include?.artifacts) {
      out.artifacts = [...store.artifacts.values()]
        .filter((a) => a.strategyId === rec.id)
        .map((a) => ({ ...a }));
    }
    return out;
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
      return rec ? attachStrategy(rec, include) : null;
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
      return attachStrategy(rec, include);
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
    create: async ({ data }: { data: Rec }) => {
      const id = store.nextId('version');
      const rec = { ...data, id };
      store.versions.set(id, rec);
      return rec;
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
    findMany: async ({ where, take }: { where?: { strategyId?: string }; take?: number }) => {
      const rows = [...store.runs.values()]
        .filter((r) => (where?.strategyId === undefined ? true : r.strategyId === where.strategyId))
        .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
        .slice(0, take ?? 50)
        .map((r) => ({ ...r }));
      return rows;
    },
    count: async ({ where = {} }: { where?: { state?: { in?: string[] } } }) => {
      const states = where.state?.in;
      return [...store.runs.values()].filter(
        (r) => states === undefined || states.includes(r.state as string),
      ).length;
    },
  };

  const spNodeArtifact = {
    findFirst: async ({ where }: { where: { nodeId: string; artifactType: string } }) => {
      const a = [...store.artifacts.values()].find(
        (r) =>
          r.nodeId === where.nodeId &&
          r.artifactType === where.artifactType &&
          !(store.hidePendingReservation && r.artifactRef === PENDING_ARTIFACT_REF),
      );
      return a ? { ...a } : null;
    },
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
      where: {
        nodeId_artifactType_artifactRef: {
          nodeId: string;
          artifactType: string;
          artifactRef: string;
        };
      };
      create: Rec;
      update: Rec;
    }) => {
      const k = where.nodeId_artifactType_artifactRef;
      const existing = [...store.artifacts.values()].find(
        (r) =>
          r.nodeId === k.nodeId &&
          r.artifactType === k.artifactType &&
          r.artifactRef === k.artifactRef,
      );
      if (existing) return { ...existing };
      const id = store.nextId('art');
      const rec: Rec = { ...create, id, createdAt: now };
      store.artifacts.set(id, rec);
      return { ...rec };
    },
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

  const spChangeSet = {
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
    findMany: async ({ where }: { where: { strategyId?: string; status?: unknown } }) =>
      [...store.changeSets.values()].filter((c) => {
        if (where.strategyId && c.strategyId !== where.strategyId) return false;
        if (typeof where.status === 'string') return c.status === where.status;
        if (where.status && typeof where.status === 'object' && 'in' in where.status) {
          return (where.status as { in: string[] }).in.includes(c.status as string);
        }
        return true;
      }),
    update: async ({ where, data }: { where: { id: string }; data: Rec }) => {
      const rec = store.changeSets.get(where.id);
      if (!rec) throw new Error('change-set not found');
      const merged = { ...rec, ...data, updatedAt: now };
      store.changeSets.set(where.id, merged);
      return merged;
    },
    updateMany: async ({ where, data }: { where: { id: string; status?: string }; data: Rec }) => {
      const rec = store.changeSets.get(where.id);
      if (!rec || (where.status !== undefined && rec.status !== where.status)) return { count: 0 };
      store.changeSets.set(where.id, { ...rec, ...data, updatedAt: now });
      return { count: 1 };
    },
  };

  const spContextFact = {
    findMany: async ({
      where = {},
      take,
      include,
    }: {
      where?: Record<string, unknown>;
      take?: number;
      include?: { document?: unknown };
    }) => {
      let rows = store.facts.filter((f) => whereMatch(f, where));
      if (typeof take === 'number') rows = rows.slice(0, take);
      return rows.map((f) => ({
        ...f,
        ...(include?.document
          ? {
              document: {
                title: (f.documentTitle as string) ?? 'Doc',
                templateKey: (f.templateKey as string) ?? 'strategy_brief',
              },
            }
          : {}),
      }));
    },
  };
  const spContextConflict = {
    findMany: async ({ where = {} }: { where?: Record<string, unknown> }) =>
      store.conflicts.filter((c) => whereMatch(c, where)).map((c) => ({ ...c })),
  };
  const spContextDocument = {
    findMany: async ({ where = {} }: { where?: Record<string, unknown> }) =>
      store.docs.filter((d) => whereMatch(d, where)).map((d) => ({ ...d })),
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
    spChangeSet,
    spContextFact,
    spContextConflict,
    spContextDocument,
    spActivityLog,
    spEventOutbox,
  } as unknown as Prisma.TransactionClient;
}

function makePrisma(store: Store) {
  const snapshot = () => ({
    missions: new Map(store.missions),
    strategies: new Map(store.strategies),
    nodes: new Map(store.nodes),
    versions: new Map(store.versions),
    runs: new Map(store.runs),
    changeSets: new Map(store.changeSets),
    artifacts: new Map(store.artifacts),
    facts: [...store.facts],
    conflicts: [...store.conflicts],
    docs: [...store.docs],
    clients: new Map(store.clients),
    activity: [...store.activity],
    outbox: [...store.outbox],
  });
  const inTx = async (fn: (tx: unknown) => Promise<unknown>) => {
    const snap = snapshot();
    try {
      return await fn(makeTx(store));
    } catch (e) {
      Object.assign(store, snap);
      throw e;
    }
  };
  const withTenantUser = jest.fn(
    async (_t: string, _u: string, fn: (tx: unknown) => Promise<unknown>) => inTx(fn),
  );
  const withTenant = jest.fn(async (_t: string, fn: (tx: unknown) => Promise<unknown>) => inTx(fn));
  return { withTenantUser, withTenant } as unknown as PrismaService;
}

// ---- seeds ----------------------------------------------------------------

function seedExecStrategy(store: Store): void {
  store.strategies.set(SID, {
    id: SID,
    tenantId: T,
    clientId: 'C1',
    title: 'FY27 authorization plan',
    type: 'authorization',
    goal: 'Authorize the program',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  store.clients.set('C1', { id: 'C1', tenantId: T, name: 'Acme Defense' });
  store.versions.set('v1', {
    id: 'v1',
    tenantId: T,
    strategyId: SID,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  });
}
function seedMission(store: Store): void {
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
  });
}
function seedNode(store: Store, over: Partial<Rec> & { id: string }): void {
  store.nodes.set(over.id, {
    tenantId: T,
    strategyId: SID,
    kind: 'action',
    subject: 'deliverable',
    title: 'File the FY27 one-pager',
    ownerUserId: 'u-owner',
    status: 'suggested',
    startsOn: daysFromToday(5),
    endsOn: daysFromToday(20),
    dependsOnIds: [],
    createdByUserId: U,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    ...over,
  });
}

// ---- execution service env (real Runs + Versioning + stubbed collaborators) --

function makeExecEnv(store: Store) {
  const prisma = makePrisma(store);
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
  // Stage-G: defaults to null (deterministic fallback) — matches this spec's
  // fixed expectations on the placeholder path.
  const draftExecutionDocument = jest.fn(async (_t: string, _b: string, _i: unknown) => null);
  const meri = { grounding, draftExecutionDocument } as unknown as MeriService;
  const health = jest.fn(async (_t: string, _c: string | null) => ({
    status: 'ok' as const,
    factCounts: { active: 0, superseded: 0, stale: 0, rejected: 0 },
    openConflicts: 0,
    openMaterialConflicts: [] as unknown[],
    staleDocs: [],
    missingRequired: [],
  }));
  const factsForOrchestrator = jest.fn(async (_t: string, _c: string | null) => []);
  const steward = { health, factsForOrchestrator } as unknown as StewardServiceType;
  const isAgenticFlagEnabled = jest.fn(async (_t: string, _flag: string) => true);
  const flags = { isAgenticFlagEnabled } as unknown as FlagsType;
  const createWorkspaceDraft = jest.fn(async (_b: string | undefined, _i: unknown) => ({
    ref: 'wsd-1',
  }));
  const createOutreachRecord = jest.fn(async (_b: string | undefined, _i: unknown) => ({
    ref: 'or-1',
  }));
  const artifacts = {
    createWorkspaceDraft,
    createOutreachRecord,
  } as unknown as ExecutionArtifactClient;

  const svc = new ExecutionService(prisma, versioning, runs, meri, steward, flags, artifacts);
  return { svc, runs, createWorkspaceDraft, createOutreachRecord };
}

const wsPlan = (over: Partial<ExecutionPlanDto> = {}): ExecutionPlanDto =>
  ({ missionId: MID, nodeId: NID, kind: 'workspace', ...over }) as ExecutionPlanDto;

// ---- change-sets service env (real Versioning + stubbed Meri/VersionService) --

const opA = { op: 'update', nodeId: 'N1', title: 'Node one (tightened)' };

function makeChangeSetsEnv(store: Store) {
  const prisma = makePrisma(store);
  const applyEditSet = jest.fn(async (..._args: unknown[]) => undefined);
  const grounding = jest.fn(async (_t: string) => ({ fiscal: {}, firmPhases: [], reference: {} }));
  const verifyAppliedPlan = jest.fn(async () => ({
    detail: { id: SID },
    violations: [] as unknown[],
  }));
  const meri = { applyEditSet, grounding, verifyAppliedPlan } as unknown as MeriService;
  const restoreSpy = jest.fn(async () => ({ id: SID, title: 'restored' }));
  const versions = { restore: restoreSpy } as unknown as VersionService;
  const svc = new ChangeSetsService(prisma, new VersioningService(), versions, meri);
  return { svc, applyEditSet };
}

function seedChangeSetStrategy(store: Store): void {
  store.strategies.set(SID, {
    id: SID,
    tenantId: T,
    clientId: 'C1',
    title: 'Existing plan',
    type: 'appropriations',
    goal: 'Win the plus-up',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastEditedByUserId: null,
    lastEditedAt: null,
  });
  store.versions.set('v1', {
    id: 'v1',
    tenantId: T,
    strategyId: SID,
    snapshot: { meta: {}, nodes: [] },
    authorKind: 'person',
    authorUserId: U,
    note: 'seed',
    coalescible: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  });
}

// ---- steward service env (real StewardService) ----------------------------

const CLIENT_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const CLIENT_B = 'bbbbbbbb-2222-4222-8222-222222222222';

function makeStewardEnv(store: Store) {
  const prisma = makePrisma(store);
  const svc = new StewardService(
    prisma,
    new VersioningService(),
    {} as unknown as StrategyAiCredentialResolver,
    {} as unknown as StrategyOrchestratorClient,
  );
  return { svc };
}

function seedTwoClients(store: Store): void {
  const fact = (over: Partial<Rec> & { id: string }): Rec => ({
    tenantId: T,
    state: 'active',
    authority: null,
    asOf: null,
    documentTitle: 'Doc',
    templateKey: 'strategy_brief',
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    fact: 'x',
    clientId: null,
    ...over,
  });
  store.facts.push(
    fact({ id: 'fA', clientId: CLIENT_A, fact: 'Client A secret — must not leak' }),
    fact({ id: 'fA2', clientId: CLIENT_A, fact: 'Client A other position' }),
    fact({ id: 'fB', clientId: CLIENT_B, fact: 'Client B position' }),
    fact({ id: 'fN', clientId: null, fact: 'Firm-wide standing note' }),
  );
  // An OPEN MATERIAL conflict between two client-A facts.
  store.conflicts.push({
    id: 'cA',
    tenantId: T,
    factAId: 'fA',
    factBId: 'fA2',
    material: true,
    state: 'open',
    createdAt: new Date('2026-05-02T00:00:00.000Z'),
  });
}

// ===========================================================================
// INVARIANT 1 — permission-bypass: the kill switch is airtight
// ===========================================================================

describe('agent-safety: permission-bypass', () => {
  const ENV = 'STRATEGY_AGENTS_ENABLED';
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[ENV];
    delete process.env[ENV];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  it('with STRATEGY_AGENTS_ENABLED unset, isAgenticFlagEnabled is false for ALL SIX agentic flags WITHOUT a DB read', async () => {
    const withTenant = jest.fn(); // must NEVER be reached — the env short-circuit is airtight
    const flags = new StrategyFlagsService({ withTenant } as unknown as PrismaService);

    const allFlags = Object.values(AGENTIC_FLAGS);
    expect(allFlags).toHaveLength(6);
    for (const flag of allFlags) {
      expect(await flags.isAgenticFlagEnabled(T, flag)).toBe(false);
    }
    expect(withTenant).not.toHaveBeenCalled();
  });

  it('every agentic guard 403s when its flag resolves off (fail-closed)', async () => {
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ tenantContext: { tenantId: T } }) }),
    } as unknown as ExecutionContext;
    const flagsOff = {
      isAgenticEnabled: jest.fn(async () => false),
      isAgenticFlagEnabled: jest.fn(async () => false),
    } as unknown as FlagsType;

    await expect(new AgenticGuard(flagsOff).canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(new StrategyWatcherGuard(flagsOff).canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(new ContextStewardGuard(flagsOff).canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(new ExecutionAgentGuard(flagsOff).canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

// ===========================================================================
// INVARIANT 2 — cross-client leakage: client A never bleeds into client B
// ===========================================================================

describe('agent-safety: cross-client leakage', () => {
  it('a client-A fact / conflict is never returned to a query scoped to client B', async () => {
    const store = makeStore();
    seedTwoClients(store);
    const { svc } = makeStewardEnv(store);

    // Facts: B sees only its own row — not A's, not even the firm-wide null row
    // (listFacts is a direct clientId filter).
    const factsB = await svc.listFacts(T, { clientId: CLIENT_B });
    expect(factsB.map((f) => f.id)).toEqual(['fB']);
    expect(factsB.some((f) => f.clientId === CLIENT_A)).toBe(false);

    // Conflicts: the A↔A material conflict must not surface for B.
    const conflictsB = await svc.listConflicts(T, { clientId: CLIENT_B });
    expect(conflictsB).toEqual([]);

    // Health: B's open-material-conflict blocker set is empty (A's conflict is
    // out of scope) — the exact signal ExecutionService G0 gates on.
    const healthB = await svc.health(T, CLIENT_B);
    expect(healthB.openMaterialConflicts).toEqual([]);

    // Sanity — the same data IS visible to its OWN client, so this proves
    // SCOPING, not a blanket-empty read.
    const conflictsA = await svc.listConflicts(T, { clientId: CLIENT_A });
    expect(conflictsA.map((c) => c.id)).toEqual(['cA']);
    const healthA = await svc.health(T, CLIENT_A);
    expect(healthA.openMaterialConflicts.map((c) => c.id)).toEqual(['cA']);
  });
});

// ===========================================================================
// INVARIANT 3 — duplicate-after-retry: retries never double-write
// ===========================================================================

describe('agent-safety: duplicate-after-retry', () => {
  it('re-running execute for the same run+node+kind stages NO second sp_node_artifact', async () => {
    const store = makeStore();
    seedExecStrategy(store);
    seedMission(store);
    seedNode(store, { id: NID, status: 'suggested' });
    const { svc, createWorkspaceDraft } = makeExecEnv(store);

    const planned = await svc.plan(T, U, 'bearer-x', wsPlan());
    await svc.execute(T, U, 'bearer-x', planned.id);
    expect(createWorkspaceDraft).toHaveBeenCalledTimes(1);
    expect(store.artifacts.size).toBe(1);

    // Adversarial re-entry (crash-recovery replays execute from 'executing').
    store.runs.get(planned.id)!.state = 'executing';
    const again = await svc.execute(T, U, 'bearer-x', planned.id);

    // The existing back-link short-circuits the external create — no duplicate.
    expect(createWorkspaceDraft).toHaveBeenCalledTimes(1);
    expect(store.artifacts.size).toBe(1);
    expect(again.state).toBe('completed');
  });

  it('re-createRun with the same idempotencyKey yields exactly ONE run row (no second create/audit)', async () => {
    const store = makeStore();
    seedExecStrategy(store);
    seedMission(store);
    const { runs } = makeExecEnv(store);

    const first = await runs.createRun(T, U, MID, {
      trigger: 'manual',
      idempotencyKey: 'retry-1',
    } as CreateRunDto);
    const replay = await runs.createRun(T, U, MID, {
      trigger: 'manual',
      idempotencyKey: 'retry-1',
    } as CreateRunDto);

    expect(replay.id).toBe(first.id);
    expect(store.runs.size).toBe(1);
    expect(store.activity.filter((a) => a.action === 'run.created')).toHaveLength(1);
    expect(store.outbox.filter((o) => o.type === 'run.created')).toHaveLength(1);
  });
});

// ===========================================================================
// INVARIANT 4 — stale-changeset-approval: a moved head applies NOTHING
// ===========================================================================

describe('agent-safety: stale-changeset-approval', () => {
  it('applying a change-set after the strategy head advanced past its pinned version is rejected stale and applies NOTHING', async () => {
    const store = makeStore();
    seedChangeSetStrategy(store);
    const { svc, applyEditSet } = makeChangeSetsEnv(store);

    const cs = (await svc.create(T, U, {
      strategyId: SID,
      summary: 'Tighten the plan',
      ops: [opA],
      risk: 'low',
    } as CreateChangeSetDto)) as Rec; // pins v1
    await svc.approve(T, U, cs.id, {} as never);

    // A newer version becomes head AFTER approval (someone edited the plan).
    store.versions.set('v2', {
      id: 'v2',
      tenantId: T,
      strategyId: SID,
      snapshot: { meta: {}, nodes: [] },
      authorKind: 'person',
      authorUserId: U,
      note: 'later edit',
      coalescible: false,
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
    });

    const err = await svc.apply(T, U, cs.id).catch((e: unknown) => e);

    expect((err as Error).constructor.name).toBe('ConflictException');
    expect((err as Error).message).toMatch(/regenerate/);
    // The pipeline was NEVER invoked — nothing applied — and the row is stale.
    expect(applyEditSet).not.toHaveBeenCalled();
    expect(store.changeSets.get(cs.id)!.status).toBe('stale');
  });
});

// ===========================================================================
// INVARIANT 5 — date/fiscal math: the federal FY-quarter mapping
// ===========================================================================

describe('agent-safety: date/fiscal math', () => {
  it('maps Oct–Dec to Q1 of the NEXT FY and the other quarters correctly, across a year boundary', () => {
    // Oct–Dec of calendar 2026 all belong to FY2027 Q1 (federal FY starts Oct 1).
    expect(fyQuarter(new Date('2026-10-01T00:00:00.000Z'))).toBe('FY2027 Q1');
    expect(fyQuarter(new Date('2026-11-15T00:00:00.000Z'))).toBe('FY2027 Q1');
    expect(fyQuarter(new Date('2026-12-31T00:00:00.000Z'))).toBe('FY2027 Q1');

    // Crossing the calendar-year boundary stays in FY2027 but advances to Q2.
    expect(fyQuarter(new Date('2027-01-01T00:00:00.000Z'))).toBe('FY2027 Q2');
    expect(fyQuarter(new Date('2027-03-31T00:00:00.000Z'))).toBe('FY2027 Q2');
    expect(fyQuarter(new Date('2027-04-01T00:00:00.000Z'))).toBe('FY2027 Q3');
    expect(fyQuarter(new Date('2027-06-30T00:00:00.000Z'))).toBe('FY2027 Q3');
    expect(fyQuarter(new Date('2027-07-01T00:00:00.000Z'))).toBe('FY2027 Q4');
    expect(fyQuarter(new Date('2027-09-30T00:00:00.000Z'))).toBe('FY2027 Q4');

    // The FY rolls over at the Oct boundary: Sep→Q4 of FY2027, next day Oct→Q1 of FY2028.
    expect(fyQuarter(new Date('2027-10-01T00:00:00.000Z'))).toBe('FY2028 Q1');
  });
});

// ===========================================================================
// INVARIANT 6 — send-approval invalidation (and the external-send kill)
// ===========================================================================

describe('agent-safety: send-approval invalidation', () => {
  const RUN_A = 'run-A';
  const RUN_B = 'run-B';
  const BASE: SendTokenInput = {
    message: 'Please advance the markup vote timeline with the chair.',
    recipients: ['staff.a@example.gov', 'staff.b@example.gov'],
    ask: 'Confirm the hearing date',
    windowStart: '2026-08-01T00:00:00.000Z',
    windowEnd: '2026-08-15T00:00:00.000Z',
  };

  it('a token minted for run A does not validate for run B (no standing/prior approval)', () => {
    const token = computeSendToken(BASE);
    expect(verifySendToken(BASE, token, RUN_A, RUN_A)).toEqual({ valid: true });
    const cross = verifySendToken(BASE, token, RUN_B, RUN_A);
    expect(cross.valid).toBe(false);
    expect(cross.reason).toMatch(/different run/i);
  });

  it('changing ANY hashed field (message / recipients / ask / window) invalidates the token', () => {
    const token = computeSendToken(BASE);
    const tamperings: SendTokenInput[] = [
      { ...BASE, message: 'Different message entirely.' },
      { ...BASE, recipients: [...BASE.recipients, 'attacker@x.gov'] },
      { ...BASE, ask: 'Confirm the vote count instead' },
      { ...BASE, windowStart: '2026-08-02T00:00:00.000Z' },
      { ...BASE, windowEnd: null },
    ];
    for (const tampered of tamperings) {
      const res = verifySendToken(tampered, token, RUN_A, RUN_A);
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/does not match/i);
    }
  });

  it('sendEnabled is false under the default env (the external-send kill)', () => {
    expect(sendEnabled({})).toBe(false);
    expect(sendEnabled(process.env)).toBe(false); // STRATEGY_EXECUTION_SEND_ENABLED is never 'true' in CI
    expect(sendEnabled({ STRATEGY_EXECUTION_SEND_ENABLED: 'false' })).toBe(false);
  });
});

// ===========================================================================
// INVARIANT 7 — run cancel/recovery: no resurrection, no un-recorded side effect
// ===========================================================================

describe('agent-safety: run cancel/recovery', () => {
  it('a canceled run cannot transition to executing (assertTransition refuses to resurrect a terminal run)', () => {
    // canceled is reachable from queued AND planning...
    expect(isLegalTransition('queued', 'canceled')).toBe(true);
    expect(isLegalTransition('planning', 'canceled')).toBe(true);
    // ...but it is terminal — no move out of it, least of all back to executing.
    expect(RUN_TERMINAL_STATES.has('canceled')).toBe(true);
    expect(isLegalTransition('canceled', 'executing')).toBe(false);
    expect(() => assertTransition('canceled', 'executing')).toThrow(/terminal/i);
  });

  it('a run that CRASHES mid-execute leaves a write-ahead reservation that DEDUPS the retry — never a duplicate external artifact', async () => {
    const store = makeStore();
    seedExecStrategy(store);
    seedMission(store);
    seedNode(store, { id: NID, status: 'suggested' });
    const { svc, createWorkspaceDraft } = makeExecEnv(store);

    const planned = await svc.plan(T, U, 'bearer-x', wsPlan());

    // Reserve-before-create ordering: the external create commits upstream but
    // the back-link finalize throws (DB blip). Exactly ONE external create fires;
    // only the PENDING reservation survives; the node is NOT advanced and the run
    // is left mid-execution ('executing') — never a dangling completion.
    store.failFinalize = true;
    await expect(svc.execute(T, U, 'bearer-x', planned.id)).rejects.toBeTruthy();
    expect(createWorkspaceDraft).toHaveBeenCalledTimes(1);
    const afterCrash = [...store.artifacts.values()];
    expect(afterCrash).toHaveLength(1);
    expect(afterCrash[0]!.artifactRef).toBe(PENDING_ARTIFACT_REF);
    expect(store.nodes.get(NID)!.status).toBe('suggested');
    expect(store.runs.get(planned.id)!.state).toBe('executing');

    // The retry FINDS the reservation and parks for reconciliation rather than
    // issuing a second external create — a crash dedups, never duplicates.
    store.failFinalize = false;
    const retried = await svc.execute(T, U, 'bearer-x', planned.id);
    expect(createWorkspaceDraft).toHaveBeenCalledTimes(1); // still exactly ONE
    expect(retried.state).toBe('waiting_for_input');
    expect(retried.waitingReason).toMatch(/reconcile/i);
    expect(store.artifacts.size).toBe(1);
    expect([...store.artifacts.values()][0]!.artifactRef).toBe(PENDING_ARTIFACT_REF);
  });
});
