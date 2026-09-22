import { NewsEvidenceService } from './news-evidence.service.js';

type Sql = { strings: TemplateStringsArray; values: unknown[] };

function harness(input: { current?: string | null; article?: Record<string, unknown> | null }) {
  const executed: Sql[] = [];
  const article =
    input.article === null
      ? null
      : {
          id: 'article-1',
          source: 'the_hill',
          title: 'Committee advances appropriations bill',
          url: 'https://thehill.com/policy/123?utm_source=x',
          author: 'Reporter',
          publishedAt: new Date('2026-09-21T12:00:00Z'),
          summary: 'Summary',
          ...(input.article ?? {}),
        };
  const currentRows = input.current ? [{ observationId: input.current }] : [];
  const queryRaw = jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    executed.push({ strings, values });
    return strings.join('?').includes('legiwatch_news_current') ? currentRows : [];
  });
  const tx = {
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      executed.push({ strings, values });
      return 1;
    }),
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      executed.push({ strings, values });
      return [];
    }),
  };
  const prisma = {
    $queryRaw: queryRaw,
    intelArticle: { findUnique: jest.fn(async () => article) },
    $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  const service = new NewsEvidenceService(prisma as never);
  return { service, prisma, tx, executed };
}

describe('NewsEvidenceService.ensureObservationForArticle', () => {
  it('returns the current observation without writing when one exists', async () => {
    const { service, prisma } = harness({ current: 'obs-existing' });
    await expect(service.ensureObservationForArticle('article-1')).resolves.toEqual({
      observationId: 'obs-existing',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.intelArticle.findUnique).not.toHaveBeenCalled();
  });

  it('returns null for an unknown article', async () => {
    const { service } = harness({ article: null });
    await expect(service.ensureObservationForArticle('missing')).resolves.toBeNull();
  });

  it('creates a headline-link observation for the existing article row', async () => {
    const { service, tx } = harness({});
    const result = await service.ensureObservationForArticle('article-1');
    expect(result?.observationId).toMatch(/^[a-f0-9]{64}$/);
    const inserts = tx.$executeRaw.mock.calls.map(([strings, ...values]) => ({
      sql: (strings as TemplateStringsArray).join('?'),
      values,
    }));
    const observation = inserts.find((i) => i.sql.includes('INSERT INTO legiwatch_news_observation'));
    expect(observation).toBeDefined();
    expect(observation!.sql).toContain("'intel_article'");
    expect(observation!.sql).toContain("'headline_link'");
    expect(observation!.values).toEqual(
      expect.arrayContaining(['article-1', 'thehill.com', 'https://thehill.com/policy/123?utm_source=x']),
    );
    expect(observation!.sql).not.toContain('intel_article.upsert');
    const current = inserts.find((i) => i.sql.includes('INSERT INTO legiwatch_news_current'));
    expect(current!.sql).toContain('ON CONFLICT(article_id) DO NOTHING');
  });
});
