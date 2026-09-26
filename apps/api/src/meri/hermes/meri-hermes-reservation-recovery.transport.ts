import {
  isMeriDispatchRequestIdentityV2,
  type MeriDispatchRequestIdentityV2,
} from './meri-hermes-dispatch-intent.contract.js';
import type {
  MeriHermesRecoveryAbortBoundaryV1,
  MeriHermesRecoveryAbortSignalV1,
  MeriHermesRecoveryFetchHeadersV1,
  MeriHermesRecoveryFetchV1,
  MeriHermesRecoveryReadableBodyReaderV1,
  MeriHermesRecoveryReadableBodyV1,
} from './meri-hermes-dispatch-recovery.transport.js';
import {
  matchesMeriHermesReservationNativeRequestV1,
  type MeriHermesReservationCommandClaimsV1,
} from './meri-hermes-reservation-recovery.contract.js';

/** Dormant, single-attempt transport for unknown-worker reservation recovery. */
const COMMAND_HEADER = 'X-Meri-Dispatch-Reservation-Command';
const RECEIPT_HEADER = 'x-meri-dispatch-reservation-receipt';
const COMMAND_TOKEN = /^mhrqc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const RECEIPT_TOKEN = /^mhrqr1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const PINNED_BEARER_AUTHORIZATION = /^Bearer [\x21-\x7e]+$/;
const MAX_HEADER_BYTES = 8192;
export const MERI_HERMES_RESERVATION_MAX_RESPONSE_BYTES_V1 = 64 * 1024;
const MAX_RESPONSE_CHUNKS = 1024;

const COMMAND_FIELDS: ReadonlyArray<keyof MeriHermesReservationCommandClaimsV1> = [
  'version', 'purpose', 'keyId', 'tenantId', 'runId', 'requestSha256',
  'workerAudience', 'workerIngressId', 'workerGeneration', 'workerCredentialId',
  'idempotencyKey', 'deliveryNotBeforeEpochMicros',
  'reconciliationNotAfterEpochMicros', 'retainUntilEpochMicros',
  'operationId', 'attemptNonce', 'nativeMethod', 'nativePath',
  'nativeBodySha256', 'notBeforeEpochMicros', 'notAfterEpochMicros',
];

export interface MeriHermesReservationTransportRequestV1 {
  readonly identity: Readonly<MeriDispatchRequestIdentityV2>;
  readonly commandToken: string;
  readonly command: Readonly<MeriHermesReservationCommandClaimsV1>;
}

export interface MeriHermesReservationTransportResponseV1 {
  readonly receiptToken: string;
  readonly nativeHttpStatus: number;
  readonly nativeResponseBodyBytes: Uint8Array;
}

export interface MeriHermesReservationResolvedEndpointV1 {
  readonly identity: Readonly<MeriDispatchRequestIdentityV2>;
  /** Canonical HTTPS origin only: no path, credentials, query, or fragment. */
  readonly baseUrl: string;
  /** Exact retained native Authorization header value. */
  readonly authorization: string;
}

export interface MeriHermesReservationEndpointResolverV1 {
  resolve(
    identity: Readonly<MeriDispatchRequestIdentityV2>,
  ): Promise<MeriHermesReservationResolvedEndpointV1>;
}

export interface MeriHermesReservationTransportDependenciesV1 {
  readonly resolver: MeriHermesReservationEndpointResolverV1;
  readonly fetch: MeriHermesRecoveryFetchV1;
  readonly abortBoundary: MeriHermesRecoveryAbortBoundaryV1;
}

export class MeriHermesReservationTransportUnconfirmedError extends Error {
  constructor() {
    super('Phase 4 reservation recovery transport is unconfirmed');
    this.name = 'MeriHermesReservationTransportUnconfirmedError';
  }
}

