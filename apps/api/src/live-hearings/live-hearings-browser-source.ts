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
  id?: string;
  provider: string;
  officialPageUrl: string;
  mediaUrl?: string | null;
  capturePolicy: string;
  priority?: number;
  updatedAt?: Date | string | null;
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
  // The Florida Channel's exact per-event video page (…/videos/<slug>/) is a
  // real browser player. The /videos/ archive INDEX is a listing and is never
  // recorded as a candidate, so membership here is safe.
  'florida-channel',
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
  return (
    (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
    !parsed.username &&
    !parsed.password
  );
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


const SIGNED_QUERY =
  /^(?:token|sig|signature|expires?|policy|key-pair-id|x-amz-.+|auth|auth_token|access_token|jwt|hdnea|hdnts)$/i;
const DIRECT_MEDIA_PATH = /\.(?:m3u8|mp[34]|m4a|aac|wav|webm|ts|mov|flv|mkv)(?:$|\/)/i;
const RESERVED_FLORIDA_CHANNEL_SLUG = /^(?:feed|rss|page|category|tag|author|wp-json)$/i;

function stripTrailingSlash(pathname: string): string {
  if (pathname === '/') return pathname;
  return pathname.replace(/\/+$/, '') || '/';
}

function isPrivateOrNonPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.test')
  )
    return true;
  if (host.includes(':')) return true;
  const parts = host.split('.');
  if (parts.length === 4 && parts.every((part) => /^\d+$/.test(part))) {
    const octets = parts.map(Number);
    if (octets.some((value) => value < 0 || value > 255)) return true;
    const a = octets[0] ?? 256;
    const b = octets[1] ?? 256;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  return false;
}

/**
 * Canonical identity for an external official page. It is intentionally
 * conservative: HTTPS only, no credentials or non-standard port, no fragment,
 * and one representation for trailing-slash equivalents.
 */
export function canonicalOfficialExternalUrl(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (isPrivateOrNonPublicHost(url.hostname)) return null;
    url.hash = '';
    url.pathname = stripTrailingSlash(url.pathname);
    return url.toString();
  } catch {
    return null;
  }
}

function exactFloridaChannelEvent(url: URL): boolean {
  if (url.hostname.toLowerCase() !== 'thefloridachannel.org') return false;
  const match = /^\/videos\/([^/]+)\/?$/i.exec(url.pathname);
  return Boolean(match?.[1] && !RESERVED_FLORIDA_CHANNEL_SLUG.test(match[1]));
}

function subdomainOf(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function providerHostAllowed(provider: string, url: URL): boolean {
  const host = url.hostname.toLowerCase();
  switch (provider.toLowerCase()) {
    case 'senate-isvp':
    case 'committee-site':
    case 'committee-rss':
    case 'committee-api':
    case 'committee-headless':
      return subdomainOf(host, 'senate.gov') || subdomainOf(host, 'house.gov');
    case 'house-live':
    case 'house-repository':
      return subdomainOf(host, 'house.gov');
    case 'florida-senate':
      return subdomainOf(host, 'flsenate.gov') || exactFloridaChannelEvent(url);
    case 'florida-house':
      return subdomainOf(host, 'flhouse.gov') || exactFloridaChannelEvent(url);
    case 'florida-channel':
      return exactFloridaChannelEvent(url);
    case 'youtube':
    case 'youtube-live':
      return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com');
    case 'congress-gov':
      return subdomainOf(host, 'congress.gov') && !host.startsWith('api.');
    default:
      return false;
  }
}

function fallbackOfficialHostAllowed(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    ['congress.gov', 'senate.gov', 'house.gov', 'flsenate.gov', 'flhouse.gov'].some((domain) =>
      subdomainOf(host, domain),
    ) || exactFloridaChannelEvent(url)
  );
}

/**
 * Public serialization boundary for official source/Watch/Replay links.
 * Returns a stable publisher HTML page only; direct media, signed/authenticated
 * links, local/private hosts and unknown providers are omitted.
 */
export function strictOfficialSourceUrl(
  value: string | null | undefined,
  provider: string | null = null,
): string | null {
  const canonical = canonicalOfficialExternalUrl(value);
  if (!canonical) return null;
  const url = new URL(canonical);
  if (url.hostname.toLowerCase().startsWith('api.')) return null;
  if (DIRECT_MEDIA_PATH.test(url.pathname)) return null;
  if ([...url.searchParams.keys()].some((key) => SIGNED_QUERY.test(key))) return null;
  if (provider ? !providerHostAllowed(provider, url) : !fallbackOfficialHostAllowed(url)) return null;
  return canonical;
}

function deterministicCandidates(candidates: BrowserSourceCandidate[]): BrowserSourceCandidate[] {
  const timestamp = (value: Date | string | null | undefined) => {
    if (value instanceof Date) return value.getTime();
    if (typeof value !== 'string') return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...candidates].sort((left, right) => {
    const priority = (left.priority ?? 100) - (right.priority ?? 100);
    if (priority) return priority;
    const updated = timestamp(right.updatedAt) - timestamp(left.updatedAt);
    if (updated) return updated;
    return (left.id ?? '').localeCompare(right.id ?? '');
  });
}

export function officialUrlsEquivalent(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const a = canonicalOfficialExternalUrl(left);
  const b = canonicalOfficialExternalUrl(right);
  return Boolean(a && b && a === b);
}

/** Choose one safe external Watch/Replay link without exposing media URLs. */
export function selectOfficialPlaybackSource(input: {
  hearingUrl: string | null;
  candidates: BrowserSourceCandidate[];
}): BrowserSourceChoice | null {
  for (const candidate of deterministicCandidates(input.candidates)) {
    // Capture policy governs Capiro recording/transcription, not whether a user
    // may open a stable public publisher page. Link visibility therefore stays
    // independent of BLOCKED, LICENSE_REQUIRED, or any future capture policy.
    const sourceUrl = strictOfficialSourceUrl(candidate.officialPageUrl, candidate.provider);
    if (!sourceUrl) continue;
    return {
      sourceUrl,
      sourceKind: isListingUrl(sourceUrl) ? 'official_listing_page' : 'official_player_page',
      sourceProvider: candidate.provider,
    };
  }
  const sourceUrl = strictOfficialSourceUrl(input.hearingUrl);
  if (!sourceUrl) return null;
  return {
    sourceUrl,
    sourceKind: 'official_listing_page',
    sourceProvider: null,
  };
}
