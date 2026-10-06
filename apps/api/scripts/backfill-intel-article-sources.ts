/**
 * backfill-intel-article-sources.ts
 *
 * Between 2026-09-04 and 2026-09-16 sync-rss-intel.ts's LegiWatch path
 * (LEGIWATCH_NEWS_INGEST_ENABLED=true → NewsEvidenceService.retain()) wrote the
 * article's publisher HOSTNAME into intel_article.source (`thehill.com`,
 * `www.politico.com`, `www.war.gov`, `ndupress.ndu.edu`, …) instead of the
 * feed's canonical slug (`the_hill`, `politico_congress`, `dod`). Every saved
 * Dashboard Wire / Data Explorer source filter is keyed on the slug, so the
 * shared news feed matched zero rows and rendered "No stories match these
 * subscriptions" while the corpus was full. The ingestion fix only labels NEW
 * rows correctly — this backfill relabels the rows already in the table.
 *
 * Authority for the relabel is `feed_url` → slug from the feed list itself
 * (ALL_FEEDS), which is exact: a row's feed_url says which feed wrote it. Rows
 * with no feed_url fall back to the publisher-hostname alias map and are only
 * touched when the hostname maps to exactly one slug.
 *
 * Also clamps future-dated rows (a DOJ item stamped six weeks ahead pinned
 * itself to the top of every news list) back to their synced_at instant, the
 * same fallback the fixed ingestion applies.
 *
 * Idempotent: only rows whose source/published_at would actually change are
 * touched, so re-running after a partial commit is safe.
 *
 * Usage: tsx scripts/backfill-intel-article-sources.ts            # DRY RUN
 *        tsx scripts/backfill-intel-article-sources.ts --commit    # write
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { ALL_FEEDS, FUTURE_PUBLISHED_TOLERANCE_MS, type RssFeed } from './sync-rss-intel.js';
import { sourceSlugsForHost } from '../src/explorer/news-semantic-matching.js';
import { PUBLISHER_NEWS_FALLBACKS } from './lib/publisher-news-fallback.js';

/** Pure: feed_url → canonical slug. The sole authority for relabelling. */
export function feedSlugMap(feeds: readonly RssFeed[] = ALL_FEEDS): Map<string, string> {
  const map = new Map<string, string>();
  for (const feed of feeds) {
    for (const url of [feed.url, PUBLISHER_NEWS_FALLBACKS[feed.source]?.url].filter((v): v is string => !!v)) {
      const existing = map.get(url);
      if (existing && existing !== feed.source) {
        throw new Error(`feed_url ${url} maps to both ${existing} and ${feed.source}`);
      }
      map.set(url, feed.source);
    }
  }
  return map;
}

/**
 * Pure: slug for a row that has no feed_url, or null when the hostname is
 * unknown or ambiguous (politico.com serves two feeds), in which case the row
 * is reported and left alone rather than guessed.
 */
export function slugForOrphanSource(source: string): string | null {
  const slugs = sourceSlugsForHost(source);
  return slugs.length === 1 ? slugs[0]! : null;
}

/** A stored source is a hostname (mislabelled) when it contains a dot. */
export function looksLikeHostname(source: string): boolean {
  return source.includes('.');
}

interface MislabelledRow {
  feed_url: string | null;
  source: string;
  n: bigint;
}

