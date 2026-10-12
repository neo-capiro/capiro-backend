/**
 * Sync RSS feeds from news outlets, agency press, think tanks, committees.
 *   pnpm --filter @capiro/api sync:rss
 * No auth required. Just RSS/Atom feeds.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { NewsEvidenceService, newsHash } from '../src/intelligence/news/news-evidence.service.js';
import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { checkPhase8Sources } from './check-legiwatch-phase8-sources.js';
import { PUBLISHER_NEWS_FALLBACKS, loadPublisherNews } from './lib/publisher-news-fallback.js';
dotenvConfig();

const DELAY_MS = 300;
// Honest, identifying RSS client header. Probe 2026-09-15 18:06 UTC: this
// exact bare token returned 200/10 items from both HHS and USDA in the same
// minute the longer "Capiro-RSS/1.0 (neo@capiro.ai)" form was 403-blocked —
// the parenthesized contact tail is what their WAF pattern-rejects, so the
// identifier stays bare. No browser impersonation, no IP rotation, no auth.
const RSS_USER_AGENT = 'Capiro-RSS/1.0';

export interface RssFeed {
  /** Canonical `intel_article.source` slug — the shared-corpus vocabulary. */
  source: string;
  url: string;
}

/** Qualified current Florida publisher feeds; each keeps its actual feed limit.
 * Only ingested when LEGIWATCH_NEWS_INGEST_ENABLED=true. */
export const FLORIDA_FEEDS: readonly RssFeed[] = [
  { source: 'florida_phoenix', url: 'https://floridaphoenix.com/feed/' },
  { source: 'wusf', url: 'https://www.wusf.org/news.rss' },
  { source: 'florida_daily', url: 'https://floridadaily.com/feed/' },
  { source: 'cbs_miami', url: 'https://www.cbsnews.com/miami/latest/rss/main' },
];

export const CORE_FEEDS: readonly RssFeed[] = [
  // News outlets
  { source: 'roll_call', url: 'https://rollcall.com/feed/' },
  { source: 'the_hill', url: 'https://thehill.com/feed/' },
  { source: 'politico', url: 'https://rss.politico.com/politics-news.xml' },
  { source: 'politico_congress', url: 'https://rss.politico.com/congress.xml' },
  { source: 'axios', url: 'https://api.axios.com/feed/' },
  {
    source: 'reuters_politics',
    url: 'https://www.reutersagency.com/feed/?taxonomy=best-sectors&post_type=best&best-sectors=political-general',
  },
  // Agency press releases (verified May 2026)
  {
    source: 'dod',
    url: 'https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?max=20&ContentType=1',
  },
  { source: 'hhs', url: 'https://www.hhs.gov/rss/news.xml' },
  { source: 'usda', url: 'https://www.usda.gov/rss/latest-releases.xml' },
  {
    source: 'doj',
    url: 'https://www.justice.gov/feeds/justice-news.xml?type=All&component%5B436%5D=436&organization=All',
  },
  { source: 'state_dept', url: 'https://www.state.gov/rss-feed/press-releases/feed/' },
  { source: 'commerce', url: 'https://www.commerce.gov/feeds/news' },
  { source: 'va', url: 'https://news.va.gov/feed/' },
  // Fixed URLs (old ones returned 404, these verified working)
  { source: 'doe', url: 'https://www.energy.gov/rss.xml' },
  { source: 'dhs', url: 'https://www.dhs.gov/rss.xml' },
  { source: 'heritage', url: 'https://www.heritage.org/rss' },
  { source: 'urban', url: 'https://www.urban.org/research/rss.xml' },
  { source: 'cato', url: 'https://www.cato.org/rss/recent-opeds' },
  // Think tanks
  { source: 'brookings', url: 'https://www.brookings.edu/feed/' },
  { source: 'aei', url: 'https://www.aei.org/feed/' },
  { source: 'bipartisan_policy', url: 'https://bipartisanpolicy.org/feed/' },
  // Removed (dead/404/WAF-blocked, no working alternative found):
  // whitehouse.gov, treasury, epa, sba, dot, cap, rand, cfr, third_way
];

/** Every feed this script has ever been configured to write, regardless of
 * env gating — the complete feed_url → source slug map used by backfills. */
export const ALL_FEEDS: readonly RssFeed[] = [...FLORIDA_FEEDS, ...CORE_FEEDS];

const FEEDS: readonly RssFeed[] =
  process.env.LEGIWATCH_NEWS_INGEST_ENABLED === 'true' ? ALL_FEEDS : CORE_FEEDS;

