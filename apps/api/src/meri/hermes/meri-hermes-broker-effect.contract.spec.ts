import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  MERI_HERMES_BROKER_EFFECT_RECEIPT_PURPOSE,
  MERI_HERMES_CLARIFICATION_INSTRUCTION,
  MERI_HERMES_FETCH_ATTACHMENT_TOOL,
  MERI_HERMES_MEMORY_SEARCH_TOOL,
  MERI_HERMES_PROPOSE_MEMORY_TOOL,
  createMeriHermesClarificationEffectIdentityV1,
  createMeriHermesMemoryProposalEffectIdentityV1,
  createMeriHermesRecordTurnEffectIdentityV1,
  meriHermesClarificationEffectResultV1,
  meriHermesClarificationReceiptClaimsSha256V1,
  meriHermesClarificationRequestIdV1,
  meriHermesClarificationRequestSha256V1,
  meriHermesMemoryProposalEffectResultV1,
  meriHermesMemoryProposalReceiptClaimsSha256V1,
  meriHermesMemoryProposalRequestSha256V1,
  meriHermesReadEffectRetryRequiresReconcilerV1,
  meriHermesBrokerEffectReceiptClaimsSha256V1,
  createMeriHermesOperationNamespaceV1,
  isMeriHermesOperationNamespaceV1,
  deriveOperationIdV1,
  createMeriHermesBrokerRunGrantV1,
  MERI_HERMES_MAX_OPERATION_SLOT,
  meriHermesBrokerEffectReceiptSha256V1,
  meriHermesBrokerEffectResultV1,
  meriHermesRecordTurnRequestSha256V1,
  normalizeMeriHermesClarificationRequestV1,
  normalizeMeriHermesMemoryProposalRequestV1,
  parseMeriHermesClarificationEffectReceiptV1,
  parseMeriHermesMemoryProposalEffectReceiptV1,
  parseMeriHermesBrokerEffectReceiptV1,
  type MeriHermesBrokerEffectReceiptFactsV1,
  type MeriHermesBrokerEffectReceiptKeyV1,
  type MeriHermesBrokerEffectReceiptRowV1,
  type MeriHermesClarificationEffectReceiptFactsV1,
  type MeriHermesMemoryProposalEffectReceiptFactsV1,
} from './meri-hermes-broker-effect.contract.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const operationId = '44444444-4444-4444-8444-444444444444';
const scopeId = `tenant:${tenantId}:user:${userId}`;
const dispatchRequestSha256 = 'a'.repeat(64);
const request = Object.freeze({ userChars: 12, assistantChars: null });
const identity = createMeriHermesRecordTurnEffectIdentityV1({
  tenantId, runId, workerRunId: 'hermes-run-1', dispatchRequestSha256,
  scopeId, operationId, request,
});
const pair = generateKeyPairSync('ed25519');
const publicKeySpkiDer = pair.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
const qualificationSha256 = 'b'.repeat(64);
const key: MeriHermesBrokerEffectReceiptKeyV1 = Object.freeze({
  purpose: MERI_HERMES_BROKER_EFFECT_RECEIPT_PURPOSE,
  keyId: 'effect-key-1', tenantId, scopeId,
  publicKeySpkiDer: Uint8Array.from(publicKeySpkiDer),
  publicKeySpkiSha256: createHash('sha256').update(publicKeySpkiDer).digest('hex'),
  notBeforeEpochMicros: '1000000', notAfterEpochMicros: '9000000',
  qualificationSha256,
});
const registry = new Map([[key.keyId, key]]);

function independentlyDigest(parts: readonly string[]): string {
  const buffers: Buffer[] = [];
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(4);
    length.writeInt32BE(bytes.length);
    buffers.push(length, bytes);
  }
  return createHash('sha256').update(Buffer.concat(buffers)).digest('hex');
}