async function main() {
  dotenvConfig();
  const commit = process.argv.includes('--commit');
  const prisma = new PrismaClient();
  const slugByFeed = feedSlugMap();
  const toleranceSeconds = Math.floor(FUTURE_PUBLISHED_TOLERANCE_MS / 1000);

  const mislabelled = await prisma.$queryRaw<MislabelledRow[]>`
    SELECT feed_url, source, count(*)::bigint AS n
    FROM intel_article
    WHERE source LIKE '%.%'
    GROUP BY 1, 2
    ORDER BY n DESC`;

  const byFeed: Array<{ feedUrl: string; slug: string; rows: number; from: string[] }> = [];
  const orphans: Array<{ source: string; slug: string | null; rows: number }> = [];
  const unknownFeeds: Array<{ feedUrl: string; source: string; rows: number }> = [];

  for (const row of mislabelled) {
    const rows = Number(row.n);
    if (row.feed_url) {
      const slug = slugByFeed.get(row.feed_url);
      if (!slug) {
        unknownFeeds.push({ feedUrl: row.feed_url, source: row.source, rows });
        continue;
      }
      const entry = byFeed.find((item) => item.feedUrl === row.feed_url);
      if (entry) {
        entry.rows += rows;
        entry.from.push(row.source);
      } else {
        byFeed.push({ feedUrl: row.feed_url, slug, rows, from: [row.source] });
      }
    } else {
      orphans.push({ source: row.source, slug: slugForOrphanSource(row.source), rows });
    }
  }

  const future = await prisma.$queryRaw<
    Array<{ id: string; source: string; title: string; published_at: Date; synced_at: Date }>
  >`
    SELECT id, source, left(title, 120) AS title, published_at, synced_at
    FROM intel_article
    WHERE published_at > now() + make_interval(secs => ${toleranceSeconds})
    ORDER BY published_at DESC`;

  console.log(`[backfill-intel-article-sources] mode: ${commit ? 'COMMIT' : 'DRY RUN'}`);
  console.log(
    `[backfill-intel-article-sources] relabel by feed_url: ${byFeed.length} feeds, ${byFeed.reduce((sum, item) => sum + item.rows, 0)} rows`,
  );
  for (const item of byFeed)
    console.log(`  ${item.slug} ← ${item.from.join(', ')} (${item.rows}) via ${item.feedUrl}`);
  console.log(
    `[backfill-intel-article-sources] orphan hostname rows (no feed_url): ${orphans.length}`,
  );
  for (const item of orphans)
    console.log(`  ${item.source} → ${item.slug ?? 'AMBIGUOUS/UNKNOWN, skipped'} (${item.rows})`);
  console.log(
    `[backfill-intel-article-sources] hostname rows on feeds this script does not know: ${unknownFeeds.length}`,
  );
  for (const item of unknownFeeds)
    console.log(`  ${item.source} (${item.rows}) via ${item.feedUrl} — skipped`);
  console.log(
    `[backfill-intel-article-sources] future-dated rows (> now + ${toleranceSeconds}s): ${future.length}`,
  );
  for (const item of future)
    console.log(
      `  ${item.id} ${item.source} "${item.title}" published_at=${item.published_at.toISOString()} → synced_at=${item.synced_at.toISOString()}`,
    );

  if (!commit) {
    console.log('[backfill-intel-article-sources] dry run only — pass --commit to write');
    await prisma.$disconnect();
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    let relabelled = 0;
    for (const item of byFeed) {
      relabelled += await tx.$executeRaw`
        UPDATE intel_article SET source = ${item.slug}
        WHERE feed_url = ${item.feedUrl} AND source <> ${item.slug}`;
    }
    let orphansRelabelled = 0;
    for (const item of orphans) {
      if (!item.slug) continue;
      orphansRelabelled += await tx.$executeRaw`
        UPDATE intel_article SET source = ${item.slug}
        WHERE feed_url IS NULL AND source = ${item.source}`;
    }
    const clamped = await tx.$executeRaw`
      UPDATE intel_article SET published_at = synced_at
      WHERE published_at > now() + make_interval(secs => ${toleranceSeconds})`;
    return { relabelled, orphansRelabelled, clamped };
  });

  const remaining = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*)::bigint AS n FROM intel_article WHERE source LIKE '%.%'`;
  console.log(
    `[backfill-intel-article-sources] DONE ${JSON.stringify({
      ...result,
      hostnameRowsRemaining: Number(remaining[0]?.n ?? 0),
    })}`,
  );
  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[backfill-intel-article-sources] FAILED', err);
    process.exit(1);
  });
}
