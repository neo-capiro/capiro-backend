/**
 * backfill-intel-article-encoding.ts
 *
 * sync-rss-intel.ts's extractText() never decoded HTML entities before this
 * fix, so intel_article rows ingested before it shipped can still carry raw
 * entities in title/summary (e.g. a title with literal "&#8216;", or a
 * summary with literal "&lt;p&gt;President &lt;a href=..."). The parser fix
 * only cleans NEW rows going forward — this backfill re-decodes the fields
 * already sitting in the table using the exact same decodeEntities/
 * stripHtmlTags helpers, so historical rows match what a fresh sync would
 * have produced.
 *
 * Idempotent: only rows whose decoded value actually differs from the stored
 * value are touched, so re-running after a partial commit is safe.
 *
 * Usage: tsx scripts/backfill-intel-article-encoding.ts            # DRY RUN
 *        tsx scripts/backfill-intel-article-encoding.ts --commit    # write
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { decodeEntities, stripHtmlTags } from './sync-rss-intel.js';

export interface ArticleEncodingFix {
  cleanTitle: string;
  cleanSummary: string | null;
  changed: boolean;
}

/** Pure, DB-free: recompute the clean title/summary for one article row. */
export function computeArticleEncodingFix(
  title: string,
  summary: string | null,
): ArticleEncodingFix {
  const cleanTitle = stripHtmlTags(decodeEntities(title));
  const cleanSummary = summary != null ? stripHtmlTags(decodeEntities(summary)) || null : null;
  return {
    cleanTitle,
    cleanSummary,
    changed: cleanTitle !== title || cleanSummary !== summary,
  };
}

async function main(): Promise<void> {
  dotenvConfig();
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/backfill-intel-article-encoding.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const commit = process.argv.includes('--commit');
  const prisma = new PrismaClient();

  let scanned = 0;
  let changed = 0;
  const samples: Array<{ id: string; before: string; after: string }> = [];

  try {
    // Pre-filter with a POSIX regex so we don't drag every row (and its
    // possibly-large summary text) into memory just to find it's already clean.
    const rows = await prisma.$queryRaw<Array<{ id: string; title: string; summary: string | null }>>`
      SELECT id, title, summary FROM intel_article
      WHERE title ~ '&(#x?[0-9a-fA-F]+|[a-zA-Z]+);' OR summary ~ '&(#x?[0-9a-fA-F]+|[a-zA-Z]+);'
    `;

    for (const row of rows) {
      scanned++;
      const fix = computeArticleEncodingFix(row.title, row.summary);
      if (!fix.changed) continue;
      changed++;
      if (samples.length < 10) {
        samples.push({ id: row.id, before: row.title, after: fix.cleanTitle });
      }
      if (commit) {
        await prisma.intelArticle.update({
          where: { id: row.id },
          data: { title: fix.cleanTitle, summary: fix.cleanSummary },
        });
      }
    }

    console.log(`[backfill-intel-article-encoding] mode: ${commit ? 'COMMIT' : 'DRY_RUN'}`);
    console.log(`[backfill-intel-article-encoding] candidates scanned: ${scanned}, changed: ${changed}`);
    for (const s of samples) {
      console.log(`  ${s.id}: "${s.before}" -> "${s.after}"`);
    }
    if (!commit && changed > 0) {
      console.log('[backfill-intel-article-encoding] dry run only — pass --commit to write.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[backfill-intel-article-encoding] FAILED', err);
    process.exit(1);
  });
}
