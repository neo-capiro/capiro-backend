import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { readMailThreadPage, readMailThreadHttpPage } from './mail-thread-pages.js';

const ids = {
  tenant: '10000000-0000-4000-8000-000000000001', actor: '20000000-0000-4000-8000-000000000001',
  client: '30000000-0000-4000-8000-000000000001', thread: '40000000-0000-4000-8000-000000000001',
  box: '50000000-0000-4000-8000-000000000001', message: '60000000-0000-4000-8000-000000000001',
};
const ctx = { tenantId: ids.tenant, userId: ids.actor } as TenantContext;
const asOf = '2026-10-01T12:00:00.000Z';
function harness() {
  const thread = { id: ids.thread, tenantId: ids.tenant, clientId: ids.client as string | null, connectionId: ids.box,
    updatedAt: new Date('2026-09-30T12:00:00Z'), connection: {
      id: ids.box, tenantId: ids.tenant, createdByUserId: ids.actor, accountEmail: 'owner@example.test',
      provider: 'google_workspace', status: 'connected', lastSyncAt: null, syncState: {},
    } };
  const tx = { $executeRaw: jest.fn(async () => 1), $queryRawUnsafe: jest.fn(async () => [{ allowed: true }]),
    $queryRaw: jest.fn(async (_sql: unknown) => [{ allowed: true }]),
    tenantMembership: { findFirst: jest.fn(async () => ({ id: 'membership' })) },
    client: { findFirst: jest.fn(async () => ({ id: ids.client })) },
    mailThread: { findFirst: jest.fn(async () => thread as typeof thread | null) },
    mailMessage: { count: jest.fn(async () => 5), findFirst: jest.fn(async () => ({ id: ids.message })),
      findMany: jest.fn(async (_args: unknown) => [1, 2, 3].map(n => ({ id: String(n), bodyText: 'Stored exact body 😀' }))) },
  };
  const prisma = { withTenant: jest.fn(async (_tenant: string, read: (tx: unknown) => unknown) => read(tx)) };
  const read = (input = {}, scope = ctx, clientId: string | undefined = ids.client, boxes?: string[]) =>
    readMailThreadPage(prisma as any, scope, ids.thread, clientId, boxes, { asOf, ...input });
  return { tx, prisma, thread, read };
}

