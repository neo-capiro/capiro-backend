/**
 * Sync GAO (Government Accountability Office) reports.
 *   pnpm --filter @capiro/api sync:gao
 * Source: gao.gov RSS + API
 * No auth required.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
dotenvConfig();

const GAO_RSS = 'https://www.gao.gov/rss/reports.xml';
const DELAY_MS = 500;

function safeDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function extractReportNumber(url: string): string | null {
  const match = url.match(/\/(GAO-\d{2}-\d+)/i) || url.match(/\/(gao-\d{2}-\d+)/i);
  return match ? match[1].toUpperCase() : null;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/sync-gao.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  const t0 = Date.now();
  console.log('[gao-sync] starting');

  try {
    await runWithSyncRun(prisma as any, 'sync-gao', async () => {
    const resp = await fetch(GAO_RSS);
    if (!resp.ok) throw new Error(`RSS HTTP ${resp.status}`);
    const xml = await resp.text();

    // Simple XML parsing (RSS items)
    const items = xml.split('<item>').slice(1);
    let total = 0;

    for (const item of items) {
      const titleMatch = item.match(/<title><!\[CDATA\[(.+?)\]\]><\/title>/s) || item.match(/<title>(.+?)<\/title>/s);
      const linkMatch = item.match(/<link>(.+?)<\/link>/);
      const descMatch = item.match(/<description><!\[CDATA\[(.+?)\]\]><\/description>/s) || item.match(/<description>(.+?)<\/description>/s);
      const dateMatch = item.match(/<pubDate>(.+?)<\/pubDate>/);
      const catMatches = [...item.matchAll(/<category><!\[CDATA\[(.+?)\]\]><\/category>/g)];

      const url = linkMatch?.[1]?.trim();
      if (!url) continue;

      const reportNum = extractReportNumber(url);
      const id = reportNum || `gao-${Buffer.from(url).toString('base64').slice(0, 20)}`;

      await (prisma as any).gaoReport.upsert({
        where: { id },
        update: {
          title: titleMatch?.[1]?.trim() || 'Untitled',
          url,
          publishDate: safeDate(dateMatch?.[1]),
          summary: descMatch?.[1]?.replace(/<[^>]+>/g, '').trim().slice(0, 5000) || null,
          topics: catMatches.map(m => m[1]).filter(Boolean),
          syncedAt: new Date(),
        },
        create: {
          id,
          title: titleMatch?.[1]?.trim() || 'Untitled',
          url,
          publishDate: safeDate(dateMatch?.[1]),
          summary: descMatch?.[1]?.replace(/<[^>]+>/g, '').trim().slice(0, 5000) || null,
          topics: catMatches.map(m => m[1]).filter(Boolean),
        },
      });
      total++;
    }

    console.log(`[gao-sync] total: ${total} reports`);
    console.log(`[gao-sync] DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return { inserted: 0, updated: total, skipped: 0, errors: 0 };
    });
  } finally { await prisma.$disconnect(); }
}

if (require.main === module) {
main().catch((err) => { console.error('[gao-sync] FAILED', err); process.exit(1); });
}