import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createMeriDispatchRequestIdentityV2,
  type MeriDispatchRequestMaterialV2,
} from './meri-hermes-dispatch-intent.contract.js';
import {
  MERI_HERMES_RECOVERY_COMMAND_PURPOSE,
  MERI_HERMES_RECOVERY_RECEIPT_PURPOSE,
  mintMeriHermesRecoveryCommandV1,
  mintMeriHermesRecoveryReceiptV1,
  verifyMeriHermesRecoveryCommandV1,
  verifyMeriHermesRecoveryReceiptV1,
  type MeriHermesRecoveryCommandKeyV1,
  type MeriHermesRecoveryReceiptKeyV1,
} from './meri-hermes-dispatch-recovery.contract.js';
import {
  MeriHermesDispatchRecoveryRepositoryV1,
  MeriHermesRecoveryPersistenceAuthorityError,
  MeriHermesRecoveryPersistenceConflictError,
  MeriHermesRecoveryPersistenceVerificationError,
  type MeriHermesRecoveryPersistenceDatabaseV1,
  type MeriHermesRecoveryPersistenceTransactionV1,
  type PersistVerifiedMeriHermesRecoveryReceiptV1,
} from './meri-hermes-dispatch-recovery.repository.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const RUN = '55555555-5555-4555-8555-555555555555';
const OPERATION = '66666666-6666-4666-8666-666666666666';
const OTHER_OPERATION = '77777777-7777-4777-8777-777777777777';
const SCOPE = `tenant:${TENANT}:user:${ACTOR}`;
const WORKER_RUN = 'worker-run-recovery-1';
const ISSUED = '1790366300000000';
const OBSERVED = '1790366310000000';
const DB_NOW = '1790366320000000';
const EXPIRES = '1790366350000000';
const RECEIPT_KEY_ID = 'recovery-receipt-2026-09';

const MATERIAL: MeriDispatchRequestMaterialV2 = {
  metadata: {
    version: 2,
    tenantId: TENANT,
    actorType: 'user',
    actorId: ACTOR,
    meriAudience: 'private',
    clientId: null,
    workspaceId: null,
    scopeId: SCOPE,
    conversationId: CONVERSATION,
    userMessageId: '44444444-4444-4444-8444-444444444444',
    runId: RUN,
    idempotencyKey: 'phase4-recovery-repository',
    conversationEpoch: 3,
    workerAudience: 'meri-hermes-scope-worker',
    workerIngressId: 'private-ingress-a',
    workerGeneration: 'worker-image-sha256:2026',
    workerCredentialId: 'worker-credential-2026-09',
    authorizationVersion: 'authorization-v8',
    authorizationPolicyVersion: 'policy-v8',
    grantVersion: 'grant-v4',
    catalogDigest: 'a'.repeat(64),
    toolViewDigest: 'b'.repeat(64),
    sessionHeaderKeyId: 'dispatch-hmac-2026-09',
    claimNotAfterEpochMicros: '1790366400000000',
    deliveryNotAfterEpochMicros: '1790366460000000',
    workerCredentialNotAfterEpochMicros: '1790366460000000',
    reconciliationNotAfterEpochMicros: '1790456460000000',
    retainUntilEpochMicros: '1790546460000000',
  },
  sourceMessage: { body: 'recover this exact turn', metadata: { runtime: 'hermes' } },
  bodyBytes: Buffer.from('{"input":"recover"}', 'utf8'),
  sessionKeyHeaderValue: `${SCOPE}:conversation:${CONVERSATION}:e3`,
  sessionHeaderHmacKey: Buffer.alloc(32, 7),
};
const IDENTITY = createMeriDispatchRequestIdentityV2(MATERIAL);
const BINDING = {
  tenantId: TENANT,
  workerAudience: IDENTITY.workerAudience,
  workerIngressId: IDENTITY.workerIngressId,
  workerGeneration: IDENTITY.workerGeneration,
  workerCredentialId: IDENTITY.workerCredentialId,
};
const COMMAND_KEY: MeriHermesRecoveryCommandKeyV1 = {
  purpose: MERI_HERMES_RECOVERY_COMMAND_PURPOSE,
  keyId: 'phase4-recovery-command-key-2026-09',
  ...BINDING,
  secret: Buffer.alloc(32, 41),
  notBeforeEpochMicros: '1790366200000000',
  notAfterEpochMicros: '1790366500000000',
};
const RECEIPT_KEY: MeriHermesRecoveryReceiptKeyV1 = {
  purpose: MERI_HERMES_RECOVERY_RECEIPT_PURPOSE,
  keyId: RECEIPT_KEY_ID,
  ...BINDING,
  secret: Buffer.alloc(32, 42),
  notBeforeEpochMicros: '1790366200000000',
  notAfterEpochMicros: '1790366500000000',
};

