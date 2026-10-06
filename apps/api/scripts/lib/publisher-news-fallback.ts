import { load } from 'cheerio';
import type { ParsedFeedItem } from '../sync-rss-intel.js';

export type PublisherNewsFallback = {
  kind: 'dhs-press-index' | 'commerce-news-api';
  url: string;
};
export const PUBLISHER_NEWS_FALLBACKS: Record<string, PublisherNewsFallback> = {
  dhs: { kind: 'dhs-press-index', url: 'https://www.dhs.gov/news-releases/press-releases' },
  commerce: {
    kind: 'commerce-news-api',
    // Public demonstration key documented by Commerce; one bounded request per
    // hourly RSS run. Do not follow its pagination links or claim full history.
    url: 'https://api.commerce.gov/api/news?api_key=DEMO_KEY&sort=-created&page%5Blimit%5D=30',
  },
};

function articleUrl(value: unknown, origin: string): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value, origin);
    return url.protocol === 'https:' && url.hostname === new URL(origin).hostname &&
      !url.username && !url.password && url.pathname.startsWith('/news/') ? url.href : null;
  } catch { return null; }
}

function validDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function parsePublisherNews(body: string, kind: PublisherNewsFallback['kind']) {
  const items: ParsedFeedItem[] = [], seen = new Set<string>();
  let rejected = 0, observedItems = 0;
  if (kind === 'dhs-press-index') {
    const $ = load(body), rows = $('.view-id-news_events .usa-collection__item');
    if (!rows.length) throw new Error('publisher_news_layout_unrecognized');
    observedItems = rows.length;
    rows.slice(0, 30).each((_, row) => {
      const heading = $(row).find('.usa-collection__heading a'),
        url = articleUrl(heading.attr('href'), 'https://www.dhs.gov'),
        title = heading.text().replace(/\s+/g, ' ').trim(),
        day = $(row).find('time[datetime]').attr('datetime') ?? '';
      // A day belongs to this article only when the publisher's dated URL and
      // calendar agree. Retain day precision, never invent a release time.
      if (!url || !title || title.length > 2000 || !validDay(day) ||
          !new URL(url).pathname.startsWith('/news/' + day.replaceAll('-', '/') + '/')) {
        rejected++; return;
      }
      if (seen.has(url)) return;
      seen.add(url);
      items.push({ url, title, pubDate: day, publicationPrecision: 'day',
        description: $(row).find('.usa-collection__body p').text().replace(/\s+/g, ' ').trim() || null,
        author: null, categories: [] });
    });
  } else {
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed.data)) throw new Error('publisher_news_layout_unrecognized');
    observedItems = parsed.data.length;
    for (const row of parsed.data.slice(0, 30)) {
      const url = articleUrl(row?.href, 'https://www.commerce.gov'),
        title = typeof row?.label === 'string' ? row.label.trim() : '',
        pubDate = row?.post_date_formatted;
      if (row?.type !== 'news' || !url || !title || title.length > 2000 ||
          typeof pubDate !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(pubDate) ||
          !validDay(pubDate.slice(0, 10)) || !Number.isFinite(Date.parse(pubDate))) { rejected++; continue; }
      if (seen.has(url)) continue;
      seen.add(url);
      // API creation/updated timestamps are not publication evidence. Use the
      // documented publication field; keep headline/excerpt rights only.
      items.push({ url, title, pubDate, description: null, author: null,
        categories: Array.isArray(row.news_type) ? row.news_type.filter((v: any) => typeof v?.label === 'string').map((v: any) => v.label).slice(0, 10) : [] });
    }
  }
  if (observedItems && !items.length) throw new Error('publisher_news_no_qualified_records');
  return { items, rejected, observedItems };
}

export async function loadPublisherNews(
  fallback: PublisherNewsFallback, fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(fallback.url, {
    headers: { 'User-Agent': 'Capiro-RSS/1.0' }, signal: AbortSignal.timeout(20_000),
  });
  const expectedHost = new URL(fallback.url).hostname;
  if (!response.ok) throw new Error(`publisher_news_http_${response.status}`);
  if (response.url && (new URL(response.url).protocol !== 'https:' || new URL(response.url).hostname !== expectedHost))
    throw new Error('publisher_news_unexpected_redirect');
  if (!response.body) throw new Error('publisher_news_body_missing');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 2_000_000) throw new Error('publisher_news_byte_limit');
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); }
  const body = Buffer.concat(chunks).toString('utf8');
  return { body, ...parsePublisherNews(body, fallback.kind) };
}
