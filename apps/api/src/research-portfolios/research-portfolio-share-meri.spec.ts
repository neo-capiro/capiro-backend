import { ResearchPortfolioMeriToolsService } from './research-portfolio-meri-tools.service.js';
import { MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY } from './research-portfolio-meri-scope.service.js';

const conversationId = '44444444-4444-4444-8444-444444444444';
const ctx: any = { tenantId: 'tenant', userId: 'actor' };
function harness(selectedClientId: string | null = 'one') {
  const receipt = {
    kind: 'research_portfolio',
    researchPortfolioId: 'portfolio',
    researchPortfolioName: 'Research',
    researchPortfolioRevision: 1,
    scopeVersion: 'a'.repeat(64),
  };
  const conversation = {
    clientId: selectedClientId,
    metadata: { [MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY]: receipt },
  };
  const share = {
    getSettings: jest.fn().mockResolvedValue({ enabled: true, activeLinkCount: 99 }),
    listLinks: jest.fn().mockResolvedValue([
      { id: 'a', clientId: 'one', status: 'active' },
      { id: 'b', clientId: 'two', status: 'active' },
      { id: 'c', clientId: 'one', status: 'revoked' },
    ]),
    publishLink: jest
      .fn()
      .mockResolvedValue({ link: { id: 'a' }, token: 'a'.repeat(64), replayed: false }),
  };
  const service = new ResearchPortfolioMeriToolsService(
    {
      withTenant: async (_tenant: string, fn: any) =>
        fn({ clioConversation: { findFirst: async () => conversation } }),
    } as any,
    { authorize: async () => receipt } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    undefined,
    undefined,
    undefined,
    share as any,
  );
  return { service, share, conversation };
}

it('returns only the selected client and a matching active count', async () => {
  const h = harness();
  expect(
    await h.service.execute(ctx, 'get_research_portfolio_share_links', { conversationId }),
  ).toEqual({
    sharing: { enabled: true, activeLinkCount: 1 },
    links: [
      { id: 'a', clientId: 'one', status: 'active' },
      { id: 'c', clientId: 'one', status: 'revoked' },
    ],
  });
});

it('uses the wall-filtered returned rows for the General count and rechecks selection after reads', async () => {
  const h = harness(null);
  expect(
    await h.service.execute(ctx, 'get_research_portfolio_share_links', { conversationId }),
  ).toMatchObject({ sharing: { activeLinkCount: 2 } });
  h.share.listLinks.mockImplementationOnce(async () => {
    h.conversation.clientId = 'two';
    return [];
  });
  await expect(
    h.service.execute(ctx, 'get_research_portfolio_share_links', { conversationId }),
  ).rejects.toThrow('scope changed');
});

it('passes the exact reviewed publication binding and returns the canonical one-time address', async () => {
  const h = harness();
  const input = {
    conversationId,
    operationKey: 'op',
    snapshotId: 'snapshot',
    designId: 'design',
    clientId: 'one',
    branding: true,
    expectedDesignVersion: 4,
    previewHash: 'b'.repeat(64),
  };
  const result = await h.service.execute(ctx, 'publish_research_portfolio_share_link', input);
  expect(h.share.publishLink).toHaveBeenCalledWith(ctx, 'portfolio', {
    operationKey: 'op',
    snapshotId: 'snapshot',
    designId: 'design',
    clientId: 'one',
    branding: true,
    expectedDesignVersion: 4,
    previewHash: 'b'.repeat(64),
  });
  expect(result).toMatchObject({ sharePath: `/share/${'a'.repeat(64)}`, shownOnce: true });
});
