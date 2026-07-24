import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { OutboxConsumerService, WATCH_TRIGGERING_TYPES } from './outbox-consumer.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/*
 * OutboxConsumerService against a fake withSystem + fake tx. The fake claim
 * implements the semantics of the atomic UPDATE ... FROM (SELECT ... FOR
 * UPDATE SKIP LOCKED): unconsumed rows are stamped consumedAt SYNCHRONOUSLY
 * and returned oldest-first, so a re-drain (or an overlapping pod) claims
 * nothing — consumedAt IS the idempotency marker.
 *
 * The harness records which tx methods run inside EACH withSystem call
 * (txOps) — that is the load-bearing assertion for the P2028 regression
 * suite below: the claim must be a single-statement tx that commits before
 * any resolution/bump work, because withSystem has no timeout option and an
 * interactive tx runs under Prisma's default 5s limit.
 */

const T = 'tenant-1';
const DAY = 86_400_000;

interface OutboxRec {
  id: string;
  tenantId: string;
  type: string;
  payload: Record<string, unknown> | null;
  createdAt: Date;
  consumedAt: Date | null;
}
interface NodeRec {
  id: string;
  tenantId: string;
  strategyId: string;
}
interface MissionRec {
  id: string;
  tenantId: string;
  strategyId: string | null;
  state: string;
  cadence: string | null;
  nextRunAt: Date | null;
}

function makeHarness(opts?: { failBumpFor?: string[] }) {
  const outbox: OutboxRec[] = [];
  const nodes: NodeRec[] = [];
  const missions: MissionRec[] = [];
  // strategyIds whose mission bump throws (simulates a poisoned target).
  const failBumpFor = new Set(opts?.failBumpFor ?? []);
  // txOps[i] = the tx methods invoked during the i-th withSystem call — lets
  // tests assert transaction BOUNDARIES, not just totals (see file header).
  const txOps: string[][] = [];
  let currentOps: string[] | null = null;

  const tx = {
    // The consumer's single raw statement: claim-and-stamp (see header).
    $queryRaw: async () => {
      currentOps?.push('$queryRaw');
      const claimable = outbox
        .filter((r) => r.consumedAt === null)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, 500);
      const now = new Date();
      return claimable.map((r) => {
        r.consumedAt = now;
        return { id: r.id, tenantId: r.tenantId, type: r.type, payload: r.payload };
      });
    },
    spNode: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        currentOps?.push('spNode.findMany');
        return nodes.filter((n) => where.id.in.includes(n.id));
      },
    },
    spAgentMission: {
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          tenantId: string;
          strategyId: string;
          state: string;
          cadence: { not: null };
          OR: Array<{ nextRunAt: null | { gt: Date } }>;
        };
        data: { nextRunAt: Date };
      }) => {
        currentOps?.push('spAgentMission.updateMany');
        if (failBumpFor.has(where.strategyId)) {
          throw new Error(`bump exploded for ${where.strategyId}`);
        }
        let count = 0;
        for (const m of missions) {
          if (m.tenantId !== where.tenantId || m.strategyId !== where.strategyId) continue;
          if (m.state !== where.state) continue;
          if (m.cadence === null) continue; // cadence: { not: null }
          const matchesOr = where.OR.some((clause) =>
            clause.nextRunAt === null
              ? m.nextRunAt === null
              : m.nextRunAt !== null && m.nextRunAt.getTime() > clause.nextRunAt.gt.getTime(),
          );
          if (!matchesOr) continue;
          m.nextRunAt = data.nextRunAt;
          count++;
        }
        return { count };
      },
    },
  };

  const withSystem = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => {
    const ops: string[] = [];
    txOps.push(ops);
    const prev = currentOps;
    currentOps = ops;
    try {
      return await fn(tx);
    } finally {
      currentOps = prev;
    }
  });
  const prisma = { withSystem } as unknown as PrismaService;
  const svc = new OutboxConsumerService(prisma);
  return { svc, outbox, nodes, missions, withSystem, txOps };
}

