/** @cleanup-smoke noArgsExit=1 */
/**
 * High-yield DoD personnel extraction from press/news archives using Firecrawl map+scrape.
 *
 * Usage:
 *   pnpm --filter @capiro/api tsx scripts/sync-dod-press-personnel.ts
 *
 * Required env:
 *   FIRECRAWL_API_KEY=...
 *
 * Optional env:
 *   FIRECRAWL_BASE_URL=https://api.firecrawl.dev/v1
 *   DOD_PRESS_OUTPUT_DIR=./tmp/press-personnel
 *   DOD_PRESS_UPLOAD_S3=1
 *   DOD_PRESS_S3_BUCKET=capiro-scraped-data-967807252336-us-east-1
 *   DOD_PRESS_S3_PREFIX=pe-watch/press-personnel
 *   DOD_PRESS_MAX_URLS_PER_SOURCE=600
 */
import { config as dotenvConfig } from 'dotenv';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { FirecrawlClient } from '../src/meri/sources/firecrawl.client.js';

dotenvConfig();

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY ?? '';
const FIRECRAWL_BASE_URL = process.env.FIRECRAWL_BASE_URL ?? 'https://api.firecrawl.dev/v1';
const OUTPUT_DIR = process.env.DOD_PRESS_OUTPUT_DIR ?? './tmp/press-personnel';
const MAX_URLS_PER_SOURCE = Number(process.env.DOD_PRESS_MAX_URLS_PER_SOURCE ?? '600');
const REQUEST_DELAY_MS = 300;
const ONLY_SOURCES = new Set(
  (process.env.DOD_PRESS_ONLY_SOURCES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const UPLOAD_S3 = (process.env.DOD_PRESS_UPLOAD_S3 ?? '1') !== '0';
const S3_BUCKET = process.env.DOD_PRESS_S3_BUCKET ?? 'capiro-scraped-data-967807252336-us-east-1';
const S3_PREFIX = (process.env.DOD_PRESS_S3_PREFIX ?? 'pe-watch/press-personnel').replace(/^\/+|\/+$/g, '');
const AWS_REGION = process.env.AWS_REGION ?? process.env.AWS_REGION_DEFAULT ?? 'us-east-1';

const NEWS_SOURCES = [
  { key: 'defense_news', url: 'https://www.defense.gov/News/' },
  { key: 'defense_bios', url: 'https://www.defense.gov/About/Biographies/' },
  { key: 'dod_osd', url: 'https://www.defense.gov/About/Office-of-the-Secretary-of-Defense/' },
  { key: 'army_news', url: 'https://www.army.mil/news/' },
  { key: 'army_newsreleases', url: 'https://www.army.mil/news/newsreleases' },
  { key: 'army_leaders', url: 'https://www.army.mil/leaders/' },
  { key: 'asaalt_news', url: 'https://www.asaalt.army.mil/News/' },
  { key: 'navy_news', url: 'https://www.navy.mil/Press-Office/News-Stories/' },
  { key: 'af_news', url: 'https://www.af.mil/News/' },
  { key: 'spaceforce_news', url: 'https://www.spaceforce.mil/News/' },
  { key: 'marines_news', url: 'https://www.marines.mil/News/' },
  { key: 'darpa_news', url: 'https://www.darpa.mil/news-events' },
  { key: 'darpa_people', url: 'https://www.darpa.mil/about-us/people' },
  { key: 'dla_leadership', url: 'https://www.dla.mil/About-DLA/Leadership/' },
  { key: 'dtra_leadership', url: 'https://www.dtra.mil/About/Leadership/' },
  { key: 'mda_leadership', url: 'https://www.mda.mil/who-we-are/leadership.html' },
] as const;
type SourceKey = (typeof NEWS_SOURCES)[number]['key'];

type PersonnelMention = {
  source: SourceKey;
  articleUrl: string;
  articleTitle: string | null;
  fullName: string;
  title: string;
  organization: string | null;
  confidence: number;
  contextQuote: string;
};

const TITLE_HINT = /(program manager|project manager|program executive officer|peo|deputy|director|chief|commander|contracting officer|contract specialist|contracting specialist|ko\b|pco\b|executive officer|assistant secretary|under secretary|sergeant major|general|colonel|captain|rear admiral|vice admiral|admiral|major|lt\.|lieutenant|dr\.|ses)/i;
const NAME_RX = /\b(?:Lt\.?\s*Gen\.?|Maj\.?\s*Gen\.?|Brig\.?\s*Gen\.?|Gen\.?|Col\.?|Lt\.?\s*Col\.?|Capt\.?|Cmdr\.?|Rear\s+Adm\.?|Vice\s+Adm\.?|Adm\.?|Dr\.?|Mr\.?|Ms\.?|Mrs\.?|Sgt\.?\s*Maj\.?|Sergeant\s+Major)?\s*([A-Z][a-zA-Z'\-.]+(?:\s+[A-Z][a-zA-Z'\-.]+){1,3})\b/g;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function normalizeUrl(raw: string | null | undefined, base: string): string | null {
  if (!raw) return null;
  try {
    return new URL(raw, base).toString();
  } catch {
    return null;
  }
}

function extractMentions(source: SourceKey, articleUrl: string, markdown: string): PersonnelMention[] {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean)
    .slice(0, 2500);

  const articleTitle = lines.find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, '') ?? null;
  const mentions: PersonnelMention[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!TITLE_HINT.test(line)) continue;

    const window = [lines[i - 1], lines[i], lines[i + 1], lines[i + 2]].filter(Boolean).join(' ');
    const matches = Array.from(window.matchAll(NAME_RX));

    for (let m = 0; m < matches.length; m += 1) {
      const name = normalizeWhitespace(matches[m]?.[1] ?? '');
      if (!name || name.length < 6) continue;
      if (/United States|Department of|News|Defense|Army|Navy|Air Force|Space Force/i.test(name)) continue;

      const titleLine = [lines[i], lines[i + 1] ?? '']
        .find((candidate) => TITLE_HINT.test(candidate ?? '') && !/photo|image|video|copyright/i.test(candidate ?? '')) ?? null;
      if (!titleLine) continue;

      const title = normalizeWhitespace(titleLine).slice(0, 180);
      const organization = /army|navy|marine|air force|space force|darpa|department of defense|osd|office of the secretary of defense|missile defense agency|defense logistics agency|defense threat reduction agency|joint staff|combatant command|socom|centcom|indopacom|eucom|northern command|transportation command|strategic command/i.test(window)
        ? (window.match(/(Army|Navy|Marine Corps|Air Force|Space Force|DARPA|Department of Defense|Office of the Secretary of Defense|OSD|Missile Defense Agency|Defense Logistics Agency|Defense Threat Reduction Agency|Joint Staff|SOCOM|CENTCOM|INDOPACOM|EUCOM|NORTHCOM|TRANSCOM|STRATCOM)/i)?.[1] ?? null)
        : null;

      const key = `${source}|${articleUrl}|${name.toLowerCase()}|${title.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const confidence = Math.min(0.98, 0.55 + (organization ? 0.2 : 0.0) + (/program manager|director|commander|officer|peo/i.test(title) ? 0.2 : 0.0));

      mentions.push({
        source,
        articleUrl,
        articleTitle,
        fullName: name,
        title,
        organization,
        confidence,
        contextQuote: window.slice(0, 420),
      });
    }
  }

  return mentions;
}

function dedupeMentions(items: PersonnelMention[]): PersonnelMention[] {
  const byKey = new Map<string, PersonnelMention>();
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const key = `${item.fullName.toLowerCase()}|${item.title.toLowerCase()}|${(item.organization ?? '').toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing || item.confidence > existing.confidence) byKey.set(key, item);
  }
  return Array.from(byKey.values());
}

