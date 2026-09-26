import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  isMeriDispatchRequestIdentityV2,
  type MeriDispatchRequestIdentityV2,
} from './meri-hermes-dispatch-intent.contract.js';
import {
  computeMeriHermesObservedToolDigestsV1,
  type MeriHermesToolSchemaV1,
} from './meri-hermes-tool-view.js';

const DOMAIN = 'capiro.meri.phase4.claim-tool-view-attestation/v1';
const TOKEN = /^([A-Za-z0-9_-]+)\.([0-9a-f]{64})$/;
const POSITIVE_MICROS = /^[1-9][0-9]{0,18}$/;
const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;
const MAX_ATTESTATION_TTL_MICROS = 60_000_000n;

/** Exact persisted route binding used to select one purpose-separated key. */
export interface MeriHermesClaimToolViewAttestationKeyBindingV1 {
  readonly tenantId: string;
  readonly scopeId: string;
  readonly workerAudience: string;
  readonly workerIngressId: string;
  readonly workerGeneration: string;
  readonly workerCredentialId: string;
}

export interface MeriHermesClaimToolViewAttestationKeyV1
extends MeriHermesClaimToolViewAttestationKeyBindingV1 {
  readonly secret: Uint8Array;
  readonly notBeforeEpochMicros: string;
  readonly notAfterEpochMicros: string;
}

export interface MeriHermesClaimToolViewAttestationClaimsV1 {
  readonly version: 1;
  readonly tenantId: string;
  readonly runId: string;
  readonly requestSha256: string;
  readonly workerRunId: string;
  readonly workerAudience: string;
  readonly workerIngressId: string;
  readonly workerGeneration: string;
  readonly workerCredentialId: string;
  readonly catalogDigest: string;
  readonly toolViewDigest: string;
  readonly notBeforeEpochMicros: string;
  readonly notAfterEpochMicros: string;
}

export interface MintMeriHermesClaimToolViewAttestationV1 {
  readonly identity: Readonly<MeriDispatchRequestIdentityV2>;
  readonly workerRunId: string;
  /** Raw model-facing schemas observed by the worker at the claim boundary. */
  readonly observedCatalogTools: readonly MeriHermesToolSchemaV1[];
  /** Exact final provider-visible schemas actually applied for this worker run. */
  readonly observedAppliedToolSchemas: readonly MeriHermesToolSchemaV1[];
  readonly notBeforeEpochMicros: string;
  readonly notAfterEpochMicros: string;
}

