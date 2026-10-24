import { ObjectiveJobReadSources } from './objective-job-read-sources.js';
import { id } from './objective-job.fixture.js';
const ctx: any = { tenantId: id(9), userId: id(15), clerkUserId: 'user_original', role: 'standard_user', tenantSlug: 'synthetic' };
function fixture() {
  const result = { exact: ['raw-owner-value'] };
  const method = () => jest.fn(async () => result);
  const integrations = { listIntegrations: method() }, tools = { checkClientRef: jest.fn(async () => ({ ok: true, clientId: id(2) })) };
  const portfolios = { detail: method() }, changes = { listChanges: method() }, reviews = { listReviews: method(), getAnnualReview: method() }, analytics = { snapshot: method() };
  const owner = new ObjectiveJobReadSources(integrations as never, tools as never, portfolios as never, changes as never, reviews as never, analytics as never);
  return { result, integrations, tools, portfolios, changes, reviews, analytics, owner };
}
describe('Objective fixed auxiliary source adapters', () => {
  it('preserves actual mailbox and selected-client lookup owner results', async () => {
    const f = fixture(); expect(await f.owner.read(ctx, id(2), 'job.readMailboxes', {})).toBe(f.result);
    expect(f.integrations.listIntegrations).toHaveBeenCalledWith(ctx);
    expect(await f.owner.read(ctx, id(2), 'job.resolveClientReference', { ref: 'Saved client' })).toEqual({ ok: true, clientId: id(2) });
    f.tools.checkClientRef.mockResolvedValue({ ok: true, clientId: id(80) });
    await expect(f.owner.read(ctx, id(2), 'job.resolveClientReference', { ref: 'Other client' })).rejects.toThrow();
  });
  it('calls actual portfolio readers without inventing an interactive conversation', async () => {
    const f = fixture();
    expect(await f.owner.read(ctx, id(2), 'get_research_portfolio', { portfolioId: id(30) })).toBe(f.result);
    expect(f.portfolios.detail).toHaveBeenCalledWith(ctx, id(30));
    expect(await f.owner.read(ctx, id(2), 'get_research_portfolio_changes', { portfolioId: id(30), limit: 50, cursor: id(31) })).toBe(f.result);
    expect(f.changes.listChanges).toHaveBeenCalledWith(ctx, id(30), id(31), 50);
  });
  it.each(['mine', 'team', 'deferred', 'resolved'])('preserves review lane %s', async lane => {
    const f = fixture(); expect(await f.owner.read(ctx, id(2), 'job.readResearchEvidenceSource', { portfolioId: id(30), source: 'reviews', lane })).toBe(f.result);
    expect(f.reviews.listReviews).toHaveBeenCalledWith(ctx, id(30), lane);
  });
  it('preserves snapshot and annual review source DTOs', async () => {
    const f = fixture();
    expect(await f.owner.read(ctx, id(2), 'job.readResearchEvidenceSource', { portfolioId: id(30), source: 'snapshot', recordId: id(31) })).toBe(f.result);
    expect(f.analytics.snapshot).toHaveBeenCalledWith(ctx, id(30), id(31));
    expect(await f.owner.read(ctx, id(2), 'job.readResearchEvidenceSource', { portfolioId: id(30), source: 'annual-review' })).toBe(f.result);
    expect(f.reviews.getAnnualReview).toHaveBeenCalledWith(ctx, id(30));
  });
  it.each([
    ['job.readMailboxes', { route: '/admin' }], ['job.resolveClientReference', { ref: '', clientId: id(2) }],
    ['get_research_portfolio', { portfolioId: id(30), conversationId: id(20) }],
    ['get_research_portfolio_changes', { portfolioId: id(30), limit: 1000, cursor: null }],
    ['job.readResearchEvidenceSource', { portfolioId: id(30), source: 'reviews', lane: 'all' }],
    ['job.readResearchEvidenceSource', { portfolioId: id(30), source: 'snapshot', recordId: '../../private' }],
    ['job.readResearchEvidenceSource', { portfolioId: id(30), source: 'annual-review', recordId: id(31) }],
    ['job.readMode', { operation: { id: 'send_mail', version: '0.2.0' }, requestSha256: 'a'.repeat(64) }],
    ['/arbitrary/route', {}],
  ])('refuses malformed/extra/unknown auxiliary %s %#', async (operation, input) => {
    const f = fixture(); await expect(f.owner.read(ctx, id(2), operation as string, input)).rejects.toThrow();
    for (const port of [f.integrations, f.tools, f.portfolios, f.changes, f.reviews, f.analytics])
      for (const method of Object.values(port)) expect(method).not.toHaveBeenCalled();
  });
  it('retains controller role floor and actual downstream denials', async () => {
    const f = fixture(); await expect(f.owner.read({ ...ctx, role: 'unknown' }, id(2), 'job.readMailboxes', {})).rejects.toThrow();
    f.portfolios.detail.mockRejectedValue(Error('actual portfolio access denied'));
    await expect(f.owner.read(ctx, id(2), 'get_research_portfolio', { portfolioId: id(30) })).rejects.toThrow('actual portfolio access denied');
  });
});
