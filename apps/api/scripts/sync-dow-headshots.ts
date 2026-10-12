/** @cleanup-smoke noArgsExit=1 */
/**
 * sync-dow-headshots.ts
 *
 * Acquire official DoD headshots for acquisition-personnel whose publicProfileUrl
 * points at a .mil bio page (metadata.linkType === 'mil_bio'), and store them in S3.
 *
 * Pipeline (per person):
 *   1. Scrape the .mil bio page via Firecrawl (direct fetches are WAF-blocked, HTTP 403).
 *   2. Parse the returned HTML for a headshot URL — prefer og:image, else the first
 *      <img src> matching media.defense.gov/...(jpg|jpeg|png) (case-insensitive).
 *   3. Download the media.defense.gov file directly (browser User-Agent; no Firecrawl
 *      needed for the media file itself) and validate it (content-type image/*, 1KB-5MB).
 *   4. Upload to S3 (ASSETS_BUCKET / AWS_REGION_DEFAULT) under dow-headshots/{personId}.{ext}.
 *   5. Merge metadata.headshotS3Key + metadata.headshotSource='media.defense.gov' (idempotent).
 *
 * Usage:
 *   tsx scripts/sync-dow-headshots.ts                 # dry-run, scans up to 50
 *   tsx scripts/sync-dow-headshots.ts --limit 200 --commit
 *   tsx scripts/sync-dow-headshots.ts --commit --force   # re-fetch even if headshotS3Key set
 *
 * Required env (apps/api/.env): FIRECRAWL_API_KEY, ASSETS_BUCKET. Optional: AWS_REGION_DEFAULT
 * (default 'us-east-1'). Without --commit nothing is written to S3 or the DB.
 */
import { config as dotenvConfig } from 'dotenv';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service.js';

dotenvConfig();

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY ?? '';
const FIRECRAWL_SCRAPE_URL = 'https://api.firecrawl.dev/v1/scrape';
const ASSETS_BUCKET = process.env.ASSETS_BUCKET ?? '';
const AWS_REGION_DEFAULT = process.env.AWS_REGION_DEFAULT ?? 'us-east-1';

const FIRECRAWL_DELAY_MS = 1_000;
const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000];
const MIN_IMAGE_BYTES = 1_024; // 1 KB
const MAX_IMAGE_BYTES = 5 * 1_024 * 1_024; // 5 MB
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The metadata blob we care about; everything else is preserved on merge. */
interface PersonMetadata {
  linkType?: unknown;
  headshotS3Key?: unknown;
  headshotSource?: unknown;
  [key: string]: unknown;
}

function asMetadata(value: Prisma.JsonValue): PersonMetadata {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as PersonMetadata)
    : {};
}

interface RunSummary {
  scanned: number;
  headshots_found: number;
  uploaded: number;
  skipped_existing: number;
  failed: number;
}

/** True for HTTP statuses worth retrying with backoff. */
function isTransient(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * fetch() with exponential backoff (1s/2s/4s) on transient 429/5xx and network
 * errors. Throws on the final attempt so the per-person handler can catch + skip.
 */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      const res = await fetch(url, init);
      if (isTransient(res.status) && attempt < RETRY_BACKOFF_MS.length) {
        await sleep(RETRY_BACKOFF_MS[attempt]);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < RETRY_BACKOFF_MS.length) {
        await sleep(RETRY_BACKOFF_MS[attempt]);
        continue;
      }
      throw err;
    }
  }
  // Unreachable in practice (loop either returns or throws), but keeps TS happy.
  throw lastError instanceof Error ? lastError : new Error(`fetch failed: ${url}`);
}