interface OperationRow {
  tenant_id: string;
  operation_id: string;
  run_id: string;
  request_sha256: string;
  worker_run_id: string;
  worker_audience: string;
  worker_ingress_id: string;
  worker_generation: string;
  worker_credential_id: string;
  action: string;
}
interface ReceiptRow extends OperationRow {
  receipt_id: string;
  contract_version: number;
  receipt_purpose: string;
  attempt_nonce: string;
  command_key_id: string;
  command_sha256: string;
  native_request_body_sha256: string;
  native_response_body_sha256: string;
  receipt_sha256: string;
  observation: string;
  worker_status: string | null;
  native_http_status: number;
  issued_at_epoch_micros: bigint;
  expires_at_epoch_micros: bigint;
  observed_at_epoch_micros: bigint;
  key_id: string;
  signature: string;
}
interface DisplayReceiptRow {
  receipt_id: string;
  tenant_id: string;
  run_id: string;
  operation_id: string;
  attempt_nonce: string;
  native_response_body_sha256: string;
  worker_status: string;
  hermes_session_id: string | null;
  output_text: string | null;
  error_text: string | null;
  usage_jsonb: Record<string, number> | null;
  display_state: string;
  persisted_at: Date;
}

class FakeRecoveryDatabase implements MeriHermesRecoveryPersistenceDatabaseV1 {
  currentUser = 'meri_phase4_authority_owner';
  sessionUser = 'meri_phase4_recovery_writer';
  now = BigInt(DB_NOW);
  operations = new Map<string, OperationRow>();
  receipts: ReceiptRow[] = [];
  displayReceipts: DisplayReceiptRow[] = [];
  calls: Array<{ kind: 'execute' | 'query'; sql: string; parameters: readonly unknown[] }> = [];
  onBoundary: (() => void) | null = null;
  private nextReceipt = 1;

