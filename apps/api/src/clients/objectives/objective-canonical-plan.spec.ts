import type { ClientObjectiveRevision } from '@prisma/client';
import type { ClientObjectiveDestinationTx } from '@capiro/shared';
import {
  requireCanonicalObjectiveFence,
  reserveCanonicalObjectivePlan,
  type CanonicalObjectivePlanToken,
} from './objective-canonical-plan.js';
import {
  objectiveRevisionSnapshotHash,
  OBJECTIVE_WORK_BLOCKER,
  OBJECTIVE_WORK_PURPOSE,
} from './objective-work-intent.js';

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const actor = { tenantId: id(1), userId: id(5), clerkUserId: 'synthetic-actor' };
function fixture(existing = true) {
  const revision: ClientObjectiveRevision = {
    id: id(4),
    tenantId: id(1),
    clientId: id(2),
    objectiveId: id(3),
    version: 2,
    operation: 'confirm_ready',
    actorUserId: id(5),
    createdAt: new Date('2026-10-15T00:00:00Z'),
    snapshot: {
      id: id(3),
      clientId: id(2),
      version: 2,
      status: 'ready',
      deletedAt: null,
      outcome: 'Saved objective',
    },
  };
  const receipt = { id: id(6), objectiveRevisionId: revision.id };
  const hash = objectiveRevisionSnapshotHash(revision.snapshot);
  const expected: CanonicalObjectivePlanToken = {
    canonicalPlanId: id(7),
    tenantId: id(1),
    clientId: id(2),
    objectiveId: id(3),
    canonicalStrategyId: id(8),
    canonicalProjectId: id(9),
    bindingVersion: 1,
    epoch: 1,
    requestedIntentId: receipt.id,
    requestedObjectiveRevisionId: revision.id,
    requestedObjectiveVersion: revision.version,
    snapshotHash: hash,
  };
  const state = {
    canonical: existing ? { ...expected } : (null as CanonicalObjectivePlanToken | null),
    intent: {
      id: receipt.id,
      tenantId: revision.tenantId,
      clientId: revision.clientId,
      objectiveId: revision.objectiveId,
      objectiveRevisionId: revision.id,
      objectiveVersion: revision.version,
      actorUserId: revision.actorUserId,
      snapshotHash: hash,
      purpose: OBJECTIVE_WORK_PURPOSE,
      state: 'pending',
      blockedReason: OBJECTIVE_WORK_BLOCKER,
      revisionActorUserId: revision.actorUserId,
      revisionOperation: revision.operation,
      revisionSnapshot: revision.snapshot,
    },
    authorized: true,
    memoryWall: false,
    grant: true,
    currentVersion: 2,
    currentRevisionId: revision.id,
    currentStatus: 'ready',
    deleted: false,
    updateCount: 1,
    conflictWinner: null as CanonicalObjectivePlanToken | null,
  };
  const query = jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join('?');
    if (sql.includes('FROM tenants t'))
      return state.authorized ? [{ userId: actor.userId, memoryWall: state.memoryWall }] : [];
    if (sql.includes('FROM client_memory_access')) return state.grant ? [{ id: id(20) }] : [];
    if (sql.includes('SELECT version FROM client_objectives'))
      return state.deleted ? [] : [{ version: state.currentVersion }];
    if (sql.includes('SELECT id FROM client_objective_revisions'))
      return [{ id: state.currentRevisionId }];
    if (sql.includes('SELECT status::text'))
      return state.deleted ? [] : [{ status: state.currentStatus }];
    if (sql.includes('FROM client_objective_work_intents i')) return [{ ...state.intent }];
    if (sql.includes('INSERT INTO client_objective_canonical_plans')) {
      if (state.conflictWinner) {
        state.canonical = { ...state.conflictWinner };
        return [];
      }
      state.canonical = {
        canonicalPlanId: values[0] as string,
        tenantId: values[1] as string,
        clientId: values[2] as string,
        objectiveId: values[3] as string,
        canonicalStrategyId: values[4] as string,
        canonicalProjectId: values[5] as string,
        bindingVersion: 1,
        epoch: 1,
        requestedIntentId: values[6] as string,
        requestedObjectiveRevisionId: values[7] as string,
        requestedObjectiveVersion: values[8] as number,
        snapshotHash: values[9] as string,
      };
      return [{ id: state.canonical.canonicalPlanId }];
    }
    if (sql.includes('UPDATE client_objective_canonical_plans')) {
      if (state.updateCount !== 1)
        return state.updateCount === 0
          ? []
          : [
              { id: id(7), bindingVersion: 2 },
              { id: id(7), bindingVersion: 2 },
            ];
      const previous = state.canonical!;
      expect(values.slice(4)).toEqual([
        previous.canonicalPlanId,
        revision.tenantId,
        revision.clientId,
        revision.objectiveId,
        previous.bindingVersion,
        previous.epoch,
        previous.canonicalStrategyId,
        previous.canonicalProjectId,
        previous.requestedIntentId,
        previous.requestedObjectiveRevisionId,
        previous.requestedObjectiveVersion,
        previous.snapshotHash,
      ]);
      state.canonical = {
        ...previous,
        requestedIntentId: values[0] as string,
        requestedObjectiveRevisionId: values[1] as string,
        requestedObjectiveVersion: values[2] as number,
        snapshotHash: values[3] as string,
        bindingVersion: previous.bindingVersion + 1,
      };
      return [
        { id: state.canonical.canonicalPlanId, bindingVersion: state.canonical.bindingVersion },
      ];
    }
    if (sql.includes('FROM client_objective_canonical_plans'))
      return state.canonical ? [{ ...state.canonical }] : [];
    throw Error('Unrecognized synthetic SQL');
  });
  return {
    revision,
    receipt,
    state,
    expected,
    query,
    tx: { $queryRaw: query } as unknown as ClientObjectiveDestinationTx,
  };
}

