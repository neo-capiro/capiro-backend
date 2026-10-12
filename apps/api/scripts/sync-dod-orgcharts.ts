/** @cleanup-smoke noArgsExit=1 */
/**
 * Crawl service leadership/org-chart pages with Firecrawl and extract
 * candidate acquisition personnel records + headshot URLs (if available).
 *
 * Usage:
 *   pnpm --filter @capiro/api sync:dod-orgcharts
 *
 * Required env:
 *   FIRECRAWL_API_KEY=...
 *
 * Optional env:
 *   FIRECRAWL_BASE_URL=https://api.firecrawl.dev/v1
 *   DOD_ORGCHARTS_OUTPUT_DIR=./tmp/orgcharts
 *   DOD_ORGCHARTS_UPLOAD_S3=1
 *   DOD_ORGCHARTS_S3_BUCKET=capiro-scraped-data-967807252336-us-east-1
 *   DOD_ORGCHARTS_S3_PREFIX=pe-watch/orgcharts
 *   AWS_REGION / AWS_REGION_DEFAULT
 */
import { config as dotenvConfig } from 'dotenv';
import { createHash } from 'crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { FirecrawlClient } from '../src/meri/sources/firecrawl.client.js';

dotenvConfig();

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY ?? '';
const FIRECRAWL_BASE_URL = process.env.FIRECRAWL_BASE_URL ?? 'https://api.firecrawl.dev/v1';
const OUTPUT_DIR = process.env.DOD_ORGCHARTS_OUTPUT_DIR ?? './tmp/orgcharts';
const REQUEST_DELAY_MS = 1_000;

const UPLOAD_S3 = (process.env.DOD_ORGCHARTS_UPLOAD_S3 ?? '1') !== '0';
const S3_BUCKET = process.env.DOD_ORGCHARTS_S3_BUCKET ?? 'capiro-scraped-data-967807252336-us-east-1';
const S3_PREFIX = (process.env.DOD_ORGCHARTS_S3_PREFIX ?? 'pe-watch/orgcharts').replace(/^\/+|\/+$/g, '');
const AWS_REGION = process.env.AWS_REGION ?? process.env.AWS_REGION_DEFAULT ?? 'us-east-1';

const SOURCES = [
  { key: 'army_senior_leaders', url: 'https://www.army.mil/leaders/' },
  { key: 'peo_stri', url: 'https://www.peostri.army.mil/about/leadership' },
  { key: 'peo_soldier', url: 'https://www.peosoldier.army.mil/leadership/' },
  { key: 'marcorsyscom_marines', url: 'https://www.marcorsyscom.marines.mil/About-Us/Leaders/' },
  { key: 'ssc_space_force', url: 'https://www.ssc.spaceforce.mil/About-Us/Leadership' },
  { key: 'darpa_people', url: 'https://www.darpa.mil/about-us/people' },
  // --- Added (Step: org-chart sources). URLs verified live 2026-05; the original
  // asaalt.army.mil host is DEAD and defense.gov/leaders moved to war.gov under the
  // Department of War rebrand. All but navair/darpa are WAF-blocked to direct fetch,
  // so Firecrawl is required. These use the generic leadership-card extractor until
  // a page-specific template is added (kept low/medium confidence accordingly).
  { key: 'navair_navy', url: 'https://www.navair.navy.mil/organization/NAVAIR' },
  { key: 'navsea_navy', url: 'https://www.navsea.navy.mil/Home/Leadership/' },
  { key: 'navwar_peo_digital', url: 'https://www.navwar.navy.mil/Organization/PEO-Digital/' },
  { key: 'aflcmc_af', url: 'https://www.aflcmc.af.mil/About-Us/Biographies/' },
  { key: 'asa_alt_army', url: 'https://api.army.mil/' },
  { key: 'osd_leadership', url: 'https://www.war.gov/About/Leadership-Bios/' },
  { key: 'cpe_ground_army', url: 'https://cpeground.army.mil/About' },
  { key: 'cpe_c2in_army', url: 'https://cpec2in.army.mil/Careers/About-CPE-C2IN' },
  { key: 'cpe_es2_army', url: 'https://www.army.mil/enterprise' },
] as const;

