import type {
  MeriHermesDispatchClaimInputV2,
  MeriHermesDispatchClaimResultV2,
} from './meri-hermes-dispatch-claim-boundary.js';

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_BODY_BYTES = 1_048_576;
const WIRE_FIELDS = [
  'version', 'receivedMethod', 'receivedPath', 'receivedContentType',
  'tenantId', 'runId', 'requestSha256', 'workerRunId', 'bearer',
  'toolViewAttestation', 'bodyBase64url', 'sessionHeaderValue',
  'idempotencyKeyHeaderValue',
] as const;

export const MERI_PHASE4_CLAIM_SERVICE_SECRET_HEADER =
  'x-meri-dispatch-claim-service-secret' as const;
export const MERI_PHASE4_DISPATCH_GATE_BEARER_HEADER =
  'x-meri-dispatch-gate-bearer' as const;
export const MERI_PHASE4_CLAIM_PATH = '/api/internal/meri/hermes/phase4/claim' as const;

export interface MeriHermesDispatchClaimWireV2 {
  readonly version: 2;
  readonly receivedMethod: 'POST';
  readonly receivedPath: '/v1/runs';
  readonly receivedContentType: 'application/json';
  readonly tenantId: string;
  readonly runId: string;
  readonly requestSha256: string;
  readonly workerRunId: string;
  readonly bearer: string;
  readonly toolViewAttestation: string;
  readonly bodyBase64url: string;
  readonly sessionHeaderValue: string;
  readonly idempotencyKeyHeaderValue: string;
}

/** Strict dormant wire decoder. It does not register an HTTP route. */
export function decodeMeriHermesDispatchClaimWireV2(
  value: unknown,
  serviceSecretHeaderValue: unknown,
): MeriHermesDispatchClaimInputV2 | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      typeof serviceSecretHeaderValue !== 'string') return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== WIRE_FIELDS.length ||
      !keys.every((key, index) => key === WIRE_FIELDS[index]) || row.version !== 2 ||
      row.receivedMethod !== 'POST' || row.receivedPath !== '/v1/runs' ||
      row.receivedContentType !== 'application/json' ||
      typeof row.bodyBase64url !== 'string' || !BASE64URL.test(row.bodyBase64url) ||
      row.bodyBase64url.length > Math.ceil(MAX_BODY_BYTES * 4 / 3)) return null;
  let bodyBytes: Buffer;
  try {
    bodyBytes = Buffer.from(row.bodyBase64url, 'base64url');
  } catch {
    return null;
  }
  if (bodyBytes.length === 0 || bodyBytes.length > MAX_BODY_BYTES ||
      bodyBytes.toString('base64url') !== row.bodyBase64url) return null;
  const strings = [
    'tenantId', 'runId', 'requestSha256', 'workerRunId', 'bearer',
    'toolViewAttestation', 'sessionHeaderValue', 'idempotencyKeyHeaderValue',
  ] as const;
  if (strings.some((field) => typeof row[field] !== 'string')) return null;
  return Object.freeze({
    receivedMethod: 'POST', receivedPath: '/v1/runs',
    receivedContentType: 'application/json',
    tenantId: row.tenantId as string,
    runId: row.runId as string,
    requestSha256: row.requestSha256 as string,
    workerRunId: row.workerRunId as string,
    bearer: row.bearer as string,
    toolViewAttestation: row.toolViewAttestation as string,
    bodyBytes: Uint8Array.from(bodyBytes),
    sessionHeaderValue: row.sessionHeaderValue as string,
    idempotencyKeyHeaderValue: row.idempotencyKeyHeaderValue as string,
    serviceSecretHeaderValue,
  });
}

export interface MeriHermesDispatchClaimBoundaryPortV2 {
  claim(input: MeriHermesDispatchClaimInputV2): Promise<MeriHermesDispatchClaimResultV2>;
}

/** Pure adapter for a future private controller; deliberately not a Nest provider. */
export async function handleMeriHermesDispatchClaimWireV2(
  boundary: MeriHermesDispatchClaimBoundaryPortV2,
  value: unknown,
  serviceSecretHeaderValue: unknown,
): Promise<MeriHermesDispatchClaimResultV2> {
  const decoded = decodeMeriHermesDispatchClaimWireV2(value, serviceSecretHeaderValue);
  if (!decoded) return { version: 2, kind: 'rejected', launchAuthorized: false };
  return boundary.claim(decoded);
}
