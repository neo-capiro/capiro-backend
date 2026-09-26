import { createHmac } from 'node:crypto';
import {
  createMeriDispatchRequestIdentityV2,
  type MeriDispatchRequestMaterialV2,
} from './meri-hermes-dispatch-intent.contract.js';
import {
  mintMeriDispatchGateBearerV1,
  verifyMeriDispatchGateBearerV1,
  type MeriDispatchGateBearerKeyV1,
} from './meri-hermes-dispatch-gate-bearer.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const SCOPE = `tenant:${TENANT}:user:${ACTOR}`;
const HEADER = `${SCOPE}:conversation:${CONVERSATION}:e3`;
const NOW = '1790366300000000';
const AFTER = '1790366350000000';
const BODY = Buffer.from('{"input":"hello","model":"luna","instructions":"governed"}', 'utf8');
const HMAC_KEY = Buffer.alloc(32, 7);
const GATE_KEY: MeriDispatchGateBearerKeyV1 = {
  secret: Buffer.alloc(32, 19),
  notBeforeEpochMicros: '1790366200000000',
  notAfterEpochMicros: '1790366500000000',
};
const KEY_ID = 'dispatch-gate-2026-09';
const MATERIAL: MeriDispatchRequestMaterialV2 = {
  metadata: {
    version: 2, tenantId: TENANT, actorType: 'user', actorId: ACTOR, meriAudience: 'private',
    clientId: null, workspaceId: null, scopeId: SCOPE, conversationId: CONVERSATION,
    userMessageId: '44444444-4444-4444-8444-444444444444',
    runId: '55555555-5555-4555-8555-555555555555',
    idempotencyKey: 'phase4-intent-1', conversationEpoch: 3,
    workerAudience: 'meri-hermes-scope-worker', workerIngressId: 'ingress-2026-09-a',
    workerGeneration: 'worker-image-sha256:2026', workerCredentialId: 'worker-credential-2026-09',
    authorizationVersion: 'envelope-auth-v8', authorizationPolicyVersion: 'policy-v8',
    grantVersion: 'grant-v4', catalogDigest: 'a'.repeat(64), toolViewDigest: 'b'.repeat(64),
    sessionHeaderKeyId: 'dispatch-hmac-2026-09',
    claimNotAfterEpochMicros: '1790366400000000',
    deliveryNotAfterEpochMicros: '1790366460000000',
    workerCredentialNotAfterEpochMicros: '1790366460000000',
    reconciliationNotAfterEpochMicros: '1790456460000000',
    retainUntilEpochMicros: '1790546460000000',
  },
  sourceMessage: { body: 'original user message', metadata: { runtime: 'hermes' } },
  bodyBytes: BODY, sessionKeyHeaderValue: HEADER, sessionHeaderHmacKey: HMAC_KEY,
};
const IDENTITY = createMeriDispatchRequestIdentityV2(MATERIAL);
const REGISTRY = new Map([[KEY_ID, GATE_KEY]]);

function resign(payloadJson: string, secret: Uint8Array = GATE_KEY.secret): string {
  const payload = Buffer.from(payloadJson, 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret)
    .update('capiro.meri.phase4.dispatch-gate-bearer/v1\0', 'utf8')
    .update(`mdgb1.${payload}`, 'ascii').digest('base64url');
  return `mdgb1.${payload}.${signature}`;
}

