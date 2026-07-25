import { describe, expect, it } from '@jest/globals';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ExecutionService } from './execution.service.js';
import { RunsService } from './runs.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import type { MeriService } from '../meri/meri.service.js';
import type { StewardService } from '../context/steward.service.js';
import type { StrategyFlagsService } from '../flags/strategy-flags.service.js';
import type { ExecutionArtifactClient } from './execution-artifact.client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ExecutionPlanDto } from './dto/agents.dto.js';

/*
 * P0-3: approval binds to the EXACT payload.
 *
 * The audited defect: a reviewer approved on the strength of a title, target and
 * action label, while the content behind it could change through regeneration,
 * fallback generation, a context refresh, a model retry, target re-resolution, a
 * template change or a user edit.
 *
 * approval-binding.spec.ts covers the hashing/verification rules exhaustively.
 * THIS spec covers the wiring: that the service records a reproducible approval,
 * re-verifies it before acting, persists invalidation, and BLOCKS execution until
 * reapproval — with the real RunsService + real VersioningService over a fake tx,
 * so lifecycle transitions and the activity trail run as in production.
 *
 * Invariant asserted throughout: NOTHING here sends. Every case holds with the
 * external send hard-disabled.
 */

interface Rec {
  [k: string]: unknown;
  id: string;
}

const T = 'tenant-1';
const U = 'user-1';
const SID = 'S1';
const NID = 'N1';
const MID = 'M1';

function daysFromToday(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function makeStore() {
  const missions = new Map<string, Rec>();
  const strategies = new Map<string, Rec>();
  const nodes = new Map<string, Rec>();
  const versions = new Map<string, Rec>();
  const runs = new Map<string, Rec>();
  const artifacts = new Map<string, Rec>();
  const clients = new Map<string, Rec>();
  const activity: Rec[] = [];
  let seq = 0;
  return {
    missions,
    strategies,
    nodes,
    versions,
    runs,
    artifacts,
    clients,
    activity,
    nextId: (p: string) => `${p}-${++seq}`,
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
    name: 'Execute the plan',
    state: 'active',
    createdByUserId: U,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
  });
}

function seedNode(store: Store, over: Partial<Rec> = {}): void {
  store.nodes.set(NID, {
    id: NID,
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
    targetRef: null,
    archivedAt: null,
    createdByUserId: U,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    ...over,
  });
}

/** Move the plan head forward — the "a teammate edited the strategy" event. */
function advanceHead(store: Store): void {
  store.versions.set('v2', {
    id: 'v2',
    tenantId: T,
    strategyId: SID,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  });
}

