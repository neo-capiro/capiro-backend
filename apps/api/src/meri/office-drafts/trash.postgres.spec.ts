import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { manageConversation } from '../conversation-management/service.js';
import { MANAGEMENT_VERSION } from '../conversation-management/contract.js';
import { officeDatabase } from './postgres-fixture.js';
import { officeDraftFixture } from './postgres-scenario.js';
import { openDraft, readDraft, saveDraft } from './store.js';
import { readOfficeDraftRetention } from './retention-subject.js';
import { digest } from './input.js';
const url = process.env.OFFICE_DRAFT_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('Office retirement in the actual Core Trash transaction', () => {
  let db: PrismaClient, scoped: PrismaService;
  beforeAll(async () => { ({ db, scoped } = await officeDatabase(url!)); }, 60000);
  afterAll(async () => { await db?.$disconnect(); });
  const fixture = () => officeDraftFixture(db, scoped);
  const command = (f: Awaited<ReturnType<typeof fixture>>, operation: 'trash' | 'archive' | 'restore', revision = '0') => ({
    version: MANAGEMENT_VERSION, requestId: randomUUID(), conversationId: f.key.conversationId, expectedRevision: revision, operation,
  });
  const inventory = (f: Awaited<ReturnType<typeof fixture>>) => readOfficeDraftRetention(scoped, {
    tenantId: f.ports.ctx.tenantId, subject: { kind: 'conversation', id: f.key.conversationId },
  });
  it('Trash erases private bytes, Restore cannot revive them, and an old Trash replay cannot erase new active work', async () => {
    const f = await fixture(), other = await fixture();
    for (const item of [f, other]) { await item.lock(); await saveDraft(item.ports, item.save('saved private bytes')); }
    const trash = command(f, 'trash');
    expect((await manageConversation(scoped, f.ports.ctx, trash)).current.status).toBe('trashed');
    expect(await inventory(f)).toMatchObject({ drafts: 1, active: 0, bytes: 0 });
    expect((await readDraft(other.ports, other.key)).sequence).toBe(1);
    await expect(saveDraft(f.ports, f.save('late write', 1))).rejects.toThrow('UNAVAILABLE');
    await manageConversation(scoped, f.ports.ctx, command(f, 'restore', '1'));
    await expect(openDraft(f.ports, f.source)).rejects.toThrow('CLOSED');
    const next = { ...f.source, draftId: randomUUID() }; await openDraft(f.ports, next);
    expect((await manageConversation(scoped, f.ports.ctx, trash)).current.status).toBe('active');
    expect((await readDraft(f.ports, { conversationId: next.conversationId, draftId: next.draftId })).state).toBe('draft');
  });
  it('Archive preserves a saved private draft through Restore', async () => {
    const f = await fixture(); await f.lock(); const save = f.save('recoverable'); await saveDraft(f.ports, save);
    await manageConversation(scoped, f.ports.ctx, command(f, 'archive'));
    expect(await inventory(f)).toMatchObject({ active: 1, bytes: Buffer.byteLength('recoverable') });
    await manageConversation(scoped, f.ports.ctx, command(f, 'restore', '1'));
    expect((await readDraft(f.ports, f.key)).bytesBase64).toBe(save.bytesBase64);
  });
  function interceptReceipt(work: (tx: Prisma.TransactionClient) => Promise<void>) {
    return { ...scoped, withTenantUser: <T>(tenant: string, actor: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
      scoped.withTenantUser(tenant, actor, tx => fn(new Proxy(tx, { get(target, key) {
        if (key === 'clioConversationManagementReceipt') return new Proxy(target.clioConversationManagementReceipt, {
          get(model, method) {
            if (method === 'create') return async (args: Parameters<typeof model.create>[0]) => { await work(tx); return model.create(args); };
            const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value;
          },
        });
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } }))) } as PrismaService;
  }
  it('a refused metadata receipt rolls private-byte retirement back atomically', async () => {
    const f = await fixture(); await f.lock(); const save = f.save('rollback private bytes'); await saveDraft(f.ports, save);
    const failed = interceptReceipt(async () => { throw Error('synthetic receipt refused'); });
    await expect(manageConversation(failed, f.ports.ctx, command(f, 'trash'))).rejects.toThrow('synthetic receipt refused');
    expect((await db.clioConversation.findUniqueOrThrow({ where: { id: f.key.conversationId } })).status).toBe('active');
    expect((await readDraft(f.ports, f.key)).bytesBase64).toBe(save.bytesBase64);
    expect(await inventory(f)).toMatchObject({ active: 1, bytes: Buffer.byteLength('rollback private bytes') });
  });
  it('a Save queued behind Trash cannot restore retired bytes after the chat status commits', async () => {
    const f = await fixture(); await f.lock(); await saveDraft(f.ports, f.save('before Trash'));
    let entered!: (pid: number) => void, release!: () => void;
    const reached = new Promise<number>(r => { entered = r; }), hold = new Promise<void>(r => { release = r; });
    const paused = interceptReceipt(async tx => {
      const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      entered(rows[0]!.pid); await hold;
    });
    const trash = manageConversation(paused, f.ports.ctx, command(f, 'trash')); trash.catch(() => undefined);
    let checked: Promise<void> | undefined;
    try {
      const pid = await reached;
      checked = expect(saveDraft(f.ports, f.save('queued stale Save', 1))).rejects.toThrow('UNAVAILABLE');
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const rows = await db.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS(
          SELECT 1 FROM pg_stat_activity WHERE ${pid}::int=ANY(pg_blocking_pids(pid))) AS blocked`;
        if (rows[0]!.blocked) { blocked = true; break; }
        await new Promise(r => setTimeout(r, 10));
      }
      expect(blocked).toBe(true);
    } finally { release(); await trash; await checked; }
    expect(await inventory(f)).toMatchObject({ active: 0, bytes: 0 });
  });
  it('retrying current Trash cleans restored draft copies without another metadata revision', async () => {
    const f = await fixture(); await f.lock(); await saveDraft(f.ports, f.save('saved'));
    const trash = command(f, 'trash'), first = await manageConversation(scoped, f.ports.ctx, trash);
    const restored = Buffer.from('restored old copy');
    await db.$executeRaw`UPDATE meri_office_drafts SET state='draft',bytes=${restored},sha256=${digest(restored)}
      WHERE tenant_id=${f.ports.ctx.tenantId}::uuid AND draft_id=${f.key.draftId}::uuid`;
    expect(await inventory(f)).toMatchObject({ active: 1 });
    const retry = await manageConversation(scoped, f.ports.ctx, trash);
    expect(retry).toEqual(first); expect(await inventory(f)).toMatchObject({ active: 0, bytes: 0 });
  });
});
