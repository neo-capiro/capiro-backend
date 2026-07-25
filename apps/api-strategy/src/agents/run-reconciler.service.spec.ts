import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RECONCILER_SWEEPABLE_STATES, RunReconcilerService } from './run-reconciler.service.js';
import { RUN_TERMINAL_STATES } from './run-state.js';
import { RunsService } from './runs.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import { PENDING_ARTIFACT_REF } from './artifact-ref.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/*
 * P0-2 reconciler I/O. The detection RULES are covered exhaustively in
 * run-recovery.spec.ts; this spec pins the service behaviour around them:
 *
 *  - a repairable run is actually transitioned, and the repair reason lands where
 *    the user will read it (waitingReason / error);
 *  - a run needing a human is NOT transitioned;
 *  - reconciliation NEVER creates or sends anything;
 *  - the attempt counter only burns on a real repair (so a clean run is not
 *    counted toward the escalation cap), which is what stops a sweep loop;
 *  - the reservation resolution (adopt / release) is exact and guarded;
 *  - the sweep is dark by default and isolates a poisoned run.
 */

interface Rec {
  [k: string]: unknown;
  id: string;
}

const T = 'tenant-1';
const U = 'user-1';

function makeStore() {
  const runs = new Map<string, Rec>();
  const artifacts = new Map<string, Rec>();
  const nodes = new Map<string, Rec>();
  const versions = new Map<string, Rec>();
  const activity: Rec[] = [];
  let seq = 0;
  return { runs, artifacts, nodes, versions, activity, nextId: () => `id-${++seq}` };
}
type Store = ReturnType<typeof makeStore>;

const MINUTE = 60_000;

function seedRun(store: Store, over: Partial<Rec> = {}): Rec {
  const run: Rec = {
    id: 'r1',
    tenantId: T,
    missionId: 'M1',
    strategyId: 'S1',
    state: 'executing',
    trigger: 'manual',
    idempotencyKey: 'exec:N1:workspace',
    startedAt: new Date(Date.now() - 60 * MINUTE),
    finishedAt: null,
    heartbeatAt: new Date(Date.now() - 60 * MINUTE),
    createdAt: new Date(Date.now() - 60 * MINUTE),
    findings: { execution: { kind: 'workspace', nodeId: 'N1', strategyId: 'S1', missionId: 'M1' } },
    waitingReason: null,
    error: null,
    reconciledAt: null,
    reconcileAttempts: 0,
    attempt: 1,
    retryOfRunId: null,
    supersededByRunId: null,
    createdByUserId: U,
    ...over,
  };
  store.runs.set(run.id, run);
  return run;
}

function seedNode(store: Store, over: Partial<Rec> = {}): void {
  store.nodes.set('N1', {
    id: 'N1',
    tenantId: T,
    strategyId: 'S1',
    title: 'Draft the paper',
    targetRef: { memberId: 'M-1' },
    archivedAt: null,
    ...over,
  });
}

function seedArtifact(store: Store, artifactRef: string, over: Partial<Rec> = {}): void {
  const id = store.nextId();
  store.artifacts.set(id, {
    id,
    tenantId: T,
    strategyId: 'S1',
    nodeId: 'N1',
    artifactType: 'workspace_draft',
    artifactRef,
    detachedAt: null,
    createdByUserId: U,
    createdAt: new Date(),
    ...over,
  });
}

function seedVersion(store: Store, id = 'v-head'): void {
  store.versions.set(id, {
    id,
    tenantId: T,
    strategyId: 'S1',
    createdAt: new Date(),
  });
}

function matchesIn(value: unknown, pred: unknown): boolean {
  if (pred === undefined) return true;
  if (pred !== null && typeof pred === 'object' && 'in' in (pred as Record<string, unknown>)) {
    return (((pred as { in: unknown[] }).in ?? []) as unknown[]).includes(value);
  }
  if (pred !== null && typeof pred === 'object' && 'not' in (pred as Record<string, unknown>)) {
    return value !== (pred as { not: unknown }).not;
  }
  if (
    pred !== null &&
    typeof pred === 'object' &&
    'startsWith' in (pred as Record<string, unknown>)
  ) {
    return String(value).startsWith(String((pred as { startsWith: string }).startsWith));
  }
  return value === pred;
}

