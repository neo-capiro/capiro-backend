import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import { MissionsService } from './missions.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { CreateMissionDto, UpdateMissionDto } from './dto/agents.dto.js';

/*
 * MissionsService.update state-transition tests against an in-memory fake tx
 * (same makeStore/makeTx pattern as runs.service.spec.ts). The fake
 * spAgentMission.update models Postgres semantics for the state-guarded
 * write: an extended-unique where { id, state } that no longer matches the
 * row throws P2025, exactly what a concurrent committed transition produces.
 * An afterMissionRead hook lets a test interleave that concurrent commit
 * between the service's read and its write.
 */

interface Rec {
  [k: string]: unknown;
  id: string;
}

const T = 'tenant-1';
const U = 'user-1';

function makeStore() {
  const missions = new Map<string, Rec>();
  const activity: Rec[] = [];
  const outbox: Rec[] = [];
  let seq = 0;
  const nextId = (p: string) => `${p}-${++seq}`;
  return { missions, activity, outbox, nextId };
}
type Store = ReturnType<typeof makeStore>;

function seedMission(store: Store, id: string, state: string): void {
  store.missions.set(id, {
    id,
    tenantId: T,
    strategyId: 'S1',
    clientId: null,
    name: 'Watch the plan',
    description: null,
    state,
    cadence: null,
    nextRunAt: null,
    createdByUserId: U,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
  });
}

interface Hooks {
  /** Runs after spAgentMission.findFirst returns its (copied) row — the
   *  window where a concurrent PATCH can commit. */
  afterMissionRead?: () => void;
}

