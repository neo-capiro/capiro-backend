import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { NodeService } from './node.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { VersioningService } from './versioning.service.js';
import type { Prisma } from '../../generated/prisma-client/index.js';
import type { CreateNodeDto, UpdateNodeDto } from './dto/node.dto.js';

/*
 * NodeService CRUD tests with an in-memory fake Prisma tx (sp_strategy/sp_node),
 * modelled after meri.service.spec.ts's makeStore()/makeTx() pattern. Versioning
 * is a pure jest.fn() spy (no-op) so we can assert the note/authorKind it was
 * called with without re-testing VersioningService itself. $executeRaw is
 * modelled against the same in-memory nodes Map so the A2 sibling dependency
 * strip on delete is exercised for real, not stubbed to a constant.
 */

interface Rec {
  [k: string]: unknown;
  id: string;
}

const T = 'tenant-1';
const U = 'user-1';

interface NodeSeed {
  id: string;
  title: string;
  startsOn: string;
  kind?: string;
  subject?: string;
  status?: string;
  endsOn?: Date | null;
  openEnded?: boolean;
  dependsOnIds?: string[];
  note?: string | null;
  ownerUserId?: string | null;
}

function makeStore() {
  const strategies = new Map<string, Rec>();
  const nodes = new Map<string, Rec>();
  const nodesFor = (sid: string) =>
    [...nodes.values()]
      .filter((n) => n.strategyId === sid)
      .sort((a, b) => {
        const sa = (a.startsOn as Date).getTime();
        const sb = (b.startsOn as Date).getTime();
        if (sa !== sb) return sa - sb;
        return (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime();
      });
  return { strategies, nodes, nodesFor };
}
type Store = ReturnType<typeof makeStore>;

/** Seed one strategy (id 'S1' by default) plus zero or more nodes under it. */
function seedStrategy(store: Store, nodeSeeds: NodeSeed[] = [], sid = 'S1'): string {
  store.strategies.set(sid, {
    id: sid,
    tenantId: T,
    clientId: 'C1',
    title: 'Existing',
    lastEditedByUserId: null,
    lastEditedAt: null,
  });
  for (const seed of nodeSeeds) {
    store.nodes.set(seed.id, {
      tenantId: T,
      strategyId: sid,
      kind: 'action',
      subject: 'deliverable',
      status: 'active',
      note: null,
      ownerUserId: null,
      endsOn: null,
      openEnded: false,
      dependsOnIds: [],
      meriAuthored: false,
      createdByUserId: U,
      createdAt: new Date('2027-01-01T00:00:00.000Z'),
      ...seed,
      startsOn: new Date(`${seed.startsOn}T00:00:00.000Z`),
    });
  }
  return sid;
}

function makeTx(store: Store) {
  const now = new Date();
  const spNode = {
    create: jest.fn(async ({ data }: { data: Rec }) => {
      const id = `node-${store.nodes.size + 1}`;
      const rec: Rec = { ...data, id, createdAt: now, updatedAt: now };
      store.nodes.set(id, rec);
      return rec;
    }),
    findFirst: jest.fn(async ({ where }: { where: { id: string; strategyId?: string } }) => {
      const rec = store.nodes.get(where.id);
      if (!rec) return null;
      if (where.strategyId && rec.strategyId !== where.strategyId) return null;
      return rec;
    }),
    findMany: jest.fn(
      async ({ where }: { where: { strategyId: string; id: { in: string[] } } }) => {
        const ids = new Set(where.id.in);
        return [...store.nodes.values()].filter(
          (n) => n.strategyId === where.strategyId && ids.has(n.id),
        );
      },
    ),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Rec }) => {
      const rec = store.nodes.get(where.id);
      if (!rec) throw new Error('node not found');
      const merged = { ...rec, ...data, updatedAt: now };
      store.nodes.set(where.id, merged);
      return merged;
    }),
    delete: jest.fn(async ({ where }: { where: { id: string } }) => {
      const rec = store.nodes.get(where.id);
      store.nodes.delete(where.id);
      return rec ?? null;
    }),
  };
  const attach = (rec: Rec) => ({ ...rec, nodes: store.nodesFor(rec.id), artifacts: [] });
  const spStrategy = {
    findFirst: jest.fn(async ({ where }: { where: { id: string } }) => store.strategies.get(where.id) ?? null),
    findFirstOrThrow: jest.fn(async ({ where }: { where: { id: string } }) => {
      const rec = store.strategies.get(where.id);
      if (!rec) throw new Error('strategy not found');
      return attach(rec);
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Rec }) => {
      const rec = store.strategies.get(where.id);
      if (!rec) throw new Error('strategy not found');
      const merged = { ...rec, ...data };
      store.strategies.set(where.id, merged);
      return merged;
    }),
  };
  // A2: models the raw array_remove sibling-strip against the same in-memory
  // nodes Map, scoped by strategyId + tenantId exactly like the real SQL's
  // WHERE clause, and returns the affected-row count (only rows that actually
  // contained the removed id — matching Postgres' UPDATE...WHERE semantics).
  const $executeRaw = jest.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const [removeId, strategyId, tenantId] = values as [string, string, string];
    let count = 0;
    for (const rec of store.nodes.values()) {
      if (rec.strategyId !== strategyId || rec.tenantId !== tenantId) continue;
      const deps = (rec.dependsOnIds as string[] | undefined) ?? [];
      if (deps.includes(removeId)) {
        rec.dependsOnIds = deps.filter((d) => d !== removeId);
        count++;
      }
    }
    return count;
  });
  // Stage C: VersioningService.logActivity unconditionally emits a
  // transactional-outbox row in the same tx — the fake tx must accept it.
  const spEventOutbox = { create: jest.fn(async () => undefined) };
  return { spNode, spStrategy, $executeRaw, spEventOutbox };
}
type Tx = ReturnType<typeof makeTx>;