let seq = 0;
function event(over: Partial<OutboxRec> & { type: string }): OutboxRec {
  seq += 1;
  return {
    id: `evt-${seq}`,
    tenantId: T,
    payload: null,
    createdAt: new Date(Date.now() - 60_000 + seq), // stable oldest-first order
    consumedAt: null,
    ...over,
  };
}

const ENV_KEYS = [
  'STRATEGY_AGENTS_ENABLED',
  'STRATEGY_WATCHER_SCHEDULER',
  'STRATEGY_WATCHER_OUTBOX_MS',
] as const;
let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  jest.restoreAllMocks();
});

describe('OutboxConsumerService.drainOnce', () => {
  it('marks EVERY claimed row consumed (triggering or not) in one pass', async () => {
    const h = makeHarness();
    h.outbox.push(
      event({ type: 'node.updated', payload: { entityType: 'node', entityId: 'N1' } }),
      event({ type: 'mission.created', payload: { entityType: 'mission', entityId: 'M9' } }),
      event({ type: 'run.transitioned', payload: { entityType: 'run', entityId: 'R9' } }),
    );

    const res = await h.svc.drainOnce();

    expect(res.claimed).toBe(3);
    expect(res.triggering).toBe(1);
    expect(h.outbox.every((r) => r.consumedAt !== null)).toBe(true);
  });

  it('brings a cadence mission forward (nextRunAt = now) for a watch-triggering node event, resolving node -> strategy', async () => {
    const h = makeHarness();
    const start = new Date();
    h.nodes.push({ id: 'N1', tenantId: T, strategyId: 'S1' });
    h.missions.push({
      id: 'M1',
      tenantId: T,
      strategyId: 'S1',
      state: 'active',
      cadence: 'daily',
      nextRunAt: new Date(Date.now() + DAY), // tomorrow — must come forward
    });
    h.outbox.push(
      event({ type: 'node.updated', payload: { entityType: 'node', entityId: 'N1' } }),
    );

    const res = await h.svc.drainOnce();

    expect(res.missionsBumped).toBe(1);
    const m = h.missions[0]!;
    expect(m.nextRunAt!.getTime()).toBeGreaterThanOrEqual(start.getTime());
    expect(m.nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('resolves entityType=strategy events directly, and an explicit payload.strategyId wins', async () => {
    const h = makeHarness();
    h.missions.push(
      { id: 'M1', tenantId: T, strategyId: 'S1', state: 'active', cadence: 'daily', nextRunAt: new Date(Date.now() + DAY) },
      { id: 'M2', tenantId: T, strategyId: 'S2', state: 'active', cadence: 'weekly', nextRunAt: new Date(Date.now() + DAY) },
    );
    h.outbox.push(
      event({ type: 'version.restored', payload: { entityType: 'strategy', entityId: 'S1' } }),
      // A future emitter that sets strategyId explicitly (entityId is NOT a strategy).
      event({ type: 'steward.extracted', payload: { entityType: 'context_document', entityId: 'D1', strategyId: 'S2' } }),
    );

    const res = await h.svc.drainOnce();

    expect(res.missionsBumped).toBe(2);
    expect(h.missions[0]!.nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(h.missions[1]!.nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('node.deleted bumps via payload.strategyId even though the node row is already gone', async () => {
    const h = makeHarness();
    // NO h.nodes entry: NodeService.remove deletes the sp_node row in the SAME
    // tx that emits the event, so node -> strategy resolution can never work
    // for deletes — the emitter carries strategyId explicitly instead.
    h.missions.push({
      id: 'M1', tenantId: T, strategyId: 'S1', state: 'active', cadence: 'daily', nextRunAt: new Date(Date.now() + DAY),
    });
    h.outbox.push(
      event({
        type: 'node.deleted',
        payload: { entityType: 'node', entityId: 'N-gone', strategyId: 'S1' },
      }),
    );

    const res = await h.svc.drainOnce();

    expect(res).toEqual({ claimed: 1, triggering: 1, missionsBumped: 1 });
    expect(h.missions[0]!.nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('activates a cadence mission that was never scheduled (nextRunAt null => now)', async () => {
    const h = makeHarness();
    h.missions.push({
      id: 'M1', tenantId: T, strategyId: 'S1', state: 'active', cadence: 'daily', nextRunAt: null,
    });
    h.outbox.push(
      event({ type: 'strategy.assisted', payload: { entityType: 'strategy', entityId: 'S1' } }),
    );

    const res = await h.svc.drainOnce();

    expect(res.missionsBumped).toBe(1);
    expect(h.missions[0]!.nextRunAt).not.toBeNull();
  });

  it('ignores non-triggering types: consumed, but no mission is touched', async () => {
    const h = makeHarness();
    const later = new Date(Date.now() + DAY);
    h.missions.push({
      id: 'M1', tenantId: T, strategyId: 'S1', state: 'active', cadence: 'daily', nextRunAt: later,
    });
    // Bookkeeping actions — including the watcher's own writes (no feedback loop).
    h.outbox.push(
      event({ type: 'mission.created', payload: { entityType: 'mission', entityId: 'M1' } }),
      event({ type: 'changeset.proposed', payload: { entityType: 'change_set', entityId: 'CS1', strategyId: 'S1' } }),
      event({ type: 'run.created', payload: { entityType: 'run', entityId: 'R1' } }),
    );

    const res = await h.svc.drainOnce();

    expect(res).toEqual({ claimed: 3, triggering: 0, missionsBumped: 0 });
    expect(h.missions[0]!.nextRunAt).toEqual(later);
    expect(h.outbox.every((r) => r.consumedAt !== null)).toBe(true);
  });

  it('never touches manual-only (cadence null) or non-active missions, and never moves an already-due mission', async () => {
    const h = makeHarness();
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + DAY);
    h.missions.push(
      { id: 'M1', tenantId: T, strategyId: 'S1', state: 'active', cadence: null, nextRunAt: future }, // manual-only
      { id: 'M2', tenantId: T, strategyId: 'S1', state: 'paused', cadence: 'daily', nextRunAt: future }, // not active
      { id: 'M3', tenantId: T, strategyId: 'S1', state: 'active', cadence: 'daily', nextRunAt: past }, // already due
    );
    h.outbox.push(
      event({ type: 'node.deleted', payload: { entityType: 'strategy', entityId: 'S1' } }),
    );

    const res = await h.svc.drainOnce();

    expect(res.missionsBumped).toBe(0);
    expect(h.missions[0]!.nextRunAt).toEqual(future);
    expect(h.missions[1]!.nextRunAt).toEqual(future);
    expect(h.missions[2]!.nextRunAt).toEqual(past); // forward-only: leave due missions alone
  });

  it('does not let a cross-tenant payload bump another tenant\'s missions (node resolution pins the tenant)', async () => {
    const h = makeHarness();
    const future = new Date(Date.now() + DAY);
    // The node belongs to tenant-2, but the (hypothetically confused/forged)
    // event claims tenant-1.
    h.nodes.push({ id: 'N1', tenantId: 'tenant-2', strategyId: 'S2' });
    h.missions.push({
      id: 'M1', tenantId: 'tenant-2', strategyId: 'S2', state: 'active', cadence: 'daily', nextRunAt: future,
    });
    h.outbox.push(
      event({ type: 'node.updated', tenantId: T, payload: { entityType: 'node', entityId: 'N1' } }),
    );

    const res = await h.svc.drainOnce();

    expect(res.missionsBumped).toBe(0);
    expect(h.missions[0]!.nextRunAt).toEqual(future);
  });

  it('is idempotent: a re-drain claims nothing and changes nothing', async () => {
    const h = makeHarness();
    h.nodes.push({ id: 'N1', tenantId: T, strategyId: 'S1' });
    h.missions.push({
      id: 'M1', tenantId: T, strategyId: 'S1', state: 'active', cadence: 'daily', nextRunAt: new Date(Date.now() + DAY),
    });
    h.outbox.push(
      event({ type: 'node.updated', payload: { entityType: 'node', entityId: 'N1' } }),
    );

    const first = await h.svc.drainOnce();
    expect(first).toEqual({ claimed: 1, triggering: 1, missionsBumped: 1 });
    const afterFirst = h.missions[0]!.nextRunAt;

    const second = await h.svc.drainOnce();
    expect(second).toEqual({ claimed: 0, triggering: 0, missionsBumped: 0 });
    expect(h.missions[0]!.nextRunAt).toEqual(afterFirst);
  });

  it('exports the watch-triggering action set (documents the meeting-completion seam by omission)', () => {
    for (const t of [
      'node.created', 'node.updated', 'node.deleted',
      'strategy.assisted', 'version.restored', 'reference.forked', 'steward.extracted',
    ]) {
      expect(WATCH_TRIGGERING_TYPES.has(t)).toBe(true);
    }
    // Deferred: meetings association. Added HERE when it lands — nothing else.
    expect(WATCH_TRIGGERING_TYPES.has('meeting.completed')).toBe(false);
  });
});

describe('OutboxConsumerService — claim-tx isolation (P2028 regression)', () => {
  // withSystem exposes no timeout option, so every interactive tx runs under
  // Prisma's default 5s limit. The claim must therefore be a SINGLE-STATEMENT
  // tx that commits before any resolution/bump work (the scheduler's shape) —
  // otherwise a big batch times out, rolls back consumption, and the SAME
  // oversized batch is re-claimed identically every interval, forever.

  it('runs the claim as its own single-statement tx; node resolution and each mission bump get separate transactions', async () => {
    const h = makeHarness();
    h.nodes.push({ id: 'N1', tenantId: T, strategyId: 'S1' });
    h.missions.push(
      { id: 'M1', tenantId: T, strategyId: 'S1', state: 'active', cadence: 'daily', nextRunAt: new Date(Date.now() + DAY) },
      { id: 'M2', tenantId: T, strategyId: 'S2', state: 'active', cadence: 'daily', nextRunAt: new Date(Date.now() + DAY) },
    );
    h.outbox.push(
      event({ type: 'node.updated', payload: { entityType: 'node', entityId: 'N1' } }),
      event({ type: 'version.restored', payload: { entityType: 'strategy', entityId: 'S2' } }),
    );

    const res = await h.svc.drainOnce();
    expect(res).toEqual({ claimed: 2, triggering: 2, missionsBumped: 2 });

    // Tx boundaries: claim alone, then the node lookup alone, then ONE
    // updateMany per target — no tx ever grows with the batch.
    expect(h.txOps).toEqual([
      ['$queryRaw'],
      ['spNode.findMany'],
      ['spAgentMission.updateMany'],
      ['spAgentMission.updateMany'],
    ]);
  });

  it('an empty drain opens only the claim tx', async () => {
    const h = makeHarness();
    const res = await h.svc.drainOnce();
    expect(res).toEqual({ claimed: 0, triggering: 0, missionsBumped: 0 });
    expect(h.txOps).toEqual([['$queryRaw']]);
  });

  it('a poisoned bump neither un-consumes the batch nor starves other targets — the batch is NOT re-claimed forever', async () => {
    const h = makeHarness({ failBumpFor: ['S-poison'] });
    const future = new Date(Date.now() + DAY);
    h.missions.push(
      { id: 'M1', tenantId: T, strategyId: 'S-poison', state: 'active', cadence: 'daily', nextRunAt: future },
      { id: 'M2', tenantId: T, strategyId: 'S-ok', state: 'active', cadence: 'daily', nextRunAt: future },
    );
    h.outbox.push(
      // Poisoned target FIRST: the healthy one after it must still bump.
      event({ type: 'version.restored', payload: { entityType: 'strategy', entityId: 'S-poison' } }),
      event({ type: 'node.updated', payload: { entityType: 'strategy', entityId: 'S-ok' } }),
    );

    // Must resolve, not throw: the failure is isolated per target.
    const res = await h.svc.drainOnce();

    expect(res.claimed).toBe(2);
    expect(res.missionsBumped).toBe(1); // S-ok bumped despite S-poison
    expect(h.missions[1]!.nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(h.missions[0]!.nextRunAt).toEqual(future); // poisoned target untouched (cadence covers it)
    // The claim COMMITTED: every row stays consumed, so the next drain
    // re-claims nothing (no eternal identical re-claim loop).
    expect(h.outbox.every((r) => r.consumedAt !== null)).toBe(true);
    const second = await h.svc.drainOnce();
    expect(second).toEqual({ claimed: 0, triggering: 0, missionsBumped: 0 });
  });

  it('a failed node resolution still keeps the batch consumed and bumps the strategy-direct targets', async () => {
    const h = makeHarness();
    const future = new Date(Date.now() + DAY);
    h.missions.push(
      { id: 'M1', tenantId: T, strategyId: 'S-direct', state: 'active', cadence: 'daily', nextRunAt: future },
    );
    h.outbox.push(
      event({ type: 'version.restored', payload: { entityType: 'strategy', entityId: 'S-direct' } }),
      event({ type: 'node.updated', payload: { entityType: 'node', entityId: 'N1' } }),
    );
    // Force the node lookup to throw: fail the SECOND withSystem call (tx #1
    // is the claim, tx #2 is spNode.findMany — see the tx-boundary test).
    const original = h.withSystem.getMockImplementation()!;
    let call = 0;
    h.withSystem.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => {
      call += 1;
      if (call === 2) throw new Error('node lookup exploded'); // tx #2 = spNode.findMany
      return original(fn);
    });

    const res = await h.svc.drainOnce();

    expect(res.claimed).toBe(2);
    expect(res.missionsBumped).toBe(1); // strategy-direct target still bumped
    expect(h.outbox.every((r) => r.consumedAt !== null)).toBe(true); // claim already committed
  });
});

describe('OutboxConsumerService — env gates (dark by default)', () => {
  const fakeTimer = () => ({ unref: jest.fn() }) as unknown as ReturnType<typeof setInterval>;

  it('does NOT arm the timer unless BOTH switches are on', () => {
    const spy = jest.spyOn(globalThis, 'setInterval').mockReturnValue(fakeTimer());
    const h = makeHarness();
    h.svc.onModuleInit();
    process.env.STRATEGY_AGENTS_ENABLED = 'true';
    h.svc.onModuleInit();
    delete process.env.STRATEGY_AGENTS_ENABLED;
    process.env.STRATEGY_WATCHER_SCHEDULER = 'true';
    h.svc.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
  });

  it('arms at the default 30s when both switches are on, clamps a too-small override, and destroy clears it', () => {
    process.env.STRATEGY_AGENTS_ENABLED = 'true';
    process.env.STRATEGY_WATCHER_SCHEDULER = 'true';
    const timer = fakeTimer();
    const setSpy = jest.spyOn(globalThis, 'setInterval').mockReturnValue(timer);
    const clearSpy = jest.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);

    const h = makeHarness();
    h.svc.onModuleInit();
    expect(setSpy).toHaveBeenLastCalledWith(expect.any(Function), 30_000);
    h.svc.onModuleDestroy();
    expect(clearSpy).toHaveBeenCalledWith(timer);

    process.env.STRATEGY_WATCHER_OUTBOX_MS = '10';
    const h2 = makeHarness();
    h2.svc.onModuleInit();
    expect(setSpy).toHaveBeenLastCalledWith(expect.any(Function), 5_000);
    h2.svc.onModuleDestroy();
  });
});
