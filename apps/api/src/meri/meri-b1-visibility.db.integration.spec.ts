import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { EngagementService } from '../engagement/engagement.service.js';
import { ActionRecommendationReadService } from '../intelligence/actions/action-recommendation-read.service.js';
import { RepresentationResolverService } from '../clients/representation-resolver.service.js';
import { MeriToolsService } from './meri-tools.service.js';

/**
 * Disposable migrated-Postgres acceptance for Meri's client-wall reads.
 * Opt in only to the fixed loopback test database; never point at a tenant DB.
 * Example: MERI_B1_TEST_DATABASE_URL=postgresql://...@127.0.0.1:5498/b1_accept?schema=public
 */
const databaseUrl = process.env.MERI_B1_TEST_DATABASE_URL;
const parsed = databaseUrl ? new URL(databaseUrl) : null;
const isolated = Boolean(
  parsed?.protocol === 'postgresql:' &&
    parsed.hostname === '127.0.0.1' &&
    parsed.port === '5498' &&
    parsed.pathname === '/b1_accept' &&
    parsed.searchParams.get('schema') === 'public' &&
    parsed.username === 'b1_test' &&
    parsed.password.length > 0,
);
const describeDb = isolated ? describe : describe.skip;

describeDb('Meri B1 visibility on migrated disposable PostgreSQL', () => {
  const namespace = `meri-b1-${randomUUID()}`;
  const tenantId = randomUUID();
  const foreignTenantId = randomUUID();
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const foreignUserId = randomUUID();
  const publicClientId = randomUUID();
  const walledClientId = randomUUID();
  const foreignClientId = randomUUID();
  const grantId = randomUUID();
  const publicActionId = randomUUID();
  const walledActionId = randomUUID();
  const foreignActionId = randomUUID();
  const walledFacilityId = randomUUID();
  const researchIds = {
    publicMeeting: randomUUID(), walledMeeting: randomUUID(),
    publicThread: randomUUID(), walledThread: randomUUID(),
    publicMessage: randomUUID(), walledMessage: randomUUID(),
    publicNote: randomUUID(), walledNote: randomUUID(),
    directoryNote: randomUUID(), foreignDirectoryNote: randomUUID(),
  };

  const ctx = { tenantId, userId, role: 'standard_user' } as TenantContext;
  let db: PrismaService;
  let engagement: EngagementService;
  let actions: ActionRecommendationReadService;
  let representation: RepresentationResolverService;
  let resolveClient: (ctx: TenantContext, clientId: string, requireMemoryAccess: boolean) => Promise<string>;
  let searchResearch: (ctx: TenantContext, input: Record<string, unknown>) => Promise<{
    results: Array<{ type: string; id: string; clientId: string | null; scope?: string }>;
  }>;

  const task = (title: string, data: Record<string, unknown> = {}) =>
    db.engagementTask.create({
      data: {
        tenantId,
        title,
        clientId: publicClientId,
        createdByUserId: userId,
        ownerUserId: userId,
        dueDate: new Date('2026-10-02T00:00:00.000Z'),
        ...data,
      } as never,
    });

  beforeAll(async () => {
    db = new PrismaService({ datasources: { db: { url: databaseUrl } } });
    await db.$connect();
    await db.tenant.createMany({ data: [
      { id: tenantId, slug: `${namespace}-a`, name: namespace, status: 'active' },
      { id: foreignTenantId, slug: `${namespace}-b`, name: `${namespace}-foreign`, status: 'active' },
    ] });
    await db.user.createMany({ data: [
      { id: userId, clerkUserId: `${namespace}-user`, email: `${namespace}-a@example.invalid` },
      { id: otherUserId, clerkUserId: `${namespace}-other`, email: `${namespace}-other@example.invalid` },
      { id: foreignUserId, clerkUserId: `${namespace}-foreign`, email: `${namespace}-foreign@example.invalid` },
    ] });
    await db.client.createMany({ data: [
      { id: publicClientId, tenantId, name: `${namespace} public`, status: 'active', memoryWall: false },
      { id: walledClientId, tenantId, name: `${namespace} walled`, status: 'active', memoryWall: true },
      { id: foreignClientId, tenantId: foreignTenantId, name: `${namespace} foreign`, status: 'active', memoryWall: false },
    ] });
    await db.clientMemoryAccess.create({
      data: { id: grantId, tenantId, clientId: walledClientId, userId, grantedBy: userId },
    });

    const actionData = (id: string, clientId: string, actionTenantId = tenantId) => ({
      id, tenantId: actionTenantId, clientId, actionType: 'restore_cut',
      issueTitle: `${namespace} ${id}`, whatChanged: 'Changed',
      whyItMatters: 'Matters', recommendedAction: 'Act',
      priority: 50, status: 'new',
    });
    await db.actionRecommendation.createMany({ data: [
      actionData(publicActionId, publicClientId),
      actionData(walledActionId, walledClientId),
      actionData(foreignActionId, foreignClientId, foreignTenantId),
    ] });

    await task('public-task');
    await task('walled-task', { clientId: walledClientId });
    await task('owned-clientless-task', { clientId: null });
    await task('other-clientless-task', { clientId: null, createdByUserId: otherUserId, ownerUserId: otherUserId });
    await task('foreign-task', { tenantId: foreignTenantId, clientId: foreignClientId });

    const privateMeeting = await db.meeting.create({ data: {
      tenantId, clientId: publicClientId, subject: 'Private linked meeting',
      startsAt: new Date('2026-10-01T10:00:00.000Z'),
      endsAt: new Date('2026-10-01T11:00:00.000Z'),
      createdByUserId: otherUserId, visibility: 'private',
    } });
    await task('private-meeting-task', {
      meetingId: privateMeeting.id,
      dueDate: new Date('2026-10-01T00:00:00.000Z'),
    });

    const otherConnection = await db.integrationConnection.create({ data: {
      tenantId, provider: 'manual', createdByUserId: otherUserId,
    } });
    const privateThread = await db.mailThread.create({ data: {
      tenantId, clientId: publicClientId, connectionId: otherConnection.id,
      subject: 'Other mailbox',
    } });
    await db.mailMessage.create({ data: { tenantId, threadId: privateThread.id } });
    await task('other-mail-task', { mailThreadId: privateThread.id });

    await db.meeting.createMany({ data: [
      { id: researchIds.publicMeeting, tenantId, clientId: publicClientId,
        subject: `${namespace} public research meeting`, createdByUserId: userId,
        startsAt: new Date('2026-10-03T10:00:00.000Z'), endsAt: new Date('2026-10-03T11:00:00.000Z') },
      { id: researchIds.walledMeeting, tenantId, clientId: walledClientId,
        subject: `${namespace} walled research meeting`, createdByUserId: userId,
        startsAt: new Date('2026-10-04T10:00:00.000Z'), endsAt: new Date('2026-10-04T11:00:00.000Z') },
    ] });
    const ownConnection = await db.integrationConnection.create({ data: {
      tenantId, provider: 'manual', createdByUserId: userId,
    } });
    await db.mailThread.createMany({ data: [
      { id: researchIds.publicThread, tenantId, clientId: publicClientId,
        connectionId: ownConnection.id, subject: `${namespace} public research thread` },
      { id: researchIds.walledThread, tenantId, clientId: walledClientId,
        connectionId: ownConnection.id, subject: `${namespace} walled research thread` },
    ] });
    await db.mailMessage.createMany({ data: [
      { id: researchIds.publicMessage, tenantId, threadId: researchIds.publicThread,
        connectionId: ownConnection.id, subject: `${namespace} public research mail` },
      { id: researchIds.walledMessage, tenantId, threadId: researchIds.walledThread,
        connectionId: ownConnection.id, subject: `${namespace} walled research mail` },
    ] });
    await db.clioNote.createMany({ data: [
      { id: researchIds.publicNote, tenantId, userId, clientId: publicClientId,
        title: `${namespace} public research note`, body: 'Public research note' },
      { id: researchIds.walledNote, tenantId, userId, clientId: walledClientId,
        title: `${namespace} walled research note`, body: 'Walled research note' },
    ] });
    await db.directoryContactNote.createMany({ data: [
      { id: researchIds.directoryNote, tenantId, directoryContactId: `${namespace}-contact`,
        directoryContactName: `${namespace} tenant contact`, body: `${namespace} tenant-wide note`,
        createdByUserId: userId },
      { id: researchIds.foreignDirectoryNote, tenantId: foreignTenantId,
        directoryContactId: `${namespace}-foreign-contact`,
        directoryContactName: `${namespace} foreign contact`, body: `${namespace} foreign-tenant note`,
        createdByUserId: foreignUserId },
    ] });

    const walledContact = await db.engagementContact.create({ data: {
      tenantId, clientId: walledClientId, fullName: 'Walled contact',
    } });
    await task('walled-contact-task', { contactId: walledContact.id });

    await db.clientFacility.create({ data: {
      id: walledFacilityId, tenantId, clientId: walledClientId,
      name: 'Walled facility', city: 'Washington', state: null,
    } });

    engagement = Object.create(EngagementService.prototype) as EngagementService;
    (engagement as unknown as { prisma: PrismaService }).prisma = db;
    actions = new ActionRecommendationReadService(db);
    representation = new RepresentationResolverService(db);
    const meri = Object.create(MeriToolsService.prototype) as MeriToolsService;
    (meri as unknown as { prisma: PrismaService }).prisma = db;
    resolveClient = (meri as unknown as { ensureClientVisible: typeof resolveClient })
      .ensureClientVisible.bind(meri);
    searchResearch = (meri as unknown as { searchResearchSources: typeof searchResearch })
      .searchResearchSources.bind(meri);
  }, 120_000);

  beforeEach(async () => {
    await db.clientMemoryAccess.upsert({
      where: { tenantId_clientId_userId: { tenantId, clientId: walledClientId, userId } },
      create: { id: randomUUID(), tenantId, clientId: walledClientId, userId, grantedBy: userId },
      update: {},
    });
    await db.actionRecommendation.updateMany({
      where: { id: walledActionId }, data: { status: 'new', ownerUserId: null },
    });
  });

  afterAll(async () => {
    if (!db) return;
    // updateStatus/updateOwner emit append-only audit rows. Their trigger
    // correctly rejects cascade deletion of this fixture's tenant; the exact
    // database guard above requires a disposable database instead.
    await db.$disconnect();
  }, 120_000);

  test('research search removes wall-denied client-linked rows before result limiting', async () => {
    const visibleIds = [walledClientId, researchIds.walledMeeting, researchIds.walledThread,
      researchIds.walledMessage, researchIds.walledNote];
    const before = await searchResearch(ctx, { query: namespace, limit: 25 });
    for (const id of visibleIds) expect(before.results.map((row) => row.id)).toContain(id);
    expect(before.results.map((row) => row.id)).toContain(publicClientId);
    expect(before.results.some((row) => row.clientId === foreignClientId)).toBe(false);
    expect(before.results).toContainEqual(expect.objectContaining({
      type: 'directory_contact_note', id: researchIds.directoryNote,
      clientId: null, scope: 'tenant_wide_directory',
    }));
    expect(before.results.map((row) => row.id)).not.toContain(researchIds.foreignDirectoryNote);
    const selected = await searchResearch(ctx, { query: namespace, clientId: walledClientId, limit: 25 });
    expect(selected.results).toContainEqual(expect.objectContaining({
      type: 'directory_contact_note', id: researchIds.directoryNote,
      clientId: null, scope: 'tenant_wide_directory',
    }));
    expect(selected.results.map((row) => row.id)).not.toContain(researchIds.foreignDirectoryNote);

    await db.clientMemoryAccess.deleteMany({ where: { tenantId, clientId: walledClientId, userId } });
    const after = await searchResearch(ctx, { query: namespace, limit: 25 });
    for (const id of visibleIds) expect(after.results.map((row) => row.id)).not.toContain(id);
    expect(after.results.map((row) => row.id)).toContain(publicClientId);
    expect(after.results).toContainEqual(expect.objectContaining({
      type: 'directory_contact_note', id: researchIds.directoryNote,
      clientId: null, scope: 'tenant_wide_directory',
    }));
    expect(after.results.map((row) => row.id)).not.toContain(researchIds.foreignDirectoryNote);
    await expect(searchResearch(ctx, { query: namespace, clientId: walledClientId }))
      .rejects.toBeInstanceOf(NotFoundException);
    const firstPage = await searchResearch(ctx, { query: namespace, limit: 1 });
    expect(firstPage.results.every((row) => row.clientId !== walledClientId)).toBe(true);
  });

  test('omitted-client tasks exclude denied and linked-private records before limit', async () => {
    const rows = await engagement.listTasks(ctx, { limit: 50 });
    expect(rows.map((row) => row.title).sort()).toEqual([
      'owned-clientless-task', 'public-task', 'walled-contact-task', 'walled-task',
    ]);
    const firstPage = await engagement.listTasks(ctx, { limit: 1 });
    expect(firstPage).toHaveLength(1);
    expect(firstPage[0]?.title).not.toBe('private-meeting-task');
    expect(rows.some((row) => row.title === 'foreign-task')).toBe(false);
  });

  test('explicit client and representation honor current grants and tenant', async () => {
    expect((await engagement.listTasks(ctx, { clientId: walledClientId })).map((row) => row.title))
      .toContain('walled-task');
    expect(await resolveClient(ctx, walledClientId, true)).toBe(walledClientId);
    expect(await representation.representationForClient(tenantId, walledClientId, userId))
      .toHaveLength(1);
    expect(await engagement.listTasks(ctx, { clientId: foreignClientId })).toEqual([]);
    await expect(resolveClient(ctx, foreignClientId, true)).rejects.toBeInstanceOf(NotFoundException);
    expect(await representation.representationForClient(tenantId, foreignClientId, userId))
      .toEqual([]);
  });

  test('action page and count share the live wall filter before pagination', async () => {
    const page = await actions.list(ctx, { limit: 1 });
    expect(page.total).toBe(2);
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.id).not.toBe(foreignActionId);
    await expect(actions.getOne(ctx, walledActionId)).resolves.toMatchObject({ id: walledActionId });
    await expect(actions.getOne(ctx, foreignActionId)).rejects.toBeInstanceOf(NotFoundException);
  });

  test('a granted user can still read and update a walled action by id', async () => {
    expect((await actions.updateStatus(ctx, walledActionId, 'triaged')).status).toBe('triaged');
    expect((await actions.updateOwner(ctx, walledActionId, otherUserId)).ownerUserId)
      .toBe(otherUserId);
    expect((await actions.getOne(ctx, walledActionId)).status).toBe('triaged');
  });

  test('revocation removes task, representation, action content, count and known-id access', async () => {
    await db.clientMemoryAccess.deleteMany({ where: { tenantId, clientId: walledClientId, userId } });
    const tasks = await engagement.listTasks(ctx, { limit: 50 });
    expect(tasks.map((row) => row.title)).not.toContain('walled-task');
    expect(tasks.map((row) => row.title)).not.toContain('walled-contact-task');
    expect(await engagement.listTasks(ctx, { clientId: walledClientId })).toEqual([]);
    await expect(resolveClient(ctx, walledClientId, true)).rejects.toBeInstanceOf(NotFoundException);
    expect(await representation.representationForClient(tenantId, walledClientId, userId))
      .toEqual([]);
    const page = await actions.list(ctx, { limit: 1 });
    expect(page.total).toBe(1);
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.id).toBe(publicActionId);
    await expect(actions.getOne(ctx, walledActionId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(actions.updateStatus(ctx, walledActionId, 'triaged'))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(actions.updateOwner(ctx, walledActionId, otherUserId))
      .rejects.toBeInstanceOf(NotFoundException);
    expect((await db.actionRecommendation.findUnique({ where: { id: walledActionId } }))?.status)
      .toBe('new');
  });
});
