/**
 * Phase 8 Session 8 — GovInfo package URL algebra and MODS metadata extraction.
 *
 * Every transform here was verified against live GovInfo responses.
 *
 * **The sitemap does not give you the document URL.** A real `CRPT` sitemap entry
 * is `https://www.govinfo.gov/app/details/CRPT-118hrpt125` — a human-facing
 * details page, not the PDF the watcher fetches and hashes. The content URL has
 * to be derived: `/content/pkg/<id>/pdf/<id>.pdf`, which for that exact package
 * answers `200 application/pdf` with `Last-Modified` and **no `ETag`** — the same
 * validator gap Session 7 designed the byte-SHA identity around.
 *
 * **The sitemap does not give you a usable title either.** The details page's
 * own `<title>` is `H. Rept. 118-125 - CRPT-118hrpt125 | Content Details |
 * GovInfo`: a label, not the document's subject, and useless for deciding
 * authorization versus appropriations. The authoritative title lives in
 * `/metadata/pkg/<id>/mods.xml`, which is key-free and returns exactly the
 * phrases the Session 7 classifier already keys on:
 *
 *   CRPT-118hrpt125 -> "NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2024"
 *   CRPT-118hrpt121 -> "DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2024"
 *   PLAW-118publ42  -> "An act making consolidated appropriations for the
 *                       fiscal year ending September 30, 2024, ..."
 *
 * The middle one is the case Session 7 called out: a HAC-D report whose front
 * matter contains no "fiscal year" phrase at all. It resolves correctly from the
 * appropriations-bill wording, which is why the title has to come from MODS
 * rather than from the sitemap or the details page.
 */

export type GovInfoCollection = 'CRPT' | 'BILLS' | 'PLAW' | 'BUDGET';

export const GOVINFO_COLLECTIONS: readonly GovInfoCollection[] = Object.freeze([
  'CRPT',
  'BILLS',
  'PLAW',
  'BUDGET',
]);

const GOVINFO_CONTENT_HOST = 'www.govinfo.gov';

/** Collections each GovInfo-backed adapter is allowed to crawl. */
export const GOVINFO_ADAPTER_COLLECTIONS: Readonly<Record<string, readonly GovInfoCollection[]>> =
  Object.freeze({
    'govinfo-committee-reports': Object.freeze<GovInfoCollection[]>(['CRPT']),
    'govinfo-bills': Object.freeze<GovInfoCollection[]>(['BILLS']),
    'govinfo-public-laws': Object.freeze<GovInfoCollection[]>(['PLAW']),
  });

export function govinfoSitemapIndexUrl(collection: GovInfoCollection): string {
  return `https://${GOVINFO_CONTENT_HOST}/sitemap/${collection}_sitemap_index.xml`;
}

/**
 * Package id from a sitemap `<loc>`.
 *
 * Accepts the `/app/details/<id>` form the real sitemaps emit, and the
 * `/content/pkg/<id>/...` form in case a publisher ever lists content URLs
 * directly. Anything else returns `null` rather than a guess.
 */
export function packageIdFromSitemapLoc(loc: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(loc);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.hostname !== GOVINFO_CONTENT_HOST && parsed.hostname !== 'govinfo.gov') return null;

  const details = /^\/app\/details\/([A-Za-z0-9._-]+)$/.exec(parsed.pathname);
  if (details?.[1]) return details[1];

  const content = /^\/content\/pkg\/([A-Za-z0-9._-]+)\//.exec(parsed.pathname);
  if (content?.[1]) return content[1];

  return null;
}

export function govinfoPackagePdfUrl(packageId: string): string {
  return `https://${GOVINFO_CONTENT_HOST}/content/pkg/${packageId}/pdf/${packageId}.pdf`;
}

export function govinfoPackageModsUrl(packageId: string): string {
  return `https://${GOVINFO_CONTENT_HOST}/metadata/pkg/${packageId}/mods.xml`;
}

/** Collection prefix of a package id, when it is one we crawl. */
export function govinfoCollectionOfPackageId(packageId: string): GovInfoCollection | null {
  const prefix = /^([A-Z]+)-/.exec(packageId.toUpperCase())?.[1];
  if (!prefix) return null;
  return (GOVINFO_COLLECTIONS as readonly string[]).includes(prefix)
    ? (prefix as GovInfoCollection)
    : null;
}

export interface ModsMetadata {
  /** The primary `<titleInfo><title>` — the document's official long title. */
  readonly title: string | null;
  /**
   * The document's own alternative titles, from `<titleInfo type="alternative">`.
   *
   * Needed, not optional. A real bill record carries the official long title
   * first — "To authorize appropriations for fiscal year 2024 for military
   * activities of the Department of Defense..." — and the popular short title
   * ("National Defense Authorization Act for Fiscal Year 2024") only as an
   * alternative. Reading the primary title alone leaves the NDAA unclassifiable,
   * because "authorize appropriations" names both tracks at once.
   */
  readonly alternativeTitles: readonly string[];
  /** Congress number, when MODS states one. */
  readonly congress: number | null;
  /** Fiscal years explicitly named in the MODS record, ascending. */
  readonly declaredFiscalYears: readonly number[];
}

