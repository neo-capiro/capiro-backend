import { mountedRequestPath } from './mounted-request-path.js';
import type { Request } from 'express';

const PREVIEW_HOST = 'first-chat-preview.app-dev.capiro.ai';
export const CORE_ROSTER_PREVIEW_HOST = 'core-roster-preview.capiro.ai';
const PREVIEW_GET_PATH = /^\/api\/(?:me|clients(?:\/[^/?]+)?|memory\/(?:candidates\/mine(?:\/[^/?]+\/status)?|owner\/items))\/?$/i;

export type CoreRosterPreviewDecision = 'unrelated' | 'preview' | 'unavailable' | 'not-found';

const CLIENT_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const CLIENT_RECORD_PATHS: Readonly<Record<string, RegExp>> = {
  GET: new RegExp(`^/api/(?:clients(?:/${CLIENT_ID}(?:/account-owners)?)?|client-account-owners(?:/options)?|billing/state)$`),
  POST: /^\/api\/clients$/,
  PUT: new RegExp(`^/api/clients/${CLIENT_ID}(?:/account-owners)?$`),
  DELETE: new RegExp(`^/api/clients/${CLIENT_ID}$`),
};

/** Native client records share the existing first-chat session owner. Canonical
 * nested routes use ordinary authentication; malformed native requests do not. */
export function firstChatClientPreviewDecision(req: Request, enabled: boolean): CoreRosterPreviewDecision {
  const target = req.originalUrl ?? req.url;
  const parsedPath = mountedRequestPath(req);
  const family = /^\/api\/(?:clients|client-account-owners|billing)(?:\/|$)/i;
  if (!family.test(parsedPath) && !(typeof target === 'string' && family.test(target.split('?')[0]!))) return 'unrelated';
  const rawHosts: string[] = [];
  for (let i = 0; i < (req.rawHeaders?.length ?? 0) - 1; i += 2) {
    if (req.rawHeaders[i]?.toLowerCase() === 'host') rawHosts.push(req.rawHeaders[i + 1]!);
  }
  const reserved = [req.headers.host, ...rawHosts, target].some(
    value => typeof value === 'string' && value.toLowerCase().includes(PREVIEW_HOST),
  );
  if (!enabled && !reserved) return 'unrelated';
  if (!enabled || !reserved) return 'unavailable';
  if (!Array.isArray(req.rawHeaders) || req.rawHeaders.length % 2 !== 0 || rawHosts.length !== 1 ||
      rawHosts[0] !== PREVIEW_HOST || req.headers.host !== PREVIEW_HOST ||
      typeof target !== 'string' || !target.startsWith('/')) return 'not-found';
  const queryStart = target.indexOf('?');
  const rawPath = queryStart === -1 ? target : target.slice(0, queryStart);
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  if (rawPath !== parsedPath ||
      !/^\/api\/(?:clients|client-account-owners|billing)(?:\/[a-z0-9_-]+)*$/.test(rawPath)) return 'not-found';
  if (!CLIENT_RECORD_PATHS[method]?.test(rawPath)) {
    // Keep alternate methods and malformed IDs on native handlers reserved.
    // Other canonical paths still pass through the ordinary tenant resolver;
    // this selector never authorizes their controllers or client operations.
    const nativePath = Object.values(CLIENT_RECORD_PATHS).some(pattern => pattern.test(rawPath));
    const nativeClient = ['GET', 'PUT', 'DELETE'].includes(method) &&
      /^\/api\/clients\/[^/]+(?:\/account-owners)?$/.test(rawPath);
    return nativePath || nativeClient ? 'not-found' : 'unrelated';
  }
  if (queryStart !== -1 && (method !== 'GET' || rawPath !== '/api/clients' ||
      !boundedRosterQuery(target.slice(queryStart + 1)))) return 'not-found';
  return 'preview';
}

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