function receiptRow(
  facts: MeriHermesBrokerEffectReceiptFactsV1,
  signed = true,
): MeriHermesBrokerEffectReceiptRowV1 {
  const claims = meriHermesBrokerEffectReceiptClaimsSha256V1(identity, facts);
  const signature = signed
    ? sign(null, Buffer.from(claims, 'hex'), pair.privateKey).toString('base64url')
    : null;
  const signerKeyId = signed ? key.keyId : null;
  const qualification = signed ? qualificationSha256 : null;
  return {
    receipt_id: '55555555-5555-4555-8555-555555555555',
    result: facts.result, detail: facts.detail,
    broker_calls_before: facts.brokerCallsBefore,
    broker_calls_after: facts.brokerCallsAfter, event_seq: facts.eventSeq,
    applied_at: new Date('2026-09-26T12:00:00.000Z'),
    applied_at_epoch_micros: 5_000_000n,
    retain_until_epoch_micros: 7_776_005_000_000n,
    signed_claims_sha256: claims, signer_key_id: signerKeyId, signature,
    signature_verified_at_epoch_micros: signed ? 4_000_000n : null,
    qualification_sha256: qualification,
    receipt_sha256: meriHermesBrokerEffectReceiptSha256V1(
      claims, signerKeyId, signature, qualification,
    ),
  };
}