function makeTx(store: Store) {
  const queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (/FROM sp_agent_mission/.test(sql)) {
      const m = store.missions.get(values[0] as string);
      return m ? [{ id: m.id, state: m.state, strategyId: m.strategyId }] : [];
    }
    if (/FROM clients/.test(sql)) {
      const c = store.clients.get(values[0] as string);
      return c ? [{ name: c.name }] : [];
    }
    return [];
  };
  return {
    $queryRaw: queryRaw,
    $queryRawUnsafe: async () => [],
    $executeRaw: async () => 0,
    spAgentMission: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        store.missions.get(where.id) ?? null,
    },
    spAgentRun: {
      findFirst: async ({ where }: { where: { id?: string; idempotencyKey?: string } }) => {
        if (where.id) return store.runs.get(where.id) ?? null;
        return (
          [...store.runs.values()].find((r) => r.idempotencyKey === where.idempotencyKey) ?? null
        );
      },
      findMany: async () => [...store.runs.values()],
      count: async () => 0,
      create: async ({ data }: { data: Rec }) => {
        const id = store.nextId('run');
        const rec = { ...data, id, state: data.state ?? 'queued', attempt: data.attempt ?? 1 };
        store.runs.set(id, rec);
        return rec;
      },
      updateMany: async ({ where, data }: { where: { id: string; state?: string }; data: Rec }) => {
        const r = store.runs.get(where.id);
        if (!r) return { count: 0 };
        if (where.state !== undefined && r.state !== where.state) return { count: 0 };
        const next = { ...r };
        for (const [k, v] of Object.entries(data)) {
          if (k === 'findings' && v && typeof v === 'object' && !Array.isArray(v)) {
            next.findings = { ...(r.findings as object), ...(v as object) };
          } else {
            next[k] = v;
          }
        }
        store.runs.set(where.id, next);
        return { count: 1 };
      },
    },
    spStrategy: {
      findFirst: async ({ where, include }: { where: { id: string }; include?: Rec }) => {
        const s = store.strategies.get(where.id);
        if (!s) return null;
        if (!include?.nodes) return { ...s };
        const w = (include.nodes as { where?: { archivedAt?: unknown } })?.where;
        const nodes = [...store.nodes.values()]
          .filter((n) => n.strategyId === where.id)
          .filter((n) => (w?.archivedAt === null ? n.archivedAt == null : true));
        return { ...s, nodes };
      },
    },
    spNode: {
      findFirst: async ({ where }: { where: { id: string; archivedAt?: unknown } }) => {
        const n = store.nodes.get(where.id);
        if (!n) return null;
        if (where.archivedAt === null && n.archivedAt != null) return null;
        return { ...n };
      },
      update: async ({ where, data }: { where: { id: string }; data: Rec }) => {
        const n = store.nodes.get(where.id);
        if (n) store.nodes.set(where.id, { ...n, ...data });
        return n;
      },
    },
    spVersion: {
      findFirst: async () => {
        const rows = [...store.versions.values()].sort(
          (a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime(),
        );
        return rows[0] ?? null;
      },
    },
    spNodeArtifact: {
      findFirst: async ({ where }: { where: { nodeId: string; artifactType: string } }) =>
        [...store.artifacts.values()].find(
          (a) => a.nodeId === where.nodeId && a.artifactType === where.artifactType,
        ) ?? null,
      create: async ({ data }: { data: Rec }) => {
        const id = store.nextId('art');
        store.artifacts.set(id, { ...data, id });
        return { ...data, id };
      },
      deleteMany: async ({ where }: { where: Rec }) => {
        let count = 0;
        for (const [id, a] of [...store.artifacts]) {
          if (a.nodeId === where.nodeId && a.artifactType === where.artifactType) {
            if (where.artifactRef === undefined || a.artifactRef === where.artifactRef) {
              store.artifacts.delete(id);
              count += 1;
            }
          }
        }
        return { count };
      },
      upsert: async ({ create }: { create: Rec }) => {
        const id = store.nextId('art');
        store.artifacts.set(id, { ...create, id });
        return { ...create, id };
      },
    },
    spContextFact: { findMany: async () => [] },
    spActivityLog: {
      create: async ({ data }: { data: Rec }) => {
        store.activity.push({ ...data, id: store.nextId('act') });
      },
    },
    spEventOutbox: {
      create: async ({ data }: { data: Rec }) => ({ ...data, id: store.nextId('ob') }),
    },
  } as unknown as Parameters<Parameters<PrismaService['withTenantUser']>[2]>[0];
}

interface Conflict {
  id: string;
  factAId: string;
  factBId: string;
  factA: string;
  factB: string;
}

interface Opts {
  draft?: {
    title: string;
    model: string | null;
    sections: Array<{ heading: string; html: string }>;
  } | null;
  /**
   * MUTABLE by design: an open material conflict BLOCKS execution eligibility at
   * plan time (evaluateG0), so a conflict cannot be seeded up front and still
   * reach a staged run. Tests push into this array AFTER staging to model the real
   * scenario — a conflict opening under an already-staged payload.
   */
  conflicts?: Conflict[];
}

