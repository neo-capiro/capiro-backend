import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

export const INTERNAL_AUTH_VERSION = 'capiro-internal-v1';

export const INTERNAL_AUTH_HEADERS = {
  caller: 'x-capiro-service',
  timestamp: 'x-capiro-timestamp',
  nonce: 'x-capiro-nonce',
  contentSha256: 'x-capiro-content-sha256',
  signature: 'x-capiro-signature',
} as const;

export interface InternalAuthClaims {
  readonly caller: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly method: string;
  readonly pathWithQuery: string;
  readonly contentSha256: string;
}

export interface InternalAuthVerificationInput extends InternalAuthClaims {
  readonly signature: string;
  readonly secret: string;
  readonly nowMs?: number;
  readonly maxSkewSeconds: number;
}

export type InternalAuthVerification =
  | { readonly ok: true; readonly signedPayload: string }
  | { readonly ok: false; readonly reason: string };

export function sha256Hex(body: string | Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

function cleanSingleLine(value: string, field: string): string {
  const cleaned = value.trim();
  if (!cleaned || cleaned.includes('\n') || cleaned.includes('\r')) {
    throw new TypeError(`${field} must be a non-empty single-line value`);
  }
  return cleaned;
}

export function canonicalInternalAuthPayload(claims: InternalAuthClaims): string {
  const caller = cleanSingleLine(claims.caller, 'caller');
  const timestamp = cleanSingleLine(claims.timestamp, 'timestamp');
  const nonce = cleanSingleLine(claims.nonce, 'nonce');
  const method = cleanSingleLine(claims.method, 'method').toUpperCase();
  const pathWithQuery = cleanSingleLine(claims.pathWithQuery, 'pathWithQuery');
  const contentSha256 = cleanSingleLine(
    claims.contentSha256,
    'contentSha256',
  ).toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(contentSha256)) {
    throw new TypeError('contentSha256 must be a lowercase SHA-256 hex digest');
  }

  return [
    INTERNAL_AUTH_VERSION,
    caller,
    timestamp,
    nonce,
    method,
    pathWithQuery,
    contentSha256,
  ].join('\n');
}

export function signInternalRequest(
  claims: InternalAuthClaims,
  secret: string,
): string {
  if (secret.length < 32) {
    throw new TypeError('internal service secret must be at least 32 characters');
  }
  return createHmac('sha256', secret)
    .update(canonicalInternalAuthPayload(claims))
    .digest('hex');
}

function safeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyInternalRequest(
  input: InternalAuthVerificationInput,
): InternalAuthVerification {
  const timestampMs = Date.parse(input.timestamp);
  if (!Number.isFinite(timestampMs)) return { ok: false, reason: 'invalid_timestamp' };

  const nowMs = input.nowMs ?? Date.now();
  const skewMs = Math.abs(nowMs - timestampMs);
  if (skewMs > input.maxSkewSeconds * 1000) {
    return { ok: false, reason: 'timestamp_outside_window' };
  }

  let signedPayload: string;
  let expected: string;
  try {
    signedPayload = canonicalInternalAuthPayload(input);
    expected = signInternalRequest(input, input.secret);
  } catch {
    return { ok: false, reason: 'invalid_canonical_fields' };
  }

  if (!safeHexEqual(expected, input.signature)) {
    return { ok: false, reason: 'signature_mismatch' };
  }

  return { ok: true, signedPayload };
}
