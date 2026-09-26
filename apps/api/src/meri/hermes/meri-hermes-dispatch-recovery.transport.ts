import {
  matchesMeriHermesRecoveryNativeRequestV1,
  type MeriHermesRecoveryCommandClaimsV1,
} from './meri-hermes-dispatch-recovery.contract.js';
import type {
  MeriHermesDispatchRecoveryBoundaryDependenciesV1,
  MeriHermesRecoveryTransportRequestV1,
  MeriHermesRecoveryTransportResponseV1,
} from './meri-hermes-dispatch-recovery-boundary.js';
import {
  isMeriDispatchRequestIdentityV2,
  type MeriDispatchRequestIdentityV2,
} from './meri-hermes-dispatch-intent.contract.js';

/**
 * Dormant native status/Stop transport. It is not registered by a module or
 * provider. Endpoint and native bearer selection, fetch, and timeout/abort are
 * explicit dependencies; this file reads no process clock and retries nothing.
 */

const COMMAND_HEADER = 'X-Meri-Dispatch-Recovery-Command';
const RECEIPT_HEADER = 'x-meri-dispatch-recovery-receipt';
const COMMAND_TOKEN = /^mhrc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const RECEIPT_TOKEN = /^mhrr1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const PINNED_BEARER_AUTHORIZATION = /^Bearer [\x21-\x7e]+$/;
const MAX_HEADER_BYTES = 8192;
export const MERI_HERMES_RECOVERY_MAX_RESPONSE_BYTES_V1 = 64 * 1024;
const MAX_RESPONSE_CHUNKS = 1024;

const COMMAND_FIELDS: ReadonlyArray<keyof MeriHermesRecoveryCommandClaimsV1> = [
  'version', 'purpose', 'keyId', 'tenantId', 'runId', 'requestSha256', 'workerRunId',
  'workerAudience', 'workerIngressId', 'workerGeneration', 'workerCredentialId',
  'action', 'operationId', 'attemptNonce', 'nativeMethod', 'nativePath',
  'nativeBodySha256', 'notBeforeEpochMicros', 'notAfterEpochMicros',
];

export interface MeriHermesRecoveryResolvedEndpointV1 {
  /** Exact identity for which this endpoint credential was retained. */
  readonly identity: Readonly<MeriDispatchRequestIdentityV2>;
  readonly workerRunId: string;
  /** Canonical HTTPS origin only: no path, credentials, query, or fragment. */
  readonly baseUrl: string;
  /** Exact retained native Authorization header value. */
  readonly authorization: string;
}

export interface MeriHermesRecoveryEndpointResolverV1 {
  resolve(
    identity: Readonly<MeriDispatchRequestIdentityV2>,
    workerRunId: string,
  ): Promise<MeriHermesRecoveryResolvedEndpointV1>;
}

export interface MeriHermesRecoveryAbortSignalV1 {
  readonly aborted: boolean;
}

export interface MeriHermesRecoveryAbortBoundaryV1 {
  /**
   * Supplies one bounded abort signal and settles only after the operation is
   * conclusively complete or aborted. It must never invoke `operation` twice.
   */
  run<T>(
    operation: (signal: MeriHermesRecoveryAbortSignalV1) => Promise<T>,
  ): Promise<T>;
}

export interface MeriHermesRecoveryFetchHeadersV1 {
  entries(): Iterable<readonly [string, string]>;
}

export interface MeriHermesRecoveryFetchResponseV1 {
  readonly status: number;
  readonly url: string;
  readonly redirected: boolean;
  readonly type?: string;
  readonly headers: MeriHermesRecoveryFetchHeadersV1;
  readonly body: MeriHermesRecoveryReadableBodyV1 | null;
}

export interface MeriHermesRecoveryReadableBodyReaderV1 {
  read(): Promise<Readonly<{ done: boolean; value?: Uint8Array }>>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock?(): void;
}

export interface MeriHermesRecoveryReadableBodyV1 {
  getReader(): MeriHermesRecoveryReadableBodyReaderV1;
}

export interface MeriHermesRecoveryFetchInitV1 {
  readonly method: 'GET' | 'POST';
  readonly headers: readonly (readonly [string, string])[];
  readonly body?: Uint8Array;
  readonly redirect: 'manual';
  readonly signal: MeriHermesRecoveryAbortSignalV1;
}

export type MeriHermesRecoveryFetchV1 = (
  url: string,
  init: Readonly<MeriHermesRecoveryFetchInitV1>,
) => Promise<MeriHermesRecoveryFetchResponseV1>;

export interface MeriHermesRecoveryTransportDependenciesV1 {
  readonly resolver: MeriHermesRecoveryEndpointResolverV1;
  readonly fetch: MeriHermesRecoveryFetchV1;
  readonly abortBoundary: MeriHermesRecoveryAbortBoundaryV1;
}

type RecoveryTransportPort = MeriHermesDispatchRecoveryBoundaryDependenciesV1['transport'];

