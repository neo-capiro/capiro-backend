import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { memberOwnerFragment } from './member-owner.fixture.js';
import { officeDatabase } from './postgres-fixture.js';
import { officeDraftFixture } from './postgres-scenario.js';
import { readDraft, saveDraft } from './store.js';

type IdentityOwner = { dispatch(tx: Prisma.TransactionClient, event: unknown): Promise<void>;
  mergeUserIdentity(tx: Prisma.TransactionClient, source: string, target: string): Promise<void> };
const Webhook = memberOwnerFragment('webhooks/clerk-webhook.service.ts', 'ClerkWebhookService',
  ['dispatch', 'mergeUserIdentity'], ['deletedClerkUserId', 'deletedEmail']) as new (d: object) => IdentityOwner;
const Provisioning = memberOwnerFragment('auth/clerk-provisioning.service.ts', 'ClerkProvisioningService',
  ['mergeUserIdentity']) as new (d: object) => IdentityOwner;
const url = process.env.OFFICE_DRAFT_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('Office retirement in canonical identity owner methods', () => {
  let db: PrismaClient, scoped: PrismaService;
  beforeAll(async () => { ({ db, scoped } = await officeDatabase(url!)); }, 60000);
  afterAll(async () => { await db?.$disconnect(); });
  const fixture = () => officeDraftFixture(db, scoped);
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function saved(f: Fixture) { await f.lock(); await saveDraft(f.ports, f.save('private identity bytes')); }
  async function retired(f: Fixture) {
    const rows = await db.$queryRaw<Array<{ state: string; bytes: Buffer | null }>>`SELECT state,bytes
      FROM meri_office_drafts WHERE draft_id=${f.key.draftId}::uuid`;
    expect(rows).toEqual([{ state: 'discarded', bytes: null }]);
  }
  async function membershipDeleted(f: Fixture) {
    const org = 'office-' + randomUUID();
    await db.tenant.update({ where: { id: f.ports.ctx.tenantId }, data: { clerkOrgId: org } });
    return { type: 'organizationMembership.deleted', data: { organization: { id: org },
      public_user_data: { user_id: f.ports.ctx.clerkUserId } } };
  }

  it('membership deletion clears only that tenant actor; missing membership replay remains idempotent', async () => {
    const f = await fixture(), other = await officeDraftFixture(db, scoped, f.ports.ctx.tenantId);
    await saved(f); await saved(other);
    const event = await membershipDeleted(f), owner = new Webhook({});
    await scoped.withSystem(tx => owner.dispatch(tx, event));
    await retired(f); expect((await readDraft(other.ports, other.key)).sequence).toBe(1);
    await db.tenantMembership.delete({ where: { id: f.member.id } });
    await expect(scoped.withSystem(tx => owner.dispatch(tx, event))).resolves.toBeUndefined();
    await retired(f);
  });

  it('user deletion retires every tenant membership, including previously removed stale drafts', async () => {
    const f = await fixture(), second = await fixture(), kept = await fixture();
    for (const item of [f, second, kept]) await saved(item);
    // Move this synthetic second tenant's fixture to the same canonical user.
    await db.tenantMembership.update({ where: { id: second.member.id }, data: { userId: f.ports.ctx.userId, status: 'removed' } });
    await db.clioConversation.update({ where: { id: second.key.conversationId }, data: { userId: f.ports.ctx.userId } });
    await db.clioConversationBootstrapReceipt.update({ where: { conversationId: second.key.conversationId }, data: { actorUserId: f.ports.ctx.userId } });
    await db.$executeRaw`UPDATE meri_office_drafts SET actor_user_id=${f.ports.ctx.userId}::uuid
      WHERE draft_id=${second.key.draftId}::uuid`;
    await scoped.withSystem(tx => new Webhook({}).dispatch(tx, { type: 'user.deleted', data: { id: f.ports.ctx.clerkUserId } }));
    await retired(f); await retired(second);
    expect((await readDraft(kept.ports, kept.key)).sequence).toBe(1);
    const user = await db.user.findUniqueOrThrow({ where: { id: f.ports.ctx.userId } });
    expect(user.clerkUserId.startsWith('deleted:')).toBe(true);
    expect(await db.tenantMembership.count({ where: { userId: user.id, status: 'active' } })).toBe(0);
  });

  it('a cleanup SQL failure preserves its cause and rolls the verified event transaction back', async () => {
    const f = await fixture(); await saved(f);
    const event = await membershipDeleted(f);
    await expect(scoped.withSystem(tx => new Webhook({}).dispatch(new Proxy(tx, { get(target, key) {
      if (key === '$executeRaw') return (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings.join('').includes('UPDATE meri_office_drafts')) return tx.$executeRaw`SELECT 1/0`;
        return tx.$executeRaw(strings, ...values);
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } }), event))).rejects.toThrow('division by zero');
    expect((await db.tenantMembership.findUniqueOrThrow({ where: { id: f.member.id } })).status).toBe('active');
    expect((await readDraft(f.ports, f.key)).sequence).toBe(1);
  });

  for (const [label, Owner] of [['webhook', Webhook], ['provisioning', Provisioning]] as const) {
    it.each([false, true])(`${label} identity merge retires source drafts with existing target membership=%s`, async existing => {
      const source = await fixture(); await saved(source);
      const target = await officeDraftFixture(db, scoped, existing ? source.ports.ctx.tenantId : undefined);
      await saved(target);
      await scoped.withSystem(tx => new Owner({}).mergeUserIdentity(tx, source.ports.ctx.userId, target.ports.ctx.userId));
      await retired(source); expect((await readDraft(target.ports, target.key)).sequence).toBe(1);
      expect(await db.tenantMembership.count({ where: { tenantId: source.ports.ctx.tenantId,
        userId: source.ports.ctx.userId, status: 'active' } })).toBe(0);
      expect(await db.tenantMembership.count({ where: { tenantId: source.ports.ctx.tenantId,
        userId: target.ports.ctx.userId, status: 'active' } })).toBe(1);
    });
  }
});
