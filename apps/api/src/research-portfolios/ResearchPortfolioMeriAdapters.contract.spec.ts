import { MeriToolsService } from '../meri/meri-tools.service.js';
import { ResearchPortfolioMeriToolsService } from './research-portfolio-meri-tools.service.js';
import { MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY } from './research-portfolio-meri-scope.service.js';
const ctx: any = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
};
const portfolioId = '33333333-3333-4333-8333-333333333333',
  conversationId = '44444444-4444-4444-8444-444444444444';
function harness() {
  const scopeReceipt = {
    kind: 'research_portfolio',
    researchPortfolioId: portfolioId,
    researchPortfolioName: 'Owned',
    researchPortfolioRevision: 7,
    scopeVersion: 'a'.repeat(64),
  };
  const imports = {
    getJob: jest.fn(async (_ctx: unknown, _portfolio: string, id: string) => ({
      id,
      rows: [
        { id: 'row-a', status: 'applied' },
        { id: 'row-b', status: 'failed' },
      ],
      compensationReceipts: [{ rowId: 'row-a', outcome: 'restored' }],
    })),
  };
  const phase11 = {
    createBookmark: jest.fn(async () => ({})),
    addReviewNote: jest.fn(async () => ({})),
    getOperation: jest.fn(async () => ({})),
  };
  const tx = {
    clioConversation: {
      findFirst: jest.fn(async () => ({
        metadata: { [MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY]: scopeReceipt },
      })),
    },
    researchPortfolioImportJob: {
      findMany: jest.fn(async () => [{ id: 'job-a' }, { id: 'job-b' }]),
      findFirst: jest.fn(async () => ({ id: 'raw-job', status: 'mapped' })),
    },
  };
  const scope = { authorize: jest.fn(async () => scopeReceipt) };
  const service = new ResearchPortfolioMeriToolsService(
    { withTenant: async (_tenant: string, work: any) => work(tx) } as any,
    scope as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    phase11 as any,
    imports as any,
  );
  const schemas = Object.create(MeriToolsService.prototype).anthropicToolSchemas({
    tenantId: ctx.tenantId,
    surface: 'chat',
    env: { RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED: 'true' },
  });
  return {
    imports,
    phase11,
    tx,
    scope,
    service,
    schema: (name: string) => schemas.find((item: any) => item.name === name)!.input_schema as any,
  };
}
describe('Research Portfolio advertised adapter contracts', () => {
  it('advertises every required write identity and revision for bookmark, review note and operation lookup', async () => {
    const h = harness(),
      values: Record<string, unknown> = {
        conversationId,
        operationKey: 'owned-key',
        expectedRevision: 7,
        targetKind: 'member',
        targetId: 'member-a',
        reviewId: 'review-a',
        body: 'Owned note',
        operationId: 'operation-a',
      };
    for (const name of [
      'create_research_portfolio_bookmark',
      'add_research_portfolio_review_note',
      'get_research_portfolio_operations',
    ] as const) {
      const input = Object.fromEntries(
        h.schema(name).required.map((field: string) => [field, values[field]]),
      );
      await expect(h.service.execute(ctx, name, input)).resolves.toEqual({});
    }
    expect(h.phase11.createBookmark).toHaveBeenCalledWith(
      ctx,
      portfolioId,
      expect.objectContaining({ idempotencyKey: 'owned-key' }),
    );
    expect(h.phase11.addReviewNote).toHaveBeenCalledWith(
      ctx,
      portfolioId,
      'review-a',
      expect.objectContaining({ idempotencyKey: 'owned-key', expectedRevision: 7 }),
    );
    expect(h.phase11.getOperation).toHaveBeenCalledWith(ctx, portfolioId, 'operation-a');
  });
  it('advertises supported bookmark kinds, lane and exact import handle without unsupported note threading', () => {
    const h = harness();
    expect(h.schema('create_research_portfolio_bookmark').properties.targetKind.enum).toEqual([
      'member',
      'snapshot',
      'evidence',
      'review',
      'import',
      'output',
      'other',
    ]);
    expect(h.schema('get_research_portfolio_reviews').properties.lane.enum).toEqual([
      'mine',
      'team',
      'deferred',
      'resolved',
    ]);
    expect(h.schema('get_research_portfolio_imports').properties.jobId.type).toBe('string');
    expect(h.schema('add_research_portfolio_review_note').properties.parentNoteId).toBeUndefined();
  });
  it('returns the ordinary domain all-row detail and compensation receipt for a known handle', async () => {
    const h = harness();
    await expect(
      h.service.execute(ctx, 'get_research_portfolio_imports', { conversationId, jobId: 'job-a' }),
    ).resolves.toEqual({
      id: 'job-a',
      rows: [
        { id: 'row-a', status: 'applied' },
        { id: 'row-b', status: 'failed' },
      ],
      compensationReceipts: [{ rowId: 'row-a', outcome: 'restored' }],
    });
    expect(h.imports.getJob).toHaveBeenCalledWith(ctx, portfolioId, 'job-a');
    expect(h.tx.researchPortfolioImportJob.findFirst).not.toHaveBeenCalled();
  });
  it('bounds history to twenty authorized handles and resolves each through the same current-authority reader', async () => {
    const h = harness();
    const rows = (await h.service.execute(ctx, 'get_research_portfolio_imports', {
      conversationId,
    })) as any[];
    expect(rows.map((row) => row.id)).toEqual(['job-a', 'job-b']);
    expect(
      rows.every((row) => row.rows.length === 2 && row.compensationReceipts.length === 1),
    ).toBe(true);
    expect(h.tx.researchPortfolioImportJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: ctx.tenantId, portfolioId },
        select: { id: true },
        take: 20,
      }),
    );
  });
  it('rejects revoked scope or caller authority injection before any import detail read', async () => {
    const h = harness();
    await expect(
      h.service.execute(ctx, 'get_research_portfolio_imports', { conversationId, portfolioId }),
    ).rejects.toThrow('controlled by the server');
    h.scope.authorize.mockRejectedValueOnce(Error('scope revoked'));
    await expect(
      h.service.execute(ctx, 'get_research_portfolio_imports', { conversationId, jobId: 'job-a' }),
    ).rejects.toThrow('scope revoked');
    expect(h.imports.getJob).not.toHaveBeenCalled();
  });
});
