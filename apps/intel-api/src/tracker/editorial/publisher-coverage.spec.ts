import { reconcilePublisherCoverage } from './publisher-coverage.js';
describe('publisher coverage reconciliation', () => {
  it('retains configured failures even when a publisher has current retained articles', () => {
    const coverage = [{ id: 'politico-fl', publisher: 'Politico', status: 'unavailable', source_group: 'Florida', evidence: { reason: 'Publisher denied access' } }];
    const result = reconcilePublisherCoverage(coverage, [{ publisher: 'politico.com', articles: 3, full_text_articles: 0, latest_published_at: '2026-10-05T12:00:00Z', latest_observed_at: '2026-10-06T12:00:00Z' }]);
    expect(result[0]).toMatchObject({ status: 'unavailable', source_group: 'Florida', evidence: coverage[0]!.evidence,
      retained: { articles: 3, fullTextArticles: 0, latestPublishedAt: '2026-10-05T12:00:00.000Z' } });
  });
  it('uses exact publisher/official host identity without substring matches', () => {
    const row = { publisher: 'not-politico.com', articles: 99, full_text_articles: 99, latest_published_at: null, latest_observed_at: null };
    expect(reconcilePublisherCoverage([{ publisher: 'Politico', status: 'partial' }], [row])[0]!.retained.articles).toBe(0);
    expect(reconcilePublisherCoverage([{ publisher: 'Example', source_url: 'https://www.example.gov/feed' }], [{ ...row, publisher: 'example.gov' }])[0]!.retained.articles).toBe(99);
  });
});
