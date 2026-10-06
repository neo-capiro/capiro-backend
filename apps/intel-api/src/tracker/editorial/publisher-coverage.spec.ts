import {
  loadPublisherIntakeReceipts,
  publisherIntakeEndpoints,
  reconcilePublisherCoverage,
  type PublisherIntakeReceipt,
} from './publisher-coverage.js';
const receipt = (
  slug: string,
  manifest: Record<string, unknown> = {},
  at = '2026-10-06T12:00:00Z',
): PublisherIntakeReceipt => ({
  id: `${slug}-${at}`,
  source: 'rss',
  source_url: publisherIntakeEndpoints.find((e) => e.slug === slug)!.url,
  scope: { publisher: slug },
  observed_at: at,
  complete: false,
  manifest: { coverage: 'current_feed_only', retained: 0, rejected: 0, ...manifest },
});
describe('publisher coverage reconciliation', () => {
  it('retains configured failures even when a publisher has current retained articles', () => {
    const coverage = [
      {
        id: 'politico-fl',
        publisher: 'Politico',
        status: 'unavailable',
        source_group: 'Florida',
        evidence: { reason: 'Publisher denied access' },
      },
    ];
    const result = reconcilePublisherCoverage(coverage, [
      {
        publisher: 'politico.com',
        articles: 3,
        full_text_articles: 0,
        latest_published_at: '2026-10-05T12:00:00Z',
        latest_observed_at: '2026-10-06T12:00:00Z',
      },
    ]);
    expect(result[0]).toMatchObject({
      status: 'unavailable',
      source_group: 'Florida',
      evidence: coverage[0]!.evidence,
      retained: { articles: 3, fullTextArticles: 0, latestPublishedAt: '2026-10-05T12:00:00.000Z' },
    });
  });
  it('uses exact publisher/official host identity without substring matches', () => {
    const row = {
      publisher: 'not-politico.com',
      articles: 99,
      full_text_articles: 99,
      latest_published_at: null,
      latest_observed_at: null,
    };
    expect(
      reconcilePublisherCoverage([{ publisher: 'Politico', status: 'partial' }], [row])[0]!.retained
        .articles,
    ).toBe(0);
    expect(
      reconcilePublisherCoverage(
        [{ publisher: 'Example', source_url: 'https://www.example.gov/feed' }],
        [{ ...row, publisher: 'example.gov' }],
      )[0]!.retained.articles,
    ).toBe(99);
  });
  it.each(['The Hill', 'Politico'])(
    'separates %s unqualified catalog from successful current-feed receipts',
    (publisher) => {
      const receipts = publisherIntakeEndpoints
        .filter((e) => e.publisher === publisher)
        .map((e) => receipt(e.slug));
      const result = reconcilePublisherCoverage(
        [{ publisher, status: 'unavailable', source_group: 'Florida' }],
        [],
        receipts,
      )[0]!;
      expect(result).toMatchObject({
        status: 'unavailable',
        source_group: 'Florida',
        intake: { status: 'succeeded' },
        retained: { articles: 0 },
      });
      expect(result.intake.feeds.every((f) => f.status === 'succeeded')).toBe(true);
    },
  );
  it('keeps every Politico endpoint failure and makes newer failure authoritative over prior success', () => {
    const result = reconcilePublisherCoverage(
      [{ publisher: 'Politico' }],
      [],
      [
        receipt('politico', {}, '2026-10-05T12:00:00Z'),
        receipt('politico', { status: 'failed', reason: 'HTTP 403' }),
        receipt('politico_congress', { status: 'failed', reason: 'HTTP 503' }),
      ],
    )[0]!;
    expect(result.intake.status).toBe('failed');
    expect(result.intake.feeds.map((f) => f.reason)).toEqual(['HTTP 403', 'HTTP 503']);
  });
  it('does not flatten one failed Politico endpoint into another successful endpoint', () => {
    const result = reconcilePublisherCoverage(
      [{ publisher: 'Politico' }],
      [],
      [receipt('politico'), receipt('politico_congress', { status: 'failed', reason: 'HTTP 500' })],
    )[0]!;
    expect(result.intake.status).toBe('partial');
    expect(result.intake.feeds.map((f) => f.status)).toEqual(['succeeded', 'failed']);
  });
  it('preserves WUSF partial historical qualification alongside successful intake', () => {
    expect(
      reconcilePublisherCoverage(
        [{ publisher: 'WUSF', status: 'partial' }],
        [],
        [receipt('wusf')],
      )[0],
    ).toMatchObject({ status: 'partial', intake: { status: 'succeeded' } });
  });
  it('does not infer intake health from articles, unknown publishers, or receipts with wrong identity', () => {
    const articles = [
      {
        publisher: 'thehill.com',
        articles: 480,
        full_text_articles: 0,
        latest_published_at: null,
        latest_observed_at: null,
      },
    ];
    const wrong = { ...receipt('the_hill'), scope: { publisher: 'unrelated' } };
    const results = reconcilePublisherCoverage(
      [{ publisher: 'The Hill' }, { publisher: 'Unconfigured newspaper', source_url: null }],
      articles,
      [wrong],
    );
    expect(results[0]).toMatchObject({
      retained: { articles: 480 },
      intake: { status: 'not_checked' },
    });
    expect(results[1]!.intake).toEqual({ status: 'no_verified_endpoint', feeds: [] });
  });
  it('retains incomplete and failed-primary evidence without treating complete=false as failure', () => {
    const result = reconcilePublisherCoverage(
      [{ publisher: 'WUSF' }],
      [],
      [{ ...receipt('wusf', { primaryFailure: 'HTTP 403' }), source: 'publisher-news' }],
    )[0]!;
    expect(result.intake).toMatchObject({
      status: 'partial',
      feeds: [{ primaryFailure: 'HTTP 403' }],
    });
    const malformed = receipt('wusf', { retained: '10' });
    expect(
      reconcilePublisherCoverage([{ publisher: 'WUSF' }], [], [malformed])[0]!.intake.feeds[0]!
        .status,
    ).toBe('unknown');
  });
  it('loads at most one latest receipt per explicitly bound endpoint and publisher, independent of article window', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await loadPublisherIntakeReceipts({ $queryRaw: query });
    const [parts, bindings] = query.mock.calls[0]!;
    const sql = parts.join('?');
    expect(sql).toContain("source IN ('rss','publisher-news')");
    expect(sql).toContain("source_url=e.url AND scope->>'publisher'=e.slug");
    expect(sql).toContain('ORDER BY observed_at DESC,id DESC LIMIT 1');
    expect(JSON.parse(bindings)).toEqual(publisherIntakeEndpoints);
    expect(sql).not.toContain('content_bytes');
  });
});
