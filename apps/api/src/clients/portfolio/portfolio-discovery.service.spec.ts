jest.mock('../client-profile-fill-workflow.service.js', () => ({
  ClientProfileFillWorkflowService: class {},
}));
import { PortfolioDiscoveryService } from './portfolio-discovery.service.js';
const ctx = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  clerkUserId: 'fixture',
  tenantSlug: 'fixture',
  role: 'user_admin',
} as const;
const clientId = '30000000-0000-4000-8000-000000000003';
const requestId = '40000000-0000-4000-8000-000000000004';
describe('durable capability discovery', () => {
  it('delegates the exact request id/source selection to the existing durable owner', async () => {
    const workflow = {
      startRun: jest.fn().mockResolvedValue({ id: requestId, status: 'running' }),
    };
    const store = { withClient: jest.fn(async (_ctx, _client, _write, work) => work({})) };
    const service = new PortfolioDiscoveryService(store as never, workflow as never);
    await service.discover(ctx, clientId, { requestId });
    await service.discover(ctx, clientId, { requestId });
    expect(workflow.startRun).toHaveBeenNthCalledWith(1, ctx, clientId, {
      requestId,
      sources: ['public_web'],
    });
    expect(workflow.startRun).toHaveBeenNthCalledWith(2, ctx, clientId, {
      requestId,
      sources: ['public_web'],
    });
  });
  it('preserves explicit document-only sources and does not broaden retry research', async () => {
    const workflow = { startRun: jest.fn().mockResolvedValue({ id: requestId }) };
    const store = { withClient: jest.fn(async (_ctx, _client, _write, work) => work({})) };
    const service = new PortfolioDiscoveryService(store as never, workflow as never);
    const input = {
      requestId,
      sources: [],
      attachmentIds: ['50000000-0000-4000-8000-000000000005'],
    };
    await service.discover(ctx, clientId, input);
    expect(workflow.startRun).toHaveBeenCalledWith(ctx, clientId, input);
  });
  it('pages a stable persisted candidate set without launching another task', async () => {
    const rows = [1, 2, 3].map((index) => ({
      id: `60000000-0000-4000-8000-00000000000${index}`,
      createdAt: new Date('2026-01-01'),
      reviewHistory: [],
    }));
    const tx = {
      clientPortfolioProposal: {
        findFirst: jest.fn().mockResolvedValue(rows[0]),
        findMany: jest.fn().mockResolvedValue(rows),
      },
    };
    const store = {
      withClient: jest.fn(async (_ctx, _client, _write, work) => work(tx)),
      validateEvidence: jest.fn(),
      input: jest.fn().mockReturnValue({}),
    };
    const workflow = { startRun: jest.fn() };
    const service = new PortfolioDiscoveryService(store as never, workflow as never);
    const result = await service.results(ctx, clientId, { after: rows[0]!.id, limit: '2' });
    expect(result).toMatchObject({ hasMore: true, nextCursor: rows[1]!.id });
    expect(tx.clientPortfolioProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: ctx.tenantId, clientId, kind: 'capability' },
        cursor: { id: rows[0]!.id },
        skip: 1,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 3,
      }),
    );
    expect(workflow.startRun).not.toHaveBeenCalled();
  });
});
