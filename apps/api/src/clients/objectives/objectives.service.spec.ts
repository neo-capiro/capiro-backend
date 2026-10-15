import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { ClientObjective } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClientObjectivesService } from './objectives.service.js';
import { objectiveRevisionSnapshotHash } from './objective-work-intent.js';
import type { CanonicalObjectivePlanToken } from './objective-canonical-plan.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'test',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'user_test',
  role: 'standard_user',
};
const clientId = '33333333-3333-4333-8333-333333333333';
const objectiveId = '44444444-4444-4444-8444-444444444444';
const requestId = '88888888-8888-4888-8888-888888888888';
const now = new Date('2026-10-10T12:00:00Z');
const record: ClientObjective = {
  id: objectiveId,
  tenantId: ctx.tenantId,
  clientId,
  outcome: 'Extend authority',
  clientRequestId: requestId,
  createRequestHash: '',
  governmentProblem: 'Authority expires',
  askType: 'policy_authority',
  minimumWin: 'Extend one year',
  limits: '',
  ownerUserId: ctx.userId,
  createdByUserId: ctx.userId,
  status: 'draft',
  version: 1,
  readyAt: null,
  reviewRequestedAt: null,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
};

function setup(current: ClientObjective = record) {
  let createdRecord = current;
  const sqlState = {
    authorized: true,
    memoryWall: false,
    grant: true,
    revisions: [] as Array<Record<string, unknown>>,
    intents: [] as Array<Record<string, unknown>>,
    canonical: null as CanonicalObjectivePlanToken | null,
  };
  const tx = {
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
    client: { findFirst: jest.fn().mockResolvedValue({ id: clientId }) },
    tenantMembership: { findFirst: jest.fn().mockResolvedValue({ id: 'active-member' }) },
    clientObjective: {
      findFirst: jest.fn().mockResolvedValue(current),
      findMany: jest.fn().mockResolvedValue([current]),
      createMany: jest
        .fn()
        .mockImplementation(async ({ data }: { data: Partial<ClientObjective> }) => {
          createdRecord = { ...current, ...data };
          return { count: 1 };
        }),
      findFirstOrThrow: jest.fn(async () => createdRecord),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    clientObjectiveRevision: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const revision = {
          ...data,
          id: `77777777-7777-4777-8777-${String(sqlState.revisions.length + 1).padStart(12, '0')}`,
          createdAt: now,
        };
        sqlState.revisions.push(revision);
        return revision;
      }),
    },
    $queryRaw: jest.fn(),
  };
  tx.$queryRaw.mockImplementation(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join('?');
    const revision = sqlState.revisions.at(-1);
    if (sql.includes('FROM tenants t')) {
      expect(values).toEqual([ctx.tenantId, ctx.userId, ctx.clerkUserId, clientId]);
      return sqlState.authorized ? [{ userId: ctx.userId, memoryWall: sqlState.memoryWall }] : [];
    }
    if (sql.includes('FROM client_memory_access')) {
      expect(values).toEqual([ctx.tenantId, clientId, ctx.userId]);
      return sqlState.grant ? [{ id: 'synthetic-current-wall-grant' }] : [];
    }
    if (sql.includes('SELECT version FROM client_objectives')) {
      expect(values).toEqual([ctx.tenantId, clientId, objectiveId]);
      return revision ? [{ version: revision.version }] : [];
    }
    if (sql.includes('SELECT id FROM client_objective_revisions')) {
      expect(values).toEqual([ctx.tenantId, clientId, objectiveId, revision?.version]);
      return revision ? [{ id: revision.id }] : [];
    }
    if (sql.includes('INSERT INTO client_objective_work_intents')) {
      const intent = {
        id: values[0],
        tenantId: values[1],
        clientId: values[2],
        objectiveId: values[3],
        objectiveRevisionId: values[4],
        objectiveVersion: values[5],
        actorUserId: values[6],
        purpose: values[7],
        snapshotHash: values[8],
        state: 'pending',
        blockedReason: values[9],
      };
      sqlState.intents.push(intent);
      return [{ id: intent.id }];
    }
    if (sql.includes('FROM client_objective_work_intents i')) {
      const intent = sqlState.intents.find(
        (row) =>
          row.id === values[0] &&
          row.tenantId === values[1] &&
          row.clientId === values[2] &&
          row.objectiveId === values[3],
      );
      const saved = sqlState.revisions.find((row) => row.id === intent?.objectiveRevisionId);
      return intent && saved
        ? [
            {
              ...intent,
              revisionActorUserId: saved.actorUserId,
              revisionOperation: saved.operation,
              revisionSnapshot: saved.snapshot,
            },
          ]
        : [];
    }
    if (sql.includes('FROM client_objective_work_intents')) {
      return sqlState.intents.filter(
        (row) =>
          row.tenantId === values[0] &&
          row.clientId === values[1] &&
          row.objectiveId === values[2] &&
          row.objectiveRevisionId === values[3] &&
          row.purpose === values[4],
      );
    }
    if (sql.includes('INSERT INTO client_objective_canonical_plans')) {
      sqlState.canonical = {
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
      return [{ id: sqlState.canonical.canonicalPlanId }];
    }
    if (sql.includes('UPDATE client_objective_canonical_plans')) {
      const previous = sqlState.canonical!;
      expect(values.slice(4)).toEqual([
        previous.canonicalPlanId,
        ctx.tenantId,
        clientId,
        objectiveId,
        previous.bindingVersion,
        previous.epoch,
        previous.canonicalStrategyId,
        previous.canonicalProjectId,
        previous.requestedIntentId,
        previous.requestedObjectiveRevisionId,
        previous.requestedObjectiveVersion,
        previous.snapshotHash,
      ]);
      sqlState.canonical = {
        ...previous,
        requestedIntentId: values[0] as string,
        requestedObjectiveRevisionId: values[1] as string,
        requestedObjectiveVersion: values[2] as number,
        snapshotHash: values[3] as string,
        bindingVersion: previous.bindingVersion + 1,
      };
      return [{ id: previous.canonicalPlanId, bindingVersion: sqlState.canonical.bindingVersion }];
    }
    if (sql.includes('FROM client_objective_canonical_plans')) {
      expect(values).toEqual([ctx.tenantId, clientId, objectiveId]);
      return sqlState.canonical ? [{ ...sqlState.canonical }] : [];
    }
    throw new Error('Unrecognized synthetic Objective SQL');
  });
  const prisma = {
    withTenant: jest.fn(async (_tenant: string, run: (value: typeof tx) => Promise<unknown>) =>
      run(tx),
    ),
  };
  // This fixture supplies the transaction operations used by the service.
  // Native constraints/RLS/concurrency remain a separate, unrun gate.
  const service = new ClientObjectivesService(prisma as unknown as PrismaService);
  return { service, tx, prisma, sqlState };
}

