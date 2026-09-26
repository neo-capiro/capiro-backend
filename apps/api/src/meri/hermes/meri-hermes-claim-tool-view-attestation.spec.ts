import {
  createMeriDispatchRequestIdentityV2,
  type MeriDispatchRequestIdentityV2,
} from './meri-hermes-dispatch-intent.contract.js';
import {
  mintMeriHermesClaimToolViewAttestationV1,
  verifyMeriHermesClaimToolViewAttestationV1,
  type MeriHermesClaimToolViewAttestationKeyV1,
} from './meri-hermes-claim-tool-view-attestation.js';
import {
  computeMeriHermesObservedToolDigestsV1,
  type MeriHermesToolSchemaV1,
} from './meri-hermes-tool-view.js';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const conversationId = '33333333-3333-4333-8333-333333333333';
const runId = '55555555-5555-4555-8555-555555555555';
const scopeId = `tenant:${tenantId}:user:${actorId}`;
const body = Buffer.from('{"input":"hello"}');
const sessionKey = Buffer.alloc(32, 7);
const now = '1790366390000000';
const notBefore = '1790366380000000';
const notAfter = '1790366399000000';
const workerRunId = 'worker-run-attested-1';
const observedCatalogTools: readonly MeriHermesToolSchemaV1[] = Object.freeze([
  Object.freeze({ type: 'function' as const, function: Object.freeze({
    name: 'read', description: 'Read a document',
    parameters: Object.freeze({ type: 'object' }),
  }) }),
  Object.freeze({ type: 'function' as const, function: Object.freeze({
    name: 'search', description: 'Search memory',
    parameters: Object.freeze({ type: 'object' }),
  }) }),
]);
const observedAppliedToolSchemas = Object.freeze([...observedCatalogTools]);
const observedDigests = computeMeriHermesObservedToolDigestsV1(
  observedCatalogTools, observedAppliedToolSchemas,
);
const workerBinding = Object.freeze({
  workerAudience: 'meri-hermes-scope-worker',
  workerIngressId: 'private-ingress-a',
  workerGeneration: 'worker-image-sha256:2026',
  workerCredentialId: 'worker-credential-2026-09',
});
const keyBinding = Object.freeze({ tenantId, scopeId, ...workerBinding });
const key: MeriHermesClaimToolViewAttestationKeyV1 = {
  ...keyBinding,
  secret: Buffer.alloc(32, 11),
  notBeforeEpochMicros: '1790366300000000',
  notAfterEpochMicros: '1790366400000000',
};

function makeIdentity(
  catalogDigest = observedDigests.catalogDigest,
  toolViewDigest = observedDigests.toolViewDigest,
): MeriDispatchRequestIdentityV2 {
  return createMeriDispatchRequestIdentityV2({
    metadata: {
      version: 2, tenantId, actorType: 'user', actorId, meriAudience: 'private',
      clientId: null, workspaceId: null, scopeId, conversationId,
      userMessageId: '44444444-4444-4444-8444-444444444444',
      runId, idempotencyKey: 'phase4-attestation-spec', conversationEpoch: 3,
      ...workerBinding,
      authorizationVersion: 'authorization-v8',
      authorizationPolicyVersion: 'policy-v8', grantVersion: 'grant-v4',
      catalogDigest, toolViewDigest,
      sessionHeaderKeyId: 'dispatch-hmac-2026-09',
      claimNotAfterEpochMicros: '1790366400000000',
      deliveryNotAfterEpochMicros: '1790366460000000',
      workerCredentialNotAfterEpochMicros: '1790366460000000',
      reconciliationNotAfterEpochMicros: '1790456460000000',
      retainUntilEpochMicros: '1790546460000000',
    },
    sourceMessage: { body: 'hello source', metadata: { runtime: 'hermes' } },
    bodyBytes: body,
    sessionKeyHeaderValue: `${scopeId}:conversation:${conversationId}:e3`,
    sessionHeaderHmacKey: sessionKey,
  });
}

