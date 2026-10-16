import { createHash } from 'node:crypto';
import { CanonicalApplicationError } from '../planner/objective-canonical-application.js';
import { generationSha256, generationUuid, parseAcceptedRunBinding } from './objective-canonical-generation.js';
import type { CanonicalRetainedResultBridge, CanonicalRetainedResultSource } from './objective-canonical-result-owner.js';

export const RETAINED_RESULT_READ_PATH = '/v1/internal/objective-generation/retained-result/read';
export const RETAINED_RESULT_READ_MAX_BYTES = 4 * 1024 * 1024;
export const CORE_RETAINED_RESULT_READER_SUBJECT = 'capiro-objective-core-result-reader:v1';
const DEADLINE_MS = 3_000;

/** The named workload credential owner must bind its authorization to every
 * field here. Meri must independently verify the signed claims and hash the
 * received body bytes; this Core-side callback is not itself authentication. */
export interface RetainedResultCredentialRequest {
  readonly subject: typeof CORE_RETAINED_RESULT_READER_SUBJECT;
  readonly method: 'POST';
  readonly path: typeof RETAINED_RESULT_READ_PATH;
  readonly bodySha256: string;
  readonly source: Readonly<CanonicalRetainedResultSource>;
  readonly expiresAtMs: number;
}

export interface RetainedResultCredential {
  readonly authorization: string;
  readonly expiresAtMs: number;
}

export interface RetainedResultWorkloadCredentialOwner {
  readonly name: string;
  authorize(request: RetainedResultCredentialRequest): Promise<RetainedResultCredential>;
  recheck(request: RetainedResultCredentialRequest, credential: RetainedResultCredential): Promise<boolean>;
}

export interface RetainedResultHttpBridgeOptions {
  /** An HTTPS origin only, with no path, query, fragment, or user info. */
  readonly origin: string;
  /** Must be the named owner of the fixed Core retained-reader subject. */
  readonly credentialOwner: RetainedResultWorkloadCredentialOwner;
  /** Dependency injection for a focused transport test; production uses fetch. */
  readonly fetchImpl?: typeof fetch;
}

const unavailable = (): never => { throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE'); };

function fixedOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' ||
        url.search || url.hash || url.origin !== raw.replace(/\/$/, '')) return null;
    return url.origin;
  } catch { return null; }
}

function credentialValid(value: RetainedResultCredential, expiry: number): boolean {
  return typeof value?.authorization === 'string' && value.authorization.length > 0 &&
    value.authorization.length <= 4_096 && /^Bearer [A-Za-z0-9._~+/-]+=*$/.test(value.authorization) &&
    Number.isSafeInteger(value.expiresAtMs) && value.expiresAtMs > Date.now() && value.expiresAtMs <= expiry;
}

/** A source-only transport. No Nest provider or credential is installed here;
 * composition must supply a named owner and a fixed HTTPS Meri origin. */
export class ObjectiveCanonicalRetainedHttpBridge implements CanonicalRetainedResultBridge {
  private readonly origin: string | null;
  private readonly options: RetainedResultHttpBridgeOptions;

  constructor(options: RetainedResultHttpBridgeOptions) {
    this.options = options;
    this.origin = fixedOrigin(options?.origin);
  }

  available(): boolean {
    const owner = this.options?.credentialOwner;
    return this.origin !== null && owner?.name === CORE_RETAINED_RESULT_READER_SUBJECT &&
      typeof owner.authorize === 'function' && typeof owner.recheck === 'function';
  }

  async read(source: CanonicalRetainedResultSource, options: { signal: AbortSignal }): Promise<unknown> {
    if (!this.available() || !(options?.signal instanceof AbortSignal) || options.signal.aborted) return unavailable();
    const controller = new AbortController();
    const expiresAtMs = Date.now() + DEADLINE_MS;
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
    const signal = AbortSignal.any([options.signal, controller.signal]);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new CanonicalApplicationError('AUTHORITY_UNAVAILABLE'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      if (signal.aborted) return unavailable();
      return await Promise.race([this.readBound(source, expiresAtMs, signal), aborted]);
    } catch { return unavailable(); }
    finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  private async readBound(source: CanonicalRetainedResultSource, expiresAtMs: number,
    signal: AbortSignal): Promise<unknown> {
    const binding = parseAcceptedRunBinding(source.binding);
    const pinned = Object.freeze({ generationJobId: generationUuid(source.generationJobId), binding,
      sourceAdmissionSha256: generationSha256(source.sourceAdmissionSha256) });
    const body = JSON.stringify({ schemaVersion: 1, source: pinned });
    const bodySha256 = createHash('sha256').update(body, 'utf8').digest('hex');
    const request = Object.freeze({ subject: CORE_RETAINED_RESULT_READER_SUBJECT,
      method: 'POST' as const, path: RETAINED_RESULT_READ_PATH,
      bodySha256, source: pinned, expiresAtMs });
    const owner = this.options.credentialOwner;
    const issued = await owner.authorize(request);
    const credential = Object.freeze({ authorization: issued?.authorization, expiresAtMs: issued?.expiresAtMs });
    if (signal.aborted || Date.now() >= expiresAtMs || !credentialValid(credential, expiresAtMs) ||
        await owner.recheck(request, credential) !== true || signal.aborted ||
        !credentialValid(credential, expiresAtMs)) return unavailable();

    const url = this.origin + RETAINED_RESULT_READ_PATH;
    const response = await (this.options.fetchImpl ?? fetch)(url, {
      method: 'POST', redirect: 'error', credentials: 'omit', signal,
      headers: { 'content-type': 'application/json', accept: 'application/json',
        'cache-control': 'no-store', authorization: credential.authorization }, body,
    });
    if (signal.aborted || Date.now() >= expiresAtMs || response.status !== 200 || response.redirected ||
        (response.url !== '' && response.url !== url) ||
        !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '') || !response.body)
      return unavailable();
    const advertised = response.headers.get('content-length');
    if (advertised !== null && (!/^(?:0|[1-9][0-9]*)$/.test(advertised) ||
        Number(advertised) > RETAINED_RESULT_READ_MAX_BYTES)) return unavailable();

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (signal.aborted || Date.now() >= expiresAtMs) return unavailable();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > RETAINED_RESULT_READ_MAX_BYTES) return unavailable();
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const json = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
    const result: unknown = JSON.parse(json);
    if (signal.aborted || Date.now() >= expiresAtMs || !credentialValid(credential, expiresAtMs) ||
        await owner.recheck(request, credential) !== true || signal.aborted ||
        !credentialValid(credential, expiresAtMs)) return unavailable();
    return result;
  }
}
