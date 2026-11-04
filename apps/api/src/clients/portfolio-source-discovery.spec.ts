import { randomUUID } from 'node:crypto';
import {
  discoverPortfolioFromSources,
  portfolioDiscoveryProposals,
  portfolioDiscoverySchema,
  type PortfolioDiscoverySource,
} from './portfolio-source-discovery.js';
import { runWithFillTask } from './client-profile-fill-execution.js';
import { portfolioResearchScope, readPortfolioResearchScope } from './portfolio-research-scope.js';
import { readResearchInputs, researchTaskInput } from './client-profile-fill-research-inputs.js';
import { researchStartRequest } from './client-profile-fill-start-request.js';
import { ClientProfileFillService } from './client-profile-fill.service.js';

jest.mock('./profile-subject.js', () => ({
  ...jest.requireActual('./profile-subject.js'),
  requireProfileSubject: jest.fn().mockResolvedValue({ id: 'client' }),
}));
const ctx = {
  tenantId: randomUUID(),
  userId: randomUUID(),
  clerkUserId: 'fixture',
  tenantSlug: 'fixture',
  role: 'standard_user',
} as const;
const clientId = randomUUID(),
  capabilityId = randomUUID(),
  runId = randomUUID();
const task = { id: randomUUID(), runId, clientId, tenantId: ctx.tenantId, workerId: 'worker' };
const dated = '2026-01-01T00:00:00.000Z';
const products = Array.from({ length: 24 }, (_, index) => ({
  name: `Fixture Vessel ${index + 1}`,
  type: 'platform',
  lifecycle: 'in_service',
  description: `Fixture Vessel ${index + 1} is a named vessel.`,
  tags: ['uncrewed vessels'],
  classification: 'capability' as const,
  parentName: null,
  evidence: [{ sourceId: 'site', quote: `Fixture Vessel ${index + 1} is a named vessel.` }],
}));
const source: PortfolioDiscoverySource = {
  id: 'site',
  title: 'Fixture product catalog',
  url: 'https://fixture.example/products',
  text: products.map((p) => p.description).join('\n'),
  observedAt: dated,
  sourceType: 'company',
};
const result = { capabilities: products, alignments: [], businessUnits: [] };
function harness(data: unknown = result) {
  const tx = {
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 'current' }]),
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    clientCapability: {
      findFirst: jest.fn().mockResolvedValue({
        id: capabilityId,
        name: 'Fixture Vessel 1',
        version: 3,
        description: products[0]!.description,
        keywords: ['vessel'],
        provenance: [],
        updatedAt: new Date(dated),
      }),
    },
    engagementAttachment: { findFirst: jest.fn().mockResolvedValue(null) },
    programElementSource: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: randomUUID(),
          peCode: '0600000N',
          sourceUrl: 'https://budget.example.gov/book.pdf',
          pageNumber: 8,
          snippet: 'Uncrewed vessel navigation and sensing research.',
          observedAt: new Date(dated),
          programElement: { title: 'Vessel research' },
        },
      ]),
    },
    federalGrant: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const prisma = {
    withTenantUser: jest.fn(async (_t: string, _u: string, work: (tx: unknown) => unknown) =>
      work(tx),
    ),
    withTenant: jest.fn(async (_t: string, work: (tx: unknown) => unknown) => work(tx)),
  };
  const agent = { extract: jest.fn().mockResolvedValue({ data, audit: { outcome: 'success' } }) };
  const review = {
    stageExtractedCapabilitiesInTransaction: jest
      .fn()
      .mockImplementation(async (_tx, _ctx, _client, inputs) => inputs),
  };
  const peRelevance = {
    getRelevantPesForClient: jest.fn().mockResolvedValue({ data: [{ peCode: '0600000N' }] }),
  };
  const input = {
    ctx,
    clientId,
    runId,
    sources: [source],
    scope: { purpose: 'capabilities' as const },
    prisma: prisma as never,
    agent: agent as never,
    review: review as never,
    peRelevance: peRelevance as never,
  };
  return { tx, prisma, agent, review, input };
}
test('one durable source execution saves all24 source-backed fixture products for stable paging', async () => {
  const h = harness();
  expect(
    await runWithFillTask(ctx, task, 'core', () => discoverPortfolioFromSources(h.input)),
  ).toBe(24);
  expect(h.agent.extract).toHaveBeenCalledTimes(1);
  expect(h.review.stageExtractedCapabilitiesInTransaction).toHaveBeenCalledTimes(1);
  expect(h.review.stageExtractedCapabilitiesInTransaction.mock.calls[0]![3]).toHaveLength(24);
  expect(portfolioDiscoverySchema.properties.capabilities.maxItems).toBe(120);
  expect(
    h.tx.$queryRawUnsafe.mock.calls.filter((call) => String(call[0]).includes('worker_id')),
  ).toHaveLength(2);
});
test('readers cannot launch the producer outside a durable task', async () => {
  const h = harness();
  await expect(discoverPortfolioFromSources(h.input)).rejects.toThrow('durable research task');
  expect(h.agent.extract).not.toHaveBeenCalled();
});
test('cancelled attempt refuses model output before any proposal persists', async () => {
  const h = harness();
  h.agent.extract.mockImplementationOnce(async () => {
    h.tx.$queryRawUnsafe.mockResolvedValue([]);
    return { data: result, audit: { outcome: 'success' } };
  });
  await expect(
    runWithFillTask(ctx, task, 'core', () => discoverPortfolioFromSources(h.input)),
  ).rejects.toThrow('no longer current');
  expect(h.review.stageExtractedCapabilitiesInTransaction).not.toHaveBeenCalled();
});
test('a withdrawn source document is refused before inference', async () => {
  const h = harness();
  await expect(
    runWithFillTask(ctx, task, 'core', () =>
      discoverPortfolioFromSources({
        ...h.input,
        sources: [{ ...source, attachmentId: randomUUID() }],
      }),
    ),
  ).rejects.toThrow('no longer shared');
  expect(h.agent.extract).not.toHaveBeenCalled();
});
test('bound research rejects a capability edited since run start', async () => {
  const h = harness();
  await expect(
    runWithFillTask(ctx, task, 'core', () =>
      discoverPortfolioFromSources({
        ...h.input,
        scope: { purpose: 'alignment', capabilityId, capabilityVersion: 2 },
      }),
    ),
  ).rejects.toThrow('Capability changed');
  expect(h.agent.extract).not.toHaveBeenCalled();
});
test('alignment producer supplies actual budget snippets for semantic and keyword review', async () => {
  const h = harness({ capabilities: [], alignments: [], businessUnits: [] });
  h.agent.extract.mockImplementationOnce(async (request) => ({
    data: {
      capabilities: [],
      businessUnits: [],
      alignments: [
        {
          targetType: 'pe',
          value: '0600000N',
          rationale: 'Both address uncrewed vessel navigation.',
          score: 88,
          evidence: [
            {
              sourceId: request.sources.find((s: { id: string }) => s.id.startsWith('pe-')).id,
              quote: 'Uncrewed vessel navigation and sensing research.',
            },
            { sourceId: `capability-${capabilityId}`, quote: products[0]!.description },
          ],
        },
      ],
    },
    audit: { outcome: 'success' },
  }));
  expect(
    await runWithFillTask(ctx, task, 'core', () =>
      discoverPortfolioFromSources({
        ...h.input,
        scope: { purpose: 'alignment', capabilityId, capabilityVersion: 3 },
      }),
    ),
  ).toBe(1);
  const proposal = h.review.stageExtractedCapabilitiesInTransaction.mock.calls[0]![3][0];
  expect(proposal).toMatchObject({
    kind: 'alignment',
    capabilityId,
    payload: { targetType: 'pe', value: '0600000N', score: 88 },
  });
  expect(proposal.evidence[0].url).toBe('https://budget.example.gov/book.pdf#page=8');
  expect(h.tx.clientCapability.findFirst).toHaveBeenCalledTimes(2);
  expect(h.tx.programElementSource.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ distinct: ['peCode'] }),
  );
});
test('unknown target IDs and fabricated source quotes never stage', () => {
  expect(() =>
    portfolioDiscoveryProposals(
      {
        ...result,
        capabilities: [
          { ...products[0]!, evidence: [{ sourceId: 'site', quote: 'Invented capability fact.' }] },
        ],
      },
      [source],
      { purpose: 'capabilities' },
    ),
  ).toThrow('not present');
  expect(() =>
    portfolioDiscoveryProposals(
      {
        capabilities: [],
        businessUnits: [],
        alignments: [
          {
            targetType: 'pe',
            value: '9999999N',
            rationale: 'Test',
            score: 90,
            evidence: [{ sourceId: 'site', quote: products[0]!.description }],
          },
        ],
      },
      [source],
      { purpose: 'alignment', capabilityId, capabilityVersion: 3 },
    ),
  ).toThrow('exact canonical target');
});
test('categories and features do not inflate capability count and stay attached to their offering', () => {
  const category = {
    ...products[0]!,
    name: 'Fixture family',
    classification: 'category' as const,
    parentName: 'Fixture Vessel 1',
    evidence: [{ sourceId: 'site', quote: 'Fixture family includes Fixture Vessel 1.' }],
  };
  const feature = {
    ...products[0]!,
    name: 'Navigation',
    classification: 'feature' as const,
    parentName: 'Fixture Vessel 1',
    evidence: [{ sourceId: 'site', quote: 'Navigation is a feature of Fixture Vessel 1.' }],
  };
  const rows = portfolioDiscoveryProposals(
    { ...result, capabilities: [products[0]!, category, feature] },
    [
      {
        ...source,
        text:
          source.text +
          ' Fixture family includes Fixture Vessel 1. Navigation is a feature of Fixture Vessel 1.',
      },
    ],
    { purpose: 'capabilities' },
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.payload).toMatchObject({
    tags: ['uncrewed vessels', 'Fixture family'],
    description: expect.stringContaining('Feature: Navigation'),
  });
});
test('only latest supplied annual report segments are proposed with their dated source', () => {
  const report = {
    ...source,
    text: '2025 Annual report. Reportable segments: Maritime Systems and Test Systems.',
  };
  const units = {
    capabilities: [],
    alignments: [],
    businessUnits: [
      {
        name: 'Maritime Systems',
        annualReportYear: 2025,
        evidence: [
          { sourceId: 'site', quote: 'Reportable segments: Maritime Systems and Test Systems.' },
        ],
      },
    ],
  };
  expect(portfolioDiscoveryProposals(units, [report], { purpose: 'business_units' })).toMatchObject(
    [{ kind: 'business_unit', payload: { name: 'Maritime Systems', annualReportYear: 2025 } }],
  );
  expect(() =>
    portfolioDiscoveryProposals(
      units,
      [
        {
          ...report,
          text: '2025 Products. Reportable segments: Maritime Systems and Test Systems.',
        },
      ],
      { purpose: 'business_units' },
    ),
  ).toThrow();
  expect(() =>
    portfolioDiscoveryProposals(
      units,
      [{ ...report, text: '2025 products: Maritime Systems and Test Systems.' }],
      { purpose: 'business_units' },
    ),
  ).toThrow();
});
test('selected capability scope survives task serialization and affects idempotency', () => {
  const scope = { purpose: 'alignment' as const, capabilityId, capabilityVersion: 3 };
  expect(
    readResearchInputs(
      JSON.parse(JSON.stringify(researchTaskInput('client_document', null, [], undefined, scope))),
      'client_document',
    ).portfolioScope,
  ).toEqual(scope);
  expect(() => portfolioResearchScope({ purpose: 'alignment' })).toThrow('requires a capability');
  expect(() => readPortfolioResearchScope({ purpose: 'alignment', capabilityId })).toThrow(
    'revision',
  );
  const requestId = randomUUID();
  expect(
    researchStartRequest(ctx, clientId, { requestId, purpose: 'alignment', capabilityId })?.sha256,
  ).not.toBe(
    researchStartRequest(ctx, clientId, { requestId, purpose: 'capabilities', capabilityId })
      ?.sha256,
  );
});
test('bounded sitemap plus nested product crawl can acquire24 distinct product sources', async () => {
  const engine = new ClientProfileFillService(
    ...(Array(16).fill({}) as ConstructorParameters<typeof ClientProfileFillService>),
  ) as unknown as {
    fetchPublicHtml: jest.Mock;
    fetchPublicPages: (url: string) => Promise<Array<{ url: string }>>;
  };
  engine.fetchPublicHtml = jest.fn(async (url: string) => {
    if (url.endsWith('sitemap.xml'))
      return {
        url,
        html: `<urlset>${products.map((_, i) => `<url><loc>https://fixture.example/products/${i + 1}</loc></url>`).join('')}</urlset>`,
      };
    return {
      url,
      html: url.endsWith('/')
        ? '<a href="/products">Products</a>'
        : `<h1>Product ${url.split('/').pop()}</h1>`,
    };
  });
  const pages = await engine.fetchPublicPages('https://fixture.example/');
  expect(pages.filter((p) => /\/products\/\d+$/.test(p.url))).toHaveLength(24);
  expect(
    engine.fetchPublicHtml.mock.calls.every((call) =>
      String(call[0]).startsWith('https://fixture.example/'),
    ),
  ).toBe(true);
});