type SourceKey = (typeof SOURCES)[number]['key'];

type CandidatePersonnel = {
  source: SourceKey;
  sourceUrl: string;
  fullName: string;
  title: string | null;
  confidence: 'high' | 'medium' | 'low';
  headshotUrl: string | null;
  snippet: string;
};

type MarkdownImageRef = {
  lineIndex: number;
  url: string;
};

const UI_STOP_WORDS = new Set([
  'all',
  'offices',
  'roles',
  'filters',
  'sort',
  'read',
  'bio',
  'video',
  'audio',
  'close',
  'modal',
  'dialog',
  'player',
  'loading',
  'default',
  'selected',
  'menu',
  'search',
  'home',
  'contact',
  'play',
  'track',
]);

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function normalizeUrl(raw: string | null | undefined, sourceUrl: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed, sourceUrl).toString();
  } catch {
    return null;
  }
}

function isLikelyImageUrl(url: string): boolean {
  return /\.(?:jpg|jpeg|png|webp|gif|avif)(?:\?|#|$)/i.test(url);
}

function isLikelyHeadshotUrl(url: string): boolean {
  if (!isLikelyImageUrl(url)) return false;
  return /(lead|leader|people|person|profile|headshot|staff|bio|portrait)/i.test(url);
}

function parseMarkdownImageRefs(markdown: string, sourceUrl: string): MarkdownImageRef[] {
  const refs: MarkdownImageRef[] = [];
  const lines = markdown.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const inlineMatches = Array.from(line.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g));
    for (let j = 0; j < inlineMatches.length; j += 1) {
      const match = inlineMatches[j];
      const normalized = normalizeUrl(match?.[1] ?? null, sourceUrl);
      if (!normalized || !isLikelyImageUrl(normalized)) continue;
      refs.push({ lineIndex: i, url: normalized });
    }

    const bareMatches = Array.from(line.matchAll(/\bhttps?:\/\/[^\s)"']+\.(?:jpg|jpeg|png|webp|gif|avif)(?:\?[^\s)"']*)?/gi));
    for (let j = 0; j < bareMatches.length; j += 1) {
      const match = bareMatches[j];
      const normalized = normalizeUrl(match?.[0] ?? null, sourceUrl);
      if (!normalized) continue;
      refs.push({ lineIndex: i, url: normalized });
    }
  }

  return refs;
}

function pickHeadshotNearLine(images: MarkdownImageRef[], lineIndex: number): string | null {
  const nearby = images
    .map((img) => ({ ...img, dist: Math.abs(img.lineIndex - lineIndex) }))
    .filter((img) => img.dist <= 4)
    .sort((a, b) => {
      if (a.dist !== b.dist) return a.dist - b.dist;
      const aHead = isLikelyHeadshotUrl(a.url) ? 1 : 0;
      const bHead = isLikelyHeadshotUrl(b.url) ? 1 : 0;
      return bHead - aHead;
    });

  if (!nearby.length) return null;
  const firstHeadshot = nearby.find((img) => isLikelyHeadshotUrl(img.url));
  return firstHeadshot?.url ?? null;
}

function isLikelyName(line: string): boolean {
  const cleaned = line
    .replace(/^[#>\-•*\d.)\s]+/, '')
    .replace(/\[[^\]]+\]\([^)]*\)/g, '')
    .trim();
  if (!cleaned || cleaned.length < 5 || cleaned.length > 80) return false;
  if (cleaned.includes('http://') || cleaned.includes('https://')) return false;
  if (/\d{4,}/.test(cleaned)) return false;
  if (!/^[A-Za-z.,'\-\s]+$/.test(cleaned)) return false;
  if (/:/.test(cleaned)) return false;

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  if (words.some((word) => UI_STOP_WORDS.has(word.toLowerCase()))) return false;

  const caps = words.filter((w) => /^[A-Z][a-zA-Z'\-.]+$/.test(w));
  return caps.length >= 2;
}

function cleanTitle(line: string): string {
  return normalizeWhitespace(line.replace(/^[\-•*\d.)\s]+/, '').replace(/^[-:–-]+\s*/, ''));
}

function isLikelyTitleLine(line: string): boolean {
  if (!line) return false;
  if (line.length > 180) return false;
  if (line.includes('http://') || line.includes('https://')) return false;
  if (/\[[^\]]+\]\([^)]*\)/.test(line)) return false;
  const lower = line.toLowerCase();
  if (Array.from(UI_STOP_WORDS).some((word) => lower.includes(word))) return false;
  return /program manager|deputy|director|officer|commander|chief|executive|innovation fellow|major|capt\.|col\.|lt\.|dr\.|peo|program executive/i.test(
    line,
  );
}

function findNearbyTitle(lines: string[], index: number): string | null {
  for (let dist = 1; dist <= 4; dist += 1) {
    const prev = lines[index - dist] ?? null;
    if (prev && isLikelyTitleLine(prev) && !isLikelyName(prev)) return cleanTitle(prev);

    const next = lines[index + dist] ?? null;
    if (next && isLikelyTitleLine(next) && !isLikelyName(next)) return cleanTitle(next);
  }

  return null;
}

function extractPersonnel(source: SourceKey, sourceUrl: string, markdown: string): CandidatePersonnel[] {
  if (source === 'darpa_people') return extractDarpaPeople(source, sourceUrl, markdown);
  if (source === 'army_senior_leaders') return extractArmySeniorLeaders(source, sourceUrl, markdown);
  if (source === 'marcorsyscom_marines') return extractMarcorLeadership(source, sourceUrl, markdown);
  if (source === 'ssc_space_force') return extractSscLeadership(source, sourceUrl, markdown);

  // Newly-added Navy/AF/OSD/CPE sources: their .mil CMS pages vary in structure, so
  // use a generic leadership-card extractor (bold name + adjacent title line). Kept
  // medium-confidence until a page-specific template proves higher precision. A
  // future LLM-cleanup pass (Claude via the LLM client) can replace this per source.
  const GENERIC_SOURCES: SourceKey[] = [
    'navair_navy', 'navsea_navy', 'navwar_peo_digital', 'aflcmc_af',
    'asa_alt_army', 'osd_leadership', 'cpe_ground_army', 'cpe_c2in_army', 'cpe_es2_army',
  ];
  if (GENERIC_SOURCES.includes(source)) return extractGenericLeadership(source, sourceUrl, markdown);

  // peo_stri and peo_soldier are currently noisy with minimal structured leadership cards.
  // Keep strict until we add dedicated page templates for those domains.
  return [];
}

/**
 * Generic DoD leadership-card extractor. Matches a bold name (**First Last**) that
 * is immediately followed (same or next non-empty line) by a recognizable title
 * (Director / Commander / PEO / Program Executive Officer / Deputy / etc.). Works
 * across the common .mil CMS card layouts without a page-specific template.
 */
function extractGenericLeadership(source: SourceKey, sourceUrl: string, markdown: string): CandidatePersonnel[] {
  const out: CandidatePersonnel[] = [];
  const TITLE_RE = /(Program Executive Officer|PEO\b|Commander|Director|Deputy|Chief|Executive Director|Technical Director|Assistant Secretary|Program Manager|Vice Commander)/i;
  // Bold-name pattern: **First Last** optionally followed by a title on the same
  // line (after a comma/dash) or the next line.
  const NAME_RE = /\*\*([A-Z][A-Za-z.'-]+(?:\s+(?:[A-Z]\.|[A-Z][A-Za-z.'-]+)){1,3})\*\*([^\n]*)/g;

  const lines = markdown.split('\n');
  let match: RegExpExecArray | null = null;
  while ((match = NAME_RE.exec(markdown)) !== null) {
    const fullName = normalizeWhitespace(match[1] ?? '');
    if (!isLikelyName(fullName)) continue;

    // Title candidate: trailing text on the bold line, else scan the next few lines.
    let title: string | null = null;
    const trailing = normalizeWhitespace((match[2] ?? '').replace(/^[\s,\\/|-]+/, ''));
    if (trailing && TITLE_RE.test(trailing)) {
      title = cleanTitle(trailing);
    } else {
      // Find this name's line index, look ahead up to 3 non-empty lines for a title.
      const idx = lines.findIndex((l) => l.includes(`**${match![1]}**`));
      if (idx >= 0) {
        for (let j = idx + 1, seen = 0; j < lines.length && seen < 3; j += 1) {
          const ln = normalizeWhitespace(lines[j] ?? '');
          if (!ln) continue;
          seen += 1;
          if (TITLE_RE.test(ln) && !isLikelyName(ln)) {
            title = cleanTitle(ln);
            break;
          }
        }
      }
    }

    if (!title) continue; // require first+last name AND a non-empty title (validation)
    out.push({
      source,
      sourceUrl,
      fullName,
      title,
      confidence: 'medium',
      headshotUrl: null,
      snippet: `${source} leadership card | ${title}`.slice(0, 500),
    });
  }

  return dedupePersonnel(out);
}

