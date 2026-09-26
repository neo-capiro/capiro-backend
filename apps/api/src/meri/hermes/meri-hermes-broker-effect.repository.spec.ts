import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  MERI_HERMES_BROKER_EFFECT_RECEIPT_PURPOSE,
  MERI_HERMES_PROPOSE_MEMORY_TOOL,
  createMeriHermesClarificationEffectIdentityV1,
  createMeriHermesMemoryProposalEffectIdentityV1,
  createMeriHermesRecordTurnEffectIdentityV1,
  meriHermesClarificationReceiptClaimsSha256V1,
  meriHermesMemoryProposalReceiptClaimsSha256V1,
  meriHermesBrokerEffectReceiptClaimsSha256V1,
  meriHermesBrokerEffectReceiptSha256V1,
  normalizeMeriHermesMemoryProposalRequestV1,
  type MeriHermesBrokerEffectReceiptFactsV1,
  type MeriHermesBrokerEffectReceiptKeyV1,
  type MeriHermesBrokerEffectReceiptRowV1,
  type MeriHermesClarificationEffectReceiptFactsV1,
  type MeriHermesMemoryProposalEffectReceiptFactsV1,
} from './meri-hermes-broker-effect.contract.js';
import {
  MeriHermesBrokerEffectAuthorityError,
  MeriHermesBrokerEffectInputError,
  MeriHermesBrokerEffectRepositoryV1,
  type MeriHermesBrokerEffectDatabaseV1,
  type MeriHermesBrokerEffectTransactionV1,
} from './meri-hermes-broker-effect.repository.js';
const tenantId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const scopeId = `tenant:${tenantId}:user:${userId}`;
const request = Object.freeze({ userChars: 3, assistantChars: 5 });
const identity = createMeriHermesRecordTurnEffectIdentityV1({
  tenantId, runId, workerRunId: 'hermes-run-1', dispatchRequestSha256: 'a'.repeat(64),
  scopeId, operationId: '44444444-4444-4444-8444-444444444444', request,
});
const pair = generateKeyPairSync('ed25519');
const spki = pair.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
const key: MeriHermesBrokerEffectReceiptKeyV1 = {
  purpose: MERI_HERMES_BROKER_EFFECT_RECEIPT_PURPOSE,
  keyId: 'effect-key-1', tenantId, scopeId,
  publicKeySpkiDer: Uint8Array.from(spki),
  publicKeySpkiSha256: createHash('sha256').update(spki).digest('hex'),
  notBeforeEpochMicros: '1000000', notAfterEpochMicros: '9000000',
  qualificationSha256: 'b'.repeat(64),
};

function row(facts: MeriHermesBrokerEffectReceiptFactsV1, signed = true): MeriHermesBrokerEffectReceiptRowV1 {
  const claims = meriHermesBrokerEffectReceiptClaimsSha256V1(identity, facts);
  const signature = signed
    ? sign(null, Buffer.from(claims, 'hex'), pair.privateKey).toString('base64url')
    : null;
  const keyId = signed ? key.keyId : null;
  const qualification = signed ? key.qualificationSha256 : null;
  return {
    receipt_id: '55555555-5555-4555-8555-555555555555',
    result: facts.result, detail: facts.detail,
    broker_calls_before: facts.brokerCallsBefore, broker_calls_after: facts.brokerCallsAfter,
    event_seq: facts.eventSeq, applied_at: new Date('2026-09-26T12:00:00Z'),
    applied_at_epoch_micros: '5000000', retain_until_epoch_micros: '7776005000000',
    signed_claims_sha256: claims, signer_key_id: keyId, signature,
    signature_verified_at_epoch_micros: signed ? '4000000' : null,
    qualification_sha256: qualification,
    receipt_sha256: meriHermesBrokerEffectReceiptSha256V1(
      claims, keyId, signature, qualification,
    ),
  };
}

class FakeDatabase implements MeriHermesBrokerEffectDatabaseV1,
  MeriHermesBrokerEffectTransactionV1 {
  calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  rows: readonly MeriHermesBrokerEffectReceiptRowV1[] = [];
  principals = [{ current_user: 'meri_phase4_broker_effect_operator',
    session_user: 'phase4_effect_caller' }];
  fail: Error | null = null;
  boundary: (() => void) | null = null;

  async withBrokerEffectTransaction<T>(
    run: (tx: MeriHermesBrokerEffectTransactionV1) => Promise<T>,
  ): Promise<T> {
    this.boundary?.();
    if (this.fail) throw this.fail;
    return run(this);
  }

  async execute(sql: string, parameters: readonly unknown[]): Promise<void> {
    this.calls.push({ sql, parameters });
  }

  async query<T extends object>(sql: string, parameters: readonly unknown[]): Promise<readonly T[]> {
    this.calls.push({ sql, parameters });
    if (sql === 'SELECT current_user, session_user') {
      return this.principals as unknown as readonly T[];
    }
    return this.rows as unknown as readonly T[];
  }
}

