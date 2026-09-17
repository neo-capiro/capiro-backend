import crypto from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { FundingOpportunityV2DecoratorService } from './funding-opportunity-v2-decorator.service.js';
import {
  FundingOpportunityV2SearchService,
  createPrismaOpportunityCatalogAdapters,
} from './funding-opportunity-v2-search.service.js';
import { normalizeOpportunitySearchCriteria } from '@capiro/shared';

const TEST_DATABASE_URL = process.env.FUNDING_OPPORTUNITIES_TEST_DATABASE_URL;
const parsedUrl = TEST_DATABASE_URL ? new URL(TEST_DATABASE_URL) : null;
const isolated = Boolean(
  parsedUrl?.protocol === 'postgresql:' && parsedUrl.hostname === '127.0.0.1'
    && parsedUrl.port === '5486' && parsedUrl.pathname === '/fo_v2_search'
    && parsedUrl.searchParams.get('schema') === 'public' && parsedUrl.username === 'fo_test'
    && parsedUrl.password.length > 0,
);
const describeDb = isolated ? describe : describe.skip;

jest.setTimeout(120_000);

describeDb('Funding Opportunity v2 actual SQL/service pagination (isolated Postgres)', () => {
  const namespace = `durable-pagination-${Date.now()}-${crypto.randomUUID()}`;
  const tenantId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const flagId = `${namespace}-flag`;
  const grantIds = Array.from({ length: 209 }, (_, index) => `${namespace}-g${index}`);
  const samIds: string[] = Array.from({ length: 7 }, () => crypto.randomUUID());
  const prisma = new PrismaService({ datasources: { db: { url: TEST_DATABASE_URL } } });
  const service = new FundingOpportunityV2SearchService(
    createPrismaOpportunityCatalogAdapters(prisma),
    { visibleClientIds: async () => [], read: async () => null },
    prisma,
    new FundingOpportunityV2DecoratorService(prisma),
  );
  const context = { tenantId, userId };
  const criteria = (patch: Record<string, unknown> = {}) => normalizeOpportunitySearchCriteria({
    mode: 'all', sources: ['grants_gov', 'sam_gov'], lifecycle: [],
    query: `${namespace}-batch`, sort: 'title', direction: 'asc', page: 1, pageSize: 100,
    ...patch,
  }).criteria;

  beforeAll(async () => {
    await prisma.tenant.create({ data: { id: tenantId, slug: namespace, name: namespace } });
    await prisma.user.create({ data: { id: userId, clerkUserId: namespace, email: `${namespace}@example.invalid` } });
    await prisma.$executeRaw`INSERT INTO intel_feature_flag(id, feature, tenant_id, enabled)
      VALUES (${flagId}, 'funding_opportunities', ${tenantId}, true)`;

    const future = new Date('2099-12-31T00:00:00.000Z');
    await prisma.federalGrant.createMany({
      data: grantIds.map((id, index) => ({
        id,
        title: index < 205
          ? `${String(index * 2).padStart(4, '0')} ${namespace}-batch`
          : index === 205
            ? ` ${namespace}-unicode`
            : index === 206
              ? `😀 ${namespace}-unicode`
              : index === 207
                ? `İ ${namespace}-fold`
                : `iz ${namespace}-fold`,
        agency: 'Root pagination test',
        fundingInstrument: 'Grant',
        status: 'posted',
        eligibility: index >= 200 && index < 205 ? ['Small businesses'] : ['State governments'],
        closeDate: future,
      })),
    });
    await prisma.samOpportunity.createMany({
      data: samIds.map((id, index) => ({
        id,
        noticeId: `${namespace}-sam-${index}`,
        title: index < 5
          ? `${String(index * 80 + 1).padStart(4, '0')} ${namespace}-batch`
          : index === 5
            ? ` ${namespace}-unicode`
            : `j ${namespace}-fold`,
        noticeType: 'Solicitation',
        active: true,
        responseDeadline: index === 0 ? null : future,
      })),
    });
  });

  afterAll(async () => {
    try {
      await prisma.opportunityBookmark.deleteMany({ where: { tenantId } });
      await prisma.federalGrant.deleteMany({ where: { id: { in: grantIds } } });
      await prisma.samOpportunity.deleteMany({ where: { id: { in: samIds }, noticeId: { startsWith: namespace } } });
      await prisma.$executeRaw`DELETE FROM intel_feature_flag WHERE id = ${flagId} AND tenant_id = ${tenantId}`;
      await prisma.tenant.deleteMany({ where: { id: tenantId, slug: namespace } });
      await prisma.user.deleteMany({ where: { id: userId, clerkUserId: namespace } });
    } finally {
      await prisma.$disconnect();
    }
  });

  test('uses actual SQL adapters for complete global pagination, late matches, Unicode, case-folding, and nulls', async () => {
    const pages = [];
    for (const page of [1, 2, 3]) pages.push(await service.search(context, criteria({ page })));
    const rows = pages.flatMap((page) => page.opportunities);
    expect(pages.every((page) => page.total === 210)).toBe(true);
    expect(pages.map((page) => page.opportunities.length)).toEqual([100, 100, 10]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(210);

    const late = await service.search(context, criteria({ sources: ['grants_gov'], applicantTypes: ['smallbiz'], pageSize: 1 }));
    expect(late.total).toBe(5);
    expect(late.opportunities).toHaveLength(1);
    expect(late.opportunities[0]?.sourceRecordId).toBe(grantIds[200]);

    for (const direction of ['asc', 'desc'] as const) {
      const fullUnicode = await service.search(context, criteria({ query: `${namespace}-unicode`, pageSize: 20, direction }));
      const pagedUnicode = [];
      for (const page of [1, 2, 3]) pagedUnicode.push(...(await service.search(context, criteria({ query: `${namespace}-unicode`, page, pageSize: 1, direction }))).opportunities);
      expect(fullUnicode.opportunities).toHaveLength(3);
      expect(pagedUnicode.map((row) => row.id)).toEqual(fullUnicode.opportunities.map((row) => row.id));

      const fullFold = await service.search(context, criteria({ query: `${namespace}-fold`, pageSize: 20, direction }));
      const pagedFold = [];
      for (const page of [1, 2, 3]) pagedFold.push(...(await service.search(context, criteria({ query: `${namespace}-fold`, page, pageSize: 1, direction }))).opportunities);
      expect(fullFold.opportunities).toHaveLength(3);
      expect(pagedFold.map((row) => row.id)).toEqual(fullFold.opportunities.map((row) => row.id));

      const ordered = [];
      for (const page of [1, 2, 3]) ordered.push(...(await service.search(context, criteria({ sort: 'deadline', page, direction }))).opportunities);
      expect(ordered).toHaveLength(210);
      expect(ordered.at(-1)?.deadline).toBeNull();
    }
  });
});

export {};
