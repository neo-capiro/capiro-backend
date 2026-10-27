import { ResearchPortfolioSharePayloadService } from './research-portfolio-share-payload.service.js';

const ctx: any = { tenantId: 'tenant', userId: 'owner' };
const input = { snapshotId: 'snapshot', designId: 'design', clientId: 'one', branding: false };
const source = {
  evidenceRefId: 'context-search-revision:source',
  sourceDocumentId: 'document',
  sourceRevisionId: 'source',
  sourceFamily: 'budget',
  publisher: 'Department',
  sourceUrl: 'https://example.test/source',
  nativeLocator: { page: 3, section: 'Funding', occurrenceId: null },
  contentHash: 'hash',
  edition: 'FY2027',
  observedAt: '2026-10-01T00:00:00.000Z',
};
function fixture() {
  const basis = {
    fundingFiscalYear: 2027,
    stage: 'request',
    metric: 'budget_authority',
    unit: 'usd_millions',
    currency: 'USD',
  };
  const snapshot: any = {
    id: 'snapshot',
    name: 'Frozen research',
    portfolioRevision: 4,
    calculationVersion: 'v2',
    capturedAt: '2026-10-01T00:00:00.000Z',
    versions: {
      structure: { portfolioName: 'Captured name', portfolioPurpose: 'Captured purpose' },
      sources: [{ id: 'source' }],
    },
    projection: {
      totals: [{ basis, value: '12.01', contributionCount: 1 }],
      contributions: [
        {
          contributionId: 'funding',
          memberId: 'member',
          targetKind: 'program_element',
          targetId: 'PE1',
          label: 'Program',
          basis,
          value: '12.01',
          disposition: 'included',
          sourceDisposition: 'observed',
          reason: 'Qualified',
          sourceObservationId: 'observation',
          privateNote: 'must not escape',
          sourceRevisionIds: ['source'],
          evidence: [{ ...source, privateNote: 'must not escape' }],
          dedupKey: 'funding',
          overlapsContributionId: null,
        },
      ],
      coverage: {
        eligibleMembers: 1,
        supportedMembers: 1,
        includedContributions: 1,
        excludedContributions: 0,
        overlapContributions: 0,
        unavailableMembers: 0,
      },
    },
    limitations: [],
    membership: [
      {
        id: 'member',
        targetKind: 'program_element',
        targetId: 'PE1',
        label: 'Program',
        disposition: 'included',
      },
      {
        id: 'hidden',
        targetKind: 'program_element',
        targetId: 'PE2',
        label: 'Excluded',
        disposition: 'excluded',
      },
    ],
  };
  const design: any = {
    id: 'design',
    version: 2,
    layout: {
      columns: 12,
      widgets: [
        { id: 'totals', kind: 'key_totals', x: 0, y: 0, w: 6, h: 2, settings: {} },
        { id: 'fit', kind: 'client_fit', x: 6, y: 0, w: 6, h: 2, settings: {} },
        { id: 'subjects', kind: 'subjects', x: 0, y: 2, w: 6, h: 2, settings: {} },
        { id: 'changes', kind: 'changes', x: 6, y: 2, w: 6, h: 2, settings: {} },
      ],
      phoneOrder: ['totals', 'fit', 'subjects', 'changes'],
    },
  };
  const tx: any = {
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
    researchPortfolio: {
      findFirst: jest.fn().mockResolvedValue({
        name: 'Current changed name',
        grants: [{ role: 'owner' }],
        clientLinks: [{ clientId: 'one' }, { clientId: 'two' }],
      }),
    },
    researchPortfolioDashboardDesign: { findFirst: jest.fn(async () => design) },
    client: {
      findFirst: jest.fn(async ({ where }: any) => ({
        name: where.id === 'one' ? 'Client One' : 'Client Two',
      })),
    },
    tenantMembership: {
      findFirst: jest.fn().mockResolvedValue({ role: 'capiro_admin', status: 'active' }),
    },
    tenant: {
      findUnique: jest.fn().mockResolvedValue({
        name: 'Firm',
        logoS3Key: 'logo',
        logoContentType: 'image/png',
        settings: {},
      }),
    },
    clientMemoryPolicy: { findUnique: jest.fn().mockResolvedValue(null) },
    clientMemoryGrant: { findFirst: jest.fn().mockResolvedValue(null) },
    researchPortfolioFitVersion: {
      findFirst: jest.fn(async ({ where }: any) => ({
        id: `fit-${where.clientId}`,
        createdAt: new Date('2026-09-30T00:00:00.000Z'),
        projection: {
          availability: 'available',
          fitScore: where.clientId === 'one' ? 20 : 80,
          basis: { calculationVersion: 'fit-v1', privateNote: 'must not escape' },
          clientName: 'DO NOT COPY',
          privateNotes: 'hidden',
        },
      })),
    },
    researchPortfolioEvent: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'event',
          eventKind: 'member_added',
          occurredAt: new Date('2026-09-30T00:00:00.000Z'),
          payload: { clientName: 'Do not expose' },
        },
      ]),
    },
  };
  const analytics: any = {
    snapshot: jest.fn(async () => snapshot),
    listSnapshots: jest.fn().mockResolvedValue([]),
  };
  const evidence: any = { resolveEvidence: jest.fn(async () => ({ ...source })) };
  const branding: any = {
    freezeLogoForSharing: jest.fn().mockResolvedValue({ dataUrl: 'data:image/png;base64,YQ==' }),
  };
  const service = new ResearchPortfolioSharePayloadService(analytics, evidence, branding);
  return { service, tx, snapshot, design, evidence, branding, analytics };
}

