import {
  createMeriDispatchRequestIdentityV2,
  type MeriDispatchRequestIdentityV2,
} from './meri-hermes-dispatch-intent.contract.js';
import {
  mintMeriDispatchGateBearerV1,
  type MeriDispatchGateBearerKeyV1,
} from './meri-hermes-dispatch-gate-bearer.js';
import { MeriHermesDispatchClaimBoundaryV2 } from './meri-hermes-dispatch-claim-boundary.js';
import {
  type MeriHermesClaimToolViewAttestationKeyV1,
} from './meri-hermes-claim-tool-view-attestation.js';
import {
  computeMeriHermesObservedToolDigestsV1,
  type MeriHermesToolSchemaV1,
} from './meri-hermes-tool-view.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  AuthenticateMeriDispatchClaimV2,
  MeriDispatchClaimInputV2,
  VerifyMeriDispatchTransitionV2,
} from './meri-hermes-dispatch-intent.repository.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const conversationId = '33333333-3333-4333-8333-333333333333';
const runId = '55555555-5555-4555-8555-555555555555';
const scopeId = `tenant:${tenantId}:user:${actorId}`;
const sharedVector = JSON.parse(readFileSync(resolve(
  __dirname, '../../../../../docker/hermes-worker/overlay/claim-tool-view-attestation-vectors.json',
), 'utf8')) as {
  requestBodyBase64url: string;
  sessionHeaderValue: string;
  sessionHeaderHmacKeyBase64url: string;
  workerRunId: string;
  identity: MeriDispatchRequestIdentityV2;
  observedCatalogTools: readonly MeriHermesToolSchemaV1[];
  observedAppliedToolSchemas: readonly MeriHermesToolSchemaV1[];
  key: Omit<MeriHermesClaimToolViewAttestationKeyV1, 'secret'> & { secretBase64url: string };
  token: string;
};
const header = sharedVector.sessionHeaderValue;
const body = Buffer.from(sharedVector.requestBodyBase64url, 'base64url');
const sessionKey = Buffer.from(sharedVector.sessionHeaderHmacKeyBase64url, 'base64url');
const workerRunId = sharedVector.workerRunId;
const bearerKey: MeriDispatchGateBearerKeyV1 = {
  secret: Buffer.alloc(32, 9),
  notBeforeEpochMicros: '1790366300000000',
  notAfterEpochMicros: '1790366400000000',
};
const now = '1790366390000000';
const expires = '1790366399000000';
const serviceSecret = 'dispatch-gate-service-secret-32-bytes';
const observedCatalogTools = Object.freeze(sharedVector.observedCatalogTools);
const observedAppliedToolSchemas = Object.freeze(sharedVector.observedAppliedToolSchemas);
const observedDigests = computeMeriHermesObservedToolDigestsV1(
  observedCatalogTools, observedAppliedToolSchemas,
);
const attestationKey: MeriHermesClaimToolViewAttestationKeyV1 = {
  ...sharedVector.key,
  secret: Buffer.from(sharedVector.key.secretBase64url, 'base64url'),
};

const identity = createMeriDispatchRequestIdentityV2({
  metadata: {
    version: 2,
    tenantId,
    actorType: 'user',
    actorId,
    meriAudience: 'private',
    clientId: null,
    workspaceId: null,
    scopeId,
    conversationId,
    userMessageId: '44444444-4444-4444-8444-444444444444',
    runId,
    idempotencyKey: 'phase4-claim-vector',
    conversationEpoch: 3,
    workerAudience: 'meri-hermes-scope-worker',
    workerIngressId: 'private-ingress-a',
    workerGeneration: 'worker-image-sha256:2026',
    workerCredentialId: 'worker-credential-2026-09',
    authorizationVersion: 'authorization-v8',
    authorizationPolicyVersion: 'policy-v8',
    grantVersion: 'grant-v4',
    catalogDigest: observedDigests.catalogDigest,
    toolViewDigest: observedDigests.toolViewDigest,
    sessionHeaderKeyId: 'dispatch-hmac-2026-09',
    claimNotAfterEpochMicros: '1790366400000000',
    deliveryNotAfterEpochMicros: '1790366460000000',
    workerCredentialNotAfterEpochMicros: '1790366460000000',
    reconciliationNotAfterEpochMicros: '1790456460000000',
    retainUntilEpochMicros: '1790546460000000',
  },
  sourceMessage: { body: 'hello source', metadata: { runtime: 'hermes' } },
  bodyBytes: body,
  sessionKeyHeaderValue: header,
  sessionHeaderHmacKey: sessionKey,
});
const bearer = mintMeriDispatchGateBearerV1(identity, 'dispatch-key-a', bearerKey, now, expires);
const toolViewAttestation = sharedVector.token;

