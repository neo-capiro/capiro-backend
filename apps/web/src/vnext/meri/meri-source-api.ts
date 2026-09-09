import { config } from '../../env.js';
import type { MeriSourceLocator } from '@capiro/shared';
import type { MeriCitation } from '../../components/chat/chat-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function normalizeMeriSourceLocator(value: unknown): MeriSourceLocator | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (!['email', 'client', 'memory', 'document'].includes(String(row.kind)) || typeof row.recordId !== 'string' || !UUID.test(row.recordId)) return undefined;
  const result: MeriSourceLocator = { kind: row.kind as MeriSourceLocator['kind'], recordId: row.recordId };
  for (const field of ['threadId', 'clientId'] as const) if (typeof row[field] === 'string' && UUID.test(row[field])) result[field] = row[field];
  for (const field of ['section', 'observedAt', 'version'] as const) if (typeof row[field] === 'string' && row[field].length <= 200) result[field] = row[field];
  return result;
}

export function meriSourceLocator(citation: MeriCitation): MeriSourceLocator | undefined {
  const explicit = normalizeMeriSourceLocator(citation.source);
  if (explicit) return explicit;
  if (!UUID.test(citation.id)) return undefined;
  if (['get_email_thread', 'search_emails', 'list_emails'].includes(citation.tool) || citation.type === 'email') return { kind: 'email', recordId: citation.id };
  if (citation.tool === 'search_memory' || citation.type === 'memory') return { kind: 'memory', recordId: citation.id };
  // Only a client UUID itself is safe for old profile citations. Child-record
  // IDs are never interpreted as the currently selected client; lookup may 404.
  if (citation.tool === 'get_client_context' || citation.type === 'client') return { kind: 'client', recordId: citation.id };
  return undefined;
}

export interface MeriFullSource {
  kind: MeriSourceLocator['kind'];
  status: 'available' | 'record_navigation' | 'unavailable';
  recordId: string;
  title?: string;
  location?: string;
  text?: string;
  notice?: string;
  versionStatus?: 'current_version_only' | 'changed_since_citation' | 'matches_cited_version';
  currentVersion?: string;
  sourceVersion?: string;
  updatedAt?: string;
  nextCursor?: string | null;
  totalMessages?: number;
  section?: number;
  sectionCount?: number;
  sectionLabel?: string;
  contentStatus?: string;
  governance?: Record<string, unknown>;
  truncated?: boolean;
  disclosure?: string;
  readability?: { status?: string; note?: string };
  message?: {
    id: string; threadId: string; subject: string; from: { email: string; name?: string | null };
    to: unknown; cc: unknown; sentAt?: string | null; receivedAt?: string | null;
    bodyText: string; offset: number; endOffset: number; bodyLength: number;
    bodyCompleteness: string; messageNumber: number;
  } | null;
}

export class MeriSourceReadError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export async function readMeriSource(
  locator: MeriSourceLocator,
  getAuthHeaders: () => Promise<Record<string, string>>,
  cursor?: string,
  signal?: AbortSignal,
): Promise<MeriFullSource> {
  const params = new URLSearchParams({ kind: locator.kind, recordId: locator.recordId });
  for (const field of ['threadId', 'clientId', 'section', 'version'] as const) if (locator[field]) params.set(field, locator[field]);
  if (cursor) params.set('cursor', cursor);
  const request = new AbortController();
  const abort = () => request.abort(signal?.reason ?? new Error('Source read cancelled.'));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(() => request.abort(new Error('The source read timed out. Retry to continue.')), 60_000);
  try {
    request.signal.throwIfAborted();
    const headers = await new Promise<Record<string, string>>((resolve, reject) => {
      const cancelled = () => reject(request.signal.reason ?? new Error('Source read cancelled.'));
      request.signal.addEventListener('abort', cancelled, { once: true });
      Promise.resolve().then(getAuthHeaders).then(resolve, reject).finally(() => request.signal.removeEventListener('abort', cancelled));
    });
    request.signal.throwIfAborted();
    if (!new Headers(headers).get('Authorization')?.trim()) throw new MeriSourceReadError(401, 'Sign in again, then retry this source.');
    const response = await fetch(`${config.apiBaseUrl.replace(/\/$/, '')}/api/clio/sources?${params}`, {
      headers, signal: request.signal, redirect: 'error', cache: 'no-store',
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({})) as { error?: string };
      const notReady = typeof detail.error === 'string' && /^(ATTACHMENT_|SCAN_|CONTENT_TYPE_)/.test(detail.error);
      const message = notReady ? 'The source is not ready to read. It may still be processing or be blocked by document policy.'
        : response.status === 401 ? 'Your sign-in expired. Sign in again, then retry this source.'
        : response.status === 403 ? 'Access to this source is denied.'
        : response.status === 404 ? 'This source was deleted, is no longer active, or you no longer have access.'
        : response.status === 409 || response.status === 422 ? 'The source is not ready to read. It may still be processing or be blocked by document policy.'
        : response.status === 400 ? 'The source changed or this continuation is no longer valid. Restart the source read.'
        : 'The source is temporarily unavailable. Retry to read it.';
      throw new MeriSourceReadError(response.status, message);
    }
    const result = await response.json() as MeriFullSource;
    request.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (request.signal.aborted) throw request.signal.reason;
    throw error;
  } finally { window.clearTimeout(timeout); signal?.removeEventListener('abort', abort); }

}

/** Source links are navigation only; never turn an arbitrary citation into an
 * authenticated API request or an executable URL. */
export function safeMeriSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (/^\/clients\?clientId=[0-9a-f-]{36}(?:&tab=documents)?$/i.test(value)) return value;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}
