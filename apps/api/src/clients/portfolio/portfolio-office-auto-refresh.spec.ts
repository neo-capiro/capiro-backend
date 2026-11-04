import { ForbiddenException } from '@nestjs/common';
import {
  PortfolioOfficeAutoRefresh,
  officeRefreshRequestId,
} from './portfolio-office-auto-refresh.js';
import { ClientProfileFillWorkflowService } from '../client-profile-fill-workflow.service.js';
const actor = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  clerkUserId: 'clerk_actual_current',
  tenantSlug: 'current-tenant',
  role: 'standard_user',
} as const;
const candidate = {
  ...actor,
  clientId: '30000000-0000-4000-8000-000000000003',
  cursor: 'client-cursor',
  localRevision: 'approved-terms',
};
function fixture() {
  const raw = jest
    .fn()
    .mockResolvedValueOnce([{ revision: 'source-a' }])
    .mockResolvedValueOnce([candidate]);
  const tx = { $queryRawUnsafe: raw };
  const exists = jest.fn().mockResolvedValue([]);
  const prisma = {
    withSystem: jest.fn((work) => work(tx)),
    withTenantUser: jest.fn((_tenant, _actor, work) => work({ $queryRawUnsafe: exists })),
  };
  const worker = new PortfolioOfficeAutoRefresh(prisma as never);
  const start = jest.fn().mockResolvedValue({ id: 'saved' }),
    report = jest.fn();
  return { worker, start, report, raw, exists };
}
describe('office updates reuse the durable worker', () => {
  const originalRefresh = process.env.CLIENT_PROFILE_FILL_AUTOMATIC_REFRESH_ENABLED;
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-11-04T12:00:00Z')));
  afterEach(() => {
    jest.useRealTimers();
    if (originalRefresh === undefined) delete process.env.CLIENT_PROFILE_FILL_AUTOMATIC_REFRESH_ENABLED;
    else process.env.CLIENT_PROFILE_FILL_AUTOMATIC_REFRESH_ENABLED = originalRefresh;
  });
  it('disables automatic admission before any reads without consuming the refresh cursor', async () => {
    process.env.CLIENT_PROFILE_FILL_AUTOMATIC_REFRESH_ENABLED = 'false';
    const f = fixture();
    await f.worker.enqueue(f.start, f.report);
    expect(f.raw).not.toHaveBeenCalled();
    expect(f.exists).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    delete process.env.CLIENT_PROFILE_FILL_AUTOMATIC_REFRESH_ENABLED;
    await f.worker.enqueue(f.start, f.report);
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it('enqueues with actual actor, bounded existing task, and stable source replay key', async () => {
    const f = fixture();
    await f.worker.enqueue(f.start, f.report);
    expect(f.start).toHaveBeenCalledWith(actor, candidate.clientId, {
      requestId: officeRefreshRequestId(candidate, 'source-a'),
      sources: ['bill_tracker'],
    });
    expect(f.raw.mock.calls[1]?.[0]).toContain("tm.status::text='active'");
    expect(f.raw.mock.calls[1]?.[0]).toContain('u.clerk_user_id AS "clerkUserId"');
    await f.worker.enqueue(f.start, f.report);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(officeRefreshRequestId(candidate, 'source-b')).not.toBe(
      officeRefreshRequestId(candidate, 'source-a'),
    );
    expect(officeRefreshRequestId({ ...candidate, userId: 'different' }, 'source-a')).not.toBe(
      officeRefreshRequestId(candidate, 'source-a'),
    );
  });
  it('does not restart an existing completed, failed, or cancelled run', async () => {
    const f = fixture();
    f.exists.mockResolvedValue([{ id: 'existing' }]);
    await f.worker.enqueue(f.start, f.report);
    expect(f.start).not.toHaveBeenCalled();
  });
  it('lets canonical start deny revoked access without substituting another actor', async () => {
    const f = fixture();
    f.start.mockRejectedValue(new ForbiddenException());
    await f.worker.enqueue(f.start, f.report);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.report).not.toHaveBeenCalled();
  });
  it('runs the actual bill_tracker branch before proposal refresh under the same actor', async () => {
    const gatherBillRecommendations = jest.fn().mockResolvedValue(2);
    const refreshAutomatically = jest.fn().mockResolvedValue(3);
    const workflow = new ClientProfileFillWorkflowService(
      {} as never,
      { gatherBillRecommendations } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { refreshAutomatically } as never,
    );
    const invoke = workflow as unknown as {
      executeTask: (ctx: typeof actor, task: unknown) => Promise<number>;
    };
    expect(
      await invoke.executeTask(actor, {
        taskType: 'bill_tracker',
        clientId: candidate.clientId,
        runId: 'run',
        input: {},
      }),
    ).toBe(2);
    expect(refreshAutomatically).toHaveBeenCalledWith(actor, candidate.clientId);
  });
});
