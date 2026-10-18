import type { Request } from 'express';

const PREVIEW_HOST = 'first-chat-preview.app-dev.capiro.ai';
const PREVIEW_GET_PATH = /^\/api\/(?:me|clients(?:\/[^/?]+)?)\/?$/i;

export function previewNativeReadMode(enabled: boolean, host: unknown): 'ordinary' | 'preview' | 'unavailable' {
  const isPreviewHost = typeof host === 'string' && host.toLowerCase() === PREVIEW_HOST;
  if (!enabled && !isPreviewHost) return 'ordinary';
  return enabled && isPreviewHost ? 'preview' : 'unavailable';
}

/** Match only routes handled by the three preview GET methods, before query parsing. */
export function isPreviewNativeReadRoute(req: Request): boolean {
  // Express may dispatch HEAD through a registered GET controller. Its
  // middleware authority must be just as strict even though ALB forwards GET.
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  // Express dispatches from its parsed path. In particular an absolute-form
  // request target can reach a GET handler while originalUrl starts with http.
  const rawPath = (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
  return PREVIEW_GET_PATH.test(req.path) || PREVIEW_GET_PATH.test(rawPath);
}
