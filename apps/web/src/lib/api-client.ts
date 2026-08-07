import axios, { type AxiosInstance } from 'axios';
import { config } from '../env.js';
import { clearImpersonationSlug } from '../state/impersonation.js';
import {
  engagementPreviewHeader,
  isEngagementApiRequest,
} from './engagement-api-preview.js';
import { markEngagementResponseData } from './engagement-preview-cache.js';
import {
  assertEngagementPreviewResponseIdentity,
  assertEngagementRequestModeCurrent,
  engagementRequestMode,
  markEngagementRequest,
  normalizeEngagementPreviewError,
} from './engagement-preview-errors.js';

/**
 * Default timeout for ordinary requests (auth, lists, CRUD). Kept tight so a
 * genuinely hung request fails fast.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * AI content-generation endpoints legitimately run 60-120s+ server-side (the
 * backend AI calls themselves allow up to 90s, chat 120s). The browser MUST
 * outlast the server or it aborts first and the user sees a spurious timeout.
 * 175s mirrors the outreach wizard's proven ceiling and stays under the ALB
 * idle timeout. Streaming chat/research use fetch() (not axios) and are not
 * bounded by this.
 */
export const GENERATION_TIMEOUT_MS = 175_000;

/**
 * URL fragments that identify a long-running AI generation request. Any axios
 * call whose URL matches gets GENERATION_TIMEOUT_MS unless the caller passed an
 * explicit per-request timeout. Centralizing this here fixes every generation
 * call site at once (and any future one) instead of per-call overrides.
 */
const GENERATION_URL_PATTERNS: RegExp[] = [
  /generate/i, // generate-document, generate-section, generate-batch, actions/generate
  /ai-fill/i,
  /ai-enhance/i,
  /artifacts/i, // POST .../artifacts (artifact generation)
  /extract-text/i, // attachment text extraction / transcription
  /clio\/research/i, // deep-research create / clarify (non-stream POSTs)
  /workspace\/assistant/i, // in-editor Meri assistant: bounded multi-round tool loop on Sonnet, runs well past 30s on a "thinking" turn
  /comments\/[^/]+\/suggest/i, // "Let Meri draft an edit": single AI rewrite, can exceed 30s
];

export function isGenerationUrl(url: string | undefined): boolean {
  if (!url) return false;
  return GENERATION_URL_PATTERNS.some((pattern) => pattern.test(url));
}

/**
 * Build an axios instance bound to the Clerk getToken() callback. The token
 * uses the `capiro` JWT template so requests carry capiro_tenant_id /
 * capiro_tenant_slug claims. Pass an optional `actAsTenantSlug` to attach
 * the impersonation header (only honored server-side for capiro_admin).
 */
export function buildApiClient(
  getToken: () => Promise<string | null>,
  actAsTenantSlug?: string,
): AxiosInstance {
  const instance = axios.create({
    baseURL: config.apiBaseUrl,
    timeout: DEFAULT_TIMEOUT_MS,
  });
  instance.interceptors.request.use(async (req) => {
    // Give AI generation endpoints a long timeout, but never override an
    // explicit per-request timeout (anything that isn't the instance default).
    if (req.timeout === DEFAULT_TIMEOUT_MS && isGenerationUrl(req.url)) {
      req.timeout = GENERATION_TIMEOUT_MS;
    }

    const token = await getToken();
    if (token) {
      req.headers = req.headers ?? {};
      req.headers.Authorization = `Bearer ${token}`;
    }
    // Never attach the impersonation header to the Capiro Admin console itself
    // (tenant list, start/end impersonation). Those must always run as the
    // admin's real context; otherwise a stale slug 403s the very requests
    // needed to start or end impersonation, locking the admin out.
    const url = req.url ?? '';
    const isAdminConsole = url.includes('/capiro-admin/');
    if (actAsTenantSlug && !isAdminConsole) {
      req.headers = req.headers ?? {};
      req.headers['x-capiro-impersonate-tenant'] = actAsTenantSlug;
    }

    // Engagement API preview (Phase 3). Off by default and, when on, attached
    // only to paths that exactly match the accepted Engagement route manifest.
    // That exact match is what keeps the header off /me, Capiro Admin,
    // Workspace, Strategy, Directory and static assets — none of their paths
    // are in the manifest, so no per-owner allowlist is needed here and none
    // can drift out of date. Attached last so it can never displace the
    // Authorization or impersonation headers set above.
    const engagementRequest = isEngagementApiRequest(req.url, config.apiBaseUrl);
    const preview = engagementPreviewHeader(req.url, config.apiBaseUrl);
    if (preview) {
      req.headers = req.headers ?? {};
      req.headers[preview.name] = preview.value;
    }
    if (engagementRequest) {
      // Persist what was ACTUALLY sent. A mode toggle cannot rewrite an
      // in-flight routing decision, so response/cache handling uses this marker
      // instead of guessing from the current sessionStorage value.
      markEngagementRequest(req, preview ? 'preview' : 'main');
    }
    return req;
  });
  // If the server reports the impersonation session is gone (expired/ended),
  // drop the stale slug and reload so the app falls back to the real context
  // instead of 403-looping every request.
  instance.interceptors.response.use(
    (res) => {
      assertEngagementPreviewResponseIdentity(res);
      assertEngagementRequestModeCurrent(res);
      if (engagementRequestMode(res.config)) markEngagementResponseData(res.data);
      return res;
    },
    (error) => {
      const status = error?.response?.status;
      const msg = String(error?.response?.data?.message ?? '');
      if (status === 403 && /impersonation session/i.test(msg)) {
        clearImpersonationSlug();
        if (typeof window !== 'undefined') window.location.reload();
      }
      // Keep the existing impersonation recovery above first and untouched.
      // Only after that path has seen the original error do we enforce preview
      // service identity, dispatch-mode freshness, and the exact intentional
      // shadow-denial translation.
      return Promise.reject(normalizeEngagementPreviewError(error));
    },
  );
  return instance;
}
