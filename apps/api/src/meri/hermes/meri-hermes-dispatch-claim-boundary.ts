import { createHash, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  createMeriHermesBrokerRunGrantV1,
  createMeriHermesOperationNamespaceV1,
  type MeriHermesBrokerRunGrantV1,
} from './meri-hermes-broker-effect.contract.js';
import {
  matchesMeriDispatchReceivedRequestV2,
  type MeriDispatchRequestIdentityV2,
} from './meri-hermes-dispatch-intent.contract.js';
import {
  verifyMeriDispatchGateBearerV1,
  type MeriDispatchGateBearerClaimsV1,
  type MeriDispatchGateBearerKeyV1,
} from './meri-hermes-dispatch-gate-bearer.js';
import {
  MeriHermesDispatchIntentRepository,
  type MeriDispatchLockedContextV2,
  type MeriDispatchTransitionResultV2,
} from './meri-hermes-dispatch-intent.repository.js';
import {
  meriHermesClaimToolViewAttestationKeyBindingV1,
  verifyMeriHermesClaimToolViewAttestationV1,
  type MeriHermesClaimToolViewAttestationKeyBindingV1,
  type MeriHermesClaimToolViewAttestationKeyV1,
} from './meri-hermes-claim-tool-view-attestation.js';

/** Untrusted wire inputs. The body is copied before this method first awaits. */
export interface MeriHermesDispatchClaimInputV2 {
  readonly receivedMethod: 'POST';
  readonly receivedPath: '/v1/runs';
  readonly receivedContentType: 'application/json';
  readonly tenantId: string;
  readonly runId: string;
  readonly requestSha256: string;
  readonly workerRunId: string;
  readonly bearer: string;
  /** Worker-origin proof over the exact applied catalog/view and route identity. */
  readonly toolViewAttestation: string;
  readonly bodyBytes: Uint8Array;
  readonly sessionHeaderValue: string;
  readonly idempotencyKeyHeaderValue: string;
  readonly serviceSecretHeaderValue: string;
}

/** No observation, identity, worker ID or request material crosses the gate. */
export type MeriHermesDispatchClaimResultV2 =
  | { readonly version: 2; readonly kind: 'transitioned'; readonly launchAuthorized: true;
      readonly brokerRunGrant: Readonly<MeriHermesBrokerRunGrantV1> }
  | { readonly version: 2; readonly kind: 'status_only'; readonly launchAuthorized: false }
  | { readonly version: 2; readonly kind: 'rejected'; readonly launchAuthorized: false }
  | { readonly version: 2; readonly kind: 'UNKNOWN'; readonly reason: 'commit_unconfirmed';
      readonly launchAuthorized: false };

export interface MeriHermesDispatchCurrentAuthorityVerifierV2 {
  /**
   * Called in the claim transaction only for prepared -> claimed. The
   * implementation must lock/check current membership and role, client and
   * mailbox grants/revocations, conversation/session epoch, Stop, worker
   * ingress/generation/credential, and route closure before returning true.
   * This is a required port; the DB adapter remains dormant and unregistered.
   */
  verifyCurrentAuthorityInTransaction(
    tx: Prisma.TransactionClient,
    context: Readonly<MeriDispatchLockedContextV2>,
    claims: Readonly<MeriDispatchGateBearerClaimsV1>,
    proposedWorkerRunId: string,
  ): Promise<boolean>;
}

export interface MeriHermesDispatchClaimBoundaryDependenciesV2 {
  readonly repository: MeriHermesDispatchIntentRepository;
  /** Dedicated dispatch-gate service secret: >=32 printable ASCII bytes. */
  readonly dispatchGateServiceSecret: string;
  /** API-owned active signing keys; never use the broker key or INTERNAL_SERVICE_SECRET. */
  readonly resolveBearerKeys: (
    identity: Readonly<MeriDispatchRequestIdentityV2>,
  ) => ReadonlyMap<string, MeriDispatchGateBearerKeyV1> |
    Promise<ReadonlyMap<string, MeriDispatchGateBearerKeyV1>>;
  /** API-owned key selected solely by the stored identity's key ID. */
  readonly resolveSessionHeaderHmacKey: (
    keyId: string,
  ) => Uint8Array | Promise<Uint8Array>;
  /**
   * One purpose-separated key selected only from the persisted route binding.
   * This lookup runs inside the locked claim transaction and must be local and
   * side-effect free: no network, KMS call, or second database transaction.
   */
  readonly resolveToolViewAttestationKey: (
    binding: Readonly<MeriHermesClaimToolViewAttestationKeyBindingV1>,
  ) => MeriHermesClaimToolViewAttestationKeyV1 |
    Promise<MeriHermesClaimToolViewAttestationKeyV1>;
  readonly currentAuthority: MeriHermesDispatchCurrentAuthorityVerifierV2;
}