function makeTx(store: Store) {
  return {
    spAgentRun: {
      findFirst: async ({ where }: { where: { id?: string } }) => {
        const r = where.id ? store.runs.get(where.id) : [...store.runs.values()][0];
        return r ? { ...r } : null;
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        [...store.runs.values()]
          .filter((r) => matchesIn(r.state, where.state))
          .filter((r) => matchesIn(r.idempotencyKey, where.idempotencyKey))
          .map((r) => ({ ...r })),
      updateMany: async ({ where, data }: { where: { id: string }; data: Rec }) => {
        const r = store.runs.get(where.id);
        if (!r) return { count: 0 };
        const next = { ...r };
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && 'increment' in (v as Record<string, unknown>)) {
            next[k] = (Number(r[k]) || 0) + Number((v as { increment: number }).increment);
          } else {
            next[k] = v;
          }
        }
        store.runs.set(where.id, next);
        return { count: 1 };
      },
    },
    spNodeArtifact: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        [...store.artifacts.values()]
          .filter((a) => matchesIn(a.nodeId, where.nodeId))
          .filter((a) => matchesIn(a.strategyId, where.strategyId))
          .filter((a) => matchesIn(a.artifactRef, where.artifactRef))
          .map((a) => ({ ...a })),
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        let count = 0;
        for (const [id, a] of [...store.artifacts]) {
          if (
            matchesIn(a.nodeId, where.nodeId) &&
            matchesIn(a.artifactType, where.artifactType) &&
            matchesIn(a.artifactRef, where.artifactRef)
          ) {
            store.artifacts.delete(id);
            count += 1;
          }
        }
        return { count };
      },
      upsert: async ({ create }: { create: Rec }) => {
        const id = store.nextId();
        store.artifacts.set(id, { ...create, id });
        return { ...create, id };
      },
    },
    spNode: {
      findFirst: async ({ where }: { where: { id: string; archivedAt?: unknown } }) => {
        const n = store.nodes.get(where.id);
        if (!n) return null;
        if (where.archivedAt === null && n.archivedAt != null) return null;
        return { ...n };
      },
    },
    spVersion: {
      findFirst: async () => {
        const v = [...store.versions.values()][0];
        return v ? { ...v } : null;
      },
    },
    spActivityLog: {
      create: async ({ data }: { data: Rec }) => {
        store.activity.push({ ...data, id: store.nextId() });
      },
    },
    spEventOutbox: { create: async ({ data }: { data: Rec }) => ({ ...data, id: store.nextId() }) },
  } as unknown as Parameters<Parameters<PrismaService['withTenantUser']>[2]>[0];
}

function makeService(store: Store) {
  const prisma = {
    withTenantUser: async (_t: string, _u: string, fn: (tx: unknown) => unknown) =>
      fn(makeTx(store)),
    withTenant: async (_t: string, fn: (tx: unknown) => unknown) => fn(makeTx(store)),
    withSystem: async (fn: (tx: unknown) => unknown) => fn(makeTx(store)),
  } as unknown as PrismaService;
  const versioning = new VersioningService();
  const runs = new RunsService(prisma, versioning);
  const svc = new RunReconcilerService(prisma, runs, versioning);
  return { svc, runs, prisma };
}

describe('RunReconcilerService.reconcileRun — repairs', () => {
  it('advances a stranded run whose artifact provably exists to `staged`', async () => {
    const store = makeStore();
    seedRun(store);
    seedNode(store);
    seedVersion(store);
    seedArtifact(store, 'ws-real-1');
    const { svc } = makeService(store);

    const out = await svc.reconcileRun(T, U, 'r1');

    expect(out.applied).toEqual({ to: 'staged', reason: expect.any(String) });
    expect(store.runs.get('r1')!.state).toBe('staged');
    expect(out.findings.map((f) => f.code)).toContain('ARTIFACT_NOT_ADVANCED');
  });

  it('fails a heartbeat-stale run to `failed_recoverable` and puts the reason where the user reads it', async () => {
    const store = makeStore();
    seedRun(store); // 60 min stale, no artifact
    seedNode(store);
    seedVersion(store);
    const { svc } = makeService(store);

    const out = await svc.reconcileRun(T, U, 'r1');

    expect(out.applied!.to).toBe('failed_recoverable');
    const run = store.runs.get('r1')!;
    expect(run.state).toBe('failed_recoverable');
    // The audit's "user-readable reason" — never a bare state.
    expect(String(run.error)).toMatch(/no agent progress/i);
  });

  it('terminally fails a run whose step was archived by a P0-1 restore', async () => {
    const store = makeStore();
    seedRun(store, { heartbeatAt: new Date() });
    seedNode(store, { archivedAt: new Date() });
    seedVersion(store);
    const { svc } = makeService(store);

    const out = await svc.reconcileRun(T, U, 'r1');

    expect(out.applied!.to).toBe('failed_terminal');
    expect(String(store.runs.get('r1')!.error)).toMatch(/no longer in the live plan/i);
  });

  it('applies at most ONE transition per pass', async () => {
    const store = makeStore();
    // Both stale AND node-archived: two auto findings, one repair.
    seedRun(store);
    seedNode(store, { archivedAt: new Date() });
    seedVersion(store);
    const { svc } = makeService(store);

    const out = await svc.reconcileRun(T, U, 'r1');

    expect(out.applied).not.toBeNull();
    // NODE_NOT_LIVE is ordered first, so that is the one applied.
    expect(out.applied!.to).toBe('failed_terminal');
  });

  it('records the reconciliation on the run findings and in the activity log', async () => {
    const store = makeStore();
    seedRun(store);
    seedNode(store);
    seedVersion(store);
    const { svc } = makeService(store);

    await svc.reconcileRun(T, U, 'r1');

    const run = store.runs.get('r1')!;
    const findings = run.findings as Record<string, unknown>;
    expect(findings.reconciliation).toMatchObject({ code: 'STRANDED_NO_HEARTBEAT' });
    // Execution intent is preserved by the shallow merge (never clobbered).
    expect(findings.execution).toBeDefined();
    expect(store.activity.some((a) => a.action === 'run.reconciled')).toBe(true);
  });
});

