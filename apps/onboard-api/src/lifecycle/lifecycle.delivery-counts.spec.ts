import { LifecycleService } from './lifecycle.service.js';

const day = 86_400_000, now = new Date('2026-10-25T12:00:00Z');
describe('lifecycle delivery counts', () => {
  it.each(['disabled', 'outcome_unknown', 'failed', 'sending', 'sent'])
  ('counts only an SES acceptance for %s receipts', async (status) => {
    const recipient = { email: 'recipient@example.test' };
    const tx = { tenant: { findMany: jest.fn(async ({ where }) => [{
      id: 'synthetic-tenant', name: 'Synthetic organization', slug: 'synthetic',
      trialEndsAt: new Date(now.getTime() + 5 * day),
      createdAt: new Date(now.getTime() - 35 * day),
      canceledAt: new Date(now.getTime() - 84 * day),
    }]) }, tenantMembership: { findMany: jest.fn(async () => [{ userId: 'synthetic-user' }]) } };
    const prisma = {
      withSystem: jest.fn(async (fn) => fn(tx)), user: { findMany: jest.fn(async () => [recipient]) },
      onboardSession: { findUnique: jest.fn(async () => null) },
    };
    const email = { send: jest.fn(async () => ({ sent: status === 'sent', skipped: false, status, sesMessageId: null })) };
    const service: any = new LifecycleService(prisma as never, {} as never, {} as never, email as never, {} as never);
    const summary = { remindersSent: 0, backstopNudges: 0, retentionWarnings: 0 };
    await service.sendTrialReminders(now, summary);
    await service.runNeverStartedBackstop(now, summary);
    await service.runRetention(now, summary);
    expect(email.send).toHaveBeenCalledTimes(3);
    expect(summary).toEqual({ remindersSent: status === 'sent' ? 1 : 0,
      backstopNudges: status === 'sent' ? 1 : 0, retentionWarnings: status === 'sent' ? 1 : 0 });
  });
});
