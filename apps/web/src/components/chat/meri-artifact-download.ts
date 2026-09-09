export type MeriArtifactAuthHeaders = () => Promise<Record<string, string>>;

const OFFICE_TYPES: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};
const ARTIFACT_ID = /^[a-zA-Z0-9_-]{1,200}$/;

/** Recognize only the canonical route on this app or its configured API. The
 * model's link is never used as an authenticated fetch destination. */
export function meriArtifactIdFromDownloadUrl(href: string | undefined, apiBaseUrl: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, window.location.origin);
    const api = new URL(apiBaseUrl || window.location.origin, window.location.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (url.origin !== window.location.origin && url.origin !== api.origin) return null;
    // Model-added query/fragment decoration has no meaning on this route;
    // discard it rather than navigating to a protected URL without auth.
    const match = /^\/api\/clio\/artifacts\/([a-zA-Z0-9_-]{1,200})\/download$/.exec(url.pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function filenameFromDisposition(value: string | null): string | undefined {
  if (!value) return undefined;
  const encoded = /(?:^|;)\s*filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded.trim()); } catch { /* try the ordinary filename */ }
  }
  return /(?:^|;)\s*filename="([^"]+)"/i.exec(value)?.[1]
    ?? /(?:^|;)\s*filename=([^;]+)/i.exec(value)?.[1]?.trim();
}

function safeFilename(value: string | undefined, extension: string): string | undefined {
  const filename = value?.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return filename && filename.length <= 200 && filename.toLowerCase().endsWith(`.${extension}`)
    ? filename
    : undefined;
}

/** Keep the browser's object URL alive long enough to start the download.
 * Synchronous revocation can cancel downloads in some browsers. */
export function saveMeriDownloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

export async function fetchMeriArtifactDownload({
  artifactId, apiBaseUrl, getAuthHeaders, signal, fallbackFilename, expectedFormat,
}: {
  artifactId: string;
  apiBaseUrl: string;
  getAuthHeaders?: MeriArtifactAuthHeaders;
  signal: AbortSignal;
  fallbackFilename?: string;
  expectedFormat?: string;
}): Promise<{ blob: Blob; filename: string }> {
  if (!ARTIFACT_ID.test(artifactId)) throw new Error('This document does not have a valid saved identity.');
  if (!getAuthHeaders) throw new Error('Sign in again, then retry the download.');
  signal.throwIfAborted();
  const headers = await new Promise<Record<string, string>>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Download cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    // Auth is not fetch and does not consume AbortSignal. Bound it explicitly
    // so a stalled token provider cannot leave Downloading stuck forever.
    Promise.resolve().then(getAuthHeaders).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
  signal.throwIfAborted();
  if (!new Headers(headers).get('Authorization')?.trim()) {
    throw new Error('Sign in again, then retry the download.');
  }
  const url = `${apiBaseUrl.replace(/\/$/, '')}/api/clio/artifacts/${artifactId}/download`;
  const response = await fetch(url, { headers, signal, cache: 'no-store', redirect: 'error' });
  if (!response.ok) {
    if (response.status === 401) throw new Error('Your sign-in expired. Sign in again, then retry the download.');
    if (response.status === 403 || response.status === 404) {
      throw new Error('This document is unavailable or you no longer have access to it.');
    }
    throw new Error('The document could not be downloaded. Please retry.');
  }
  const contentType = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  const extension = OFFICE_TYPES[contentType];
  if (!extension || (expectedFormat && extension !== expectedFormat)) {
    throw new Error('The server did not return the expected document. Please retry.');
  }
  const blob = await response.blob();
  signal.throwIfAborted();
  if (!blob.size) throw new Error('The downloaded document was empty. Please retry.');
  const filename = safeFilename(filenameFromDisposition(response.headers.get('Content-Disposition')), extension)
    ?? safeFilename(fallbackFilename, extension)
    ?? `document.${extension}`;
  return { blob, filename };
}
