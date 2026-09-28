import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { MeriService } from '../meri/meri.service.js';
const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
} as TenantContext;
function fixture() {
  let grant = true,
    member = true;
  const b = {
      kind: 'research_portfolio',
      researchPortfolioId: '33333333-3333-4333-8333-333333333333',
      researchPortfolioName: 'Private portfolio',
      researchPortfolioRevision: 1,
    },
    scope = { ...b, scopeVersion: createHash('sha256').update(JSON.stringify(b)).digest('hex') };
  const ordinary = {
    id: 'ordinary',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    clientId: null,
    metadata: {},
    messages: [{ body: 'ordinary transcript' }],
    artifacts: [{ bodyText: 'ordinary artifact' }],
  };
  const rp = {
    ...ordinary,
    id: 'rp',
    metadata: { researchPortfolioScope: scope },
    messages: [{ body: 'private transcript' }],
    artifacts: [{ bodyText: 'private draft' }],
  };
  let messageReads = 0;
  const tx: any = {
    $executeRaw: async () => 1,
    tenantMembership: { findFirst: async () => (member ? { id: 'member' } : null) },
    researchPortfolio: {
      findFirst: async () =>
        grant ? { id: b.researchPortfolioId, grants: [{ role: 'viewer' }], clientLinks: [] } : null,
    },
    clioConversation: {
      findMany: async () => [ordinary, rp],
      findFirst: async ({ where }: any) => (where.id === 'rp' ? rp : ordinary),
    },
    clioMessage: {
      findMany: async () => {
        messageReads++;
        return [{ body: 'private transcript', artifacts: rp.artifacts }];
      },
    },
  };
  const service: any = { prisma: { withTenant: async (_tenant: any, fn: any) => fn(tx) } };
  for (const key of [
    'ensureConversation',
    'ensureConversationAnyStatus',
    'authorizedResearchPortfolioHistory',
  ])
    service[key] = (MeriService.prototype as any)[key].bind(service);
  return {
    service,
    setGrant: (v: boolean) => (grant = v),
    setMember: (v: boolean) => (member = v),
    messageReads: () => messageReads,
  };
}
describe('RP current authority on ordinary Meri retrieval', () => {
  test('list hides whole revoked RP conversation including latest transcript/artifact, preserves ordinary rows', async () => {
    const f = fixture();
    let rows = await MeriService.prototype.listConversations.call(f.service, ctx);
    expect(rows).toHaveLength(2);
    f.setGrant(false);
    rows = await MeriService.prototype.listConversations.call(f.service, ctx);
    expect(rows.map((r: any) => r.id)).toEqual(['ordinary']);
    expect(JSON.stringify(rows)).not.toContain('private draft');
    f.setGrant(true);
    f.setMember(false);
    expect(
      (await MeriService.prototype.listConversations.call(f.service, ctx)).map((r: any) => r.id),
    ).toEqual(['ordinary']);
  });
  test('direct active/archive metadata and transcript reads require membership/current grant', async () => {
    const f = fixture();
    await MeriService.prototype.listMessages.call(f.service, ctx, 'rp');
    expect(f.messageReads()).toBe(1);
    f.setGrant(false);
    await expect(MeriService.prototype.listMessages.call(f.service, ctx, 'rp')).rejects.toThrow(
      'portfolio',
    );
    await expect(f.service.ensureConversation(ctx, 'rp')).rejects.toThrow('portfolio');
    await expect(f.service.ensureConversationAnyStatus(ctx, 'rp')).rejects.toThrow('portfolio');
    expect(f.messageReads()).toBe(1);
    await expect(f.service.ensureConversation(ctx, 'ordinary')).resolves.toHaveProperty(
      'id',
      'ordinary',
    );
  });
  test('shared semantic/keyword hit filter hides full private search body on revocation', async () => {
    const f = fixture();
    const hits = [
      { conversationId: 'ordinary', body: 'ordinary history' },
      { conversationId: 'rp', body: 'private history' },
    ];
    expect(await f.service.authorizedResearchPortfolioHistory(ctx, hits)).toHaveLength(2);
    f.setGrant(false);
    expect(await f.service.authorizedResearchPortfolioHistory(ctx, hits)).toEqual([hits[0]]);
  });
});
