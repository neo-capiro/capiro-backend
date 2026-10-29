import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { officeDatabase } from './postgres-fixture.js';
import { openDraft, readDraft, readEditorDraft, lockDraft, saveDraft, discardDraft } from './store.js';
import { beginDraftPublish, settleDraftPublish } from './publication.js';
import { admitOfficeEditor } from './editor.js';
import { digest } from './input.js';
import type { OfficeAuthority } from './authority.js';
import { expireOfficeDrafts } from './retention.js';
import { readOfficeDraftRetention, retireOfficeDrafts, OFFICE_RETENTION_VERSION } from './retention-subject.js';
const url = process.env.OFFICE_DRAFT_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('private Office drafts on ordinary-role PostgreSQL', () => {
  let db: PrismaClient, scoped: PrismaService;
  beforeAll(async () => { ({ db, scoped } = await officeDatabase(url!)); }, 60000);
  afterAll(async () => { await db?.$disconnect(); });
  async function fixture(existingTenantId?: string, artifactId = randomUUID()) {
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
    const source = { ...key, artifactId, baseVersionId: randomUUID(), baseSha256: 'a'.repeat(64), format: 'docx', filename: 'draft.docx' };
    const opened = await openDraft(ports, source);
    const editor = { editorId: randomUUID(), editorEpoch: 1 };
    await admitOfficeEditor(ports, { ...key, operation: 'acquire', editorId: editor.editorId, expectedEpoch: 0 });
    const lock = (operation = 'lock', token = 'writer-1') => lockDraft(ports, { ...key, ...editor, operation, ...(operation === 'get' ? {} : { lock: token }) });
    const save = (text: string, expectedSequence = 0) => {
      const bytes = Buffer.from(text); return { ...key, ...editor, lock: 'writer-1', expectedSequence,
        sha256: digest(bytes), bytesBase64: bytes.toString('base64'), kind: 'explicit' };
    };
    return { ports, key, source, opened, member, clientId, editor, lock, save };
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
  it('roundtrips extended opaque locks containing spaces through ordinary-role custody and save', async () => {
    const f = await fixture(), lock = '{"owner": "CODE", "pad": "' + 'x'.repeat(996) + '"}';
    expect(lock.length).toBe(1024);
    expect(await f.lock('lock', lock)).toEqual({ status: 200 });
    expect(await f.lock('get')).toEqual({ status: 200, lock });
    expect(await f.lock('lock', 'other')).toEqual({ status: 409, lock });
    expect(await saveDraft(f.ports, { ...f.save('exact bytes'), lock })).toMatchObject({ status: 200, receipt: { sequence: 1 } });
    expect(await lockDraft(f.ports, { ...f.key, ...f.editor, operation: 'relock', oldLock: lock, lock: 'new lock' })).toEqual({ status: 200 });
    expect(await f.lock('refresh', 'new lock')).toEqual({ status: 200 });
    expect(await f.lock('unlock', 'new lock')).toEqual({ status: 200 });
  });
  it('serializes locks and refuses incorrect/expired locks before saving; supports relock and unlock', async () => {
    const f = await fixture(); expect(await f.lock()).toEqual({ status: 200 });
    expect(await f.lock('lock', 'writer-2')).toEqual({ status: 409, lock: 'writer-1' });
    expect(await saveDraft(f.ports, { ...f.save('x'), lock: 'wrong' })).toEqual({ status: 409, lock: 'writer-1' });
    expect(await lockDraft(f.ports, { ...f.key, ...f.editor, operation: 'relock', oldLock: 'writer-1', lock: 'writer-2' })).toEqual({ status: 200 });
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
  it('admits only one concurrent editor across independent connections and replays its exact acknowledgement', async () => {
    const f = await fixture(), other = await officeDatabase(url!);
    try {
      await admitOfficeEditor(f.ports, { ...f.key, operation: 'release', editorId: f.editor.editorId, expectedEpoch: 1 });
      const requests = [randomUUID(), randomUUID()].map(editorId => ({ ...f.key, operation: 'acquire', editorId, expectedEpoch: 1 }));
      const results = await Promise.allSettled(requests.map((request, i) => admitOfficeEditor({ ...f.ports, prisma: i ? other.scoped : scoped }, request)));
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      const winner = results.findIndex(r => r.status === 'fulfilled'), result = (results[winner] as PromiseFulfilledResult<any>).value;
      expect(result.epoch).toBe(2); expect(await admitOfficeEditor(f.ports, requests[winner])).toEqual(result);
      await expect(admitOfficeEditor(f.ports, { ...requests[1 - winner], expectedEpoch: 2 })).rejects.toThrow('BUSY');
    } finally { await other.db.$disconnect(); }
  });
  it('explicit takeover fences stale read/lock/save and clears the old WOPI lock without losing saved bytes', async () => {
    const f = await fixture(); await f.lock(); const saved = f.save('kept through takeover'); await saveDraft(f.ports, saved);
    const request = { ...f.key, operation: 'takeover', editorId: randomUUID(), expectedEpoch: 1 };
    const next = await admitOfficeEditor(f.ports, request), proof = { editorId: next.editorId, editorEpoch: next.epoch };
    expect(await admitOfficeEditor(f.ports, request)).toEqual(next);
    await expect(readEditorDraft(f.ports, { ...f.key, ...f.editor })).rejects.toThrow('EDITOR_STALE');
    await expect(f.lock('get')).rejects.toThrow('EDITOR_STALE');
    await expect(saveDraft(f.ports, f.save('stale frame', 1))).rejects.toThrow('EDITOR_STALE');
    expect(await lockDraft(f.ports, { ...f.key, ...proof, operation: 'get' })).toEqual({ status: 200, lock: '' });
    expect((await readEditorDraft(f.ports, { ...f.key, ...proof })).bytesBase64).toBe(saved.bytesBase64);
  });
  it('release is idempotent and old acquire cannot revive; reusing an editor ID still advances the epoch', async () => {
    const f = await fixture(); await f.lock(); await saveDraft(f.ports, f.save('recoverable'));
    const release = { ...f.key, operation: 'release', editorId: f.editor.editorId, expectedEpoch: 1 };
    expect(await admitOfficeEditor(f.ports, release)).toEqual({ editorId: null, epoch: 1, expiresAt: null });
    expect(await admitOfficeEditor(f.ports, release)).toEqual({ editorId: null, epoch: 1, expiresAt: null });
    await expect(admitOfficeEditor(f.ports, { ...release, operation: 'acquire', expectedEpoch: 0 })).rejects.toThrow('EDITOR_STALE');
    const next = await admitOfficeEditor(f.ports, { ...release, operation: 'acquire' }); expect(next.epoch).toBe(2);
    await expect(admitOfficeEditor(f.ports, release)).rejects.toThrow('EDITOR_STALE');
    await expect(readEditorDraft(f.ports, { ...f.key, ...f.editor })).rejects.toThrow('EDITOR_STALE');
    expect((await readDraft(f.ports, f.key)).sequence).toBe(1);
  });
  it('uses database expiry for editor reads and writes; expired refresh cannot resurrect a frame', async () => {
    const f = await fixture(); await f.lock(); await saveDraft(f.ports, f.save('survives editor expiry'));
    await db.$executeRaw`UPDATE meri_office_drafts SET editor_expires_at=clock_timestamp()-interval '1 second' WHERE draft_id=${f.key.draftId}::uuid`;
    for (const effect of [() => f.lock('get'), () => saveDraft(f.ports, f.save('late', 1)), () => readEditorDraft(f.ports, { ...f.key, ...f.editor }),
      () => admitOfficeEditor(f.ports, { ...f.key, operation: 'refresh', editorId: f.editor.editorId, expectedEpoch: 1 })])
      await expect(effect()).rejects.toThrow('EDITOR_STALE');
    expect(await admitOfficeEditor(f.ports, { ...f.key, operation: 'inspect' })).toEqual({ editorId: null, epoch: 1, expiresAt: null });
    expect((await readDraft(f.ports, f.key)).sequence).toBe(1);
    expect((await admitOfficeEditor(f.ports, { ...f.key, operation: 'acquire', editorId: randomUUID(), expectedEpoch: 1 })).epoch).toBe(2);
  });
  it('refresh preserves epoch/lock, but pending publication cannot acquire or refresh a writing frame', async () => {
    const f = await fixture(); await f.lock(); const save = f.save('publish barrier'); await saveDraft(f.ports, save);
    const request = { ...f.key, operation: 'refresh', editorId: f.editor.editorId, expectedEpoch: 1 };
    expect((await admitOfficeEditor(f.ports, request)).epoch).toBe(1); expect(await f.lock('get')).toEqual({ status: 200, lock: 'writer-1' });
    await beginDraftPublish(f.ports, { ...f.key, sequence: 1, sha256: save.sha256 });
    await expect(admitOfficeEditor(f.ports, request)).rejects.toThrow('PUBLISH_BARRIER');
    await expect(admitOfficeEditor(f.ports, { ...request, operation: 'takeover', editorId: randomUUID() })).rejects.toThrow('PUBLISH_BARRIER');
    await admitOfficeEditor(f.ports, { ...request, operation: 'release' });
    expect((await readDraft(f.ports, f.key)).state).toBe('publish-pending');
  });
  it('fences stale takeover and release without changing current editor admission', async () => {
    const f = await fixture();
    for (const operation of ['takeover', 'release', 'refresh'])
      await expect(admitOfficeEditor(f.ports, { ...f.key, operation, editorId: randomUUID(), expectedEpoch: 0 })).rejects.toThrow('EDITOR_STALE');
    expect(await admitOfficeEditor(f.ports, { ...f.key, operation: 'inspect' })).toMatchObject({ editorId: f.editor.editorId, epoch: 1 });
    await discardDraft(f.ports, f.key);
    await expect(admitOfficeEditor(f.ports, { ...f.key, operation: 'inspect' })).rejects.toThrow('CLOSED');
  });
  it('fails closed at epoch exhaustion without preventing release or corrupting the counter', async () => {
    const f = await fixture(); await db.$executeRaw`UPDATE meri_office_drafts SET editor_epoch=2147483647 WHERE draft_id=${f.key.draftId}::uuid`;
    const request = { ...f.key, operation: 'release', editorId: f.editor.editorId, expectedEpoch: 2147483647 };
    await admitOfficeEditor(f.ports, request);
    await expect(admitOfficeEditor(f.ports, { ...request, operation: 'acquire' })).rejects.toThrow('EPOCH_LIMIT');
    expect(await admitOfficeEditor(f.ports, { ...f.key, operation: 'inspect' })).toEqual({ editorId: null, epoch: 2147483647, expiresAt: null });
  });
  it('current owner, member and wall checks apply to editor admission, never the lease alone', async () => {
    const f = await fixture(), other = await fixture(f.ports.ctx.tenantId), request = { ...f.key, operation: 'inspect' };
    await expect(admitOfficeEditor(other.ports, request)).rejects.toThrow();
    await db.clientMemoryAccess.deleteMany({ where: { tenantId: f.ports.ctx.tenantId, userId: f.ports.ctx.userId } });
    await expect(admitOfficeEditor(f.ports, request)).rejects.toThrow('Chat not found');
  });
  it('a Save queued behind a takeover rechecks the new epoch before committing any bytes', async () => {
    const f = await fixture(); await f.lock(); await saveDraft(f.ports, f.save('before takeover'));
    let entered!: () => void, resume!: () => void, queued!: () => void;
    const atLock = new Promise<void>(resolve => { entered = resolve; }), continueTakeover = new Promise<void>(resolve => { resume = resolve; });
    const saveAdmitted = new Promise<void>(resolve => { queued = resolve; });
    let admissions = 0;
    const takeoverAuthority = { readCurrent: async (tx: Parameters<OfficeAuthority['readCurrent']>[0]) => {
      if (++admissions === 2) { entered(); await continueTakeover; }
      return f.ports.authority.readCurrent(tx);
    } } as OfficeAuthority;
    const takeover = admitOfficeEditor({ ...f.ports, authority: takeoverAuthority },
      { ...f.key, operation: 'takeover', editorId: randomUUID(), expectedEpoch: 1 });
    await atLock;
    const queuedAuthority = { readCurrent: async (tx: Parameters<OfficeAuthority['readCurrent']>[0]) => {
      queued(); return f.ports.authority.readCurrent(tx);
    } } as OfficeAuthority;
    const attempt = saveDraft({ ...f.ports, authority: queuedAuthority }, f.save('stale queued write', 1));
    // Attach rejection handling before the held transaction is released.
    const checked = expect(attempt).rejects.toThrow('EDITOR_STALE');
    try { await saveAdmitted; } finally { resume(); }
    await takeover; await checked;
    const result = await readDraft(f.ports, f.key); expect(result.sequence).toBe(1);
    expect(Buffer.from(result.bytesBase64!, 'base64').toString()).toBe('before takeover');
  });
  const retirement = (f: Awaited<ReturnType<typeof fixture>>, kind = 'conversation') => ({
    tenantId: f.ports.ctx.tenantId, subject: { kind, id: kind === 'conversation' ? f.key.conversationId : f.source.artifactId },
  });
  it('retires private bytes, locks and pending publication while keeping a closed editor identity', async () => {
    const f = await fixture(); await f.lock(); const saved = f.save('retire private bytes');
    await saveDraft(f.ports, saved);
    await beginDraftPublish(f.ports, { ...f.key, sequence: 1, sha256: saved.sha256 });
    const input = retirement(f);
    expect(await readOfficeDraftRetention(scoped, input)).toEqual({ version: OFFICE_RETENTION_VERSION, ...input,
      drafts: 1, active: 1, bytes: Buffer.byteLength('retire private bytes') });
    expect(await retireOfficeDrafts(scoped, input)).toEqual({ version: OFFICE_RETENTION_VERSION, ...input, retired: 1, remaining: false });
    expect(await readOfficeDraftRetention(scoped, input)).toMatchObject({ drafts: 1, active: 0, bytes: 0 });
    expect(await retireOfficeDrafts(scoped, input)).toMatchObject({ retired: 0, remaining: false });
    await expect(openDraft(f.ports, f.source)).rejects.toThrow('CLOSED');
    await expect(saveDraft(f.ports, f.save('late save', 1))).rejects.toThrow('CLOSED');
    const rows = await db.$queryRaw<Array<{ bytes: Buffer | null; editor_id: string | null; lock_token: string | null;
      publish_intent: string | null; published_version_id: string | null }>>`SELECT bytes,editor_id,lock_token,publish_intent,published_version_id
      FROM meri_office_drafts WHERE tenant_id=${input.tenantId}::uuid AND draft_id=${f.key.draftId}::uuid`;
    expect(rows).toEqual([{ bytes: null, editor_id: null, lock_token: null, publish_intent: null, published_version_id: null }]);
  });
  it('artifact retirement covers all private writers but cannot cross tenant or artifact boundaries', async () => {
    const first = await fixture(), second = await fixture(first.ports.ctx.tenantId, first.source.artifactId);
    const otherTenant = await fixture(undefined, first.source.artifactId), otherArtifact = await fixture(first.ports.ctx.tenantId);
    for (const f of [first, second, otherTenant, otherArtifact]) { await f.lock(); await saveDraft(f.ports, f.save('private')); }
    const input = retirement(first, 'artifact');
    expect(await retireOfficeDrafts(scoped, input)).toMatchObject({ retired: 2, remaining: false });
    expect(await readOfficeDraftRetention(scoped, input)).toMatchObject({ drafts: 2, active: 0, bytes: 0 });
    for (const f of [otherTenant, otherArtifact]) expect((await readDraft(f.ports, f.key)).sequence).toBe(1);
    // The system operation's transaction-local bypass must not leak into ordinary reads.
    const visible = await scoped.withTenantUser(first.ports.ctx.tenantId, first.ports.ctx.userId,
      tx => tx.$queryRaw<Array<{ draft_id: string }>>`SELECT draft_id FROM meri_office_drafts`);
    expect(visible).toEqual([{ draft_id: first.key.draftId }]);
  });
  it('retirement is bounded to one hundred rows and reports unfinished batches', async () => {
    const f = await fixture(), input = retirement(f);
    await db.$executeRaw`INSERT INTO meri_office_drafts
      (tenant_id,actor_user_id,conversation_id,draft_id,artifact_id,base_version_id,base_sha256,format,filename,expires_at)
      SELECT tenant_id,actor_user_id,conversation_id,gen_random_uuid(),artifact_id,base_version_id,base_sha256,format,filename,expires_at
      FROM meri_office_drafts CROSS JOIN generate_series(1,101) WHERE tenant_id=${input.tenantId}::uuid AND draft_id=${f.key.draftId}::uuid`;
    expect(await readOfficeDraftRetention(scoped, input)).toMatchObject({ drafts: 102, active: 102 });
    expect(await retireOfficeDrafts(scoped, input)).toMatchObject({ retired: 100, remaining: true });
    expect(await retireOfficeDrafts(scoped, input)).toMatchObject({ retired: 2, remaining: false });
    expect(await readOfficeDraftRetention(scoped, input)).toMatchObject({ drafts: 102, active: 0, bytes: 0 });
  });
  it('a locked writer cannot be silently reported as erased', async () => {
    const f = await fixture(); await f.lock(); await saveDraft(f.ports, f.save('pending writer'));
    let acquired!: () => void, release!: () => void;
    const locked = new Promise<void>(r => { acquired = r; }), held = new Promise<void>(r => { release = r; });
    const writer = db.$transaction(async tx => {
      await tx.$executeRaw`SELECT draft_id FROM meri_office_drafts WHERE tenant_id=${f.ports.ctx.tenantId}::uuid
        AND draft_id=${f.key.draftId}::uuid FOR UPDATE`;
      acquired(); await held;
    }, { timeout: 15000 });
    try {
      await locked;
      expect(await retireOfficeDrafts(scoped, retirement(f))).toMatchObject({ retired: 0, remaining: true });
      expect(await readOfficeDraftRetention(scoped, retirement(f))).toMatchObject({ active: 1, bytes: Buffer.byteLength('pending writer') });
    } finally { release(); await writer; }
    expect(await retireOfficeDrafts(scoped, retirement(f))).toMatchObject({ retired: 1, remaining: false });
  });
  it('fresh inventory detects restored private bytes and retirement works after membership departure', async () => {
    const f = await fixture(); await f.lock(); await saveDraft(f.ports, f.save('saved'));
    await db.tenantMembership.update({ where: { id: f.member.id }, data: { status: 'removed' } });
    const input = retirement(f);
    expect(await retireOfficeDrafts(scoped, input)).toMatchObject({ retired: 1 });
    const bytes = Buffer.from('restored private bytes');
    await db.$executeRaw`UPDATE meri_office_drafts SET state='draft',bytes=${bytes},sha256=${digest(bytes)}
      WHERE tenant_id=${input.tenantId}::uuid AND draft_id=${f.key.draftId}::uuid`;
    expect(await readOfficeDraftRetention(scoped, input)).toMatchObject({ active: 1, bytes: bytes.length });
    expect(await retireOfficeDrafts(scoped, input)).toMatchObject({ retired: 1, remaining: false });
    await db.$executeRaw`UPDATE meri_office_drafts SET expires_at=clock_timestamp()-interval '1 second'
      WHERE tenant_id=${input.tenantId}::uuid AND draft_id=${f.key.draftId}::uuid`;
    expect(await expireOfficeDrafts(scoped, { tenantId: input.tenantId, actorId: f.ports.ctx.userId,
      conversationId: f.key.conversationId })).toEqual({ deleted: 1, remaining: false });
    expect(await readOfficeDraftRetention(scoped, input)).toMatchObject({ drafts: 0, active: 0, bytes: 0 });
  });
});