const identity = makeIdentity();
const mint = (
  selectedIdentity = identity,
  selectedKey = key,
  selectedCatalog = observedCatalogTools,
  selectedApplied = observedAppliedToolSchemas,
) => mintMeriHermesClaimToolViewAttestationV1({
  identity: selectedIdentity,
  workerRunId,
  observedCatalogTools: selectedCatalog,
  observedAppliedToolSchemas: selectedApplied,
  notBeforeEpochMicros: notBefore,
  notAfterEpochMicros: notAfter,
}, selectedKey);

describe('Phase 4 worker claim catalog/tool-view attestation', () => {
  test('matches the checked-in Python/TypeScript HMAC golden vector', () => {
    const vector = JSON.parse(readFileSync(resolve(
      __dirname, '../../../../../docker/hermes-worker/overlay/claim-tool-view-attestation-vectors.json',
    ), 'utf8')) as {
      identity: MeriDispatchRequestIdentityV2;
      workerRunId: string;
      observedCatalogTools: MeriHermesToolSchemaV1[];
      observedAppliedToolSchemas: MeriHermesToolSchemaV1[];
      key: Omit<MeriHermesClaimToolViewAttestationKeyV1, 'secret'> &
        { secretBase64url: string };
      notBeforeEpochMicros: string;
      notAfterEpochMicros: string;
      claims: string[];
      encoded: string;
      signatureHex: string;
      token: string;
    };
    const { secretBase64url, ...binding } = vector.key;
    const vectorKey = { ...binding, secret: Buffer.from(secretBase64url, 'base64url') };
    const minted = mintMeriHermesClaimToolViewAttestationV1({
      identity: vector.identity,
      workerRunId: vector.workerRunId,
      observedCatalogTools: vector.observedCatalogTools,
      observedAppliedToolSchemas: vector.observedAppliedToolSchemas,
      notBeforeEpochMicros: vector.notBeforeEpochMicros,
      notAfterEpochMicros: vector.notAfterEpochMicros,
    }, vectorKey);
    expect(minted).toBe(vector.token);
    expect(vector.token).toBe(`${vector.encoded}.${vector.signatureHex}`);
    expect(JSON.parse(Buffer.from(vector.encoded, 'base64url').toString('utf8'))).toEqual(vector.claims);
    expect(verifyMeriHermesClaimToolViewAttestationV1(
      vector.token, vector.identity, vector.workerRunId, vectorKey,
      vector.notBeforeEpochMicros,
    )).not.toBeNull();
  });

  test('accepts only the exact persisted route, request, catalog, view, and worker run', () => {
    const result = verifyMeriHermesClaimToolViewAttestationV1(
      mint(), identity, workerRunId, key, now,
    );
    expect(result).toMatchObject({
      version: 1, tenantId, runId, requestSha256: identity.requestSha256,
      workerRunId, ...workerBinding,
      catalogDigest: identity.catalogDigest,
      toolViewDigest: identity.toolViewDigest,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  test('recomputes observations and refuses to sign schema or applied-view drift', () => {
    const changedCatalog = observedCatalogTools.map((tool) => tool.function.name === 'read'
      ? { ...tool, function: { ...tool.function, description: 'drifted schema' } }
      : tool);
    expect(() => mint(identity, key, changedCatalog, changedCatalog)).toThrow(
      'observed Phase 4 claim tool view does not match dispatch identity',
    );
    expect(() => mint(identity, key, observedCatalogTools, [observedCatalogTools[0]!])).toThrow(
      'observed Phase 4 claim tool view does not match dispatch identity',
    );
  });

  test('rejects another worker run, request identity, catalog, or applied view', () => {
    const token = mint();
    expect(verifyMeriHermesClaimToolViewAttestationV1(
      token, identity, 'another-worker', key, now,
    )).toBeNull();
    expect(verifyMeriHermesClaimToolViewAttestationV1(
      token, makeIdentity('c'.repeat(64), identity.toolViewDigest), workerRunId, key, now,
    )).toBeNull();
    expect(verifyMeriHermesClaimToolViewAttestationV1(
      token, makeIdentity(identity.catalogDigest, 'd'.repeat(64)), workerRunId, key, now,
    )).toBeNull();
  });

  test('rejects signature, key, encoding, shape, and key-binding forgery', () => {
    const token = mint();
    const [payload, signature = ''] = token.split('.');
    expect(verifyMeriHermesClaimToolViewAttestationV1(
      `${payload}.${signature.replace(/^./, signature[0] === 'a' ? 'b' : 'a')}`,
      identity, workerRunId, key, now,
    )).toBeNull();
    expect(verifyMeriHermesClaimToolViewAttestationV1(
      token, identity, workerRunId, { ...key, secret: Buffer.alloc(32, 12) }, now,
    )).toBeNull();
    expect(verifyMeriHermesClaimToolViewAttestationV1(
      token, identity, workerRunId, { ...key, workerCredentialId: 'other-credential' }, now,
    )).toBeNull();
    expect(verifyMeriHermesClaimToolViewAttestationV1(
      token, identity, workerRunId, {
        ...key, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }, now,
    )).toBeNull();
    expect(verifyMeriHermesClaimToolViewAttestationV1(
      token, identity, workerRunId, { ...key, scopeId: `${scopeId}-collision` }, now,
    )).toBeNull();
    expect(verifyMeriHermesClaimToolViewAttestationV1(
      'not-a-token', identity, workerRunId, key, now,
    )).toBeNull();
  });

  test('enforces the exclusive DB-clock, credential, key, and one-minute windows', () => {
    const token = mint();
    expect(verifyMeriHermesClaimToolViewAttestationV1(
      token, identity, workerRunId, key, '1790366379999999',
    )).toBeNull();
    expect(verifyMeriHermesClaimToolViewAttestationV1(
      token, identity, workerRunId, key, notAfter,
    )).toBeNull();
    expect(() => mintMeriHermesClaimToolViewAttestationV1({
      identity, workerRunId, observedCatalogTools, observedAppliedToolSchemas,
      notBeforeEpochMicros: '1790366300000000',
      notAfterEpochMicros: '1790366400000001',
    }, key)).toThrow('invalid Phase 4 claim tool-view attestation window');
    expect(() => mintMeriHermesClaimToolViewAttestationV1({
      identity, workerRunId, observedCatalogTools, observedAppliedToolSchemas,
      notBeforeEpochMicros: '1790366299999999',
      notAfterEpochMicros: '1790366390000000',
    }, key)).toThrow('invalid Phase 4 claim tool-view attestation window');
    expect(() => mintMeriHermesClaimToolViewAttestationV1({
      identity, workerRunId, observedCatalogTools, observedAppliedToolSchemas,
      notBeforeEpochMicros: '1790366390000000',
      notAfterEpochMicros: '1790366400000001',
    }, key)).toThrow('invalid Phase 4 claim tool-view attestation window');
  });

  test('rejects oversized tokens and validly signed field-count tampering', () => {
    expect(verifyMeriHermesClaimToolViewAttestationV1(
      'a'.repeat(4_097), identity, workerRunId, key, now,
    )).toBeNull();
    const [encoded = ''] = mint().split('.');
    const fields = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as string[];
    fields.push('extra');
    const tamperedEncoded = Buffer.from(JSON.stringify(fields), 'utf8').toString('base64url');
    const tamperedSignature = createHmac('sha256', key.secret)
      .update(tamperedEncoded, 'ascii').digest('hex');
    expect(verifyMeriHermesClaimToolViewAttestationV1(
      `${tamperedEncoded}.${tamperedSignature}`, identity, workerRunId, key, now,
    )).toBeNull();
  });

  test('copies worker-owned key bytes before signing', () => {
    const mutable = Buffer.alloc(32, 21);
    const selectedKey = { ...key, secret: mutable };
    const token = mint(identity, selectedKey);
    mutable.fill(22);
    expect(verifyMeriHermesClaimToolViewAttestationV1(
      token, identity, workerRunId, { ...key, secret: Buffer.alloc(32, 21) }, now,
    )).not.toBeNull();
  });
});
