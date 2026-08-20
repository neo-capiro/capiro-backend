import type { PrismaService } from '../../prisma/prisma.service.js';
import { NewsCatcherDashboardService } from './news-catcher-dashboard.service.js';

describe('NewsCatcherDashboardService shared Data Explorer corpus', () => {
  it('queries IntelArticle with semantic filters and maps the dashboard response', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 'article-1',
        source: 'politico_congress',
        title: 'Army advances counter-drone procurement',
        url: 'https://example.test/article-1',
        summary: 'The Department of Defense outlined a new acquisition plan.',
        publishedAt: new Date('2026-08-20T10:00:00.000Z'),
        topics: ['Procurement'],
      },
    ]);
    const prisma = {
      intelArticle: { findMany },
    } as unknown as PrismaService;
    const service = new NewsCatcherDashboardService(prisma);

    const result = await service.getSharedNewsDashboard({
      query: 'counter UAS',
      sources: ['Politico'],
      topics: ['procurement'],
      agencies: ['Department of Defense'],
      lookback: '48h',
    });

    const args = findMany.mock.calls[0]?.[0] as { where: Record<string, unknown>; take: number };
    expect(args.take).toBe(8);
    expect(JSON.stringify(args.where)).toContain('counter unmanned aircraft systems');
    expect(JSON.stringify(args.where)).toContain('politico_congress');
    expect(JSON.stringify(args.where)).toContain('Procurement');
    expect(JSON.stringify(args.where)).toContain('publishedAt');
    expect(result).toMatchObject({
      available: true,
      provider: 'intel-article',
      cached: false,
      items: [
        {
          id: 'article-1',
          source: 'politico_congress',
          title: 'Army advances counter-drone procurement',
          clientMatches: [],
          duplicateCount: null,
        },
      ],
    });
  });

  it('reports an honest empty state when the shared corpus has no matches', async () => {
    const prisma = {
      intelArticle: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const service = new NewsCatcherDashboardService(prisma);

    const result = await service.getSharedNewsDashboard({ query: 'no such story' });

    expect(result).toMatchObject({
      available: true,
      provider: 'intel-article',
      items: [],
      reason: 'no_articles',
    });
  });
});
