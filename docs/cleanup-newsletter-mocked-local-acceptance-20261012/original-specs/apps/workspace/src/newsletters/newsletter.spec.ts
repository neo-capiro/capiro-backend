import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  defaultNewsletterConfig,
  governmentAffairsNewsletter,
  createNewsletterBlock,
  createNewsletterSection,
  newsletterBlockVisible,
  defaultNewsletterBrandKit,
} from '@capiro/shared/newsletter';
import { renderNewsletterDesign, newsletterSafeUrl } from '@capiro/shared/newsletter-render';
import { sanitizeNewsletterHtml, validateNewsletterDesign } from './newsletter-validation.js';
import { NewsletterService } from './newsletter.service.js';
const ctx = { tenantId: '11111111-1111-4111-8111-111111111111', clerkUserId: 'user_owner' };
const id = '22222222-2222-4222-8222-222222222222';
const makeRow = () => ({
  id,
  ...ctx,
  ownerId: ctx.clerkUserId,
  name: 'Weekly newsletter',
  revision: 3,
  status: 'draft',
  updatedAt: new Date(),
  config: defaultNewsletterConfig(),
  design: governmentAffairsNewsletter(),
});
function fixture() {
  const document = {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
    create: jest.fn(),
  };
  const stage = { upsert: jest.fn() };
  const library = { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn() };
  const reviewers = {
    findFirst: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    upsert: jest.fn(),
  };
  const comments = {
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    findFirst: jest.fn(),
  };
  const notifications = { create: jest.fn() };
  const imageEditor = { refine: jest.fn() };
  const htmlChecker = { available: jest.fn().mockReturnValue(true), check: jest.fn() };
  const assets = { create: jest.fn() };
  let storedWatchers: Array<{
    tenantId: string;
    documentId: string;
    rootId: string;
    userId: string;
  }> = [];
  const watchers = {
    findMany: jest.fn(async ({ where }) =>
      storedWatchers.filter(
        (item) =>
          item.rootId === where.rootId &&
          item.tenantId === where.tenantId &&
          item.documentId === where.documentId,
      ),
    ),
    deleteMany: jest.fn(async ({ where }) => {
      storedWatchers = storedWatchers.filter(
        (item) =>
          !(
            item.rootId === where.rootId &&
            item.tenantId === where.tenantId &&
            item.documentId === where.documentId
          ),
      );
    }),
    createMany: jest.fn(async ({ data }) => {
      storedWatchers.push(...data);
    }),
  };
  const emailRequests = { createMany: jest.fn() };
  const invitations = {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn().mockResolvedValue(null),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    update: jest.fn(),
    create: jest.fn(async ({ data }) => ({ id, ...data })),
  };
  const brandKit = {
    upsert: jest.fn().mockResolvedValue({
      payload: defaultNewsletterBrandKit(),
      revision: 1,
      updatedAt: new Date(),
    }),
  };
  const prisma = {
    wsNewsletterDocument: document,
    wsNewsletterStage: stage,
    wsNewsletterLibraryItem: library,
    wsNewsletterReviewer: reviewers,
    wsNewsletterComment: comments,
    wsNewsletterAsset: assets,
    wsNewsletterBrandKit: brandKit,
    wsNewsletterThreadWatcher: watchers,
    wsNewsletterReviewEmailRequest: emailRequests,
    wsNewsletterInvitation: invitations,
    $transaction: jest.fn(async (fn) =>
      fn({
        wsNewsletterDocument: document,
        wsNewsletterStage: stage,
        wsNewsletterComment: comments,
        wsNewsletterThreadWatcher: watchers,
        wsNewsletterReviewEmailRequest: emailRequests,
        wsNewsletterInvitation: invitations,
        wsNewsletterReviewer: reviewers,
        $queryRaw: jest.fn().mockResolvedValue([{ id }]),
      }),
    ),
  };
  const source = {
    resolveUserId: jest.fn(),
    getClient: jest.fn(),
    newsletterMembers: jest.fn().mockResolvedValue([]),
    newsletterMemberByEmail: jest.fn().mockResolvedValue(null),
    newsletterMember: jest
      .fn()
      .mockResolvedValue({ clerkUserId: ctx.clerkUserId, role: 'standard_user' }),
    userDisplays: jest.fn().mockResolvedValue(new Map()),
  };
  const service = new NewsletterService(
    prisma as never,
    source as never,
    {} as never,
    { get: () => 'https://app.capiro.ai' } as never,
    notifications as never,
    imageEditor as never,
    htmlChecker as never,
  );
  return {
    service,
    document,
    stage,
    source,
    library,
    reviewers,
    comments,
    notifications,
    imageEditor,
    htmlChecker,
    assets,
    watchers,
    emailRequests,
    invitations,
  };
}
describe('newsletter email invitations', () => {
  const requestKey = '77777777-7777-4777-8777-777777777777';
  function setup(active = true) {
    const f = fixture();
    f.document.findFirst.mockResolvedValue(makeRow());
    if (active)
      f.source.newsletterMemberByEmail.mockResolvedValue({
        clerkUserId: 'reviewer',
        email: 'reviewer@example.com',
        name: 'Policy reviewer',
        role: 'standard_user',
      });
    f.invitations.findFirst.mockImplementation(async ({ where }) =>
      where.id ? f.invitations.create.mock.results[0]?.value : null,
    );
    return f;
  }
  it('saves a normalized email, optional note and original source restrictions with ready access', async () => {
    const f = setup(),
      row = makeRow();
    row.config.clientId = id;
    f.document.findFirst.mockResolvedValue(row);
    f.source.getClient.mockResolvedValue({ wallAllowed: true });
    const result = await f.service.inviteByEmail(ctx, id, {
      email: ' Reviewer@Example.com ',
      role: 'editor',
      message: ' Check this bill. ',
      requestKey,
    });
    expect(result.invitation).toMatchObject({ email: 'reviewer@example.com', status: 'ready' });
    expect(f.invitations.create.mock.calls[0]![0].data).toMatchObject({
      authorId: ctx.clerkUserId,
      recipientId: 'reviewer',
      email: 'reviewer@example.com',
      role: 'editor',
      message: 'Check this bill.',
      requestKey,
      sourceClientIds: [id],
      activatedAt: expect.any(Date),
    });
    expect(f.reviewers.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { role: 'editor' } }),
    );
  });
  it('persists an outside-firm request without granting access or sending a notification', async () => {
    const f = setup(false);
    const result = await f.service.inviteByEmail(ctx, id, {
      email: 'new@example.com',
      role: 'viewer',
      requestKey,
    });
    expect(result.invitation.status).toBe('pending');
    expect(f.reviewers.upsert).not.toHaveBeenCalled();
    expect(f.notifications.create).not.toHaveBeenCalled();
    expect(f.invitations.create.mock.calls[0]![0].data).toMatchObject({
      recipientId: null,
      activatedAt: null,
      expiresAt: expect.any(Date),
    });
  });
  it('replays an accepted request without a second grant or notification and rejects changed details', async () => {
    const f = setup();
    const input = {
      email: 'reviewer@example.com',
      role: 'viewer' as const,
      message: 'Review.',
      requestKey,
    };
    await f.service.inviteByEmail(ctx, id, input);
    f.invitations.findUnique.mockResolvedValue(await f.invitations.create.mock.results[0]?.value);
    await f.service.inviteByEmail(ctx, id, input);
    expect(f.invitations.create).toHaveBeenCalledTimes(1);
    expect(f.notifications.create).toHaveBeenCalledTimes(1);
    await expect(
      f.service.inviteByEmail(ctx, id, { ...input, role: 'editor' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('rejects invalid input, self invitations and source access before writing', async () => {
    const f = setup();
    await expect(
      f.service.inviteByEmail(ctx, id, { email: 'bad', role: 'viewer', requestKey }),
    ).rejects.toBeInstanceOf(BadRequestException);
    f.source.newsletterMemberByEmail.mockResolvedValue({ clerkUserId: ctx.clerkUserId });
    await expect(
      f.service.inviteByEmail(ctx, id, { email: 'owner@example.com', role: 'viewer', requestKey }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.invitations.create).not.toHaveBeenCalled();
  });
});
describe('newsletter thread email subscriptions', () => {
  const rootId = '33333333-3333-4333-8333-333333333333';
  const replyId = '44444444-4444-4444-8444-444444444444';
  function setup() {
    const f = fixture();
    f.document.findFirst.mockResolvedValue(makeRow());
    f.source.newsletterMembers.mockResolvedValue([
      { clerkUserId: ctx.clerkUserId, name: 'Owner', email: 'owner@example.com' },
      { clerkUserId: 'reviewer', name: 'Policy reviewer', email: 'reviewer@example.com' },
    ]);
    f.reviewers.findMany.mockResolvedValue([
      { userId: 'reviewer', role: 'commenter', notifications: 'none' },
    ]);
    f.comments.findFirst.mockImplementation(async ({ where }) =>
      where.id === rootId
        ? { id: rootId, parentId: null, authorId: ctx.clerkUserId }
        : where.id === replyId
          ? { id: replyId, parentId: rootId, authorId: 'reviewer' }
          : null,
    );
    return f;
  }
  it('defaults a new thread to its author and does not email the author', async () => {
    const f = setup();
    expect(await f.service.threadNotifications(ctx, id)).toMatchObject({
      rootId: null,
      userIds: [ctx.clerkUserId],
      emailAvailable: false,
    });
    await f.service.addComment(ctx, id, { message: 'Review bill summary.' });
    const saved = f.comments.create.mock.calls[0][0].data;
    expect(f.watchers.createMany).toHaveBeenCalledWith({
      data: [{ tenantId: ctx.tenantId, documentId: id, rootId: saved.id, userId: ctx.clerkUserId }],
    });
    expect(f.emailRequests.createMany).not.toHaveBeenCalled();
  });
  it('deduplicates chosen users, snapshots source access and queues only other reviewers', async () => {
    const f = setup(),
      row = makeRow();
    row.config.clientId = id;
    f.document.findFirst.mockResolvedValue(row);
    f.source.getClient.mockResolvedValue({ wallAllowed: true });
    await f.service.addComment(ctx, id, {
      message: 'Private bill summary.',
      notifyUserIds: [ctx.clerkUserId, 'reviewer', 'reviewer'],
    });
    const saved = f.comments.create.mock.calls[0][0].data;
    expect(f.emailRequests.createMany).toHaveBeenCalledWith({
      data: [
        {
          tenantId: ctx.tenantId,
          documentId: id,
          rootId: saved.id,
          commentId: saved.id,
          recipientId: 'reviewer',
          sourceClientIds: [id],
        },
      ],
      skipDuplicates: true,
    });
    expect(f.notifications.create).not.toHaveBeenCalled(); // In-app preference is independent.
  });
  it('inherits subscriptions on replies and normalizes a nested reply to the root', async () => {
    const f = setup();
    await f.service.setThreadNotifications(ctx, id, rootId, [ctx.clerkUserId, 'reviewer']);
    f.watchers.deleteMany.mockClear();
    await f.service.addComment(ctx, id, { message: 'Confirmed.', parentId: replyId });
    expect(f.comments.create.mock.calls[0][0].data.parentId).toBe(rootId);
    expect(f.watchers.deleteMany).not.toHaveBeenCalled();
    expect(f.emailRequests.createMany.mock.calls[0][0].data[0]).toMatchObject({
      rootId,
      recipientId: 'reviewer',
    });
    expect(await f.service.threadNotifications(ctx, id, replyId)).toMatchObject({
      rootId,
      userIds: [ctx.clerkUserId, 'reviewer'],
    });
  });
  it('can unsubscribe every user without changing in-app preferences', async () => {
    const f = setup();
    await f.service.setThreadNotifications(ctx, id, rootId, ['reviewer']);
    expect(await f.service.setThreadNotifications(ctx, id, rootId, [])).toHaveProperty(
      'userIds',
      [],
    );
    await f.service.addComment(ctx, id, { message: 'Update.', parentId: rootId });
    expect(f.emailRequests.createMany).not.toHaveBeenCalled();
    expect(f.reviewers.upsert).not.toHaveBeenCalled();
  });
  it('rejects outsiders, missing threads, viewers and revoked client access before mutation', async () => {
    const f = setup();
    await expect(
      f.service.addComment(ctx, id, { message: 'Update.', notifyUserIds: ['outsider'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      f.service.setThreadNotifications(ctx, id, 'invalid-id', []),
    ).rejects.toBeInstanceOf(NotFoundException);
    f.document.findFirst.mockResolvedValue({ ...makeRow(), ownerId: 'someone_else' });
    f.reviewers.findFirst.mockResolvedValue({ role: 'viewer' });
    await expect(f.service.setThreadNotifications(ctx, id, rootId, [])).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const row = makeRow();
    row.config.clientId = id;
    f.document.findFirst.mockResolvedValue(row);
    f.source.resolveUserId.mockImplementation(async (user) => user);
    f.source.getClient.mockImplementation(async (_tenant, user) => ({
      wallAllowed: user !== 'reviewer',
    }));
    await expect(
      f.service.addComment(ctx, id, { message: 'Private.', notifyUserIds: ['reviewer'] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(f.comments.create).not.toHaveBeenCalled();
    expect(f.watchers.deleteMany).not.toHaveBeenCalled();
    expect(f.emailRequests.createMany).not.toHaveBeenCalled();
  });
});
describe('newsletter authoring boundary', () => {
  it('lets an active invited author edit, save a personal template and stage a private handoff', async () => {
    const f = fixture(),
      row = { ...makeRow(), ownerId: 'document_owner' };
    f.document.findFirst.mockResolvedValue(row);
    f.reviewers.findFirst.mockResolvedValue({ role: 'editor' });
    f.document.updateMany.mockResolvedValue({ count: 1 });
    f.library.create.mockImplementation(async ({ data }) => ({
      ...data,
      id,
      updatedAt: new Date(),
    }));
    f.stage.upsert.mockResolvedValue({ id, name: row.name, createdAt: new Date() });
    expect((await f.service.get(ctx, id)).ownerId).toBe('document_owner');
    await f.service.save(ctx, id, {
      revision: 3,
      name: 'Author revision',
      design: row.design,
      config: row.config,
    });
    const write = f.document.updateMany.mock.calls[0][0];
    expect(write.where).toMatchObject({
      tenantId: ctx.tenantId,
      ownerId: 'document_owner',
      revision: 3,
      reviewers: { some: { tenantId: ctx.tenantId, userId: ctx.clerkUserId, role: 'editor' } },
    });
    await f.service.saveLibrary(ctx, id, { name: 'My edited template' });
    expect(f.library.create.mock.calls[0][0].data.ownerId).toBe(ctx.clerkUserId);
    await f.service.stage(ctx, id, 3);
    expect(f.stage.upsert.mock.calls[0][0]).toMatchObject({
      where: {
        documentId_revision_ownerId: { documentId: id, revision: 3, ownerId: ctx.clerkUserId },
      },
      create: { ownerId: ctx.clerkUserId },
      update: {},
    });
  });
  it('keeps access administration with the document owner', async () => {
    const f = fixture();
    f.document.findFirst.mockResolvedValue({ ...makeRow(), ownerId: 'document_owner' });
    f.reviewers.findFirst.mockResolvedValue({ role: 'editor' });
    await expect(
      f.service.inviteReviewer(ctx, id, 'another_user', 'editor'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(f.service.removeReviewer(ctx, id, 'another_user')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(f.reviewers.upsert).not.toHaveBeenCalled();
  });
  it('refuses stale authors, inactive firm members and revoked source clients before authoring', async () => {
    const f = fixture(),
      row = { ...makeRow(), ownerId: 'document_owner' };
    f.document.findFirst.mockResolvedValue(row);
    f.reviewers.findFirst.mockResolvedValue({ role: 'viewer' });
    await expect(f.service.get(ctx, id)).rejects.toBeInstanceOf(NotFoundException);
    f.reviewers.findFirst.mockResolvedValue({ role: 'editor' });
    f.source.newsletterMember.mockResolvedValue(null);
    await expect(
      f.service.save(ctx, id, {
        revision: 3,
        name: 'Edit',
        design: row.design,
        config: row.config,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    f.source.newsletterMember.mockResolvedValue({
      clerkUserId: ctx.clerkUserId,
      role: 'standard_user',
    });
    row.config.clientId = id;
    f.source.getClient.mockResolvedValue({ wallAllowed: false });
    await expect(f.service.stage(ctx, id, 3)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.document.updateMany).not.toHaveBeenCalled();
    expect(f.stage.upsert).not.toHaveBeenCalled();
  });
  it('refuses an author save or stage whose revision or current grant lost the atomic write', async () => {
    const f = fixture(),
      row = { ...makeRow(), ownerId: 'document_owner' };
    f.document.findFirst.mockResolvedValue(row);
    f.reviewers.findFirst.mockResolvedValue({ role: 'editor' });
    f.document.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      f.service.save(ctx, id, {
        revision: 3,
        name: 'Edit',
        design: row.design,
        config: row.config,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(f.service.stage(ctx, id, 3)).rejects.toBeInstanceOf(ConflictException);
    expect(f.stage.upsert).not.toHaveBeenCalled();
  });
  it('flags unknown merge tags in block and social destinations and refuses to stage them', async () => {
    const f = fixture(),
      row = makeRow();
    row.design.sections = [
      createNewsletterSection('Body', [
        createNewsletterBlock('button', {
          text: '*|UNKNOWN|*',
          url: 'https://example.com/?name=*|UNKNOWN|*',
        }),
        createNewsletterBlock('social', {
          items: [
            { label: 'Known recipient', url: 'https://example.com/?name=*|FNAME|*' },
            { label: 'Unknown recipient', url: 'https://example.com/?name=*|OTHER|*' },
          ],
        }),
      ]),
    ];
    f.document.findFirst.mockResolvedValue(row);
    const errors = f.service
      .checks(row.design, row.config)
      .filter((check) => check.label === 'Unknown merge tag');
    expect(errors.map((check) => check.detail)).toEqual(['*|UNKNOWN|*', '*|OTHER|*']);
    await expect(f.service.stage(ctx, id, row.revision)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(f.stage.upsert).not.toHaveBeenCalled();
  });
  it('checks owner and revision before submitting HTML to the sandbox', async () => {
    const f = fixture();
    f.document.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(makeRow());
    await expect(f.service.htmlCheck(ctx, id, 3)).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service.htmlCheck(ctx, id, 2)).rejects.toBeInstanceOf(ConflictException);
    expect(f.htmlChecker.check).not.toHaveBeenCalled();
  });
  it('checks rendered HTML for the saved revision and rechecks access before returning the report', async () => {
    const f = fixture();
    f.document.findFirst.mockResolvedValue(makeRow());
    f.htmlChecker.check.mockResolvedValue({
      provider: 'Mailtrap',
      issues: [],
      report: { status: 'success', errors: [] },
    });
    const result = await f.service.htmlCheck(ctx, id, 3);
    expect(f.htmlChecker.check.mock.calls[0][0]).toContain('The week in policy.');
    expect(f.htmlChecker.check.mock.calls[0][0]).toContain(
      'https://app.capiro.ai/newsletter/capitol.png',
    );
    expect(result).toMatchObject({ provider: 'Mailtrap', revision: 3, issues: [] });
    expect(f.document.findFirst).toHaveBeenCalledTimes(2);
    f.document.findFirst.mockResolvedValueOnce(makeRow()).mockResolvedValueOnce(null);
    await expect(f.service.htmlCheck(ctx, id, 3)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('rejects another owner before sending an image to OpenAI', async () => {
    const f = fixture();
    f.document.findFirst.mockResolvedValue(null);
    await expect(
      f.service.refineImage(ctx, id, { buffer: Buffer.alloc(0) }, { prompt: 'Edit' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(f.imageEditor.refine).not.toHaveBeenCalled();
  });
  it('rechecks access after generation before saving the image options', async () => {
    const f = fixture();
    f.document.findFirst.mockResolvedValueOnce(makeRow()).mockResolvedValueOnce(null);
    f.imageEditor.refine.mockResolvedValue([Buffer.alloc(0)]);
    await expect(
      f.service.refineImage(ctx, id, { buffer: Buffer.alloc(0) }, { prompt: 'Edit' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(f.assets.create).not.toHaveBeenCalled();
  });
  it('looks up a document by tenant and verifies its authenticated owner', async () => {
    const f = fixture();
    f.document.findFirst.mockResolvedValue(makeRow());
    await expect(f.service.get(ctx, id)).resolves.toHaveProperty('ownerId', ctx.clerkUserId);
    expect(f.document.findFirst).toHaveBeenCalledWith({
      where: { id, tenantId: ctx.tenantId },
    });
    expect(f.reviewers.findFirst).not.toHaveBeenCalled();
    f.reviewers.findFirst.mockResolvedValue(null);
    await expect(f.service.get({ ...ctx, clerkUserId: 'other_user' }, id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it('rechecks the client ethical wall before returning a document', async () => {
    const f = fixture();
    const row = makeRow();
    row.config.clientId = id;
    f.document.findFirst.mockResolvedValue(row);
    f.source.getClient.mockResolvedValue({ wallAllowed: false });
    await expect(f.service.get(ctx, id)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('rejects concurrent saves instead of overwriting the latest revision', async () => {
    const f = fixture();
    const row = makeRow();
    f.document.findFirst.mockResolvedValue(row);
    f.document.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      f.service.save(ctx, id, {
        revision: 2,
        name: row.name,
        design: row.design,
        config: row.config,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(f.document.updateMany.mock.calls[0][0].where).toEqual({
      id,
      tenantId: ctx.tenantId,
      ownerId: ctx.clerkUserId,
      revision: 2,
    });
  });
  it('stages only the saved revision, with an immutable snapshot and an Outreach route', async () => {
    const f = fixture();
    const row = makeRow();
    f.document.findFirst.mockResolvedValue(row);
    f.document.updateMany.mockResolvedValue({ count: 1 });
    f.stage.upsert.mockResolvedValue({ id, name: row.name, createdAt: new Date() });
    await expect(f.service.stage(ctx, id, 2)).rejects.toBeInstanceOf(ConflictException);
    expect(f.stage.upsert).not.toHaveBeenCalled();
    const result = await f.service.stage(ctx, id, 3);
    expect(result.route).toBe(`/engagement/outreach?newsletterStage=${id}`);
    const write = f.stage.upsert.mock.calls[0][0];
    expect(write.update).toEqual({});
    expect(write.create.design).toEqual(row.design);
    expect(write.create.html).toContain('The week in policy.');
    expect(write.create.html).toContain('https://app.capiro.ai/newsletter/capitol.png');
  });
  it('fails staging if the revision changed while the snapshot was rendering', async () => {
    const f = fixture();
    f.document.findFirst.mockResolvedValue(makeRow());
    f.document.updateMany.mockResolvedValue({ count: 0 });
    await expect(f.service.stage(ctx, id, 3)).rejects.toBeInstanceOf(ConflictException);
    expect(f.stage.upsert).not.toHaveBeenCalled();
  });
  it('retains source client restrictions when a copied design changes its client', async () => {
    const f = fixture();
    const row = makeRow();
    row.config.clientId = id;
    f.document.findFirst.mockResolvedValue(row);
    f.document.updateMany.mockResolvedValue({ count: 1 });
    f.source.getClient.mockResolvedValue({ wallAllowed: true });
    await f.service.save(ctx, id, {
      revision: 3,
      name: row.name,
      design: governmentAffairsNewsletter(),
      config: defaultNewsletterConfig(),
    });
    expect(f.document.updateMany.mock.calls[0][0].data.design.sourceClientIds).toContain(id);
  });
  it('hides saved templates and sections after access to their source client is revoked', async () => {
    const f = fixture();
    const design = governmentAffairsNewsletter();
    design.sourceClientIds = [id];
    f.library.findMany.mockResolvedValue([
      { id, name: 'Client layout', folder: '', updatedAt: new Date(), payload: { design } },
    ]);
    f.source.getClient.mockResolvedValue({ wallAllowed: false });
    expect((await f.service.library(ctx, 'template')).items).toEqual([]);
    const section = { ...design.sections[0], sourceClientIds: [id] };
    f.library.findMany.mockResolvedValue([
      { id, name: 'Client section', folder: '', updatedAt: new Date(), payload: section },
    ]);
    expect((await f.service.library(ctx, 'section')).items).toEqual([]);
  });
  it('does not let an uninvited teammate read a newsletter review', async () => {
    const f = fixture();
    f.document.findFirst.mockResolvedValue({ ...makeRow(), ownerId: 'another_owner' });
    f.reviewers.findFirst.mockResolvedValue(null);
    await expect(f.service.review(ctx, id)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.reviewers.findFirst).toHaveBeenCalledWith({
      where: { documentId: id, tenantId: ctx.tenantId, userId: ctx.clerkUserId },
    });
  });
  it('lets an invited viewer preview but refuses to create comments or author drafts', async () => {
    const f = fixture();
    f.document.findFirst.mockResolvedValue({ ...makeRow(), ownerId: 'another_owner' });
    f.reviewers.findFirst.mockResolvedValue({ role: 'viewer' });
    expect((await f.service.review(ctx, id)).html).toContain('The week in policy.');
    await expect(f.service.addComment(ctx, id, { message: 'Review' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    f.document.findFirst.mockResolvedValue(null);
    await expect(
      f.service.save(ctx, id, {
        revision: 3,
        name: 'Edit',
        design: governmentAffairsNewsletter(),
        config: defaultNewsletterConfig(),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
  it('rejects an invitation outside the active firm membership', async () => {
    const f = fixture();
    f.document.findFirst.mockResolvedValue(makeRow());
    await expect(
      f.service.inviteReviewer(ctx, id, 'outside_user', 'commenter'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.reviewers.upsert).not.toHaveBeenCalled();
  });
  it('creates comment notifications only for subscribed reviewers and mentions', async () => {
    const f = fixture();
    f.document.findFirst.mockResolvedValue(makeRow());
    f.source.newsletterMembers.mockResolvedValue([
      { clerkUserId: ctx.clerkUserId, name: 'Owner', email: 'owner@example.com' },
      { clerkUserId: 'mentioned', name: 'Policy reviewer', email: 'reviewer@example.com' },
      { clerkUserId: 'muted', name: 'Muted reviewer', email: 'muted@example.com' },
      { clerkUserId: 'other', name: 'Other reviewer', email: 'other@example.com' },
    ]);
    f.reviewers.findMany.mockResolvedValue([
      { userId: 'mentioned', role: 'commenter', notifications: 'mentions' },
      { userId: 'muted', role: 'commenter', notifications: 'none' },
      { userId: 'other', role: 'commenter', notifications: 'mentions' },
    ]);
    await f.service.addComment(ctx, id, { message: '@Policy reviewer Please verify the source.' });
    expect(f.notifications.create).toHaveBeenCalledTimes(1);
    expect(f.notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: ctx.tenantId,
        recipientId: 'mentioned',
        newsletterId: id,
        kind: 'newsletter_comment',
      }),
    );
  });
  it('checks the invited member’s client access before granting review access', async () => {
    const f = fixture();
    const row = makeRow();
    row.config.clientId = id;
    f.document.findFirst.mockResolvedValue(row);
    f.source.newsletterMembers.mockResolvedValue([
      { clerkUserId: 'reviewer', name: 'Reviewer', email: 'reviewer@example.com' },
    ]);
    f.source.getClient
      .mockResolvedValueOnce({ wallAllowed: true })
      .mockResolvedValueOnce({ wallAllowed: false });
    await expect(f.service.inviteReviewer(ctx, id, 'reviewer', 'commenter')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(f.reviewers.upsert).not.toHaveBeenCalled();
  });
  it('returns a committed comment when notification delivery fails', async () => {
    const f = fixture();
    f.document.findFirst.mockResolvedValue(makeRow());
    f.source.newsletterMembers.mockResolvedValue([
      { clerkUserId: 'reviewer', name: 'Reviewer', email: 'reviewer@example.com' },
    ]);
    f.reviewers.findMany.mockResolvedValue([
      { userId: 'reviewer', role: 'commenter', notifications: 'all' },
    ]);
    f.notifications.create.mockRejectedValue(new Error('Notification storage unavailable'));
    await expect(
      f.service.addComment(ctx, id, { message: 'Please review.' }),
    ).resolves.toHaveProperty('items');
    expect(f.comments.create).toHaveBeenCalledTimes(1);
  });
  it('does not notify a reviewer whose client access was revoked', async () => {
    const f = fixture();
    const row = makeRow();
    row.config.clientId = id;
    f.document.findFirst.mockResolvedValue(row);
    f.source.newsletterMembers.mockResolvedValue([
      { clerkUserId: 'reviewer', name: 'Reviewer', email: 'reviewer@example.com' },
    ]);
    f.reviewers.findMany.mockResolvedValue([
      { userId: 'reviewer', role: 'commenter', notifications: 'all' },
    ]);
    f.source.resolveUserId.mockImplementation(async (user: string) => user);
    f.source.getClient.mockImplementation(async (_tenant: string, user: string) => ({
      wallAllowed: user !== 'reviewer',
    }));
    await f.service.addComment(ctx, id, { message: 'Private client update.' });
    expect(f.notifications.create).not.toHaveBeenCalled();
  });
});
describe('newsletter rendering and validation', () => {
  it('keeps nested columns while stripping executable HTML, attributes and URLs', () => {
    const design = governmentAffairsNewsletter();
    design.sections[0]!.blocks[0]!.html =
      '<script>evil()</script><p onclick="evil()">safe <a href="javascript:evil()">link</a></p><img src="https://example.com/image.jpg" onerror="evil()">';
    const validated = validateNewsletterDesign(design);
    const html = validated.sections[0]!.blocks[0]!.html;
    expect(html).toContain('safe');
    expect(html).not.toMatch(/script|onclick|onerror|javascript/);
    expect(validated.sections[1]!.blocks.some((b) => b.columns.length === 2)).toBe(true);
    expect(newsletterSafeUrl('mailto:test@example.com', true)).toBe('');
    expect(newsletterSafeUrl('https://user:secret@example.com/a')).toBe('');
  });
  it('rejects duplicate IDs and deeply nested/invalid block containers', () => {
    const design = governmentAffairsNewsletter();
    design.sections[0]!.blocks[1]!.id = design.sections[0]!.blocks[0]!.id;
    expect(() => validateNewsletterDesign(design)).toThrow(BadRequestException);
  });
  it('escapes merge data and evaluates recipient visibility before rendering', () => {
    const block = createNewsletterBlock('paragraph', {
      text: 'Hi *|FNAME|*',
      visibility: { mode: 'custom', rules: [{ field: 'company', operator: 'is', value: 'Acme' }] },
    });
    const recipient = {
      id: 'r1',
      email: 'user@example.com',
      firstName: '<script>bad</script>',
      lastName: '',
      company: 'Acme',
      phone: '',
      address: '',
      birthday: '',
      client: '',
      tags: [],
      subscribed: true,
    };
    expect(newsletterBlockVisible(block, { ...recipient, company: 'Other' })).toBe(false);
    const design = governmentAffairsNewsletter();
    design.sections = [createNewsletterSection('Body', [block])];
    const html = renderNewsletterDesign(design, defaultNewsletterConfig(), {
      recipient,
      liveMergeTags: true,
      sanitizeHtml: sanitizeNewsletterHtml,
    });
    expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });
  it('makes each custom mobile declaration override desktop inline styles', () => {
    const design = governmentAffairsNewsletter();
    const block = design.sections[1]!.blocks.find((b) => b.kind === 'heading')!;
    block.linkedStyles = false;
    block.mobileStyle = { fontSize: 21, color: '#00ff00' };
    const html = renderNewsletterDesign(design, defaultNewsletterConfig());
    expect(html).toContain('font-size:21px!important;color:#00ff00!important');
  });
  it('applies global image and divider spacing once and keeps button padding inside the shape', () => {
    const design = governmentAffairsNewsletter();
    design.styles.image.paddingTop = 23;
    const image = createNewsletterBlock('image', { imageUrl: 'https://example.com/image.png' });
    const divider = createNewsletterBlock('divider', { style: { paddingTop: 19 } });
    const button = createNewsletterBlock('button', {
      text: 'Read',
      url: 'https://example.com/',
      style: { paddingTop: 27 },
    });
    design.sections = [createNewsletterSection('Body', [image, divider, button])];
    const html = renderNewsletterDesign(design, defaultNewsletterConfig());
    expect(html).toContain(`class="nl-block-${image.id}" style="padding:23px`);
    expect(html).toContain(`class="nl-block-${divider.id}" style="padding:19px`);
    expect(html.match(/padding:19px/g)).toHaveLength(1);
    expect(html).toContain(`class="nl-block-${button.id}" style="padding:12px`);
    expect(html).toContain('padding-top:27px');
  });
  it('applies mobile padding to the wrapper or button, and mobile divider thickness to the top border', () => {
    const design = governmentAffairsNewsletter();
    const divider = createNewsletterBlock('divider', {
      linkedStyles: false,
      mobileStyle: { paddingTop: 9, borderWidth: 3 },
    });
    const button = createNewsletterBlock('button', {
      linkedStyles: false,
      mobileStyle: { paddingTop: 7 },
    });
    design.sections = [createNewsletterSection('Body', [divider, button])];
    const html = renderNewsletterDesign(design, defaultNewsletterConfig());
    expect(html).toContain(`.nl-block-${divider.id}{padding-top:9px!important}`);
    expect(html).toContain(`.nl-block-${divider.id}>*{border-top-width:3px!important}`);
    expect(html).toContain(`.nl-block-${button.id}>div>a{padding-top:7px!important}`);
  });
  it('keeps image content sizing authoritative over desktop and mobile style widths', () => {
    const design = governmentAffairsNewsletter();
    design.styles.image = {
      ...design.styles.image,
      width: 100,
      align: 'center',
      borderColor: '#123456',
      borderWidth: 2,
    };
    design.styles.linkedStyles = false;
    design.styles.mobileImage = { width: 80, radius: 8 };
    for (const kind of ['image', 'logo'] as const) {
      for (const [size, expected] of [
        ['scale', '55%'],
        ['original', 'auto'],
        ['fill', '100%'],
      ] as const) {
        const image = createNewsletterBlock(kind, {
          imageUrl: '/newsletter/capitol.png',
          imageSize: size,
          imageScale: 55,
          linkedStyles: false,
          style: { width: 90 },
          mobileStyle: { width: 75, borderColor: '#654321' },
        });
        design.sections = [createNewsletterSection('Body', [image])];
        const html = renderNewsletterDesign(design, defaultNewsletterConfig());
        const tag = html.match(/<img\b[^>]+style="([^"]*)"/)![1]!;
        expect(tag.match(/(?:^|;)width:[^;]+/g)).toEqual([`;width:${expected}`]);
        expect(html).not.toMatch(new RegExp(`\\.nl-block-${image.id}[^{}]*\\{[^}]*width:`));
        expect(html).toContain('border-color:#654321!important');
      }
    }
  });
  it('escapes recipient data inside rich text instead of interpreting it as markup', () => {
    const design = governmentAffairsNewsletter();
    design.sections[0]!.blocks[0]!.html = '<p>Hello *|FNAME|*</p>';
    const html = renderNewsletterDesign(design, defaultNewsletterConfig(), {
      liveMergeTags: true,
      editor: true,
      recipient: {
        id: 'r',
        email: 'r@example.com',
        firstName: '<b>Injected</b>',
        lastName: '',
        company: '',
        phone: '',
        address: '',
        birthday: '',
        client: '',
        tags: [],
        subscribed: true,
      },
      sanitizeHtml: sanitizeNewsletterHtml,
    });
    expect(html).toContain('&lt;b&gt;Injected&lt;/b&gt;');
    expect(html).not.toContain('<b>Injected</b>');
  });
  it('validates persisted Link Preview settings and rejects unsupported apps or display values', () => {
    const design = governmentAffairsNewsletter();
    const app = {
      kind: 'link-preview' as const,
      sourceUrl: 'https://news.example/policy',
      title: 'Committee update',
      description: 'Illustrative story.',
      imageUrl: 'https://images.example/policy.png',
      size: 'medium' as const,
      showImage: true,
      showDescription: false,
      showBackground: true,
    };
    const block = createNewsletterBlock('apps', { app });
    design.sections[0]!.blocks.push(block);
    expect(validateNewsletterDesign(design).sections[0]!.blocks.at(-1)!.app).toEqual(app);
    for (const change of [
      { kind: 'unknown' },
      { size: 'huge' },
      { showImage: 'yes' },
      { sourceUrl: 'javascript:alert(1)' },
      { description: 'a'.repeat(6001) },
    ]) {
      const invalid = JSON.parse(JSON.stringify(design));
      Object.assign(invalid.sections[0].blocks.at(-1).app, change);
      expect(() => validateNewsletterDesign(invalid)).toThrow(BadRequestException);
    }
    block.kind = 'paragraph';
    expect(() => validateNewsletterDesign(design)).toThrow('Only Apps');
  });
  it('blocks staging an unconfigured Apps block instead of silently delivering a placeholder', async () => {
    const f = fixture(),
      row = makeRow();
    row.design.sections[0]!.blocks.push(createNewsletterBlock('apps'));
    f.document.findFirst.mockResolvedValue(row);
    await expect(f.service.stage(ctx, id, row.revision)).rejects.toThrow('Choose app content');
    expect(f.stage.upsert).not.toHaveBeenCalled();
  });
});