function micros(value: unknown): bigint | null {
  if (typeof value !== 'string' || !POSITIVE_MICROS.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= MAX_SIGNED_INT64 ? parsed : null;
}

function validWorkerRunId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 120 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

export function meriHermesClaimToolViewAttestationKeyBindingV1(
  identity: Readonly<MeriDispatchRequestIdentityV2>,
): Readonly<MeriHermesClaimToolViewAttestationKeyBindingV1> {
  return Object.freeze({
    tenantId: identity.tenantId,
    scopeId: identity.scopeId,
    workerAudience: identity.workerAudience,
    workerIngressId: identity.workerIngressId,
    workerGeneration: identity.workerGeneration,
    workerCredentialId: identity.workerCredentialId,
  });
}

function keyMatchesBinding(
  key: MeriHermesClaimToolViewAttestationKeyV1 | undefined,
  binding: Readonly<MeriHermesClaimToolViewAttestationKeyBindingV1>,
): key is MeriHermesClaimToolViewAttestationKeyV1 {
  return Boolean(key && key.secret instanceof Uint8Array && key.secret.length >= 32 &&
    key.tenantId === binding.tenantId &&
    key.scopeId === binding.scopeId &&
    key.workerAudience === binding.workerAudience &&
    key.workerIngressId === binding.workerIngressId &&
    key.workerGeneration === binding.workerGeneration &&
    key.workerCredentialId === binding.workerCredentialId &&
    micros(key.notBeforeEpochMicros) !== null && micros(key.notAfterEpochMicros) !== null &&
    BigInt(key.notBeforeEpochMicros) < BigInt(key.notAfterEpochMicros));
}

function claimsArray(
  material: MintMeriHermesClaimToolViewAttestationV1,
  catalogDigest: string,
  toolViewDigest: string,
): readonly string[] {
  const { identity } = material;
  return [
    DOMAIN, '1', identity.tenantId, identity.runId, identity.requestSha256,
    material.workerRunId, identity.workerAudience, identity.workerIngressId,
    identity.workerGeneration, identity.workerCredentialId, catalogDigest, toolViewDigest,
    material.notBeforeEpochMicros, material.notAfterEpochMicros,
  ];
}

/**
 * Worker-side contract helper. Call only after observing the raw worker
 * catalog and the final applied run-local view. This function recomputes both
 * versioned digests and refuses to sign unless they equal the immutable
 * dispatch identity. The key is purpose-separated and bound to that identity's
 * exact credential, generation, ingress, and audience.
 */
export function mintMeriHermesClaimToolViewAttestationV1(
  material: MintMeriHermesClaimToolViewAttestationV1,
  key: MeriHermesClaimToolViewAttestationKeyV1,
): string {
  if (!isMeriDispatchRequestIdentityV2(material.identity) ||
      !validWorkerRunId(material.workerRunId) ||
      !keyMatchesBinding(key, meriHermesClaimToolViewAttestationKeyBindingV1(material.identity))) {
    throw new Error('invalid Phase 4 claim tool-view attestation material');
  }
  const observed = computeMeriHermesObservedToolDigestsV1(
    material.observedCatalogTools, material.observedAppliedToolSchemas,
  );
  if (observed.catalogDigest !== material.identity.catalogDigest ||
      observed.toolViewDigest !== material.identity.toolViewDigest) {
    throw new Error('observed Phase 4 claim tool view does not match dispatch identity');
  }
  const notBefore = micros(material.notBeforeEpochMicros);
  const notAfter = micros(material.notAfterEpochMicros);
  const keyNotBefore = micros(key.notBeforeEpochMicros);
  const keyNotAfter = micros(key.notAfterEpochMicros);
  if (notBefore === null || notAfter === null || keyNotBefore === null || keyNotAfter === null ||
      notBefore >= notAfter || notAfter - notBefore > MAX_ATTESTATION_TTL_MICROS ||
      notBefore < keyNotBefore || notAfter > keyNotAfter ||
      notAfter > BigInt(material.identity.claimNotAfterEpochMicros) ||
      notAfter > BigInt(material.identity.workerCredentialNotAfterEpochMicros)) {
    throw new Error('invalid Phase 4 claim tool-view attestation window');
  }
  const encoded = Buffer.from(
    JSON.stringify(claimsArray(material, observed.catalogDigest, observed.toolViewDigest)),
    'utf8',
  ).toString('base64url');
  const signature = createHmac('sha256', Uint8Array.from(key.secret))
    .update(encoded, 'ascii').digest('hex');
  return `${encoded}.${signature}`;
}

/** API-side verification against one route-selected key and persisted identity. */
export function verifyMeriHermesClaimToolViewAttestationV1(
  token: unknown,
  identity: Readonly<MeriDispatchRequestIdentityV2>,
  expectedWorkerRunId: string,
  key: MeriHermesClaimToolViewAttestationKeyV1,
  dbNowEpochMicros: string,
): MeriHermesClaimToolViewAttestationClaimsV1 | null {
  if (typeof token !== 'string' || token.length > 4096 ||
      !isMeriDispatchRequestIdentityV2(identity) || !validWorkerRunId(expectedWorkerRunId) ||
      !keyMatchesBinding(key, meriHermesClaimToolViewAttestationKeyBindingV1(identity))) return null;
  const match = TOKEN.exec(token);
  if (!match?.[1] || !match[2]) return null;
  const [encoded, presentedSignature] = [match[1], match[2]];
  let fields: unknown;
  try {
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded || decoded.length > 3072) return null;
    fields = JSON.parse(decoded.toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(fields) || fields.length !== 14 ||
      fields.some((value) => typeof value !== 'string')) return null;
  const values = fields as string[];
  if (values[0] !== DOMAIN || values[1] !== '1') return null;
  const expectedSignature = createHmac('sha256', Uint8Array.from(key.secret))
    .update(encoded, 'ascii').digest();
  const presented = Buffer.from(presentedSignature, 'hex');
  if (presented.length !== expectedSignature.length ||
      !timingSafeEqual(presented, expectedSignature)) return null;

  const now = micros(dbNowEpochMicros);
  const notBefore = micros(values[12]);
  const notAfter = micros(values[13]);
  const keyNotBefore = micros(key.notBeforeEpochMicros);
  const keyNotAfter = micros(key.notAfterEpochMicros);
  if (now === null || notBefore === null || notAfter === null ||
      keyNotBefore === null || keyNotAfter === null ||
      notBefore >= notAfter || notAfter - notBefore > MAX_ATTESTATION_TTL_MICROS ||
      now < notBefore || now >= notAfter || notBefore < keyNotBefore || notAfter > keyNotAfter ||
      notAfter > BigInt(identity.claimNotAfterEpochMicros) ||
      notAfter > BigInt(identity.workerCredentialNotAfterEpochMicros)) return null;

  const expected = [
    DOMAIN, '1', identity.tenantId, identity.runId, identity.requestSha256,
    expectedWorkerRunId, identity.workerAudience, identity.workerIngressId,
    identity.workerGeneration, identity.workerCredentialId,
    identity.catalogDigest, identity.toolViewDigest, values[12], values[13],
  ];
  if (values.some((value, index) => value !== expected[index])) return null;

  return Object.freeze({
    version: 1,
    tenantId: values[2]!,
    runId: values[3]!,
    requestSha256: values[4]!,
    workerRunId: values[5]!,
    workerAudience: values[6]!,
    workerIngressId: values[7]!,
    workerGeneration: values[8]!,
    workerCredentialId: values[9]!,
    catalogDigest: values[10]!,
    toolViewDigest: values[11]!,
    notBeforeEpochMicros: values[12]!,
    notAfterEpochMicros: values[13]!,
  });
}