test('date-only official catalog retrieval metadata becomes valid dated classification evidence', async () => {
  const h = harness({ capabilities: [], alignments: [], businessUnits: [] });
  h.tx.clientCapability.findFirst.mockResolvedValue({
    id: capabilityId,
    name: 'Engineering service',
    version: 3,
    description: 'Engineering analysis and design services.',
    keywords: ['engineering'],
    provenance: [],
    updatedAt: new Date(dated),
  });
  h.agent.extract.mockImplementationOnce(async (request) => {
    const reference = request.sources.find((s: { id: string }) => s.id.startsWith('naics-'));
    expect(reference).toBeDefined();
    const code = reference.id.slice('naics-'.length);
    return {
      data: {
        capabilities: [],
        businessUnits: [],
        alignments: [
          {
            targetType: 'naics',
            value: code,
            rationale: 'Engineering services align to the cited industry definition.',
            score: 88,
            evidence: [
              { sourceId: reference.id, quote: reference.text },
              {
                sourceId: `capability-${capabilityId}`,
                quote: 'Engineering analysis and design services.',
              },
            ],
          },
        ],
      },
      audit: { outcome: 'success' },
    };
  });
  expect(
    await runWithFillTask(ctx, task, 'core', () =>
      discoverPortfolioFromSources({
        ...h.input,
        scope: { purpose: 'alignment', capabilityId, capabilityVersion: 3 },
      }),
    ),
  ).toBe(1);
  expect(
    h.review.stageExtractedCapabilitiesInTransaction.mock.calls[0]![3][0].evidence[0].observedAt,
  ).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

test('source access withdrawn during inference prevents saving derived proposals', async () => {
  const h = harness();
  const attachmentId = randomUUID();
  h.tx.engagementAttachment.findFirst
    .mockResolvedValueOnce({ id: attachmentId })
    .mockResolvedValue(null);
  await expect(
    runWithFillTask(ctx, task, 'core', () =>
      discoverPortfolioFromSources({ ...h.input, sources: [{ ...source, attachmentId }] }),
    ),
  ).rejects.toThrow('no longer shared');
  expect(h.agent.extract).toHaveBeenCalledTimes(1);
  expect(h.review.stageExtractedCapabilitiesInTransaction).not.toHaveBeenCalled();
});