function makeTx(store: Store, hooks: Hooks, updateWheres: Rec[]) {
  const spAgentMission = {
    findFirst: async ({ where }: { where: { id: string } }) => {
      const rec = store.missions.get(where.id);
      // Copy: the service must not see later store mutations through the read.
      const copy = rec ? { ...rec } : null;
      hooks.afterMissionRead?.();
      return copy;
    },
    update: async ({ where, data }: { where: { id: string; state?: string }; data: Rec }) => {
      updateWheres.push({ ...where } as Rec);
      const rec = store.missions.get(where.id);
      // Extended-unique where: a state predicate that no longer matches the
      // committed row is a zero-row UPDATE => Prisma P2025.
      if (!rec || (where.state !== undefined && rec.state !== where.state)) {
        const err = Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
        Object.setPrototypeOf(err, Prisma.PrismaClientKnownRequestError.prototype);
        throw err;
      }
      const merged = { ...rec, ...data, updatedAt: new Date() };
      store.missions.set(where.id, merged);
      return merged;
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
  return { spAgentMission, spActivityLog, spEventOutbox } as unknown as Prisma.TransactionClient;
}

function makeService(store: Store, hooks: Hooks = {}) {
  const updateWheres: Rec[] = [];
  const snapshot = () => ({
    missions: new Map(store.missions),
    activity: [...store.activity],
    outbox: [...store.outbox],
  });
  const restore = (snap: ReturnType<typeof snapshot>) => {
    store.missions = snap.missions;
    store.activity = snap.activity;
    store.outbox = snap.outbox;
  };
  // Models the $transaction: snapshot, run, roll back on throw. NOTE: a
  // concurrent commit staged via afterMissionRead mutates the store INSIDE
  // this tx's lifetime, so restore() would wrongly roll it back — tests that
  // use the hook must re-apply the concurrent state when asserting, or (as
  // done here) the hook mutation is re-asserted against the snapshot+hook
  // composition. To keep it simple, restore() replays the hook mutation.
  const withTenantUser = jest.fn(
    async (_t: string, _u: string, fn: (tx: unknown) => Promise<unknown>) => {
      const snap = snapshot();
      let hookRan = false;
      const wrappedHooks: Hooks = {
        afterMissionRead: hooks.afterMissionRead
          ? () => {
              hookRan = true;
              hooks.afterMissionRead!();
            }
          : undefined,
      };
      try {
        return await fn(makeTx(store, wrappedHooks, updateWheres));
      } catch (e) {
        restore(snap);
        // The concurrent writer's commit survives OUR rollback.
        if (hookRan) hooks.afterMissionRead!();
        throw e;
      }
    },
  );
  const prisma = { withTenantUser } as unknown as PrismaService;
  const svc = new MissionsService(prisma, new VersioningService());
  return { svc, updateWheres };
}

describe('MissionsService.update state transitions', () => {
  it('guards the state write with the state it validated against, and a legal transition persists + logs', async () => {
    const store = makeStore();
    seedMission(store, 'M1', 'active');
    const { svc, updateWheres } = makeService(store);

    const updated = await svc.update(T, U, 'M1', { state: 'paused' } as UpdateMissionDto);

    expect(updated.state).toBe('paused');
    // The UPDATE must carry the previously READ state as a predicate — that is
    // the whole concurrency fix.
    expect(updateWheres).toHaveLength(1);
    expect(updateWheres[0]).toMatchObject({ id: 'M1', state: 'active' });
    const row = store.activity.find((a) => a.action === 'mission.updated')!;
    expect(row.before).toMatchObject({ state: 'active' });
    expect(row.after).toMatchObject({ state: 'paused' });
  });

  it('409s (not overwrites) when a concurrent transition commits between read and write: completed stays completed', async () => {
    const store = makeStore();
    seedMission(store, 'M1', 'active');
    // Request A commits state='completed' right after request B reads 'active'.
    const concurrentCommit = () => {
      const rec = store.missions.get('M1')!;
      store.missions.set('M1', { ...rec, state: 'completed' });
    };
    const { svc } = makeService(store, { afterMissionRead: concurrentCommit });

    // Request B: active -> paused is legal from what B read, but the row is
    // now terminal — the guarded UPDATE matches zero rows.
    const err = await svc
      .update(T, U, 'M1', { state: 'paused' } as UpdateMissionDto)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/changed concurrently/);
    // The terminal state survives; the mission cannot be re-activated later.
    expect(store.missions.get('M1')!.state).toBe('completed');
    // B's tx rolled back — no mission.updated audit row, no outbox event.
    expect(store.activity.filter((a) => a.action === 'mission.updated')).toHaveLength(0);
    expect(store.outbox).toHaveLength(0);
  });

  it('does NOT state-guard a non-state PATCH: renaming survives a concurrent transition (last-writer-wins fields)', async () => {
    const store = makeStore();
    seedMission(store, 'M1', 'active');
    const concurrentCommit = () => {
      const rec = store.missions.get('M1')!;
      store.missions.set('M1', { ...rec, state: 'completed' });
    };
    const { svc, updateWheres } = makeService(store, { afterMissionRead: concurrentCommit });

    const updated = await svc.update(T, U, 'M1', { name: 'Renamed' } as UpdateMissionDto);

    expect(updated.name).toBe('Renamed');
    expect(updateWheres[0]).toEqual({ id: 'M1' }); // no state predicate
    // The concurrent state change is untouched by the rename.
    expect(store.missions.get('M1')!.state).toBe('completed');
  });

  it('still 400s an illegal transition up front (terminal mission)', async () => {
    const store = makeStore();
    seedMission(store, 'M1', 'completed');
    const { svc, updateWheres } = makeService(store);

    const err = await svc
      .update(T, U, 'M1', { state: 'active' } as UpdateMissionDto)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(/terminal/);
    expect(updateWheres).toHaveLength(0); // rejected before any write
    expect(store.missions.get('M1')!.state).toBe('completed');
  });
});

/*
 * MissionsService.create FK-less reference validation. strategyId and clientId
 * have no FKs: strategyId is checked via the tenant-scoped spStrategy read,
 * clientId via the cross-schema raw `clients` existence query (no Prisma model
 * in this schema). A foreign or random UUID in either (both pass @IsUUID) must
 * 400 and persist nothing — no mission row, no activity, no outbox event.
 * Self-contained harness: create touches models the update harness above
 * deliberately omits (spStrategy, $queryRaw).
 */

function makeCreateStore() {
  const strategies = new Map<string, Rec>();
  // The shared cross-schema `clients` table (reached via raw SQL only).
  const clients = new Set<string>();
  const missions = new Map<string, Rec>();
  const activity: Rec[] = [];
  const outbox: Rec[] = [];
  let seq = 0;
  const nextId = (p: string) => `${p}-${++seq}`;
  return { strategies, clients, missions, activity, outbox, nextId };
}
type CreateStore = ReturnType<typeof makeCreateStore>;

function makeCreateTx(store: CreateStore) {
  const now = new Date();
  // Tenant-scoped in prod (the query hook injects tenantId); the fake store
  // only holds tenant-1 rows, so a miss models both "nonexistent" and
  // "other tenant".
  const spStrategy = {
    findFirst: async ({ where }: { where: { id: string } }) =>
      store.strategies.get(where.id) ?? null,
  };
  const spAgentMission = {
    create: async ({ data }: { data: Rec }) => {
      const id = store.nextId('mission');
      const rec: Rec = { ...data, id, createdAt: now, updatedAt: now };
      store.missions.set(id, rec);
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
  // MissionsService.create's ONLY raw query is the cross-schema clients
  // existence check: SELECT 1 ... WHERE id = ${clientId} AND tenant_id = ${tenantId}.
  const $queryRaw = async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const [clientId, tenantId] = values as [string, string];
    return store.clients.has(clientId) && tenantId === T ? [{ ok: 1 }] : [];
  };
  return {
    spStrategy,
    spAgentMission,
    spActivityLog,
    spEventOutbox,
    $queryRaw,
  } as unknown as Prisma.TransactionClient;
}

function makeCreateService(store: CreateStore) {
  const snapshot = () => ({
    missions: new Map(store.missions),
    activity: [...store.activity],
    outbox: [...store.outbox],
  });
  const restore = (snap: ReturnType<typeof snapshot>) => {
    store.missions = snap.missions;
    store.activity = snap.activity;
    store.outbox = snap.outbox;
  };
  // Models the $transaction: snapshot, run, roll back on throw.
  const withTenantUser = jest.fn(
    async (_t: string, _u: string, fn: (tx: unknown) => Promise<unknown>) => {
      const snap = snapshot();
      try {
        return await fn(makeCreateTx(store));
      } catch (e) {
        restore(snap);
        throw e;
      }
    },
  );
  const prisma = { withTenantUser } as unknown as PrismaService;
  return new MissionsService(prisma, new VersioningService());
}

describe('MissionsService.create — FK-less reference validation', () => {
  it('rejects a strategyId the tenant does not own (no spStrategy row) and persists nothing', async () => {
    const store = makeCreateStore();
    const svc = makeCreateService(store);

    const err = await svc
      .create(T, U, { name: 'Watch the plan', strategyId: 'foreign-strategy' } as CreateMissionDto)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(/Unknown strategy/);
    expect(store.missions.size).toBe(0);
    expect(store.activity).toHaveLength(0);
    expect(store.outbox).toHaveLength(0);
  });

  it('rejects a clientId the tenant does not own (cross-schema clients check) and persists nothing', async () => {
    // SpAgentMission.clientId has no FK and no Prisma model in this schema —
    // without the raw tenant-scoped existence check a random / cross-tenant
    // UUID would commit and client-scoped consumers downstream would
    // misattribute or silently lose the mission.
    const store = makeCreateStore();
    const svc = makeCreateService(store);

    const err = await svc
      .create(T, U, { name: 'Watch the plan', clientId: 'foreign-client' } as CreateMissionDto)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(/Unknown client/);
    expect(store.missions.size).toBe(0);
    expect(store.activity).toHaveLength(0);
    expect(store.outbox).toHaveLength(0);
  });

  it('accepts in-tenant strategyId + clientId: draft mission persisted with audit + outbox rows', async () => {
    const store = makeCreateStore();
    store.strategies.set('S1', { id: 'S1', tenantId: T });
    store.clients.add('C1');
    const svc = makeCreateService(store);

    const mission = await svc.create(T, U, {
      name: 'Watch the plan',
      strategyId: 'S1',
      clientId: 'C1',
    } as CreateMissionDto);

    expect(mission.state).toBe('draft');
    expect(mission.strategyId).toBe('S1');
    expect(mission.clientId).toBe('C1');
    expect(store.activity.filter((a) => a.action === 'mission.created')).toHaveLength(1);
    expect(store.outbox.filter((o) => o.type === 'mission.created')).toHaveLength(1);
  });
});