describe('dormant Phase 4 dispatch-gate bearer v1', () => {
  test('fixed request/time/key vector binds every run and worker claim', () => {
    const bearer = mintMeriDispatchGateBearerV1(IDENTITY, KEY_ID, GATE_KEY, NOW, AFTER);
    const [prefix, payload, signature] = bearer.split('.');
    expect(prefix).toBe('mdgb1');
    expect(signature).toHaveLength(43);
    const expectedClaims = {
      version: 1, purpose: 'meri-hermes-dispatch-gate', keyId: KEY_ID,
      tenantId: TENANT, actorType: 'user', actorId: ACTOR, scopeId: SCOPE,
      runId: MATERIAL.metadata.runId, requestSha256: IDENTITY.requestSha256,
      workerAudience: MATERIAL.metadata.workerAudience,
      workerIngressId: MATERIAL.metadata.workerIngressId,
      workerGeneration: MATERIAL.metadata.workerGeneration,
      workerCredentialId: MATERIAL.metadata.workerCredentialId,
      authorizationVersion: MATERIAL.metadata.authorizationVersion,
      reconciliationNotAfterEpochMicros: MATERIAL.metadata.reconciliationNotAfterEpochMicros,
      retainUntilEpochMicros: MATERIAL.metadata.retainUntilEpochMicros,
      notBeforeEpochMicros: NOW, notAfterEpochMicros: AFTER,
    };
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'))).toEqual(expectedClaims);
    expect(bearer).toBe(resign(JSON.stringify(expectedClaims)));
    expect(verifyMeriDispatchGateBearerV1(bearer, IDENTITY, REGISTRY, NOW))
      .toMatchObject({ runId: MATERIAL.metadata.runId, requestSha256: IDENTITY.requestSha256 });
    expect(verifyMeriDispatchGateBearerV1(bearer, IDENTITY, REGISTRY, AFTER)).toBeNull();
    expect(verifyMeriDispatchGateBearerV1(bearer, IDENTITY, REGISTRY, '1790366299999999'))
      .toBeNull();
  });

  test('rejects material mismatch, wrong key, missing key and signature tampering', () => {
    const bearer = mintMeriDispatchGateBearerV1(IDENTITY, KEY_ID, GATE_KEY, NOW, AFTER);
    const changedIdentity = createMeriDispatchRequestIdentityV2({
      ...MATERIAL, bodyBytes: Buffer.from('{"input":"different"}', 'utf8'),
    });
    expect(verifyMeriDispatchGateBearerV1(bearer, changedIdentity, REGISTRY, NOW)).toBeNull();
    expect(verifyMeriDispatchGateBearerV1(bearer, IDENTITY, new Map(), NOW)).toBeNull();
    expect(verifyMeriDispatchGateBearerV1(bearer, IDENTITY, new Map([[KEY_ID, {
      ...GATE_KEY, secret: Buffer.alloc(32, 20),
    }]]), NOW)).toBeNull();
    const changedSignature = `${bearer.slice(0, -1)}${bearer.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyMeriDispatchGateBearerV1(changedSignature, IDENTITY, REGISTRY, NOW))
      .toBeNull();
    expect(verifyMeriDispatchGateBearerV1(bearer, {
      ...IDENTITY, actorId: '99999999-9999-4999-8999-999999999999',
    },
      REGISTRY, NOW)).toBeNull();
  });

  test('rejects signed unknown, duplicate, malformed and mismatched claim payloads', () => {
    const bearer = mintMeriDispatchGateBearerV1(IDENTITY, KEY_ID, GATE_KEY, NOW, AFTER);
    const claims = JSON.parse(Buffer.from(bearer.split('.')[1]!, 'base64url').toString('utf8'));
    const changed = [
      { ...claims, extra: true },
      { ...claims, purpose: 'meri-hermes-worker' },
      { ...claims, version: 2 },
      { ...claims, keyId: 'wrong-key-id' },
      { ...claims, tenantId: '99999999-9999-4999-8999-999999999999' },
      { ...claims, actorId: '99999999-9999-4999-8999-999999999999' },
      { ...claims, scopeId: 'tenant:other:user:other' },
      { ...claims, runId: '99999999-9999-4999-8999-999999999999' },
      { ...claims, workerAudience: 'other-worker' },
      { ...claims, workerIngressId: 'other-ingress' },
      { ...claims, workerGeneration: 'other-generation' },
      { ...claims, workerCredentialId: 'other-credential' },
      { ...claims, authorizationVersion: 'other-authorization' },
      { ...claims, reconciliationNotAfterEpochMicros: '1790456460000001' },
      { ...claims, retainUntilEpochMicros: '1790546460000001' },
      { ...claims, notAfterEpochMicros: '9223372036854775808' },
    ];
    for (const value of changed) {
      expect(verifyMeriDispatchGateBearerV1(resign(JSON.stringify(value)), IDENTITY, REGISTRY, NOW))
        .toBeNull();
    }
    const duplicate = JSON.stringify(claims).replace('"tenantId":',
      '"tenantId":"99999999-9999-4999-8999-999999999999","tenantId":');
    expect(verifyMeriDispatchGateBearerV1(resign(duplicate), IDENTITY, REGISTRY, NOW)).toBeNull();
    expect(verifyMeriDispatchGateBearerV1(resign('[1,2]'), IDENTITY, REGISTRY, NOW)).toBeNull();
    expect(verifyMeriDispatchGateBearerV1(resign('{'), IDENTITY, REGISTRY, NOW)).toBeNull();
    expect(verifyMeriDispatchGateBearerV1(`${bearer}=`, IDENTITY, REGISTRY, NOW)).toBeNull();
    expect(verifyMeriDispatchGateBearerV1(bearer.replace('mdgb1.', 'mhw1.'),
      IDENTITY, REGISTRY, NOW)).toBeNull();
  });

  test('enforces exclusive claim, credential and key windows at mint and verify', () => {
    expect(() => mintMeriDispatchGateBearerV1(IDENTITY, KEY_ID, GATE_KEY, NOW,
      IDENTITY.claimNotAfterEpochMicros)).not.toThrow();
    for (const after of [NOW, '1790366400000001', '1790366460000001',
      '9223372036854775808']) {
      expect(() => mintMeriDispatchGateBearerV1(IDENTITY, KEY_ID, GATE_KEY, NOW, after)).toThrow();
    }
    expect(() => mintMeriDispatchGateBearerV1(IDENTITY, KEY_ID,
      { ...GATE_KEY, secret: Buffer.alloc(31) }, NOW, AFTER)).toThrow();
    expect(() => mintMeriDispatchGateBearerV1(IDENTITY, KEY_ID,
      { ...GATE_KEY, notBeforeEpochMicros: '1790366300000001' }, NOW, AFTER)).toThrow();
    expect(() => mintMeriDispatchGateBearerV1({ ...IDENTITY, extra: true }, KEY_ID,
      GATE_KEY, NOW, AFTER)).toThrow();
    const excessiveRetention = createMeriDispatchRequestIdentityV2({
      ...MATERIAL,
      metadata: {
        ...MATERIAL.metadata,
        retainUntilEpochMicros: (BigInt(NOW) + 8n * 86_400_000_000n).toString(),
      },
    });
    expect(() => mintMeriDispatchGateBearerV1(
      excessiveRetention, KEY_ID, GATE_KEY, NOW, AFTER,
    )).toThrow('dispatch-gate bearer outside validity window');
    const bearer = mintMeriDispatchGateBearerV1(IDENTITY, KEY_ID, GATE_KEY, NOW, AFTER);
    expect(verifyMeriDispatchGateBearerV1(bearer, IDENTITY, new Map([[KEY_ID, {
      ...GATE_KEY, notAfterEpochMicros: AFTER,
    }]]), NOW)).not.toBeNull();
    expect(verifyMeriDispatchGateBearerV1(bearer, IDENTITY, new Map([[KEY_ID, {
      ...GATE_KEY, notAfterEpochMicros: '1790366349999999',
    }]]), NOW)).toBeNull();
  });
});