describe('bounded canonical thread pages', () => {
  it('Outlook selected-body context stays additive, private and unavailable when capture is missing', async () => {
    const h = harness(), tx = h.tx as any;
    Object.assign(h.thread, { source: 'outlook', externalId: 'conversation' }); h.thread.connection.provider = 'microsoft_365';
    tx.integrationConnection = { findMany: jest.fn(async () => [{ accountEmail: 'owner@example.test' }]) };
    tx.user = { findUnique: jest.fn(async () => ({ email: 'actor@example.test' })) };
    const source: any = { id: ids.message, threadId: ids.thread, connectionId: ids.box, source: 'outlook', externalId: 'default-source',
      removedAt: null, subject: 'Subject', fromEmail: 'contact@example.test', updatedAt: new Date('2026-09-30T11:00:00Z'), bodyText: 'Stored exact body',
      raw: { graphReplySource: { schema: 'graph-native-reply/1', defaultId: 'default-source', identity: {
        kind: 'microsoft_graph', immutableId: 'Immutable-Source', conversationId: 'conversation', changeKey: 'version',
        subject: 'Subject', fromEmail: 'contact@example.test', senderEmail: 'contact@example.test', toEmail: 'contact@example.test', replyTo: [],
        inReplyTo: '<source@example.test>', references: '<source@example.test>' } } } };
    tx.mailMessage.findMany.mockResolvedValue([source]); tx.mailMessage.count.mockResolvedValue(1);
    const read = () => readMailThreadHttpPage(h.prisma as any, ctx, ids.thread, ids.client, { asOf, messageId: ids.message });
    const supported = await read();
    expect(supported.messages[0]?.replyContext).toMatchObject({ supported: true, to: [{ email: 'contact@example.test' }] });
    expect(JSON.stringify(supported)).not.toMatch(/Immutable-Source|default-source|changeKey|source@example/);
    delete source.raw.graphReplySource;
    expect((await read()).messages[0]).toMatchObject({ bodyText: 'Stored exact body', replyContext: { supported: false } });
  });

  it('reply-all selected HTTP context exposes only reviewed recipients and keeps ordinary reply available without full capture', async () => {
    const h = harness(), tx = h.tx as any;
    Object.assign(h.thread, { source: 'google', externalId: 'provider-thread' });
    tx.integrationConnection = { findMany: jest.fn(async () => [{ accountEmail: 'owner@example.test' }]) };
    tx.user = { findUnique: jest.fn(async () => ({ email: 'actor@example.test' })) };
    const source: any = { id: ids.message, threadId: ids.thread, connectionId: ids.box, source: 'google', externalId: 'provider-original',
      removedAt: null, subject: 'Subject', fromEmail: 'contact@example.test', updatedAt: new Date(asOf), bodyText: 'Stored exact body',
      raw: { id: 'provider-original', threadId: 'provider-thread', labelIds: ['INBOX'], payload: { headers: [
        { name: 'From', value: 'contact@example.test' }, { name: 'Subject', value: 'Subject' }, { name: 'Message-ID', value: '<original@example.test>' },
        { name: 'To', value: 'owner@example.test, other@example.test' }, { name: 'Cc', value: 'copy@example.test' },
      ] } } };
    tx.mailMessage.findMany.mockResolvedValue([source]); tx.mailMessage.count.mockResolvedValue(1);
    const read = () => readMailThreadHttpPage(h.prisma as any, ctx, ids.thread, ids.client, { asOf, messageId: ids.message });
    const page = await read();
    expect(page.messages[0]?.replyAllContext).toMatchObject({ supported: true, operation: 'reply_all', to: [{ email: 'contact@example.test' }, { email: 'other@example.test' }], cc: [{ email: 'copy@example.test' }] });
    expect(page.messages[0]?.replyContext).toMatchObject({ supported: true, operation: 'reply', to: [{ email: 'contact@example.test' }] });
    expect(JSON.stringify(page)).not.toMatch(/provider-original|original@example/);
    source.raw.payload.headers = source.raw.payload.headers.filter((row: any) => row.name !== 'To');
    const unsupported = await read();
    expect(unsupported.messages[0]?.replyAllContext).toMatchObject({ supported: false });
    expect(unsupported.messages[0]?.replyContext).toMatchObject({ supported: true });
    expect(unsupported.messages[0]?.bodyText).toBe('Stored exact body');
  });
  it.each(['wall', 'client'])('refuses General access to an actual associated client with current %s denial', async failure => {
    const h = harness();
    if (failure === 'wall') h.tx.$queryRawUnsafe.mockResolvedValue([{ allowed: false }]);
    if (failure === 'client') h.tx.client.findFirst.mockResolvedValue(null as any);
    await expect(readMailThreadPage(h.prisma as any, ctx, ids.thread, undefined, [ids.box], { asOf }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(h.tx.$queryRawUnsafe).toHaveBeenCalledWith(expect.any(String), ids.tenant, ids.client, ids.actor);
    expect(h.tx.mailMessage.count).not.toHaveBeenCalled();
    expect(h.tx.mailMessage.findMany).not.toHaveBeenCalled();
  });

  it('keeps visible client-linked and unassociated owned threads readable in General', async () => {
    const h = harness();
    await readMailThreadPage(h.prisma as any, ctx, ids.thread, undefined, [ids.box], { asOf });
    expect(h.tx.$queryRawUnsafe).toHaveBeenCalledWith(expect.any(String), ids.tenant, ids.client, ids.actor);
    h.tx.$queryRawUnsafe.mockClear();
    h.thread.clientId = null;
    await readMailThreadPage(h.prisma as any, ctx, ids.thread, undefined, [ids.box], { asOf });
    expect(h.tx.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(h.tx.mailMessage.findMany).toHaveBeenCalledTimes(2);
  });

  it('does not let contact association with a visible client bypass the actual thread client wall', async () => {
    const h = harness();
    const selectedClient = '30000000-0000-4000-8000-000000000002';
    h.tx.$queryRawUnsafe.mockResolvedValueOnce([{ allowed: true }]).mockResolvedValueOnce([{ allowed: false }]);
    await expect(readMailThreadHttpPage(h.prisma as any, ctx, ids.thread, undefined,
      { asOf, associationClientId: selectedClient }, async () => ['synthetic@example.test']))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(h.tx.$queryRawUnsafe).toHaveBeenNthCalledWith(1, expect.any(String), ids.tenant, selectedClient, ids.actor);
    expect(h.tx.$queryRawUnsafe).toHaveBeenNthCalledWith(2, expect.any(String), ids.tenant, ids.client, ids.actor);
    expect(h.tx.mailMessage.findMany).not.toHaveBeenCalled();
  });

  it('selects only the requested bounded messages under a current read transaction and existing walls', async () => {
    const h = harness(); const page = await h.read();
    expect(h.prisma.withTenant).toHaveBeenCalledWith(ids.tenant, expect.any(Function),
      { readOnly: true, isolationLevel: 'RepeatableRead', timeoutMs: 12000 });
    expect(h.tx.tenantMembership.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      tenantId: ids.tenant, userId: ids.actor, status: 'active', tenant: { status: 'active' },
      role: { in: ['standard_user', 'user_admin', 'capiro_admin'] },
    } }));
    expect(h.tx.$queryRawUnsafe).toHaveBeenCalledWith(expect.any(String), ids.tenant, ids.client, ids.actor);
    expect(h.tx.mailThread.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: ids.thread, tenantId: ids.tenant, clientId: ids.client,
      connection: { createdByUserId: ids.actor }, messages: { some: { removedAt: null } },
    } }));
    expect(h.tx.mailMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: ids.tenant, threadId: ids.thread, connectionId: ids.box, removedAt: null,
        createdAt: { lte: new Date(asOf) } }, take: 3, skip: 0,
      orderBy: [{ sentAt: 'asc' }, { receivedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    }));
    const selection = h.tx.mailMessage.findMany.mock.calls[0]![0] as any;
    expect(selection.select.bodyText).toBe(true); expect(selection.select.raw).toBeUndefined();
    expect(page).toMatchObject({ totalMessages: 5, messageOffset: 0, hasMore: true, nextMessageOffset: 3,
      asOf, coverage: { backfillComplete: false, captureRepair: 'required' } });
    expect(page.messages[0]!.bodyText).toBe('Stored exact body 😀');
  });
  it.each(['supported', 'connection bound', 'missing actor', 'DB error'])('selected original %s keeps reply eligibility additive and raw metadata private', async eligibility => {
    const h = harness();
    Object.assign(h.thread, { source: 'google', externalId: 'provider-thread' });
    Object.assign(h.tx, {
      integrationConnection: { findMany: jest.fn(async () => [{ accountEmail: 'owner@example.test' }]) },
      user: { findUnique: jest.fn(async () => ({ email: 'actor@example.test' })) },
    });
    const source = { id: ids.message, threadId: ids.thread, connectionId: ids.box, source: 'google',
      externalId: 'provider-message', removedAt: null, subject: 'Exact subject', fromEmail: 'contact@example.test',
      updatedAt: new Date('2026-09-30T11:00:00Z'), bodyText: 'Exact incoming body', raw: {
        id: 'provider-message', threadId: 'provider-thread', labelIds: ['INBOX'], payload: { headers: [
          { name: 'From', value: 'contact@example.test' }, { name: 'Reply-To', value: 'reply@example.test' },
          { name: 'Subject', value: 'Exact subject' }, { name: 'Message-ID', value: '<original@example.test>' },
        ] },
      } };
    h.tx.mailMessage.findMany.mockResolvedValue([source]); h.tx.mailMessage.count.mockResolvedValue(1);
    const tx = h.tx as any;
    if (eligibility === 'connection bound') tx.integrationConnection.findMany.mockResolvedValue(Array.from({ length: 101 }, () => ({ accountEmail: 'owner@example.test' })));
    if (eligibility === 'missing actor') tx.user.findUnique.mockResolvedValue({ email: null });
    if (eligibility === 'DB error') {
      const failure = new Error('synthetic database unavailable'); tx.user.findUnique.mockRejectedValue(failure);
      await expect(readMailThreadHttpPage(h.prisma as any, ctx, ids.thread, ids.client, { asOf, messageId: ids.message })).rejects.toBe(failure);
      return;
    }
    const page = await readMailThreadHttpPage(h.prisma as any, ctx, ids.thread, ids.client, { asOf, messageId: ids.message });
    expect(page.messages[0]?.bodyText).toBe(source.bodyText);
    if (eligibility === 'supported') expect(page.messages[0]).toMatchObject({ bodyText: source.bodyText, replyContext: {
      supported: true, originalMessageId: ids.message, originalUpdatedAt: source.updatedAt.toISOString(),
      senderConnectionId: ids.box, subject: source.subject, to: [{ email: 'reply@example.test' }],
    } });
    else expect(page.messages[0]?.replyContext).toMatchObject({ supported: false });
    expect(JSON.stringify(page)).not.toContain('provider-message');
    expect(JSON.stringify(page)).not.toContain('<original@example.test>');
    expect(page.messages[0]).not.toHaveProperty('raw'); expect(page).not.toHaveProperty('externalId');
    source.raw.labelIds = ['SENT'];
    const unsupported = await readMailThreadHttpPage(h.prisma as any, ctx, ids.thread, ids.client, { asOf, messageId: ids.message });
    expect(unsupported.messages[0]?.replyContext).toMatchObject({ supported: false });
  });
  it('continues with the exact asOf, scope and limit and stops at the final page', async () => {
    const h = harness(); const first = await h.read();
    h.tx.mailMessage.findMany.mockResolvedValueOnce([{ id: '4', bodyText: 'four' }, { id: '5', bodyText: 'five' }]);
    const last = await h.read({ cursor: first.nextCursor });
    expect(h.tx.mailMessage.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 3, skip: 3 }));
    expect(last).toMatchObject({ totalMessages: 5, messageOffset: 3, hasMore: false, nextCursor: null, asOf });
  });
  it.each([{ limit: 11 }, { limit: 0 }, { messageOffset: 10001 }, { messageOffset: -1 },
    { asOf: '2999-01-01' }, { cursor: 'invalid' }, { messageId: 'not-a-uuid' }])('rejects invalid input before any DB work: %j', async input => {
    const h = harness(); await expect(h.read(input)).rejects.toBeInstanceOf(BadRequestException);
    expect(h.prisma.withTenant).not.toHaveBeenCalled();
  });
  it('rejects cross-actor, changed filter, changed limit and mixed-position cursors', async () => {
    const h = harness(); const first = await h.read();
    for (const input of [{ cursor: first.nextCursor, limit: 2 }, { cursor: first.nextCursor, messageOffset: 3 },
      { cursor: first.nextCursor, messageId: ids.message }, { cursor: first.nextCursor, asOf: '2026-09-01' }]) {
      await expect(h.read(input)).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(h.read({ cursor: first.nextCursor }, { ...ctx, userId: ids.message })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('refuses changed thread timestamps before selecting a later page', async () => {
    const h = harness(); const first = await h.read(); h.tx.mailMessage.findMany.mockClear();
    h.thread.updatedAt = new Date('2026-10-01T11:00:00Z');
    await expect(h.read({ cursor: first.nextCursor })).rejects.toBeInstanceOf(ConflictException);
    expect(h.tx.mailMessage.findMany).not.toHaveBeenCalled();
  });
  it.each(['membership', 'wall', 'client', 'thread', 'owner', 'tenant', 'citation'])('refuses current %s denial before reading body rows', async failure => {
    const h = harness();
    if (failure === 'membership') h.tx.tenantMembership.findFirst.mockResolvedValue(null as any);
    if (failure === 'wall') h.tx.$queryRawUnsafe.mockResolvedValue([{ allowed: false }]);
    if (failure === 'client') h.tx.client.findFirst.mockResolvedValue(null as any);
    if (failure === 'thread') h.tx.mailThread.findFirst.mockResolvedValue(null);
    if (failure === 'owner') h.thread.connection.createdByUserId = ids.message;
    if (failure === 'tenant') h.thread.connection.tenantId = ids.message;
    if (failure === 'citation') h.tx.mailMessage.findFirst.mockResolvedValue(null as any);
    await expect(h.read({ requiredMessageId: ids.message })).rejects.toBeInstanceOf(NotFoundException);
    expect(h.tx.mailMessage.findMany).not.toHaveBeenCalled();
  });
  it('pushes exact retained mailbox and message selection into the owner', async () => {
    const h = harness(); await h.read({ messageId: ids.message, limit: 1 }, ctx, ids.client, [ids.box]);
    expect(h.tx.mailThread.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where:
      expect.objectContaining({ connectionId: { in: [ids.box] } }) }));
    expect(h.tx.mailMessage.count).toHaveBeenCalledWith({ where: expect.objectContaining({ id: ids.message }) });
    expect(h.tx.mailMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1, skip: 0,
      where: expect.objectContaining({ id: ids.message }) }));
    await expect(h.read({}, ctx, ids.client, [])).rejects.toBeInstanceOf(BadRequestException);
  });
  it('keeps the bounded-offset ceiling explicit even when more stored mail exists', async () => {
    const h = harness(); h.tx.mailMessage.count.mockResolvedValue(10020);
    const page = await h.read({ messageOffset: 10000 });
    expect(page).toMatchObject({ hasMore: true, nextCursor: null, nextMessageOffset: null });
  });
  it('caps historical oversized HTTP bodies while preserving exact full-body hashes and Unicode continuation', async () => {
    const h = harness(); const body = 'A'.repeat(5999) + '😀' + 'Z'.repeat(2_000_000);
    h.tx.mailMessage.count.mockResolvedValue(1);
    h.tx.mailMessage.findMany.mockResolvedValue([{ id: ids.message, bodyText: body }]);
    const first = await readMailThreadHttpPage(h.prisma as any, ctx, ids.thread, undefined, { asOf });
    expect(first.messages[0]!.bodyText).toHaveLength(5999);
    expect(first.messages[0]!.bodyLength).toBe(body.length);
    expect(first.messages[0]!.bodyTruncated).toBe(true);
    expect(JSON.stringify(first).length).toBeLessThan(10000);
    const next = await readMailThreadHttpPage(h.prisma as any, ctx, ids.thread, undefined,
      { asOf, messageId: ids.message, bodyOffset: first.messages[0]!.nextBodyOffset,
        expectedBodySha256: first.messages[0]!.bodySha256 });
    expect(next.messages[0]!.bodyText).toBe(body.slice(5999, 11999));
    expect(next.messages[0]!.bodySha256).toBe(first.messages[0]!.bodySha256);
    h.tx.mailMessage.findMany.mockResolvedValue([{ id: ids.message, bodyText: body + 'changed' }]);
    await expect(readMailThreadHttpPage(h.prisma as any, ctx, ids.thread, undefined,
      { asOf, messageId: ids.message, bodyOffset: 5999, expectedBodySha256: first.messages[0]!.bodySha256 }))
      .rejects.toBeInstanceOf(ConflictException);
  });
  it('requires an exact message and delivered body hash before HTTP body continuation', async () => {
    const h = harness();
    await expect(readMailThreadHttpPage(h.prisma as any, ctx, ids.thread, undefined, { bodyOffset: 5 }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(readMailThreadHttpPage(h.prisma as any, ctx, ids.thread, undefined,
      { bodyOffset: 5, messageId: ids.message, expectedBodySha256: 'invalid' }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(h.prisma.withTenant).not.toHaveBeenCalled();
  });
  it('refuses a deleted HTTP body continuation instead of returning a successful empty page', async () => {
    const h = harness(); h.tx.mailMessage.count.mockResolvedValue(0);
    h.tx.mailMessage.findMany.mockResolvedValue([]);
    await expect(readMailThreadHttpPage(h.prisma as any, ctx, ids.thread, undefined,
      { asOf, messageId: ids.message, bodyOffset: 5, expectedBodySha256: 'a'.repeat(64) }))
      .rejects.toBeInstanceOf(NotFoundException);
  });
  it('does not serialize raw metadata or treat historical completeness values as full', async () => {
    const h = harness(); h.tx.mailMessage.count.mockResolvedValue(1);
    h.tx.mailMessage.findMany.mockResolvedValue([{ id: ids.message, bodyText: 'Body',
      metadata: { rawProviderData: 'Not an HTTP field', bodyCompleteness: ['full'] } }] as any);
    const page = await readMailThreadHttpPage(h.prisma as any, ctx, ids.thread, undefined, { asOf });
    expect(page.messages[0]!.bodyCompleteness).toBe('unknown');
    expect(page.messages[0]).not.toHaveProperty('metadata');
    expect(page).not.toHaveProperty('client');
  });
  it.each([
    { clientId: ids.client, associationClientId: ids.client },
    { associationClientId: 'invalid' },
    { recipientEmails: ['person@example.test'] },
    { associationClientId: ids.client, recipientEmails: ['x'.repeat(321)] },
  ])('rejects ambiguous or invalid HTTP association selectors: %j', async ({ clientId, ...input }) => {
    const h = harness();
    await expect(readMailThreadHttpPage(h.prisma as any, ctx, ids.thread, clientId, input, async () => []))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(h.prisma.withTenant).not.toHaveBeenCalled();
  });
  it('uses the selected client wall and bounded active association inside the same HTTP read transaction', async () => {
    const h = harness(); const profile = jest.fn(async () => ['profile@example.test']);
    const input = { asOf, associationClientId: ids.client, recipientEmails: [' PERSON@example.test '] };
    const page = await readMailThreadHttpPage(h.prisma as any, ctx, ids.thread, undefined, input, profile);
    expect(page.associationClientId).toBe(ids.client);
    expect(profile).toHaveBeenCalledWith(h.tx, ids.client);
    expect(h.tx.$queryRawUnsafe).toHaveBeenCalledWith(expect.any(String), ids.tenant, ids.client, ids.actor);
    const proof = h.tx.$queryRaw.mock.calls[0]![0] as any;
    expect(proof.sql).toContain('t.id=?::uuid'); expect(proof.sql).toContain('ma.connection_id=t.connection_id');
    expect(proof.sql).toContain('ma.removed_at IS NULL'); expect(proof.values).toContainEqual(['person@example.test']);
    h.tx.$queryRaw.mockResolvedValue([{ allowed: false }]); h.tx.mailMessage.findMany.mockClear();
    await expect(readMailThreadHttpPage(h.prisma as any, ctx, ids.thread, undefined, input, profile))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(h.tx.mailMessage.findMany).not.toHaveBeenCalled();
  });

});

it('returns folder and Internet Message-ID provenance while withholding raw metadata', async () => {
  const h = harness();
  (h.tx.mailMessage.findMany as any).mockResolvedValue([
    {
      id: ids.message,
      bodyText: 'Original',
      metadata: {
        folder: 'inbox',
        internetMessageId: '<original@example.test>',
        bodyCompleteness: 'full',
        privateInternal: 'hidden',
      },
    },
  ]);
  const result = await readMailThreadHttpPage(h.prisma as any, ctx, ids.thread, ids.client, {
    asOf,
  });
  expect(result.messages[0]).toMatchObject({
    folder: 'inbox',
    internetMessageId: '<original@example.test>',
  });
  expect(JSON.stringify(result)).not.toContain('privateInternal');
});