describe('RunReconcilerService.reconcileRun — escalation, not guessing', () => {
  it('does NOT transition a run whose only finding needs a human', async () => {
    const store = makeStore();
    seedRun(store, { heartbeatAt: new Date() }); // fresh, so not stranded
    seedNode(store);
    seedVersion(store);
    seedArtifact(store, PENDING_ARTIFACT_REF); // surviving reservation
    const { svc } = makeService(store);

    const out = await svc.reconcileRun(T, U, 'r1');

    expect(out.applied).toBeNull();
    expect(out.needsHuman).toBe(true);
    expect(out.findings.map((f) => f.code)).toContain('RESERVATION_WITHOUT_ARTIFACT');
    expect(store.runs.get('r1')!.state).toBe('executing'); // untouched
  });

  it('NEVER creates an artifact — reconciliation cannot stage anything', async () => {
    const store = makeStore();
    seedRun(store, { heartbeatAt: new Date() });
    seedNode(store);
    seedVersion(store);
    seedArtifact(store, PENDING_ARTIFACT_REF);
    const before = store.artifacts.size;
    const { svc } = makeService(store);

    await svc.reconcileRun(T, U, 'r1');

    expect(store.artifacts.size).toBe(before);
  });

  it('a clean pass does NOT burn an attempt (so it cannot exhaust the escalation budget)', async () => {
    const store = makeStore();
    seedRun(store, { state: 'ready_for_review', heartbeatAt: new Date() });
    seedNode(store);
    seedVersion(store);
    const { svc } = makeService(store);

    await svc.reconcileRun(T, U, 'r1');

    const run = store.runs.get('r1')!;
    expect(run.reconcileAttempts).toBe(0);
    // ...but we still record WHEN we looked.
    expect(run.reconciledAt).toBeInstanceOf(Date);
  });

  it('a real repair DOES burn an attempt', async () => {
    const store = makeStore();
    seedRun(store);
    seedNode(store);
    seedVersion(store);
    const { svc } = makeService(store);

    await svc.reconcileRun(T, U, 'r1');

    expect(store.runs.get('r1')!.reconcileAttempts).toBe(1);
  });

  it('stops repairing and escalates once the attempt budget is spent', async () => {
    const store = makeStore();
    seedRun(store, { reconcileAttempts: 3 });
    seedNode(store);
    seedVersion(store);
    const { svc } = makeService(store);

    const out = await svc.reconcileRun(T, U, 'r1');

    expect(out.applied).toBeNull();
    expect(out.needsHuman).toBe(true);
    expect(store.runs.get('r1')!.state).toBe('executing');
  });

  it('404s an unknown run', async () => {
    const { svc } = makeService(makeStore());
    await expect(svc.reconcileRun(T, U, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('RunReconcilerService.resolveReservation', () => {
  function reserved() {
    const store = makeStore();
    seedRun(store, { heartbeatAt: new Date() });
    seedNode(store);
    seedVersion(store);
    seedArtifact(store, PENDING_ARTIFACT_REF);
    return store;
  }

  it('adopt: retires the sentinel and links the real artifact', async () => {
    const store = reserved();
    const { svc } = makeService(store);

    await svc.resolveReservation(T, U, 'r1', { action: 'adopt', artifactRef: 'ws-found-1' });

    const refs = [...store.artifacts.values()].map((a) => a.artifactRef);
    expect(refs).toEqual(['ws-found-1']);
    expect(store.activity.some((a) => a.action === 'run.reservation_resolved')).toBe(true);
  });

  it('release: drops the sentinel so a retry can stage cleanly, linking nothing', async () => {
    const store = reserved();
    const { svc } = makeService(store);

    await svc.resolveReservation(T, U, 'r1', { action: 'release' });

    expect(store.artifacts.size).toBe(0);
  });

  it('after adopt, the next reconcile advances the run to staged', async () => {
    const store = reserved();
    const { svc } = makeService(store);

    await svc.resolveReservation(T, U, 'r1', { action: 'adopt', artifactRef: 'ws-found-1' });
    const out = await svc.reconcileRun(T, U, 'r1');

    expect(out.applied!.to).toBe('staged');
  });

  it('rejects adopt without a ref, and rejects the sentinel as a ref', async () => {
    const store = reserved();
    const { svc } = makeService(store);

    await expect(svc.resolveReservation(T, U, 'r1', { action: 'adopt' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      svc.resolveReservation(T, U, 'r1', { action: 'adopt', artifactRef: PENDING_ARTIFACT_REF }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Nothing was touched by either rejection.
    expect([...store.artifacts.values()][0]!.artifactRef).toBe(PENDING_ARTIFACT_REF);
  });

  it('rejects a run with no outstanding reservation', async () => {
    const store = makeStore();
    seedRun(store, { heartbeatAt: new Date() });
    seedNode(store);
    seedVersion(store);
    seedArtifact(store, 'ws-real-1'); // already fully staged
    const { svc } = makeService(store);

    await expect(svc.resolveReservation(T, U, 'r1', { action: 'release' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('RunReconcilerService — the sweep', () => {
  it('only ever looks at NON-terminal runs (a finished run needs no recovery)', () => {
    for (const state of RECONCILER_SWEEPABLE_STATES) {
      expect(RUN_TERMINAL_STATES.has(state)).toBe(false);
    }
    // The states that actually strand must all be in scope.
    for (const state of [
      'queued',
      'planning',
      'executing',
      'waiting_for_input',
      'failed_recoverable',
    ]) {
      expect(RECONCILER_SWEEPABLE_STATES).toContain(state);
    }
    // ...and no terminal state may be.
    for (const state of ['completed', 'failed', 'failed_terminal', 'canceled', 'superseded']) {
      expect(RECONCILER_SWEEPABLE_STATES).not.toContain(state);
    }
  });

  it('is DARK by default: no timer without both env switches', () => {
    const prev = { ...process.env };
    delete process.env.STRATEGY_AGENTS_ENABLED;
    delete process.env.STRATEGY_RUN_RECONCILER;
    const { svc } = makeService(makeStore());
    svc.onModuleInit();
    // No timer armed => destroy is a no-op and nothing throws.
    expect(() => svc.onModuleDestroy()).not.toThrow();
    process.env = prev;
  });

  it('does not arm with only the agentic kill-switch on', () => {
    const prev = { ...process.env };
    process.env.STRATEGY_AGENTS_ENABLED = 'true';
    delete process.env.STRATEGY_RUN_RECONCILER;
    const { svc } = makeService(makeStore());
    svc.onModuleInit();
    expect(() => svc.onModuleDestroy()).not.toThrow();
    process.env = prev;
  });

  it('reconciles the stale execution runs it finds', async () => {
    const store = makeStore();
    seedRun(store);
    seedNode(store);
    seedVersion(store);
    const { svc } = makeService(store);

    const result = await svc.tickOnce();

    expect(result.scanned).toBe(1);
    expect(result.repaired).toBe(1);
    expect(store.runs.get('r1')!.state).toBe('failed_recoverable');
  });

  it('isolates a poisoned run so one bad row cannot wedge the sweep', async () => {
    const store = makeStore();
    seedRun(store);
    seedNode(store);
    seedVersion(store);
    const { svc } = makeService(store);
    // Force the per-run path to throw.
    jest.spyOn(svc, 'reconcileRun').mockRejectedValueOnce(new Error('poisoned') as never);

    const result = await svc.tickOnce();

    expect(result.scanned).toBe(1);
    expect(result.repaired).toBe(0);
  });

  it('tick() swallows a sweep failure so the loop survives', async () => {
    const { svc } = makeService(makeStore());
    jest.spyOn(svc, 'tickOnce').mockRejectedValueOnce(new Error('boom') as never);
    await expect(svc.tick()).resolves.toBeUndefined();
  });
});