  async withRecoveryAuthorityTransaction<T>(
    run: (tx: MeriHermesRecoveryPersistenceTransactionV1) => Promise<T>,
  ): Promise<T> {
    this.onBoundary?.();
    const operations = new Map(
      [...this.operations].map(([key, value]) => [key, { ...value }]),
    );
    const receipts = this.receipts.map((row) => ({ ...row }));
    const displayReceipts = this.displayReceipts.map((row) => ({
      ...row,
      usage_jsonb: row.usage_jsonb === null ? null : { ...row.usage_jsonb },
    }));
    let nextReceipt = this.nextReceipt;
    const tx: MeriHermesRecoveryPersistenceTransactionV1 = {
      execute: async (sql, parameters) => {
        this.calls.push({ kind: 'execute', sql, parameters: [...parameters] });
      },
      query: async <R extends object>(sql: string, parameters: readonly unknown[]) => {
        this.calls.push({ kind: 'query', sql, parameters: [...parameters] });
        let rows: readonly object[];
        if (sql.includes('current_user::text AS current_user')) {
          rows = [{ current_user: this.currentUser, session_user: this.sessionUser }];
        } else if (sql.includes('AS db_now_epoch_micros')) {
          rows = [{ db_now_epoch_micros: this.now }];
        } else if (sql.includes('INSERT INTO public.meri_phase4_dispatch_recovery_operations')) {
          const row: OperationRow = {
            tenant_id: String(parameters[0]), operation_id: String(parameters[1]),
            run_id: String(parameters[2]), request_sha256: String(parameters[3]),
            worker_run_id: String(parameters[4]), worker_audience: String(parameters[5]),
            worker_ingress_id: String(parameters[6]), worker_generation: String(parameters[7]),
            worker_credential_id: String(parameters[8]), action: String(parameters[9]),
          };
          const key = `${row.tenant_id}:${row.operation_id}`;
          if (operations.has(key)) rows = [];
          else {
            operations.set(key, row);
            rows = [row];
          }
        } else if (sql.includes('FROM public.meri_phase4_dispatch_recovery_operations')) {
          const key = `${String(parameters[0])}:${String(parameters[1])}`;
          const row = operations.get(key);
          rows = row ? [row] : [];
        } else if (sql.includes('INSERT INTO public.meri_phase4_dispatch_recovery_receipts')) {
          const row: ReceiptRow = {
            receipt_id: `99999999-9999-4999-8999-${String(nextReceipt).padStart(12, '0')}`,
            contract_version: Number(parameters[0]), receipt_purpose: String(parameters[1]),
            tenant_id: String(parameters[2]), run_id: String(parameters[3]),
            request_sha256: String(parameters[4]), worker_run_id: String(parameters[5]),
            worker_audience: String(parameters[6]), worker_ingress_id: String(parameters[7]),
            worker_generation: String(parameters[8]), worker_credential_id: String(parameters[9]),
            action: String(parameters[10]), operation_id: String(parameters[11]),
            attempt_nonce: String(parameters[12]), command_key_id: String(parameters[13]),
            command_sha256: String(parameters[14]),
            native_request_body_sha256: String(parameters[15]),
            native_response_body_sha256: String(parameters[16]),
            receipt_sha256: String(parameters[17]), observation: String(parameters[18]),
            worker_status: parameters[19] === null ? null : String(parameters[19]),
            native_http_status: Number(parameters[20]),
            issued_at_epoch_micros: BigInt(String(parameters[21])),
            expires_at_epoch_micros: BigInt(String(parameters[22])),
            observed_at_epoch_micros: BigInt(String(parameters[23])),
            key_id: String(parameters[24]), signature: String(parameters[25]),
          };
          const conflict = receipts.some((prior) => prior.tenant_id === row.tenant_id && (
            prior.receipt_sha256 === row.receipt_sha256 ||
            prior.attempt_nonce === row.attempt_nonce ||
            (prior.key_id === row.key_id && prior.signature === row.signature)
          ));
          if (conflict) rows = [];
          else {
            nextReceipt += 1;
            receipts.push(row);
            rows = [row];
          }
        } else if (sql.includes('FROM public.meri_phase4_dispatch_recovery_receipts')) {
          rows = receipts.filter((row) => row.tenant_id === String(parameters[0]) && (
            row.receipt_sha256 === String(parameters[1]) ||
            row.attempt_nonce === String(parameters[2]) ||
            (row.key_id === String(parameters[3]) && row.signature === String(parameters[4]))
          ));
        } else if (sql.includes('INSERT INTO public.meri_phase4_recovery_display_receipts')) {
          const row: DisplayReceiptRow = {
            receipt_id: String(parameters[0]), tenant_id: String(parameters[1]),
            run_id: String(parameters[2]), operation_id: String(parameters[3]),
            attempt_nonce: String(parameters[4]),
            native_response_body_sha256: String(parameters[5]),
            worker_status: String(parameters[6]),
            hermes_session_id: parameters[7] === null ? null : String(parameters[7]),
            output_text: parameters[8] === null ? null : String(parameters[8]),
            error_text: parameters[9] === null ? null : String(parameters[9]),
            usage_jsonb: parameters[10] === null
              ? null : JSON.parse(String(parameters[10])) as Record<string, number>,
            display_state: String(parameters[11]),
            persisted_at: new Date('2026-09-26T12:00:00.000Z'),
          };
          if (displayReceipts.some((prior) => prior.receipt_id === row.receipt_id)) rows = [];
          else {
            displayReceipts.push(row);
            rows = [row];
          }
        } else if (sql.includes('FROM public.meri_phase4_recovery_display_receipts')) {
          rows = displayReceipts.filter((row) => row.receipt_id === String(parameters[0]));
        } else {
          throw new Error(`unexpected SQL: ${sql}`);
        }
        return rows as readonly R[];
      },
    };
    const result = await run(tx);
    this.operations = operations;
    this.receipts = receipts;
    this.displayReceipts = displayReceipts;
    this.nextReceipt = nextReceipt;
    return result;
  }
}

