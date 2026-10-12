import { ClientActivityService } from './client-activity.service.js';
import {
  bearer,
  ctx,
  fixture,
  followInput,
  IDs,
} from '../../test/support/activity-command.fixture.js';

describe('canonical client activity ethical-wall boundary', () => {
  function setup() {
    const f = fixture();
    const tx = {
      ...f.tx,
      clientActivity: {
        ...f.tx.clientActivity,
        findMany: jest.fn(async () => []),
        update: jest.fn(async () => ({})),
        deleteMany: jest.fn(async () => ({ count: 1 })),
      },
      meeting: { findMany: jest.fn(async () => []) },
      engagementAttachment: { findMany: jest.fn(async () => []) },
      outreachRecord: { findMany: jest.fn(async () => []) },
    };
    const engagement = { listMailThreads: jest.fn(async () => []) };
    const prisma = { withTenant: jest.fn(async (_tenant: string, fn: (tx: any) => any) => fn(tx)) };
    return {
      ...f,
      tx,
      engagement,
      activitiesService: new ClientActivityService(prisma as any, engagement as any),
    };
  }
  it.each(['list', 'create', 'update', 'remove'] as const)(
    'denies %s before reading derived content or mutating a walled client',
    async (action) => {
      const f = setup();
      f.state.actorWall = false;
      const result =
        action === 'list'
          ? f.activitiesService.list(ctx, IDs.client)
          : action === 'create'
            ? f.activitiesService.create(ctx, IDs.client, { kind: 'note', title: 'Test' })
            : action === 'update'
              ? f.activitiesService.update(ctx, IDs.client, IDs.activity, { title: 'Changed' })
              : f.activitiesService.remove(ctx, IDs.client, IDs.activity);
      await expect(result).rejects.toThrow('Client not found');
      expect(f.tx.clientActivity.findMany).not.toHaveBeenCalled();
      expect(f.engagement.listMailThreads).not.toHaveBeenCalled();
      expect(f.tx.clientActivity.create).not.toHaveBeenCalled();
      expect(f.tx.clientActivity.update).not.toHaveBeenCalled();
      expect(f.tx.clientActivity.deleteMany).not.toHaveBeenCalled();
      expect(f.tx.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.any(String),
        IDs.tenant,
        IDs.client,
        IDs.actor,
      );
    },
  );
  it('preserves authorized legacy editing and deletion without deleting the durable command', async () => {
    const f = setup();
    await f.service.create(ctx, IDs.client, followInput, bearer);
    await f.activitiesService.update(ctx, IDs.client, IDs.activity, { title: 'Edited' });
    await f.activitiesService.remove(ctx, IDs.client, IDs.activity);
    expect(f.tx.clientActivity.update).toHaveBeenCalled();
    expect(f.tx.clientActivity.deleteMany).toHaveBeenCalled();
    expect(f.rows).toHaveLength(1);
  });
});
