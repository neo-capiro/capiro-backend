import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { officeDatabase } from './postgres-fixture.js';
import { officeDraftFixture } from './postgres-scenario.js';
import { memberOwnerFragment } from './member-owner.fixture.js';
import { retireMemberOfficeDraftsInTx } from './member-retention.js';
import { openDraft, readDraft, saveDraft, lockDraft } from './store.js';
import { admitOfficeEditor } from './editor.js';

type Dependencies = { prisma: PrismaService; outbox: {
  enqueueClerkMembershipDelete(tx: Prisma.TransactionClient): Promise<string | null>;
  attemptNow(id: string): Promise<boolean>;
} };
type TenantOwner = { removeMember(ctx: TenantContext, userId: string): Promise<unknown> };
type HqOwner = { removeUserFromTenant(actor: string, tenant: string, user: string): Promise<unknown> };
const TenantOwner = memberOwnerFragment('tenant-admin/tenant-admin.service.ts', 'TenantAdminService', ['removeMember']) as new (d: Dependencies) => TenantOwner;
const HqOwner = memberOwnerFragment('capiro-admin/capiro-admin.service.ts', 'CapiroAdminService', ['removeUserFromTenant']) as new (d: Dependencies) => HqOwner;
const url = process.env.OFFICE_DRAFT_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('Member departure and private Office bytes in ordinary-role PostgreSQL', () => {
  let db: PrismaClient, scoped: PrismaService;
  beforeAll(async () => { ({ db, scoped } = await officeDatabase(url!)); }, 60000);
  afterAll(async () => { await db?.$disconnect(); });
  const fixture = () => officeDraftFixture(db, scoped);
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const outbox = () => ({ enqueueClerkMembershipDelete: jest.fn(async (_tx: Prisma.TransactionClient): Promise<string | null> => null), attemptNow: jest.fn(async () => true) });
  async function saved(f: Fixture) { await f.lock(); await saveDraft(f.ports, f.save('private bytes')); }
  async function retired(draftId: string) {
    const [row] = await db.$queryRaw<Array<Record<string, unknown>>>`SELECT state,bytes,sha256,editor_id,
      editor_expires_at,lock_token,lock_expires_at,publish_intent,published_version_id
      FROM meri_office_drafts WHERE draft_id=${draftId}::uuid`;
    expect(row).toEqual({ state: 'discarded', bytes: null, sha256: null, editor_id: null,
      editor_expires_at: null, lock_token: null, lock_expires_at: null, publish_intent: null, published_version_id: null });
  }
  async function administrator(f: Fixture) {
    const admin = await officeDraftFixture(db, scoped, f.ports.ctx.tenantId);
    await db.tenantMembership.update({ where: { id: admin.member.id }, data: { role: 'user_admin' } });
    return { ...admin.ports.ctx, role: 'user_admin' as const };
  }
  async function general(f: Fixture, tenantId = f.ports.ctx.tenantId) {
    const ctx = { ...f.ports.ctx, tenantId }, key = { conversationId: randomUUID(), draftId: randomUUID() };
    if (tenantId !== f.ports.ctx.tenantId) await db.tenantMembership.create({ data: { tenantId, userId: ctx.userId,
      role: 'standard_user', status: 'active' } });
    await db.clioConversation.create({ data: { id: key.conversationId, tenantId, userId: ctx.userId, title: 'General test' } });
    await db.clioConversationBootstrapReceipt.create({ data: { tenantId, actorUserId: ctx.userId,
      conversationId: key.conversationId, requestId: randomUUID(), scopeKind: 'general' } });
    const ports = { ...f.ports, ctx, authority: { readCurrent: async () => ({
      principal: { tenantId, actorId: ctx.userId }, expiresAtMs: Date.now() + 600000,
    }) } as unknown as typeof f.ports.authority };
    const source = { ...f.source, ...key }, editor = { editorId: randomUUID(), editorEpoch: 1 };
    await openDraft(ports, source);
    await admitOfficeEditor(ports, { ...key, operation: 'acquire', editorId: editor.editorId, expectedEpoch: 0 });
    await lockDraft(ports, { ...key, ...editor, operation: 'lock', lock: 'writer-1' });
    await saveDraft(ports, { ...f.save('private General bytes'), ...key, ...editor });
    return { ports, key, source };
  }
  const remove = (f: Fixture, ctx: TenantContext, jobs = outbox()) =>
    new TenantOwner({ prisma: scoped, outbox: jobs }).removeMember(ctx, f.ports.ctx.userId);

  it('tenant removal clears client and General drafts, preserves other actors/tenants, and regrant keeps IDs closed', async () => {
    const f = await fixture(), admin = await administrator(f), other = await fixture();
    const kept = await officeDraftFixture(db, scoped, f.ports.ctx.tenantId);
    for (const item of [f, kept, other]) await saved(item);
    const g = await general(f), foreign = await general(f, other.ports.ctx.tenantId);
    await remove(f, admin);
    for (const item of [f, g]) await retired(item.key.draftId);
    for (const item of [kept, other, foreign]) expect((await readDraft(item.ports, item.key)).sequence).toBe(1);
    await expect(saveDraft(f.ports, f.save('late', 1))).rejects.toThrow('Current conversation access unavailable');
    await db.tenantMembership.update({ where: { id: f.member.id }, data: { status: 'active' } });
    for (const item of [f, g]) await expect(openDraft(item.ports, item.source)).rejects.toThrow('CLOSED');
  });

  it('repeat removal retires a restored draft without issuing another identity deletion', async () => {
    const f = await fixture(), admin = await administrator(f); await saved(f);
    await db.tenantMembership.update({ where: { id: f.member.id }, data: { status: 'removed' } });
    const jobs = outbox(); await remove(f, admin, jobs); await retired(f.key.draftId);
    expect(jobs.enqueueClerkMembershipDelete).not.toHaveBeenCalled();
  });

  it('an outbox failure rolls membership and draft cleanup back; actor context is restored first', async () => {
    const f = await fixture(), admin = await administrator(f); await saved(f);
    await db.tenant.update({ where: { id: f.ports.ctx.tenantId }, data: { clerkOrgId: 'office-' + randomUUID() } });
    const jobs = outbox();
    jobs.enqueueClerkMembershipDelete.mockImplementation(async tx => {
      const [context] = await tx.$queryRaw<Array<{ actor: string; bypass: boolean }>>`SELECT
        COALESCE(current_setting('app.current_user',true),'') AS actor,COALESCE(rls_bypass(),false) AS bypass`;
      expect(context).toEqual({ actor: '', bypass: false });
      throw Error('synthetic outbox refused');
    });
    await expect(remove(f, admin, jobs)).rejects.toThrow('synthetic outbox refused');
    expect((await db.tenantMembership.findUniqueOrThrow({ where: { id: f.member.id } })).status).toBe('active');
    expect((await readDraft(f.ports, f.key)).sequence).toBe(1);
    expect(jobs.attemptNow).not.toHaveBeenCalled();
  });

  it('HQ removal retires only the target and commits its affected-tenant audit', async () => {
    const f = await fixture(), other = await officeDraftFixture(db, scoped, f.ports.ctx.tenantId);
    await saved(f); await saved(other);
    await new HqOwner({ prisma: scoped, outbox: outbox() }).removeUserFromTenant(other.ports.ctx.userId, f.ports.ctx.tenantId, f.ports.ctx.userId);
    await retired(f.key.draftId); expect((await readDraft(other.ports, other.key)).sequence).toBe(1);
    expect(await db.auditLog.count({ where: { tenantId: f.ports.ctx.tenantId, action: 'tenant.user.remove' } })).toBe(1);
  });

  it('HQ audit failure rolls membership and private bytes back', async () => {
    const f = await fixture(); await saved(f);
    await expect(new HqOwner({ prisma: scoped, outbox: outbox() })
      .removeUserFromTenant('invalid-uuid', f.ports.ctx.tenantId, f.ports.ctx.userId)).rejects.toThrow();
    expect((await db.tenantMembership.findUniqueOrThrow({ where: { id: f.member.id } })).status).toBe('active');
    expect((await readDraft(f.ports, f.key)).sequence).toBe(1);
    expect(await db.auditLog.count({ where: { tenantId: f.ports.ctx.tenantId } })).toBe(0);
  });

  it('a Save queued behind removal cannot restore private bytes', async () => {
    const f = await fixture(), admin = await administrator(f); await saved(f);
    await db.tenant.update({ where: { id: f.ports.ctx.tenantId }, data: { clerkOrgId: 'office-' + randomUUID() } });
    let entered!: (pid: number) => void, release!: () => void;
    const reached = new Promise<number>(r => { entered = r; }), hold = new Promise<void>(r => { release = r; });
    const jobs = { ...outbox(), enqueueClerkMembershipDelete: async (tx: Prisma.TransactionClient) => {
      const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      entered(row!.pid); await hold; return null;
    } };
    const removing = new TenantOwner({ prisma: scoped, outbox: jobs }).removeMember(admin, f.ports.ctx.userId);
    removing.catch(() => undefined);
    let checked: Promise<void> | undefined;
    try {
      const pid = await reached;
      checked = expect(saveDraft(f.ports, f.save('late', 1))).rejects.toThrow('Current conversation access unavailable');
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const [row] = await db.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS(
          SELECT 1 FROM pg_stat_activity WHERE ${pid}::int=ANY(pg_blocking_pids(pid))) AS blocked`;
        if (row!.blocked) { blocked = true; break; }
        await new Promise(r => setTimeout(r, 10));
      }
      expect(blocked).toBe(true);
    } finally { release(); await removing; await checked; }
    await retired(f.key.draftId);
  });

  it('ordinary tenant RLS refuses foreign cleanup and active membership prevents accidental retirement', async () => {
    const f = await fixture(), other = await fixture(); await saved(f); await saved(other);
    await db.tenantMembership.update({ where: { id: other.member.id }, data: { status: 'removed' } });
    await scoped.withTenantUser(f.ports.ctx.tenantId, f.ports.ctx.userId, async tx => {
      await retireMemberOfficeDraftsInTx(tx, other.ports.ctx.tenantId, other.ports.ctx.userId);
      await retireMemberOfficeDraftsInTx(tx, f.ports.ctx.tenantId, f.ports.ctx.userId);
      const [row] = await tx.$queryRaw<Array<{ actor: string }>>`SELECT current_setting('app.current_user',true) AS actor`;
      expect(row!.actor).toBe(f.ports.ctx.userId);
    });
    expect((await readDraft(f.ports, f.key)).sequence).toBe(1);
    const [row] = await db.$queryRaw<Array<{ bytes: number }>>`SELECT octet_length(bytes) AS bytes
      FROM meri_office_drafts WHERE draft_id=${other.key.draftId}::uuid`;
    expect(row!.bytes).toBeGreaterThan(0);
  });
});
