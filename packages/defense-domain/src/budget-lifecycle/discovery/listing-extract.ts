/**
 * Phase 8 Session 8 — link extraction for index-page and feed adapters.
 *
 * Nine of the fourteen registered adapters publish through an HTML index page
 * (the comptroller, the three service comptrollers, HASC, SASC, both
 * appropriations committees, and the reprogramming page) and one through a news
 * feed. None of them offers a sitemap or a key-free API, so discovery there is
 * link extraction over a page we were given permission to read.
 *
 * The rules that keep that safe are the same ones the manifest adapter enforced:
 *
 *  * Only absolute HTTPS links on the requesting adapter's own official hosts
 *    survive. A relative link is resolved against the page URL first, so a
 *    redirect to a third-party mirror cannot smuggle a host in.
 *  * Document extensions are emitted by default. A publisher may explicitly opt
 *    into bounded extensionless download paths. An index page is mostly navigation,
 *    and a crawler that treated every anchor as a candidate would spend its
 *    budget on menus.
 *  * Output is deduplicated and sorted, so the same page always yields the same
 *    candidate list in the same order.
 *
 * Anchor text is captured because for these publishers it is the only title-like
 * evidence available — there is no MODS record behind an `.xlsx` exhibit on
 * `asafm.army.mil`. It is a discovery hint, and it is passed to resolution as a
 * title exactly like GovInfo's MODS title, with the same fail-closed handling if
 * it proves insufficient.
 */

/** Extensions that can carry an official budget document. */
export const DOCUMENT_EXTENSIONS: readonly string[] = Object.freeze([
  '.pdf',
  '.xlsx',
  '.xls',
  '.xlsm',
  '.csv',
  '.docx',
  '.doc',
  '.zip',
  '.txt',
  '.xml',
]);

export interface ExtractedLink {
  readonly url: string;
  /** Visible anchor text, collapsed. Empty string when the anchor had none. */
  readonly text: string;
}

const ANCHOR_PATTERN =
  /<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>([\s\S]*?)<\/a>/gi;

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gi, '&');
}

function collapseText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasDocumentExtension(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return DOCUMENT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Extract candidate document links from an HTML listing.
 *
 * `officialHosts` is the requesting adapter's own host list; a link anywhere else
 * is discarded here and would be refused again by the registry downstream.
 */
export function extractDocumentLinks(input: {
  html: string;
  /** Absolute URL the HTML was retrieved from, used to resolve relative links. */
  pageUrl: string;
  officialHosts: readonly string[];
  /** Optional extra path constraint, e.g. only `/Portals/45/Documents/defbudget`. */
  requiredPathPrefixes?: readonly string[];
  /** Explicit publisher opt-in; default extraction remains extension-only. */
  extensionlessDocumentPathPrefixes?: readonly string[];
}): readonly ExtractedLink[] {
  const hosts = new Set(input.officialHosts);
  const byUrl = new Map<string, ExtractedLink>();

  for (const match of input.html.matchAll(ANCHOR_PATTERN)) {
    const rawHref = match[2] ?? match[3] ?? match[4];
    if (!rawHref) continue;

    const href = decodeEntities(rawHref).trim();
    if (href === '' || href.startsWith('#')) continue;
    if (/^(?:mailto|javascript|tel|data):/i.test(href)) continue;

    let resolved: URL;
    try {
      resolved = new URL(href, input.pageUrl);
    } catch {
      continue;
    }

    if (resolved.protocol !== 'https:') continue;
    if (!hosts.has(resolved.hostname)) continue;
    const extensionlessDocument =
      input.extensionlessDocumentPathPrefixes?.some(
        (prefix) =>
          resolved.pathname.startsWith(prefix) &&
          /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(resolved.pathname) &&
          resolved.pathname.length > prefix.length &&
          !resolved.pathname.endsWith('/'),
      ) === true;
    if (!hasDocumentExtension(resolved.pathname) && !extensionlessDocument) continue;

    if (
      input.requiredPathPrefixes &&
      input.requiredPathPrefixes.length > 0 &&
      !input.requiredPathPrefixes.some((prefix) =>
        resolved.pathname.toLowerCase().startsWith(prefix.toLowerCase()),
      )
    ) {
      continue;
    }

    // Fragments never identify a different document.
    resolved.hash = '';
    const url = resolved.toString();
    const text = collapseText(match[5] ?? '');

    const existing = byUrl.get(url);
    // Prefer the anchor that actually carried text; an icon link often has none.
    if (!existing || (existing.text === '' && text !== '')) {
      byUrl.set(url, Object.freeze({ url, text }));
    }
  }

  return Object.freeze(
    [...byUrl.values()].sort((left, right) =>
      left.url < right.url ? -1 : left.url > right.url ? 1 : 0,
    ),
  );
}

export interface FeedItem {
  readonly url: string;
  readonly title: string;
  readonly publishedAt: string | null;
}

const FEED_ITEM_PATTERN = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
const FEED_LINK_PATTERN =
  /<link\b[^>]*?href\s*=\s*"([^"]+)"[^>]*\/?>|<link>\s*([^<]+?)\s*<\/link>/i;
const FEED_TITLE_PATTERN = /<title\b[^>]*>\s*([\s\S]*?)\s*<\/title>/i;
const FEED_DATE_PATTERN =
  /<(?:pubDate|published|updated)\b[^>]*>\s*([^<]+?)\s*<\/(?:pubDate|published|updated)>/i;

/**
 * Extract items from an RSS or Atom feed.
 *
 * Used by the contract-announcement adapter, whose output is explicitly a signal
 * reference and never a funding assertion.
 */
export function extractFeedItems(input: {
  xml: string;
  officialHosts: readonly string[];
}): readonly FeedItem[] {
  const hosts = new Set(input.officialHosts);
  const byUrl = new Map<string, FeedItem>();

  for (const match of input.xml.matchAll(FEED_ITEM_PATTERN)) {
    const body = match[2] ?? '';
    const linkMatch = FEED_LINK_PATTERN.exec(body);
    const rawLink = linkMatch?.[1] ?? linkMatch?.[2];
    if (!rawLink) continue;

    let resolved: URL;
    try {
      resolved = new URL(decodeEntities(rawLink).trim());
    } catch {
      continue;
    }
    if (resolved.protocol !== 'https:') continue;
    if (!hosts.has(resolved.hostname)) continue;

    resolved.hash = '';
    const url = resolved.toString();
    if (byUrl.has(url)) continue;

    const rawDate = FEED_DATE_PATTERN.exec(body)?.[1];
    const parsedDate = rawDate ? Date.parse(rawDate) : Number.NaN;

    byUrl.set(
      url,
      Object.freeze({
        url,
        title: collapseText(FEED_TITLE_PATTERN.exec(body)?.[1] ?? ''),
        publishedAt: Number.isNaN(parsedDate) ? null : new Date(parsedDate).toISOString(),
      }),
    );
  }

  return Object.freeze(
    [...byUrl.values()].sort((left, right) =>
      left.url < right.url ? -1 : left.url > right.url ? 1 : 0,
    ),
  );
}