function input(registry = new Map([[key.keyId, key]])) {
  return { identity, request, effectDisposition: 'attempt' as const,
    verificationKeys: registry };
}

describe('Phase 4 broker-effect repository', () => {
  it('sets the dedicated role and calls only the fixed routine with request facts', async () => {
    const db = new FakeDatabase();
    db.rows = [row({ result: 'committed', detail: 'recorded',
      brokerCallsBefore: 4, brokerCallsAfter: 5, eventSeq: 12 })];
    const result = await new MeriHermesBrokerEffectRepositoryV1(db).apply(input());
    expect(result.kind).toBe('committed');
    expect(db.calls[0]).toEqual({ sql: 'SET LOCAL ROLE meri_phase4_broker_effect_operator',
      parameters: [] });
    expect(db.calls[1]).toEqual({ sql: 'SELECT current_user, session_user', parameters: [] });
    const routineCall = db.calls[2]!;
    expect(routineCall.sql).toContain('public.meri_phase4_record_turn_effect(');
    expect(routineCall.parameters).toEqual([
      tenantId, runId, 'hermes-run-1', 'a'.repeat(64), scopeId,
      '44444444-4444-4444-8444-444444444444', identity.requestSha256,
      3, 5, 'attempt',
    ]);
    expect(routineCall.parameters).not.toContain(key.keyId);
    expect(routineCall.parameters).not.toContain(db.rows[0]!.signature);
  });

  it('returns a verified denial and preserves exact replay evidence', async () => {
    const db = new FakeDatabase();
    db.rows = [row({ result: 'denied_before_effect', detail: 'tool_denied',
      brokerCallsBefore: 4, brokerCallsAfter: 4, eventSeq: null })];
    const repository = new MeriHermesBrokerEffectRepositoryV1(db);
    const first = await repository.apply(input());
    const second = await repository.apply(input());
    expect(first).toEqual(second);
    expect(first).toMatchObject({ kind: 'denied_before_effect',
      receipt: { receiptId: '55555555-5555-4555-8555-555555555555', signed: true },
      result: { detail: 'tool_denied' } });
  });

  it('keeps signed and unsigned uncertainty unresolved', async () => {
    const facts: MeriHermesBrokerEffectReceiptFactsV1 = {
      result: 'effect_unknown', detail: 'caller_reported_unknown',
      brokerCallsBefore: 4, brokerCallsAfter: 4, eventSeq: null,
    };
    for (const signed of [true, false]) {
      const db = new FakeDatabase();
      db.rows = [row(facts, signed)];
      const result = await new MeriHermesBrokerEffectRepositoryV1(db).apply(input());
      expect(result).toMatchObject({ kind: 'effect_unknown' });
      if (signed) expect(result.receipt).toBeNull();
      else expect(result.receipt).toMatchObject({ signed: false });
    }
  });

  it.each(['empty', 'multiple', 'malformed', 'database failure'])('%s becomes effect_unknown', async (mode) => {
    const db = new FakeDatabase();
    const valid = row({ result: 'committed', detail: 'recorded',
      brokerCallsBefore: 4, brokerCallsAfter: 5, eventSeq: 12 });
    if (mode === 'empty') db.rows = [];
    if (mode === 'multiple') db.rows = [valid, valid];
    if (mode === 'malformed') db.rows = [{ ...valid, receipt_sha256: 'c'.repeat(64) }];
    if (mode === 'database failure') db.fail = new Error('uncertain commit');
    await expect(new MeriHermesBrokerEffectRepositoryV1(db).apply(input()))
      .resolves.toEqual({ kind: 'effect_unknown', receipt: null });
  });

  it('copies registry bytes before the database boundary', async () => {
    const db = new FakeDatabase();
    db.rows = [row({ result: 'committed', detail: 'recorded',
      brokerCallsBefore: 4, brokerCallsAfter: 5, eventSeq: 12 })];
    const mutable = Uint8Array.from(key.publicKeySpkiDer);
    const mutableKey = { ...key, publicKeySpkiDer: mutable };
    db.boundary = () => mutable.fill(0);
    await expect(new MeriHermesBrokerEffectRepositoryV1(db).apply(
      input(new Map([[key.keyId, mutableKey]])),
    )).resolves.toMatchObject({ kind: 'committed' });
  });

  it('rejects request drift before opening a transaction', async () => {
    const db = new FakeDatabase();
    await expect(new MeriHermesBrokerEffectRepositoryV1(db).apply({
      ...input(), request: { ...request, userChars: 4 },
    })).rejects.toBeInstanceOf(MeriHermesBrokerEffectInputError);
    expect(db.calls).toEqual([]);
  });

  it('rejects use of the operator as the session principal', async () => {
    const db = new FakeDatabase();
    db.principals = [{ current_user: 'meri_phase4_broker_effect_operator',
      session_user: 'meri_phase4_broker_effect_operator' }];
    await expect(new MeriHermesBrokerEffectRepositoryV1(db).apply(input()))
      .rejects.toBeInstanceOf(MeriHermesBrokerEffectAuthorityError);
  });

  it('contains no direct writes, process time, randomness, signer or secret material', () => {
    const source = readFileSync(__filename.replace(/\.spec\.ts$/, '.ts'), 'utf8');
    expect(source).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
    expect(source).not.toMatch(/Date\.now|randomUUID|createHmac|privateKey|bearer|rawBody/i);
    expect(source.match(/public\.meri_phase4_record_turn_effect/g)).toHaveLength(1);
    expect(source.match(/public\.meri_phase4_request_clarification_effect/g)).toHaveLength(1);
  });
});