function recoveryInput(options: {
  action?: 'status' | 'stop';
  operationId?: string;
  nonceByte?: number;
  observation?: 'run_nonterminal' | 'run_terminal' | 'stop_accepted';
  workerStatus?: 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted' | 'expired' | null;
  nativeResponseBodyBytes?: Uint8Array;
} = {}): PersistVerifiedMeriHermesRecoveryReceiptV1 {
  const action = options.action ?? 'status';
  const operationId = options.operationId ?? OPERATION;
  const nonce = Buffer.alloc(16, options.nonceByte ?? 31).toString('base64url');
  const observation = options.observation ??
    (action === 'status' ? 'run_nonterminal' : 'stop_accepted');
  const workerStatus = options.workerStatus ??
    (observation === 'run_terminal' ? 'completed'
      : observation === 'run_nonterminal' ? 'running' : null);
  const nativeBodyBytes = action === 'status' ? Buffer.alloc(0) : Buffer.from('{}');
  const nativeResponseBodyBytes = Uint8Array.from(options.nativeResponseBodyBytes ??
    (action === 'status'
      ? Buffer.from(JSON.stringify({ run_id: WORKER_RUN, status: workerStatus }))
      : Buffer.from('{"accepted":true}')));
  const commandToken = mintMeriHermesRecoveryCommandV1({
    identity: IDENTITY,
    workerRunId: WORKER_RUN,
    action,
    operationId,
    attemptNonce: nonce,
    nativeBodyBytes,
    notBeforeEpochMicros: ISSUED,
    notAfterEpochMicros: EXPIRES,
  }, COMMAND_KEY);
  const verifiedCommand = verifyMeriHermesRecoveryCommandV1(
    commandToken, IDENTITY, WORKER_RUN, COMMAND_KEY, DB_NOW,
  )!;
  const receiptToken = mintMeriHermesRecoveryReceiptV1({
    commandToken,
    command: verifiedCommand,
    observation,
    workerStatus,
    nativeHttpStatus: action === 'status' ? 200 : 202,
    nativeResponseBodyBytes,
    observedAtEpochMicros: OBSERVED,
  }, RECEIPT_KEY);
  const verifiedReceipt = verifyMeriHermesRecoveryReceiptV1(
    receiptToken, commandToken, IDENTITY, WORKER_RUN,
    COMMAND_KEY, RECEIPT_KEY, DB_NOW,
  )!;
  return {
    identity: IDENTITY,
    workerRunId: WORKER_RUN,
    commandToken,
    receiptToken,
    commandKey: COMMAND_KEY,
    receiptKey: RECEIPT_KEY,
    verifiedCommand,
    verifiedReceipt,
    nativeResponseBodyBytes,
  };
}

