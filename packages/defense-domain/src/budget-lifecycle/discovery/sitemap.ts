/**
 * Phase 8 Session 8 — sitemap extraction for live official-source discovery.
 *
 * GovInfo publishes a per-collection sitemap index that requires **no API key**,
 * which matters because both `api.govinfo.gov` and `api.congress.gov` answer an
 * unauthenticated request with `API_KEY_MISSING`. The sitemap channel is the one
 * a dark deployment can actually run without a credential, and govinfo's own
 * robots.txt lists these files explicitly while disallowing `/search/`.
 *
 * Two properties of the real files drive this parser:
 *
 *  1. **Entry order is arbitrary.** The real `CRPT_sitemap_index.xml` lists 2001,
 *     2015, 2004, 2005, 2011 in that order. Discovery has to be deterministic, so
 *     extracted entries are sorted by location rather than trusted as given.
 *
 *  2. **The markup is not pretty-printed.** Real entries arrive as
 *     `</url><url>  <loc>…</loc>  <lastmod>…</lastmod>` on a single line, so a
 *     line-oriented parser would mis-frame them. Extraction is therefore
 *     element-scoped, not line-scoped, and deliberately tolerant: this is a
 *     discovery hint channel, and a malformed entry must be skipped rather than
 *     abort a crawl.
 *
 * `lastmod` here is GovInfo's **metadata** timestamp, not the publication date —
 * real FY2024 packages carry `lastmod` values in late 2024 and 2025. It is used
 * only as a change signal for incremental crawling. Nothing downstream may treat
 * it as "when the document was published".
 */

export interface SitemapIndexEntry {
  readonly loc: string;
  readonly lastmod: string | null;
}

export interface SitemapUrlEntry {
  readonly loc: string;
  readonly lastmod: string | null;
}

const LOC_PATTERN = /<loc>\s*([^<]+?)\s*<\/loc>/i;
const LASTMOD_PATTERN = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/i;

function extractBlocks(xml: string, element: 'sitemap' | 'url'): readonly string[] {
  const pattern = new RegExp(`<${element}(?:\\s[^>]*)?>([\\s\\S]*?)</${element}>`, 'gi');
  const blocks: string[] = [];
  for (const match of xml.matchAll(pattern)) {
    const body = match[1];
    if (typeof body === 'string') blocks.push(body);
  }
  return blocks;
}

function normaliseLastmod(raw: string | undefined): string | null {
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

function extractEntries(xml: string, element: 'sitemap' | 'url'): readonly SitemapIndexEntry[] {
  const entries: SitemapIndexEntry[] = [];
  const seen = new Set<string>();

  for (const block of extractBlocks(xml, element)) {
    const loc = LOC_PATTERN.exec(block)?.[1];
    if (!loc) continue;
    // A sitemap may legitimately repeat a location; the first wins so the result
    // is a function of the document rather than of iteration order.
    if (seen.has(loc)) continue;
    seen.add(loc);
    entries.push(
      Object.freeze({
        loc,
        lastmod: normaliseLastmod(LASTMOD_PATTERN.exec(block)?.[1]),
      }),
    );
  }

  // Deterministic order regardless of how the publisher happened to emit them.
  entries.sort((left, right) => (left.loc < right.loc ? -1 : left.loc > right.loc ? 1 : 0));
  return Object.freeze(entries);
}

export function parseSitemapIndex(xml: string): readonly SitemapIndexEntry[] {
  return extractEntries(xml, 'sitemap');
}

export function parseSitemapUrlSet(xml: string): readonly SitemapUrlEntry[] {
  return extractEntries(xml, 'url');
}

/**
 * `true` when an entry changed at or after the recorded watermark.
 *
 * Inclusive on purpose. An exclusive comparison would permanently skip any entry
 * whose `lastmod` equals the watermark, and two GovInfo packages routinely share
 * a `lastmod` to the millisecond. Re-seeing an unchanged entry is free — the
 * watcher's byte comparison makes it a no-op — whereas missing one is silent
 * data loss.
 */
export function sitemapEntryChangedSince(entry: {
  lastmod: string | null;
}, watermarkIso: string | null): boolean {
  if (watermarkIso === null) return true;
  if (entry.lastmod === null) return true;
  const entryAt = Date.parse(entry.lastmod);
  const watermark = Date.parse(watermarkIso);
  if (Number.isNaN(entryAt) || Number.isNaN(watermark)) return true;
  return entryAt >= watermark;
}

/** The newest `lastmod` across entries, or the prior watermark when none advance. */
export function highestLastmod(
  entries: readonly { lastmod: string | null }[],
  fallbackIso: string | null = null,
): string | null {
  let best = fallbackIso === null ? Number.NEGATIVE_INFINITY : Date.parse(fallbackIso);
  if (Number.isNaN(best)) best = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    if (entry.lastmod === null) continue;
    const at = Date.parse(entry.lastmod);
    if (!Number.isNaN(at) && at > best) best = at;
  }

  return best === Number.NEGATIVE_INFINITY ? null : new Date(best).toISOString();
}