interface FixtureOptions {
  loadedIdentity?: MeriDispatchRequestIdentityV2;
  dbNow?: string;
  state?: 'prepared' | 'claimed';
  storedWorkerRunId?: string;
  selectedSessionKey?: Uint8Array;
  selectedBearerKey?: MeriDispatchGateBearerKeyV1;
  selectedAttestationKey?: MeriHermesClaimToolViewAttestationKeyV1;
  selectedToolViewAttestation?: string;
  authorityDecision?: boolean;
  authorityThrows?: boolean;
}

function fixture(options: FixtureOptions = {}) {
  const loadedIdentity = Object.freeze(options.loadedIdentity ?? identity);
  const tx = {
    $queryRaw: jest.fn(async () => [{ now_epoch_micros: BigInt(options.dbNow ?? now) }]),
  };
  const authority = {
    verifyCurrentAuthorityInTransaction: jest.fn(async () => {
      if (options.authorityThrows) throw new Error('authority unavailable');
      return options.authorityDecision ?? true;
    }),
  };
  const resolveBearerKeys = jest.fn(async () => new Map([
    ['dispatch-key-a', options.selectedBearerKey ?? bearerKey],
  ]));
  const resolveSessionHeaderHmacKey = jest.fn(async () =>
    options.selectedSessionKey ?? sessionKey);
  const resolveToolViewAttestationKey = jest.fn(async () =>
    options.selectedAttestationKey ?? attestationKey);
  const repo = {
    claim: jest.fn(async (
      request: MeriDispatchClaimInputV2,
      authenticate: AuthenticateMeriDispatchClaimV2,
      verifyTransition: VerifyMeriDispatchTransitionV2,
    ) => {
      try {
        const decision = await authenticate(tx as never, Object.freeze({ identity: loadedIdentity }));
        if (decision === false) return { kind: 'rejected' as const };
        if (request.tenantId !== loadedIdentity.tenantId ||
            request.runId !== loadedIdentity.runId ||
            request.requestSha256 !== loadedIdentity.requestSha256) return { kind: 'rejected' as const };
        if (options.state === 'claimed') {
          return request.workerRunId === (options.storedWorkerRunId ?? workerRunId)
            ? { kind: 'status_only' as const }
            : { kind: 'rejected' as const };
        }
        const allowed = await verifyTransition(tx as never, {
          identity: loadedIdentity,
          runStatus: 'provisioning',
          dispatchStatus: 'pending',
          stopRequestedAt: null,
          scopeAuthorizationVersion: loadedIdentity.authorizationVersion,
        });
        return allowed
          ? { kind: 'transitioned' as const,
              operationNamespace: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
          : { kind: 'rejected' as const };
      } catch {
        return { kind: 'UNKNOWN' as const };
      }
    }),
  };
  const boundary = new MeriHermesDispatchClaimBoundaryV2({
    repository: repo as never,
    dispatchGateServiceSecret: serviceSecret,
    resolveBearerKeys,
    resolveSessionHeaderHmacKey,
    resolveToolViewAttestationKey,
    currentAuthority: authority,
  });
  const request = {
    receivedMethod: 'POST' as const,
    receivedPath: '/v1/runs' as const,
    receivedContentType: 'application/json' as const,
    tenantId,
    runId,
    requestSha256: identity.requestSha256,
    workerRunId,
    bearer,
    toolViewAttestation: options.selectedToolViewAttestation ?? toolViewAttestation,
    bodyBytes: Uint8Array.from(body),
    sessionHeaderValue: header,
    idempotencyKeyHeaderValue: identity.idempotencyKey,
    serviceSecretHeaderValue: serviceSecret,
  };
  return { boundary, request, repo, tx, authority, resolveBearerKeys,
    resolveSessionHeaderHmacKey, resolveToolViewAttestationKey };
}

describe('dormant Phase 4 authenticated claim boundary', () => {
  test('rejects wrong service secret before any database or key resolver call', async () => {
    const f = fixture();
    await expect(f.boundary.claim({ ...f.request, serviceSecretHeaderValue: 'x'.repeat(32) }))
      .resolves.toEqual({ version: 2, kind: 'rejected', launchAuthorized: false });
    expect(f.repo.claim).not.toHaveBeenCalled();
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
    expect(f.resolveBearerKeys).not.toHaveBeenCalled();
  });

  test('rejects wrong, mismatched, and expired bearers with no status disclosure', async () => {
    for (const requestChange of [
      { bearer: bearer.slice(0, -1) + (bearer.endsWith('A') ? 'B' : 'A') },
      { tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      { requestSha256: 'f'.repeat(64) },
    ]) {
      const f = fixture();
      await expect(f.boundary.claim({ ...f.request, ...requestChange })).resolves.toEqual({
        version: 2, kind: 'rejected', launchAuthorized: false,
      });
      expect(f.authority.verifyCurrentAuthorityInTransaction).not.toHaveBeenCalled();
    }
    const cutoff = fixture({ dbNow: expires, state: 'claimed' });
    await expect(cutoff.boundary.claim(cutoff.request)).resolves.toEqual({
      version: 2, kind: 'rejected', launchAuthorized: false,
    });
    expect(cutoff.resolveSessionHeaderHmacKey).not.toHaveBeenCalled();
    const driftedIdentity = fixture({
      loadedIdentity: { ...identity, workerGeneration: 'different-generation' },
    });
    await expect(driftedIdentity.boundary.claim(driftedIdentity.request)).resolves.toEqual({
      version: 2, kind: 'rejected', launchAuthorized: false,
    });
    const driftedBearerKey = fixture({
      selectedBearerKey: { ...bearerKey, secret: Buffer.alloc(32, 10) },
    });
    await expect(driftedBearerKey.boundary.claim(driftedBearerKey.request)).resolves.toEqual({
      version: 2, kind: 'rejected', launchAuthorized: false,
    });
  });

  test('rejects malformed tenant/run selectors and digest before any database query', async () => {
    for (const requestChange of [
      { tenantId: 'not-a-uuid' },
      { runId: 'not-a-uuid' },
      { requestSha256: 'BAD' },
    ]) {
      const f = fixture();
      await expect(f.boundary.claim({ ...f.request, ...requestChange })).resolves.toEqual({
        version: 2, kind: 'rejected', launchAuthorized: false,
      });
      expect(f.repo.claim).not.toHaveBeenCalled();
    }
  });

  test('rejects method, path, and content-type drift before any database query', async () => {
    for (const requestChange of [
      { receivedMethod: 'PUT' },
      { receivedPath: '/p/other/v1/runs' },
      { receivedContentType: 'application/json; charset=utf-8' },
    ]) {
      const f = fixture();
      await expect(f.boundary.claim({ ...f.request, ...requestChange } as never)).resolves.toEqual({
        version: 2, kind: 'rejected', launchAuthorized: false,
      });
      expect(f.repo.claim).not.toHaveBeenCalled();
    }
  });

  test('rejects exact body, header, and API-selected key drift before authority', async () => {
    const requests = [
      { bodyBytes: Buffer.from('{"input":"drift"}') },
      { sessionHeaderValue: `${header}-drift` },
      { idempotencyKeyHeaderValue: 'different-idempotency-key' },
    ];
    for (const changed of requests) {
      const f = fixture();
      await expect(f.boundary.claim({ ...f.request, ...changed })).resolves.toEqual({
        version: 2, kind: 'rejected', launchAuthorized: false,
      });
      expect(f.authority.verifyCurrentAuthorityInTransaction).not.toHaveBeenCalled();
    }
    const wrongKey = fixture({ selectedSessionKey: Buffer.alloc(32, 8) });
    await expect(wrongKey.boundary.claim(wrongKey.request)).resolves.toEqual({
      version: 2, kind: 'rejected', launchAuthorized: false,
    });
    expect(wrongKey.resolveSessionHeaderHmacKey).toHaveBeenCalledWith(identity.sessionHeaderKeyId);
  });

  test('requires exact received request material before returning claimed status-only', async () => {
    for (const changed of [
      { bodyBytes: Buffer.from('{"input":"drift"}') },
      { sessionHeaderValue: `${header}-drift` },
      { idempotencyKeyHeaderValue: 'different-idempotency-key' },
    ]) {
      const f = fixture({ state: 'claimed' });
      await expect(f.boundary.claim({ ...f.request, ...changed })).resolves.toEqual({
        version: 2, kind: 'rejected', launchAuthorized: false,
      });
      expect(f.authority.verifyCurrentAuthorityInTransaction).not.toHaveBeenCalled();
    }
  });

  test('requires an exact worker-origin catalog/view attestation before authority', async () => {
    const missing = fixture({ selectedToolViewAttestation: '' });
    await expect(missing.boundary.claim(missing.request)).resolves.toEqual({
      version: 2, kind: 'rejected', launchAuthorized: false,
    });
    expect(missing.authority.verifyCurrentAuthorityInTransaction).not.toHaveBeenCalled();

    const forged = fixture({
      selectedAttestationKey: { ...attestationKey, secret: Buffer.alloc(32, 12) },
    });
    await expect(forged.boundary.claim(forged.request)).resolves.toEqual({
      version: 2, kind: 'rejected', launchAuthorized: false,
    });
    expect(forged.authority.verifyCurrentAuthorityInTransaction).not.toHaveBeenCalled();

    const wrongBinding = fixture({
      selectedAttestationKey: { ...attestationKey, workerCredentialId: 'other-credential' },
    });
    await expect(wrongBinding.boundary.claim(wrongBinding.request)).resolves.toEqual({
      version: 2, kind: 'rejected', launchAuthorized: false,
    });
    expect(wrongBinding.authority.verifyCurrentAuthorityInTransaction).not.toHaveBeenCalled();

    const crossTenantCollision = fixture({
      selectedAttestationKey: {
        ...attestationKey, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    });
    await expect(crossTenantCollision.boundary.claim(crossTenantCollision.request))
      .resolves.toEqual({ version: 2, kind: 'rejected', launchAuthorized: false });
    expect(crossTenantCollision.authority.verifyCurrentAuthorityInTransaction)
      .not.toHaveBeenCalled();

    const otherWorker = fixture();
    await expect(otherWorker.boundary.claim({
      ...otherWorker.request, workerRunId: 'other-worker',
    })).resolves.toEqual({ version: 2, kind: 'rejected', launchAuthorized: false });
    expect(otherWorker.authority.verifyCurrentAuthorityInTransaction).not.toHaveBeenCalled();
  });

  test('allows only a new transition to launch; duplicate same/different IDs are content-free', async () => {
    expect(identity).toEqual(sharedVector.identity);
    const first = fixture();
    await expect(first.boundary.claim(first.request)).resolves.toEqual({
      version: 2, kind: 'transitioned', launchAuthorized: true,
      brokerRunGrant: {
        version: 1,
        operationNamespace: {
          version: 1,
          namespace: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          tenantId: identity.tenantId,
          runId: identity.runId,
          workerRunId,
          dispatchRequestSha256: identity.requestSha256,
        },
      },
    });
    expect(first.resolveToolViewAttestationKey).toHaveBeenCalledWith({
      tenantId: identity.tenantId,
      scopeId: identity.scopeId,
      workerAudience: identity.workerAudience,
      workerIngressId: identity.workerIngressId,
      workerGeneration: identity.workerGeneration,
      workerCredentialId: identity.workerCredentialId,
    });
    expect(first.authority.verifyCurrentAuthorityInTransaction).toHaveBeenCalledTimes(1);
    const duplicate = fixture({ state: 'claimed' });
    await expect(duplicate.boundary.claim(duplicate.request)).resolves.toEqual({
      version: 2, kind: 'status_only', launchAuthorized: false,
    });
    await expect(duplicate.boundary.claim({ ...duplicate.request, workerRunId: 'other-worker' }))
      .resolves.toEqual({ version: 2, kind: 'rejected', launchAuthorized: false });
    expect(duplicate.authority.verifyCurrentAuthorityInTransaction).not.toHaveBeenCalled();
  });

  test('closes on current-authority denial or error', async () => {
    const denied = fixture({ authorityDecision: false });
    await expect(denied.boundary.claim(denied.request)).resolves.toEqual({
      version: 2, kind: 'rejected', launchAuthorized: false,
    });
    const error = fixture({ authorityThrows: true });
    await expect(error.boundary.claim(error.request)).resolves.toEqual({
      version: 2, kind: 'UNKNOWN', reason: 'commit_unconfirmed', launchAuthorized: false,
    });
  });

  test('copies all caller-owned input before the first await', async () => {
    const f = fixture();
    const input = { ...f.request };
    const pending = f.boundary.claim(input);
    input.tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    Object.assign(input, {
      receivedMethod: 'PUT', receivedPath: '/p/other/v1/runs',
      receivedContentType: 'application/json; charset=utf-8',
    });
    input.runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    input.requestSha256 = 'f'.repeat(64);
    input.workerRunId = 'other-worker';
    input.bearer = 'tampered';
    input.toolViewAttestation = 'tampered';
    input.bodyBytes[0] = input.bodyBytes[0]! ^ 1;
    input.sessionHeaderValue = 'tampered';
    input.idempotencyKeyHeaderValue = 'tampered';
    input.serviceSecretHeaderValue = 'tampered';
    await expect(pending).resolves.toEqual({
      version: 2, kind: 'transitioned', launchAuthorized: true,
      brokerRunGrant: {
        version: 1,
        operationNamespace: {
          version: 1,
          namespace: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          tenantId: identity.tenantId,
          runId: identity.runId,
          workerRunId,
          dispatchRequestSha256: identity.requestSha256,
        },
      },
    });
    expect(f.repo.claim.mock.calls[0]?.[0]).toMatchObject({
      tenantId, runId, requestSha256: identity.requestSha256, workerRunId,
    });
  });
});
