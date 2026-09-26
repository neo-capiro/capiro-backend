import { MeriHermesExactDispatchRequestV2 } from './meri-hermes-exact-dispatch-request.js';
import type { MeriDispatchRequestMetadataV2 } from './meri-hermes-dispatch-intent.contract.js';

const metadata: MeriDispatchRequestMetadataV2 = {
  version: 2,
  tenantId: '11111111-1111-4111-8111-111111111111',
  actorType: 'user',
  actorId: '22222222-2222-4222-8222-222222222222',
  meriAudience: 'private',
  clientId: null,
  workspaceId: null,
  scopeId: 'tenant:11111111-1111-4111-8111-111111111111:user:22222222-2222-4222-8222-222222222222',
  conversationId: '33333333-3333-4333-8333-333333333333',
  userMessageId: '44444444-4444-4444-8444-444444444444',
  runId: '55555555-5555-4555-8555-555555555555',
  idempotencyKey: 'phase4-build-once',
  conversationEpoch: 2,
  workerAudience: 'private-scope-worker',
  workerIngressId: 'private-ingress-v1',
  workerGeneration: 'sha256:worker-generation',
  workerCredentialId: 'worker-credential-v1',
  authorizationVersion: 'auth-v1',
  authorizationPolicyVersion: 'policy-v1',
  grantVersion: 'grant-v1',
  catalogDigest: 'a'.repeat(64),
  toolViewDigest: 'b'.repeat(64),
  sessionHeaderKeyId: 'session-hmac-v1',
  claimNotAfterEpochMicros: '1790366400000000',
  deliveryNotAfterEpochMicros: '1790366460000000',
  workerCredentialNotAfterEpochMicros: '1790366460000000',
  reconciliationNotAfterEpochMicros: '1790456460000000',
  retainUntilEpochMicros: '1790546460000000',
};

const input = {
  input: 'hello',
  sessionId: 'session-1',
  sessionKey: `${metadata.scopeId}:conversation:${metadata.conversationId}:e2`,
  idempotencyKey: metadata.idempotencyKey,
  instructions: 'governed',
  model: 'model-1',
  modelOptions: { temperature: 0 },
};
const sourceMessage = {
  body: 'hello from user',
  metadata: { runtime: 'hermes', provenance: { mode: 'new' } },
};

describe('Meri Phase 4 exact dispatch request', () => {
  test('serializes once in the pinned wire order and binds the identity to those bytes', () => {
    const sourceOptions = { temperature: 0 };
    const request = MeriHermesExactDispatchRequestV2.build({
      input: { ...input, modelOptions: sourceOptions },
      metadata,
      sourceMessage,
      sessionHeaderHmacKey: Buffer.alloc(32, 7),
      extraBody: { meri_tool_view_v1: { payload: 'p', signature: 's' } },
    });
    const expected = JSON.stringify({
      input: 'hello',
      meri_tool_view_v1: { payload: 'p', signature: 's' },
      session_id: 'session-1',
      instructions: 'governed',
      model: 'model-1',
      model_options: { temperature: 0 },
    });
    expect(Buffer.from(request.copyExactBodyBytes()).toString('utf8')).toBe(expected);
    expect(request.identity.bodyLengthBytes).toBe(Buffer.byteLength(expected));
    expect(request.sessionId).toBe('session-1');
    sourceOptions.temperature = 1;
    expect(Buffer.from(request.copyExactBodyBytes()).toString('utf8')).toBe(expected);
  });

  test('never exposes mutable authoritative storage to a transport callback', async () => {
    const request = MeriHermesExactDispatchRequestV2.build({
      input,
      metadata,
      sourceMessage,
      sessionHeaderHmacKey: Buffer.alloc(32, 7),
    });
    const before = request.copyExactBodyBytes();
    await request.withExactBodyCopy(async (body) => {
      body[0] = 0;
    });
    expect(request.copyExactBodyBytes()).toEqual(before);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.identity)).toBe(true);
  });

  test('rejects idempotency drift and extension replacement of base fields', () => {
    expect(() => MeriHermesExactDispatchRequestV2.build({
      input: { ...input, idempotencyKey: 'different' },
      metadata,
      sourceMessage,
      sessionHeaderHmacKey: Buffer.alloc(32, 7),
    })).toThrow(/idempotency key must match/);
    expect(() => MeriHermesExactDispatchRequestV2.build({
      input,
      metadata,
      sourceMessage,
      sessionHeaderHmacKey: Buffer.alloc(32, 7),
      extraBody: { model: 'replacement' },
    })).toThrow(/may not replace 'model'/);
    expect(() => MeriHermesExactDispatchRequestV2.build({
      input,
      metadata,
      sourceMessage,
      sessionHeaderHmacKey: Buffer.alloc(32, 7),
      extraBody: { 1: 'integer-like keys reorder JSON fields' },
    })).toThrow(/invalid key '1'/);
  });
});
