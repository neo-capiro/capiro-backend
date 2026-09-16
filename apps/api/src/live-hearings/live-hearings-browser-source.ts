/**
 * Browser-source selection for the Phase 7 browser join plan.
 *
 * Regression being repaired: `browserJoinPlan` handed the browser session the
 * Congress.gov event-LISTING url (`hearing.url`), which carries no playable
 * media. The pre-regression UI resolved a playable Senate ISVP / House /
 * committee source before creating the session. This module restores that by
 * choosing the browser source from already-discovered `hearing_stream_candidate`
 * rows.
 *
 * Selection rules (deliberate, and asserted by live-hearings-browser-source.spec):
 *
 *  1. Genuine official PLAYER/watch pages rank above central LISTING pages
 *     regardless of stored candidate order: Senate ISVP, House live, committee
 *     sites, and Florida chamber watch pages (florida-senate / florida-house)
 *     are players; Congress.gov event pages and generic calendars are listings.
 *  2. The browser session opens the STABLE official page. Fresh media is
 *     resolved at session creation/refresh by the existing intel-api resolver —
 *     a stored `media_url` is NOT handed out here, because it may be an expired
 *     signed/CDN URL.
 *  3. `hearing.url` (Congress.gov / official event listing) is only a
 *     last-resort fallback, and never an api.* URL.
 *  4. A server-side `capture_policy` (including BLOCKED) is NOT a blanket
 *     browser deny: it governs server ingest, not the user opening a public
 *     official page. Only the public-visibility check and the separate
 *     stateCapturePolicy browser gate restrict browser join.
 *  5. Only public http(s) pages are usable — javascript:, data:, or malformed
 *     URLs are rejected. Nothing is fabricated from a title.
 */

export interface BrowserSourceCandidate {
  provider: string;
  officialPageUrl: string;
  mediaUrl?: string | null;
  capturePolicy: string;
}

export interface BrowserSourceChoice {
  sourceUrl: string;
  sourceKind: 'official_player_page' | 'official_listing_page';
  sourceProvider: string | null;
}

/** Providers whose official page is a real player/watch surface, not a listing. */
const PLAYER_PROVIDERS = new Set([
  'senate-isvp',
  'house-live',
  'house-repository',
  'committee-cdn',
  'committee-site',
  'committee-rss',
  'committee-api',
  'committee-headless',
  'florida-senate',
  'florida-house',
]);

/** Hosts that are central event LISTINGS, never a playable player page. */
const LISTING_HOST = /(^|\.)(congress\.gov|api\.congress\.gov)$/i;

function isApiMetadataUrl(url: string): boolean {
  return /^https?:\/\/api[.]/i.test(url.trim());
}

/** True only for a public http(s) page URL — rejects javascript:/data:/garbage. */
function isPublicPageUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:';
}

function isListingUrl(url: string): boolean {
  try {
    return LISTING_HOST.test(new URL(url.trim()).hostname);
  } catch {
    return false;
  }
}

function isPlayerCandidate(candidate: BrowserSourceCandidate, page: string): boolean {
  // A known central LISTING host is never a player, whatever the provider
  // string claims — a mislabeled committee-site row pointing at Congress.gov
  // must not outrank a genuine Senate/House player page.
  if (isListingUrl(page)) return false;
  if (PLAYER_PROVIDERS.has((candidate.provider ?? '').toLowerCase())) return true;
  // A first-party page that is not a known central listing still counts as a
  // player/committee surface even if the provider string is unrecognized.
  return true;
}

/**
 * Choose the browser source for one public hearing from its stored stream
 * candidates plus its official listing url. Returns null when there is no
 * usable public page at all.
 */
export function selectBrowserSource(input: {
  hearingUrl: string | null;
  candidates: BrowserSourceCandidate[];
}): BrowserSourceChoice | null {
  // Rank candidates: genuine player pages first, listings last, independent of
  // stored order. Within a tier the stored priority order is preserved.
  const usable = input.candidates
    .map((candidate) => ({ candidate, page: (candidate.officialPageUrl ?? '').trim() }))
    .filter(
      ({ page }) => page && isPublicPageUrl(page) && !isApiMetadataUrl(page),
    );

  const players = usable.filter(({ candidate, page }) => isPlayerCandidate(candidate, page));

  // 1. First genuine official player/watch page.
  const player = players[0];
  if (player) {
    return {
      sourceUrl: player.page,
      sourceKind: 'official_player_page',
      sourceProvider: player.candidate.provider ?? null,
    };
  }

  // 2. A stored listing candidate (e.g. a Congress.gov candidate row) is no
  //    better than the hearing's own listing url; fall through to hearing.url.

  // 3. Last resort: the official listing page (e.g. Congress.gov event page),
  //    never an api.* metadata URL.
  const listing = (input.hearingUrl ?? '').trim();
  if (listing && isPublicPageUrl(listing) && !isApiMetadataUrl(listing)) {
    return {
      sourceUrl: listing,
      sourceKind: 'official_listing_page',
      sourceProvider: null,
    };
  }

  return null;
}
