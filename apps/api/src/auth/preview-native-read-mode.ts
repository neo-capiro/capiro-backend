import type { Request } from 'express';

/** Express removes the mount prefix from req.path while middleware runs. */
function mountedRequestPath(req: Request): string {
  return (req.baseUrl ?? '') + (req.baseUrl && req.path === '/' ? '' : req.path);
}

const PREVIEW_HOST = 'first-chat-preview.app-dev.capiro.ai';
export const CORE_ROSTER_PREVIEW_HOST = 'core-roster-preview.capiro.ai';
const PREVIEW_GET_PATH = /^\/api\/(?:me|clients(?:\/[^/?]+)?|memory\/(?:candidates\/mine(?:\/[^/?]+\/status)?|owner\/items))\/?$/i;

export type CoreRosterPreviewDecision = 'unrelated' | 'preview' | 'unavailable' | 'not-found';

/**
 * The roster origin is a separate, exact Host authority. Inspect raw Host
 * headers as well as Node's normalized first value: Node may discard a second
 * Host from req.headers, but it remains visible in rawHeaders. A malformed
 * spelling of this reserved Host must never enter ordinary tenant resolution.
 */
export function coreRosterPreviewDecision(
  req: Request,
  enabled: boolean,
  nativeGetsEnabled: boolean,
): CoreRosterPreviewDecision {
  const rawHosts: string[] = [];
  if (Array.isArray(req.rawHeaders)) {
    for (let i = 0; i < req.rawHeaders.length - 1; i += 2) {
      if (req.rawHeaders[i]?.toLowerCase() === 'host') rawHosts.push(req.rawHeaders[i + 1]!);
    }
  }
  const parsedHost = req.headers.host;
  const target = req.originalUrl ?? req.url;
  // An absolute-form target can name the roster origin while the Host header
  // names Portfolio. Express may still dispatch its parsed /api/clients path;
  // reserve that authority claim before any ordinary Host can be considered.
  const targetAuthority = typeof target === 'string'
    ? /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)/i.exec(target)?.[1]
    : undefined;
  const isReserved = [parsedHost, ...rawHosts].some(
    (value) => typeof value === 'string' && value.toLowerCase().includes(CORE_ROSTER_PREVIEW_HOST),
  ) || (typeof targetAuthority === 'string' &&
    targetAuthority.toLowerCase().includes(CORE_ROSTER_PREVIEW_HOST));
  if (!isReserved) return 'unrelated';
  if (!Array.isArray(req.rawHeaders) || req.rawHeaders.length % 2 !== 0 ||
      rawHosts.length !== 1 || rawHosts[0] !== CORE_ROSTER_PREVIEW_HOST ||
      parsedHost !== CORE_ROSTER_PREVIEW_HOST) return 'not-found';
  if (!enabled || !nativeGetsEnabled) return 'unavailable';

  // Do not let Express' parsed route turn an absolute-form, encoded, trailed,
  // or otherwise ambiguous request target into the roster GET controller.
  if (req.method !== 'GET' || typeof target !== 'string' || !target.startsWith('/')) return 'not-found';
  const queryStart = target.indexOf('?');
  const rawPath = queryStart === -1 ? target : target.slice(0, queryStart);
  if (rawPath !== '/api/clients' || mountedRequestPath(req) !== rawPath) return 'not-found';
  if (queryStart !== -1 && !boundedRosterQuery(target.slice(queryStart + 1))) return 'not-found';
  return 'preview';
}

/** Bound the only accepted query keys before Express' query parser and DTO. */
function boundedRosterQuery(raw: string): boolean {
  if (Buffer.byteLength(raw, 'utf8') > 512 || raw.includes('#') || /%(?![0-9a-fA-F]{2})/.test(raw)) return false;
  const seen = new Set<string>();
  for (const [key, value] of new URLSearchParams(raw)) {
    if (!['profileStatus', 'sectorTag', 'includeArchived'].includes(key) ||
        seen.has(key) || value.length > 160) return false;
    seen.add(key);
  }
  return true;
}

export function previewNativeReadMode(
  enabled: boolean,
  host: unknown,
  rosterEnabled = false,
): 'ordinary' | 'preview' | 'unavailable' {
  // The composed task still serves the original first-chat Host. Native GETs
  // under every other Host remain unavailable, exactly as on the parent task.
  // Its additional roster Host is admitted only by coreRosterPreviewDecision,
  // which checks the complete request before this legacy mode is consulted.
  if (rosterEnabled) {
    if (typeof host === 'string' && host.toLowerCase() === PREVIEW_HOST) {
      return enabled ? 'preview' : 'unavailable';
    }
    return 'unavailable';
  }
  if (typeof host === 'string' && host.toLowerCase().includes(CORE_ROSTER_PREVIEW_HOST)) {
    return 'unavailable';
  }
  const isPreviewHost = typeof host === 'string' && host.toLowerCase() === PREVIEW_HOST;
  if (!enabled && !isPreviewHost) return 'ordinary';
  return enabled && isPreviewHost ? 'preview' : 'unavailable';
}

/** Match only routes handled by the preview GET methods, before query parsing. */
export function isPreviewNativeReadRoute(req: Request): boolean {
  // Express may dispatch HEAD through a registered GET controller. Its
  // middleware authority must be just as strict even though ALB forwards GET.
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  // Express dispatches from its parsed path. In particular an absolute-form
  // request target can reach a GET handler while originalUrl starts with http.
  const rawPath = (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
  return PREVIEW_GET_PATH.test(mountedRequestPath(req)) || PREVIEW_GET_PATH.test(rawPath);
}
