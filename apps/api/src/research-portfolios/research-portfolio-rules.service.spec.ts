import type { PreviewResearchPortfolioRuleDto, TenantContext } from '@capiro/shared';
import { ResearchPortfolioRulesService } from './research-portfolio-rules.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const portfolioId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const ctx = { tenantId, userId, role: 'standard_user' } as TenantContext;

function previewHarness(members: unknown[]) {
  const tx = {
    researchPortfolioGrant: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ role: 'owner', portfolio: { lifecycle: 'active', revision: 1 } }),
    },
    researchPortfolioMember: { findMany: jest.fn().mockResolvedValue(members) },
    researchPortfolioRulePreview: {
      upsert: jest.fn(async ({ create }: any) => ({
        id: 'preview-1',
        expiresAt: create.expiresAt,
      })),
    },
    programElement: {
      findUnique: jest.fn(async ({ where }: any) => ({
        peCode: where.peCode,
        title: where.peCode,
        service: where.peCode === 'PE-EXCLUDED' || where.peCode === 'PE-OUTAGE' ? 'ARMY' : 'NAVY',
        serviceCode: null,
        appropriationType: 'RDT&E',
        source: 'jbook',
        sourceConfidence: 0.95,
        firstSeenFy: 2026,
        raw: {},
      })),
    },
    capabilityBudgetLineMatch: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenant: string, fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  return { service: new ResearchPortfolioRulesService(prisma as never), tx };
}

const expression = {
  kind: 'condition' as const,
  field: 'component',
  operator: 'eq' as const,
  value: 'ARMY',
};
const input: PreviewResearchPortfolioRuleDto = {
  expectedRevision: 1,
  schemaVersion: 1,
  expression,
  readableExpression: 'Component is Army',
  mode: 'hybrid',
  qualificationPolicy: { autoAdd: true },
  candidates: [],
};

describe('ResearchPortfolioRulesService', () => {
  test('appends immutable, idempotent template versions with predecessor lineage', async () => {
    const publishedAt = new Date('2026-09-26T00:00:00Z');
    const tx = {
      researchPortfolioTemplateVersion: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockResolvedValue({
            id: 'version-2',
            version: 2,
            schemaVersion: 1,
            expression,
            readableExpression: 'Component is Army',
            mode: 'hybrid',
            qualificationPolicy: { autoAdd: false },
            taxonomyVersionId: null,
            publishedAt,
          }),
      },
      researchPortfolioTemplate: {
        findFirst: jest
          .fn()
          .mockResolvedValue({
            id: 'template-1',
            archivedAt: null,
            versions: [{ id: 'version-1', version: 1 }],
          }),
      },
      researchTaxonomyVersion: { findFirst: jest.fn() },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenant: string, fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const service = new ResearchPortfolioRulesService(prisma as never);
    const admin = { ...ctx, role: 'user_admin' } as TenantContext;
    const result = await service.createTemplateVersion(admin, 'template-1', {
      idempotencyKey: 'template-v2',
      schemaVersion: 1,
      expression,
      readableExpression: 'Component is Army',
      mode: 'hybrid',
      qualificationPolicy: { autoAdd: false },
    });
    expect(result).toMatchObject({ id: 'version-2', version: 2 });
    expect(tx.researchPortfolioTemplateVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        version: 2,
        predecessorId: 'version-1',
        operationKey: 'template-v2',
        payloadFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    });
  });

  test('explains manual precedence, accepted nonmatches, withdrawals, and unknowns', async () => {
    const { service } = previewHarness([
      {
        id: 'excluded',
        targetKind: 'program_element',
        targetId: 'PE-EXCLUDED',
        disposition: 'excluded',
        origin: 'manual',
      },
      {
        id: 'accepted',
        targetKind: 'program_element',
        targetId: 'PE-ACCEPTED',
        disposition: 'included',
        origin: 'rule',
      },
      {
        id: 'candidate',
        targetKind: 'program_element',
        targetId: 'PE-CANDIDATE',
        disposition: 'candidate',
        origin: 'rule',
      },
    ]);
    const result = await service.preview(ctx, portfolioId, {
      ...input,
      candidates: [
        { targetKind: 'program_element', targetId: 'PE-EXCLUDED', facts: { component: 'spoofed' } },
        { targetKind: 'program_element', targetId: 'PE-ACCEPTED', facts: { component: 'spoofed' } },
        {
          targetKind: 'program_element',
          targetId: 'PE-CANDIDATE',
          facts: { component: 'spoofed' },
        },
        {
          targetKind: 'program_element',
          targetId: 'PE-OUTAGE',
          facts: {},
          completeness: 'partial',
          unknownReasons: ['source_unavailable'],
        },
      ],
    });
    expect(result.items.map((item) => [item.targetId, item.disposition])).toEqual([
      ['PE-EXCLUDED', 'manual_override'],
      ['PE-ACCEPTED', 'accepted_nonmatch'],
      ['PE-CANDIDATE', 'withdrawn'],
      ['PE-OUTAGE', 'unknown'],
    ]);
    expect(result.complete).toBe(false);
    expect(result.counts).toMatchObject({
      manual_override: 1,
      accepted_nonmatch: 1,
      withdrawn: 1,
      unknown: 1,
    });
  });

  test('records rule-candidate withdrawal without deleting history and suppresses it for incomplete previews', async () => {
    const member = {
      id: 'candidate',
      targetKind: 'program',
      targetId: 'candidate',
      disposition: 'candidate',
      origin: 'rule',
      label: 'Candidate',
      reason: null,
    };
    const tx = {
      researchPortfolioMember: {
        findUnique: jest.fn().mockResolvedValue(member),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
    };
    const service = new ResearchPortfolioRulesService({} as never);
    const item = {
      targetKind: 'program',
      targetId: 'candidate',
      label: 'Candidate',
      result: 'nonmatch',
      disposition: 'withdrawn',
      reasons: ['component is not ARMY'],
    };
    await (service as any).applyBoundedPreview(tx, ctx, portfolioId, 'rule-2', [item], false);
    expect(tx.researchPortfolioMember.update).not.toHaveBeenCalled();
    await (service as any).applyBoundedPreview(tx, ctx, portfolioId, 'rule-2', [item], true);
    expect(tx.researchPortfolioMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ disposition: 'withdrawn', ruleVersionId: 'rule-2' }),
      }),
    );
    expect(tx.researchPortfolioMember.delete).not.toHaveBeenCalled();
  });
});

