export type MeriArtifactAuthHeaders = () => Promise<Record<string, string>>;
export type MeriDocumentExportFormat = 'docx' | 'pdf';

const DOCUMENT_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};
const ARTIFACT_ID = /^[a-zA-Z0-9_-]{1,200}$/;
export const MAX_MERI_DOCUMENT_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get('Content-Length');
  let declaredLength: number | null = null;
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_MERI_DOCUMENT_DOWNLOAD_BYTES) {
      throw new Error('The downloaded document was empty or too large. Please retry.');
    }
    declaredLength = length;
  }
  if (!response.body) throw new Error('The server did not return readable document bytes. Please retry.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > MAX_MERI_DOCUMENT_DOWNLOAD_BYTES) {
        await reader.cancel();
        throw new Error('The downloaded document was too large. Please retry.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!total) throw new Error('The downloaded document was empty. Please retry.');
  if (declaredLength !== null && total !== declaredLength) {
    throw new Error('The downloaded document was incomplete. Please retry.');
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', arrayBufferCopy(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function arrayBufferCopy(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}


/** Older model replies wrapped this protected app route in a sandbox alias.
 * Accept that exact alias only; it never names a file, host or fetch target. */
export function canonicalMeriArtifactSandboxUrl(href: string): string | null {
  const match = /^sandbox:(\/api\/clio\/artifacts\/[a-zA-Z0-9_-]{1,200}\/download(?:\?format=(?:pdf|docx))?)$/.exec(href);
  return match?.[1] ?? null;
}

export interface MeriSavedDocumentArtifact {
  id: string;
  title: string;
  kind: string;
  bodyText: string;
}

/** Preserve only canonical saved document rows from history or artifact SSE. */
export function readMeriSavedDocumentArtifact(value: unknown): MeriSavedDocumentArtifact | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const artifact = value as Record<string, unknown>;
  if (typeof artifact.id !== 'string' || !ARTIFACT_ID.test(artifact.id) ||
    typeof artifact.kind !== 'string' || !['word_document', 'pdf_document', 'excel_workbook', 'powerpoint_deck'].includes(artifact.kind) ||
    typeof artifact.bodyText !== 'string') return null;
  return {
    id: artifact.id, kind: artifact.kind, bodyText: artifact.bodyText,
    title: typeof artifact.title === 'string' && artifact.title.trim() ? artifact.title.trim() : 'Document',
  };
}

/** Recognize only the canonical route on this app or its configured API. The
 * model's link is never used as an authenticated fetch destination. */
export function meriArtifactDownloadFromUrl(href: string | undefined, apiBaseUrl: string): { artifactId: string; format?: string } | null {
  if (!href) return null;
  try {
    const url = new URL(canonicalMeriArtifactSandboxUrl(href) ?? href, window.location.origin);
    const api = new URL(apiBaseUrl || window.location.origin, window.location.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (url.origin !== window.location.origin && url.origin !== api.origin) return null;
    // Only the requested export format has meaning on this route. The fetch
    // helper validates it before reconstructing a fresh authenticated URL.
    const match = /^\/api\/clio\/artifacts\/([a-zA-Z0-9_-]{1,200})\/download$/.exec(url.pathname);
    if (!match) return null;
    const formats = url.searchParams.getAll('format');
    return { artifactId: match[1]!, ...(formats.length ? { format: formats.length === 1 ? formats[0] : '' } : {}) };
  } catch {
    return null;
  }
}

export function meriArtifactIdFromDownloadUrl(href: string | undefined, apiBaseUrl: string): string | null {
  return meriArtifactDownloadFromUrl(href, apiBaseUrl)?.artifactId ?? null;
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
  artifactId, apiBaseUrl, getAuthHeaders, signal, fallbackFilename, expectedFormat, format,
}: {
  artifactId: string;
  apiBaseUrl: string;
  getAuthHeaders?: MeriArtifactAuthHeaders;
  signal: AbortSignal;
  fallbackFilename?: string;
  expectedFormat?: string;
  format?: string;
}): Promise<{ blob: Blob; filename: string }> {
  if (!ARTIFACT_ID.test(artifactId)) throw new Error('This document does not have a valid saved identity.');
  if (format !== undefined && format !== 'pdf' && format !== 'docx') {
    throw new Error('This document cannot be downloaded in the requested format. Choose Word or PDF.');
  }
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
  const url = `${apiBaseUrl.replace(/\/$/, '')}/api/clio/artifacts/${artifactId}/download${format ? `?format=${format}` : ''}`;
  let response: Response;
  try {
    response = await fetch(url, { headers, signal, cache: 'no-store', redirect: 'error' });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof TypeError) {
      throw new Error('The network connection failed. Check your connection and retry the download.');
    }
    throw error;
  }
  if (!response.ok) {
    if (response.status === 401) throw new Error('Your sign-in expired. Sign in again, then retry the download.');
    if (response.status === 403 || response.status === 404) {
      throw new Error('This document is unavailable or you no longer have access to it.');
    }
    // Only known error codes become user-facing guidance; never show an
    // arbitrary server body, exception detail or an error payload as a file.
    if (response.status === 400 || response.status === 422) {
      const error = await response.json().catch(() => null);
      if (error?.code === 'MERI_DOCUMENT_FORMAT_UNSUPPORTED') {
        throw new Error('This document cannot be downloaded in the requested format. Choose another available format.');
      }
      if (error?.code === 'MERI_DOCUMENT_RENDER_FAILED') {
        const label = (format ?? expectedFormat ?? (error.format === 'pdf' ? 'pdf' : undefined)) === 'pdf' ? 'PDF' : 'Word document';
        const failure = format ? `The ${label} conversion failed.` : `The ${label} could not be generated.`;
        if (error.reason === 'unsupported_text') throw new Error(`${failure} Some characters are unsupported. Download Word to preserve the full text.`);
        if (error.reason === 'document_too_large') throw new Error(`${failure} The document is too large. Ask Meri to split it into smaller documents.`);
        if (error.reason === 'invalid_image') throw new Error(`${failure} An embedded image could not be included. Ask Meri to check the chart or download Word.`);
        throw new Error(`${failure} Retry or download the other format.`);
      }
    }
    throw new Error('The document could not be downloaded. Please retry.');
  }
  const contentType = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  const extension = DOCUMENT_TYPES[contentType];
  const requestedFormat = format ?? expectedFormat;
  if (!extension || (requestedFormat && extension !== requestedFormat)) {
    throw new Error('The server did not return the expected document. Please retry.');
  }
  if (response.headers.get('X-Capiro-Artifact-Id') !== artifactId) {
    throw new Error('The server returned a different saved document. Please retry.');
  }
  const expectedSha256 = response.headers.get('X-Capiro-Artifact-Sha256')?.toLowerCase() ?? '';
  if (!SHA256_HEX.test(expectedSha256)) {
    throw new Error('The server did not return a document integrity receipt. Please retry.');
  }
  const bytes = await readBoundedResponse(response, signal);
  signal.throwIfAborted();
  if (await sha256Hex(bytes) !== expectedSha256) {
    throw new Error('The downloaded document did not match its integrity receipt. Please retry.');
  }
  const blob = new Blob([arrayBufferCopy(bytes)], { type: contentType });
  const filename = safeFilename(filenameFromDisposition(response.headers.get('Content-Disposition')), extension)
    ?? safeFilename(fallbackFilename, extension)
    ?? `document.${extension}`;
  return { blob, filename };
}
