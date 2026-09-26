import {
  createMeriDispatchRequestIdentityV2,
  isMeriDispatchIntentObservationV2,
  isMeriDispatchIntentStateV2,
  isMeriDispatchRequestIdentityV2,
  matchesMeriDispatchRequestMaterialV2,
  matchesMeriDispatchReceivedRequestV2,
  meriDispatchExpectedPrivateSessionKeyV2,
  meriDispatchClaimDispositionV2,
  type MeriDispatchRequestMaterialV2,
} from './meri-hermes-dispatch-intent.contract.js';

const DIGEST = 'a'.repeat(64);
const BASE: MeriDispatchRequestMaterialV2 = {
  metadata: {
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
    idempotencyKey: 'phase4-intent-1',
    conversationEpoch: 3,
    workerAudience: 'meri-hermes-scope-worker',
    workerIngressId: 'ingress-2026-09-a',
    workerGeneration: 'worker-image-sha256:2026',
    workerCredentialId: 'worker-credential-2026-09',
    authorizationVersion: 'envelope-auth-v8',
    authorizationPolicyVersion: 'policy-v8',
    grantVersion: 'grant-v4',
    catalogDigest: DIGEST,
    toolViewDigest: 'b'.repeat(64),
    sessionHeaderKeyId: 'dispatch-hmac-2026-09',
    claimNotAfterEpochMicros: '1790366400000000',
    deliveryNotAfterEpochMicros: '1790366460000000',
    workerCredentialNotAfterEpochMicros: '1790366460000000',
    reconciliationNotAfterEpochMicros: '1790456460000000',
    retainUntilEpochMicros: '1790546460000000',
  },
  sourceMessage: {
    body: 'original user message',
    metadata: { runtime: 'hermes', provenance: { mode: 'new' } },
  },
  bodyBytes: Buffer.from('{"input":"hello","model":"luna","instructions":"governed"}', 'utf8'),
  sessionKeyHeaderValue: 'tenant:11111111-1111-4111-8111-111111111111:user:22222222-2222-4222-8222-222222222222:conversation:33333333-3333-4333-8333-333333333333:e3',
  sessionHeaderHmacKey: Buffer.alloc(32, 7),
};