function extractDarpaPeople(source: SourceKey, sourceUrl: string, markdown: string): CandidatePersonnel[] {
  const out: CandidatePersonnel[] = [];
  const pattern = /(?:^|\n)([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})\n\n(Program Manager|Innovation Fellow|Deputy Program Manager|Deputy Director|Director)\n\n[\s\S]{0,380}?\[Read Bio\]\((https:\/\/www\.darpa\.mil\/about\/people\/[^)]+)\)/g;

  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(markdown)) !== null) {
    const fullName = normalizeWhitespace(match[1] ?? '');
    const title = normalizeWhitespace(match[2] ?? '');
    if (!isLikelyName(fullName)) continue;
    out.push({
      source,
      sourceUrl,
      fullName,
      title,
      confidence: 'high',
      headshotUrl: null,
      snippet: `DARPA card | ${title} | ${match[3] ?? ''}`.slice(0, 500),
    });
  }

  return dedupePersonnel(out);
}

function extractArmySeniorLeaders(source: SourceKey, sourceUrl: string, markdown: string): CandidatePersonnel[] {
  const out: CandidatePersonnel[] = [];
  const pattern = /-\s*\[!\[[^\]]*\]\((https?:\/\/[^)]+)\)\*\*([^*]+)\*\*[\s\\]*\n?([^\]\n]+)\]\((https?:\/\/www\.army\.mil\/leaders\/[^)]+)\)/g;
  let match: RegExpExecArray | null = null;

  while ((match = pattern.exec(markdown)) !== null) {
    const headshotUrl = normalizeUrl(match[1] ?? null, sourceUrl);
    const title = normalizeWhitespace((match[2] ?? '').replace(/official/gi, ''));
    const fullNameRaw = normalizeWhitespace(match[3] ?? '');
    const fullName = fullNameRaw.replace(/^Sergeant Major of the Army\s+/i, '').trim();
    if (!isLikelyName(fullName)) continue;
    if (!isLikelyTitleLine(title)) continue;

    out.push({
      source,
      sourceUrl,
      fullName,
      title,
      confidence: 'high',
      headshotUrl,
      snippet: `Army leaders card | ${title} | ${match[4] ?? ''}`.slice(0, 500),
    });
  }

  return dedupePersonnel(out);
}