const MODS_TITLE_PATTERN = /<title>\s*([\s\S]*?)\s*<\/title>/i;
const MODS_CONGRESS_PATTERN = /<congress>\s*(\d{1,3})\s*<\/congress>/i;
const MODS_ALT_TITLE_PATTERN =
  /<titleInfo\b[^>]*\btype\s*=\s*"alternative"[^>]*>[\s\S]*?<title>\s*([\s\S]*?)\s*<\/title>/gi;
/** A bill designator such as "H.R. 2670 (RH)" identifies, it does not describe. */
const BILL_DESIGNATOR_TITLE = /^(?:H\.?\s?R\.?|S\.?|H\.?J\.?RES\.?|S\.?J\.?RES\.?)\s*\d+\b/i;

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    // Ampersand last, so a double-encoded entity cannot be re-decoded into markup.
    .replace(/&amp;/g, '&');
}

/**
 * Extract the fields the classifier needs from a MODS record.
 *
 * Deliberately not a general XML parser: this reads three well-known fields out
 * of a document that can exceed 400 KB (the real `PLAW-118publ42` record is
 * ~469 KB) and ignores everything else. No funding amount is read, and none
 * could be used if it were — discovery cannot assert dollars.
 */
export function parseModsMetadata(xml: string): ModsMetadata {
  // Everything before the first relatedItem is about THIS document. A title
  // inside a relatedItem describes a different one - the bill a report
  // accompanies, or a U.S. Code citation - and using it would misclassify.
  const relatedItemAt = xml.search(/<relatedItem\b/i);
  const ownScope = relatedItemAt === -1 ? xml : xml.slice(0, relatedItemAt);

  const clean = (raw: string): string => decodeXmlEntities(raw).replace(/\s+/g, ' ').trim();

  const rawTitle = MODS_TITLE_PATTERN.exec(ownScope)?.[1] ?? null;
  const title = rawTitle === null ? null : clean(rawTitle);

  const alternativeTitles: string[] = [];
  for (const match of ownScope.matchAll(MODS_ALT_TITLE_PATTERN)) {
    const candidate = clean(match[1] ?? '');
    if (candidate === '' || candidate === title) continue;
    // A pure bill designator identifies the document; it does not describe it.
    if (BILL_DESIGNATOR_TITLE.test(candidate)) continue;
    if (!alternativeTitles.includes(candidate)) alternativeTitles.push(candidate);
  }

  const congressRaw = MODS_CONGRESS_PATTERN.exec(xml)?.[1];
  const congress = congressRaw ? Number(congressRaw) : null;

  const years = new Set<number>();
  for (const candidate of [title, ...alternativeTitles]) {
    if (!candidate) continue;
    for (const match of candidate.matchAll(/\b(?:fiscal year|FY)\s*(\d{4})\b/gi)) {
      const year = Number(match[1]);
      if (year >= 1900 && year <= 2200) years.add(year);
    }
    // "DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2024" names its year without
    // any "fiscal year" phrase; the appropriations wording is the evidence.
    for (const match of candidate.matchAll(/APPROPRIATIONS\s+(?:BILL|ACT)[, ]+\s*(\d{4})\b/gi)) {
      const year = Number(match[1]);
      if (year >= 1900 && year <= 2200) years.add(year);
    }
    // "for the fiscal year ending September 30, 2024"
    for (const match of candidate.matchAll(/fiscal year ending\s+\w+\s+\d{1,2},\s*(\d{4})\b/gi)) {
      const year = Number(match[1]);
      if (year >= 1900 && year <= 2200) years.add(year);
    }
  }

  return Object.freeze({
    title,
    alternativeTitles: Object.freeze(alternativeTitles),
    congress: congress !== null && Number.isFinite(congress) ? congress : null,
    declaredFiscalYears: Object.freeze([...years].sort((left, right) => left - right)),
  });
}

/**
 * Plausible congress numbers for a fiscal year.
 *
 * A fiscal year's authorization and appropriations work is done by the congress
 * sitting in the preceding calendar year, but a supplemental or a late omnibus
 * can land in the following one. Both are allowed; anything further away is not,
 * which is what keeps a `BILLS_2023` sitemap of 13,354 entries from being
 * considered wholesale.
 */
export function plausibleCongressesForFiscalYear(fiscalYear: number): readonly number[] {
  // The 1st Congress convened in 1789; congress N covers 1789 + 2*(N-1).
  const congressOf = (calendarYear: number): number =>
    Math.floor((calendarYear - 1789) / 2) + 1;
  const primary = congressOf(fiscalYear - 1);
  const next = congressOf(fiscalYear);
  return Object.freeze([...new Set([primary, next])].sort((left, right) => left - right));
}
