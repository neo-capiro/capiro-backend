import { createHash } from 'node:crypto';

/** Captured fetch response-body bytes after HTTP transport decoding, not compressed wire frames. */
export interface FederalSourceCapture {
  version: 'federal-source-capture/1';
  representation: 'response-body';
  format: 'xml' | 'txt' | 'htm';
  mediaType: string | null;
  encoding: 'utf-8';
  byteLength: number;
  sha256: string;
  utf8RoundTrip: true;
}
export const FEDERAL_CAPTURE_VERSION = 'federal-source-capture/1';
const keys = [
  'version',
  'representation',
  'format',
  'mediaType',
  'encoding',
  'byteLength',
  'sha256',
  'utf8RoundTrip',
];
const reject = (): never => {
  throw new Error('FEDERAL_SOURCE_CAPTURE_INVALID');
};

export function assertFederalSourceCapture(raw: string, value: unknown): FederalSourceCapture {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject();
  const v = value as Record<string, unknown>;
  const bytes = Buffer.from(raw, 'utf8');
  if (
    Object.keys(v).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(v, key)) ||
    v.version !== FEDERAL_CAPTURE_VERSION ||
    v.representation !== 'response-body' ||
    !['xml', 'txt', 'htm'].includes(v.format as string) ||
    v.encoding !== 'utf-8' ||
    v.utf8RoundTrip !== true ||
    !bytes.length ||
    bytes.length > 30_000_000 ||
    bytes.toString('utf8') !== raw ||
    raw.includes('\0') ||
    v.byteLength !== bytes.length ||
    v.sha256 !== createHash('sha256').update(bytes).digest('hex') ||
    !(
      v.mediaType === null ||
      (typeof v.mediaType === 'string' && v.mediaType.length <= 256 && !/[\r\n]/.test(v.mediaType))
    )
  )
    return reject();
  const charset = (v.mediaType as string | null)?.match(
    /(?:^|;)\s*charset\s*=\s*["']?([^\s;"']+)/i,
  )?.[1];
  const declaration =
    v.format === 'xml'
      ? raw.match(/^\uFEFF?\s*<\?xml\s[^?]*\bencoding\s*=\s*['"]([^'"]+)['"]/i)?.[1]
      : undefined;
  if (
    (charset !== undefined && !/^utf-8$/i.test(charset)) ||
    (declaration !== undefined && !/^utf-8$/i.test(declaration))
  )
    return reject();
  return value as FederalSourceCapture;
}

/** One bounded reader; strict UTF-8 preserves the BOM and proves TEXT can retain these exact bytes. */
export async function captureFederalResponse(
  response: Response,
  format: FederalSourceCapture['format'],
  maxBytes = 30_000_000,
) {
  const mediaType = response.headers.get('content-type');
  const charset = mediaType?.match(/(?:^|;)\s*charset\s*=\s*["']?([^\s;"']+)/i)?.[1];
  const declared = response.headers.get('content-length');
  const reader = response.body?.getReader();
  if (!reader) return reject();
  let done = false;
  try {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 30_000_000 ||
      (mediaType !== null && (mediaType.length > 256 || /[\r\n]/.test(mediaType))) ||
      (charset !== undefined && !/^utf-8$/i.test(charset)) ||
      (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))
    )
      return reject();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) {
        done = true;
        break;
      }
      length += part.value.byteLength;
      if (length > maxBytes) return reject();
      chunks.push(part.value);
    }
    const bytes = Buffer.concat(chunks, length);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!Buffer.from(text, 'utf8').equals(bytes)) return reject();
    const capture: FederalSourceCapture = {
      version: FEDERAL_CAPTURE_VERSION,
      representation: 'response-body',
      format,
      mediaType,
      encoding: 'utf-8',
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      utf8RoundTrip: true,
    };
    assertFederalSourceCapture(text, capture);
    return { text, capture };
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
