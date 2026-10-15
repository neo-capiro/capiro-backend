import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { ClientObjective } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClientObjectivesService } from './objectives.service.js';
import { objectiveRevisionSnapshotHash } from './objective-work-intent.js';

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
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        id: '77777777-7777-4777-8777-777777777777',
        createdAt: now,
      })),
    },
    $queryRaw: jest.fn(),
  };
  tx.$queryRaw.mockImplementation(async (sql: TemplateStringsArray) => {
    const intentId = '99999999-9999-4999-8999-999999999999';
    if (sql.join('').includes('INSERT INTO')) return [{ id: intentId }];
    const { data } = tx.clientObjectiveRevision.create.mock.calls.at(-1)![0];
    return [
      {
        id: intentId,
        tenantId: data.tenantId,
        clientId: data.clientId,
        objectiveId: data.objectiveId,
        objectiveRevisionId: '77777777-7777-4777-8777-777777777777',
        objectiveVersion: data.version,
        actorUserId: data.actorUserId,
        snapshotHash: objectiveRevisionSnapshotHash(data.snapshot as never),
        purpose: 'objective_strategy_plan',
        state: 'pending',
        blockedReason: 'runtime_authority_unconnected',
      },
    ];
  });
  const prisma = {
    withTenant: jest.fn(async (_tenant: string, run: (value: typeof tx) => Promise<unknown>) =>
      run(tx),
    ),
  };
  // This fixture supplies the exact transaction operations used by the service;
  // separate SQL tests verify real constraints. It is not a live Prisma client.
  const service = new ClientObjectivesService(prisma as unknown as PrismaService);
  return { service, tx, prisma };
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
    const { service, tx } = setup();
    tx.clientObjective.findFirst
      .mockResolvedValueOnce(record)
      .mockResolvedValue({ ...record, version: 2, status: 'ready', readyAt: now });
    expect((await service.transition(ctx, clientId, objectiveId, 1, 'confirm_ready')).status).toBe(
      'ready',
    );
    await service.transition(ctx, clientId, objectiveId, 2, 'confirm_ready');
    expect(tx.clientObjectiveRevision.create).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw.mock.calls[0]!.slice(1)).toContain('77777777-7777-4777-8777-777777777777');
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

  test.each(['revision', 'insert', 'receipt', 'authority'] as const)(
    '%s failure escapes the same transaction and synthetic rollback restores all state',
    async (stage) => {
      const { service, tx, prisma } = setup();
      const durable = {
        objective: { ...record },
        revisions: [] as unknown[],
        intents: [] as unknown[],
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
        const insert = (args[0] as TemplateStringsArray).join('').includes('INSERT INTO');
        if (insert && stage === 'insert') throw new Error('synthetic insert failure');
        const result = await query(...args);
        if (insert) durable.intents.push(result);
        if (!insert && stage === 'receipt') return [];
        if (!insert && stage === 'authority') tx.client.findFirst.mockResolvedValue(null);
        return result;
      });
      // Explicit synthetic transactional storage; this proves callback placement
      // and error propagation, not real PostgreSQL rollback or concurrency.
      prisma.withTenant.mockImplementation(async (_tenant, run) => {
        const before = structuredClone(durable);
        try {
          return await run(tx);
        } catch (error) {
          Object.assign(durable, before);
          throw error;
        }
      });
      await expect(
        service.transition(ctx, clientId, objectiveId, 1, 'confirm_ready'),
      ).rejects.toThrow();
      expect(durable).toEqual({ objective: record, revisions: [], intents: [] });
      expect(prisma.withTenant).toHaveBeenCalledTimes(1);
    },
  );
});
