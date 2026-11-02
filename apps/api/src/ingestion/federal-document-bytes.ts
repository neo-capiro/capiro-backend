import { createHash } from 'node:crypto';
export const FEDERAL_DOCUMENT_MAX_BYTES = 30_000_000;
export type FederalOriginalBytes = { base64: string; sha256: string; mime: string };
export const byteHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Body consumption shares the request deadline and checks actual streamed bytes, not just headers. */
export async function readFederalBytes(response: Response, signal: AbortSignal): Promise<Buffer> {
  if (Number(response.headers.get('content-length') ?? 0) > FEDERAL_DOCUMENT_MAX_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw Error('FEDERAL_DOCUMENT_SIZE_LIMIT');
  }
  if (!response.body) throw Error('FEDERAL_DOCUMENT_BODY_UNAVAILABLE');
  const reader = response.body.getReader();
  const parts: Buffer[] = [];
  let total = 0;
  let rejectAbort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const abort = () => rejectAbort(Error('FEDERAL_DOCUMENT_DEADLINE'));
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw Error('FEDERAL_DOCUMENT_DEADLINE');
    for (;;) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > FEDERAL_DOCUMENT_MAX_BYTES) throw Error('FEDERAL_DOCUMENT_SIZE_LIMIT');
      parts.push(Buffer.from(next.value));
    }
    return Buffer.concat(parts, total);
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
  }
}
export function decodeFederalUtf8(bytes: Buffer, mime: string): string {
  const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(mime)?.[1]?.toLowerCase();
  if (charset && !['utf-8', 'utf8', 'us-ascii'].includes(charset))
    throw Error('FEDERAL_DOCUMENT_CHARSET_UNSUPPORTED');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw Error('FEDERAL_DOCUMENT_ENCODING_UNSUPPORTED');
  }
  const declared = /^\s*<\?xml[^>]*encoding\s*=\s*["']([^"']+)/i.exec(text)?.[1]?.toLowerCase();
  if (declared && !['utf-8', 'utf8', 'us-ascii'].includes(declared))
    throw Error('FEDERAL_DOCUMENT_CHARSET_UNSUPPORTED');
  return text;
}
export function qualifyFederalOriginal(raw: string, original: FederalOriginalBytes) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(original.base64) || original.base64.length > 40_000_000)
    throw Error('FEDERAL_ORIGINAL_ENCODING_INVALID');
  const bytes = Buffer.from(original.base64, 'base64');
  if (
    !bytes.length ||
    bytes.length > FEDERAL_DOCUMENT_MAX_BYTES ||
    byteHash(bytes) !== original.sha256
  )
    throw Error('FEDERAL_ORIGINAL_HASH_MISMATCH');
  if (decodeFederalUtf8(bytes, original.mime) !== raw)
    throw Error('FEDERAL_ORIGINAL_DECODE_MISMATCH');
  return {
    parserVersion: `fed-exact-v1:bytes:${Buffer.from(original.sha256, 'hex').toString('base64url')}`,
    metadata: {
      originalBytesBase64: original.base64,
      rawBytesHash: original.sha256,
      originalMime: original.mime,
      originalBytesEncoding: 'UTF-8',
    },
  };
}