async function uploadTextToS3(s3: S3Client, bucket: string, key: string, body: string, contentType: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ServerSideEncryption: 'AES256',
    }),
  );
}

function scoreNewsUrl(url: string): number {
  const u = url.toLowerCase();
  let score = 0;
  if (/\/news\//.test(u)) score += 3;
  if (/article|press|release|story|news-stories|display\/article|biographies|leaders|leadership|about-us\/people/.test(u)) score += 3;
  if (/peo|program-manager|program manager|appointed|assumes|promotion|command|acquisition|contract|award|ko\b|pco\b|contracting officer|contract specialist|osd|darpa/.test(u)) score += 2;
  if (/video|photo|gallery|podcast|rss|feed|tag|topic|search|contact|subscribe/.test(u)) score -= 3;
  return score;
}

async function main() {
  if (!FIRECRAWL_API_KEY.trim()) {
    console.error('Usage: sync-dod-press-personnel (requires FIRECRAWL_API_KEY)');
    throw new Error('FIRECRAWL_API_KEY env var is required');
  }

  const client = new FirecrawlClient(FIRECRAWL_API_KEY, FIRECRAWL_BASE_URL);
  const s3 = new S3Client({ region: AWS_REGION });
  const startedAt = Date.now();
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const s3RunPrefix = `${S3_PREFIX}/${runStamp}`;

  await mkdir(OUTPUT_DIR, { recursive: true });

  const allMentions: PersonnelMention[] = [];
  const pageHashes: Record<string, string> = {};
  const stats: Record<string, { mapped: number; scraped: number; mentions: number }> = {};

  for (let i = 0; i < NEWS_SOURCES.length; i += 1) {
    const source = NEWS_SOURCES[i]!;
    stats[source.key] = { mapped: 0, scraped: 0, mentions: 0 };

    console.log(`[press-sync] crawling ${source.key} -> ${source.url}`);
    let pages: Array<{ url: string; markdown: string }> = [];

    try {
      pages = await client.crawl(source.url, {
        limit: MAX_URLS_PER_SOURCE,
        maxDepth: 2,
        timeoutMs: 420_000,
        pollIntervalMs: 4_000,
        scrapeOptions: {
          formats: ['markdown'],
          onlyMainContent: true,
        },
      });
    } catch (error) {
      console.warn(`[press-sync] crawl failed for ${source.key}: ${(error as Error).message}`);
      console.warn(`[press-sync] falling back to map+scrape for ${source.key}`);

      try {
        const mapped = await client.map(source.url, {
          search: 'appointed program manager peo director commander acquisition contract award leadership',
          limit: MAX_URLS_PER_SOURCE,
          timeoutMs: 90_000,
        });

        const fallbackUrls = mapped
          .map((u) => normalizeUrl(u, source.url))
          .filter((u): u is string => !!u)
          .filter((u) => scoreNewsUrl(u) > 0)
          .slice(0, MAX_URLS_PER_SOURCE);

        for (let k = 0; k < fallbackUrls.length; k += 1) {
          const fUrl = fallbackUrls[k]!;
          try {
            await sleep(REQUEST_DELAY_MS);
            const doc = await client.scrape(fUrl, {
              formats: ['markdown'],
              onlyMainContent: true,
              timeoutMs: 60_000,
            });
            const md = doc.markdown?.trim() ?? '';
            if (!md || md.length < 200) continue;
            pages.push({ url: fUrl, markdown: md });
          } catch {
            // best effort fallback
          }
        }
      } catch (mapError) {
        console.warn(`[press-sync] map fallback failed for ${source.key}: ${(mapError as Error).message}`);
      }

      if (!pages.length) {
        continue;
      }
    }

    const urls = pages
      .map((p) => normalizeUrl(p.url, source.url))
      .filter((u): u is string => !!u)
      .filter((u) => scoreNewsUrl(u) > 0)
      .slice(0, MAX_URLS_PER_SOURCE);

    stats[source.key]!.mapped = pages.length;

    for (let u = 0; u < urls.length; u += 1) {
      const url = urls[u]!;
      const page = pages.find((p) => normalizeUrl(p.url, source.url) === url);
      const markdown = page?.markdown?.trim() ?? '';
      if (!markdown || markdown.length < 200) continue;

      await sleep(REQUEST_DELAY_MS);
      stats[source.key]!.scraped += 1;
      pageHashes[url] = sha256(markdown);

      const mentions = extractMentions(source.key, url, markdown);
      stats[source.key]!.mentions += mentions.length;
      allMentions.push(...mentions);

      const safe = url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
      await writeFile(path.join(OUTPUT_DIR, `${source.key}__${safe}.md`), markdown, 'utf8');
    }

    console.log(
      `[press-sync] ${source.key}: crawled=${stats[source.key]!.mapped} scraped=${stats[source.key]!.scraped} mentions=${stats[source.key]!.mentions}`,
    );
  }

  const deduped = dedupeMentions(allMentions);
  const payload = JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      sourceCount: NEWS_SOURCES.length,
      candidateCount: deduped.length,
      pageHashes,
      stats,
      mentions: deduped,
    },
    null,
    2,
  );

  const outPath = path.join(OUTPUT_DIR, 'press-personnel-mentions.json');
  await writeFile(outPath, payload, 'utf8');

  if (UPLOAD_S3) {
    const jsonKey = `${s3RunPrefix}/press-personnel-mentions.json`;
    const latestKey = `${S3_PREFIX}/latest/press-personnel-mentions.json`;
    await uploadTextToS3(s3, S3_BUCKET, jsonKey, payload, 'application/json; charset=utf-8');
    await uploadTextToS3(s3, S3_BUCKET, latestKey, payload, 'application/json; charset=utf-8');
    console.log(`[press-sync] uploaded JSON -> s3://${S3_BUCKET}/${jsonKey}`);
    console.log(`[press-sync] updated latest -> s3://${S3_BUCKET}/${latestKey}`);
  }

  console.log(`[press-sync] wrote ${deduped.length} deduped mentions -> ${outPath}`);
  console.log(`[press-sync] DONE in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch((error) => {
  console.error('[press-sync] FAILED', error);
  process.exit(1);
});
