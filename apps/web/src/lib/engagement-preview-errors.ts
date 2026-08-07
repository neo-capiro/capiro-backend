import type { AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios';

export const ENGAGEMENT_PREVIEW_ROUTE_MISS = 'ENGAGEMENT_PREVIEW_ROUTE_MISS';
export const ENGAGEMENT_EXTERNAL_ACTION_DISABLED = 'ENGAGEMENT_EXTERNAL_ACTION_DISABLED';
export const ENGAGEMENT_PREVIEW_EXTERNAL_ACTION_MESSAGE =
  'This action is disabled in the Engagement API preview. No external action was taken.';

const EXPECTED_PREVIEW_SERVICE = 'engagement-api';
const PREVIEW_REQUEST_MARKER = '__capiroEngagementPreviewRequest';

type MarkedAxiosConfig = (AxiosRequestConfig | InternalAxiosRequestConfig) & {
  [PREVIEW_REQUEST_MARKER]?: true;
};

type AxiosLikeError = Error & {
  code?: string;
  response?: AxiosResponse;
};

/**
 * Record the routing decision on the request itself. Response handling must use
 * this marker rather than reading the current session mode: an in-flight preview
 * request is still a preview request even if the operator turns preview off
 * before the response arrives.
 */
export function markEngagementPreviewRequest(config: AxiosRequestConfig): void {
  (config as MarkedAxiosConfig)[PREVIEW_REQUEST_MARKER] = true;
}

export function wasEngagementPreviewRequest(config: AxiosRequestConfig | undefined): boolean {
  return Boolean(config && (config as MarkedAxiosConfig)[PREVIEW_REQUEST_MARKER] === true);
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
 * semantics.
 */
export function normalizeEngagementPreviewError(error: unknown): unknown {
  const candidate = error as AxiosLikeError | null | undefined;
  const response = candidate?.response;
  if (!response || !wasEngagementPreviewRequest(response.config)) return error;

  assertEngagementPreviewResponseIdentity(response);

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
