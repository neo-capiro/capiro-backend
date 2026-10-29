import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { officeDatabase } from './postgres-fixture.js';
import { openDraft, readDraft, lockDraft, saveDraft, discardDraft } from './store.js';
import { beginDraftPublish, settleDraftPublish } from './publication.js';
import { digest } from './input.js';
import type { OfficeAuthority } from './authority.js';
import { expireOfficeDrafts } from './retention.js';
const url = process.env.OFFICE_DRAFT_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('private Office drafts on ordinary-role PostgreSQL', () => {
  let db: PrismaClient, scoped: PrismaService;
  beforeAll(async () => { ({ db, scoped } = await officeDatabase(url!)); }, 60000);
  afterAll(async () => { await db?.$disconnect(); });
  async function fixture(existingTenantId?: string) {
    const tenantId = existingTenantId ?? randomUUID(), userId = randomUUID(), clientId = randomUUID(), conversationId = randomUUID();
    if (!existingTenantId) await db.tenant.create({ data: { id: tenantId, slug: 'office-' + tenantId, name: 'Office test', status: 'active' } });
    await db.user.create({ data: { id: userId, clerkUserId: 'office-' + userId, email: userId + '@example.invalid' } });
    const member = await db.tenantMembership.create({ data: { tenantId, userId, role: 'standard_user', status: 'active' } });
    await db.client.create({ data: { id: clientId, tenantId, name: 'Office test', memoryWall: true } });
    await db.clientMemoryAccess.create({ data: { tenantId, userId, clientId } });
    await db.clioConversation.create({ data: { id: conversationId, tenantId, userId, clientId, title: 'Office test' } });
    await db.clioConversationBootstrapReceipt.create({ data: { tenantId, actorUserId: userId, requestId: randomUUID(),
      conversationId, scopeKind: 'client', clientId } });
    const ctx = { tenantId, tenantSlug: 'office-' + tenantId, userId, clerkUserId: 'office-' + userId, role: 'standard_user' } as TenantContext;
    const authority = { readCurrent: jest.fn(async () => ({ principal: { tenantId, actorId: userId }, expiresAtMs: Date.now() + 600000 })) } as unknown as OfficeAuthority;
    const ports = { prisma: scoped, ctx, authority }, key = { conversationId, draftId: randomUUID() };
    const source = { ...key, artifactId: randomUUID(), baseVersionId: randomUUID(), baseSha256: 'a'.repeat(64), format: 'docx', filename: 'draft.docx' };
    const opened = await openDraft(ports, source);
    const lock = (operation = 'lock', token = 'writer-1') => lockDraft(ports, { ...key, operation, ...(operation === 'get' ? {} : { lock: token }) });
    const save = (text: string, expectedSequence = 0) => {
      const bytes = Buffer.from(text); return { ...key, lock: 'writer-1', expectedSequence,
        sha256: digest(bytes), bytesBase64: bytes.toString('base64'), kind: 'explicit' };
    };
    return { ports, key, source, opened, member, clientId, lock, save };
  }
  it('recovers exact private bytes after a new connection; replays a lost save acknowledgement without another sequence', async () => {
    const f = await fixture(); await f.lock();
    const request = f.save('private Office bytes'), saved = await saveDraft(f.ports, request);
    expect((saved as any).receipt).toMatchObject({ sequence: 1, state: 'draft', publishedVersionId: null });
    expect(await saveDraft(f.ports, request)).toEqual(saved);
    const otherConnection = await officeDatabase(url!);
    try {
      const read = await readDraft({ ...f.ports, prisma: otherConnection.scoped }, f.key);
      expect(read.bytesBase64).toBe(request.bytesBase64); expect(read.sha256).toBe(request.sha256);
    } finally { await otherConnection.db.$disconnect(); }
    await expect(openDraft(f.ports, { ...f.source, baseSha256: 'b'.repeat(64) })).rejects.toThrow('ID_CONFLICT');
    expect((await readDraft(f.ports, f.key)).baseVersionId).toBe(f.source.baseVersionId);
  });
  it('accepts exactly one competing save at an exact sequence', async () => {
    const f = await fixture(); await f.lock();
    const results = await Promise.allSettled([saveDraft(f.ports, f.save('first')), saveDraft(f.ports, f.save('second'))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect((await readDraft(f.ports, f.key)).sequence).toBe(1);
    await expect(saveDraft(f.ports, f.save('third'))).rejects.toThrow('STALE_SEQUENCE');
  });
  it('serializes locks and refuses incorrect/expired locks before saving; supports relock and unlock', async () => {
    const f = await fixture(); expect(await f.lock()).toEqual({ status: 200 });
    expect(await f.lock('lock', 'writer-2')).toEqual({ status: 409, lock: 'writer-1' });
    expect(await saveDraft(f.ports, { ...f.save('x'), lock: 'wrong' })).toEqual({ status: 409, lock: 'writer-1' });
    expect(await lockDraft(f.ports, { ...f.key, operation: 'relock', oldLock: 'writer-1', lock: 'writer-2' })).toEqual({ status: 200 });
    expect(await f.lock('refresh', 'writer-2')).toEqual({ status: 200 });
    expect(await f.lock('unlock', 'writer-2')).toEqual({ status: 200 });
    expect(await f.lock('get')).toEqual({ status: 200, lock: '' });
    await f.lock();
    await db.$executeRaw`UPDATE meri_office_drafts SET lock_expires_at=clock_timestamp()-interval '1 second'
      WHERE draft_id=${f.key.draftId}::uuid`;
    expect(await saveDraft(f.ports, f.save('x'))).toEqual({ status: 409, lock: '' });
    expect((await readDraft(f.ports, f.key)).sequence).toBe(0);
  });
  it('enforces actor and tenant RLS, and prevents ordinary-role mutation of immutable source provenance', async () => {
    const f = await fixture(), actor = await fixture(f.ports.ctx.tenantId), tenant = await fixture();
    for (const other of [actor, tenant]) {
      await expect(readDraft(other.ports, f.key)).rejects.toThrow();
      const rows = await scoped.withTenant(other.ports.ctx.tenantId, async tx => {
        await tx.$executeRaw`SELECT set_config('app.current_user',${other.ports.ctx.userId},true)`;
        return tx.$queryRaw<Array<{ draft_id: string }>>`SELECT draft_id FROM meri_office_drafts WHERE draft_id=${f.key.draftId}::uuid`;
      });
      expect(rows).toHaveLength(0);
    }
    await expect(scoped.withTenant(f.ports.ctx.tenantId, async tx => {
      await tx.$executeRaw`SELECT set_config('app.current_user',${f.ports.ctx.userId},true)`;
      await tx.$executeRaw`UPDATE meri_office_drafts SET base_sha256=${'b'.repeat(64)} WHERE draft_id=${f.key.draftId}::uuid`;
    })).rejects.toThrow();
  });
  it('rechecks wall, membership, conversation, session and seven-day expiry on read and save', async () => {
    const f = await fixture(); await f.lock();
    await db.clientMemoryAccess.deleteMany({ where: { tenantId: f.ports.ctx.tenantId, userId: f.ports.ctx.userId } });
    await expect(saveDraft(f.ports, f.save('blocked'))).rejects.toThrow('Chat not found');
    await db.clientMemoryAccess.create({ data: { tenantId: f.ports.ctx.tenantId, userId: f.ports.ctx.userId, clientId: f.clientId } });
    await db.tenantMembership.update({ where: { id: f.member.id }, data: { status: 'removed' } });
    await expect(readDraft(f.ports, f.key)).rejects.toThrow('access unavailable');
    await db.tenantMembership.update({ where: { id: f.member.id }, data: { status: 'active' } });
    await db.clioConversation.update({ where: { id: f.key.conversationId }, data: { status: 'archived' } });
    await expect(readDraft(f.ports, f.key)).rejects.toThrow('UNAVAILABLE');
    await db.clioConversation.update({ where: { id: f.key.conversationId }, data: { status: 'active' } });
    const expired = { readCurrent: async () => ({ principal: { tenantId: f.ports.ctx.tenantId, actorId: f.ports.ctx.userId }, expiresAtMs: 1 }) } as unknown as OfficeAuthority;
    await expect(saveDraft({ ...f.ports, authority: expired }, f.save('blocked'))).rejects.toThrow('AUTHORITY');
    await db.$executeRaw`UPDATE meri_office_drafts SET expires_at=clock_timestamp()-interval '1 second' WHERE draft_id=${f.key.draftId}::uuid`;
    await expect(readDraft(f.ports, f.key)).rejects.toThrow('EXPIRED');
  });
  it('keeps uncertain publishing as a save/discard barrier and settles only the exact intent identity', async () => {
    const f = await fixture(); await f.lock(); const save = f.save('publication bytes'); await saveDraft(f.ports, save);
    const request = { ...f.key, sequence: 1, sha256: save.sha256 };
    const begun = await beginDraftPublish(f.ports, request);
    expect(begun.dispatch).toBe(true); expect((await beginDraftPublish(f.ports, request)).dispatch).toBe(false);
    const settle = { ...request, intent: begun.receipt.publishIntent, outcome: 'unknown', versionId: null };
    await settleDraftPublish(f.ports, settle);
    await expect(saveDraft(f.ports, f.save('new bytes', 1))).rejects.toThrow('PUBLISH_BARRIER');
    await expect(discardDraft(f.ports, f.key)).rejects.toThrow('PUBLISH_BARRIER');
    await expect(settleDraftPublish(f.ports, { ...settle, sha256: 'b'.repeat(64) })).rejects.toThrow('PUBLISH_IDENTITY');
    const versionId = randomUUID(), published = { ...settle, outcome: 'published', versionId };
    expect(await settleDraftPublish(f.ports, published)).toMatchObject({ state: 'published', publishedVersionId: versionId });
    expect(await settleDraftPublish(f.ports, published)).toMatchObject({ state: 'published' });
    await expect(settleDraftPublish(f.ports, { ...published, versionId: randomUUID() })).rejects.toThrow('PUBLISH_BARRIER');
  });
  it('preserves bytes on stale-parent conflict and permits explicit discard without a published mutation', async () => {
    const f = await fixture(); await f.lock(); const save = f.save('keep my work'); await saveDraft(f.ports, save);
    const request = { ...f.key, sequence: 1, sha256: save.sha256 }, begun = await beginDraftPublish(f.ports, request);
    await settleDraftPublish(f.ports, { ...request, intent: begun.receipt.publishIntent, outcome: 'conflict', versionId: null });
    expect(await readDraft(f.ports, f.key)).toMatchObject({ state: 'conflict', bytesBase64: save.bytesBase64 });
    await expect(beginDraftPublish(f.ports, request)).rejects.toThrow('PUBLISH_BARRIER');
    expect(await discardDraft(f.ports, f.key)).toEqual({ discarded: true });
    await expect(readDraft(f.ports, f.key)).rejects.toThrow('CLOSED');
    await expect(openDraft(f.ports, f.source)).rejects.toThrow('CLOSED');
    expect(await discardDraft(f.ports, f.key)).toEqual({ discarded: true });
    const erased = await db.$queryRaw<Array<{ bytes: Buffer | null; sha256: string | null }>>`SELECT bytes,sha256
      FROM meri_office_drafts WHERE draft_id=${f.key.draftId}::uuid`;
    expect(erased).toEqual([{ bytes: null, sha256: null }]);
  });
  it('expires only the exact owner/chat private rows, including after member departure, without deleting active saves', async () => {
    const f = await fixture(), other = await fixture(f.ports.ctx.tenantId); await f.lock();
    await saveDraft(f.ports, f.save('expired private bytes'));
    const input = { tenantId: f.ports.ctx.tenantId, actorId: f.ports.ctx.userId, conversationId: f.key.conversationId };
    expect(await expireOfficeDrafts(scoped, input)).toEqual({ deleted: 0, remaining: false });
    await db.$executeRaw`UPDATE meri_office_drafts SET expires_at=clock_timestamp()-interval '1 second' WHERE draft_id=${f.key.draftId}::uuid`;
    await db.tenantMembership.update({ where: { id: f.member.id }, data: { status: 'removed' } });
    expect(await expireOfficeDrafts(scoped, { ...input, actorId: other.ports.ctx.userId })).toEqual({ deleted: 0, remaining: false });
    expect(await expireOfficeDrafts(scoped, input)).toEqual({ deleted: 1, remaining: false });
    expect(await expireOfficeDrafts(scoped, input)).toEqual({ deleted: 0, remaining: false });
    expect(await readDraft(other.ports, other.key)).toMatchObject({ draftId: other.key.draftId });
  });
});
