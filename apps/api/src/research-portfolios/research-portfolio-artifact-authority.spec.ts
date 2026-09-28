import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { MeriService } from '../meri/meri.service.js';
import { authorizeResearchPortfolioArtifact } from './research-portfolio-artifact-authority.js';
const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
} as TenantContext;
function fixture() {
  let member = true,
    grant = true,
    conversationOwner = ctx.userId,
    refreshedScope: any = null;
  const bounded = {
    kind: 'research_portfolio',
    researchPortfolioId: '33333333-3333-4333-8333-333333333333',
    researchPortfolioName: 'Owned',
    researchPortfolioRevision: 1,
  };
  const scope = {
    ...bounded,
    scopeVersion: createHash('sha256').update(JSON.stringify(bounded)).digest('hex'),
  };
  const parent: any = {
    id: '44444444-4444-4444-8444-444444444444',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    clientId: null,
    conversationId: '55555555-5555-4555-8555-555555555555',
    kind: 'research_portfolio_brief',
    title: 'Private draft',
    contentType: 'text/markdown',
    bodyText: 'Original captured content',
    metadata: {
      schemaVersion: 'research_portfolio_institutional_v1',
      researchPortfolioScope: scope,
      sourceLineage: {
        sourceRevisionIds: ['exact-old-source'],
        calculationVersion: 'research-portfolio-analytics-v2',
      },
      requestFingerprint: 'a'.repeat(64),
      reviewStatus: 'unreviewed_draft',
    },
  };
  const children: any[] = [];
  const tx: any = {
    $executeRaw: async () => 1,
    tenantMembership: { findFirst: async () => (member ? { id: 'membership' } : null) },
    researchPortfolio: {
      findFirst: async () =>
        grant
          ? {
              id: scope.researchPortfolioId,
              lifecycle: 'archived',
              grants: [{ role: 'viewer' }],
              clientLinks: [],
            }
          : null,
    },
    clioConversation: {
      findFirst: async ({ where }: any) =>
        where.userId === conversationOwner
          ? {
              id: parent.conversationId,
              tenantId: ctx.tenantId,
              userId: ctx.userId,
              clientId: null,
              metadata: { researchPortfolioScope: refreshedScope ?? scope },
            }
          : null,
    },
    clioArtifact: {
      findFirst: async ({ where }: any) =>
        where.id === parent.id &&
        where.tenantId === parent.tenantId &&
        (!where.userId || where.userId === parent.userId)
          ? parent
          : null,
      create: async ({ data }: any) => {
        const row = { ...data, id: 'actual-created-child' };
        children.push(row);
        return row;
      },
    },
  };
  const call = (actor = ctx) =>
    MeriService.prototype.createArtifactVersion.call(
      { prisma: { withTenant: async (_tenant: any, fn: any) => fn(tx) } } as any,
      actor,
      parent.id,
      'Edited working text',
    );
  return {
    ctx,
    parent,
    tx,
    children,
    call,
    setScope: (value: any) => (refreshedScope = value),
    setMember: (v: boolean) => (member = v),
    setGrant: (v: boolean) => (grant = v),
    setConversationOwner: (v: string) => (conversationOwner = v),
  };
}
describe('narrow RP-kind generic artifact corrections', () => {
  test('private edit creates actual child, preserves immutable lineage, and remains unreviewed', async () => {
    const f = fixture();
    const child: any = await f.call();
    expect(child.id).toBe('actual-created-child');
    expect(child.parentArtifactId).toBe(f.parent.id);
    expect(child.metadata.sourceLineage).toEqual(f.parent.metadata.sourceLineage);
    expect(child.metadata.researchPortfolioScope).toEqual(f.parent.metadata.researchPortfolioScope);
    expect(child.metadata.reviewStatus).toBe('unreviewed_edit');
    expect(child.bodyText).toBe('Edited working text');
    expect(f.parent.bodyText).toBe('Original captured content');
  });
  test('current original owner, tenant, active membership, conversation and RP grant are required', async () => {
    const f = fixture();
    await expect(
      f.call({ ...ctx, userId: '66666666-6666-4666-8666-666666666666' }),
    ).rejects.toThrow('not found');
    await expect(
      f.call({ ...ctx, tenantId: '77777777-7777-4777-8777-777777777777' }),
    ).rejects.toThrow('not found');
    f.setMember(false);
    await expect(f.call()).rejects.toThrow('Active tenant');
    f.setMember(true);
    f.setGrant(false);
    await expect(f.call()).rejects.toThrow('portfolio');
    f.setGrant(true);
    f.setConversationOwner('other');
    await expect(f.call()).rejects.toThrow('conversation');
    expect(f.children).toEqual([]);
  });
  test('invalid scope/provenance and unintended private client association fail closed', async () => {
    const f = fixture();
    f.parent.metadata.researchPortfolioScope.scopeVersion = 'b'.repeat(64);
    await expect(authorizeResearchPortfolioArtifact(f.tx, ctx, f.parent)).rejects.toThrow(
      'receipt is invalid',
    );
    f.parent.clientId = '88888888-8888-4888-8888-888888888888';
    await expect(f.call()).rejects.toThrow('not found');
    expect(f.children).toEqual([]);
  });
  test('same RP receipt refresh permits old captured draft edits; different RP or invalid new receipt denies', async () => {
    const f = fixture();
    const newer = { ...f.parent.metadata.researchPortfolioScope, researchPortfolioRevision: 2 };
    newer.scopeVersion = createHash('sha256')
      .update(
        JSON.stringify({
          kind: newer.kind,
          researchPortfolioId: newer.researchPortfolioId,
          researchPortfolioName: newer.researchPortfolioName,
          researchPortfolioRevision: newer.researchPortfolioRevision,
        }),
      )
      .digest('hex');
    f.setScope(newer);
    const child: any = await f.call();
    expect(child.metadata.researchPortfolioScope.researchPortfolioRevision).toBe(1);
    newer.scopeVersion = 'f'.repeat(64);
    await expect(f.call()).rejects.toThrow('receipt is invalid');
    const other = { ...newer, researchPortfolioId: '99999999-9999-4999-8999-999999999999' };
    other.scopeVersion = createHash('sha256')
      .update(
        JSON.stringify({
          kind: other.kind,
          researchPortfolioId: other.researchPortfolioId,
          researchPortfolioName: other.researchPortfolioName,
          researchPortfolioRevision: other.researchPortfolioRevision,
        }),
      )
      .digest('hex');
    f.setScope(other);
    await expect(f.call()).rejects.toThrow('conversation');
  });
  test('generic non-RP artifact correction behavior remains unchanged', async () => {
    const f = fixture();
    f.parent.kind = 'document';
    f.setMember(false);
    f.setGrant(false);
    const child = await f.call();
    expect(child.metadata).toEqual({ versionOf: f.parent.id, editedBy: ctx.userId });
    expect(child.kind).toBe('document');
    expect(child.clientId).toBeNull();
    expect(f.children).toHaveLength(1);
  });
});