describe('Phase 4 broker-effect contract', () => {
  it('matches PostgreSQL length-framed request hashing and excludes operation identity', () => {
    const expected = independentlyDigest([
      'capiro.meri.phase4.broker-effect-request/v1', tenantId, runId,
      'hermes-run-1', dispatchRequestSha256, scopeId, 'meri_record_turn', '12', 'null',
    ]);
    expect(identity.requestSha256).toBe(expected);
    expect(meriHermesRecordTurnRequestSha256V1({
      tenantId, runId, workerRunId: 'hermes-run-1', dispatchRequestSha256,
      scopeId, request: { assistantChars: null, userChars: 12 },
    })).toBe(expected);
    expect(createMeriHermesRecordTurnEffectIdentityV1({
      tenantId, runId, workerRunId: 'hermes-run-1', dispatchRequestSha256,
      scopeId, operationId: '66666666-6666-4666-8666-666666666666', request,
    }).requestSha256).toBe(expected);
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it.each([
    { userChars: -1, assistantChars: null },
    { userChars: 1.5, assistantChars: null },
    { userChars: 100_000_001, assistantChars: null },
    { userChars: 1, assistantChars: null, unexpected: true },
  ])('rejects a noncanonical request %#', (badRequest) => {
    expect(() => meriHermesRecordTurnRequestSha256V1({
      tenantId, runId, workerRunId: 'hermes-run-1', dispatchRequestSha256,
      scopeId, request: badRequest as never,
    })).toThrow();
  });

  it('verifies an exact signed committed receipt and exposes only normalized facts', () => {
    const row = receiptRow({ result: 'committed', detail: 'recorded',
      brokerCallsBefore: 2, brokerCallsAfter: 3, eventSeq: 9 });
    const receipt = parseMeriHermesBrokerEffectReceiptV1(row, identity, registry);
    expect(receipt).toMatchObject({
      signed: true, result: 'committed', resultSummary: 'recorded',
      domainRef: 'meri_institutional_memory', signerKeyId: key.keyId,
      signatureVerifiedAtEpochMicros: '4000000',
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(meriHermesBrokerEffectResultV1(receipt)).toMatchObject({
      kind: 'committed', result: { recorded: true,
        authoritativeMemory: 'meri_institutional_memory' },
    });
  });

  it('verifies signed denial facts and rejects signed uncertainty', () => {
    const denied = parseMeriHermesBrokerEffectReceiptV1(receiptRow({
      result: 'denied_before_effect', detail: 'stop_requested',
      brokerCallsBefore: 2, brokerCallsAfter: 2, eventSeq: null,
    }), identity, registry);
    expect(meriHermesBrokerEffectResultV1(denied)).toMatchObject({
      kind: 'denied_before_effect',
      result: { recorded: false, detail: 'stop_requested' },
    });
    const signedUnknown = parseMeriHermesBrokerEffectReceiptV1(receiptRow({
      result: 'effect_unknown', detail: 'caller_reported_unknown',
      brokerCallsBefore: 2, brokerCallsAfter: 2, eventSeq: null,
    }), identity, registry);
    expect(signedUnknown).toBeNull();
    expect(meriHermesBrokerEffectResultV1(signedUnknown)).toEqual({
      kind: 'effect_unknown', receipt: null,
    });
  });

  it('accepts only fully null unsigned evidence for effect_unknown', () => {
    const unknown = receiptRow({ result: 'effect_unknown', detail: 'caller_reported_unknown',
      brokerCallsBefore: 7, brokerCallsAfter: 7, eventSeq: null }, false);
    const parsed = parseMeriHermesBrokerEffectReceiptV1(unknown, identity, new Map());
    expect(meriHermesBrokerEffectResultV1(parsed)).toMatchObject({
      kind: 'effect_unknown', receipt: { signed: false, signerKeyId: null },
    });
    expect(parseMeriHermesBrokerEffectReceiptV1(
      { ...unknown, signer_key_id: key.keyId }, identity, registry,
    )).toBeNull();
  });

  it('checks DB facts, claims, receipt integrity, qualification, key window and signature', () => {
    const row = receiptRow({ result: 'committed', detail: 'recorded',
      brokerCallsBefore: 0, brokerCallsAfter: 1, eventSeq: 1 });
    expect(parseMeriHermesBrokerEffectReceiptV1(
      { ...row, broker_calls_after: 2 }, identity, registry,
    )).toBeNull();
    expect(parseMeriHermesBrokerEffectReceiptV1(
      { ...row, signed_claims_sha256: 'c'.repeat(64) }, identity, registry,
    )).toBeNull();
    expect(parseMeriHermesBrokerEffectReceiptV1(
      { ...row, receipt_sha256: 'c'.repeat(64) }, identity, registry,
    )).toBeNull();
    const badSignature = `${row.signature![0] === 'A' ? 'B' : 'A'}${row.signature!.slice(1)}`;
    expect(parseMeriHermesBrokerEffectReceiptV1(
      { ...row, signature: badSignature }, identity, registry,
    )).toBeNull();
    expect(parseMeriHermesBrokerEffectReceiptV1(
      { ...row, qualification_sha256: 'c'.repeat(64) }, identity, registry,
    )).toBeNull();
    expect(parseMeriHermesBrokerEffectReceiptV1(row, identity, new Map([[key.keyId, {
      ...key, notBeforeEpochMicros: '4000001',
    }]]))).toBeNull();
    expect(parseMeriHermesBrokerEffectReceiptV1(row, identity, new Map([[key.keyId, {
      ...key, keyId: 'different-effect-key',
    }]]))).toBeNull();
    expect(parseMeriHermesBrokerEffectReceiptV1(
      { ...row, unexpected: true }, identity, registry,
    )).toBeNull();
  });

  it('validates a historical replay against signing time, not the process clock', () => {
    const row = receiptRow({ result: 'denied_before_effect', detail: 'run_terminal',
      brokerCallsBefore: 10, brokerCallsAfter: 10, eventSeq: null });
    const historicalKey = { ...key, notAfterEpochMicros: '4000001' };
    expect(parseMeriHermesBrokerEffectReceiptV1(
      row, identity, new Map([[key.keyId, historicalKey]]),
    )).not.toBeNull();
  });
});

describe('Phase 4 clarification broker-effect contract', () => {
  const clarificationOperationId = '77777777-7777-4777-8777-777777777777';
  const clarificationRequest = normalizeMeriHermesClarificationRequestV1({
    question: '  Which client?  ', choices: ['  Acme  ', '', 'Beta'], multiSelect: true,
  });
  const clarificationIdentity = createMeriHermesClarificationEffectIdentityV1({
    tenantId, runId, workerRunId: 'hermes-run-1', dispatchRequestSha256,
    scopeId, operationId: clarificationOperationId, request: clarificationRequest,
  });

  function clarificationRow(
    facts: MeriHermesClarificationEffectReceiptFactsV1,
    signed = true,
  ): MeriHermesBrokerEffectReceiptRowV1 {
    const claims = meriHermesClarificationReceiptClaimsSha256V1(
      clarificationIdentity, facts,
    );
    const signature = signed
      ? sign(null, Buffer.from(claims, 'hex'), pair.privateKey).toString('base64url')
      : null;
    const signerKeyId = signed ? key.keyId : null;
    const qualification = signed ? qualificationSha256 : null;
    return {
      receipt_id: '88888888-8888-4888-8888-888888888888',
      result: facts.result, detail: facts.detail,
      broker_calls_before: facts.brokerCallsBefore,
      broker_calls_after: facts.brokerCallsAfter, event_seq: facts.eventSeq,
      applied_at: new Date('2026-09-26T12:00:00.000Z'),
      applied_at_epoch_micros: '5000000',
      retain_until_epoch_micros: '7776005000000',
      signed_claims_sha256: claims, signer_key_id: signerKeyId, signature,
      signature_verified_at_epoch_micros: signed ? '4000000' : null,
      qualification_sha256: qualification,
      receipt_sha256: meriHermesBrokerEffectReceiptSha256V1(
        claims, signerKeyId, signature, qualification,
      ),
    };
  }

  it('normalizes once and matches the length-framed ordered-choice digest', () => {
    expect(clarificationRequest).toEqual({
      question: 'Which client?', choices: ['Acme', 'Beta'], multiSelect: true,
    });
    expect(clarificationIdentity.requestSha256).toBe(independentlyDigest([
      'capiro.meri.phase4.broker-effect-request/v1', tenantId, runId,
      'hermes-run-1', dispatchRequestSha256, scopeId,
      'meri_request_clarification', 'Which client?', '2', 'Acme', 'Beta', 'true',
    ]));
    expect(meriHermesClarificationRequestSha256V1({
      tenantId, runId, workerRunId: 'hermes-run-1', dispatchRequestSha256,
      scopeId, request: clarificationRequest,
    })).toBe(clarificationIdentity.requestSha256);
    expect(normalizeMeriHermesClarificationRequestV1({
      question: 'Choose', choices: [], multiSelect: true,
    })).toMatchObject({ choices: [], multiSelect: false });
    expect(() => normalizeMeriHermesClarificationRequestV1({
      question: 'x'.repeat(2001),
    })).toThrow();
  });

  it('verifies the deterministic request id and signed committed facts', () => {
    const parsed = parseMeriHermesClarificationEffectReceiptV1(
      clarificationRow({ result: 'committed', detail: 'clarification_requested',
        brokerCallsBefore: 3, brokerCallsAfter: 4, eventSeq: 11 }),
      clarificationIdentity, registry,
    );
    expect(parsed).toMatchObject({
      signed: true, resultSummary: 'clarification_requested',
      domainRef: `clar_${clarificationOperationId}`,
    });
    expect(meriHermesClarificationEffectResultV1(parsed)).toEqual(expect.objectContaining({
      kind: 'committed',
      result: {
        requestId: meriHermesClarificationRequestIdV1(clarificationOperationId),
        instruction: MERI_HERMES_CLARIFICATION_INSTRUCTION,
      },
    }));
  });

  it('keeps unsigned uncertainty unresolved and rejects tampered signed facts', () => {
    const unknown = clarificationRow({
      result: 'effect_unknown', detail: 'caller_reported_unknown',
      brokerCallsBefore: 3, brokerCallsAfter: 3, eventSeq: null,
    }, false);
    expect(meriHermesClarificationEffectResultV1(
      parseMeriHermesClarificationEffectReceiptV1(
        unknown, clarificationIdentity, new Map(),
      ),
    )).toMatchObject({ kind: 'effect_unknown', receipt: { signed: false } });
    const committed = clarificationRow({
      result: 'committed', detail: 'clarification_requested',
      brokerCallsBefore: 3, brokerCallsAfter: 4, eventSeq: 11,
    });
    expect(parseMeriHermesClarificationEffectReceiptV1(
      { ...committed, event_seq: 12 }, clarificationIdentity, registry,
    )).toBeNull();
    expect(parseMeriHermesClarificationEffectReceiptV1(
      { ...committed, receipt_sha256: 'c'.repeat(64) }, clarificationIdentity, registry,
    )).toBeNull();
  });
});


describe('Phase 4 memory proposal broker-effect contract', () => {
  const memoryProposalOperationId = '99999999-9999-4999-8999-999999999999';
  const memoryProposalRequest = normalizeMeriHermesMemoryProposalRequestV1({
    key: '  user_preferred_name  ',
    value: 'Alice',
    scope: 'client',
    clientId: 'aaaa1111-bb22-cc33-dd44-555566667777',
    confidence: 0.85,
    sourceExcerpt: '  The user prefers to be called Alice  ',
  });
  const memoryProposalIdentity = createMeriHermesMemoryProposalEffectIdentityV1({
    tenantId, runId, workerRunId: 'hermes-run-1', dispatchRequestSha256,
    scopeId, operationId: memoryProposalOperationId, request: memoryProposalRequest,
  });

  function memoryProposalRow(
    facts: MeriHermesMemoryProposalEffectReceiptFactsV1,
    signed = true,
  ): MeriHermesBrokerEffectReceiptRowV1 {
    const claims = meriHermesMemoryProposalReceiptClaimsSha256V1(
      memoryProposalIdentity, facts,
    );
    const signature = signed
      ? sign(null, Buffer.from(claims, 'hex'), pair.privateKey).toString('base64url')
      : null;
    const signerKeyId = signed ? key.keyId : null;
    const qualification = signed ? qualificationSha256 : null;
    return {
      receipt_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      result: facts.result, detail: facts.detail,
      broker_calls_before: facts.brokerCallsBefore,
      broker_calls_after: facts.brokerCallsAfter, event_seq: facts.eventSeq,
      applied_at: new Date('2026-09-26T12:00:00.000Z'),
      applied_at_epoch_micros: '5000000',
      retain_until_epoch_micros: '7776005000000',
      signed_claims_sha256: claims, signer_key_id: signerKeyId, signature,
      signature_verified_at_epoch_micros: signed ? '4000000' : null,
      qualification_sha256: qualification,
      receipt_sha256: meriHermesBrokerEffectReceiptSha256V1(
        claims, signerKeyId, signature, qualification,
      ),
    };
  }

  it('normalizes once and matches the length-framed digest with IEEE-754 confidence', () => {
    expect(memoryProposalRequest).toEqual({
      key: 'user_preferred_name',
      value: 'Alice',
      scope: 'client',
      clientId: 'aaaa1111-bb22-cc33-dd44-555566667777',
      confidence: 0.85,
      sourceExcerpt: '  The user prefers to be called Alice  ',
    });
    const buf = Buffer.alloc(8);
    buf.writeDoubleBE(0.85);
    const confidenceHex = buf.toString('hex');
    expect(memoryProposalIdentity.requestSha256).toBe(independentlyDigest([
      'capiro.meri.phase4.broker-effect-request/v1', tenantId, runId,
      'hermes-run-1', dispatchRequestSha256, scopeId,
      'meri_propose_memory', 'user_preferred_name', 'Alice', 'client',
      'aaaa1111-bb22-cc33-dd44-555566667777', confidenceHex,
      '  The user prefers to be called Alice  ',
    ]));
    expect(meriHermesMemoryProposalRequestSha256V1({
      tenantId, runId, workerRunId: 'hermes-run-1', dispatchRequestSha256,
      scopeId, request: memoryProposalRequest,
    })).toBe(memoryProposalIdentity.requestSha256);
  });

  it('verifies the deterministic request id and signed committed facts', () => {
    const parsed = parseMeriHermesMemoryProposalEffectReceiptV1(
      memoryProposalRow({ result: 'committed', detail: 'memory_proposed',
        brokerCallsBefore: 5, brokerCallsAfter: 6, eventSeq: 13 }),
      memoryProposalIdentity, registry,
    );
    expect(parsed).toMatchObject({
      signed: true, resultSummary: 'memory_proposed',
      domainRef: `memcand_${memoryProposalOperationId}`,
    });
    expect(meriHermesMemoryProposalEffectResultV1(parsed, 'client')).toEqual(expect.objectContaining({
      kind: 'committed',
      result: {
        candidateId: `memcand_${memoryProposalOperationId}`,
        scope: 'client',
      },
    }));
  });

  it('keeps unsigned uncertainty unresolved and rejects tampered signed facts', () => {
    const unknown = memoryProposalRow({
      result: 'effect_unknown', detail: 'caller_reported_unknown',
      brokerCallsBefore: 5, brokerCallsAfter: 5, eventSeq: null,
    }, false);
    expect(meriHermesMemoryProposalEffectResultV1(
      parseMeriHermesMemoryProposalEffectReceiptV1(
        unknown, memoryProposalIdentity, new Map(),
      ), 'client',
    )).toMatchObject({ kind: 'effect_unknown', receipt: { signed: false } });
    const committed = memoryProposalRow({
      result: 'committed', detail: 'memory_proposed',
      brokerCallsBefore: 5, brokerCallsAfter: 6, eventSeq: 13,
    });
    expect(parseMeriHermesMemoryProposalEffectReceiptV1(
      { ...committed, event_seq: 14 }, memoryProposalIdentity, registry,
    )).toBeNull();
    expect(parseMeriHermesMemoryProposalEffectReceiptV1(
      { ...committed, receipt_sha256: 'c'.repeat(64) }, memoryProposalIdentity, registry,
    )).toBeNull();
  });

  it('validates scope/clientId constraints and null confidence', () => {
    expect(() => normalizeMeriHermesMemoryProposalRequestV1({
      key: 'x', value: 'y', scope: 'personal', clientId: 'aaaaaaaa-1111-2222-3333-444444444444',
    })).toThrow();
    expect(() => normalizeMeriHermesMemoryProposalRequestV1({
      key: 'x', value: 'y', scope: 'client',
    })).toThrow();
    expect(() => normalizeMeriHermesMemoryProposalRequestV1({
      key: 'x', value: 'y', scope: 'firm', clientId: null,
    })).not.toThrow();
    const personalResult = normalizeMeriHermesMemoryProposalRequestV1({
      key: 'x', value: 'y', scope: 'personal',
      confidence: null, sourceExcerpt: null,
    });
    expect(personalResult).toMatchObject({ clientId: null, confidence: null, sourceExcerpt: null });
  });

  it('truncates sourceExcerpt at 4000 UTF-16 code units', () => {
    const longSource = 'a'.repeat(5000);
    const normalized = normalizeMeriHermesMemoryProposalRequestV1({
      key: 'x', value: 'y', scope: 'firm', sourceExcerpt: longSource,
    });
    expect(normalized.sourceExcerpt?.length).toBe(4000);
    expect(normalized.sourceExcerpt).toBe(longSource.slice(0, 4000));
  });
});

describe('Phase 4 read-effect retry_requires_reconciler boundary', () => {
  it('produces a frozen typed rejection for retryExtraction', () => {
    const result = meriHermesReadEffectRetryRequiresReconcilerV1();
    expect(result).toEqual({
      kind: 'retry_requires_reconciler',
      tool: 'meri_fetch_attachment',
      reason: 'extraction_saga_not_available',
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('exports the read-effect tool name constants', () => {
    expect(MERI_HERMES_MEMORY_SEARCH_TOOL).toBe('meri_memory_search');
    expect(MERI_HERMES_FETCH_ATTACHMENT_TOOL).toBe('meri_fetch_attachment');
  });
});

// ── Item 5: Stable per-tool operation identity ──

const namespaceUuid = '55555555-5555-4555-8555-555555555555';
const dispatchSha = 'a'.repeat(64);

function validNsInput() {
  return {
    namespace: namespaceUuid,
    tenantId,
    runId,
    workerRunId: 'worker-run-1',
    dispatchRequestSha256: dispatchSha,
  };
}

describe('Phase 4 operation namespace', () => {
  it('creates a frozen validated namespace', () => {
    const ns = createMeriHermesOperationNamespaceV1(validNsInput());
    expect(ns.version).toBe(1);
    expect(ns.namespace).toBe(namespaceUuid);
    expect(ns.tenantId).toBe(tenantId);
    expect(Object.isFrozen(ns)).toBe(true);
    expect(isMeriHermesOperationNamespaceV1(ns)).toBe(true);
  });

  it('rejects invalid namespace UUID', () => {
    expect(() => createMeriHermesOperationNamespaceV1({
      ...validNsInput(), namespace: 'not-a-uuid',
    })).toThrow('invalid operation namespace');
  });

  it('rejects missing tenantId', () => {
    expect(() => createMeriHermesOperationNamespaceV1({
      ...validNsInput(), tenantId: '',
    })).toThrow('invalid operation namespace');
  });

  it('rejects invalid dispatchRequestSha256', () => {
    expect(() => createMeriHermesOperationNamespaceV1({
      ...validNsInput(), dispatchRequestSha256: 'short',
    })).toThrow('invalid operation namespace');
  });

  it('type guard rejects primitives and arrays', () => {
    expect(isMeriHermesOperationNamespaceV1(null)).toBe(false);
    expect(isMeriHermesOperationNamespaceV1(42)).toBe(false);
    expect(isMeriHermesOperationNamespaceV1([])).toBe(false);
    expect(isMeriHermesOperationNamespaceV1('string')).toBe(false);
  });
});

describe('Phase 4 operation ID derivation', () => {
  const ns = createMeriHermesOperationNamespaceV1(validNsInput());

  it('produces a valid UUID v5 for slot 0', () => {
    const id = deriveOperationIdV1(ns, 'meri_record_turn', 0);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('is deterministic: same inputs produce same output', () => {
    const a = deriveOperationIdV1(ns, 'meri_record_turn', 0);
    const b = deriveOperationIdV1(ns, 'meri_record_turn', 0);
    expect(a).toBe(b);
  });

  it('different slots produce different IDs', () => {
    const a = deriveOperationIdV1(ns, 'meri_record_turn', 0);
    const b = deriveOperationIdV1(ns, 'meri_record_turn', 1);
    expect(a).not.toBe(b);
  });

  it('different tools produce different IDs', () => {
    const a = deriveOperationIdV1(ns, 'meri_record_turn', 0);
    const b = deriveOperationIdV1(ns, 'meri_request_clarification', 0);
    expect(a).not.toBe(b);
  });

  it('different namespaces produce different IDs', () => {
    const ns2 = createMeriHermesOperationNamespaceV1({
      ...validNsInput(),
      namespace: '66666666-6666-4666-8666-666666666666',
    });
    const a = deriveOperationIdV1(ns, 'meri_record_turn', 0);
    const b = deriveOperationIdV1(ns2, 'meri_record_turn', 0);
    expect(a).not.toBe(b);
  });

  it('rejects slot below 0', () => {
    expect(() => deriveOperationIdV1(ns, 'meri_record_turn', -1))
      .toThrow('operation slot must be 0..40');
  });

  it('rejects slot above MAX_OPERATION_SLOT', () => {
    expect(() => deriveOperationIdV1(ns, 'meri_record_turn',
      MERI_HERMES_MAX_OPERATION_SLOT + 1))
      .toThrow('operation slot must be 0..40');
  });

  it('accepts slot at MAX_OPERATION_SLOT boundary', () => {
    const id = deriveOperationIdV1(ns, 'meri_record_turn',
      MERI_HERMES_MAX_OPERATION_SLOT);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('rejects empty tool name', () => {
    expect(() => deriveOperationIdV1(ns, '', 0))
      .toThrow('invalid tool name');
  });

  it('rejects non-integer slot', () => {
    expect(() => deriveOperationIdV1(ns, 'meri_record_turn', 1.5))
      .toThrow('operation slot must be 0..40');
  });
});

describe('Phase 4 broker run grant', () => {
  it('creates a frozen grant containing the namespace', () => {
    const ns = createMeriHermesOperationNamespaceV1(validNsInput());
    const grant = createMeriHermesBrokerRunGrantV1(ns);
    expect(grant.version).toBe(1);
    expect(grant.operationNamespace).toBe(ns);
    expect(Object.isFrozen(grant)).toBe(true);
  });

  it('rejects invalid namespace', () => {
    expect(() => createMeriHermesBrokerRunGrantV1({} as any))
      .toThrow('invalid operation namespace');
  });
});