describe('dormant Phase 4 no-copy dispatch identity v1', () => {
  test('is deterministic and retains only hashes of exact body and session header', () => {
    const first = createMeriDispatchRequestIdentityV2(BASE);
    const second = createMeriDispatchRequestIdentityV2({
      ...BASE,
      metadata: { ...BASE.metadata },
      bodyBytes: Buffer.from(BASE.bodyBytes),
      sessionHeaderHmacKey: Buffer.from(BASE.sessionHeaderHmacKey),
    });
    expect(first).toEqual(second);
    expect(isMeriDispatchRequestIdentityV2(first)).toBe(true);
    expect(matchesMeriDispatchRequestMaterialV2(first, BASE)).toBe(true);
    const persisted = JSON.stringify(first);
    expect(persisted).not.toContain('governed');
    expect(persisted).not.toContain('original user message');
    expect(persisted).not.toContain(BASE.sessionKeyHeaderValue);
    expect(persisted).not.toContain('07070707');
    expect(Object.isFrozen(first)).toBe(true);
  });

  test('binds exact body bytes, not a reconstructed JSON object', () => {
    const original = createMeriDispatchRequestIdentityV2(BASE);
    const reordered = createMeriDispatchRequestIdentityV2({
      ...BASE,
      bodyBytes: Buffer.from('{"model":"luna","input":"hello","instructions":"governed"}', 'utf8'),
    });
    expect(reordered.bodySha256).not.toBe(original.bodySha256);
    expect(reordered.requestSha256).not.toBe(original.requestSha256);
    expect(matchesMeriDispatchRequestMaterialV2(original, { ...BASE, bodyBytes: Buffer.from(
      '{"model":"luna","input":"hello","instructions":"governed"}', 'utf8',
    ) })).toBe(false);
  });

  test('matches only exact received bytes and session/idempotency headers with the API-owned V2 HMAC key', () => {
    const identity = createMeriDispatchRequestIdentityV2(BASE);
    const match = (body: unknown, header: unknown, key: unknown, expected: unknown = identity,
      idempotencyHeader: unknown = identity.idempotencyKey) =>
      matchesMeriDispatchReceivedRequestV2(expected, body, header, idempotencyHeader, key);
    expect(match(BASE.bodyBytes, BASE.sessionKeyHeaderValue, BASE.sessionHeaderHmacKey)).toBe(true);
    expect(match(Buffer.from('{"model":"luna","input":"hello","instructions":"governed"}'),
      BASE.sessionKeyHeaderValue, BASE.sessionHeaderHmacKey)).toBe(false);
    expect(match(Buffer.from(BASE.bodyBytes).fill(0), BASE.sessionKeyHeaderValue,
      BASE.sessionHeaderHmacKey)).toBe(false);
    expect(match(BASE.bodyBytes, `${BASE.sessionKeyHeaderValue}:e4`, BASE.sessionHeaderHmacKey)).toBe(false);
    expect(match(BASE.bodyBytes, BASE.sessionKeyHeaderValue, BASE.sessionHeaderHmacKey,
      identity, 'different-idempotency-key')).toBe(false);
    expect(match(BASE.bodyBytes, BASE.sessionKeyHeaderValue, BASE.sessionHeaderHmacKey,
      identity, 'bad key with whitespace')).toBe(false);
    expect(match(BASE.bodyBytes, BASE.sessionKeyHeaderValue, Buffer.alloc(32, 8))).toBe(false);
    expect(match(BASE.bodyBytes, BASE.sessionKeyHeaderValue, Buffer.alloc(31, 7))).toBe(false);
    expect(match(BASE.bodyBytes, BASE.sessionKeyHeaderValue, BASE.sessionHeaderHmacKey,
      { ...identity, requestSha256: 'f'.repeat(64) })).toBe(false);
    expect(match('same JSON, not bytes', BASE.sessionKeyHeaderValue,
      BASE.sessionHeaderHmacKey)).toBe(false);
  });

  test('binds the persisted source-message body and canonical JSON provenance to the outbound assembly', () => {
    const original = createMeriDispatchRequestIdentityV2(BASE);
    const reorderedMetadata = createMeriDispatchRequestIdentityV2({
      ...BASE,
      sourceMessage: {
        ...BASE.sourceMessage,
        metadata: { provenance: { mode: 'new' }, runtime: 'hermes' },
      },
    });
    const changedBody = createMeriDispatchRequestIdentityV2({
      ...BASE,
      sourceMessage: { ...BASE.sourceMessage, body: 'different user message' },
    });
    expect(reorderedMetadata.sourceMessageSha256).toBe(original.sourceMessageSha256);
    expect(reorderedMetadata.requestAssemblySha256).toBe(original.requestAssemblySha256);
    expect(changedBody.sourceMessageSha256).not.toBe(original.sourceMessageSha256);
    expect(changedBody.requestAssemblySha256).not.toBe(original.requestAssemblySha256);
    expect(changedBody.requestSha256).not.toBe(original.requestSha256);
  });

  test('binds header identity, scope, generation, grant and all expiry horizons', () => {
    const original = createMeriDispatchRequestIdentityV2(BASE);
    const changedActor = {
      ...BASE.metadata,
      actorId: '99999999-9999-4999-8999-999999999999',
      scopeId: 'tenant:11111111-1111-4111-8111-111111111111:user:99999999-9999-4999-8999-999999999999',
    };
    const changedEpoch = { ...BASE.metadata, conversationEpoch: 4 };
    const variations: MeriDispatchRequestMaterialV2[] = [
      { ...BASE, sessionHeaderHmacKey: Buffer.alloc(32, 8) },
      { ...BASE, metadata: changedActor,
        sessionKeyHeaderValue: meriDispatchExpectedPrivateSessionKeyV2(changedActor) },
      { ...BASE, metadata: { ...BASE.metadata, clientId: '66666666-6666-4666-8666-666666666666' } },
      { ...BASE, metadata: { ...BASE.metadata, workspaceId: '77777777-7777-4777-8777-777777777777' } },
      { ...BASE, metadata: changedEpoch,
        sessionKeyHeaderValue: meriDispatchExpectedPrivateSessionKeyV2(changedEpoch) },
      { ...BASE, metadata: { ...BASE.metadata, workerAudience: 'other-worker-audience' } },
      { ...BASE, metadata: { ...BASE.metadata, workerIngressId: 'ingress-2026-09-b' } },
      { ...BASE, metadata: { ...BASE.metadata, workerGeneration: 'worker-image-sha256:2027' } },
      { ...BASE, metadata: { ...BASE.metadata, workerCredentialId: 'worker-credential-2026-10' } },
      { ...BASE, metadata: { ...BASE.metadata, authorizationVersion: 'envelope-auth-v9' } },
      { ...BASE, metadata: { ...BASE.metadata, authorizationPolicyVersion: 'policy-v9' } },
      { ...BASE, metadata: { ...BASE.metadata, grantVersion: 'grant-v5' } },
      { ...BASE, metadata: { ...BASE.metadata, catalogDigest: 'c'.repeat(64) } },
      { ...BASE, metadata: { ...BASE.metadata, toolViewDigest: 'd'.repeat(64) } },
      { ...BASE, metadata: { ...BASE.metadata, sessionHeaderKeyId: 'dispatch-hmac-2026-10' } },
      { ...BASE, metadata: { ...BASE.metadata, idempotencyKey: 'phase4-intent-2' } },
      { ...BASE, metadata: { ...BASE.metadata, claimNotAfterEpochMicros: '1790366400000001' } },
      { ...BASE, metadata: { ...BASE.metadata, deliveryNotAfterEpochMicros: '1790366460000001' } },
      { ...BASE, metadata: { ...BASE.metadata, workerCredentialNotAfterEpochMicros: '1790366460000001' } },
      { ...BASE, metadata: { ...BASE.metadata, reconciliationNotAfterEpochMicros: '1790456460000001' } },
      { ...BASE, metadata: { ...BASE.metadata, retainUntilEpochMicros: '1790546460000001' } },
    ];
    for (const changed of variations) {
      expect(createMeriDispatchRequestIdentityV2(changed).requestSha256).not.toBe(original.requestSha256);
    }
  });

  test('rejects unknown fields, drifted digest, noncanonical IDs and insufficient retention', () => {
    const valid = createMeriDispatchRequestIdentityV2(BASE);
    const withInvalidMetadata = (overrides: Record<string, unknown>): MeriDispatchRequestMaterialV2 => ({
      ...BASE,
      metadata: { ...BASE.metadata, ...overrides } as typeof BASE.metadata,
    });
    expect(isMeriDispatchRequestIdentityV2({ ...valid, futureField: 'ignored' })).toBe(false);
    expect(isMeriDispatchRequestIdentityV2({ ...valid, bodySha256: 'c'.repeat(64) })).toBe(false);
    expect(isMeriDispatchRequestIdentityV2({ ...valid, actorId: valid.actorId.toUpperCase() })).toBe(false);
    expect(() => createMeriDispatchRequestIdentityV2(withInvalidMetadata({ actorType: 'service' })))
      .toThrow('invalid dispatch request metadata');
    expect(() => createMeriDispatchRequestIdentityV2(withInvalidMetadata({ meriAudience: 'room' })))
      .toThrow('invalid dispatch request metadata');
    expect(() => createMeriDispatchRequestIdentityV2(withInvalidMetadata({ scopeId: 'tenant:other:user:other' })))
      .toThrow('invalid dispatch request metadata');
    expect(() => createMeriDispatchRequestIdentityV2(withInvalidMetadata({ authorizationVersion: '' })))
      .toThrow('invalid dispatch request metadata');
    expect(() => createMeriDispatchRequestIdentityV2({
      ...BASE,
      metadata: { ...BASE.metadata, retainUntilEpochMicros: BASE.metadata.reconciliationNotAfterEpochMicros },
    })).toThrow('invalid dispatch request metadata');
    expect(() => createMeriDispatchRequestIdentityV2(withInvalidMetadata({
      reconciliationNotAfterEpochMicros: '1790452859999999',
    }))).toThrow('invalid dispatch request metadata');
    expect(() => createMeriDispatchRequestIdentityV2(withInvalidMetadata({
      workerCredentialNotAfterEpochMicros: BASE.metadata.reconciliationNotAfterEpochMicros,
    }))).toThrow('invalid dispatch request metadata');
    expect(() => createMeriDispatchRequestIdentityV2(withInvalidMetadata({
      retainUntilEpochMicros: '1790542859999999',
    }))).toThrow('invalid dispatch request metadata');
    expect(() => createMeriDispatchRequestIdentityV2(withInvalidMetadata({
      retainUntilEpochMicros: '9223372036854775808',
    }))).toThrow('invalid dispatch request metadata');
    expect(() => createMeriDispatchRequestIdentityV2({
      ...BASE,
      sessionHeaderHmacKey: Buffer.alloc(8),
    })).toThrow('invalid dispatch request material');
    expect(() => createMeriDispatchRequestIdentityV2({
      ...BASE,
      sessionKeyHeaderValue: `${BASE.sessionKeyHeaderValue.slice(0, -1)}4`,
    })).toThrow('invalid dispatch request material');
    expect(() => createMeriDispatchRequestIdentityV2({
      ...BASE,
      sessionKeyHeaderValue: 'safe\r\nInjected: bad',
    })).toThrow('invalid dispatch request material');
    expect(() => createMeriDispatchRequestIdentityV2({
      ...BASE,
      metadata: { ...BASE.metadata, idempotencyKey: 'safe\nInjected' },
    })).toThrow('invalid dispatch request metadata');
    expect(() => createMeriDispatchRequestIdentityV2({
      ...BASE,
      metadata: { ...BASE.metadata, idempotencyKey: 'x'.repeat(201) },
    })).toThrow('invalid dispatch request metadata');
  });

  test('maps current private sessionEpoch 0 and positive epochs to exact header values', () => {
    const epochZero = { ...BASE.metadata, conversationEpoch: 0 };
    expect(meriDispatchExpectedPrivateSessionKeyV2(epochZero))
      .toBe(`${epochZero.scopeId}:conversation:${epochZero.conversationId}`);
    expect(meriDispatchExpectedPrivateSessionKeyV2(BASE.metadata))
      .toBe(BASE.sessionKeyHeaderValue);
  });
});