function makeService(store: Store, opts: Opts = {}) {
  const run = async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx(store));
  const prisma = {
    withTenantUser: async (_t: string, _u: string, fn: (tx: unknown) => Promise<unknown>) =>
      run(fn),
    withTenant: async (_t: string, fn: (tx: unknown) => Promise<unknown>) => run(fn),
  } as unknown as PrismaService;

  const versioning = new VersioningService();
  const runs = new RunsService(prisma, versioning);
  const meri = {
    grounding: async () => ({
      fiscal: { today: daysFromToday(0), fys: [], fyLabels: [], focalFy: 'FY27' },
      firmPhases: [],
      reference: { congress: [], ppbeLanes: [], ppbeCurrentPhases: [] },
    }),
    draftExecutionDocument: async () => opts.draft ?? null,
  } as unknown as MeriService;
  const steward = {
    health: async () => ({
      status: 'ok' as const,
      factCounts: { active: 0, superseded: 0, stale: 0, rejected: 0 },
      openConflicts: 0,
      openMaterialConflicts: opts.conflicts ?? [],
      staleDocs: [],
      missingRequired: [],
    }),
    factsForOrchestrator: async () => [],
  } as unknown as StewardService;
  const flags = { isAgenticFlagEnabled: async () => true } as unknown as StrategyFlagsService;
  const artifacts = {
    createWorkspaceDraft: async () => ({ ref: 'wsd-1' }),
    createOutreachRecord: async () => ({ ref: 'or-1' }),
  } as unknown as ExecutionArtifactClient;

  const svc = new ExecutionService(prisma, versioning, runs, meri, steward, flags, artifacts);
  return { svc, runs };
}

const wsPlan = () => ({ missionId: MID, nodeId: NID, kind: 'workspace' }) as ExecutionPlanDto;
const outreachPlan = () => ({ missionId: MID, nodeId: NID, kind: 'outreach' }) as ExecutionPlanDto;

/** A workspace run sitting at ready_for_review (a STAGE approval decision). */
async function reviewedPlan(store: Store, opts: Opts = {}) {
  seedStrategy(store);
  seedMission(store);
  seedNode(store);
  const made = makeService(store, opts);
  await made.svc.plan(T, U, 'bearer-x', wsPlan());
  const runId = [...store.runs.keys()][0]!;
  return { ...made, runId };
}

/** An outreach run staged and parked on the send gate (a SEND approval decision). */
async function stagedOutreach(store: Store, opts: Opts = {}) {
  seedStrategy(store);
  seedMission(store);
  seedNode(store, {
    subject: 'member',
    targetRef: {
      clientTargetId: 'ct-1',
      memberId: 'M-1',
      memberName: 'Rep. Jane Smith',
      party: 'D',
      state: 'CA',
      chamber: 'House',
    },
  });
  const made = makeService(store, opts);
  await made.svc.plan(T, U, 'bearer-x', outreachPlan());
  const runId = [...store.runs.keys()][0]!;
  await made.svc.execute(T, U, 'bearer-x', runId);
  return { ...made, runId };
}