describe('exact research sharing payload', () => {
  it('does not admit a selector from an excluded contribution that is absent from the recipient ledger', async () => {
    const h = fixture();
    h.snapshot.projection.contributions.push({
      ...h.snapshot.projection.contributions[0],
      contributionId: 'excluded',
      disposition: 'excluded',
      basis: { ...h.snapshot.projection.contributions[0].basis, fundingFiscalYear: 2035 },
    });
    h.design.layout.widgets[0].settings = { fundingFiscalYear: 2035 };
    await expect(h.service.prepare(ctx, 'portfolio', input, h.tx)).rejects.toThrow(
      'Widget totals cannot be published: the selected fiscal year is not in this frozen data',
    );
  });

  it('admits both frozen sides when comparison is the only financial widget', async () => {
    const h = fixture();
    const earlier = structuredClone(h.snapshot);
    earlier.id = 'earlier';
    earlier.capturedAt = '2026-09-01T00:00:00.000Z';
    earlier.projection.totals[0].value = '4.01';
    earlier.projection.contributions[0].value = '4.01';
    h.analytics.snapshot.mockImplementation(
      async (_ctx: unknown, _portfolio: string, id: string) =>
        id === 'earlier' ? earlier : h.snapshot,
    );
    h.analytics.listSnapshots.mockResolvedValue([earlier]);
    h.design.layout.widgets = [
      {
        id: 'compare',
        kind: 'snapshot_comparison',
        x: 0,
        y: 0,
        w: 12,
        h: 2,
        settings: { snapshotId: 'earlier', fundingFiscalYear: 2027 },
      },
    ];
    const { payload } = await h.service.prepare(ctx, 'portfolio', input, h.tx);
    expect(payload.dashboard.data.totals[0]?.value).toBe('12.01');
    expect(payload.dashboard.data.comparison?.totals[0]?.value).toBe('4.01');
    expect(h.evidence.resolveEvidence).toHaveBeenCalledTimes(2);
    h.evidence.resolveEvidence.mockRejectedValueOnce(new Error('current source denied'));
    await expect(h.service.prepare(ctx, 'portfolio', input, h.tx)).rejects.toThrow(
      'Widget compare cannot be published: a frozen source is restricted or no longer accessible',
    );
  });

  it('retains frozen financial and subject selectors without altering the admitted ledger', async () => {
    const h = fixture();
    const basisKey = JSON.stringify([
      2027,
      'request',
      'budget_authority',
      'usd_millions',
      'USD',
      null,
      null,
      null,
    ]);
    h.design.layout.widgets[0] = {
      id: 'funding',
      kind: 'funding_table',
      x: 0,
      y: 0,
      w: 6,
      h: 2,
      settings: { fundingFiscalYear: 2027, basisKey, subjectIds: ['member'], showSources: false },
    };
    const first = await h.service.prepare(ctx, 'portfolio', input, h.tx);
    expect(first.payload.dashboard.layout.widgets[0]?.settings).toEqual({
      fundingFiscalYear: 2027,
      basisKey,
      subjectIds: ['member'],
      showSources: false,
    });
    expect(first.payload.dashboard.data.contributions[0]?.value).toBe('12.01');
    expect(first.payload.dashboard.data.sources).toHaveLength(1);
    expect(first.payload.dashboard.data.totals).toEqual(h.snapshot.projection.totals);
    h.design.layout.widgets[0].settings.subjectIds = [];
    const empty = await h.service.prepare(ctx, 'portfolio', input, h.tx);
    expect(empty.payload.dashboard.layout.widgets[0]?.settings.subjectIds).toEqual([]);
    expect(empty.payload.dashboard.data.contributions).toEqual(
      first.payload.dashboard.data.contributions,
    );
    expect(empty.previewHash).not.toBe(first.previewHash);
    delete h.design.layout.widgets[0].settings.subjectIds;
    expect(
      (await h.service.prepare(ctx, 'portfolio', input, h.tx)).payload.dashboard.layout.widgets[0]
        ?.settings,
    ).not.toHaveProperty('subjectIds');
  });

  it.each([
    ['funding_table', { fundingFiscalYear: 2035 }],
    ['funding_table', { fundingFiscalYear: '2027' }],
    ['funding_table', { basisKey: 'arbitrary' }],
    ['funding_table', { subjectIds: ['hidden'] }],
    ['subjects', { subjectIds: ['foreign'] }],
    ['subjects', { subjectIds: 'member' }],
    ['subjects', { subjectIds: ['member', 'member'] }],
    ['key_totals', { subjectIds: ['member'] }],
    ['snapshot_comparison', { subjectIds: [] }],
    ['funding_table', { showSources: 'false' }],
    ['subjects', { showSources: false }],
    ['subjects', { fundingFiscalYear: 2027 }],
  ])(
    'refuses unsupported or foreign selectors on %s instead of silently dropping them',
    async (kind, settings) => {
      const h = fixture();
      h.design.layout.widgets[0] = { id: 'selected', kind, x: 0, y: 0, w: 6, h: 2, settings };
      await expect(h.service.prepare(ctx, 'portfolio', input, h.tx)).rejects.toThrow(
        'Widget selected cannot be published',
      );
    },
  );

  it('admits the exact same-basis selectors on totals and source rows without recomputing amounts', async () => {
    const h = fixture();
    const basisKey = JSON.stringify([
      2027,
      'request',
      'budget_authority',
      'usd_millions',
      'USD',
      null,
      null,
      null,
    ]);
    h.design.layout.widgets[0].settings = { fundingFiscalYear: 2027, basisKey };
    h.design.layout.widgets[1] = {
      id: 'evidence',
      kind: 'sources',
      x: 6,
      y: 0,
      w: 6,
      h: 2,
      settings: { fundingFiscalYear: 2027, basisKey, subjectIds: ['member'] },
    };
    const { payload } = await h.service.prepare(ctx, 'portfolio', input, h.tx);
    expect(payload.dashboard.layout.widgets[0]?.settings).toEqual({
      fundingFiscalYear: 2027,
      basisKey,
    });
    expect(payload.dashboard.layout.widgets[1]?.settings.subjectIds).toEqual(['member']);
    expect(payload.dashboard.data.totals[0]?.value).toBe('12.01');
    expect(payload.dashboard.data.sources).toHaveLength(1);
  });

  it('refuses restricted evidence even when every subject and the source column are hidden', async () => {
    const h = fixture();
    h.design.layout.widgets[0] = {
      id: 'funding',
      kind: 'funding_table',
      x: 0,
      y: 0,
      w: 6,
      h: 2,
      settings: { subjectIds: [], showSources: false },
    };
    h.evidence.resolveEvidence.mockRejectedValueOnce(new Error('denied'));
    await expect(h.service.prepare(ctx, 'portfolio', input, h.tx)).rejects.toThrow(
      'Widget funding cannot be published: a frozen source is restricted or no longer accessible',
    );
    expect(h.evidence.resolveEvidence).toHaveBeenCalledWith(source.evidenceRefId);
  });

  it('uses captured research, selected-client immutable fit and evidence allowlist', async () => {
    const h = fixture();
    const { payload } = await h.service.prepare(ctx, 'portfolio', input, h.tx);
    expect(payload.dashboard.portfolioName).toBe('Captured name');
    expect(payload.dashboard.data.subjects).toHaveLength(1);
    expect(payload.dashboard.data.clientFit?.fitScore).toBe(20);
    expect(payload.dashboard.data.sources[0]).toMatchObject({
      sourceRevisionId: 'source',
      nativeLocator: { page: 3 },
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /privateNote|hidden|DO NOT COPY|Client Two|Do not expose/,
    );
    expect(h.tx.researchPortfolioFitVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          clientId: 'one',
          portfolioRevision: 4,
          createdAt: { lte: new Date(h.snapshot.capturedAt) },
        }),
      }),
    );
    expect(h.tx.researchPortfolioEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          occurredAt: { lte: new Date(h.snapshot.capturedAt) },
          aggregateRevision: { lte: 4 },
        }),
      }),
    );
  });

  it('binds content, design, client, branding and actual logo bytes to the reviewed hash', async () => {
    const h = fixture();
    const first = await h.service.prepare(ctx, 'portfolio', input, h.tx);
    expect((await h.service.prepare(ctx, 'portfolio', input, h.tx)).previewHash).toBe(
      first.previewHash,
    );
    const other = await h.service.prepare(ctx, 'portfolio', { ...input, clientId: 'two' }, h.tx);
    expect(other.payload.dashboard.data.clientFit?.fitScore).toBe(80);
    expect(JSON.stringify(other.payload)).not.toContain('Client One');
    expect(other.previewHash).not.toBe(first.previewHash);
    const branded = await h.service.prepare(ctx, 'portfolio', { ...input, branding: true }, h.tx);
    expect(branded.payload.logoBinding?.dataUrl).toBe('data:image/png;base64,YQ==');
    h.branding.freezeLogoForSharing.mockResolvedValue({ dataUrl: 'data:image/png;base64,Yg==' });
    expect(
      (await h.service.prepare(ctx, 'portfolio', { ...input, branding: true }, h.tx)).previewHash,
    ).not.toBe(branded.previewHash);
    h.design.version++;
    expect((await h.service.prepare(ctx, 'portfolio', input, h.tx)).previewHash).not.toBe(
      first.previewHash,
    );
  });

  it('refuses the named widget on restricted source, changed revision or missing source', async () => {
    const h = fixture();
    h.evidence.resolveEvidence.mockRejectedValueOnce(new Error('denied'));
    await expect(h.service.prepare(ctx, 'portfolio', input, h.tx)).rejects.toThrow(
      'Widget totals cannot be published',
    );
    h.evidence.resolveEvidence.mockResolvedValueOnce({ ...source, contentHash: 'changed' });
    await expect(h.service.prepare(ctx, 'portfolio', input, h.tx)).rejects.toThrow(
      'source revision cannot be verified',
    );
    h.snapshot.projection.contributions[0].evidence = [];
    await expect(h.service.prepare(ctx, 'portfolio', input, h.tx)).rejects.toThrow(
      'figure has no verifiable frozen source',
    );
  });

  it('keeps missing fit honest, omits hidden financial data and refuses unfrozen external images', async () => {
    const h = fixture();
    h.tx.researchPortfolioFitVersion.findFirst.mockResolvedValue(null);
    h.design.layout.widgets = [
      { id: 'fit', kind: 'client_fit', x: 0, y: 0, w: 12, h: 2, settings: {} },
    ];
    const { payload } = await h.service.prepare(ctx, 'portfolio', input, h.tx);
    expect(payload.dashboard.data.clientFit).toBeNull();
    expect(payload.dashboard.data.contributions).toEqual([]);
    expect(payload.dashboard.data.sources).toEqual([]);
    expect(h.evidence.resolveEvidence).not.toHaveBeenCalled();
    h.design.layout.widgets[0] = {
      id: 'picture',
      kind: 'image',
      x: 0,
      y: 0,
      w: 12,
      h: 2,
      settings: { url: 'https://example.test/live.png' },
    };
    await expect(h.service.prepare(ctx, 'portfolio', input, h.tx)).rejects.toThrow(
      'Widget picture cannot be published',
    );
  });
  it('refuses oversized full content instead of truncating and drops hidden editor settings', async () => {
    const h = fixture();
    h.design.layout.widgets[0].settings.privateClient = { name: 'Other client' };
    const prepared = await h.service.prepare(ctx, 'portfolio', input, h.tx);
    expect(JSON.stringify(prepared.payload)).not.toContain('Other client');
    h.branding.freezeLogoForSharing.mockResolvedValue({ dataUrl: 'x'.repeat(4 * 1024 * 1024) });
    await expect(
      h.service.prepare(ctx, 'portfolio', { ...input, branding: true }, h.tx),
    ).rejects.toThrow('full frozen dashboard exceeds');
  });
});
