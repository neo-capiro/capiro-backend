import type { AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { readEngagementPreviewMode } from './engagement-api-preview.js';

export const ENGAGEMENT_PREVIEW_ROUTE_MISS = 'ENGAGEMENT_PREVIEW_ROUTE_MISS';
export const ENGAGEMENT_PREVIEW_STALE_RESPONSE = 'ENGAGEMENT_PREVIEW_STALE_RESPONSE';
export const ENGAGEMENT_EXTERNAL_ACTION_DISABLED = 'ENGAGEMENT_EXTERNAL_ACTION_DISABLED';
export const ENGAGEMENT_PREVIEW_EXTERNAL_ACTION_MESSAGE =
  'This action is disabled in the Engagement API preview. No external action was taken.';

const EXPECTED_PREVIEW_SERVICE = 'engagement-api';
const ENGAGEMENT_REQUEST_MODE_MARKER = '__capiroEngagementRequestMode';

export type EngagementRequestMode = 'main' | 'preview';

type MarkedAxiosConfig = (AxiosRequestConfig | InternalAxiosRequestConfig) & {
  [ENGAGEMENT_REQUEST_MODE_MARKER]?: EngagementRequestMode;
};

type AxiosLikeError = Error & {
  code?: string;
  response?: AxiosResponse;
};

/**
 * Record the routing mode on every accepted Engagement request. Response
 * handling must use this dispatch-time marker: sessionStorage can change while
 * the request is in flight, but the request's owner cannot.
 */
export function markEngagementRequest(
  config: AxiosRequestConfig,
  mode: EngagementRequestMode,
): void {
  (config as MarkedAxiosConfig)[ENGAGEMENT_REQUEST_MODE_MARKER] = mode;
}

/** Compatibility helper retained for the 3.4 tests/callers. */
export function markEngagementPreviewRequest(config: AxiosRequestConfig): void {
  markEngagementRequest(config, 'preview');
}

export function engagementRequestMode(
  config: AxiosRequestConfig | undefined,
): EngagementRequestMode | undefined {
  return config ? (config as MarkedAxiosConfig)[ENGAGEMENT_REQUEST_MODE_MARKER] : undefined;
}

export function wasEngagementPreviewRequest(config: AxiosRequestConfig | undefined): boolean {
  return engagementRequestMode(config) === 'preview';
}

function responseHeader(response: AxiosResponse, name: string): string | undefined {
  const headers = response.headers as unknown as {
    get?: (headerName: string) => unknown;
    [key: string]: unknown;
  };
  const viaGet = typeof headers?.get === 'function' ? headers.get(name) : undefined;
  if (viaGet != null) return String(viaGet);

  const wanted = name.toLowerCase();
  const key = Object.keys(headers ?? {}).find((candidate) => candidate.toLowerCase() === wanted);
  return key ? String(headers[key]) : undefined;
}

export class EngagementPreviewRouteMissError extends Error {
  readonly code = ENGAGEMENT_PREVIEW_ROUTE_MISS;

  constructor() {
    super('Engagement API preview routing could not be verified. No preview result was accepted.');
    this.name = 'EngagementPreviewRouteMissError';
  }
}

export class EngagementPreviewStaleResponseError extends Error {
  readonly code = ENGAGEMENT_PREVIEW_STALE_RESPONSE;

  constructor() {
    super('An Engagement response completed after the runtime preview mode changed and was discarded.');
    this.name = 'EngagementPreviewStaleResponseError';
  }
}

/**
 * A preview response is useful as parity evidence only when it proves that it
 * came from engagement-api. Normal/main requests are deliberately untouched.
 */
export function assertEngagementPreviewResponseIdentity(response: AxiosResponse): void {
  if (!wasEngagementPreviewRequest(response.config)) return;
  const service = responseHeader(response, 'x-capiro-service');
  if (service !== EXPECTED_PREVIEW_SERVICE) {
    throw new EngagementPreviewRouteMissError();
  }
}

/**
 * Prevent an old-mode response from becoming new-mode React Query data. This is
 * independent of query cancellation: many existing queryFns do not consume the
 * AbortSignal, so the transport may still complete after a toggle.
 */
export function assertEngagementRequestModeCurrent(response: AxiosResponse): void {
  const dispatched = engagementRequestMode(response.config);
  if (!dispatched) return;
  const current: EngagementRequestMode =
    readEngagementPreviewMode() === 'v3' ? 'preview' : 'main';
  if (dispatched !== current) throw new EngagementPreviewStaleResponseError();
}

function exactServerCode(response: AxiosResponse | undefined): string | undefined {
  const data = response?.data;
  if (!data || typeof data !== 'object') return undefined;
  const code = (data as Record<string, unknown>).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Enforce identity on preview error responses and translate only the one
 * intentional shadow-runtime denial. A generic 503, callback denial, auth
 * error, transport failure, or any other server error keeps its existing
 * semantics. Old-mode error responses are discarded just like old-mode
 * successes so they cannot drive a new-mode cache or false UI state.
 */
export function normalizeEngagementPreviewError(error: unknown): unknown {
  const candidate = error as AxiosLikeError | null | undefined;
  const response = candidate?.response;
  if (!response || !engagementRequestMode(response.config)) return error;

  // A request that was actually preview-routed must prove its service identity
  // even if the operator toggled modes before the response returned.
  assertEngagementPreviewResponseIdentity(response);
  assertEngagementRequestModeCurrent(response);

  if (!wasEngagementPreviewRequest(response.config)) return error;
  if (exactServerCode(response) !== ENGAGEMENT_EXTERNAL_ACTION_DISABLED) return error;

  // Preserve the Axios error shape used by existing callers, but replace the
  // server-shadow wording with the fixed product copy. Do not carry the
  // server's action field into a user-visible payload.
  response.data = {
    statusCode: response.status,
    code: ENGAGEMENT_EXTERNAL_ACTION_DISABLED,
    message: ENGAGEMENT_PREVIEW_EXTERNAL_ACTION_MESSAGE,
  };
  if (candidate) {
    candidate.message = ENGAGEMENT_PREVIEW_EXTERNAL_ACTION_MESSAGE;
    candidate.code = ENGAGEMENT_EXTERNAL_ACTION_DISABLED;
  }
  return error;
}