describe('approvalStatus — the approval screen is server-derived (P0-3)', () => {
  it('reports a SEND decision with the exact recipient, not the subject category', async () => {
    const store = makeStore();
    const { svc, runId } = await stagedOutreach(store);

    const status = await svc.approvalStatus(T, runId);

    expect(status.action).toBe('send');
    expect(status.effect).toBe('sends externally');
    expect(status.binding.recipients).toHaveLength(1);
    expect(status.binding.recipients[0]!.name).toContain('Rep. Jane Smith');
    expect(status.binding.recipients[0]!.id).toBe('ct-1');
    expect(status.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(status.approval).toBeNull();
    expect(status.approvalValid).toBe(false);
  });

  it('reports a STAGE decision for a reviewed plan', async () => {
    const store = makeStore();
    const { svc, runId } = await reviewedPlan(store);
    const status = await svc.approvalStatus(T, runId);
    expect(status.action).toBe('stage');
    expect(status.effect).toBe('stages internally');
  });

  it('ALWAYS reports sendEnabled false — the Stage-G hard boundary', async () => {
    const store = makeStore();
    const { svc, runId } = await stagedOutreach(store);
    const status = await svc.approvalStatus(T, runId);
    expect(status.sendEnabled).toBe(false);
    expect(status.binding.sendEnabled).toBe(false);
  });

  it('flags FALLBACK content when generation produced no prose', async () => {
    const store = makeStore();
    const { svc, runId } = await stagedOutreach(store, { draft: null });
    const status = await svc.approvalStatus(T, runId);
    expect(status.warnings.fallbackContent).toBe(true);
    expect(status.binding.grounded).toBe(false);
  });

  it('does NOT flag fallback for grounded prose, and binds the model', async () => {
    const store = makeStore();
    const { svc, runId } = await stagedOutreach(store, {
      draft: {
        title: 'Co-sign the FY27 request',
        model: 'claude-sonnet-5',
        sections: [{ heading: 'Ask', html: '<p>Please co-sign.</p>' }],
      },
    });
    const status = await svc.approvalStatus(T, runId);
    expect(status.warnings.fallbackContent).toBe(false);
    expect(status.binding.grounded).toBe(true);
    expect(status.binding.model).toBe('claude-sonnet-5');
    expect(status.binding.body.length).toBeGreaterThan(0);
  });

  it('carries the grounding + conflict disclosures for a conflict opened AFTER staging', async () => {
    const store = makeStore();
    // Seeded empty so the run can actually stage (an open material conflict is an
    // execution-eligibility BLOCKER at plan time), then introduced afterwards.
    const conflicts: Conflict[] = [];
    const { svc, runId } = await stagedOutreach(store, { conflicts });

    conflicts.push({
      id: 'cf-1',
      factAId: 'f1',
      factBId: 'f2',
      factA: 'A says x',
      factB: 'B says y',
    });
    const status = await svc.approvalStatus(T, runId);

    expect(status.warnings.groundingStatus).toBe('ok');
    expect(status.warnings.openMaterialConflicts).toHaveLength(1);
    expect(status.warnings.openMaterialConflicts[0]!.id).toBe('cf-1');
  });

  it('a conflict opening after APPROVAL invalidates it (the context-pack is bound)', async () => {
    const store = makeStore();
    const conflicts: Conflict[] = [];
    const { svc, runId } = await stagedOutreach(store, { conflicts });
    const before = await svc.approvalStatus(T, runId);
    await svc.approve(T, U, runId, { contentHash: before.contentHash });
    expect((await svc.approvalStatus(T, runId)).approvalValid).toBe(true);

    conflicts.push({
      id: 'cf-1',
      factAId: 'f1',
      factBId: 'f2',
      factA: 'A says x',
      factB: 'B says y',
    });

    const after = await svc.approvalStatus(T, runId);
    expect(after.approvalValid).toBe(false);
    expect(after.changedFields).toContain('contextPackFingerprint');
  });
});

describe('approve — binds the exact payload (P0-3)', () => {
  it('records approver, timestamp and the FULL reproducible payload', async () => {
    const store = makeStore();
    const { svc, runId } = await stagedOutreach(store);
    const before = await svc.approvalStatus(T, runId);

    const after = await svc.approve(T, U, runId, { contentHash: before.contentHash });

    expect(after.approval).not.toBeNull();
    expect(after.approval!.approvedByUserId).toBe(U);
    expect(after.approval!.status).toBe('approved');
    expect(after.approval!.contentHash).toBe(before.contentHash);
    expect(after.approval!.binding.body).toBe(before.binding.body);
    expect(after.approval!.binding.recipients).toEqual(before.binding.recipients);
    expect(after.approvalValid).toBe(true);
  });

  it('writes the full approved payload into the activity trail', async () => {
    const store = makeStore();
    const { svc, runId } = await stagedOutreach(store);
    const status = await svc.approvalStatus(T, runId);

    await svc.approve(T, U, runId, { contentHash: status.contentHash });

    const row = store.activity.find((a) => a.action === 'execution.approval_granted');
    expect(row).toBeDefined();
    const after = row!.after as Record<string, unknown>;
    expect(after.contentHash).toBe(status.contentHash);
    expect((after.binding as Record<string, unknown>).body).toBe(status.binding.body);
    expect(after.sendEnabled).toBe(false);
  });

  it('409s when the presented hash does not match the live payload', async () => {
    const store = makeStore();
    const { svc, runId } = await stagedOutreach(store);

    await expect(svc.approve(T, U, runId, { contentHash: 'f'.repeat(64) })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect((await svc.approvalStatus(T, runId)).approval).toBeNull();
  });

  it('400s without a contentHash — approving unseen content IS the defect', async () => {
    const store = makeStore();
    const { svc, runId } = await stagedOutreach(store);
    await expect(svc.approve(T, U, runId, { contentHash: '' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('mirrors the approved hash onto the send preview for the changed-since-review badge', async () => {
    const store = makeStore();
    const { svc, runId } = await stagedOutreach(store);
    const status = await svc.approvalStatus(T, runId);

    await svc.approve(T, U, runId, { contentHash: status.contentHash });

    const findings = store.runs.get(runId)!.findings as Record<string, unknown>;
    const sa = findings.sendApproval as Record<string, unknown>;
    expect(sa.approvedContentHash).toBe(status.contentHash);
    expect(sa.status).toBe('approved');
    expect(sa.contentHash).toBe(status.contentHash);
  });

  it('approving a SEND does NOT move the run out of its park — nothing is transmitted', async () => {
    const store = makeStore();
    const { svc, runId } = await stagedOutreach(store);
    const status = await svc.approvalStatus(T, runId);

    await svc.approve(T, U, runId, { contentHash: status.contentHash });

    expect(store.runs.get(runId)!.state).toBe('waiting_for_input');
  });

  it('approving a reviewed PLAN drives ready_for_review -> approved (the P0-2 state)', async () => {
    const store = makeStore();
    const { svc, runId } = await reviewedPlan(store);
    expect(store.runs.get(runId)!.state).toBe('ready_for_review');

    const status = await svc.approvalStatus(T, runId);
    await svc.approve(T, U, runId, { contentHash: status.contentHash });

    expect(store.runs.get(runId)!.state).toBe('approved');
  });

  it('an approved plan still executes — an approval never blocks its own run', async () => {
    const store = makeStore();
    const { svc, runId } = await reviewedPlan(store);
    const status = await svc.approvalStatus(T, runId);
    await svc.approve(T, U, runId, { contentHash: status.contentHash });

    await svc.execute(T, U, 'bearer-x', runId);

    expect(store.runs.get(runId)!.state).toBe('completed');
    expect([...store.artifacts.values()]).toHaveLength(1);
  });
});

describe('invalidation blocks execution until reapproval (P0-3 acceptance)', () => {
  it('a moved plan head after approval PARKS the run and stages nothing', async () => {
    const store = makeStore();
    const { svc, runId } = await reviewedPlan(store);
    const status = await svc.approvalStatus(T, runId);
    await svc.approve(T, U, runId, { contentHash: status.contentHash });

    advanceHead(store);
    await svc.execute(T, U, 'bearer-x', runId);

    const run = store.runs.get(runId)!;
    expect(run.state).toBe('waiting_for_input');
    expect(String(run.waitingReason)).toMatch(/approval no longer valid/i);
    expect(String(run.waitingReason)).toMatch(/plan version changed/i);
    expect([...store.artifacts.values()]).toHaveLength(0);
  });

  it('persists the invalidation with the fields that moved, and audits it', async () => {
    const store = makeStore();
    const { svc, runId } = await reviewedPlan(store);
    const status = await svc.approvalStatus(T, runId);
    await svc.approve(T, U, runId, { contentHash: status.contentHash });

    advanceHead(store);
    await svc.execute(T, U, 'bearer-x', runId);

    const findings = store.runs.get(runId)!.findings as Record<string, unknown>;
    const approval = findings.approval as Record<string, unknown>;
    expect(approval.status).toBe('invalidated');
    expect(approval.changedFields).toEqual(['strategyVersionId']);
    // The ORIGINAL approved payload survives — history is not rewritten.
    expect((approval.binding as Record<string, unknown>).nodeId).toBe(NID);
    expect(store.activity.some((a) => a.action === 'execution.approval_invalidated')).toBe(true);
  });

  it('the approval screen reports it invalid with a changed-since-review flag', async () => {
    const store = makeStore();
    const { svc, runId } = await reviewedPlan(store);
    const s1 = await svc.approvalStatus(T, runId);
    await svc.approve(T, U, runId, { contentHash: s1.contentHash });

    advanceHead(store);
    const s2 = await svc.approvalStatus(T, runId);

    expect(s2.approvalValid).toBe(false);
    expect(s2.warnings.changedSinceReview).toBe(true);
    expect(s2.changedFields).toContain('strategyVersionId');
    expect(s2.approvalInvalidReason).toMatch(/plan version changed/i);
  });

  it('a run with NO approval is not blocked — non-breaking for the existing flow', async () => {
    const store = makeStore();
    const { svc, runId } = await reviewedPlan(store);

    await svc.execute(T, U, 'bearer-x', runId);

    expect(store.runs.get(runId)!.state).toBe('completed');
  });

  it('re-approving against the CURRENT payload unblocks execution', async () => {
    const store = makeStore();
    const { svc, runId } = await reviewedPlan(store);
    const s1 = await svc.approvalStatus(T, runId);
    await svc.approve(T, U, runId, { contentHash: s1.contentHash });
    advanceHead(store);
    await svc.execute(T, U, 'bearer-x', runId); // parks: approval invalid

    const s2 = await svc.approvalStatus(T, runId);
    await svc.approve(T, U, runId, { contentHash: s2.contentHash });
    await svc.resume(T, U, 'bearer-x', runId);

    expect(store.runs.get(runId)!.state).toBe('completed');
    expect([...store.artifacts.values()]).toHaveLength(1);
  });
});

describe('rejectApproval (P0-3)', () => {
  it('invalidates the approval, records who and why, and audits it', async () => {
    const store = makeStore();
    const { svc, runId } = await stagedOutreach(store);
    const status = await svc.approvalStatus(T, runId);
    await svc.approve(T, U, runId, { contentHash: status.contentHash });

    await svc.rejectApproval(T, U, runId, 'recipient list looks wrong');

    const findings = store.runs.get(runId)!.findings as Record<string, unknown>;
    expect((findings.approval as Record<string, unknown>).status).toBe('invalidated');
    expect((findings.approvalRejection as Record<string, unknown>).reason).toBe(
      'recipient list looks wrong',
    );
    expect((findings.sendApproval as Record<string, unknown>).approvedContentHash).toBeNull();
    expect(store.activity.some((a) => a.action === 'execution.approval_rejected')).toBe(true);
  });

  it('records a plain refusal when there was no prior approval', async () => {
    const store = makeStore();
    const { svc, runId } = await stagedOutreach(store);

    await svc.rejectApproval(T, U, runId);

    const findings = store.runs.get(runId)!.findings as Record<string, unknown>;
    expect((findings.approvalRejection as Record<string, unknown>).reason).toBe(
      'rejected by a reviewer',
    );
  });

  it('a rejected approval never satisfies execution again', async () => {
    const store = makeStore();
    const { svc, runId } = await reviewedPlan(store);
    const status = await svc.approvalStatus(T, runId);
    await svc.approve(T, U, runId, { contentHash: status.contentHash });
    await svc.rejectApproval(T, U, runId, 'no');

    await svc.execute(T, U, 'bearer-x', runId);

    const run = store.runs.get(runId)!;
    expect(run.state).toBe('waiting_for_input');
    expect(String(run.waitingReason)).toMatch(/approval no longer valid/i);
    expect([...store.artifacts.values()]).toHaveLength(0);
  });
});