function makePrisma(store: Store) {
  let lastTx: Tx | undefined;
  const withTenantUser = jest.fn(
    async (_t: string, _u: string, fn: (tx: unknown) => Promise<unknown>) => {
      const tx = makeTx(store);
      lastTx = tx;
      return fn(tx as unknown as Prisma.TransactionClient);
    },
  );
  return {
    prisma: { withTenantUser } as unknown as PrismaService,
    withTenantUser,
    getLastTx: () => lastTx!,
  };
}

function makeVersioning() {
  return {
    cutVersion: jest.fn(async () => 'v-1'),
    logActivity: jest.fn(async () => undefined),
  } as unknown as VersioningService;
}

function makeService(store: Store) {
  const { prisma, withTenantUser, getLastTx } = makePrisma(store);
  const versioning = makeVersioning();
  const svc = new NodeService(prisma, versioning);
  return { svc, versioning, withTenantUser, getLastTx };
}

describe('NodeService.add', () => {
  it('resolves and persists dependsOnIds when all ids are valid nodes in the same strategy', async () => {
    const store = makeStore();
    const sid = seedStrategy(store, [
      { id: 'N1', title: 'Node one', startsOn: '2027-02-01' },
      { id: 'N2', title: 'Node two', startsOn: '2027-03-01' },
    ]);
    const { svc } = makeService(store);

    const dto = {
      kind: 'action',
      subject: 'deliverable',
      title: 'New step',
      startsOn: '2027-04-01',
      dependsOnIds: ['N1', 'N2'],
    } as CreateNodeDto;

    const detail = (await svc.add(T, U, sid, dto)) as unknown as {
      nodes: Array<{ title: string; dependsOnIds: string[] }>;
    };
    const created = detail.nodes.find((n) => n.title === 'New step')!;
    expect(created.dependsOnIds).toEqual(['N1', 'N2']);
    // Persisted to the store, not just echoed on the return value.
    const stored = [...store.nodes.values()].find((n) => n.title === 'New step')!;
    expect(stored.dependsOnIds).toEqual(['N1', 'N2']);
  });

  it('rejects a dangling dependsOnId with a NotFoundException-free 400 naming the missing id', async () => {
    const store = makeStore();
    const sid = seedStrategy(store, [{ id: 'N1', title: 'Node one', startsOn: '2027-02-01' }]);
    const { svc } = makeService(store);
    const dto = {
      kind: 'action',
      subject: 'deliverable',
      title: 'New step',
      startsOn: '2027-04-01',
      dependsOnIds: ['N1', 'ghost-id'],
    } as CreateNodeDto;

    await expect(svc.add(T, U, sid, dto)).rejects.toThrow(BadRequestException);
    await expect(svc.add(T, U, sid, dto)).rejects.toThrow(/ghost-id/);
    // Nothing persisted from either failed attempt.
    expect([...store.nodes.values()].some((n) => n.title === 'New step')).toBe(false);
  });
});