describe('canonical Objective reservation and unregistered tx fence (synthetic SQL, not native proof)', () => {
  test('same intent reuses exactly the locked reservation without writes', async () => {
    const f = fixture();
    await expect(reserveCanonicalObjectivePlan(f.tx, f.revision, f.receipt)).resolves.toEqual(
      f.expected,
    );
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.query.mock.calls[0]![0].join('')).toContain('FROM client_objective_work_intents');
    expect(f.query.mock.calls[0]![0].join('')).not.toMatch(/FOR (UPDATE|SHARE)/);
    expect(f.query.mock.calls[1]![0].join('')).toContain('FOR UPDATE');
  });

  test('first confirmation reserves only IDs using DB time, append once and separate winner lookup', async () => {
    const f = fixture(false);
    const row = await reserveCanonicalObjectivePlan(f.tx, f.revision, f.receipt);
    expect(row).toMatchObject({
      bindingVersion: 1,
      epoch: 1,
      requestedIntentId: f.receipt.id,
      snapshotHash: f.expected.snapshotHash,
    });
    expect(
      new Set([row.canonicalPlanId, row.canonicalStrategyId, row.canonicalProjectId]).size,
    ).toBe(3);
    expect(f.query).toHaveBeenCalledTimes(4);
    const sql = f.query.mock.calls[2]![0].join('');
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('clock_timestamp()');
    expect(f.query.mock.calls[3]![0].join('')).toContain('FOR UPDATE');
    expect(f.query.mock.calls.every((c) => !/INSERT INTO (sp_|planner_)/.test(c[0].join('')))).toBe(
      true,
    );
  });

  test('READ COMMITTED conflict winner is reconciled in a later statement', async () => {
    const f = fixture(false);
    f.state.conflictWinner = { ...f.expected };
    await expect(reserveCanonicalObjectivePlan(f.tx, f.revision, f.receipt)).resolves.toEqual(
      f.expected,
    );
  });

  test('higher ready revision updates only requested binding and preserves IDs/epoch', async () => {
    const f = fixture();
    f.state.canonical = {
      ...f.expected,
      requestedIntentId: id(21),
      requestedObjectiveRevisionId: id(22),
      requestedObjectiveVersion: 1,
      snapshotHash: 'a'.repeat(64),
      bindingVersion: 4,
      epoch: 1,
    };
    const previous = { ...f.state.canonical };
    const actual = await reserveCanonicalObjectivePlan(f.tx, f.revision, f.receipt);
    expect(actual).toEqual({ ...f.expected, bindingVersion: 5, epoch: 1 });
    expect(actual.canonicalStrategyId).toBe(previous.canonicalStrategyId);
    expect(actual.canonicalProjectId).toBe(previous.canonicalProjectId);
  });

  test.each([2, 3])(
    'same/lower requested revision refuses replacement intent (current=%s)',
    async (version) => {
      const f = fixture();
      f.state.canonical!.requestedIntentId = id(99);
      f.state.canonical!.requestedObjectiveVersion = version;
      await expect(reserveCanonicalObjectivePlan(f.tx, f.revision, f.receipt)).rejects.toThrow(
        'unavailable',
      );
      expect(f.query.mock.calls.some((c) => c[0].join('').includes('UPDATE client'))).toBe(false);
    },
  );

  test.each([0, 2])('CAS rowcount %s refuses success', async (count) => {
    const f = fixture();
    f.state.canonical!.requestedObjectiveVersion = 1;
    f.state.updateCount = count;
    await expect(reserveCanonicalObjectivePlan(f.tx, f.revision, f.receipt)).rejects.toThrow(
      'unavailable',
    );
  });

  test.each([
    'tenantId',
    'clientId',
    'objectiveId',
    'objectiveRevisionId',
    'actorUserId',
    'revisionActorUserId',
    'purpose',
    'state',
    'blockedReason',
    'snapshotHash',
    'revisionOperation',
  ] as const)('actual saved intent/revision %s cannot be forged', async (field) => {
    const f = fixture();
    f.state.intent[field] = field === 'snapshotHash' ? 'f'.repeat(64) : id(99);
    await expect(reserveCanonicalObjectivePlan(f.tx, f.revision, f.receipt)).rejects.toThrow();
    expect(f.query).toHaveBeenCalledTimes(1);
  });

  test('actual stored snapshot hash is recomputed, not just echoed caller/intent hash', async () => {
    const f = fixture();
    f.state.intent.revisionSnapshot = {
      ...(f.revision.snapshot as object),
      outcome: 'Forged stored content',
    };
    await expect(reserveCanonicalObjectivePlan(f.tx, f.revision, f.receipt)).rejects.toThrow();
    const gate = fixture();
    gate.state.intent.revisionSnapshot = { ...(gate.revision.snapshot as object), status: 'draft' };
    await expect(requireCanonicalObjectiveFence(gate.tx, actor, gate.expected)).rejects.toThrow();
  });

  test('unsaved/mismatched ready receipt fails before SQL', async () => {
    const f = fixture();
    await expect(
      reserveCanonicalObjectivePlan(f.tx, f.revision, {
        ...f.receipt,
        objectiveRevisionId: id(99),
      }),
    ).rejects.toThrow();
    await expect(
      reserveCanonicalObjectivePlan(f.tx, { ...f.revision, operation: 'edit' }, f.receipt),
    ).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled();
  });

  test('fence uses actual shared destination authority then immutable intent and canonical lock', async () => {
    const f = fixture();
    await expect(requireCanonicalObjectiveFence(f.tx, actor, f.expected)).resolves.toEqual(
      f.expected,
    );
    const sql = f.query.mock.calls.map((c) => c[0].join(''));
    expect(sql[0]).toContain('FROM tenants t');
    expect(sql[1]).toContain('FOR SHARE');
    expect(sql.at(-2)).toContain('FROM client_objective_work_intents');
    expect(sql.at(-1)).toContain('FOR UPDATE');
  });

  test('fence permits another currently authorized actor without claiming delegated workload authority', async () => {
    const f = fixture();
    await expect(
      requireCanonicalObjectiveFence(
        f.tx,
        { ...actor, userId: id(77), clerkUserId: 'another-current-member' },
        f.expected,
      ),
    ).resolves.toEqual(f.expected);
    expect(f.query.mock.calls[0]!.slice(1)).toContain(id(77));
  });

  test.each(['membership', 'wall', 'version', 'revision', 'ready', 'deleted'] as const)(
    'fence fails current %s using real authority source and no policy mock',
    async (change) => {
      const f = fixture();
      if (change === 'membership') f.state.authorized = false;
      if (change === 'wall') {
        f.state.memoryWall = true;
        f.state.grant = false;
      }
      if (change === 'version') f.state.currentVersion++;
      if (change === 'revision') f.state.currentRevisionId = id(99);
      if (change === 'ready') f.state.currentStatus = 'draft';
      if (change === 'deleted') f.state.deleted = true;
      await expect(requireCanonicalObjectiveFence(f.tx, actor, f.expected)).rejects.toThrow();
      expect(
        f.query.mock.calls.some((c) =>
          c[0].join('').includes('FROM client_objective_canonical_plans'),
        ),
      ).toBe(false);
    },
  );

  test.each([
    'canonicalPlanId',
    'canonicalStrategyId',
    'canonicalProjectId',
    'bindingVersion',
    'epoch',
    'requestedIntentId',
    'requestedObjectiveRevisionId',
    'requestedObjectiveVersion',
    'snapshotHash',
  ] as const)('fence rejects exact token mismatch %s', async (key) => {
    const f = fixture();
    const forged = { ...f.expected };
    if (key === 'bindingVersion' || key === 'epoch' || key === 'requestedObjectiveVersion')
      forged[key]++;
    else forged[key] = key === 'snapshotHash' ? 'f'.repeat(64) : id(99);
    await expect(requireCanonicalObjectiveFence(f.tx, actor, forged)).rejects.toThrow();
  });

  test('token getters/proxies/coercions/symbols/unknown keys cannot run queries', async () => {
    const f = fixture();
    const getter = jest.fn(() => 1);
    const value = { ...f.expected };
    Object.defineProperty(value, 'epoch', { enumerable: true, get: getter });
    const trap = jest.fn(() => {
      throw Error('must not run');
    });
    for (const invalid of [
      value,
      new Proxy({}, { ownKeys: trap }),
      { ...f.expected, epoch: '1' },
      { ...f.expected, unknown: true },
      { ...f.expected, [Symbol('extra')]: true },
    ]) {
      await expect(
        requireCanonicalObjectiveFence(f.tx, actor, invalid as CanonicalObjectivePlanToken),
      ).rejects.toThrow();
    }
    expect(getter).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  });

  test('replacement epoch is unavailable and rejected before authority queries', async () => {
    const f = fixture();
    await expect(
      requireCanonicalObjectiveFence(f.tx, actor, { ...f.expected, epoch: 2 }),
    ).rejects.toThrow('Invalid');
    expect(f.query).not.toHaveBeenCalled();
  });

  test('caller transaction propagates failure and synthetic rollback restores requested pointer', async () => {
    const f = fixture();
    f.state.canonical!.requestedObjectiveVersion = 1;
    const before = { ...f.state.canonical! };
    const transaction = async () => {
      try {
        await reserveCanonicalObjectivePlan(f.tx, f.revision, f.receipt);
        throw Error('later caller failure');
      } catch (error) {
        f.state.canonical = before;
        throw error;
      }
    };
    await expect(transaction()).rejects.toThrow('later caller failure');
    expect(f.state.canonical).toEqual(before);
    // This demonstrates callback error propagation only, not PostgreSQL rollback.
  });
});