// RSS/Atom fields commonly arrive HTML-entity-escaped (named entities like
// &amp;/&lt;/&gt;, and numeric character references like &#8216; or &#x2019;
// for smart quotes). A field such as <description> is frequently itself
// escaped markup (e.g. "&lt;p&gt;President &lt;a href=...&gt;...") — decoding
// must happen BEFORE tag-stripping, otherwise the escaped tags never match
// the strip regex and survive as literal entity text in stored data.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const isHex = entity[1]?.toLowerCase() === 'x';
      const codePoint = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function stripHtmlTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractText(xml: string, tag: string): string | null {
  const cdataMatch = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[(.+?)\\]\\]><\/${tag}>`, 's'));
  const plainMatch = cdataMatch ? null : xml.match(new RegExp(`<${tag}>(.+?)<\/${tag}>`, 's'));
  const raw = cdataMatch?.[1] ?? plainMatch?.[1];
  if (raw == null) return null;
  const clean = stripHtmlTags(decodeEntities(raw));
  return clean || null;
}

export function extractCategories(item: string): string[] {
  const matches = [...item.matchAll(/<category[^>]*>(?:<!\[CDATA\[)?(.+?)(?:\]\]>)?<\/category>/g)];
  return matches
    .map((m) => decodeEntities(m[1] ?? '').trim())
    .filter(Boolean)
    .slice(0, 10);
}

function safeDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/** Clock-skew allowance before a feed's pubDate is treated as bogus. */
export const FUTURE_PUBLISHED_TOLERANCE_MS = 60 * 60 * 1000;

/**
 * Feed publication instant, or null when the feed gave none, an unparseable
 * one, or one in the future. The shared corpus sorts by published_at desc, so
 * a future-dated item (observed live 2026-09-16: a DOJ release stamped six
 * weeks ahead) pins itself to the top of every Dashboard Wire and Explorer
 * News list until that date passes. Null lets the caller fall back to the
 * sync instant, which is the honest "first seen" time.
 */
export function publishedAtFor(
  pubDate: string | null | undefined,
  now: Date = new Date(),
): Date | null {
  const parsed = safeDate(pubDate);
  if (!parsed) return null;
  return parsed.getTime() > now.getTime() + FUTURE_PUBLISHED_TOLERANCE_MS ? null : parsed;
}

export interface ParsedFeedItem {
  url: string;
  title: string;
  description: string | null;
  pubDate: string | null;
  author: string | null;
  categories: string[];
  publicationPrecision?: 'day';
}

/**
 * NewsEvidenceService.retain() input for one feed item. `source` is the feed's
 * canonical slug (what Dashboard/Explorer source filters, saved preferences and
 * outlet marks are keyed on); `publisher` is the article hostname kept for the
 * LegiWatch observation ledger. Passing only `publisher` made retain() store
 * hostnames in intel_article.source and emptied every saved source filter.
 */
export function retainInputFor(
  feed: RssFeed,
  item: ParsedFeedItem,
  now: Date = new Date(),
  provider = 'rss',
) {
  const publishedAt = publishedAtFor(item.pubDate, now);
  return {
    provider,
    providerId: item.url,
    url: item.url,
    source: feed.source,
    publisher: new URL(item.url).hostname,
    title: item.title,
    summary: item.description,
    publishedAt:
      item.publicationPrecision === 'day' && publishedAt
        ? item.pubDate!
        : publishedAt?.toISOString(),
    ...(item.publicationPrecision === 'day' && publishedAt
      ? { publicationPrecision: 'day' as const }
      : {}),
    author: item.author,
    feedUrl: feed.url,
    categories: item.categories,
    rights: 'excerpt' as const,
  };
}

export async function retainFailedFeed(prisma: PrismaClient, feed: RssFeed, failure: string) {
  if (process.env.LEGIWATCH_NEWS_INGEST_ENABLED !== 'true') return;
  const observedAt = new Date().toISOString(),
    manifest = {
      observedAt,
      status: 'failed',
      reason: failure.slice(0, 500),
      history: 'unqualified',
    };
  await prisma.$executeRaw`INSERT INTO legiwatch_source_receipt(id,source,source_url,content_hash,scope,manifest,complete) VALUES(${newsHash([feed.url, observedAt])},'rss',${feed.url},${newsHash(['failed', observedAt])},${JSON.stringify({ publisher: feed.source, domain: new URL(feed.url).hostname })}::jsonb,${JSON.stringify(manifest)}::jsonb,false)`;
}

export async function loadConfiguredFeed(feed: RssFeed, fetcher: typeof fetch = fetch) {
  let primaryFailure: string | null = null;
  try {
    const response = await fetcher(feed.url, {
      headers: { 'User-Agent': RSS_USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`rss_http_${response.status}`);
    const body = await response.text();
    // A retired feed may redirect to a publisher's HTML homepage. Preserve that
    // transport result rather than reporting incidental HTML entities as bad XML.
    // Inspect only the document root: HTML inside feed CDATA is legitimate.
    const root = body
      .replace(/^\uFEFF/, '')
      .trimStart()
      .replace(/^<\?xml[^?]*\?>\s*/i, '')
      .replace(/^(?:<!--[\s\S]*?-->\s*)*/, '');
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (
      /^(?:<!doctype\s+html\b|<html(?:\s|>))/i.test(root) ||
      (['text/html', 'application/xhtml+xml'].includes(contentType ?? '') &&
        !/^<(?:rss|feed|rdf:RDF)(?:\s|>)/i.test(root))
    ) {
      throw new Error(
        response.redirected ? 'rss_html_response_after_redirect' : 'rss_html_response',
      );
    }
    if (
      contentType &&
      /^(?:application\/(?:json|pdf)|text\/json|image\/|audio\/|video\/)/.test(contentType)
    ) {
      throw new Error(`rss_unexpected_content_type: ${contentType}`);
    }
    const error = validateFeedXml(body);
    if (error) throw new Error(`rss_invalid_feed: ${error}`);
    const rssItems = body.split(/<item[ >]/).slice(1),
      entries = rssItems.length ? rssItems : body.split(/<entry[ >]/).slice(1);
    const items: ParsedFeedItem[] = [];
    let rejected = 0;
    for (const entry of entries.slice(0, 30)) {
      const title = extractText(entry, 'title'),
        link = extractText(entry, 'link') || entry.match(/href="([^"]+)"/)?.[1];
      if (!title || !link) {
        rejected++;
        continue;
      }
      items.push({
        title,
        url: link.startsWith('http') ? link : `https://${link}`,
        pubDate:
          extractText(entry, 'pubDate') ||
          extractText(entry, 'published') ||
          extractText(entry, 'updated'),
        description:
          extractText(entry, 'description') ||
          extractText(entry, 'summary') ||
          extractText(entry, 'content'),
        author: extractText(entry, 'author') || extractText(entry, 'dc:creator'),
        categories: extractCategories(entry),
      });
    }
    return {
      body,
      items,
      rejected,
      observedItems: entries.length,
      provider: 'rss',
      sourceUrl: feed.url,
      primaryFailure,
    };
  } catch (error) {
    primaryFailure = (error as Error).message;
  }
  const fallback =
    process.env.LEGIWATCH_NEWS_INGEST_ENABLED === 'true'
      ? PUBLISHER_NEWS_FALLBACKS[feed.source]
      : undefined;
  // Never use another route to evade a publisher rate limit. Only the two
  // reviewed public publisher interfaces are configured; no guessed URLs.
  if (!fallback || primaryFailure === 'rss_http_429') throw new Error(primaryFailure);
  try {
    return {
      ...(await loadPublisherNews(fallback, fetcher)),
      provider: fallback.kind,
      sourceUrl: fallback.url,
      primaryFailure,
    };
  } catch (error) {
    throw new Error(`${primaryFailure}; ${(error as Error).message}`);
  }
}

