import { createHash, createHmac } from 'node:crypto';
import {
  createMeriDispatchRequestIdentityV2,
  type MeriDispatchRequestMaterialV2,
} from './meri-hermes-dispatch-intent.contract.js';
import {
  MERI_HERMES_RECOVERY_COMMAND_PURPOSE,
  MERI_HERMES_RECOVERY_RECEIPT_PURPOSE,
  type MeriHermesRecoveryCommandKeyV1,
  type MeriHermesRecoveryReceiptKeyV1,
} from './meri-hermes-dispatch-recovery.contract.js';
import type {
  MeriHermesRecoveryPersistenceDatabaseV1,
  MeriHermesRecoveryPersistenceTransactionV1,
} from './meri-hermes-dispatch-recovery.repository.js';
import {
  mintMeriHermesReservationCommandV1,
  verifyMeriHermesReservationCommandV1,
  verifyMeriHermesReservationReceiptV1,
} from './meri-hermes-reservation-recovery.contract.js';
import {
  MeriHermesReservationRecoveryPersistenceConflictError,
  MeriHermesReservationRecoveryRepositoryV1,
} from './meri-hermes-reservation-recovery.repository.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const MESSAGE = '44444444-4444-4444-8444-444444444444';
const RUN = '55555555-5555-4555-8555-555555555555';
const OPERATION = '77777777-7777-4777-8777-777777777777';
const SCOPE = `tenant:${TENANT}:user:${ACTOR}`;
const DELIVERY = '1790366290000000';
const ISSUED = '1790366300000000';
const OBSERVED = '1790366310000000';
const DB_NOW = '1790366320000000';
const EXPIRES = '1790366350000000';
const WORKER_RUN = 'worker-run-late-1';

const MATERIAL: MeriDispatchRequestMaterialV2 = {
  metadata: {
    version: 2, tenantId: TENANT, actorType: 'user', actorId: ACTOR,
    meriAudience: 'private', clientId: null, workspaceId: null, scopeId: SCOPE,
    conversationId: CONVERSATION, userMessageId: MESSAGE, runId: RUN,
    idempotencyKey: 'phase4-reservation-repository', conversationEpoch: 3,
    workerAudience: 'meri-hermes-scope-worker', workerIngressId: 'private-ingress-a',
    workerGeneration: 'worker-image-sha256:2026',
    workerCredentialId: 'worker-credential-2026-09',
    authorizationVersion: 'authorization-v8', authorizationPolicyVersion: 'policy-v8',
    grantVersion: 'grant-v4', catalogDigest: 'a'.repeat(64), toolViewDigest: 'b'.repeat(64),
    sessionHeaderKeyId: 'dispatch-hmac-2026-09',
    claimNotAfterEpochMicros: '1790366250000000',
    deliveryNotAfterEpochMicros: DELIVERY,
    workerCredentialNotAfterEpochMicros: DELIVERY,
    reconciliationNotAfterEpochMicros: '1790456460000000',
    retainUntilEpochMicros: '1790546460000000',
  },
  sourceMessage: { body: 'recover exact repository turn', metadata: { runtime: 'hermes' } },
  bodyBytes: Buffer.from('{"input":"recover"}'),
  sessionKeyHeaderValue: `${SCOPE}:conversation:${CONVERSATION}:e3`,
  sessionHeaderHmacKey: Buffer.alloc(32, 7),
};
const IDENTITY = createMeriDispatchRequestIdentityV2(MATERIAL);
const BINDING = {
  tenantId: TENANT, workerAudience: IDENTITY.workerAudience,
  workerIngressId: IDENTITY.workerIngressId,
  workerGeneration: IDENTITY.workerGeneration,
  workerCredentialId: IDENTITY.workerCredentialId,
};
const COMMAND_KEY: MeriHermesRecoveryCommandKeyV1 = {
  purpose: MERI_HERMES_RECOVERY_COMMAND_PURPOSE,
  keyId: 'reservation-command-key-a', ...BINDING,
  secret: Buffer.alloc(32, 41),
  notBeforeEpochMicros: '1790366200000000', notAfterEpochMicros: '1790366500000000',
};
const RECEIPT_KEY: MeriHermesRecoveryReceiptKeyV1 = {
  purpose: MERI_HERMES_RECOVERY_RECEIPT_PURPOSE,
  keyId: 'reservation-receipt-key-a', ...BINDING,
  secret: Buffer.alloc(32, 42),
  notBeforeEpochMicros: '1790366200000000', notAfterEpochMicros: '1790366500000000',
};