function extractMarcorLeadership(source: SourceKey, sourceUrl: string, markdown: string): CandidatePersonnel[] {
  if (!/Leadership-View\/Article\//i.test(sourceUrl)) return [];

  const lines = markdown.split(/\r?\n/).map((line) => normalizeWhitespace(line));
  let imageUrl: string | null = null;
  let title: string | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!imageUrl) {
      const imgMatch = line.match(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/);
      if (imgMatch) imageUrl = normalizeUrl(imgMatch[1], sourceUrl);
    }

    if (!title && isLikelyTitleLine(line) && !/download|print|share|engagement opportunities/i.test(line)) {
      title = line;
      continue;
    }
  }

  if (!title) return [];

  const slug = sourceUrl.split('/').filter(Boolean).pop() ?? '';
  const fullName = nameFromSlug(slug);
  if (!isLikelyName(fullName)) return [];

  return [
    {
      source,
      sourceUrl,
      fullName,
      title,
      confidence: 'high',
      headshotUrl: imageUrl,
      snippet: `MARCORSYSCOM profile | ${title}`.slice(0, 500),
    },
  ];
}

function extractSscLeadership(source: SourceKey, sourceUrl: string, markdown: string): CandidatePersonnel[] {
  if (!/\/Leadership\/Display\/Article\//i.test(sourceUrl)) return [];

  const slug = sourceUrl.split('/').filter(Boolean).pop() ?? '';
  const fullName = nameFromSlug(slug);
  if (!isLikelyName(fullName)) return [];

  const firstLine = markdown
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .find((line) => line && !/skip to main content/i.test(line) && !/^\[/.test(line));

  let title: string | null = null;
  if (firstLine) {
    const m = firstLine.match(/leads the\s+([^.,]+?)\s+for\s+the\s+Space Systems Command/i);
    if (m?.[1]) title = `Director, ${normalizeWhitespace(m[1])}`;
  }

  if (!title) title = 'Space Systems Command Leadership';

  const imgMatch = markdown.match(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/);
  const headshotUrl = imgMatch ? normalizeUrl(imgMatch[1], sourceUrl) : null;

  return [
    {
      source,
      sourceUrl,
      fullName,
      title,
      confidence: 'medium',
      headshotUrl,
      snippet: `SSC profile | ${title}`.slice(0, 500),
    },
  ];
}

function nameFromSlug(slug: string): string {
  const tokens = slug.split('-').filter(Boolean);
  const out: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!.toLowerCase();
    if (token === 'dr') {
      out.push('Dr.');
      continue;
    }
    if (token === 'jr') {
      out.push('Jr.');
      continue;
    }
    if (/^[a-z]$/.test(token)) {
      out.push(`${token.toUpperCase()}.`);
      continue;
    }

    const cap = token.charAt(0).toUpperCase() + token.slice(1);
    out.push(cap);
  }

  return out.join(' ').trim();
}

function dedupePersonnel(items: CandidatePersonnel[]): CandidatePersonnel[] {
  const byKey = new Map<string, CandidatePersonnel>();
  const score = { high: 3, medium: 2, low: 1 } as const;

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const key = `${item.fullName.toLowerCase()}|${(item.title ?? '').toLowerCase()}`;
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, item);
      continue;
    }

    const itemScore = score[item.confidence] + (item.headshotUrl ? 0.25 : 0);
    const existingScore = score[existing.confidence] + (existing.headshotUrl ? 0.25 : 0);
    if (itemScore > existingScore) byKey.set(key, item);
  }

  return Array.from(byKey.values()).sort((a, b) => {
    const c = score[b.confidence] - score[a.confidence];
    if (c !== 0) return c;
    return a.fullName.localeCompare(b.fullName);
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadJsonToS3(s3: S3Client, bucket: string, key: string, body: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'application/json; charset=utf-8',
      ServerSideEncryption: 'AES256',
    }),
  );
}