const REJECTED: MeriHermesDispatchClaimResultV2 = Object.freeze({
  version: 2, kind: 'rejected', launchAuthorized: false,
});
const UNKNOWN: MeriHermesDispatchClaimResultV2 = Object.freeze({
  version: 2, kind: 'UNKNOWN', reason: 'commit_unconfirmed', launchAuthorized: false,
});
const POSITIVE_SIGNED_INT64 = /^[1-9][0-9]{0,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Dormant private claim boundary. Its repository owns the tenant transaction;
 * neither this class nor its dependencies are registered as a Nest provider.
 * Authentication is repeated on claimed rows. An expired bearer cannot recover
 * status: post-expiry recovery requires a distinct future purpose-bound policy.
 */
export class MeriHermesDispatchClaimBoundaryV2 {
  readonly #repository: MeriHermesDispatchIntentRepository;
  readonly #serviceSecretDigest: Buffer;
  readonly #resolveBearerKeys: MeriHermesDispatchClaimBoundaryDependenciesV2['resolveBearerKeys'];
  readonly #resolveSessionHeaderHmacKey:
    MeriHermesDispatchClaimBoundaryDependenciesV2['resolveSessionHeaderHmacKey'];
  readonly #resolveToolViewAttestationKey:
    MeriHermesDispatchClaimBoundaryDependenciesV2['resolveToolViewAttestationKey'];
  readonly #currentAuthority: MeriHermesDispatchCurrentAuthorityVerifierV2;

  constructor(dependencies: MeriHermesDispatchClaimBoundaryDependenciesV2) {
    if (!dependencies?.repository ||
        typeof dependencies.dispatchGateServiceSecret !== 'string' ||
        !/^[\x21-\x7e]{32,}$/.test(dependencies.dispatchGateServiceSecret) ||
        typeof dependencies.resolveBearerKeys !== 'function' ||
        typeof dependencies.resolveSessionHeaderHmacKey !== 'function' ||
        typeof dependencies.resolveToolViewAttestationKey !== 'function' ||
        typeof dependencies.currentAuthority?.verifyCurrentAuthorityInTransaction !== 'function') {
      throw new Error('dispatch claim boundary requires dedicated explicit dependencies');
    }
    this.#repository = dependencies.repository;
    this.#serviceSecretDigest = createHash('sha256')
      .update(dependencies.dispatchGateServiceSecret, 'ascii').digest();
    this.#resolveBearerKeys = dependencies.resolveBearerKeys;
    this.#resolveSessionHeaderHmacKey = dependencies.resolveSessionHeaderHmacKey;
    this.#resolveToolViewAttestationKey = dependencies.resolveToolViewAttestationKey;
    this.#currentAuthority = dependencies.currentAuthority;
  }

  async claim(input: MeriHermesDispatchClaimInputV2): Promise<MeriHermesDispatchClaimResultV2> {
    let copied: MeriHermesDispatchClaimInputV2;
    try {
      // Every caller-owned field is read synchronously before the first await.
      copied = Object.freeze({
        receivedMethod: input.receivedMethod,
        receivedPath: input.receivedPath,
        receivedContentType: input.receivedContentType,
        tenantId: input.tenantId,
        runId: input.runId,
        requestSha256: input.requestSha256,
        workerRunId: input.workerRunId,
        bearer: input.bearer,
        toolViewAttestation: input.toolViewAttestation,
        bodyBytes: Uint8Array.from(input.bodyBytes),
        sessionHeaderValue: input.sessionHeaderValue,
        idempotencyKeyHeaderValue: input.idempotencyKeyHeaderValue,
        serviceSecretHeaderValue: input.serviceSecretHeaderValue,
      });
    } catch {
      return REJECTED;
    }
    if (!this.#serviceSecretMatches(copied.serviceSecretHeaderValue) ||
        copied.receivedMethod !== 'POST' || copied.receivedPath !== '/v1/runs' ||
        copied.receivedContentType !== 'application/json' ||
        typeof copied.tenantId !== 'string' || !UUID.test(copied.tenantId) ||
        typeof copied.runId !== 'string' || !UUID.test(copied.runId) ||
        typeof copied.requestSha256 !== 'string' || !SHA256.test(copied.requestSha256) ||
        typeof copied.workerRunId !== 'string' ||
        typeof copied.bearer !== 'string' ||
        typeof copied.toolViewAttestation !== 'string' ||
        typeof copied.sessionHeaderValue !== 'string' ||
        typeof copied.idempotencyKeyHeaderValue !== 'string') return REJECTED;

    let authenticatedClaims: MeriDispatchGateBearerClaimsV1 | null = null;
    let result: MeriDispatchTransitionResultV2;
    try {
      result = await this.#repository.claim({
        tenantId: copied.tenantId,
        runId: copied.runId,
        requestSha256: copied.requestSha256,
        workerRunId: copied.workerRunId,
      }, async (tx, { identity }) => {
        const clock = await tx.$queryRaw<Array<{ now_epoch_micros: bigint }>>(Prisma.sql`
          SELECT floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint
            AS now_epoch_micros
        `);
        const now = clock.length === 1 ? clock[0]?.now_epoch_micros : null;
        if (typeof now !== 'bigint' || !POSITIVE_SIGNED_INT64.test(now.toString()) ||
            now > 9_223_372_036_854_775_807n) return false;
        const registry = await this.#resolveBearerKeys(identity);
        if (!(registry instanceof Map)) return false;
        // A resolver may own mutable Uint8Arrays. Verification sees local copies.
        const keys = new Map<string, MeriDispatchGateBearerKeyV1>();
        for (const [keyId, key] of registry) {
          keys.set(keyId, {
            secret: Uint8Array.from(key.secret),
            notBeforeEpochMicros: key.notBeforeEpochMicros,
            notAfterEpochMicros: key.notAfterEpochMicros,
          });
        }
        const claims = verifyMeriDispatchGateBearerV1(
          copied.bearer, identity, keys, now.toString(),
        );
        if (!claims) return false;
        const selectedKey = await this.#resolveSessionHeaderHmacKey(identity.sessionHeaderKeyId);
        if (!(selectedKey instanceof Uint8Array)) return false;
        const apiOwnedKey = Uint8Array.from(selectedKey);
        if (!matchesMeriDispatchReceivedRequestV2(
          identity, copied.bodyBytes, copied.sessionHeaderValue,
          copied.idempotencyKeyHeaderValue, apiOwnedKey,
        )) return false;
        const attestationBinding = meriHermesClaimToolViewAttestationKeyBindingV1(identity);
        const resolvedAttestationKey = await this.#resolveToolViewAttestationKey(attestationBinding);
        if (!resolvedAttestationKey || !(resolvedAttestationKey.secret instanceof Uint8Array)) {
          return false;
        }
        const attestationKey: MeriHermesClaimToolViewAttestationKeyV1 = Object.freeze({
          secret: Uint8Array.from(resolvedAttestationKey.secret),
          tenantId: resolvedAttestationKey.tenantId,
          scopeId: resolvedAttestationKey.scopeId,
          workerAudience: resolvedAttestationKey.workerAudience,
          workerIngressId: resolvedAttestationKey.workerIngressId,
          workerGeneration: resolvedAttestationKey.workerGeneration,
          workerCredentialId: resolvedAttestationKey.workerCredentialId,
          notBeforeEpochMicros: resolvedAttestationKey.notBeforeEpochMicros,
          notAfterEpochMicros: resolvedAttestationKey.notAfterEpochMicros,
        });
        if (!verifyMeriHermesClaimToolViewAttestationV1(
          copied.toolViewAttestation, identity, copied.workerRunId,
          attestationKey, now.toString(),
        )) return false;
        authenticatedClaims = Object.freeze(claims);
        return { authenticated: true, notAfterEpochMicros: claims.notAfterEpochMicros };
      }, async (tx, context) => {
        if (!authenticatedClaims) return false;
        return this.#currentAuthority.verifyCurrentAuthorityInTransaction(
          tx, context, authenticatedClaims, copied.workerRunId,
        );
      });
    } catch {
      return UNKNOWN;
    }
    if (result.kind === 'transitioned') {
      const ns = createMeriHermesOperationNamespaceV1({
        namespace: result.operationNamespace,
        tenantId: copied.tenantId,
        runId: copied.runId,
        workerRunId: copied.workerRunId,
        dispatchRequestSha256: copied.requestSha256,
      });
      return {
        version: 2,
        kind: 'transitioned',
        launchAuthorized: true,
        brokerRunGrant: createMeriHermesBrokerRunGrantV1(ns),
      };
    }
    if (result.kind === 'status_only') {
      return { version: 2, kind: 'status_only', launchAuthorized: false };
    }
    return result.kind === 'UNKNOWN' ? UNKNOWN : REJECTED;
  }

  #serviceSecretMatches(candidate: unknown): boolean {
    const candidateBytes = Buffer.from(typeof candidate === 'string' ? candidate : '', 'utf8');
    const digest = createHash('sha256').update(candidateBytes).digest();
    return timingSafeEqual(digest, this.#serviceSecretDigest) &&
      typeof candidate === 'string' && /^[\x21-\x7e]{32,}$/.test(candidate);
  }
}