function sha256(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex');
}

function commitInput(outcome: 'reserved' | 'sealed_absent') {
  const commandToken = mintMeriHermesReservationCommandV1({
    identity: IDENTITY,
    idempotencyKey: IDENTITY.idempotencyKey,
    deliveryNotBeforeEpochMicros: DELIVERY,
    operationId: OPERATION,
    attemptNonce: Buffer.alloc(16, 33).toString('base64url'),
    notBeforeEpochMicros: ISSUED,
    notAfterEpochMicros: EXPIRES,
  }, COMMAND_KEY);
  const command = verifyMeriHermesReservationCommandV1(
    commandToken, IDENTITY, COMMAND_KEY, DB_NOW,
  )!;
  const body = outcome === 'reserved'
    ? Buffer.from(`{"outcome":"reserved","workerRunId":"${WORKER_RUN}","workerStatus":"running"}`)
    : Buffer.from(
      `{"outcome":"sealed_absent","sealedAtEpochMicros":"1790366305000000",` +
      `"retainUntilEpochMicros":"${IDENTITY.retainUntilEpochMicros}"}`,
    );
  const claims = {
    version: 1, purpose: 'meri-hermes-reservation-receipt', keyId: RECEIPT_KEY.keyId,
    tenantId: command.tenantId, runId: command.runId,
    requestSha256: command.requestSha256, workerAudience: command.workerAudience,
    workerIngressId: command.workerIngressId, workerGeneration: command.workerGeneration,
    workerCredentialId: command.workerCredentialId,
    idempotencyKey: command.idempotencyKey,
    deliveryNotBeforeEpochMicros: command.deliveryNotBeforeEpochMicros,
    retainUntilEpochMicros: command.retainUntilEpochMicros,
    operationId: command.operationId, attemptNonce: command.attemptNonce,
    commandSha256: sha256(commandToken), nativeMethod: command.nativeMethod,
    nativePath: command.nativePath, nativeBodySha256: command.nativeBodySha256,
    nativeHttpStatus: 200, nativeResponseBodySha256: sha256(body), outcome,
    workerRunId: outcome === 'reserved' ? WORKER_RUN : null,
    workerStatus: outcome === 'reserved' ? 'running' : null,
    sealedAtEpochMicros: outcome === 'sealed_absent' ? '1790366305000000' : null,
    observedAtEpochMicros: OBSERVED,
    notBeforeEpochMicros: command.notBeforeEpochMicros,
    notAfterEpochMicros: command.notAfterEpochMicros,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', RECEIPT_KEY.secret)
    .update('capiro.meri.phase4.reservation-receipt/v1\0', 'utf8')
    .update(`mhrqr1.${payload}`, 'ascii').digest('base64url');
  const receiptToken = `mhrqr1.${payload}.${signature}`;
  const receipt = verifyMeriHermesReservationReceiptV1(
    receiptToken, commandToken, IDENTITY, COMMAND_KEY, RECEIPT_KEY, DB_NOW,
  )!;
  return {
    identity: IDENTITY,
    idempotencyKey: IDENTITY.idempotencyKey,
    deliveryNotBeforeEpochMicros: DELIVERY,
    commandToken,
    commandKey: COMMAND_KEY,
    receiptToken,
    receiptKey: RECEIPT_KEY,
    verifiedCommand: command,
    verifiedReceipt: receipt,
  };
}

function intentRow(state: 'prepared' | 'claimed' | 'sealed_absent' = 'prepared') {
  return {
    run_id: RUN, tenant_id: TENANT, identity_version: 2, actor_type: 'user',
    actor_id: ACTOR, meri_audience: 'private', client_id: null, workspace_id: null,
    scope_id: SCOPE, conversation_id: CONVERSATION, user_message_id: MESSAGE,
    idempotency_key: IDENTITY.idempotencyKey, conversation_epoch: 3n,
    worker_audience: IDENTITY.workerAudience, worker_ingress_id: IDENTITY.workerIngressId,
    worker_generation: IDENTITY.workerGeneration,
    worker_credential_id: IDENTITY.workerCredentialId,
    authorization_version: IDENTITY.authorizationVersion,
    authorization_policy_version: IDENTITY.authorizationPolicyVersion,
    grant_version: IDENTITY.grantVersion, catalog_digest: IDENTITY.catalogDigest,
    tool_view_digest: IDENTITY.toolViewDigest,
    session_header_key_id: IDENTITY.sessionHeaderKeyId,
    claim_not_after_epoch_micros: BigInt(IDENTITY.claimNotAfterEpochMicros),
    delivery_not_after_epoch_micros: BigInt(DELIVERY),
    worker_credential_not_after_epoch_micros: BigInt(DELIVERY),
    reconciliation_not_after_epoch_micros: BigInt(IDENTITY.reconciliationNotAfterEpochMicros),
    retain_until_epoch_micros: BigInt(IDENTITY.retainUntilEpochMicros),
    source_message_sha256: IDENTITY.sourceMessageSha256,
    body_length_bytes: BigInt(IDENTITY.bodyLengthBytes), body_sha256: IDENTITY.bodySha256,
    request_assembly_sha256: IDENTITY.requestAssemblySha256,
    session_header_hmac_sha256: IDENTITY.sessionHeaderHmacSha256,
    request_sha256: IDENTITY.requestSha256, state,
    worker_run_id: state === 'claimed' ? WORKER_RUN : null,
    absence_proof_sha256: state === 'sealed_absent' ? 'f'.repeat(64) : null,
  };
}

function sourceRow(workerRunId: string | null = null) {
  return {
    run_id: RUN, tenant_id: TENANT, scope_id: SCOPE, actor_id: ACTOR,
    conversation_id: CONVERSATION, user_message_id: MESSAGE,
    idempotency_key: IDENTITY.idempotencyKey, run_status: 'provisioning',
    dispatch_status: 'pending', existing_worker_run_id: workerRunId,
    stop_requested_at: null,
    envelope_authorization_version: IDENTITY.authorizationVersion,
    scope_principal_type: 'user', scope_principal_id: ACTOR, scope_kind: 'private',
    scope_authorization_version: IDENTITY.authorizationVersion,
    conversation_user_id: ACTOR, conversation_client_id: null,
    conversation_workspace_id: null, conversation_epoch_text: '3',
    message_tenant_id: TENANT, message_user_id: ACTOR, message_client_id: null,
    message_conversation_id: CONVERSATION, message_role: 'user',
    message_body: MATERIAL.sourceMessage.body,
    message_metadata_jsonb: MATERIAL.sourceMessage.metadata,
  };
}

type AnyRow = Record<string, unknown>;

class FakeDatabase implements MeriHermesRecoveryPersistenceDatabaseV1 {
  state: 'prepared' | 'claimed' | 'sealed_absent' = 'prepared';
  sourceWorkerRunId: string | null = null;
  operations = new Map<string, AnyRow>();
  receipts: AnyRow[] = [];
  calls: string[] = [];

  async withRecoveryAuthorityTransaction<T>(
    run: (tx: MeriHermesRecoveryPersistenceTransactionV1) => Promise<T>,
  ): Promise<T> {
    const tx: MeriHermesRecoveryPersistenceTransactionV1 = {
      execute: async (sql) => { this.calls.push(sql); },
      query: async <R extends object>(sql: string, parameters: readonly unknown[]) => {
        this.calls.push(sql);
        let rows: readonly AnyRow[];
        if (sql.includes('current_user::text AS current_user')) {
          rows = [{ current_user: 'meri_phase4_authority_owner', session_user: 'reservation-writer' }];
        } else if (sql.includes('meri_phase4_lock_authority_fence')) {
          rows = [{ revision: 7n }];
        } else if (sql.includes('meri_phase4_lock_reservation_recovery_source')) {
          rows = [sourceRow(this.sourceWorkerRunId)];
        } else if (sql.includes('FROM public.meri_agent_dispatch_intents')) {
          rows = [intentRow(this.state)];
        } else if (sql.includes('AS db_now_epoch_micros')) {
          rows = [{ db_now_epoch_micros: BigInt(DB_NOW) }];
        } else if (sql.includes('INSERT INTO public.meri_phase4_reservation_recovery_operations')) {
          const row = {
            tenant_id: String(parameters[0]), operation_id: String(parameters[1]),
            run_id: String(parameters[2]), request_sha256: String(parameters[3]),
            idempotency_key: String(parameters[4]), worker_audience: String(parameters[5]),
            worker_ingress_id: String(parameters[6]), worker_generation: String(parameters[7]),
            worker_credential_id: String(parameters[8]),
            delivery_not_before_epoch_micros: parameters[9],
            retain_until_epoch_micros: parameters[10], outcome: String(parameters[11]),
            worker_run_id: parameters[12] === null ? null : String(parameters[12]),
            sealed_at_epoch_micros: parameters[13],
          };
          const key = `${row.tenant_id}:${row.operation_id}`;
          if (this.operations.has(key)) rows = [];
          else { this.operations.set(key, row); rows = [row]; }
        } else if (sql.includes('UPDATE public.meri_agent_runs')) {
          if (this.sourceWorkerRunId !== null) rows = [];
          else {
            this.sourceWorkerRunId = String(parameters[2]);
            rows = [{ id: RUN }];
          }
        } else if (sql.includes('UPDATE public.meri_agent_dispatch_intents')) {
          if (this.state !== 'prepared') rows = [];
          else {
            this.state = sql.includes("state = 'claimed'") ? 'claimed' : 'sealed_absent';
            rows = [{ run_id: RUN }];
          }
        } else if (sql.includes('FROM public.meri_phase4_reservation_recovery_operations')) {
          const found = this.operations.get(`${String(parameters[0])}:${String(parameters[1])}`);
          rows = found ? [found] : [];
        } else if (sql.includes('INSERT INTO public.meri_phase4_reservation_recovery_receipts')) {
          const row = {
            receipt_id: '99999999-9999-4999-8999-999999999999',
            contract_version: Number(parameters[0]), receipt_purpose: String(parameters[1]),
            tenant_id: String(parameters[2]), run_id: String(parameters[3]),
            request_sha256: String(parameters[4]), idempotency_key: String(parameters[5]),
            worker_audience: String(parameters[6]), worker_ingress_id: String(parameters[7]),
            worker_generation: String(parameters[8]), worker_credential_id: String(parameters[9]),
            delivery_not_before_epoch_micros: parameters[10],
            retain_until_epoch_micros: parameters[11], outcome: String(parameters[12]),
            worker_run_id: parameters[13] === null ? null : String(parameters[13]),
            worker_status: parameters[14] === null ? null : String(parameters[14]),
            sealed_at_epoch_micros: parameters[15], operation_id: String(parameters[16]),
            attempt_nonce: String(parameters[17]), command_key_id: String(parameters[18]),
            command_sha256: String(parameters[19]),
            native_request_body_sha256: String(parameters[20]),
            native_response_body_sha256: String(parameters[21]),
            receipt_sha256: String(parameters[22]), native_http_status: Number(parameters[23]),
            issued_at_epoch_micros: parameters[24], expires_at_epoch_micros: parameters[25],
            observed_at_epoch_micros: parameters[26], key_id: String(parameters[27]),
            signature: String(parameters[28]),
          };
          const conflict = this.receipts.some((prior) =>
            prior.receipt_sha256 === row.receipt_sha256 ||
            prior.attempt_nonce === row.attempt_nonce ||
            (prior.key_id === row.key_id && prior.signature === row.signature));
          if (conflict) rows = [];
          else { this.receipts.push(row); rows = [row]; }
        } else if (sql.includes('FROM public.meri_phase4_reservation_recovery_receipts')) {
          rows = this.receipts.filter((row) =>
            row.receipt_sha256 === String(parameters[1]) ||
            row.attempt_nonce === String(parameters[2]) ||
            (row.key_id === String(parameters[3]) && row.signature === String(parameters[4])));
        } else {
          throw new Error(`unexpected SQL: ${sql}`);
        }
        return rows as readonly R[];
      },
    };
    return run(tx);
  }
}

describe('dormant Phase 4 reservation recovery atomic repository', () => {
  test('locks fence, source, and intent before DB time, then binds and persists reserved', async () => {
    const database = new FakeDatabase();
    const input = commitInput('reserved');
    await expect(new MeriHermesReservationRecoveryRepositoryV1(database)
      .commitVerified(input)).resolves.toEqual({
        kind: 'bound_worker', workerRunId: WORKER_RUN,
      });
    expect(database.state).toBe('claimed');
    expect(database.sourceWorkerRunId).toBe(WORKER_RUN);
    expect(database.receipts).toHaveLength(1);
    const fence = database.calls.findIndex((sql) => sql.includes('lock_authority_fence'));
    const source = database.calls.findIndex((sql) =>
      sql.includes('meri_phase4_lock_reservation_recovery_source'));
    const intent = database.calls.findIndex((sql) =>
      sql.includes('FROM public.meri_agent_dispatch_intents'));
    const clock = database.calls.findIndex((sql) => sql.includes('AS db_now_epoch_micros'));
    expect(fence).toBeLessThan(source);
    expect(source).toBeLessThan(intent);
    expect(intent).toBeLessThan(clock);
    expect(database.calls.join('\n')).toContain("status IN ('queued', 'provisioning', 'cancelling')");
  });

  test('seals only from a signed tombstone and persists its exact receipt digest', async () => {
    const database = new FakeDatabase();
    const input = commitInput('sealed_absent');
    await expect(new MeriHermesReservationRecoveryRepositoryV1(database)
      .commitVerified(input)).resolves.toEqual({ kind: 'sealed_absent' });
    expect(database.state).toBe('sealed_absent');
    expect(database.sourceWorkerRunId).toBeNull();
    expect(database.receipts[0]?.receipt_sha256).toBe(sha256(input.receiptToken));
  });

  test('replays its own anchored late binding but never reinterprets an ordinary claim', async () => {
    const input = commitInput('reserved');
    const repositoryDatabase = new FakeDatabase();
    const repository = new MeriHermesReservationRecoveryRepositoryV1(repositoryDatabase);
    await repository.commitVerified(input);
    await expect(repository.commitVerified(input)).resolves.toEqual({
      kind: 'bound_worker', workerRunId: WORKER_RUN,
    });
    expect(repositoryDatabase.receipts).toHaveLength(1);

    const ordinary = new FakeDatabase();
    ordinary.state = 'claimed';
    ordinary.sourceWorkerRunId = WORKER_RUN;
    await expect(new MeriHermesReservationRecoveryRepositoryV1(ordinary)
      .commitVerified(input)).rejects.toBeInstanceOf(
        MeriHermesReservationRecoveryPersistenceConflictError,
      );
    expect(ordinary.receipts).toHaveLength(0);
  });

  test('never sends raw command, receipt, source text, or key bytes to SQL', async () => {
    const database = new FakeDatabase();
    const input = commitInput('reserved');
    await new MeriHermesReservationRecoveryRepositoryV1(database).commitVerified(input);
    const serialized = JSON.stringify(
      database.receipts,
      (_key, value) => typeof value === 'bigint' ? value.toString() : value,
    );
    expect(serialized).not.toContain(input.commandToken);
    expect(serialized).not.toContain(input.receiptToken);
    expect(serialized).not.toContain(MATERIAL.sourceMessage.body);
    expect(serialized).not.toContain(Buffer.from(COMMAND_KEY.secret).toString('base64'));
  });
});