async function uploadMarkdownToS3(s3: S3Client, bucket: string, key: string, body: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'text/markdown; charset=utf-8',
      ServerSideEncryption: 'AES256',
    }),
  );
}

async function main() {
  if (!FIRECRAWL_API_KEY.trim()) {
    console.error('Usage: sync-dod-orgcharts (requires FIRECRAWL_API_KEY)');
    throw new Error('FIRECRAWL_API_KEY env var is required');
  }

  const client = new FirecrawlClient(FIRECRAWL_API_KEY, FIRECRAWL_BASE_URL);
  const s3 = new S3Client({ region: AWS_REGION });
  const startedAt = Date.now();
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const s3RunPrefix = `${S3_PREFIX}/${runStamp}`;

  await mkdir(OUTPUT_DIR, { recursive: true });

  const results: CandidatePersonnel[] = [];
  const pageHashes: Record<string, string> = {};

  console.log(`[orgcharts-sync] starting (${SOURCES.length} sources)`);
  console.log(`[orgcharts-sync] local output: ${path.resolve(OUTPUT_DIR)}`);
  if (UPLOAD_S3) {
    console.log(`[orgcharts-sync] s3 target: s3://${S3_BUCKET}/${s3RunPrefix}/`);
  }

  for (let i = 0; i < SOURCES.length; i += 1) {
    const source = SOURCES[i]!;
    try {
      await sleep(REQUEST_DELAY_MS);

      const targets: Array<{ url: string; label: string }> = [{ url: source.url, label: 'seed' }];
      if (source.key !== 'darpa_people') {
        try {
          const mapped = await client.map(source.url, { search: 'leadership', limit: 8, timeoutMs: 30_000 });
          for (let m = 0; m < mapped.length; m += 1) {
            const mappedUrl = mapped[m]!;
            if (!targets.some((t) => t.url === mappedUrl)) {
              targets.push({ url: mappedUrl, label: 'mapped' });
            }
          }
        } catch (mapError) {
          console.warn(`[orgcharts-sync] map failed for ${source.key}: ${(mapError as Error).message}`);
        }
      }

      let sourceCount = 0;
      let sourceHeadshots = 0;

      for (let t = 0; t < targets.length; t += 1) {
        const target = targets[t]!;
        console.log(`[orgcharts-sync] scrape ${source.key} (${target.label}) -> ${target.url}`);
        try {
          const doc = await client.scrape(target.url, {
            formats: ['markdown'],
            onlyMainContent: true,
            timeoutMs: 45_000,
          });

          const markdown = doc.markdown?.trim() ?? '';
          if (!markdown) continue;

          pageHashes[target.url] = sha256(markdown);
          const extracted = extractPersonnel(source.key, target.url, markdown);
          const withHeadshot = extracted.filter((row) => !!row.headshotUrl).length;
          sourceCount += extracted.length;
          sourceHeadshots += withHeadshot;
          results.push(...extracted);

          const fileSafe = target.url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
          const localMdPath = path.join(OUTPUT_DIR, `${source.key}__${fileSafe}.md`);
          await writeFile(localMdPath, markdown, 'utf8');

          if (UPLOAD_S3) {
            const mdKey = `${s3RunPrefix}/raw/${source.key}__${fileSafe}.md`;
            await uploadMarkdownToS3(s3, S3_BUCKET, mdKey, markdown);
          }
        } catch (scrapeError) {
          console.warn(`[orgcharts-sync] ${source.key} target failed ${target.url}: ${(scrapeError as Error).message}`);
        }
      }

      console.log(`[orgcharts-sync] ${source.key}: ${sourceCount} candidates (${sourceHeadshots} with headshot URLs)`);
    } catch (error) {
      console.warn(`[orgcharts-sync] ${source.key} failed: ${(error as Error).message}`);
    }
  }

  const deduped = dedupePersonnel(results);
  const withHeadshots = deduped.filter((item) => !!item.headshotUrl).length;

  const payload = JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      sourceCount: SOURCES.length,
      candidateCount: deduped.length,
      candidateWithHeadshotCount: withHeadshots,
      pageHashes,
      candidates: deduped,
    },
    null,
    2,
  );

  const outPath = path.join(OUTPUT_DIR, 'acquisition-personnel-candidates.json');
  await writeFile(outPath, payload, 'utf8');

  if (UPLOAD_S3) {
    const jsonKey = `${s3RunPrefix}/acquisition-personnel-candidates.json`;
    await uploadJsonToS3(s3, S3_BUCKET, jsonKey, payload);
    const latestKey = `${S3_PREFIX}/latest/acquisition-personnel-candidates.json`;
    await uploadJsonToS3(s3, S3_BUCKET, latestKey, payload);
    console.log(`[orgcharts-sync] uploaded JSON -> s3://${S3_BUCKET}/${jsonKey}`);
    console.log(`[orgcharts-sync] updated latest -> s3://${S3_BUCKET}/${latestKey}`);
  }

  console.log(`[orgcharts-sync] wrote ${deduped.length} candidates (${withHeadshots} with headshot URLs) -> ${outPath}`);
  console.log(`[orgcharts-sync] DONE in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch((error) => {
  console.error('[orgcharts-sync] FAILED', error);
  process.exit(1);
});