describe('ClientObjectivesService', () => {
  test('foreign or archived client refuses all access before Objective lookup', async () => {
    const { service, tx } = setup();
    tx.client.findFirst.mockResolvedValue(null);
    await expect(service.get(ctx, clientId, objectiveId)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.clientObjective.findFirst).not.toHaveBeenCalled();
  });

  test('all Objective reads bind tenant, client and nondeleted scope', async () => {
    const { service, tx, prisma } = setup();
    await service.get(ctx, clientId, objectiveId);
    expect(prisma.withTenant).toHaveBeenCalledWith(ctx.tenantId, expect.any(Function));
    expect(tx.clientObjective.findFirst).toHaveBeenCalledWith({
      where: { id: objectiveId, tenantId: ctx.tenantId, clientId, deletedAt: null },
    });
    tx.clientObjective.findFirst.mockResolvedValue(null);
    await expect(service.get(ctx, clientId, objectiveId)).rejects.toBeInstanceOf(NotFoundException);
  });

  test('foreign/inactive owner cannot be assigned', async () => {
    const { service, tx } = setup();
    tx.tenantMembership.findFirst.mockResolvedValue(null);
    await expect(
      service.create(ctx, clientId, { requestId, ownerUserId: 'other' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.clientObjective.createMany).not.toHaveBeenCalled();
  });

  test('creates an incomplete normalized draft and revision in the same tenant transaction', async () => {
    const { service, tx } = setup({
      ...record,
      outcome: 'A partial draft',
      governmentProblem: '',
      askType: null,
      minimumWin: '',
    });
    const result = await service.create(ctx, clientId, { requestId, outcome: ' A partial draft ' });
    expect(result.readiness.completedFields).toBe(1);
    expect(tx.clientObjective.createMany).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: ctx.tenantId,
        clientId,
        createdByUserId: ctx.userId,
        ownerUserId: ctx.userId,
        outcome: 'A partial draft',
        clientRequestId: requestId,
      }),
      skipDuplicates: true,
    });
    expect(tx.clientObjectiveRevision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: ctx.tenantId,
          objectiveId: result.id,
          version: 1,
          operation: 'create',
        }),
      }),
    );
  });

  test('retrying the same create request returns the stored draft without a second revision', async () => {
    const { service, tx } = setup();
    const first = await service.create(ctx, clientId, { requestId, outcome: 'New draft' });
    tx.clientObjective.createMany.mockResolvedValue({ count: 0 });
    const repeated = await service.create(ctx, clientId, { requestId, outcome: 'New draft' });
    expect(repeated.id).toBe(first.id);
    expect(tx.clientObjectiveRevision.create).toHaveBeenCalledTimes(1);
    await expect(
      service.create(ctx, clientId, { requestId, outcome: 'Different draft' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.clientObjectiveRevision.create).toHaveBeenCalledTimes(1);
  });

  test('rejects stale versions before writing', async () => {
    const { service, tx } = setup();
    await expect(
      service.update(ctx, clientId, objectiveId, 2, { outcome: 'Changed' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.clientObjective.updateMany).not.toHaveBeenCalled();
  });

  test('concurrent version winner prevents a second write and revision', async () => {
    const { service, tx } = setup();
    tx.clientObjective.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.update(ctx, clientId, objectiveId, 1, { outcome: 'Changed' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.clientObjectiveRevision.create).not.toHaveBeenCalled();
  });

  test('editing a ready Objective reopens Draft and clears readiness and review timestamps', async () => {
    const ready = { ...record, status: 'ready', readyAt: now };
    const { service, tx } = setup(ready);
    tx.clientObjective.findFirst
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce({ ...record, version: 2, outcome: 'Changed' });
    const result = await service.update(ctx, clientId, objectiveId, 1, { outcome: 'Changed' });
    expect(result.status).toBe('draft');
    expect(result.version).toBe(2);
    expect(tx.clientObjective.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ version: 1, tenantId: ctx.tenantId, clientId }),
        data: expect.objectContaining({
          status: 'draft',
          readyAt: null,
          reviewRequestedAt: null,
          version: { increment: 1 },
        }),
      }),
    );
  });

  test('four fields confirm Ready and a repeated current-version confirmation is inert', async () => {
    const { service, tx, sqlState } = setup();
    tx.clientObjective.findFirst
      .mockResolvedValueOnce(record)
      .mockResolvedValue({ ...record, version: 2, status: 'ready', readyAt: now });
    expect((await service.transition(ctx, clientId, objectiveId, 1, 'confirm_ready')).status).toBe(
      'ready',
    );
    const firstQueryCount = tx.$queryRaw.mock.calls.length;
    await service.transition(ctx, clientId, objectiveId, 2, 'confirm_ready');
    expect(tx.clientObjectiveRevision.create).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(firstQueryCount);
    const intentInserts = tx.$queryRaw.mock.calls.filter((call) =>
      call[0].join('').includes('INSERT INTO client_objective_work_intents'),
    );
    expect(intentInserts).toHaveLength(1);
    expect(intentInserts[0]!.slice(1)).toContain(sqlState.revisions[0]!.id);
    expect(
      tx.$queryRaw.mock.calls.filter((call) =>
        call[0].join('').includes('INSERT INTO client_objective_canonical_plans'),
      ),
    ).toHaveLength(1);
  });

  test('first confirmation binds actual saved revision/intent and reserves private IDs without changing response', async () => {
    const { service, tx, sqlState, prisma } = setup();
    tx.clientObjective.findFirst
      .mockResolvedValueOnce(record)
      .mockResolvedValue({ ...record, version: 2, status: 'ready', readyAt: now });
    const result = await service.transition(ctx, clientId, objectiveId, 1, 'confirm_ready');
    const saved = sqlState.revisions[0]!;
    const intent = sqlState.intents[0]!;
    expect(sqlState.canonical).toMatchObject({
      tenantId: ctx.tenantId,
      clientId,
      objectiveId,
      requestedIntentId: intent.id,
      requestedObjectiveRevisionId: saved.id,
      requestedObjectiveVersion: 2,
      snapshotHash: objectiveRevisionSnapshotHash(saved.snapshot as never),
      bindingVersion: 1,
      epoch: 1,
    });
    const canonical = sqlState.canonical!;
    expect(
      new Set([
        canonical.canonicalPlanId,
        canonical.canonicalStrategyId,
        canonical.canonicalProjectId,
      ]).size,
    ).toBe(3);
    expect(Object.keys(result).sort()).toEqual(
      [
        'id',
        'clientId',
        'requestId',
        'outcome',
        'governmentProblem',
        'askType',
        'minimumWin',
        'limits',
        'ownerUserId',
        'status',
        'version',
        'readyAt',
        'reviewRequestedAt',
        'createdAt',
        'updatedAt',
        'readiness',
      ].sort(),
    );
    expect(prisma.withTenant).toHaveBeenCalledTimes(1);
    const queries = tx.$queryRaw.mock.calls.map((call) => call[0].join(''));
    expect(queries[0]).toContain('FROM tenants t');
    expect(queries[2]).toContain('SELECT id FROM client_objective_revisions');
    expect(queries[3]).toContain('INSERT INTO client_objective_work_intents');
    expect(queries[5]).toContain('JOIN client_objective_revisions');
    expect(queries.at(-1)).toContain('FOR UPDATE');
  });

  test.each(['membership', 'wall'] as const)(
    'current %s refusal prevents intent and canonical reservation',
    async (scope) => {
      const { service, tx, sqlState } = setup();
      tx.clientObjective.findFirst
        .mockResolvedValueOnce(record)
        .mockResolvedValue({ ...record, version: 2, status: 'ready', readyAt: now });
      if (scope === 'membership') sqlState.authorized = false;
      else {
        sqlState.memoryWall = true;
        sqlState.grant = false;
      }
      await expect(
        service.transition(ctx, clientId, objectiveId, 1, 'confirm_ready'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(sqlState.intents).toEqual([]);
      expect(sqlState.canonical).toBeNull();
      expect(tx.$queryRaw.mock.calls.some((call) => call[0].join('').includes('INSERT INTO'))).toBe(
        false,
      );
      expect(
        tx.$queryRaw.mock.calls.some((call) =>
          call[0].join('').includes('FROM client_objective_canonical_plans'),
        ),
      ).toBe(false);
    },
  );

  test('editing then reconfirming requests the new actual revision while keeping canonical IDs and epoch', async () => {
    const { service, tx, sqlState } = setup();
    let live = { ...record };
    tx.clientObjective.findFirst.mockImplementation(async () => live);
    tx.clientObjective.updateMany.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => {
        const fields = { ...data };
        delete fields.version;
        live = { ...live, ...fields, version: live.version + 1 };
        return { count: 1 };
      },
    );
    await service.transition(ctx, clientId, objectiveId, 1, 'confirm_ready');
    const first = { ...sqlState.canonical! };
    const edited = await service.update(ctx, clientId, objectiveId, 2, {
      outcome: 'Revised preserved authority',
    });
    expect(edited.status).toBe('draft');
    expect(sqlState.canonical).toEqual(first);
    await service.transition(ctx, clientId, objectiveId, 3, 'confirm_ready');
    const latest = sqlState.revisions.at(-1)!;
    expect(sqlState.canonical).toEqual({
      ...first,
      bindingVersion: 2,
      requestedIntentId: sqlState.intents[1]!.id,
      requestedObjectiveRevisionId: latest.id,
      requestedObjectiveVersion: 4,
      snapshotHash: objectiveRevisionSnapshotHash(latest.snapshot as never),
    });
    expect(sqlState.canonical!.requestedObjectiveRevisionId).not.toBe(
      first.requestedObjectiveRevisionId,
    );
    expect(sqlState.canonical!.snapshotHash).not.toBe(first.snapshotHash);
    expect(sqlState.intents).toHaveLength(2);
    expect(sqlState.revisions).toHaveLength(3);
    expect(
      tx.$queryRaw.mock.calls.filter((call) =>
        call[0].join('').includes('INSERT INTO client_objective_canonical_plans'),
      ),
    ).toHaveLength(1);
    expect(
      tx.$queryRaw.mock.calls.filter((call) =>
        call[0].join('').includes('UPDATE client_objective_canonical_plans'),
      ),
    ).toHaveLength(1);
  });

  test('missing fields block review and Ready without writes', async () => {
    const { service, tx } = setup({ ...record, minimumWin: '' });
    for (const action of ['request_review', 'confirm_ready'] as const) {
      await expect(
        service.transition(ctx, clientId, objectiveId, 1, action),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(tx.clientObjective.updateMany).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  test('request_review and already-ready historical records never backfill an intent', async () => {
    const review = setup();
    review.tx.clientObjective.findFirst
      .mockResolvedValueOnce(record)
      .mockResolvedValue({ ...record, status: 'in_review', version: 2 });
    await review.service.transition(ctx, clientId, objectiveId, 1, 'request_review');
    expect(review.tx.clientObjectiveRevision.create).toHaveBeenCalledTimes(1);
    expect(review.tx.$queryRaw).not.toHaveBeenCalled();
    const ready = setup({ ...record, status: 'ready', readyAt: now });
    await ready.service.transition(ctx, clientId, objectiveId, 1, 'confirm_ready');
    expect(ready.tx.clientObjectiveRevision.create).not.toHaveBeenCalled();
    expect(ready.tx.$queryRaw).not.toHaveBeenCalled();
  });

  test('stale confirmation and a CAS loser do not create revision or intent', async () => {
    for (const stale of [true, false]) {
      const { service, tx } = setup();
      if (!stale) tx.clientObjective.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.transition(ctx, clientId, objectiveId, stale ? 2 : 1, 'confirm_ready'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.clientObjectiveRevision.create).not.toHaveBeenCalled();
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    }
  });

  test.each([
    'revision',
    'insert',
    'receipt',
    'authority',
    'canonical_insert',
    'canonical_receipt',
    'source_mismatch',
  ] as const)(
    '%s failure escapes the same transaction and synthetic rollback restores all state',
    async (stage) => {
      const { service, tx, prisma, sqlState } = setup();
      const durable = {
        objective: { ...record },
        revisions: [] as unknown[],
        intents: [] as unknown[],
        canonical: [] as unknown[],
      };
      tx.clientObjective.findFirst.mockImplementation(async () => durable.objective);
      tx.clientObjective.updateMany.mockImplementation(async () => {
        durable.objective = { ...record, version: 2, status: 'ready', readyAt: now };
        return { count: 1 };
      });
      const create = tx.clientObjectiveRevision.create.getMockImplementation()!;
      tx.clientObjectiveRevision.create.mockImplementation(async (input) => {
        if (stage === 'revision') throw new Error('synthetic revision failure');
        const saved = await create(input);
        durable.revisions.push(saved);
        return saved;
      });
      const query = tx.$queryRaw.getMockImplementation()!;
      tx.$queryRaw.mockImplementation(async (...args) => {
        const sql = (args[0] as TemplateStringsArray).join('');
        const intentInsert = sql.includes('INSERT INTO client_objective_work_intents');
        const intentReceipt =
          sql.includes('FROM client_objective_work_intents') && !sql.includes('JOIN');
        const canonicalInsert = sql.includes('INSERT INTO client_objective_canonical_plans');
        const canonicalRead = sql.includes('FROM client_objective_canonical_plans');
        if (intentInsert && stage === 'insert') throw new Error('synthetic insert failure');
        if (canonicalInsert && stage === 'canonical_insert')
          throw new Error('synthetic canonical insert failure');
        if (
          stage === 'source_mismatch' &&
          sql.includes('SELECT id FROM client_objective_revisions')
        )
          return [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }];
        const result = await query(...args);
        if (intentInsert) durable.intents.push(result);
        if (canonicalInsert) durable.canonical.push(result);
        if (intentReceipt && stage === 'receipt') return [];
        if (canonicalRead && sqlState.canonical && stage === 'canonical_receipt')
          return [{ ...sqlState.canonical, snapshotHash: 'f'.repeat(64) }];
        if (canonicalRead && sqlState.canonical && stage === 'authority')
          tx.client.findFirst.mockResolvedValue(null);
        return result;
      });
      // Explicit synthetic transactional storage; this proves callback placement
      // and error propagation, not real PostgreSQL rollback or concurrency.
      prisma.withTenant.mockImplementation(async (_tenant, run) => {
        const before = structuredClone(durable);
        const sqlBefore = structuredClone(sqlState);
        try {
          return await run(tx);
        } catch (error) {
          Object.assign(durable, before);
          Object.assign(sqlState, sqlBefore);
          throw error;
        }
      });
      await expect(
        service.transition(ctx, clientId, objectiveId, 1, 'confirm_ready'),
      ).rejects.toThrow();
      expect(durable).toEqual({ objective: record, revisions: [], intents: [], canonical: [] });
      expect(sqlState.revisions).toEqual([]);
      expect(sqlState.intents).toEqual([]);
      expect(sqlState.canonical).toBeNull();
      expect(prisma.withTenant).toHaveBeenCalledTimes(1);
    },
  );
});
