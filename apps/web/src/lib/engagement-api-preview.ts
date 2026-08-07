/**
 * Engagement API preview activation and request scoping (Phase 3, 3.3).
 *
 * An internal, session-scoped switch that routes ONLY Engagement API requests
 * through the dark `engagement-api` service by adding
 * `X-Capiro-Engagement-Preview: v3`. Off by default; nothing in the ordinary
 * product path reads or writes it, and with the mode off `api-client.ts`
 * behaves exactly as it did before Phase 3.
 *
 *   sessionStorage key   capiro.engagement-api-preview
 *   allowed value        v3
 *   activation query     ?engagement-api-preview=v3
 *   deactivation query   ?engagement-api-preview=off
 *
 * Session-scoped, not local-scoped, on purpose: the mode must not survive into
 * a new tab the user opens later, and 3.9 compares main and preview in separate
 * browser contexts.
 *
 * This file and its spec are the only places in apps/web permitted to name the
 * preview header; `scripts/verify-engagement-web-no-preview-header.mjs` keeps
 * every other file honest.
 */
import { ENGAGEMENT_PREVIEW_ROUTE_PATTERNS } from './engagement-api-preview-routes.generated.js';

export type EngagementApiPreviewMode = 'off' | 'v3';

export const ENGAGEMENT_PREVIEW_STORAGE_KEY = 'capiro.engagement-api-preview';
export const ENGAGEMENT_PREVIEW_QUERY_PARAM = 'engagement-api-preview';
export const ENGAGEMENT_PREVIEW_HEADER = 'X-Capiro-Engagement-Preview';
export const ENGAGEMENT_PREVIEW_HEADER_VALUE = 'v3';

/**
 * The one value that turns the preview on. Anything else — 'V3', 'true', '1',
 * an empty string, a stray value left by a future feature — fails closed to
 * 'off'. Preview routing is never inferred.
 */
const ACTIVE_VALUE: EngagementApiPreviewMode = 'v3';
const DEACTIVATION_VALUE = 'off';

const COMPILED_ROUTE_PATTERNS: readonly RegExp[] = ENGAGEMENT_PREVIEW_ROUTE_PATTERNS.map(
  (source) => new RegExp(source),
);

function sessionStore(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage;
  } catch {
    // Storage can throw on access under strict privacy settings. Treat an
    // unreadable store as "preview off" rather than letting it break the app.
    return null;
  }
}

/** Current mode. Off unless sessionStorage holds exactly `v3`. */
export function readEngagementPreviewMode(): EngagementApiPreviewMode {
  const store = sessionStore();
  if (!store) return 'off';
  try {
    return store.getItem(ENGAGEMENT_PREVIEW_STORAGE_KEY) === ACTIVE_VALUE ? ACTIVE_VALUE : 'off';
  } catch {
    return 'off';
  }
}

export function isEngagementPreviewActive(): boolean {
  return readEngagementPreviewMode() === ACTIVE_VALUE;
}

export function activateEngagementPreview(): void {
  const store = sessionStore();
  if (!store) return;
  try {
    store.setItem(ENGAGEMENT_PREVIEW_STORAGE_KEY, ACTIVE_VALUE);
  } catch {
    /* non-fatal: preview simply stays off */
  }
}

export function clearEngagementPreview(): void {
  const store = sessionStore();
  if (!store) return;
  try {
    store.removeItem(ENGAGEMENT_PREVIEW_STORAGE_KEY);
  } catch {
    /* non-fatal */
  }
}

export interface PreviewActivationResult {
  /** Mode after applying the query parameter. */
  mode: EngagementApiPreviewMode;
  /** True when the parameter was present and has been consumed. */
  changed: boolean;
  /**
   * The search string with ONLY the activation parameter removed, in its
   * original order, `?`-prefixed, or '' when nothing remains. Every other
   * parameter — meeting IDs, detail tabs, dates, report filters, client
   * filters — is preserved byte-for-byte.
   */
  nextSearch: string;
}

/**
 * Read and consume the activation parameter from a location search string.
 *
 * Pure with respect to the URL: it returns the rewritten search rather than
 * touching history, so the caller decides how to apply it (a replace, never a
 * push — activation must not add a back-button step).
 */
export function consumePreviewActivation(search: string): PreviewActivationResult {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (!params.has(ENGAGEMENT_PREVIEW_QUERY_PARAM)) {
    return { mode: readEngagementPreviewMode(), changed: false, nextSearch: search };
  }

  const raw = params.get(ENGAGEMENT_PREVIEW_QUERY_PARAM);
  // Remove every occurrence — a duplicated parameter must not leave one behind.
  params.delete(ENGAGEMENT_PREVIEW_QUERY_PARAM);

  if (raw === ACTIVE_VALUE) {
    activateEngagementPreview();
  } else if (raw === DEACTIVATION_VALUE) {
    clearEngagementPreview();
  }
  // Any other value: consumed and ignored. The mode is left exactly as it was,
  // so an unknown value can neither turn the preview on nor silently turn a
  // running preview off.

  const rest = params.toString();
  return {
    mode: readEngagementPreviewMode(),
    changed: true,
    nextSearch: rest ? `?${rest}` : '',
  };
}

/**
 * Resolve an axios request URL to a pathname.
 *
 * Handles both forms the app produces: a relative `/api/engagement/...` (the
 * overwhelmingly common case, resolved against the axios baseURL) and a fully
 * qualified URL. Returns null when the URL cannot be resolved, which callers
 * treat as "not an Engagement request" — failing closed means at worst a
 * preview request goes to main and is caught by 3.4's service-identity check,
 * never that the header leaks to an unknown owner.
 */
export function resolveRequestPath(url: string | undefined, baseUrl?: string): string | null {
  if (!url) return null;
  try {
    // A base is required for relative URLs. The literal below is never used as
    // an origin — only its pathname is read back out.
    const base = baseUrl && /^https?:\/\//i.test(baseUrl) ? baseUrl : 'http://relative.invalid';
    return new URL(url, base).pathname;
  } catch {
    return null;
  }
}

/**
 * True when the request targets a route in the accepted Engagement route
 * manifest. Exact, anchored matching against the generated pattern list — not
 * a prefix test, which would also match `/api/engagement-something-else`.
 */
export function isEngagementApiRequest(url: string | undefined, baseUrl?: string): boolean {
  const pathname = resolveRequestPath(url, baseUrl);
  if (!pathname) return false;
  // Tolerate a trailing slash on an otherwise exact match; the manifest stores
  // paths unslashed and axios callers occasionally add one.
  const normalized =
    pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return COMPILED_ROUTE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * The header pair to attach, or null. Returns null whenever the mode is off or
 * the request is not an accepted Engagement route, so callers never have to
 * decide.
 */
export function engagementPreviewHeader(
  url: string | undefined,
  baseUrl?: string,
): { name: string; value: string } | null {
  if (!isEngagementPreviewActive()) return null;
  if (!isEngagementApiRequest(url, baseUrl)) return null;
  return { name: ENGAGEMENT_PREVIEW_HEADER, value: ENGAGEMENT_PREVIEW_HEADER_VALUE };
}