describe('dormant Phase 4 dispatch recovery repository', () => {
  it('re-verifies with the DB clock, assumes the private owner locally, and persists only digests', async () => {
    const database = new FakeRecoveryDatabase();
    const repository = new MeriHermesDispatchRecoveryRepositoryV1(database);
    const input = recoveryInput();

    await expect(repository.persistVerified(input)).resolves.toMatchObject({
      kind: 'inserted',
      receipt: {
        tenantId: TENANT,
        runId: RUN,
        workerRunId: WORKER_RUN,
        operationId: OPERATION,
        action: 'status',
        observation: 'run_nonterminal',
        keyId: RECEIPT_KEY_ID,
        issuedAtEpochMicros: ISSUED,
        expiresAtEpochMicros: EXPIRES,
        observedAtEpochMicros: OBSERVED,
      },
    });
    expect(database.calls[0]).toEqual({
      kind: 'execute', sql: 'SET LOCAL ROLE meri_phase4_authority_owner', parameters: [],
    });
    expect(database.receipts).toHaveLength(1);
    expect(database.displayReceipts).toHaveLength(0);
    const allParameters = database.calls.flatMap((call) => call.parameters);
    expect(allParameters).not.toContain(input.commandToken);
    expect(allParameters).not.toContain(input.receiptToken);
    expect(allParameters).not.toContain(MATERIAL.sourceMessage.body);
    expect(database.receipts[0]).toMatchObject({
      command_key_id: COMMAND_KEY.keyId,
      command_sha256: input.verifiedReceipt.commandSha256,
      native_request_body_sha256: input.verifiedReceipt.nativeBodySha256,
      native_response_body_sha256: input.verifiedReceipt.nativeResponseBodySha256,
    });
    const receiptInsert = database.calls.find((call) =>
      call.sql.includes('INSERT INTO public.meri_phase4_dispatch_recovery_receipts'));
    expect(receiptInsert?.sql).toContain('command_key_id');
    expect(receiptInsert?.parameters).toHaveLength(26);
  });

  it('returns the exact prior receipt for an idempotent replay', async () => {
    const database = new FakeRecoveryDatabase();
    const repository = new MeriHermesDispatchRecoveryRepositoryV1(database);
    const input = recoveryInput();
    const first = await repository.persistVerified(input);
    const replay = await repository.persistVerified(input);
    expect(first.kind).toBe('inserted');
    expect(replay).toEqual({ kind: 'replayed', receipt: first.receipt });
    expect(database.receipts).toHaveLength(1);
  });

  it('persists and replays only a normalized terminal display receipt', async () => {
    const database = new FakeRecoveryDatabase();
    const repository = new MeriHermesDispatchRecoveryRepositoryV1(database);
    const nativeResponseBodyBytes = Buffer.from(JSON.stringify({
      object: 'run',
      run_id: WORKER_RUN,
      status: 'completed',
      session_id: 'hermes-session-1',
      output: 'Recovered output',
      error: '',
      usage: {
        input_tokens: 13,
        output_tokens: 8,
        total_tokens: 21,
        ignored_provider_counter: 99,
      },
      ignored_top_level: { raw: 'must not persist' },
    }));
    const input = recoveryInput({
      observation: 'run_terminal',
      workerStatus: 'completed',
      nativeResponseBodyBytes,
    });

    const first = await repository.persistVerified(input);
    const replay = await repository.persistVerified(input);

    expect(first.kind).toBe('inserted');
    expect(replay).toEqual({ kind: 'replayed', receipt: first.receipt });
    expect(database.receipts).toHaveLength(1);
    expect(database.displayReceipts).toHaveLength(1);
    expect(database.displayReceipts[0]).toEqual({
      receipt_id: first.receipt.receiptId,
      tenant_id: TENANT,
      run_id: RUN,
      operation_id: OPERATION,
      attempt_nonce: input.verifiedReceipt.attemptNonce,
      native_response_body_sha256: input.verifiedReceipt.nativeResponseBodySha256,
      worker_status: 'completed',
      hermes_session_id: 'hermes-session-1',
      output_text: 'Recovered output',
      error_text: '',
      usage_jsonb: { input_tokens: 13, output_tokens: 8, total_tokens: 21 },
      display_state: 'available',
      persisted_at: new Date('2026-09-26T12:00:00.000Z'),
    });
    const displayInsert = database.calls.find((call) =>
      call.sql.includes('INSERT INTO public.meri_phase4_recovery_display_receipts'));
    expect(displayInsert?.sql).toContain('receipt_id, tenant_id, run_id, operation_id');
    expect(displayInsert?.parameters).not.toContain(nativeResponseBodyBytes);
    expect(displayInsert?.parameters.join('|')).not.toContain('ignored_provider_counter');
    expect(displayInsert?.parameters.join('|')).not.toContain('ignored_top_level');
  });

  it('records unavailable terminal display state without inventing output', async () => {
    const database = new FakeRecoveryDatabase();
    const repository = new MeriHermesDispatchRecoveryRepositoryV1(database);
    const input = recoveryInput({
      observation: 'run_terminal',
      workerStatus: 'failed',
      nativeResponseBodyBytes: Buffer.from(JSON.stringify({
        run_id: WORKER_RUN,
        status: 'failed',
        error: 'worker failed',
      })),
    });

    await expect(repository.persistVerified(input)).resolves.toMatchObject({ kind: 'inserted' });
    expect(database.displayReceipts).toHaveLength(1);
    expect(database.displayReceipts[0]).toMatchObject({
      worker_status: 'failed',
      output_text: null,
      error_text: 'worker failed',
      usage_jsonb: null,
      display_state: 'unavailable',
    });
  });

  it.each([
    ['wrong run id', { run_id: 'another-run', status: 'completed', output: 'unsafe' }],
    ['unsigned status drift', { run_id: WORKER_RUN, status: 'failed', output: 'unsafe' }],
    ['non-string optional field', { run_id: WORKER_RUN, status: 'completed', session_id: 3 }],
    ['negative token count', {
      run_id: WORKER_RUN, status: 'completed', output: 'unsafe', usage: { total_tokens: -1 },
    }],
    ['unsafe token count', {
      run_id: WORKER_RUN,
      status: 'completed',
      output: 'unsafe',
      usage: { total_tokens: Number.MAX_SAFE_INTEGER + 1 },
    }],
  ])('keeps the verified receipt when the display envelope has %s', async (_label, body) => {
    const database = new FakeRecoveryDatabase();
    const repository = new MeriHermesDispatchRecoveryRepositoryV1(database);
    const input = recoveryInput({
      observation: 'run_terminal',
      workerStatus: 'completed',
      nativeResponseBodyBytes: Buffer.from(JSON.stringify(body)),
    });

    await expect(repository.persistVerified(input)).resolves.toMatchObject({ kind: 'inserted' });
    expect(database.receipts).toHaveLength(1);
    expect(database.displayReceipts).toHaveLength(1);
    expect(database.displayReceipts[0]).toMatchObject({
      worker_status: 'completed',
      hermes_session_id: null,
      output_text: null,
      error_text: null,
      usage_jsonb: null,
      display_state: 'unavailable',
    });
  });

  it('keeps the verified receipt when the display envelope exceeds its byte bound', async () => {
    const database = new FakeRecoveryDatabase();
    const repository = new MeriHermesDispatchRecoveryRepositoryV1(database);
    const input = recoveryInput({
      observation: 'run_terminal',
      workerStatus: 'completed',
      nativeResponseBodyBytes: Buffer.from(JSON.stringify({
        run_id: WORKER_RUN,
        status: 'completed',
        output: 'x'.repeat(1_048_576),
      })),
    });

    await expect(repository.persistVerified(input)).resolves.toMatchObject({ kind: 'inserted' });
    expect(database.receipts).toHaveLength(1);
    expect(database.displayReceipts).toHaveLength(1);
    expect(database.displayReceipts[0]).toMatchObject({
      output_text: null, usage_jsonb: null, display_state: 'unavailable',
    });
  });

  it('rejects response bytes that do not match the independently verified digest', async () => {
    const database = new FakeRecoveryDatabase();
    const repository = new MeriHermesDispatchRecoveryRepositoryV1(database);
    const input = recoveryInput({ observation: 'run_terminal' });
    const mismatched = {
      ...input,
      nativeResponseBodyBytes: Buffer.from('{"run_id":"tampered","status":"completed"}'),
    };

    await expect(repository.persistVerified(mismatched))
      .rejects.toBeInstanceOf(MeriHermesRecoveryPersistenceVerificationError);
    expect(database.receipts).toHaveLength(0);
    expect(database.displayReceipts).toHaveLength(0);
  });

  it('fails closed when a stable operation id drifts to another action', async () => {
    const database = new FakeRecoveryDatabase();
    const repository = new MeriHermesDispatchRecoveryRepositoryV1(database);
    await repository.persistVerified(recoveryInput({ action: 'status', nonceByte: 31 }));
    await expect(repository.persistVerified(recoveryInput({
      action: 'stop', nonceByte: 32,
    }))).rejects.toBeInstanceOf(MeriHermesRecoveryPersistenceConflictError);
    expect(database.receipts).toHaveLength(1);
  });

  it('rejects nonce reuse by a different logical operation', async () => {
    const database = new FakeRecoveryDatabase();
    const repository = new MeriHermesDispatchRecoveryRepositoryV1(database);
    await repository.persistVerified(recoveryInput({ operationId: OPERATION, nonceByte: 31 }));
    await expect(repository.persistVerified(recoveryInput({
      operationId: OTHER_OPERATION, nonceByte: 31,
    }))).rejects.toBeInstanceOf(MeriHermesRecoveryPersistenceConflictError);
    expect(database.receipts).toHaveLength(1);
    expect(database.operations.size).toBe(1);
  });

  it('rejects caller claims that do not exactly match the authenticated tokens', async () => {
    const database = new FakeRecoveryDatabase();
    const repository = new MeriHermesDispatchRecoveryRepositoryV1(database);
    const input = recoveryInput();
    const drifted = {
      ...input,
      verifiedReceipt: { ...input.verifiedReceipt, workerStatus: 'queued' as const },
    };
    await expect(repository.persistVerified(drifted))
      .rejects.toBeInstanceOf(MeriHermesRecoveryPersistenceVerificationError);
    expect(database.receipts).toHaveLength(0);
  });

  it('rejects capiro_app even if a connection could assume the owner', async () => {
    const database = new FakeRecoveryDatabase();
    database.sessionUser = 'capiro_app';
    const repository = new MeriHermesDispatchRecoveryRepositoryV1(database);
    await expect(repository.persistVerified(recoveryInput()))
      .rejects.toBeInstanceOf(MeriHermesRecoveryPersistenceAuthorityError);
    expect(database.receipts).toHaveLength(0);
  });

  it('uses immutable snapshots after the first async boundary', async () => {
    const database = new FakeRecoveryDatabase();
    const repository = new MeriHermesDispatchRecoveryRepositoryV1(database);
    const base = recoveryInput({
      observation: 'run_terminal',
      nativeResponseBodyBytes: Buffer.from(JSON.stringify({
        run_id: WORKER_RUN, status: 'completed', output: 'snapshot output',
      })),
    });
    const mutable = {
      ...base,
      identity: { ...base.identity },
      commandKey: { ...base.commandKey, secret: Uint8Array.from(base.commandKey.secret) },
      receiptKey: { ...base.receiptKey, secret: Uint8Array.from(base.receiptKey.secret) },
      verifiedCommand: { ...base.verifiedCommand },
      verifiedReceipt: { ...base.verifiedReceipt },
      nativeResponseBodyBytes: Uint8Array.from(base.nativeResponseBodyBytes),
    };
    database.onBoundary = () => {
      mutable.identity.tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      mutable.workerRunId = 'mutated-worker-run';
      mutable.commandToken = 'mutated-command';
      mutable.receiptToken = 'mutated-receipt';
      mutable.receiptKey.keyId = 'mutated-key';
      mutable.commandKey.secret.fill(0);
      mutable.receiptKey.secret.fill(0);
      mutable.verifiedCommand.workerRunId = 'mutated-worker-run';
      mutable.verifiedReceipt.workerRunId = 'mutated-worker-run';
      mutable.nativeResponseBodyBytes.fill(0);
    };

    await expect(repository.persistVerified(mutable)).resolves.toMatchObject({
      kind: 'inserted',
      receipt: { tenantId: TENANT, workerRunId: WORKER_RUN, keyId: RECEIPT_KEY_ID },
    });
    expect(database.displayReceipts[0]).toMatchObject({
      output_text: 'snapshot output', display_state: 'available',
    });
  });

  it('keeps raw prompt and body material out of the repository source contract', () => {
    const source = readFileSync(join(
      __dirname, 'meri-hermes-dispatch-recovery.repository.ts',
    ), 'utf8');
    expect(source).not.toContain('sourceMessage');
    expect(source).not.toContain('bodyBytes');
    expect(source).not.toContain('GRANT ');
    expect(source).not.toContain('withTenant');
  });
});