interface FrozenRequest {
  readonly identity: Readonly<MeriDispatchRequestIdentityV2>;
  readonly commandToken: string;
  readonly command: Readonly<MeriHermesReservationCommandClaimsV1>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function snapshotCommand(
  value: unknown,
): Readonly<MeriHermesReservationCommandClaimsV1> | null {
  const row = record(value);
  if (!row) return null;
  const keys = Object.keys(row);
  if (keys.length !== COMMAND_FIELDS.length ||
      !keys.every((key) => COMMAND_FIELDS.includes(
        key as keyof MeriHermesReservationCommandClaimsV1,
      ))) return null;
  const copied: Record<string, unknown> = {};
  for (const field of COMMAND_FIELDS) copied[field] = row[field];
  return Object.freeze(copied) as Readonly<MeriHermesReservationCommandClaimsV1>;
}

function sameIdentity(
  left: Readonly<MeriDispatchRequestIdentityV2>,
  right: Readonly<MeriDispatchRequestIdentityV2>,
): boolean {
  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length &&
    keys.every((key) => leftRecord[key] === rightRecord[key]);
}

function exactCommandBinding(request: FrozenRequest): boolean {
  const { command, identity } = request;
  return command.tenantId === identity.tenantId && command.runId === identity.runId &&
    command.requestSha256 === identity.requestSha256 &&
    command.workerAudience === identity.workerAudience &&
    command.workerIngressId === identity.workerIngressId &&
    command.workerGeneration === identity.workerGeneration &&
    command.workerCredentialId === identity.workerCredentialId &&
    command.reconciliationNotAfterEpochMicros ===
      identity.reconciliationNotAfterEpochMicros &&
    command.retainUntilEpochMicros === identity.retainUntilEpochMicros &&
    matchesMeriHermesReservationNativeRequestV1(
      command, 'POST', command.nativePath, '', new Uint8Array(),
    );
}

function freezeRequest(
  request: Readonly<MeriHermesReservationTransportRequestV1>,
): FrozenRequest | null {
  try {
    const identity = Object.freeze({ ...request.identity });
    const command = snapshotCommand(request.command);
    const copied: FrozenRequest = Object.freeze({
      identity,
      commandToken: request.commandToken,
      command: command!,
    });
    if (!command || !isMeriDispatchRequestIdentityV2(identity) ||
        typeof copied.commandToken !== 'string' ||
        Buffer.byteLength(copied.commandToken, 'utf8') > MAX_HEADER_BYTES ||
        !COMMAND_TOKEN.test(copied.commandToken) || !exactCommandBinding(copied)) return null;
    return copied;
  } catch {
    return null;
  }
}

function canonicalOrigin(baseUrl: unknown): string | null {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0 || baseUrl.length > 2048 ||
      baseUrl !== baseUrl.trim()) return null;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' ||
        parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') return null;
    return baseUrl === parsed.origin || baseUrl === `${parsed.origin}/` ? parsed.origin : null;
  } catch {
    return null;
  }
}

function responseMetadata(headers: MeriHermesRecoveryFetchHeadersV1): Readonly<{
  receiptToken: string;
  contentLength: number | null;
}> | null {
  if (!headers || typeof headers.entries !== 'function') return null;
  const values: string[] = [];
  const lengths: string[] = [];
  try {
    for (const entry of headers.entries()) {
      if (!Array.isArray(entry) || entry.length !== 2 ||
          typeof entry[0] !== 'string' || typeof entry[1] !== 'string') return null;
      if (entry[0].toLowerCase() === RECEIPT_HEADER) values.push(entry[1]);
      if (entry[0].toLowerCase() === 'content-length') lengths.push(entry[1]);
    }
  } catch {
    return null;
  }
  if (values.length !== 1 || Buffer.byteLength(values[0]!, 'utf8') > MAX_HEADER_BYTES ||
      !RECEIPT_TOKEN.test(values[0]!) || lengths.length > 1) return null;
  let contentLength: number | null = null;
  if (lengths.length === 1) {
    if (!/^(0|[1-9][0-9]*)$/.test(lengths[0]!)) return null;
    contentLength = Number(lengths[0]);
    if (!Number.isSafeInteger(contentLength)) return null;
  }
  return Object.freeze({ receiptToken: values[0]!, contentLength });
}

function exactAuthorization(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_HEADER_BYTES &&
    PINNED_BEARER_AUTHORIZATION.test(value);
}

async function cancelReader(reader: MeriHermesRecoveryReadableBodyReaderV1): Promise<void> {
  try {
    await reader.cancel(new MeriHermesReservationTransportUnconfirmedError());
  } catch {
    // The transport remains unconfirmed even if cancellation fails.
  }
}

async function readBoundedBody(
  body: MeriHermesRecoveryReadableBodyV1 | null,
  contentLength: number | null,
  signal: MeriHermesRecoveryAbortSignalV1,
): Promise<Uint8Array> {
  if (body === null) {
    if (contentLength !== null && contentLength !== 0) {
      throw new MeriHermesReservationTransportUnconfirmedError();
    }
    return new Uint8Array();
  }
  if (typeof body.getReader !== 'function') {
    throw new MeriHermesReservationTransportUnconfirmedError();
  }
  const reader = body.getReader();
  if (!reader || typeof reader.read !== 'function' || typeof reader.cancel !== 'function') {
    throw new MeriHermesReservationTransportUnconfirmedError();
  }
  if (contentLength !== null && contentLength > MERI_HERMES_RESERVATION_MAX_RESPONSE_BYTES_V1) {
    await cancelReader(reader);
    try { reader.releaseLock?.(); } catch { /* already unconfirmed */ }
    throw new MeriHermesReservationTransportUnconfirmedError();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let chunkCount = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new MeriHermesReservationTransportUnconfirmedError();
      const next = await reader.read();
      if (!next || typeof next.done !== 'boolean' ||
          (next.value !== undefined && !(next.value instanceof Uint8Array))) {
        throw new MeriHermesReservationTransportUnconfirmedError();
      }
      if (next.done) break;
      if (next.value !== undefined) {
        chunkCount += 1;
        if (chunkCount > MAX_RESPONSE_CHUNKS ||
            next.value.byteLength > MERI_HERMES_RESERVATION_MAX_RESPONSE_BYTES_V1 - total) {
          throw new MeriHermesReservationTransportUnconfirmedError();
        }
        const copied = Uint8Array.from(next.value);
        chunks.push(copied);
        total += copied.byteLength;
      }
    }
    if (contentLength !== null && total !== contentLength) {
      throw new MeriHermesReservationTransportUnconfirmedError();
    }
    const exact = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      exact.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return exact;
  } catch {
    await cancelReader(reader);
    throw new MeriHermesReservationTransportUnconfirmedError();
  } finally {
    try { reader.releaseLock?.(); } catch { /* consumed or cancelled */ }
  }
}

