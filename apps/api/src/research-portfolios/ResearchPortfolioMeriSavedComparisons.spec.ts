import { ForbiddenException } from '@nestjs/common';
import { ResearchPortfolioMeriToolsService } from './research-portfolio-meri-tools.service.js';
import {
  parseResearchPortfolioManagementInput,
  researchPortfolioManagementSchema,
} from './research-portfolio-management.js';
import { MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY } from './research-portfolio-meri-scope.service.js';

const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
};
const portfolioId = '33333333-3333-4333-8333-333333333333',
  conversationId = '44444444-4444-4444-8444-444444444444',
  comparisonId = '55555555-5555-4555-8555-555555555555',
  versionId = '66666666-6666-4666-8666-666666666666';
const basis = {
  requestEdition: null,
  fundingFiscalYear: null,
  stage: null,
  metric: null,
  unit: null,
  currency: null,
  priceBasis: null,
  asOfDate: null,
  periodStart: '2026-01-01',
  periodEnd: '2026-12-31',
};
const selection = {
  mode: 'explicit',
  subjectKeys: ['program_element:0601101F'],
  passageIds: [versionId],
};
const save = {
  schemaVersion: 'defense_saved_comparison_v1',
  displayVersion: 'defense-compare-display-v1',
  name: 'My retained evidence',
  subjects: [
    { type: 'program_element', id: '0601101F' },
    { type: 'context_document', id: comparisonId },
  ],
  selection,
  basisPair: { left: basis, right: basis },
  passageMode: 'native_sections',
  contextualRevisionPins: [
    {
      documentId: comparisonId,
      revisionId: versionId,
      sectionIds: [conversationId],
    },
  ],
  idempotencyKey: 'unchanged-original-request',
};
const lifecycle = {
  comparisonId,
  expectedRevision: 7,
  idempotencyKey: 'unchanged-original-request',
};
const cases = [
  {
    action: 'comparison_list',
    parameters: { includeArchived: true },
    method: 'list',
    args: [ctx, true, { portfolioId }],
    readOnly: true,
  },
  {
    action: 'comparison_get',
    parameters: { comparisonId, versionId },
    method: 'get',
    args: [ctx, comparisonId, versionId, { portfolioId }],
    readOnly: true,
  },
  {
    action: 'comparison_create',
    parameters: save,
    method: 'save',
    args: [ctx, { ...save, portfolioId }, undefined, { portfolioId }],
    readOnly: false,
  },
  {
    action: 'comparison_revise',
    parameters: { ...save, comparisonId, expectedRevision: 7 },
    method: 'save',
    args: [ctx, { ...save, portfolioId, expectedRevision: 7 }, comparisonId, { portfolioId }],
    readOnly: false,
  },
  {
    action: 'comparison_archive',
    parameters: lifecycle,
    method: 'changeLifecycle',
    args: [
      ctx,
      comparisonId,
      { expectedRevision: 7, idempotencyKey: lifecycle.idempotencyKey },
      true,
      { portfolioId },
    ],
    readOnly: false,
  },
  {
    action: 'comparison_restore',
    parameters: lifecycle,
    method: 'changeLifecycle',
    args: [
      ctx,
      comparisonId,
      { expectedRevision: 7, idempotencyKey: lifecycle.idempotencyKey },
      false,
      { portfolioId },
    ],
    readOnly: false,
  },
  {
    action: 'comparison_add_selection',
    parameters: {
      ...lifecycle,
      versionId,
      expectedPortfolioRevision: 9,
      selection,
    },
    method: 'addSelectionToPortfolio',
    args: [
      ctx,
      comparisonId,
      versionId,
      {
        expectedRevision: 7,
        idempotencyKey: lifecycle.idempotencyKey,
        portfolioId,
        expectedPortfolioRevision: 9,
        selection,
      },
      { portfolioId },
    ],
    readOnly: false,
  },
];
function harness(enabled = true) {
  const comparison = {
    id: comparisonId,
    ownerUserId: ctx.userId,
    portfolioId,
    revision: 8,
    currentVersion: { id: versionId },
  };
  const receipt = {
    comparison,
    eventId: 'actual-event',
    resultingRevision: 8,
    portfolioId,
    portfolioRevision: 10,
    outcomes: [
      {
        kind: 'member',
        targetId: 'program_element:0601101F',
        id: 'actual-member',
        status: 'created',
      },
      { kind: 'bookmark', targetId: versionId, id: 'actual-bookmark', status: 'unchanged' },
    ],

    replayed: false,
  };
  const saved = {
    list: jest.fn(async () => [comparison]),
    get: jest.fn(async () => comparison),
    save: jest.fn(async () => receipt),
    changeLifecycle: jest.fn(async () => receipt),
    addSelectionToPortfolio: jest.fn(async () => receipt),
  };
  const stored = {
    kind: 'research_portfolio',
    researchPortfolioId: portfolioId,
    researchPortfolioName: 'Original',
    researchPortfolioRevision: 7,
    scopeVersion: 'a'.repeat(64),
  };
  const scope = { authorize: jest.fn(async () => stored) };
  const tx = {
    clioConversation: {
      findFirst: jest.fn(async () => ({
        metadata: { [MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY]: stored },
      })),
    },
  };
  const adapter = new ResearchPortfolioMeriToolsService(
    {
      withTenant: async (_tenant: string, work: (tx: unknown) => unknown) => work(tx),
    } as any,
    scope as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    undefined,
    undefined,
    enabled ? (saved as any) : undefined,
  );
  return { adapter, saved, scope, tx, comparison, receipt };
}
function input(action: string, parameters: object, confirmed = true) {
  return {
    conversationId,
    action,
    parameters,
    ...(confirmed ? { confirmed: true } : {}),
  };
}

