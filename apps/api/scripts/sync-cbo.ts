/**
 * CBO cost-estimate discovery from the all-publications RSS feed
 * (Bucket-#3 C4.F2, SC2.4). Daily freshness layer on top of the
 * congress-api spine (C4.F1 in sync-congress): the RSS surfaces new
 * estimates the moment CBO publishes them, hours-to-days before the
 * bill's Congress.gov detail record picks them up.
 *
 * HARD CONSTRAINT (counsel + verified WAF behavior): cbo.gov HTML pages
 * and PDFs block server-side fetches (TLS fingerprinting). This job
 * touches ONLY the RSS feed endpoint — one request per run. Never add
 * publication-page or PDF fetches here.
 *
 * Cost-estimate items are titled with the bill designation ("H.R. 5999,
 * Veteran Opioid Emergency Treatment Act"); items whose title prefix does
 * not parse as a bill (outlooks, reports, presentations) are skipped —
 * they are not bill cost estimates. Congress is inferred from pubDate
 * (the feed only carries current-congress publications).
 *
 *   pnpm --filter @capiro/api exec tsx scripts/sync-cbo.ts
 * Env: CBO_RSS_URL (default https://www.cbo.gov/publications/all/rss.xml).
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { parseBillDesignation, formatBillId } from '@capiro/shared';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
dotenvConfig();

const prisma = new PrismaClient();
const RSS_URL = process.env.CBO_RSS_URL ?? 'https://www.cbo.gov/publications/all/rss.xml';

function extractText(xml: string, tag: string): string | null {
  const cdataMatch = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[(.+?)\\]\\]><\/${tag}>`, 's'));
  if (cdataMatch?.[1]) return cdataMatch[1].trim();
  const plainMatch = xml.match(new RegExp(`<${tag}>(.+?)<\/${tag}>`, 's'));
  return plainMatch?.[1]?.trim() ?? null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** Congress in session for a given date (119th = 2025-2026, ...). */
export function congressForDate(d: Date): number {
  return Math.floor((d.getUTCFullYear() - 1789) / 2) + 1;
}

export interface ParsedCboItem {
  publicationId: string;
  billId: string | null;
  congress: number;
  billType: string;
  billNumber: string;
  title: string;
  description: string | null;
  pubDate: Date;
  cboUrl: string;
}

/**
 * Parse one RSS <item> body into a cost-estimate row. Null when the item
 * is not a bill cost estimate (no publication id, bad date, or a title
 * that doesn't lead with a bill designation).
 */
export function parseCboRssItem(item: string): ParsedCboItem | null {
  const title = decodeEntities(extractText(item, 'title') ?? '');
  const link = extractText(item, 'link') ?? '';
  const pubDateRaw = extractText(item, 'pubDate');
  const description = decodeEntities(extractText(item, 'description') ?? '');

  const pubIdMatch = link.match(/publication\/(\d+)/);
  const pubDate = pubDateRaw ? new Date(pubDateRaw) : null;
  if (!pubIdMatch?.[1] || !pubDate || Number.isNaN(pubDate.getTime())) return null;

  // Cost estimates lead with the bill designation; take the prefix
  // before the first comma ("H.R. 5999, Veteran ..." -> "H.R. 5999").
  const designation = title.split(',')[0] ?? '';
  const parsed = parseBillDesignation(designation, congressForDate(pubDate));
  if (!parsed) return null; // outlook/report/presentation — not a cost estimate

  return {
    publicationId: pubIdMatch[1],
    billId: formatBillId(parsed.congress, parsed.type, parsed.number),
    congress: parsed.congress,
    billType: parsed.type,
    billNumber: String(parsed.number),
    title,
    description: description || null,
    pubDate,
    cboUrl: link,
  };
}

async function main() {
  await runWithSyncRun(prisma as never, 'sync-cbo', async () => {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    const res = await fetch(RSS_URL, { headers: { accept: 'application/rss+xml, text/xml' } });
    if (!res.ok) throw new Error(`CBO RSS fetch failed: HTTP ${res.status}`);
    const xml = await res.text();
    const items = xml.split(/<item[ >]/).slice(1);
    console.log(`[sync-cbo] feed items: ${items.length}`);

    for (const item of items) {
      const est = parseCboRssItem(item);
      if (!est) {
        skipped++;
        continue;
      }

      try {
        const existing = await prisma.cboCostEstimate.findUnique({
          where: { id: est.publicationId },
          select: { id: true },
        });
        if (existing) {
          // congress-api rows are authoritative for bill linkage; the RSS
          // only refreshes narrative fields it may have seen earlier.
          await prisma.cboCostEstimate.update({
            where: { id: est.publicationId },
            data: {
              title: est.title,
              description: est.description,
              pubDate: est.pubDate,
              lastSyncedAt: new Date(),
            },
          });
          updated++;
        } else {
          await prisma.cboCostEstimate.create({
            data: {
              id: est.publicationId,
              billId: est.billId,
              congress: est.congress,
              billType: est.billType,
              billNumber: est.billNumber,
              title: est.title,
              description: est.description,
              pubDate: est.pubDate,
              cboUrl: est.cboUrl,
              source: 'cbo-rss',
            },
          });
          inserted++;
        }
      } catch (err) {
        errors++;
        console.error(`[sync-cbo] upsert failed publication ${est.publicationId}:`, err);
      }
    }

    return { inserted, updated, skipped, errors };
  });
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