export class MeriHermesReservationRecoveryTransportV1 {
  readonly #dependencies: MeriHermesReservationTransportDependenciesV1;

  constructor(dependencies: MeriHermesReservationTransportDependenciesV1) {
    if (!dependencies || typeof dependencies.resolver?.resolve !== 'function' ||
        typeof dependencies.fetch !== 'function' ||
        typeof dependencies.abortBoundary?.run !== 'function') {
      throw new Error(
        'reservation transport requires explicit resolver, fetch, and abort boundary',
      );
    }
    this.#dependencies = dependencies;
  }

  async execute(
    request: Readonly<MeriHermesReservationTransportRequestV1>,
  ): Promise<MeriHermesReservationTransportResponseV1> {
    const frozen = freezeRequest(request);
    if (!frozen) throw new MeriHermesReservationTransportUnconfirmedError();
    try {
      const resolved = await this.#dependencies.resolver.resolve(frozen.identity);
      if (!resolved || !isMeriDispatchRequestIdentityV2(resolved.identity) ||
          !sameIdentity(resolved.identity, frozen.identity) ||
          !exactAuthorization(resolved.authorization)) {
        throw new MeriHermesReservationTransportUnconfirmedError();
      }
      const origin = canonicalOrigin(resolved.baseUrl);
      if (!origin) throw new MeriHermesReservationTransportUnconfirmedError();
      const target = `${origin}${frozen.command.nativePath}`;
      const parsedTarget = new URL(target);
      if (parsedTarget.origin !== origin || parsedTarget.search !== '' ||
          parsedTarget.hash !== '' || parsedTarget.pathname !== frozen.command.nativePath) {
        throw new MeriHermesReservationTransportUnconfirmedError();
      }
      const headers = Object.freeze([
        Object.freeze(['Authorization', resolved.authorization] as const),
        Object.freeze([COMMAND_HEADER, frozen.commandToken] as const),
      ]);

      let invoked = false;
      let completed = false;
      let usedSignal: MeriHermesRecoveryAbortSignalV1 | null = null;
      const result = await this.#dependencies.abortBoundary.run(async (signal) => {
        if (invoked || !signal || signal.aborted) {
          throw new MeriHermesReservationTransportUnconfirmedError();
        }
        invoked = true;
        usedSignal = signal;
        const response = await this.#dependencies.fetch(target, Object.freeze({
          method: 'POST' as const,
          headers,
          redirect: 'manual' as const,
          signal,
        }));
        if (signal.aborted || !response || !Number.isSafeInteger(response.status) ||
            response.status < 100 || response.status > 599 ||
            (response.status >= 300 && response.status < 400) ||
            response.redirected !== false || response.type === 'opaqueredirect' ||
            response.url !== target) {
          throw new MeriHermesReservationTransportUnconfirmedError();
        }
        const metadata = responseMetadata(response.headers);
        if (!metadata) throw new MeriHermesReservationTransportUnconfirmedError();
        const nativeResponseBodyBytes = await readBoundedBody(
          response.body, metadata.contentLength, signal,
        );
        if (signal.aborted) throw new MeriHermesReservationTransportUnconfirmedError();
        completed = true;
        return Object.freeze({
          receiptToken: metadata.receiptToken,
          nativeHttpStatus: response.status,
          nativeResponseBodyBytes,
        });
      });
      const finalSignal = usedSignal as MeriHermesRecoveryAbortSignalV1 | null;
      if (!invoked || !completed || !finalSignal || finalSignal.aborted ||
          !result || !(result.nativeResponseBodyBytes instanceof Uint8Array)) {
        throw new MeriHermesReservationTransportUnconfirmedError();
      }
      return result;
    } catch {
      throw new MeriHermesReservationTransportUnconfirmedError();
    }
  }
}