describe('Meri saved comparisons stay inside current server Research Portfolio', () => {
  it.each(cases)(
    'delegates $action with immutable native scope and actual receipts',
    async (item) => {
      const h = harness();
      const result = await h.adapter.execute(
        ctx as any,
        'manage_research_portfolio',
        input(item.action, item.parameters, !item.readOnly),
      );
      const method = h.saved[item.method as keyof typeof h.saved];
      expect(method).toHaveBeenCalledTimes(1);
      expect(method).toHaveBeenCalledWith(...item.args);
      const last = method.mock.calls[0] as unknown as unknown[];
      expect(Object.isFrozen(last[last.length - 1])).toBe(true);
      expect(h.scope.authorize).toHaveBeenCalledTimes(1);
      expect(result).toEqual(
        item.method === 'list' ? [h.comparison] : item.method === 'get' ? h.comparison : h.receipt,
      );
    },
  );
  it('lists only current owned attachment even if native port returns additional private rows', async () => {
    const h = harness();
    h.saved.list.mockResolvedValue([
      h.comparison,
      { ...h.comparison, id: versionId, portfolioId: versionId },
      { ...h.comparison, portfolioId: null } as any,
      { ...h.comparison, ownerUserId: versionId },
    ]);
    await expect(
      h.adapter.execute(ctx as any, 'manage_research_portfolio', input('comparison_list', {})),
    ).resolves.toEqual([h.comparison]);
  });
  it.each([null, versionId])('never exposes get with attachment %s', async (attachment) => {
    const h = harness();
    h.saved.get.mockResolvedValue({
      ...h.comparison,
      portfolioId: attachment,
    } as any);
    await expect(
      h.adapter.execute(
        ctx as any,
        'manage_research_portfolio',
        input('comparison_get', { comparisonId }),
      ),
    ).rejects.toThrow('unavailable in this Research Portfolio');
  });
  it.each(cases.filter((item) => !item.readOnly))(
    'requires explicit confirmation for $action',
    async (item) => {
      const h = harness();
      await expect(
        h.adapter.execute(
          ctx as any,
          'manage_research_portfolio',
          input(item.action, item.parameters, false),
        ),
      ).rejects.toThrow();
      expect(h.saved[item.method as keyof typeof h.saved]).not.toHaveBeenCalled();
    },
  );
  it.each([
    'portfolioId',
    'tenantId',
    'userId',
    'researchPortfolioId',
    'scopeVersion',
    'knownAt',
    'capturedProjection',
    'sourcePins',
    'contentHash',
  ])('rejects caller %s rather than delegating capture or authority', async (forbidden) => {
    const h = harness();
    await expect(
      h.adapter.execute(
        ctx as any,
        'manage_research_portfolio',
        input('comparison_create', {
          ...save,
          [forbidden]: 'model-supplied',
        }),
      ),
    ).rejects.toThrow();
    expect(h.saved.save).not.toHaveBeenCalled();
  });
  it('validates all nullable basis fields, bounded fiscal year, explicit selection, and retained revision', () => {
    expect(() =>
      parseResearchPortfolioManagementInput(input('comparison_create', save)),
    ).not.toThrow();
    const invalid = [
      {
        ...save,
        basisPair: {
          left: { ...basis, fundingFiscalYear: 2201 },
          right: basis,
        },
      },
      {
        ...save,
        basisPair: {
          left: { ...basis, fundingFiscalYear: 1899 },
          right: basis,
        },
      },
      {
        ...save,
        basisPair: { left: { fundingFiscalYear: null }, right: basis },
      },
      { ...save, selection: { ...selection, mode: 'all' } },
      { ...save, idempotencyKey: '' },
    ];
    for (const parameters of invalid)
      expect(() =>
        parseResearchPortfolioManagementInput(input('comparison_create', parameters)),
      ).toThrow();
    expect(() =>
      parseResearchPortfolioManagementInput(
        input('comparison_revise', {
          ...save,
          comparisonId,
          expectedRevision: 0,
        }),
      ),
    ).toThrow();
  });
  it('reauthorizes original receipt and does not write after current grant revocation', async () => {
    const h = harness();
    h.scope.authorize.mockRejectedValueOnce(new ForbiddenException('Current grant revoked'));
    await expect(
      h.adapter.execute(ctx as any, 'manage_research_portfolio', input('comparison_create', save)),
    ).rejects.toThrow('Current grant revoked');
    expect(h.saved.save).not.toHaveBeenCalled();
  });
  it('returns native under-lock policy rejection instead of fabricated success', async () => {
    const h = harness();
    h.saved.changeLifecycle.mockRejectedValueOnce(
      new ForbiddenException('Current attachment revoked under lock'),
    );
    await expect(
      h.adapter.execute(
        ctx as any,
        'manage_research_portfolio',
        input('comparison_archive', lifecycle),
      ),
    ).rejects.toThrow('Current attachment revoked under lock');
    expect(h.saved.get).not.toHaveBeenCalled();
  });
  it('keeps exact original key and native payload across uncertain retry', async () => {
    const h = harness();
    h.saved.save.mockRejectedValueOnce(new Error('Transport outcome unknown'));
    const request = input('comparison_create', save);
    await expect(
      h.adapter.execute(ctx as any, 'manage_research_portfolio', request),
    ).rejects.toThrow('Transport outcome unknown');
    await expect(
      h.adapter.execute(ctx as any, 'manage_research_portfolio', request),
    ).resolves.toEqual(h.receipt);
    expect(h.saved.save.mock.calls[0]).toEqual(h.saved.save.mock.calls[1]);
    expect(h.scope.authorize).toHaveBeenCalledTimes(2);
  });
  it('fails closed when the optional native service is not installed', async () => {
    await expect(
      harness(false).adapter.execute(
        ctx as any,
        'manage_research_portfolio',
        input('comparison_list', {}),
      ),
    ).rejects.toThrow('saved comparisons are unavailable');
  });
  it('publishes all seven strict branches without replacing the 42 existing actions', () => {
    const schema = researchPortfolioManagementSchema as any;
    expect(schema.oneOf).toHaveLength(49);
    for (const item of cases) {
      const branch = schema.oneOf.find(
        (entry: any) => entry.properties.action.enum[0] === item.action,
      );
      expect(branch).toBeDefined();
      expect(branch.properties.parameters.additionalProperties).toBe(false);
      expect(branch.properties.parameters.properties).not.toHaveProperty('portfolioId');
      if (!item.readOnly) expect(branch.required).toContain('confirmed');
    }
  });
});
