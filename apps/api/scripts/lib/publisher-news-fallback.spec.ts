import {
  loadPublisherNews,
  parsePublisherNews,
  PUBLISHER_NEWS_FALLBACKS,
} from './publisher-news-fallback.js';

function dhsRow(href = '/news/2026/10/05/published-release', day = '2026-10-05') {
  return `<li class="usa-collection__item"><h3 class="usa-collection__heading"><a href="${href}">Published &amp; verified release</a></h3><time datetime="${day}"></time><div class="usa-collection__body"><p>Official excerpt.</p></div></li>`;
}
const dhs = (rows: string) => `<div class="view-id-news_events">${rows}</div>`;
const commerceRow = (overrides: Record<string, unknown> = {}) => ({
  type: 'news',
  href: 'https://www.commerce.gov/news/press-releases/2026/10/published-release',
  label: 'Published release',
  post_date_formatted: '2026-10-05T09:30:00-04:00',
  created: '2026-10-06T14:00:00Z',
  updated: '2026-10-06T15:00:00Z',
  news_type: [{ label: 'Press releases' }, { missing: true }],
  ...overrides,
});

describe('official publisher article parsing', () => {
  it('retains DHS day precision and deduplicates exact URLs', () => {
    const parsed = parsePublisherNews(dhs(dhsRow() + dhsRow()), 'dhs-press-index');
    expect(parsed.observedItems).toBe(2);
    expect(parsed.items).toEqual([
      expect.objectContaining({
        url: 'https://www.dhs.gov/news/2026/10/05/published-release',
        title: 'Published & verified release',
        pubDate: '2026-10-05',
        publicationPrecision: 'day',
        description: 'Official excerpt.',
      }),
    ]);
  });
  it.each([
    ['https://external.example/news/2026/10/05/article', '2026-10-05'],
    ['http://www.dhs.gov/news/2026/10/05/article', '2026-10-05'],
    ['/news/2026/10/04/article', '2026-10-05'],
    ['/news/2026/02/30/article', '2026-02-30'],
    ['/news/2026/10/05/article', '2026-10-05T12:00:00Z'],
  ])('rejects DHS host, date or precision mismatch %s', (url, day) => {
    const parsed = parsePublisherNews(dhs(dhsRow() + dhsRow(url, day)), 'dhs-press-index');
    expect(parsed.items).toHaveLength(1);
    expect(parsed.rejected).toBe(1);
  });
  it('rejects an unrelated DHS layout or a recognized layout with no qualified records', () => {
    expect(() =>
      parsePublisherNews('<html><h1>Access denied</h1></html>', 'dhs-press-index'),
    ).toThrow('layout_unrecognized');
    expect(() => parsePublisherNews(dhs(dhsRow('/news/undated')), 'dhs-press-index')).toThrow(
      'no_qualified_records',
    );
  });
  it('uses Commerce publication time rather than API creation/update times and deduplicates', () => {
    const row = commerceRow();
    const parsed = parsePublisherNews(JSON.stringify({ data: [row, row] }), 'commerce-news-api');
    expect(parsed.observedItems).toBe(2);
    expect(parsed.items).toEqual([
      expect.objectContaining({
        pubDate: '2026-10-05T09:30:00-04:00',
        categories: ['Press releases'],
      }),
    ]);
    expect(parsed.items[0]).not.toHaveProperty('publicationPrecision');
  });
  it.each([
    { href: 'https://external.example/news/article' },
    { type: 'blog' },
    { post_date_formatted: undefined },
    { post_date_formatted: '2026-10-05' },
    { post_date_formatted: '2026-10-05T12:00:00' },
    { post_date_formatted: '2026-02-30T12:00:00-05:00' },
  ])('rejects Commerce foreign or unqualified publication evidence %j', (patch) => {
    const parsed = parsePublisherNews(
      JSON.stringify({ data: [commerceRow(), commerceRow(patch)] }),
      'commerce-news-api',
    );
    expect(parsed.items).toHaveLength(1);
    expect(parsed.rejected).toBe(1);
  });
  it('rejects unrecognized Commerce layouts without interpreting arbitrary JSON as empty success', () => {
    expect(() => parsePublisherNews(JSON.stringify({ results: [] }), 'commerce-news-api')).toThrow(
      'layout_unrecognized',
    );
    expect(() =>
      parsePublisherNews(
        JSON.stringify({ data: [commerceRow({ post_date_formatted: null })] }),
        'commerce-news-api',
      ),
    ).toThrow('no_qualified_records');
  });
  it('bounds parsed article records to the first 30 published entries', () => {
    const rows = Array.from({ length: 31 }, (_, i) =>
      commerceRow({ href: `https://www.commerce.gov/news/article-${i}` }),
    );
    const result = parsePublisherNews(JSON.stringify({ data: rows }), 'commerce-news-api');
    expect(result.observedItems).toBe(31);
    expect(result.items).toHaveLength(30);
  });
});

describe('bounded official publisher fetch', () => {
  it('fetches the exact configured endpoint and parses its official body', async () => {
    const fetcher = jest.fn(async () => new Response(dhs(dhsRow())));
    const result = await loadPublisherNews(PUBLISHER_NEWS_FALLBACKS.dhs!, fetcher as typeof fetch);
    expect(result.items).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith(
      'https://www.dhs.gov/news-releases/press-releases',
      expect.objectContaining({ headers: { 'User-Agent': 'Capiro-RSS/1.0' } }),
    );
  });
  it.each(['https://external.example/news', 'http://www.dhs.gov/news'])(
    'rejects unexpected redirect %s',
    async (url) => {
      const response = new Response(dhs(dhsRow()));
      Object.defineProperty(response, 'url', { value: url });
      await expect(
        loadPublisherNews(
          PUBLISHER_NEWS_FALLBACKS.dhs!,
          jest.fn(async () => response) as typeof fetch,
        ),
      ).rejects.toThrow('unexpected_redirect');
    },
  );
  it('rejects an oversized streamed body and cancels its reader', async () => {
    const cancel = jest.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2_000_001));
      },
      cancel,
    });
    const response = new Response(stream);
    await expect(
      loadPublisherNews(
        PUBLISHER_NEWS_FALLBACKS.dhs!,
        jest.fn(async () => response) as typeof fetch,
      ),
    ).rejects.toThrow('byte_limit');
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('does not turn a publisher refusal or missing body into successful empty news', async () => {
    await expect(
      loadPublisherNews(
        PUBLISHER_NEWS_FALLBACKS.dhs!,
        jest.fn(async () => new Response(null, { status: 403 })) as typeof fetch,
      ),
    ).rejects.toThrow('http_403');
    await expect(
      loadPublisherNews(
        PUBLISHER_NEWS_FALLBACKS.dhs!,
        jest.fn(async () => new Response(null)) as typeof fetch,
      ),
    ).rejects.toThrow('body_missing');
  });
});
