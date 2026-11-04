import { ClientTargetRecommendationsService } from '../client-target-recommendations.service.js';
import { assertFillExecution, runWithFillTask } from '../client-profile-fill-execution.js';
const ctx = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  clerkUserId: 'clerk_fixture',
  tenantSlug: 'fixture',
  role: 'standard_user',
} as const;
const clientId = '30000000-0000-4000-8000-000000000003';
it('does not publish a late ranking cache after its durable task scope ends', async () => {
  let release!: (value: unknown[]) => void;
  const ranking = new Promise<unknown[]>((resolve) => {
    release = resolve;
  });
  const tx = {
    client: { findFirst: jest.fn().mockResolvedValue({ id: clientId }) },
    clientTargetRecommendation: { upsert: jest.fn().mockResolvedValue({ computedAt: new Date() }) },
  };
  const prisma = { withTenant: jest.fn((_tenant, work) => work(tx)) };
  const intelligence = { computeOfficeRecommendations: jest.fn().mockReturnValue(ranking) };
  const service = new ClientTargetRecommendationsService(prisma as never, intelligence as never);
  let pending!: ReturnType<typeof service.getRecommendations>;
  await runWithFillTask(
    ctx,
    { id: 'task', runId: 'run', tenantId: ctx.tenantId, clientId, workerId: 'worker' },
    'core',
    async () => {
      pending = service.getRecommendations(ctx, clientId, {
        refresh: true,
        beforeWrite: async (transaction) => {
          await assertFillExecution(transaction, ctx.tenantId, clientId);
        },
      });
      await Promise.resolve();
    },
  );
  release([]);
  await expect(pending).rejects.toThrow('no longer current');
  expect(tx.clientTargetRecommendation.upsert).not.toHaveBeenCalled();
});
