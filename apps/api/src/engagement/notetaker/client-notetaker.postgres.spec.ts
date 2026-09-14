import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { IntelligenceService } from '../../intelligence/intelligence.service.js';
import { EngagementService } from '../engagement.service.js';
import { NotetakerService } from './notetaker.service.js';

// Run against a disposable database initialized from schema.prisma and the
// client_notetaker_preferences migration; never the application's database.
const url = process.env.CLIENT_NOTETAKER_TEST_DATABASE_URL;
if (url) {
  const target = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/client_profiles_test') {
    throw new Error('Client notetaker integration tests require a local disposable client_profiles_test database');
  }
}
const integration = url ? describe : describe.skip;
integration('client notetaker PostgreSQL integration', () => {
  const prisma = new PrismaService({ datasources: { db: { url } } });
  const bot = {
    dispatchBot: jest.fn(async (_input: unknown): Promise<{ externalBotId: string; raw: object }> => ({ externalBotId: randomUUID(), raw: {} })),
    leaveCall: jest.fn(async (_id: string) => undefined),
  };
  // Use the real client association logic, with the rest of Engagement unused.
  const engagement = Object.create(EngagementService.prototype) as EngagementService;
  const policy = { assertExternalAction() {}, assertBackgroundOwner() {} };
  const service = new NotetakerService(prisma, bot as never, engagement,
    { get: () => 'https://us-west-2.recall.ai' } as never, policy as never);
  let ctx: TenantContext;
  let clientId: string;
  let otherUserId: string;

  beforeAll(async () => {
    await prisma.$connect(); process.env.NOTETAKER_ENABLED = 'true';
    // api-strategy owns this table; it is absent from the API Prisma schema.
    await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS sp_strategy (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, archived_at timestamptz)');
  });
  afterAll(async () => { await prisma.$disconnect(); delete process.env.NOTETAKER_ENABLED; });
  beforeEach(async () => {
    await prisma.clientNotetakerPreference.updateMany({ data: { enabled: false } });
    bot.dispatchBot.mockClear(); bot.leaveCall.mockClear();
    const tenantId = randomUUID();
    const userId = randomUUID(); otherUserId = randomUUID(); clientId = randomUUID();
    await prisma.withSystem(async (tx) => {
      await tx.tenant.create({ data: { id: tenantId, slug: tenantId, name: 'Test firm', status: 'active' } });
      await tx.user.createMany({ data: [userId, otherUserId].map((id) => ({ id, clerkUserId: id, email: `${id}@example.test` })) });
      await tx.tenantMembership.createMany({ data: [userId, otherUserId].map((id) => ({ tenantId, userId: id, role: 'standard_user', status: 'active' })) });
      await tx.client.create({ data: { id: clientId, tenantId, name: 'Test client', status: 'active', primaryContactEmail: 'client@example.test' } });
    });
    ctx = { tenantId, userId, clerkUserId: userId, tenantSlug: tenantId, role: 'standard_user' };
  });
  async function meeting(extra: Record<string, unknown> = {}) {
    return prisma.withTenant(ctx.tenantId, (tx) => tx.meeting.create({ data: {
      tenantId: ctx.tenantId, createdByUserId: ctx.userId, clientId, subject: 'Client meeting',
      startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 600_000),
      joinLink: 'https://meet.google.com/abc-defg-hij', visibility: 'private', ...extra,
    } }));
  }
  const consent = { authorizedToRecord: true, allPartiesWillBeNotified: true };

  test('preference persists and is private to the user and tenant', async () => {
    await service.enableClientPreference(ctx, clientId, consent);
    expect(await service.getClientPreference(ctx, clientId)).toEqual({ enabled: true, stopping: false });
    expect(await service.getClientPreference({ ...ctx, userId: otherUserId }, clientId)).toEqual({ enabled: false, stopping: false });
    await expect(service.getClientPreference({ ...ctx, tenantId: randomUUID() }, clientId)).rejects.toThrow('Client not found');
    await service.disableClientPreference(ctx, clientId);
    expect(await service.getClientPreference(ctx, clientId)).toEqual({ enabled: false, stopping: false });
  });

  test('two concurrent sends create exactly one bot', async () => {
    const m = await meeting();
    await service.enableClientPreference(ctx, clientId, consent);
    const preference = await prisma.clientNotetakerPreference.findFirstOrThrow({ where: { tenantId: ctx.tenantId } });
    const input = { ...consent, meetingUrl: m.joinLink! };
    const attempts = await Promise.allSettled([
      service.dispatch(ctx, m.id, input, preference), service.dispatch(ctx, m.id, input),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(bot.dispatchBot).toHaveBeenCalledTimes(1);
    expect(await prisma.meetingBotSession.count({ where: { meetingId: m.id } })).toBe(1);
  });

  test('turning off during dispatch removes the bot once its id is known', async () => {
    const m = await meeting();
    await service.enableClientPreference(ctx, clientId, consent);
    const preference = await prisma.clientNotetakerPreference.findFirstOrThrow({ where: { tenantId: ctx.tenantId } });
    let release!: () => void;
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => { started = resolve; });
    bot.dispatchBot.mockImplementationOnce(async () => {
      started(); await new Promise<void>((resolve) => { release = resolve; });
      return { externalBotId: 'in-flight-bot', raw: {} };
    });
    const pending = service.dispatch(ctx, m.id, { ...consent, meetingUrl: m.joinLink! }, preference);
    await inFlight;
    expect(await service.disableClientPreference(ctx, clientId)).toEqual({ enabled: false, stopping: true });
    release(); await pending;
    expect(bot.leaveCall).toHaveBeenCalledWith('in-flight-bot');
    expect(await service.getClientPreference(ctx, clientId)).toEqual({ enabled: false, stopping: false });
  });

  test('worker sees newly associated meetings and never re-adds a removed bot', async () => {
    await service.enableClientPreference(ctx, clientId, consent);
    const m = await meeting({ clientId: null, organizerEmail: 'client@example.test' });
    await meeting({ status: 'cancelled' });
    await meeting({ createdByUserId: otherUserId });
    await service.reconcileClientMeetings();
    expect(bot.dispatchBot).toHaveBeenCalledTimes(1);
    await service.remove(ctx, m.id);
    await service.reconcileClientMeetings();
    expect(bot.dispatchBot).toHaveBeenCalledTimes(1);
    await service.disableClientPreference(ctx, clientId);
    await meeting();
    await service.reconcileClientMeetings();
    expect(bot.dispatchBot).toHaveBeenCalledTimes(1);
  });

  test('portfolio counts private, shared and contact-associated client meetings within the local week', async () => {
    const from = '2026-09-07T04:00:00.000Z', to = '2026-09-14T04:00:00.000Z';
    await meeting({ startsAt: new Date(from) });
    await meeting({ startsAt: new Date('2026-09-14T03:59:59.999Z'), visibility: 'shared' });
    await meeting({ startsAt: new Date(from), clientId: null, organizerEmail: 'CLIENT@example.test' });
    await meeting({ startsAt: new Date(from), clientId: null, organizerEmail: 'client@example.test', associationSignals: { manual: true } });
    await meeting({ startsAt: new Date(to) });
    await meeting({ startsAt: new Date(from), status: 'canceled' });
    await meeting({ startsAt: new Date(from), createdByUserId: otherUserId });
    await meeting({ startsAt: new Date(from), clientId: null });
    const summary = await new IntelligenceService(prisma).getPortfolioSummary(ctx.tenantId, ctx.userId, { from, to });
    expect(summary.meetingsThisWeek).toBe(3);
  });
});