describe('NodeService.resolveDependsOn (private — exercised directly for edge cases)', () => {
  it('rejects a self-reference with BadRequestException', async () => {
    const store = makeStore();
    const sid = seedStrategy(store, [{ id: 'N1', title: 'Node one', startsOn: '2027-02-01' }]);
    const { svc } = makeService(store);
    const tx = makeTx(store);
    await expect(
      (svc as unknown as { resolveDependsOn: (...a: unknown[]) => Promise<unknown> }).resolveDependsOn(
        tx,
        sid,
        'N1',
        ['N1'],
      ),
    ).rejects.toThrow(/cannot depend on itself/);
  });

  it('rejects an id that is not a node in this strategy (dangling / cross-strategy) naming it', async () => {
    const store = makeStore();
    const sid = seedStrategy(store, [{ id: 'N1', title: 'Node one', startsOn: '2027-02-01' }]);
    // A node that exists, but in a DIFFERENT strategy — must still be rejected.
    seedStrategy(store, [{ id: 'X1', title: 'Other strategy node', startsOn: '2027-02-01' }], 'S2');
    const { svc } = makeService(store);
    const tx = makeTx(store);
    const call = (svc as unknown as { resolveDependsOn: (...a: unknown[]) => Promise<unknown> }).resolveDependsOn(
      tx,
      sid,
      null,
      ['N1', 'X1'],
    );
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(/X1/);
  });

  it('dedupes repeated ids in the input', async () => {
    const store = makeStore();
    const sid = seedStrategy(store, [{ id: 'N1', title: 'Node one', startsOn: '2027-02-01' }]);
    const { svc } = makeService(store);
    const tx = makeTx(store);
    const result = await (svc as unknown as {
      resolveDependsOn: (...a: unknown[]) => Promise<string[] | undefined>;
    }).resolveDependsOn(tx, sid, null, ['N1', 'N1', 'N1']);
    expect(result).toEqual(['N1']);
  });

  it('returns undefined when dependsOnIds is absent, and [] when explicitly empty', async () => {
    const store = makeStore();
    const sid = seedStrategy(store, []);
    const { svc } = makeService(store);
    const tx = makeTx(store);
    const resolve = svc as unknown as {
      resolveDependsOn: (...a: unknown[]) => Promise<string[] | undefined>;
    };
    await expect(resolve.resolveDependsOn(tx, sid, null, undefined)).resolves.toBeUndefined();
    await expect(resolve.resolveDependsOn(tx, sid, null, [])).resolves.toEqual([]);
  });
});

describe('NodeService.remove', () => {
  it("strips the deleted node's id from every OTHER node's dependsOnIds in the same strategy", async () => {
    const store = makeStore();
    const sid = seedStrategy(store, [
      { id: 'N1', title: 'Node one', startsOn: '2027-02-01' },
      { id: 'N2', title: 'Node two', startsOn: '2027-03-01', dependsOnIds: ['N1'] },
      { id: 'N3', title: 'Node three', startsOn: '2027-04-01', dependsOnIds: ['N1', 'N2'] },
    ]);
    const { svc } = makeService(store);

    await svc.remove(T, U, sid, 'N1');

    expect(store.nodes.has('N1')).toBe(false);
    expect(store.nodes.get('N2')!.dependsOnIds).toEqual([]);
    // N3 depended on both N1 and N2 — only the deleted id (N1) is stripped.
    expect(store.nodes.get('N3')!.dependsOnIds).toEqual(['N2']);
  });

  it("does not touch a node in a different strategy that happens to share the deleted node's id shape", async () => {
    const store = makeStore();
    const sid = seedStrategy(store, [
      { id: 'N1', title: 'Node one', startsOn: '2027-02-01' },
      { id: 'N2', title: 'Node two', startsOn: '2027-03-01', dependsOnIds: ['N1'] },
    ]);
    seedStrategy(store, [{ id: 'X1', title: 'Other', startsOn: '2027-02-01', dependsOnIds: ['N1'] }], 'S2');
    const { svc } = makeService(store);

    await svc.remove(T, U, sid, 'N1');

    expect(store.nodes.get('N2')!.dependsOnIds).toEqual([]);
    // Cross-strategy row is untouched even though it lists the same id string.
    expect(store.nodes.get('X1')!.dependsOnIds).toEqual(['N1']);
  });

  it("differentiates the version note: 'Deleted X' vs 'Deleted X (unlinked from N steps)'", async () => {
    const store = makeStore();
    const sid = seedStrategy(store, [
      { id: 'N1', title: 'Node one', startsOn: '2027-02-01' },
      { id: 'N2', title: 'Node two', startsOn: '2027-03-01', dependsOnIds: ['N1'] },
    ]);
    const { svc, versioning } = makeService(store);
    await svc.remove(T, U, sid, 'N1');
    const note = (versioning.cutVersion as jest.Mock).mock.calls[0]![1] as { note: string };
    expect(note.note).toBe('Deleted Node one (unlinked from 1 step)');

    const store2 = makeStore();
    const sid2 = seedStrategy(store2, [
      { id: 'N1', title: 'Node one', startsOn: '2027-02-01' },
      { id: 'N2', title: 'Node two', startsOn: '2027-03-01' },
    ]);
    const { svc: svc2, versioning: versioning2 } = makeService(store2);
    await svc2.remove(T, U, sid2, 'N1');
    const note2 = (versioning2.cutVersion as jest.Mock).mock.calls[0]![1] as { note: string };
    expect(note2.note).toBe('Deleted Node one');

    const store3 = makeStore();
    const sid3 = seedStrategy(store3, [
      { id: 'N1', title: 'Node one', startsOn: '2027-02-01' },
      { id: 'N2', title: 'Node two', startsOn: '2027-03-01', dependsOnIds: ['N1'] },
      { id: 'N3', title: 'Node three', startsOn: '2027-04-01', dependsOnIds: ['N1'] },
    ]);
    const { svc: svc3, versioning: versioning3 } = makeService(store3);
    await svc3.remove(T, U, sid3, 'N1');
    const note3 = (versioning3.cutVersion as jest.Mock).mock.calls[0]![1] as { note: string };
    expect(note3.note).toBe('Deleted Node one (unlinked from 2 steps)');
  });
});