describe('Research portfolio imported rule draft governance', () => {
  it('reauthorizes explicit publication replay and binds its original actor while preserving committed retry', async () => {
    let preview: any;
    let published: any;
    let event: any = null;
    const tx: any = {
      researchPortfolioGrant: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ role: 'editor', portfolio: { lifecycle: 'active', revision: 1 } }),
      },
      researchPortfolioMember: { findMany: jest.fn().mockResolvedValue([]) },
      researchPortfolioRulePreview: {
        upsert: jest.fn(
          async ({ create }: any) => (preview = { ...create, id: 'publish-preview' }),
        ),
        findFirst: jest.fn(async () => preview),
      },
      researchPortfolioRuleVersion: {
        findFirst: jest.fn(async ({ where }: any) => (where.id ? published : null)),
        create: jest.fn(
          async ({ data }: any) =>
            (published = { ...data, id: 'published-rule-1', publishedAt: new Date() }),
        ),
      },
      researchPortfolioRecomputeJob: {
        create: jest.fn().mockResolvedValue({ id: 'job-publish' }),
        update: jest.fn(async ({ data }: any) => ({ ...data, id: 'job-publish' })),
      },
      researchPortfolio: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      researchPortfolioEvent: {
        findFirst: jest.fn(async () => event),
        create: jest.fn(async ({ data }: any) => (event = data)),
      },
    };
    const service = new ResearchPortfolioRulesService({
      withTenant: async (_tenant: string, action: any) => action(tx),
    } as any);
    const draft = await service.preview(ctx, portfolioId, input);
    const request = {
      idempotencyKey: 'explicit-publish',
      expectedRevision: 1,
      previewId: draft.previewId,
      previewHash: draft.previewHash,
    };
    const first = await service.publish(ctx, portfolioId, request);
    published.jobs = [{ id: 'job-publish', status: 'completed' }];
    tx.researchPortfolioGrant.findUnique.mockResolvedValue({
      role: 'editor',
      portfolio: { lifecycle: 'archived', revision: 50 },
    });
    await expect(service.publish(ctx, portfolioId, request)).resolves.toEqual(first);
    await expect(
      service.publish({ ...ctx, userId: 'other-actor' }, portfolioId, request),
    ).rejects.toThrow('another actor or portfolio');
    tx.researchPortfolioGrant.findUnique.mockResolvedValue(null);
    await expect(service.publish(ctx, portfolioId, request)).rejects.toThrow('not found');
    expect(tx.researchPortfolioRuleVersion.create).toHaveBeenCalledTimes(1);
    expect(tx.researchPortfolio.updateMany).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid versioned AST and viewer authority through the native preview validator', async () => {
    const h = previewHarness([]);
    await expect(
      h.service.previewImportDraftInTransaction(
        h.tx as any,
        ctx,
        portfolioId,
        { readable_expression: 'Invalid rule', expression_json: '{"kind":"unsupported"}' },
        1,
        'import-invalid',
      ),
    ).rejects.toThrow();
    expect(h.tx.researchPortfolioRulePreview.upsert).not.toHaveBeenCalled();
    h.tx.researchPortfolioGrant.findUnique.mockResolvedValue({
      role: 'viewer',
      portfolio: { lifecycle: 'active', revision: 1 },
    } as any);
    await expect(
      h.service.previewImportDraftInTransaction(
        h.tx as any,
        ctx,
        portfolioId,
        { readable_expression: 'Army', expression_json: JSON.stringify(expression) },
        1,
        'import-viewer',
      ),
    ).rejects.toThrow('Editor access');
  });
  it('creates distinct owned drafts for distinct import operations without changing the logical rule', async () => {
    const h = previewHarness([]);
    const row = { readable_expression: 'Army', expression_json: JSON.stringify(expression) };
    const first = await h.service.previewImportDraftInTransaction(
      h.tx as any,
      ctx,
      portfolioId,
      row,
      1,
      'owned-import-1',
    );
    const second = await h.service.previewImportDraftInTransaction(
      h.tx as any,
      ctx,
      portfolioId,
      row,
      1,
      'owned-import-2',
    );
    expect(first.previewHash).not.toBe(second.previewHash);
    const firstCall = h.tx.researchPortfolioRulePreview.upsert.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) throw new Error('Expected an actual governed draft upsert call');
    expect(firstCall[0].create.expression).toEqual(expression);
    expect(firstCall[0].create.manifest.request.qualificationPolicy).toEqual({ autoAdd: false });
  });
});