/** Scrape a bio page via Firecrawl and return the HTML, or null on failure. */
async function scrapeHtml(url: string): Promise<string | null> {
  const res = await fetchWithRetry(FIRECRAWL_SCRAPE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
    },
    body: JSON.stringify({ url, formats: ['html'] }),
  });
  if (!res.ok) {
    throw new Error(`Firecrawl scrape failed (${res.status}) for ${url}`);
  }
  const payload = (await res.json()) as { data?: { html?: unknown } };
  const html = payload?.data?.html;
  return typeof html === 'string' && html.length > 0 ? html : null;
}

const MEDIA_DEFENSE_RE = /https?:\/\/media\.defense\.gov\/[^\s"'<>]+?\.(?:jpg|jpeg|png)/i;

/**
 * Extract a headshot URL from scraped HTML. Prefer an og:image meta whose content
 * is a media.defense.gov image; otherwise fall back to the first <img src> matching
 * the media.defense.gov image pattern. Case-insensitive throughout.
 */
function extractHeadshotUrl(html: string): string | null {
  // Prefer og:image (either attribute order).
  const ogMatchers = [
    /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i,
  ];
  for (const re of ogMatchers) {
    const m = html.match(re);
    if (m && MEDIA_DEFENSE_RE.test(m[1])) {
      const found = m[1].match(MEDIA_DEFENSE_RE);
      if (found) return found[0];
    }
  }
  // Fall back to the first <img src> pointing at a media.defense.gov image.
  const imgSrcRe = /<img[^>]+src=["']([^"']+)["']/gi;
  let imgMatch: RegExpExecArray | null;
  while ((imgMatch = imgSrcRe.exec(html)) !== null) {
    const candidate = imgMatch[1].match(MEDIA_DEFENSE_RE);
    if (candidate) return candidate[0];
  }
  // Last resort: any media.defense.gov image anywhere in the HTML.
  const anyMatch = html.match(MEDIA_DEFENSE_RE);
  return anyMatch ? anyMatch[0] : null;
}

interface FetchedImage {
  body: Buffer;
  contentType: string;
  ext: string;
}

/** Map an image content-type to a file extension. */
function extForContentType(contentType: string): string | null {
  const ct = contentType.toLowerCase();
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('png')) return 'png';
  return null;
}

/**
 * Download the media URL directly with a browser UA and validate it is a real
 * image (content-type image/*, 1KB-5MB). Returns null if it fails validation.
 */