describe('NodeService.update', () => {
  it('clears openEnded when converting a node away from risk without the caller explicitly setting it', async () => {
    const store = makeStore();
    const sid = seedStrategy(store, [
      { id: 'N1', title: 'CR risk', startsOn: '2027-02-01', kind: 'risk', openEnded: true },
    ]);
    const { svc } = makeService(store);

    await svc.update(T, U, sid, 'N1', { kind: 'action' } as UpdateNodeDto);

    const rec = store.nodes.get('N1')!;
    expect(rec.kind).toBe('action');
    expect(rec.openEnded).toBe(false);
  });

  it('leaves openEnded alone when the node stays a risk', async () => {
    const store = makeStore();
    const sid = seedStrategy(store, [
      { id: 'N1', title: 'CR risk', startsOn: '2027-02-01', kind: 'risk', openEnded: true },
    ]);
    const { svc } = makeService(store);

    await svc.update(T, U, sid, 'N1', { title: 'CR risk (renamed)' } as UpdateNodeDto);

    expect(store.nodes.get('N1')!.openEnded).toBe(true);
  });

  it('respects an explicit openEnded value even while converting away from risk', async () => {
    const store = makeStore();
    const sid = seedStrategy(store, [
      { id: 'N1', title: 'CR risk', startsOn: '2027-02-01', kind: 'risk', openEnded: true },
    ]);
    const { svc } = makeService(store);

    await svc.update(T, U, sid, 'N1', { kind: 'milestone', openEnded: true } as UpdateNodeDto);

    // Caller explicitly set it — the auto-clear only fires when the field was
    // NOT provided in the dto.
    expect(store.nodes.get('N1')!.openEnded).toBe(true);
  });

  it('rejects a partial date change that leaves endsOn earlier than the (possibly unchanged) startsOn', async () => {
    const store = makeStore();
    const sid = seedStrategy(store, [
      {
        id: 'N1',
        title: 'Node one',
        startsOn: '2027-02-01',
        endsOn: new Date('2027-02-15T00:00:00.000Z'),
      },
    ]);
    const { svc } = makeService(store);

    // Only startsOn is sent; the cross-validation must merge it against the
    // node's EXISTING endsOn (2027-02-15), not just the fields present in dto.
    await expect(
      svc.update(T, U, sid, 'N1', { startsOn: '2027-03-01' } as UpdateNodeDto),
    ).rejects.toThrow(BadRequestException);
    // Nothing persisted.
    expect((store.nodes.get('N1')!.startsOn as Date).toISOString().slice(0, 10)).toBe('2027-02-01');
  });

  it('leaves dependsOnIds untouched when omitted from the dto, but clears it when explicitly sent as []', async () => {
    const store = makeStore();
    const sid = seedStrategy(store, [
      { id: 'N1', title: 'Node one', startsOn: '2027-02-01' },
      { id: 'N2', title: 'Node two', startsOn: '2027-03-01', dependsOnIds: ['N1'] },
    ]);
    const { svc } = makeService(store);

    await svc.update(T, U, sid, 'N2', { title: 'Node two (renamed)' } as UpdateNodeDto);
    expect(store.nodes.get('N2')!.dependsOnIds).toEqual(['N1']);

    await svc.update(T, U, sid, 'N2', { dependsOnIds: [] } as UpdateNodeDto);
    expect(store.nodes.get('N2')!.dependsOnIds).toEqual([]);
  });

  it('does not cut a version or call spNode.update when the dto has no recognized fields', async () => {
    const store = makeStore();
    const sid = seedStrategy(store, [{ id: 'N1', title: 'Node one', startsOn: '2027-02-01' }]);
    const { svc, versioning, getLastTx } = makeService(store);

    await svc.update(T, U, sid, 'N1', { changeNote: 'just leaving a note' } as UpdateNodeDto);

    const tx = getLastTx();
    expect(tx.spNode.update).not.toHaveBeenCalled();
    expect(tx.spStrategy.update).not.toHaveBeenCalled(); // bump() short-circuited too
    expect(versioning.cutVersion).not.toHaveBeenCalled();
    expect(versioning.logActivity).not.toHaveBeenCalled();
  });
});