describe('dormant Phase 4 intent state/observation v1', () => {
  const prepared = {
    version: 2, state: 'prepared', workerRunId: null, claimedAtEpochMicros: null,
    sealedAbsentAtEpochMicros: null, absenceProofSha256: null,
  } as const;
  const claimed = {
    version: 2, state: 'claimed', workerRunId: 'worker-run-1', claimedAtEpochMicros: '1790366399000000',
    sealedAbsentAtEpochMicros: null, absenceProofSha256: null,
  } as const;
  const absent = {
    version: 2, state: 'sealed_absent', workerRunId: null, claimedAtEpochMicros: null,
    sealedAbsentAtEpochMicros: '1790366461000000', absenceProofSha256: DIGEST,
  } as const;

  test('recognizes only the three durable states with mutually exclusive facts', () => {
    expect(isMeriDispatchIntentStateV2(prepared)).toBe(true);
    expect(isMeriDispatchIntentStateV2(claimed)).toBe(true);
    expect(isMeriDispatchIntentStateV2(absent)).toBe(true);
    expect(isMeriDispatchIntentStateV2({ ...claimed, sealedAbsentAtEpochMicros: '1790366461000000' })).toBe(false);
    expect(isMeriDispatchIntentStateV2({ ...claimed, claimedAtEpochMicros: '0' })).toBe(false);
    expect(isMeriDispatchIntentStateV2({ ...claimed, claimedAtEpochMicros: '9223372036854775808' }))
      .toBe(false);
    expect(isMeriDispatchIntentStateV2({ ...claimed, workerRunId: 'w'.repeat(121) })).toBe(false);
    expect(isMeriDispatchIntentStateV2({ ...absent, workerRunId: 'worker-run-1' })).toBe(false);
    expect(isMeriDispatchIntentStateV2({ ...absent, sealedAbsentAtEpochMicros: '0' })).toBe(false);
    expect(isMeriDispatchIntentStateV2({ ...prepared, state: 'UNKNOWN' })).toBe(false);
    expect(isMeriDispatchIntentStateV2({ ...prepared, version: 1 })).toBe(false);
    expect(isMeriDispatchIntentObservationV2({ version: 2, kind: 'known', intent: prepared })).toBe(true);
    expect(isMeriDispatchIntentObservationV2({ version: 2, kind: 'UNKNOWN', reason: 'read_unavailable' }))
      .toBe(true);
    expect(isMeriDispatchIntentObservationV2({ version: 2, kind: 'UNKNOWN', reason: 'absence_unproven' }))
      .toBe(true);
    expect(isMeriDispatchIntentObservationV2({ version: 2, kind: 'UNKNOWN', state: 'sealed_absent' }))
      .toBe(false);
  });

  test('never interprets timeout or a duplicate claim as launch permission or absence', () => {
    expect(meriDispatchClaimDispositionV2({ version: 2, kind: 'known', intent: prepared }))
      .toBe('requires_authoritative_transaction');
    expect(meriDispatchClaimDispositionV2({ version: 2, kind: 'known', intent: claimed })).toBe('status_only');
    expect(meriDispatchClaimDispositionV2({ version: 2, kind: 'known', intent: absent })).toBe('deny');
    expect(meriDispatchClaimDispositionV2({ version: 2, kind: 'UNKNOWN', reason: 'gate_response_unconfirmed' }))
      .toBe('status_only');
  });
});
