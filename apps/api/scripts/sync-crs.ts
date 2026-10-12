/**
 * Sync CRS (Congressional Research Service) reports.
 *   pnpm --filter @capiro/api sync:crs
 * Source: Congress.gov API v3 /crsreport endpoint (primary)
 *         EveryCRSReport.com all-reports HTML index (fallback)
 * Auth: CONGRESS_API_KEY (free, same key as sync-congress.ts)
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
dotenvConfig();

const CONGRESS_BASE = 'https://api.congress.gov/v3';
const CONGRESS_API_KEY = process.env.CONGRESS_API_KEY ?? '';
const EVERYCRS_ALL_REPORTS_URL = 'https://www.everycrsreport.com/all-reports.html';
const DELAY_MS = 500;

function safeDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

interface CRSReport {
  id: string;
  title: string;
  date: Date | null;
  authors: string[];
  topics: string[];
  summary: string | null;
  pdfUrl: string | null;
  htmlUrl: string | null;
}

async function fetchFromCongressAPI(): Promise<CRSReport[]> {
  if (!CONGRESS_API_KEY) {
    console.warn('[crs-sync] no CONGRESS_API_KEY, skipping Congress.gov API');
    return [];
  }
  console.log('[crs-sync] trying Congress.gov API...');
  const reports: CRSReport[] = [];
  let offset = 0;

  for (let page = 0; page < 50; page++) {
    await new Promise((r) => setTimeout(r, DELAY_MS));
    try {
      const url = `${CONGRESS_BASE}/crsreport?api_key=${CONGRESS_API_KEY}&format=json&limit=100&offset=${offset}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        console.warn(`[crs-sync] Congress API HTTP ${resp.status}`);
        break;
      }
      const data = await resp.json() as any;
      const items = data?.crsReports ?? data?.reports ?? [];
      if (!items.length) break;

      for (const r of items) {
        const id = r.number || r.id;
        if (!id) continue;
        reports.push({
          id,
          title: r.title || 'Untitled',
          date: safeDate(r.latestUpdateDate || r.publishDate || r.date),
          authors: (r.authors || []).map((a: any) => a.name || String(a)).filter(Boolean),
          topics: r.topics || r.subjects || [],
          summary: r.summary?.slice(0, 10000) || null,
          pdfUrl: r.pdfUrl || null,
          htmlUrl: r.htmlUrl || `https://crsreports.congress.gov/product/details?prodcode=${id}`,
        });
      }
      offset += 100;
      console.log(`[crs-sync] Congress API page ${page + 1}: ${items.length} reports (total: ${reports.length})`);
      if (items.length < 100) break;
    } catch (err) {
      console.warn(`[crs-sync] Congress API error: ${(err as Error).message}`);
      break;
    }
  }
  return reports;
}

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '–');
}

function stripTags(text: string): string {
  return decodeHtml(text.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

async function fetchFromEveryCRS(): Promise<CRSReport[]> {
  console.log('[crs-sync] trying EveryCRSReport.com...');
  try {
    const resp = await fetch(EVERYCRS_ALL_REPORTS_URL, {
      headers: { 'User-Agent': 'Capiro/1.0 (neo@capiro.ai)' },
      signal: AbortSignal.timeout(45000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();

    const reportsById = new Map<string, CRSReport>();
    const blockRegex = /<div class="crs-report">([\s\S]*?)<\/div>/g;
    let match: RegExpExecArray | null;

    while ((match = blockRegex.exec(html)) !== null) {
      const block = match[1] ?? '';
      const titleMatch = block.match(/<p class="report-title">\s*<a href="([^"]+)">([\s\S]*?)<\/a>\s*<\/p>/);
      if (!titleMatch) continue;

      const href = titleMatch[1] ?? '';
      const title = stripTags(titleMatch[2] ?? '') || 'Untitled';
      const idFromHref = href.match(/\/reports\/([A-Za-z0-9-]+)\.html/i)?.[1] ?? null;
      const codeMatch = block.match(/<code>([^<]+)<\/code>/i);
      const id = (codeMatch?.[1] ?? idFromHref ?? '').trim();
      if (!id) continue;

      const metaMatch = block.match(/<p class="report-metadata">([\s\S]*?)<\/p>/);
      const metadata = metaMatch ? stripTags(metaMatch[1]) : '';
      const dateTokens = metadata.match(/[A-Z][a-z]+\s+\d{1,2},\s+\d{4}/g) ?? [];
      const parsedDates = dateTokens.map((d) => safeDate(d)).filter((d): d is Date => d !== null);
      const date = parsedDates.length ? parsedDates[parsedDates.length - 1] : null;

      reportsById.set(id, {
        id,
        title,
        date,
        authors: [],
        topics: [],
        summary: null,
        pdfUrl: null,
        htmlUrl: href.startsWith('http') ? href : `https://www.everycrsreport.com${href}`,
      });
    }

    const reports = Array.from(reportsById.values());
    console.log(`[crs-sync] EveryCRS parsed: ${reports.length} reports from HTML index`);
    return reports;
  } catch (err) {
    console.warn(`[crs-sync] EveryCRS failed: ${(err as Error).message}`);
    return [];
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/sync-crs.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  const t0 = Date.now();
  console.log('[crs-sync] starting');

  try {
    // Try Congress API first, fall back to EveryCRSReport
    let reports = await fetchFromCongressAPI();
    if (reports.length === 0) {
      reports = await fetchFromEveryCRS();
    }

    if (reports.length === 0) {
      console.warn('[crs-sync] no CRS data from any source');
      return;
    }

    let total = 0;
    for (const r of reports) {
      await (prisma as any).crsReport.upsert({
        where: { id: r.id },
        update: {
          title: r.title,
          date: r.date,
          authors: r.authors,
          topics: r.topics,
          summary: r.summary,
          pdfUrl: r.pdfUrl,
          htmlUrl: r.htmlUrl,
          active: true,
          syncedAt: new Date(),
        },
        create: {
          id: r.id,
          title: r.title,
          date: r.date,
          authors: r.authors,
          topics: r.topics,
          summary: r.summary,
          pdfUrl: r.pdfUrl,
          htmlUrl: r.htmlUrl,
        },
      });
      total++;
      if (total % 500 === 0) console.log(`[crs-sync]   ${total} reports...`);
    }

    console.log(`[crs-sync] total: ${total}`);
    console.log(`[crs-sync] DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } finally { await prisma.$disconnect(); }
}

if (require.main === module) {
main().catch((err) => { console.error('[crs-sync] FAILED', err); process.exit(1); });
}