async function downloadImage(url: string): Promise<FetchedImage | null> {
  const res = await fetchWithRetry(url, {
    method: 'GET',
    headers: { 'User-Agent': BROWSER_UA, Accept: 'image/*' },
  });
  if (!res.ok) {
    throw new Error(`Image download failed (${res.status}) for ${url}`);
  }
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  if (!contentType.toLowerCase().startsWith('image/')) {
    console.warn(`  ! not an image (content-type "${contentType}") for ${url}`);
    return null;
  }
  const ext = extForContentType(contentType);
  if (!ext) {
    console.warn(`  ! unsupported image content-type "${contentType}" for ${url}`);
    return null;
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (body.byteLength < MIN_IMAGE_BYTES || body.byteLength > MAX_IMAGE_BYTES) {
    console.warn(
      `  ! image size ${body.byteLength}B outside [${MIN_IMAGE_BYTES}, ${MAX_IMAGE_BYTES}] for ${url}`,
    );
    return null;
  }
  return { body, contentType, ext };
}

async function main(): Promise<void> {
  const limit = Math.max(1, Number.parseInt(arg('limit') ?? '50', 10) || 50);
  const commit = hasFlag('commit');
  const force = hasFlag('force');

  if (!FIRECRAWL_API_KEY) {
    console.error('Usage: sync-dow-headshots [--limit <n>] [--commit] [--force] (requires FIRECRAWL_API_KEY)');
    throw new Error('FIRECRAWL_API_KEY is not set (apps/api/.env)');
  }
  if (commit && !ASSETS_BUCKET) {
    throw new Error('ASSETS_BUCKET is not set but --commit was passed');
  }

  console.log(
    `[sync-dow-headshots] limit=${limit} commit=${commit} force=${force} ` +
      `bucket=${ASSETS_BUCKET || '(unset)'} region=${AWS_REGION_DEFAULT}`,
  );

  const s3 = commit ? new S3Client({ region: AWS_REGION_DEFAULT }) : null;
  const prisma = new PrismaService();
  await prisma.onModuleInit();

  const summary: RunSummary = {
    scanned: 0,
    headshots_found: 0,
    uploaded: 0,
    skipped_existing: 0,
    failed: 0,
  };

  try {
    // metadata is a JSONB column; fetch the .mil-bio candidates and filter in JS
    // (simplest + robust against quoting differences in the ->> raw operator).
    const candidates = await prisma.acquisitionPersonnel.findMany({
      where: { publicProfileUrl: { not: null } },
      select: { id: true, fullName: true, publicProfileUrl: true, metadata: true },
      orderBy: { createdAt: 'asc' },
    });

    const queue = candidates.filter((p) => asMetadata(p.metadata).linkType === 'mil_bio');

    let processed = 0;
    for (const person of queue) {
      if (processed >= limit) break;
      processed += 1;
      summary.scanned += 1;

      const url = person.publicProfileUrl;
      if (!url) continue;

      const meta = asMetadata(person.metadata);
      const existingKey =
        typeof meta.headshotS3Key === 'string' && meta.headshotS3Key.length > 0
          ? meta.headshotS3Key
          : null;
      if (existingKey && !force) {
        summary.skipped_existing += 1;
        console.log(`- skip (has headshot) ${person.fullName} -> ${existingKey}`);
        continue;
      }

      try {
        console.log(`> ${person.fullName} (${person.id})`);
        const html = await scrapeHtml(url);
        // Politeness delay between Firecrawl calls.
        await sleep(FIRECRAWL_DELAY_MS);

        if (!html) {
          console.warn(`  ! Firecrawl returned no HTML for ${url}`);
          summary.failed += 1;
          continue;
        }

        const headshotUrl = extractHeadshotUrl(html);
        if (!headshotUrl) {
          console.warn(`  ! no media.defense.gov headshot found on ${url}`);
          summary.failed += 1;
          continue;
        }
        summary.headshots_found += 1;
        console.log(`  found headshot: ${headshotUrl}`);

        const image = await downloadImage(headshotUrl);
        if (!image) {
          summary.failed += 1;
          continue;
        }

        const s3Key = `dow-headshots/${person.id}.${image.ext}`;

        if (!commit) {
          console.log(
            `  [dry-run] WOULD upload ${image.body.byteLength}B (${image.contentType}) ` +
              `to s3://${ASSETS_BUCKET || '(unset)'}/${s3Key} and set metadata.headshotS3Key`,
          );
          summary.uploaded += 1;
          continue;
        }

        await s3!.send(
          new PutObjectCommand({
            Bucket: ASSETS_BUCKET,
            Key: s3Key,
            Body: image.body,
            ContentType: image.contentType,
          }),
        );

        // Merge into existing metadata, preserving all other keys. The source JSON
        // came from the DB so its values are valid JSON; cast to the Prisma input type.
        const nextMetadata = {
          ...meta,
          headshotS3Key: s3Key,
          headshotUrl,
          headshotSource: 'media.defense.gov',
        } as Prisma.InputJsonObject;
        await prisma.acquisitionPersonnel.update({
          where: { id: person.id },
          data: { metadata: nextMetadata },
        });

        summary.uploaded += 1;
        console.log(`  uploaded -> s3://${ASSETS_BUCKET}/${s3Key} (metadata updated)`);
      } catch (err) {
        summary.failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`  ! failed ${person.fullName} (${person.id}): ${message}`);
        continue;
      }
    }

    console.log(JSON.stringify(summary));
  } finally {
    await prisma.onModuleDestroy();
    s3?.destroy();
  }
}

void main();
