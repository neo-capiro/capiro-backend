import { BadRequestException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { Client, Prisma, PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { clientsServiceFragment } from '../../clients/clients.service-fragment.fixture.js';
import { requireOwnerClient } from '../../clients/client-ordered-owner.access.js';
import { requireClientCapacity } from '../../clients/client-capacity.js';
import { validateClientFundingProfile } from '../../clients/client-funding-profile.validation.js';
import { officeDatabase } from './postgres-fixture.js';
import { officeDraftFixture } from './postgres-scenario.js';
import { retireClientOfficeDraftsInTx } from './client-retention.js';
import { readOfficeDraftRetention } from './retention-subject.js';
import { openDraft, readDraft, saveDraft } from './store.js';

type Owner = {
  setMemoryAccess(ctx: TenantContext, id: string, input: { memoryWall: boolean; userIds: string[] }): Promise<unknown>;
  update(ctx: TenantContext, id: string, input: { status: string }): Promise<Client>;
};
const OwnerClass = clientsServiceFragment(['setMemoryAccess', 'update', 'updateInTransaction', 'afterUpdate', 'indexProfileAfterCommit'], {
  BadRequestException, NotFoundException, retireClientOfficeDraftsInTx, requireOwnerClient,
  requireClientCapacity, validateClientFundingProfile,
}) as new (prisma: PrismaService) => Owner;
const url = process.env.OFFICE_DRAFT_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('Office retirement in exact client owner methods, ordinary-role PostgreSQL', () => {
  let db: PrismaClient, scoped: PrismaService;
  beforeAll(async () => { ({ db, scoped } = await officeDatabase(url!)); }, 60000);
  afterAll(async () => { await db?.$disconnect(); });
  const owner = (prisma = scoped) => Object.assign(new OwnerClass(prisma), {
    billingEnforced: false, clientKb: { indexClientProfileFireAndForget: jest.fn() }, withLogoUrl: (client: Client) => client,
  });
  const fixture = () => officeDraftFixture(db, scoped);
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const sibling = (f: Fixture) => officeDraftFixture(db, scoped, f.ports.ctx.tenantId, undefined, f.clientId);
  const inventory = (f: Fixture) => readOfficeDraftRetention(scoped, {
    tenantId: f.ports.ctx.tenantId, subject: { kind: 'conversation', id: f.key.conversationId },
  });
  async function saved(f: Fixture) { await f.lock(); await saveDraft(f.ports, f.save('private client draft')); }
  const wall = (f: Fixture, ids: string[], prisma = scoped, enabled = true) =>
    owner(prisma).setMemoryAccess(f.ports.ctx, f.clientId, { memoryWall: enabled, userIds: ids });

  it('revokes only excluded actors, preserves other clients/tenants, and regrant cannot revive closed IDs', async () => {
    const f = await fixture(), kept = await sibling(f);
    const otherClient = await officeDraftFixture(db, scoped, f.ports.ctx.tenantId), otherTenant = await fixture();
    for (const item of [f, kept, otherClient, otherTenant]) await saved(item);
    const conversationId = randomUUID(), tenantId = f.ports.ctx.tenantId, userId = f.ports.ctx.userId;
    await db.clientMemoryAccess.create({ data: { tenantId, userId, clientId: otherClient.clientId } });
    await db.clioConversation.create({ data: { id: conversationId, tenantId, userId, clientId: otherClient.clientId, title: 'Other client' } });
    await db.clioConversationBootstrapReceipt.create({ data: { tenantId, actorUserId: userId,
      conversationId, requestId: randomUUID(), scopeKind: 'client', clientId: otherClient.clientId } });
    const sameActorOtherClient = { ...f.source, conversationId, draftId: randomUUID() };
    await openDraft(f.ports, sameActorOtherClient);
    await wall(f, [kept.ports.ctx.userId]);
    expect(await inventory(f)).toMatchObject({ drafts: 1, active: 0, bytes: 0 });
    for (const item of [kept, otherClient, otherTenant]) expect((await readDraft(item.ports, item.key)).sequence).toBe(1);
    expect((await readDraft(f.ports, { conversationId, draftId: sameActorOtherClient.draftId })).state).toBe('draft');
    await expect(saveDraft(f.ports, f.save('late', 1))).rejects.toThrow('Chat not found');
    await wall(f, [kept.ports.ctx.userId, f.ports.ctx.userId]);
    await expect(openDraft(f.ports, f.source)).rejects.toThrow('CLOSED');
    const rows = await db.$queryRaw<Array<{ lock_token: string | null; editor_id: string | null; publish_intent: string | null }>>`
      SELECT lock_token,editor_id,publish_intent FROM meri_office_drafts WHERE draft_id=${f.key.draftId}::uuid`;
    expect(rows).toEqual([{ lock_token: null, editor_id: null, publish_intent: null }]);
  });

  it('raising a previously open wall also retires actors absent from its old grant roster', async () => {
    const f = await fixture(), other = await sibling(f); await saved(f); await saved(other);
    await wall(f, [], scoped, false);
    expect(await inventory(f)).toMatchObject({ active: 1 });
    await wall(f, [other.ports.ctx.userId]);
    expect(await inventory(f)).toMatchObject({ active: 0, bytes: 0 });
    expect(await inventory(other)).toMatchObject({ active: 1 });
  });

  it('archive retires every actor in the client and restoring the client preserves closed identities', async () => {
    const f = await fixture(), other = await sibling(f); await saved(f); await saved(other);
    expect((await owner().update(f.ports.ctx, f.clientId, { status: 'archived' })).status).toBe('archived');
    for (const item of [f, other]) expect(await inventory(item)).toMatchObject({ active: 0, bytes: 0 });
    await owner().update(f.ports.ctx, f.clientId, { status: 'active' });
    await expect(openDraft(other.ports, other.source)).rejects.toThrow('CLOSED');
  });

  function atAudit(actor: string, work: (tx: Prisma.TransactionClient) => Promise<void>) {
    return { ...scoped, withTenant: <T>(tenant: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
      scoped.withTenantUser(tenant, actor, tx => fn(new Proxy(tx, { get(target, key) {
        if (key === 'auditLog') return new Proxy(target.auditLog, { get(model, method) {
          if (method === 'create') return async (args: Parameters<typeof model.create>[0]) => { await work(tx); return model.create(args); };
          const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value;
        } });
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } }))) } as PrismaService;
  }

  it('restores actor RLS before audit; audit failure rolls grants, policy and private bytes back together', async () => {
    const f = await fixture(), other = await sibling(f); await saved(f); await saved(other);
    const failed = atAudit(f.ports.ctx.userId, async tx => {
      const [context] = await tx.$queryRaw<Array<{ actor: string; bypass: boolean }>>`SELECT
        current_setting('app.current_user',true) AS actor,COALESCE(rls_bypass(),false) AS bypass`;
      expect(context).toEqual({ actor: f.ports.ctx.userId, bypass: false });
      const rows = await tx.$queryRaw<Array<{ actor_user_id: string }>>`SELECT actor_user_id FROM meri_office_drafts`;
      expect(rows).toEqual([{ actor_user_id: f.ports.ctx.userId }]);
      throw Error('synthetic audit refused');
    });
    await expect(wall(f, [], failed)).rejects.toThrow('synthetic audit refused');
    expect(await db.clientMemoryAccess.count({ where: { clientId: f.clientId } })).toBe(2);
    for (const item of [f, other]) expect((await readDraft(item.ports, item.key)).sequence).toBe(1);
    expect(await db.auditLog.count({ where: { tenantId: f.ports.ctx.tenantId } })).toBe(0);
  });

  it('a Save queued behind revocation cannot restore bytes after the wall commits', async () => {
    const f = await fixture(); await saved(f);
    let entered!: (pid: number) => void, release!: () => void;
    const reached = new Promise<number>(r => { entered = r; }), hold = new Promise<void>(r => { release = r; });
    const paused = atAudit(f.ports.ctx.userId, async tx => {
      const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      entered(rows[0]!.pid); await hold;
    });
    const revoke = wall(f, [], paused); revoke.catch(() => undefined);
    let checked: Promise<void> | undefined;
    try {
      const pid = await reached;
      checked = expect(saveDraft(f.ports, f.save('queued stale Save', 1))).rejects.toThrow('Chat not found');
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const rows = await db.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS(
          SELECT 1 FROM pg_stat_activity WHERE ${pid}::int=ANY(pg_blocking_pids(pid))) AS blocked`;
        if (rows[0]!.blocked) { blocked = true; break; }
        await new Promise(r => setTimeout(r, 10));
      }
      expect(blocked).toBe(true);
    } finally { release(); await revoke; await checked; }
    expect(await inventory(f)).toMatchObject({ active: 0, bytes: 0 });
  });

  it('tenant RLS refuses a client from another tenant even under the internal cleanup helper', async () => {
    const f = await fixture(), other = await fixture(); await saved(f); await saved(other);
    await scoped.withTenantUser(f.ports.ctx.tenantId, f.ports.ctx.userId, async tx => {
      await retireClientOfficeDraftsInTx(tx, other.ports.ctx.tenantId, other.clientId);
      const rows = await tx.$queryRaw<Array<{ actor: string }>>`SELECT current_setting('app.current_user',true) AS actor`;
      expect(rows[0]!.actor).toBe(f.ports.ctx.userId);
    });
    expect(await inventory(other)).toMatchObject({ active: 1 });
  });
});