/**
 * Structural gate: the response body must actually BE an RSS/Atom/RDF feed,
 * not just an HTTP 200 — a 200 HTML challenge/soft-404 page was previously
 * accepted as "success, 0 items", reporting false source health. The body is
 * validated as one complete XML document: the previous 256KB prefix-trim
 * rejected any valid feed larger than 256KB as "unclosed" (a real 280161-byte
 * RSS body failed exactly that way), so validation now runs on the full body
 * with no size cap. Requires the document root to be a recognized feed root
 * (<rss>, <feed>, or RDF in either spelling — prefixed <rdf:RDF> or
 * default-namespace <RDF>); Content-Type is deliberately not checked (valid
 * feeds are served text/plain). The feed bodies handled here are far smaller
 * than memory, so whole-document validation costs nothing extra in practice.
 */
const FEED_ROOT_TAGS = new Set(['rss', 'feed', 'rdf:RDF', 'RDF']);

export function validateFeedXml(xml: string): string | null {
  const valid = XMLValidator.validate(xml);
  if (valid !== true) return valid.err.msg;
  const parsed = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
    ignoreDeclaration: true,
  }).parse(xml);
  const root = Object.keys(parsed).find((k) => !k.startsWith('?') && !k.startsWith('!'));
  if (!root || !FEED_ROOT_TAGS.has(root)) {
    return `unrecognized document root <${root ?? 'none'}> — not an RSS/Atom/RDF feed`;
  }
  return null;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/sync-rss-intel.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  const t0 = Date.now();
  console.log('[rss-sync] starting');

  let totalArticles = 0;
  let feedsProcessed = 0;
  let feedsFailed = 0;

  for (const feed of FEEDS) {
    await new Promise((r) => setTimeout(r, DELAY_MS));
    try {
      const loaded = await loadConfiguredFeed(feed),
        xml = loaded.body;
      if (loaded.primaryFailure) {
        await retainFailedFeed(prisma, feed, loaded.primaryFailure);
        console.warn(
          `[rss-sync] ${feed.source} primary failed: ${loaded.primaryFailure}; using ${loaded.provider}`,
        );
      }
      let feedCount = 0,
        rejected = loaded.rejected;

      for (const item of loaded.items) {
        // max 30 per feed
        const { title, url, pubDate, description, author } = item;

        try {
          if (process.env.LEGIWATCH_NEWS_INGEST_ENABLED === 'true') {
            await new NewsEvidenceService(prisma as never).retain(
              retainInputFor({ ...feed, url: loaded.sourceUrl }, item, new Date(), loaded.provider),
            );
          } else
            await (prisma as any).intelArticle.upsert({
              where: { url },
              update: { title, summary: description?.slice(0, 5000) || null, syncedAt: new Date() },
              create: {
                source: feed.source,
                feedUrl: feed.url,
                title,
                url,
                author: author?.slice(0, 200) || null,
                publishedAt: publishedAtFor(pubDate) || new Date(),
                summary: description?.slice(0, 5000) || null,
                categories: item.categories,
              },
            });
          feedCount++;
          totalArticles++;
        } catch {
          rejected++;
        }
      }

      if (process.env.LEGIWATCH_NEWS_INGEST_ENABLED === 'true') {
        const observedAt = new Date().toISOString(),
          contentHash = createHash('sha256').update(xml).digest('hex'),
          id = newsHash([loaded.sourceUrl, contentHash, observedAt]);
        const manifest = {
          observedAt,
          items: loaded.observedItems,
          retained: feedCount,
          rejected,
          pageLimit: 30,
          history: 'unqualified',
          coverage: 'current_feed_only',
          status: rejected ? 'partial' : 'retained',
          provider: loaded.provider,
          primarySourceUrl: feed.url,
          ...(loaded.primaryFailure
            ? { primaryFailure: loaded.primaryFailure, coverage: 'current_publisher_index_only' }
            : {}),
        };
        await prisma.$executeRaw`INSERT INTO legiwatch_source_receipt(id,source,source_url,content_hash,scope,manifest,complete) VALUES(${id},${loaded.provider === 'rss' ? 'rss' : 'publisher-news'},${loaded.sourceUrl},${contentHash},${JSON.stringify({ publisher: feed.source, domain: new URL(loaded.sourceUrl).hostname })}::jsonb,${JSON.stringify(manifest)}::jsonb,false) ON CONFLICT DO NOTHING`;
      }
      if (feedCount > 0) console.log(`[rss-sync] ${feed.source}: ${feedCount} articles`);
      if (rejected) {
        feedsFailed++;
        console.warn(
          `[rss-sync] ${feed.source} partial: ${feedCount} retained, ${rejected} rejected`,
        );
      } else feedsProcessed++;
    } catch (err) {
      console.warn(`[rss-sync] ${feed.source} failed: ${(err as Error).message}`);
      await retainFailedFeed(prisma, feed, (err as Error).message);
      feedsFailed++;
    }
  }

  console.log(`[rss-sync] feeds: ${feedsProcessed} ok, ${feedsFailed} failed`);
  console.log(`[rss-sync] total: ${totalArticles} articles`);
  console.log(`[rss-sync] DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log('[rss-sync] phase8-refresh ' + JSON.stringify(await checkPhase8Sources(prisma)));
  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[rss-sync] FAILED', err);
    process.exit(1);
  });
}
