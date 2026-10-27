import 'reflect-metadata';
import { ParseUUIDPipe } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service';
import { EngagementController } from './engagement.controller';

const ctx = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: '10000000-0000-4000-8000-000000000002',
} as TenantContext;
const id = '10000000-0000-4000-8000-000000000003';
const clientId = '10000000-0000-4000-8000-000000000004';
const date = new Date('2026-10-26T00:00:00.000Z');
function fixture(overrides: Record<string, unknown> = {}) {
  const row = {
    id,
    tenantId: ctx.tenantId,
    clientId: null,
    client: null,
    meetingId: null,
    contactId: null,
    mailThreadId: null,
    title: 'Current task',
    description: 'Private source content',
    ownerUserId: ctx.userId,
    createdByUserId: ctx.userId,
    status: 'todo',
    dueDate: date,
    sourceType: 'meri_approved_execution',
    sourceId: 'private-receipt-reference',
    createdAt: date,
    updatedAt: date,
    ...overrides,
  };
  const tx = {
    tenantMembership: { findFirst: jest.fn().mockResolvedValue({ id: 'membership' }) },
    client: { findFirst: jest.fn().mockResolvedValue({ id: clientId }) },
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
    engagementTask: {
      findMany: jest.fn().mockImplementation(async ({ where }) => (where.sourceType ? [] : [row])),
      findFirst: jest.fn().mockResolvedValue(row),
      count: jest.fn().mockResolvedValue(1),
    },
    clioArtifact: { findFirst: jest.fn().mockResolvedValue(null) },
    meeting: { findFirst: jest.fn() },
  };
  const withTenant = jest.fn(async (_tenant: string, fn: (tx: unknown) => unknown) => fn(tx));
  const service = Object.assign(Object.create(EngagementService.prototype), {
    prisma: { withTenant },
  }) as EngagementService;
  return { row, tx, service, withTenant };
}

describe('current EngagementTask receipt destination', () => {
  it.each(['todo', 'done', 'canceled'])(
    'reads exact %s task with only the public display fields',
    async (status) => {
      const { service, tx, withTenant } = fixture({ status });
      expect(await service.readTask(ctx, id)).toEqual({
        id,
        title: 'Current task',
        status,
        dueDate: date.toISOString(),
        clientId: null,
        client: null,
        updatedAt: date.toISOString(),
      });
      expect(withTenant).toHaveBeenCalledWith(ctx.tenantId, expect.any(Function));
      expect(tx.engagementTask.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id, tenantId: ctx.tenantId }),
        }),
      );
      const query = tx.engagementTask.findMany.mock.calls.find(
        ([arg]) => !arg.where.sourceType,
      )![0];
      expect(query.take).toBe(1);
      expect(query.skip).toBe(0);
      expect(query.where).not.toHaveProperty('status');
    },
  );
  it('admits unassigned General tasks created by the actor', async () => {
    await expect(fixture({ ownerUserId: null }).service.readTask(ctx, id)).resolves.toMatchObject({
      id,
    });
  });
  it('reads the current visible client task even if another user owns it', async () => {
    const { service, tx } = fixture({
      clientId,
      client: { id: clientId, name: 'Synthetic client' },
      ownerUserId: 'other',
    });
    await expect(service.readTask(ctx, id, clientId)).resolves.toMatchObject({ clientId });
    expect(tx.$queryRawUnsafe).toHaveBeenCalled();
  });
  it.each([
    { ownerUserId: 'other' },
    { ownerUserId: null, createdByUserId: 'other' },
    { tenantId: 'other' },
    { id: 'other' },
  ])('refuses a mismatched or unowned General task %j', async (overrides) => {
    await expect(fixture(overrides).service.readTask(ctx, id)).rejects.toThrow('Task not found');
  });
  it('refuses a stale client URL hint instead of displaying a moved task', async () => {
    await expect(fixture().service.readTask(ctx, id, clientId)).rejects.toThrow('Task not found');
  });
  it('requires active membership before querying the task', async () => {
    const { service, tx } = fixture();
    tx.tenantMembership.findFirst.mockResolvedValue(null);
    await expect(service.readTask(ctx, id)).rejects.toThrow('Active tenant membership required');
    expect(tx.engagementTask.findMany).not.toHaveBeenCalled();
  });
  it.each(['wall', 'archived'])('retains current %s refusal', async (kind) => {
    const { service, tx } = fixture({
      clientId,
      client: { id: clientId, name: 'Synthetic client' },
    });
    if (kind === 'wall') tx.$queryRawUnsafe.mockResolvedValue([{ allowed: false }]);
    else tx.client.findFirst.mockResolvedValue(null);
    await expect(service.readTask(ctx, id)).rejects.toThrow('Client not found');
  });
  it('withholds a task changed between candidate and current read', async () => {
    const { service, tx, row } = fixture();
    tx.engagementTask.findFirst.mockResolvedValue({ ...row, title: 'Changed' });
    await expect(service.readTask(ctx, id)).rejects.toThrow('Task not found');
  });
  it('withholds a task removed during read', async () => {
    const { service, tx } = fixture();
    tx.engagementTask.findFirst.mockResolvedValue(null);
    await expect(service.readTask(ctx, id)).rejects.toThrow('Task not found');
  });
  it('retains Portfolio source authority instead of treating the receipt as permission', async () => {
    const { service, tx } = fixture({ sourceType: 'research_portfolio_action' });
    await expect(service.readTask(ctx, id)).rejects.toThrow('Task source is no longer available');
    expect(tx.clioArtifact.findFirst).toHaveBeenCalled();
  });
  it('exposes only a no-store exact GET through the existing controller', async () => {
    const service = { readTask: jest.fn().mockResolvedValue({ id }) };
    const controller = Object.assign(Object.create(EngagementController.prototype), {
      service,
    }) as EngagementController;
    expect(Reflect.getMetadata('path', controller.task)).toBe('tasks/:id');
    expect(Reflect.getMetadata('method', controller.task)).toBe(0);
    expect(Reflect.getMetadata('__headers__', controller.task)).toContainEqual({
      name: 'Cache-Control',
      value: 'no-store',
    });
    await controller.task(ctx, id, { clientId });
    expect(service.readTask).toHaveBeenCalledWith(ctx, id, clientId);
    await expect(new ParseUUIDPipe().transform('wrong-id', { type: 'param' })).rejects.toThrow();
  });
});
