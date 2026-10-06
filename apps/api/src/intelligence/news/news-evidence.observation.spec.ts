import { NewsEvidenceService } from './news-evidence.service.js';
import { createHash } from 'node:crypto';

type Sql = { strings: TemplateStringsArray; values: unknown[] };

function harness(input: {
  current?: string | null;
  article?: Record<string, unknown> | null;
  known?: boolean;
}) {
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
    intelArticle: {
      upsert: jest.fn(async () => ({ id: 'article-1' })),
      update: jest.fn(async () => ({ id: 'article-1' })),
    },
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      executed.push({ strings, values });
      return 1;
    }),
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      executed.push({ strings, values });
      if (input.known && strings.join('?').includes('SELECT id FROM legiwatch_news_observation'))
        return [{ id: values[0] }];
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
    const observation = inserts.find((i) =>
      i.sql.includes('INSERT INTO legiwatch_news_observation'),
    );
    expect(observation).toBeDefined();
    expect(observation!.sql).toContain("'intel_article'");
    expect(observation!.sql).toContain("'headline_link'");
    expect(observation!.values).toEqual(
      expect.arrayContaining([
        'article-1',
        'thehill.com',
        'https://thehill.com/policy/123?utm_source=x',
      ]),
    );
    expect(observation!.sql).not.toContain('intel_article.upsert');
    const current = inserts.find((i) => i.sql.includes('INSERT INTO legiwatch_news_current'));
    expect(current!.sql).toContain('ON CONFLICT(article_id) DO NOTHING');
  });
});

describe('NewsEvidenceService.retain publication precision', () => {
  const observation = {
    provider: 'official-html',
    url: 'https://www.dhs.gov/news/2026/10/05/release',
    publisher: 'www.dhs.gov',
    title: 'Official release',
    rights: 'headline_link' as const,
  };
  const inserted = (executed: Sql[]) => {
    const row = executed.find(({ strings }) =>
      strings.join('?').includes('INSERT INTO legiwatch_news_observation'),
    )!;
    expect(row).toBeDefined();
    const columns = row.strings
      .join('?')
      .match(/legiwatch_news_observation\(([^)]+)\)/)![1]!
      .split(',');
    return Object.fromEntries(columns.map((column, index) => [column, row.values[index]]));
  };
  // Pin the pre-change serialized revision contract independently of newsHash.
  const legacyRevision = (publishedAt: Date | null) =>
    createHash('sha256')
      .update(
        JSON.stringify({
          title: observation.title,
          summary: null,
          body: null,
          publishedAt,
          publisher: observation.publisher,
          rights: observation.rights,
          author: null,
        }),
      )
      .digest('hex');

  it('writes an exact publisher day as a UTC bucket with day precision and a distinct revision', async () => {
    const { service, executed, tx } = harness({});
    await service.retain({
      ...observation,
      publishedAt: '2026-10-05',
      publicationPrecision: 'day',
    });
    const row = inserted(executed);
    expect(row.publication_precision).toBe('day');
    expect((row.published_at as Date).toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(row.revision).not.toBe(legacyRevision(new Date('2026-10-05T00:00:00Z')));
    expect(tx.intelArticle.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ publishedAt: new Date('2026-10-05T00:00:00Z') }),
      }),
    );
  });

  it.each([undefined, 'instant'] as const)(
    'preserves the legacy revision and instant timestamp for precision %s',
    async (publicationPrecision) => {
      const { service, executed } = harness({});
      await service.retain({
        ...observation,
        publishedAt: '2026-10-05T09:15:00-04:00',
        publicationPrecision,
      });
      const row = inserted(executed);
      expect(row.publication_precision).toBe('instant');
      expect((row.published_at as Date).toISOString()).toBe('2026-10-05T13:15:00.000Z');
      expect(row.revision).toBe(legacyRevision(new Date('2026-10-05T13:15:00Z')));
    },
  );

  it('preserves unknown publication and its legacy revision without inventing an instant in evidence', async () => {
    const { service, executed } = harness({});
    await service.retain(observation);
    expect(inserted(executed)).toMatchObject({
      published_at: null,
      publication_precision: 'unknown',
      revision: legacyRevision(null),
    });
  });

  it.each([
    '2026-02-29',
    '2026-02-30',
    '2026-13-01',
    '2026-10-05T00:00:00Z',
    '10/05/2026',
    '',
    null,
  ])(
    'rejects invalid or non-day input %s before opening a write transaction',
    async (publishedAt) => {
      const { service, prisma } = harness({});
      await expect(
        service.retain({ ...observation, publishedAt, publicationPrecision: 'day' }),
      ).rejects.toThrow('INVALID_PUBLICATION_DAY');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('accepts a real leap day and does not roll a replayed observation back into current', async () => {
    const { service, executed, tx } = harness({ known: true });
    await service.retain({
      ...observation,
      publishedAt: '2024-02-29',
      publicationPrecision: 'day',
    });
    expect(inserted(executed)).toMatchObject({
      published_at: new Date('2024-02-29T00:00:00Z'),
      publication_precision: 'day',
    });
    expect(
      executed.some(({ strings }) =>
        strings.join('?').includes('INSERT INTO legiwatch_news_current'),
      ),
    ).toBe(false);
    expect(tx.intelArticle.update).not.toHaveBeenCalled();
  });
});