describe('Phase 4 clarification broker-effect repository', () => {
  const operationId = '77777777-7777-4777-8777-777777777777';
  const clarificationRequest = {
    question: '  Which client?  ', choices: [' Acme ', '', 'Beta'], multiSelect: true,
  } as const;
  const clarificationIdentity = createMeriHermesClarificationEffectIdentityV1({
    tenantId, runId, workerRunId: 'hermes-run-1',
    dispatchRequestSha256: 'a'.repeat(64), scopeId, operationId,
    request: clarificationRequest,
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
    const keyId = signed ? key.keyId : null;
    const qualification = signed ? key.qualificationSha256 : null;
    return {
      receipt_id: '88888888-8888-4888-8888-888888888888',
      result: facts.result, detail: facts.detail,
      broker_calls_before: facts.brokerCallsBefore,
      broker_calls_after: facts.brokerCallsAfter, event_seq: facts.eventSeq,
      applied_at: new Date('2026-09-26T12:00:00Z'),
      applied_at_epoch_micros: '5000000',
      retain_until_epoch_micros: '7776005000000',
      signed_claims_sha256: claims, signer_key_id: keyId, signature,
      signature_verified_at_epoch_micros: signed ? '4000000' : null,
      qualification_sha256: qualification,
      receipt_sha256: meriHermesBrokerEffectReceiptSha256V1(
        claims, keyId, signature, qualification,
      ),
    };
  }

  function clarificationInput() {
    return {
      identity: clarificationIdentity,
      request: clarificationRequest,
      effectDisposition: 'attempt' as const,
      verificationKeys: new Map([[key.keyId, key]]),
    };
  }

  it('normalizes request facts and calls only the fixed clarification routine', async () => {
    const db = new FakeDatabase();
    db.rows = [clarificationRow({
      result: 'committed', detail: 'clarification_requested',
      brokerCallsBefore: 4, brokerCallsAfter: 5, eventSeq: 12,
    })];
    const result = await new MeriHermesBrokerEffectRepositoryV1(db)
      .applyClarification(clarificationInput());
    expect(result).toMatchObject({
      kind: 'committed', result: { requestId: `clar_${operationId}` },
    });
    expect(db.calls[2]!.sql).toContain(
      'public.meri_phase4_request_clarification_effect(',
    );
    expect(db.calls[2]!.parameters).toEqual([
      tenantId, runId, 'hermes-run-1', 'a'.repeat(64), scopeId, operationId,
      clarificationIdentity.requestSha256, 'Which client?',
      JSON.stringify(['Acme', 'Beta']), true, 'attempt',
    ]);
    expect(db.calls[2]!.parameters).not.toContain(key.keyId);
  });

  it('maps malformed, multiple, and failed outcomes to unknown', async () => {
    const valid = clarificationRow({
      result: 'committed', detail: 'clarification_requested',
      brokerCallsBefore: 4, brokerCallsAfter: 5, eventSeq: 12,
    });
    for (const rows of [[], [valid, valid], [{ ...valid, event_seq: 13 }]]) {
      const db = new FakeDatabase();
      db.rows = rows;
      await expect(new MeriHermesBrokerEffectRepositoryV1(db)
        .applyClarification(clarificationInput()))
        .resolves.toEqual({ kind: 'effect_unknown', receipt: null });
    }
    const failed = new FakeDatabase();
    failed.fail = new Error('uncertain commit');
    await expect(new MeriHermesBrokerEffectRepositoryV1(failed)
      .applyClarification(clarificationInput()))
      .resolves.toEqual({ kind: 'effect_unknown', receipt: null });
  });

  it('rejects request/identity drift before opening the database boundary', async () => {
    const db = new FakeDatabase();
    await expect(new MeriHermesBrokerEffectRepositoryV1(db).applyClarification({
      ...clarificationInput(), request: { ...clarificationRequest, question: 'Different' },
    })).rejects.toBeInstanceOf(MeriHermesBrokerEffectInputError);
    expect(db.calls).toEqual([]);
  });
});

describe('Phase 4 memory proposal broker-effect repository', () => {
  const memoryProposalOperationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const memoryProposalRequest = normalizeMeriHermesMemoryProposalRequestV1({
    key: 'user_preferred_name',
    value: 'Alice',
    scope: 'client',
    clientId: 'aaaa1111-bb22-cc33-dd44-555566667777',
    confidence: 0.85,
    sourceExcerpt: 'The user prefers to be called Alice',
  });
  const memoryProposalIdentity = createMeriHermesMemoryProposalEffectIdentityV1({
    tenantId, runId, workerRunId: 'hermes-run-1',
    dispatchRequestSha256: 'a'.repeat(64), scopeId, operationId: memoryProposalOperationId,
    request: memoryProposalRequest,
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
    const keyId = signed ? key.keyId : null;
    const qualification = signed ? key.qualificationSha256 : null;
    return {
      receipt_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      result: facts.result, detail: facts.detail,
      broker_calls_before: facts.brokerCallsBefore,
      broker_calls_after: facts.brokerCallsAfter, event_seq: facts.eventSeq,
      applied_at: new Date('2026-09-26T12:00:00Z'),
      applied_at_epoch_micros: '5000000', retain_until_epoch_micros: '7776005000000',
      signed_claims_sha256: claims, signer_key_id: keyId, signature,
      signature_verified_at_epoch_micros: signed ? '4000000' : null,
      qualification_sha256: qualification,
      receipt_sha256: meriHermesBrokerEffectReceiptSha256V1(
        claims, keyId, signature, qualification,
      ),
    };
  }

  function memoryProposalInput(registry = new Map([[key.keyId, key]])) {
    return {
      identity: memoryProposalIdentity,
      request: memoryProposalRequest,
      effectDisposition: 'attempt' as const,
      verificationKeys: registry,
    };
  }

  it('sets the dedicated role and calls only the fixed routine with request facts', async () => {
    const db = new FakeDatabase();
    db.rows = [memoryProposalRow({ result: 'committed', detail: 'memory_proposed',
      brokerCallsBefore: 7, brokerCallsAfter: 8, eventSeq: 14 })];
    const result = await new MeriHermesBrokerEffectRepositoryV1(db).applyMemoryProposal(memoryProposalInput());
    expect(result.kind).toBe('committed');
    expect(db.calls[0]).toEqual({ sql: 'SET LOCAL ROLE meri_phase4_broker_effect_operator',
      parameters: [] });
    expect(db.calls[1]).toEqual({ sql: 'SELECT current_user, session_user', parameters: [] });
    const routineCall = db.calls[2]!;
    expect(routineCall.sql).toContain('public.meri_phase4_propose_memory_effect(');
    expect(routineCall.parameters).toEqual([
      tenantId, runId, 'hermes-run-1', 'a'.repeat(64), scopeId,
      memoryProposalOperationId, memoryProposalIdentity.requestSha256,
      'user_preferred_name', 'Alice', 'client',
      'aaaa1111-bb22-cc33-dd44-555566667777', 0.85,
      'The user prefers to be called Alice', 'attempt',
    ]);
    expect(routineCall.parameters).not.toContain(key.keyId);
    expect(routineCall.parameters).not.toContain(db.rows[0]!.signature);
  });

  it('returns a verified denial and preserves exact replay evidence', async () => {
    const db = new FakeDatabase();
    db.rows = [memoryProposalRow({ result: 'denied_before_effect', detail: 'tool_denied',
      brokerCallsBefore: 7, brokerCallsAfter: 7, eventSeq: null })];
    const repository = new MeriHermesBrokerEffectRepositoryV1(db);
    const first = await repository.applyMemoryProposal(memoryProposalInput());
    const second = await repository.applyMemoryProposal(memoryProposalInput());
    expect(first).toEqual(second);
    expect(first).toMatchObject({ kind: 'denied_before_effect',
      receipt: { receiptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', signed: true },
      result: { detail: 'tool_denied' } });
  });

  it('keeps signed and unsigned uncertainty unresolved', async () => {
    const facts: MeriHermesMemoryProposalEffectReceiptFactsV1 = {
      result: 'effect_unknown', detail: 'caller_reported_unknown',
      brokerCallsBefore: 7, brokerCallsAfter: 7, eventSeq: null,
    };
    for (const signed of [true, false]) {
      const db = new FakeDatabase();
      db.rows = [memoryProposalRow(facts, signed)];
      const result = await new MeriHermesBrokerEffectRepositoryV1(db).applyMemoryProposal(memoryProposalInput());
      expect(result).toMatchObject({ kind: 'effect_unknown' });
      if (signed) expect(result.receipt).toBeNull();
      else expect(result.receipt).toMatchObject({ signed: false });
    }
  });

  it.each(['empty', 'multiple', 'malformed', 'database failure'])('%s becomes effect_unknown', async (mode) => {
    const db = new FakeDatabase();
    const valid = memoryProposalRow({ result: 'committed', detail: 'memory_proposed',
      brokerCallsBefore: 7, brokerCallsAfter: 8, eventSeq: 14 });
    if (mode === 'empty') db.rows = [];
    if (mode === 'multiple') db.rows = [valid, valid];
    if (mode === 'malformed') db.rows = [{ ...valid, receipt_sha256: 'c'.repeat(64) }];
    if (mode === 'database failure') db.fail = new Error('uncertain commit');
    await expect(new MeriHermesBrokerEffectRepositoryV1(db).applyMemoryProposal(memoryProposalInput()))
      .resolves.toEqual({ kind: 'effect_unknown', receipt: null });
  });

  it('copies registry bytes before the database boundary', async () => {
    const db = new FakeDatabase();
    db.rows = [memoryProposalRow({ result: 'committed', detail: 'memory_proposed',
      brokerCallsBefore: 7, brokerCallsAfter: 8, eventSeq: 14 })];
    const mutable = Uint8Array.from(key.publicKeySpkiDer);
    const mutableKey = { ...key, publicKeySpkiDer: mutable };
    db.boundary = () => mutable.fill(0);
    await expect(new MeriHermesBrokerEffectRepositoryV1(db).applyMemoryProposal(
      memoryProposalInput(new Map([[key.keyId, mutableKey]])),
    )).resolves.toMatchObject({ kind: 'committed' });
  });

  it('rejects request drift before opening a transaction', async () => {
    const db = new FakeDatabase();
    await expect(new MeriHermesBrokerEffectRepositoryV1(db).applyMemoryProposal({
      ...memoryProposalInput(), request: { ...memoryProposalRequest, key: 'different' },
    })).rejects.toBeInstanceOf(MeriHermesBrokerEffectInputError);
    expect(db.calls).toEqual([]);
  });

  it('rejects use of the operator as the session principal', async () => {
    const db = new FakeDatabase();
    db.principals = [{ current_user: 'meri_phase4_broker_effect_operator',
      session_user: 'meri_phase4_broker_effect_operator' }];
    await expect(new MeriHermesBrokerEffectRepositoryV1(db).applyMemoryProposal(memoryProposalInput()))
      .rejects.toBeInstanceOf(MeriHermesBrokerEffectAuthorityError);
  });

  it('contains no direct writes, process time, randomness, signer or secret material', () => {
    const source = readFileSync(__filename.replace(/\.spec\.ts$/, '.ts'), 'utf8');
    expect(source).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
    expect(source).not.toMatch(/Date\.now|randomUUID|createHmac|privateKey|bearer|rawBody/i);
    expect(source.match(/public\.meri_phase4_propose_memory_effect/g)).toHaveLength(1);
  });
});
