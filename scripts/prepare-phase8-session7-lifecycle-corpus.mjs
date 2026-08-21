#!/usr/bin/env node
/**
 * Phase 8 Session 7 — materialise the real official lifecycle corpus.
 *
 * Downloads every source from its official publisher, hashes the bytes, fetches
 * the publisher's own text rendition where one exists, and writes a prepared
 * corpus with pinned SHAs. Bytes are never committed to the repository.
 *
 * Fail-closed rules:
 *   - only HTTPS URLs on an allow-list of official publisher hosts;
 *   - a pinned SHA that no longer matches the download is a hard failure
 *     (tamper / silent republication detection);
 *   - a claimed division-evidence pattern must actually appear in the document's
 *     own text, otherwise the corpus entry is refused;
 *   - GovInfo answers a missing text rendition with HTTP 200 and a
 *     "Page Not Found" body, so that soft-404 is detected and reported as
 *     "no rendition" rather than swallowed as document content.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const corpusPath = path.join(root, 'docs/defense-budget/phase8-session7-lifecycle-corpus.json');
const outDir = path.resolve(
  process.env.PHASE8_SESSION7_WORKDIR || path.join(root, '.session7-lifecycle'),
);
const outputPath = path.join(outDir, 'prepared-corpus.json');

const allowedHosts = new Set([
  'www.govinfo.gov',
  'govinfo.gov',
  'www.congress.gov',
  'congress.gov',
  'comptroller.defense.gov',
  'asafm.army.mil',
  'www.secnav.navy.mil',
  'secnav.navy.mil',
  'www.saffm.hq.af.mil',
  'saffm.hq.af.mil',
]);

const USER_AGENT = 'Capiro-Phase8-Session7/1.0 lifecycle-source-discovery';
const EXCERPT_CHARS = 8_000;
const SOFT_404 = /Page Not Found \| GovInfo|<title>\s*404\b/i;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function assertOfficialUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) {
    throw new Error(`Refusing non-official Session 7 source URL: ${raw}`);
  }
  return url.toString();
}

function stripMarkup(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const byteCache = new Map();
async function download(urlText) {
  const url = assertOfficialUrl(urlText);
  if (byteCache.has(url)) return byteCache.get(url);
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow' });
  if (!response.ok) throw new Error(`Source download failed ${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error(`Empty body: ${url}`);
  const result = {
    sha256: sha256(bytes),
    byteSize: bytes.length,
    httpEtag: response.headers.get('etag'),
    httpLastModified: response.headers.get('last-modified'),
  };
  byteCache.set(url, result);
  return result;
}

const textCache = new Map();
async function downloadText(urlText) {
  if (!urlText) return { available: false, excerpt: null, full: null, reason: 'no rendition declared' };
  const url = assertOfficialUrl(urlText);
  if (textCache.has(url)) return textCache.get(url);
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow' });
  if (!response.ok) {
    const miss = { available: false, excerpt: null, full: null, reason: `HTTP ${response.status}` };
    textCache.set(url, miss);
    return miss;
  }
  const raw = await response.text();
  if (SOFT_404.test(raw)) {
    const miss = {
      available: false,
      excerpt: null,
      full: null,
      reason: 'publisher soft-404 (HTTP 200 with a "Page Not Found" body)',
    };
    textCache.set(url, miss);
    return miss;
  }
  const text = stripMarkup(raw);
  const result = {
    available: true,
    excerpt: text.slice(0, EXCERPT_CHARS),
    full: text,
    reason: null,
    textSha256: sha256(Buffer.from(text, 'utf8')),
    textLength: text.length,
  };
  textCache.set(url, result);
  return result;
}

await fs.mkdir(outDir, { recursive: true });
const corpus = JSON.parse(await fs.readFile(corpusPath, 'utf8'));
if (corpus.schemaVersion !== 'phase8_session7_lifecycle_corpus_v1') {
  throw new Error(`Unsupported corpus schema: ${corpus.schemaVersion}`);
}

const prepared = [];
const failures = [];

for (const source of corpus.sources) {
  try {
    const bytes = await download(source.officialUrl);
    if (source.sourceSha256 && source.sourceSha256 !== bytes.sha256) {
      throw new Error(
        `Pinned source SHA mismatch for ${source.sourceKey}: expected ${source.sourceSha256}, ` +
          `downloaded ${bytes.sha256}`,
      );
    }

    const text = await downloadText(source.textRendition ?? null);

    // A declared division-evidence pattern must genuinely be in the document.
    let divisionEvidence = null;
    if (source.divisionEvidencePattern) {
      if (!text.available) {
        throw new Error(
          `${source.sourceKey} claims division evidence but the publisher offers no text rendition`,
        );
      }
      const needle = source.divisionEvidencePattern.toLowerCase();
      if (!text.full.toLowerCase().includes(needle)) {
        throw new Error(
          `${source.sourceKey} division-evidence pattern is NOT present in the official text: ` +
            `"${source.divisionEvidencePattern}"`,
        );
      }
      divisionEvidence = source.divisionEvidencePattern;
    }

    // A corpus entry that claims a phrase is ABSENT must be checked too. This is
    // what keeps the ambiguity scenario honest: the omnibus used for it really
    // has no Department of Defense division, rather than one we hid.
    if (source.mustNotContainPattern) {
      if (!text.available) {
        throw new Error(
          `${source.sourceKey} claims an absent phrase but the publisher offers no text rendition`,
        );
      }
      if (text.full.toLowerCase().includes(source.mustNotContainPattern.toLowerCase())) {
        throw new Error(
          `${source.sourceKey} was expected NOT to contain "${source.mustNotContainPattern}", ` +
            'but the official text does contain it',
        );
      }
    }

    prepared.push({
      sourceKey: source.sourceKey,
      adapterId: source.adapterId,
      officialUrl: source.officialUrl,
      packageId: source.packageId ?? null,
      title: source.title,
      authorityTrack: source.authorityTrack,
      stage: source.stage,
      sourceFamily: source.sourceFamily,
      chamber: source.chamber ?? null,
      committee: source.committee ?? null,
      component: source.component ?? null,
      availableFrom: source.availableFrom,
      versionRank: source.versionRank ?? null,
      supersedes: source.supersedes ?? null,
      sourceSha256: bytes.sha256,
      byteSize: bytes.byteSize,
      httpEtag: bytes.httpEtag,
      httpLastModified: bytes.httpLastModified,
      contentExcerpt: text.excerpt,
      contentExcerptAvailable: text.available,
      contentExcerptUnavailableReason: text.available ? null : text.reason,
      textRenditionSha256: text.textSha256 ?? null,
      divisionEvidence,
      expectedDecision: source.expectedDecision,
      expectedCorroborationDeferred: source.expectedCorroborationDeferred === true,
      note: source.note ?? null,
    });
    const shaShort = bytes.sha256.slice(0, 12);
    const textNote = text.available ? `text=${text.textLength}c` : `text=none (${text.reason})`;
    console.log(
      `[phase8-session7] ok  ${source.sourceKey} sha=${shaShort}… bytes=${bytes.byteSize} ${textNote}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${source.sourceKey}: ${message}`);
    console.error(`[phase8-session7] FAIL ${source.sourceKey}: ${message}`);
  }
}

if (failures.length) {
  console.error(`\n[phase8-session7] corpus preparation FAILED (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const output = {
  schemaVersion: 'phase8_session7_prepared_lifecycle_corpus_v1',
  fiscalYear: corpus.fiscalYear,
  preparedFrom: 'docs/defense-budget/phase8-session7-lifecycle-corpus.json',
  sources: prepared,
};
await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

console.log(
  `\n[phase8-session7] CORPUS_PREPARED sources=${prepared.length} ` +
    `withText=${prepared.filter((s) => s.contentExcerptAvailable).length} ` +
    `pdfOnly=${prepared.filter((s) => !s.contentExcerptAvailable).length}`,
);
console.log(`[phase8-session7] wrote ${path.relative(root, outputPath)}`);