export class MeriHermesRecoveryTransportUnconfirmedError extends Error {
  constructor() {
    super('Phase 4 recovery transport is unconfirmed');
    this.name = 'MeriHermesRecoveryTransportUnconfirmedError';
  }
}

interface FrozenRequest {
  readonly identity: Readonly<MeriDispatchRequestIdentityV2>;
  readonly workerRunId: string;
  readonly action: 'status' | 'stop';
  readonly commandToken: string;
  readonly command: Readonly<MeriHermesRecoveryCommandClaimsV1>;
  readonly nativeBodyBytes: Uint8Array;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function snapshotCommand(value: unknown): Readonly<MeriHermesRecoveryCommandClaimsV1> | null {
  const row = record(value);
  if (!row) return null;
  const keys = Object.keys(row);
  if (keys.length !== COMMAND_FIELDS.length ||
      !keys.every((key) => COMMAND_FIELDS.includes(
        key as keyof MeriHermesRecoveryCommandClaimsV1,
      ))) return null;
  const copied: Record<string, unknown> = {};
  for (const field of COMMAND_FIELDS) copied[field] = row[field];
  return Object.freeze(copied) as Readonly<MeriHermesRecoveryCommandClaimsV1>;
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
  const method = request.action === 'status' ? 'GET' : 'POST';
  const encodedRunId = encodeURIComponent(request.workerRunId);
  const path = request.action === 'status'
    ? `/v1/runs/${encodedRunId}` : `/v1/runs/${encodedRunId}/stop`;
  return command.tenantId === identity.tenantId && command.runId === identity.runId &&
    command.requestSha256 === identity.requestSha256 &&
    command.workerRunId === request.workerRunId &&
    command.workerAudience === identity.workerAudience &&
    command.workerIngressId === identity.workerIngressId &&
    command.workerGeneration === identity.workerGeneration &&
    command.workerCredentialId === identity.workerCredentialId &&
    command.action === request.action && command.nativeMethod === method &&
    command.nativePath === path &&
    matchesMeriHermesRecoveryNativeRequestV1(
      command, method, path, request.nativeBodyBytes,
    );
}

function freezeRequest(request: Readonly<MeriHermesRecoveryTransportRequestV1>): FrozenRequest | null {
  try {
    const identity = Object.freeze({ ...request.identity });
    const command = snapshotCommand(request.command);
    const copied: FrozenRequest = Object.freeze({
      identity,
      workerRunId: request.workerRunId,
      action: request.action,
      commandToken: request.commandToken,
      command: command!,
      nativeBodyBytes: Uint8Array.from(request.nativeBodyBytes),
    });
    if (!command || !isMeriDispatchRequestIdentityV2(identity) ||
        typeof copied.workerRunId !== 'string' || copied.workerRunId.length === 0 ||
        copied.workerRunId.length > 120 || copied.workerRunId.trim() !== copied.workerRunId ||
        /[\u0000-\u001f\u007f]/.test(copied.workerRunId) ||
        (copied.action !== 'status' && copied.action !== 'stop') ||
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
    await reader.cancel(new MeriHermesRecoveryTransportUnconfirmedError());
  } catch {
    // The transport remains unconfirmed even when cancellation itself fails.
  }
}

async function readBoundedBody(
  body: MeriHermesRecoveryReadableBodyV1 | null,
  contentLength: number | null,
  signal: MeriHermesRecoveryAbortSignalV1,
): Promise<Uint8Array> {
  if (body === null) {
    if (contentLength !== null && contentLength !== 0) {
      throw new MeriHermesRecoveryTransportUnconfirmedError();
    }
    return new Uint8Array();
  }
  if (typeof body.getReader !== 'function') {
    throw new MeriHermesRecoveryTransportUnconfirmedError();
  }
  const reader = body.getReader();
  if (!reader || typeof reader.read !== 'function' || typeof reader.cancel !== 'function') {
    throw new MeriHermesRecoveryTransportUnconfirmedError();
  }
  if (contentLength !== null && contentLength > MERI_HERMES_RECOVERY_MAX_RESPONSE_BYTES_V1) {
    await cancelReader(reader);
    try { reader.releaseLock?.(); } catch { /* already unconfirmed */ }
    throw new MeriHermesRecoveryTransportUnconfirmedError();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let chunkCount = 0;
  let done = false;
  try {
    while (!done) {
      if (signal.aborted) {
        throw new MeriHermesRecoveryTransportUnconfirmedError();
      }
      const next = await reader.read();
      if (!next || typeof next.done !== 'boolean' ||
          (next.value !== undefined && !(next.value instanceof Uint8Array))) {
        throw new MeriHermesRecoveryTransportUnconfirmedError();
      }
      done = next.done;
      if (next.value !== undefined) {
        chunkCount += 1;
        if (chunkCount > MAX_RESPONSE_CHUNKS) {
          throw new MeriHermesRecoveryTransportUnconfirmedError();
        }
        if (next.value.byteLength >
            MERI_HERMES_RECOVERY_MAX_RESPONSE_BYTES_V1 - total) {
          throw new MeriHermesRecoveryTransportUnconfirmedError();
        }
        const copied = Uint8Array.from(next.value);
        chunks.push(copied);
        total += copied.byteLength;
      }
    }
    if (contentLength !== null && total !== contentLength) {
      throw new MeriHermesRecoveryTransportUnconfirmedError();
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
    throw new MeriHermesRecoveryTransportUnconfirmedError();
  } finally {
    try { reader.releaseLock?.(); } catch { /* already consumed or cancelled */ }
  }
}

export class MeriHermesDispatchRecoveryTransportV1 implements RecoveryTransportPort {
  readonly #dependencies: MeriHermesRecoveryTransportDependenciesV1;

  constructor(dependencies: MeriHermesRecoveryTransportDependenciesV1) {
    if (!dependencies || typeof dependencies.resolver?.resolve !== 'function' ||
        typeof dependencies.fetch !== 'function' ||
        typeof dependencies.abortBoundary?.run !== 'function') {
      throw new Error('recovery transport requires explicit resolver, fetch, and abort boundary');
    }
    this.#dependencies = dependencies;
  }

  async execute(
    request: Readonly<MeriHermesRecoveryTransportRequestV1>,
  ): Promise<MeriHermesRecoveryTransportResponseV1> {
    const frozen = freezeRequest(request);
    if (!frozen) throw new MeriHermesRecoveryTransportUnconfirmedError();
    try {
      const resolved = await this.#dependencies.resolver.resolve(
        frozen.identity, frozen.workerRunId,
      );
      if (!resolved || !isMeriDispatchRequestIdentityV2(resolved.identity) ||
          !sameIdentity(resolved.identity, frozen.identity) ||
          resolved.workerRunId !== frozen.workerRunId ||
          !exactAuthorization(resolved.authorization)) {
        throw new MeriHermesRecoveryTransportUnconfirmedError();
      }
      const origin = canonicalOrigin(resolved.baseUrl);
      if (!origin) throw new MeriHermesRecoveryTransportUnconfirmedError();
      const target = `${origin}${frozen.command.nativePath}`;
      const parsedTarget = new URL(target);
      if (parsedTarget.origin !== origin || parsedTarget.search !== '' || parsedTarget.hash !== '' ||
          parsedTarget.pathname !== frozen.command.nativePath) {
        throw new MeriHermesRecoveryTransportUnconfirmedError();
      }
      const authorization = resolved.authorization;
      const headers = Object.freeze([
        Object.freeze(['Authorization', authorization] as const),
        Object.freeze([COMMAND_HEADER, frozen.commandToken] as const),
      ]);

      let invoked = false;
      let completed = false;
      let usedSignal: MeriHermesRecoveryAbortSignalV1 | null = null;
      const result = await this.#dependencies.abortBoundary.run(async (signal) => {
        if (invoked || !signal || signal.aborted) {
          throw new MeriHermesRecoveryTransportUnconfirmedError();
        }
        invoked = true;
        usedSignal = signal;
        const method = frozen.action === 'status' ? 'GET' : 'POST';
        const init: MeriHermesRecoveryFetchInitV1 = Object.freeze({
          method,
          headers,
          ...(method === 'POST' ? { body: Uint8Array.from(frozen.nativeBodyBytes) } : {}),
          redirect: 'manual' as const,
          signal,
        });
        const response = await this.#dependencies.fetch(target, init);
        if (signal.aborted || !response || !Number.isSafeInteger(response.status) ||
            response.status < 100 || response.status > 599 ||
            (response.status >= 300 && response.status < 400) ||
            response.redirected !== false || response.type === 'opaqueredirect' ||
            response.url !== target) {
          throw new MeriHermesRecoveryTransportUnconfirmedError();
        }
        const metadata = responseMetadata(response.headers);
        if (!metadata) throw new MeriHermesRecoveryTransportUnconfirmedError();
        const nativeResponseBodyBytes = await readBoundedBody(
          response.body, metadata.contentLength, signal,
        );
        if (signal.aborted) throw new MeriHermesRecoveryTransportUnconfirmedError();
        completed = true;
        return Object.freeze({
          receiptToken: metadata.receiptToken,
          nativeHttpStatus: response.status,
          nativeResponseBodyBytes,
        });
      });
      const finalSignal = usedSignal as unknown as MeriHermesRecoveryAbortSignalV1 | null;
      if (!invoked || !completed || !finalSignal || finalSignal.aborted ||
          !result || !(result.nativeResponseBodyBytes instanceof Uint8Array)) {
        throw new MeriHermesRecoveryTransportUnconfirmedError();
      }
      return result;
    } catch {
      throw new MeriHermesRecoveryTransportUnconfirmedError();
    }
  }
}
