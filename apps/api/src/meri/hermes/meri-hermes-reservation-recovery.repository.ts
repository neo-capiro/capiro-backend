import { createHash, timingSafeEqual } from 'node:crypto';
import {
  isMeriDispatchRequestIdentityV2,
  meriDispatchSourceMessageSha256V2,
  type MeriDispatchRequestIdentityV2,
} from './meri-hermes-dispatch-intent.contract.js';
import type {
  MeriHermesRecoveryPersistenceDatabaseV1,
  MeriHermesRecoveryPersistenceTransactionV1,
} from './meri-hermes-dispatch-recovery.repository.js';
import type {
  MeriHermesReservationRecoveryCommitOutcomeV1,
  MeriHermesVerifiedReservationRecoveryCommitV1,
} from './meri-hermes-reservation-recovery-boundary.js';
import {
  verifyMeriHermesReservationCommandV1,
  verifyMeriHermesReservationReceiptV1,
  type MeriHermesReservationCommandClaimsV1,
  type MeriHermesReservationReceiptClaimsV1,
} from './meri-hermes-reservation-recovery.contract.js';
import type {
  MeriHermesRecoveryCommandKeyV1,
  MeriHermesRecoveryReceiptKeyV1,
} from './meri-hermes-dispatch-recovery.contract.js';

/**
 * Dormant privileged atomic commit for signed unknown-worker recovery. No
 * module, scheduler, controller, or database adapter registers this class.
 */
const OWNER = 'meri_phase4_authority_owner';
const POSITIVE_MICROS = /^[1-9][0-9]{0,18}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_INT64 = 9_223_372_036_854_775_807n;

const COMMAND_FIELDS: ReadonlyArray<keyof MeriHermesReservationCommandClaimsV1> = [
  'version', 'purpose', 'keyId', 'tenantId', 'runId', 'requestSha256',
  'workerAudience', 'workerIngressId', 'workerGeneration', 'workerCredentialId',
  'idempotencyKey', 'deliveryNotBeforeEpochMicros',
  'reconciliationNotAfterEpochMicros', 'retainUntilEpochMicros',
  'operationId', 'attemptNonce', 'nativeMethod', 'nativePath',
  'nativeBodySha256', 'notBeforeEpochMicros', 'notAfterEpochMicros',
];
const RECEIPT_FIELDS: ReadonlyArray<keyof MeriHermesReservationReceiptClaimsV1> = [
  'version', 'purpose', 'keyId', 'tenantId', 'runId', 'requestSha256',
  'workerAudience', 'workerIngressId', 'workerGeneration', 'workerCredentialId',
  'idempotencyKey', 'deliveryNotBeforeEpochMicros', 'retainUntilEpochMicros',
  'operationId', 'attemptNonce', 'commandSha256', 'nativeMethod', 'nativePath',
  'nativeBodySha256', 'nativeHttpStatus', 'nativeResponseBodySha256', 'outcome',
  'workerRunId', 'workerStatus', 'sealedAtEpochMicros', 'observedAtEpochMicros',
  'notBeforeEpochMicros', 'notAfterEpochMicros',
];
const KEY_FIELDS = [
  'purpose', 'keyId', 'tenantId', 'workerAudience', 'workerIngressId',
  'workerGeneration', 'workerCredentialId', 'secret',
  'notBeforeEpochMicros', 'notAfterEpochMicros',
] as const;

export class MeriHermesReservationRecoveryPersistenceVerificationError extends Error {
  constructor() {
    super('reservation recovery commit requires one exact verified command/receipt pair');
    this.name = 'MeriHermesReservationRecoveryPersistenceVerificationError';
  }
}

export class MeriHermesReservationRecoveryPersistenceAuthorityError extends Error {
  constructor() {
    super('reservation recovery commit authority is unavailable');
    this.name = 'MeriHermesReservationRecoveryPersistenceAuthorityError';
  }
}

export class MeriHermesReservationRecoveryPersistenceConflictError extends Error {
  constructor() {
    super('reservation recovery commit conflicts with durable authority');
    this.name = 'MeriHermesReservationRecoveryPersistenceConflictError';
  }
}

interface AuthorityRow { current_user: string; session_user: string }
interface FenceRow { revision: bigint | string }
interface ClockRow { db_now_epoch_micros: bigint | string }

interface IntentRow {
  run_id: string;
  tenant_id: string;
  identity_version: number;
  actor_type: string;
  actor_id: string;
  meri_audience: string;
  client_id: string | null;
  workspace_id: string | null;
  scope_id: string;
  conversation_id: string;
  user_message_id: string;
  idempotency_key: string;
  conversation_epoch: bigint | string;
  worker_audience: string;
  worker_ingress_id: string;
  worker_generation: string;
  worker_credential_id: string;
  authorization_version: string;
  authorization_policy_version: string;
  grant_version: string;
  catalog_digest: string;
  tool_view_digest: string;
  session_header_key_id: string;
  claim_not_after_epoch_micros: bigint | string;
  delivery_not_after_epoch_micros: bigint | string;
  worker_credential_not_after_epoch_micros: bigint | string;
  reconciliation_not_after_epoch_micros: bigint | string;
  retain_until_epoch_micros: bigint | string;
  source_message_sha256: string;
  body_length_bytes: bigint | string;
  body_sha256: string;
  request_assembly_sha256: string;
  session_header_hmac_sha256: string;
  request_sha256: string;
  state: string;
  worker_run_id: string | null;
  absence_proof_sha256: string | null;
}

interface SourceRow {
  run_id: string;
  tenant_id: string;
  scope_id: string;
  actor_id: string;
  conversation_id: string;
  user_message_id: string | null;
  idempotency_key: string;
  run_status: string;
  dispatch_status: string;
  existing_worker_run_id: string | null;
  stop_requested_at: unknown | null;
  envelope_authorization_version: string | null;
  scope_principal_type: string;
  scope_principal_id: string;
  scope_kind: string;
  scope_authorization_version: string;
  conversation_user_id: string;
  conversation_client_id: string | null;
  conversation_workspace_id: string | null;
  conversation_epoch_text: string | null;
  message_tenant_id: string;
  message_user_id: string;
  message_client_id: string | null;
  message_conversation_id: string;
  message_role: string;
  message_body: string;
  message_metadata_jsonb: unknown;
}

interface OperationRow {
  tenant_id: string;
  operation_id: string;
  run_id: string;
  request_sha256: string;
  idempotency_key: string;
  worker_audience: string;
  worker_ingress_id: string;
  worker_generation: string;
  worker_credential_id: string;
  delivery_not_before_epoch_micros: bigint | string;
  retain_until_epoch_micros: bigint | string;
  outcome: string;
  worker_run_id: string | null;
  sealed_at_epoch_micros: bigint | string | null;
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
  worker_status: string | null;
  native_http_status: number;
  issued_at_epoch_micros: bigint | string;
  expires_at_epoch_micros: bigint | string;
  observed_at_epoch_micros: bigint | string;
  key_id: string;
  signature: string;
}

interface FrozenInput {
  readonly identity: Readonly<MeriDispatchRequestIdentityV2>;
  readonly idempotencyKey: string;
  readonly deliveryNotBeforeEpochMicros: string;
  readonly commandToken: string;
  readonly commandKey: MeriHermesRecoveryCommandKeyV1;
  readonly receiptToken: string;
  readonly receiptKey: MeriHermesRecoveryReceiptKeyV1;
  readonly verifiedCommand: Readonly<MeriHermesReservationCommandClaimsV1>;
  readonly verifiedReceipt: Readonly<MeriHermesReservationReceiptClaimsV1>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function exactKeys(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
}

function snapshotClaims<T extends object>(
  value: unknown,
  fields: ReadonlyArray<keyof T>,
): Readonly<T> | null {
  const row = record(value);
  if (!row || !exactKeys(row, fields as readonly string[])) return null;
  const copied: Record<string, unknown> = {};
  for (const field of fields) copied[field as string] = row[field as string];
  return Object.freeze(copied) as Readonly<T>;
}

function snapshotKey<T extends MeriHermesRecoveryCommandKeyV1 | MeriHermesRecoveryReceiptKeyV1>(
  value: unknown,
): T | null {
  const row = record(value);
  if (!row || !exactKeys(row, KEY_FIELDS) || !(row.secret instanceof Uint8Array)) return null;
  return Object.freeze({
    purpose: row.purpose,
    keyId: row.keyId,
    tenantId: row.tenantId,
    workerAudience: row.workerAudience,
    workerIngressId: row.workerIngressId,
    workerGeneration: row.workerGeneration,
    workerCredentialId: row.workerCredentialId,
    secret: Uint8Array.from(row.secret),
    notBeforeEpochMicros: row.notBeforeEpochMicros,
    notAfterEpochMicros: row.notAfterEpochMicros,
  }) as T;
}

function sameClaims<T extends object>(
  left: Readonly<T>, right: Readonly<T>, fields: ReadonlyArray<keyof T>,
): boolean {
  return fields.every((field) => left[field] === right[field]);
}

function canonicalMicros(value: bigint | string): string | null {
  const text = typeof value === 'bigint' ? value.toString() : value;
  return POSITIVE_MICROS.test(text) && BigInt(text) <= MAX_INT64 ? text : null;
}

function sha256Ascii(value: string): string {
  return createHash('sha256').update(value, 'ascii').digest('hex');
}

function sharedSecret(
  commandKey: MeriHermesRecoveryCommandKeyV1,
  receiptKey: MeriHermesRecoveryReceiptKeyV1,
): boolean {
  return commandKey.secret.length === receiptKey.secret.length &&
    timingSafeEqual(commandKey.secret, receiptKey.secret);
}

function freezeInput(input: MeriHermesVerifiedReservationRecoveryCommitV1): FrozenInput | null {
  const identity = Object.freeze({ ...input.identity });
  const commandKey = snapshotKey<MeriHermesRecoveryCommandKeyV1>(input.commandKey);
  const receiptKey = snapshotKey<MeriHermesRecoveryReceiptKeyV1>(input.receiptKey);
  const verifiedCommand = snapshotClaims<MeriHermesReservationCommandClaimsV1>(
    input.verifiedCommand, COMMAND_FIELDS,
  );
  const verifiedReceipt = snapshotClaims<MeriHermesReservationReceiptClaimsV1>(
    input.verifiedReceipt, RECEIPT_FIELDS,
  );
  if (!isMeriDispatchRequestIdentityV2(identity) ||
      typeof input.commandToken !== 'string' || typeof input.receiptToken !== 'string' ||
      !commandKey || !receiptKey || !verifiedCommand || !verifiedReceipt ||
      !KEY_ID.test(commandKey.keyId) || !KEY_ID.test(receiptKey.keyId) ||
      sharedSecret(commandKey, receiptKey) ||
      input.idempotencyKey !== identity.idempotencyKey ||
      input.deliveryNotBeforeEpochMicros !== identity.deliveryNotAfterEpochMicros) return null;
  return Object.freeze({
    identity,
    idempotencyKey: input.idempotencyKey,
    deliveryNotBeforeEpochMicros: input.deliveryNotBeforeEpochMicros,
    commandToken: input.commandToken,
    commandKey,
    receiptToken: input.receiptToken,
    receiptKey,
    verifiedCommand,
    verifiedReceipt,
  });
}

function identityFromRow(row: IntentRow): MeriDispatchRequestIdentityV2 | null {
  const identity: MeriDispatchRequestIdentityV2 = {
    version: row.identity_version as 2,
    tenantId: row.tenant_id,
    actorType: row.actor_type as 'user',
    actorId: row.actor_id,
    meriAudience: row.meri_audience as 'private',
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    scopeId: row.scope_id,
    conversationId: row.conversation_id,
    userMessageId: row.user_message_id,
    runId: row.run_id,
    idempotencyKey: row.idempotency_key,
    conversationEpoch: Number(row.conversation_epoch),
    workerAudience: row.worker_audience,
    workerIngressId: row.worker_ingress_id,
    workerGeneration: row.worker_generation,
    workerCredentialId: row.worker_credential_id,
    authorizationVersion: row.authorization_version,
    authorizationPolicyVersion: row.authorization_policy_version,
    grantVersion: row.grant_version,
    catalogDigest: row.catalog_digest,
    toolViewDigest: row.tool_view_digest,
    sessionHeaderKeyId: row.session_header_key_id,
    claimNotAfterEpochMicros: String(row.claim_not_after_epoch_micros),
    deliveryNotAfterEpochMicros: String(row.delivery_not_after_epoch_micros),
    workerCredentialNotAfterEpochMicros: String(row.worker_credential_not_after_epoch_micros),
    reconciliationNotAfterEpochMicros: String(row.reconciliation_not_after_epoch_micros),
    retainUntilEpochMicros: String(row.retain_until_epoch_micros),
    sourceMessageSha256: row.source_message_sha256,
    bodyLengthBytes: Number(row.body_length_bytes),
    bodySha256: row.body_sha256,
    requestAssemblySha256: row.request_assembly_sha256,
    sessionHeaderHmacSha256: row.session_header_hmac_sha256,
    requestSha256: row.request_sha256,
  };
  return isMeriDispatchRequestIdentityV2(identity) ? identity : null;
}

function sameIdentity(
  left: Readonly<MeriDispatchRequestIdentityV2>,
  right: Readonly<MeriDispatchRequestIdentityV2>,
): boolean {
  return (Object.keys(left) as Array<keyof MeriDispatchRequestIdentityV2>)
    .every((key) => left[key] === right[key]);
}

function canonicalConversationEpoch(value: string | null): number | null {
  if (value === null) return 0;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function sourceMatchesIdentity(
  source: SourceRow,
  identity: MeriDispatchRequestIdentityV2,
): boolean {
  return source.run_id === identity.runId && source.tenant_id === identity.tenantId &&
    source.scope_id === identity.scopeId && source.actor_id === identity.actorId &&
    source.conversation_id === identity.conversationId &&
    source.user_message_id === identity.userMessageId &&
    source.idempotency_key === identity.idempotencyKey &&
    source.scope_principal_type === identity.actorType &&
    source.scope_principal_id === identity.actorId &&
    source.scope_kind === identity.meriAudience &&
    source.scope_authorization_version === identity.authorizationVersion &&
    source.envelope_authorization_version === identity.authorizationVersion &&
    source.conversation_user_id === identity.actorId &&
    source.conversation_client_id === identity.clientId &&
    source.conversation_workspace_id === identity.workspaceId &&
    canonicalConversationEpoch(source.conversation_epoch_text) === identity.conversationEpoch &&
    source.message_tenant_id === identity.tenantId &&
    source.message_user_id === identity.actorId &&
    source.message_client_id === identity.clientId &&
    source.message_conversation_id === identity.conversationId &&
    source.message_role === 'user' &&
    meriDispatchSourceMessageSha256V2(identity, {
      body: source.message_body,
      metadata: source.message_metadata_jsonb,
    }) === identity.sourceMessageSha256 &&
    source.dispatch_status === 'pending' &&
    ['queued', 'provisioning', 'cancelling'].includes(source.run_status);
}

function exactOperation(
  row: OperationRow,
  receipt: MeriHermesReservationReceiptClaimsV1,
): boolean {
  return row.tenant_id === receipt.tenantId && row.operation_id === receipt.operationId &&
    row.run_id === receipt.runId && row.request_sha256 === receipt.requestSha256 &&
    row.idempotency_key === receipt.idempotencyKey &&
    row.worker_audience === receipt.workerAudience &&
    row.worker_ingress_id === receipt.workerIngressId &&
    row.worker_generation === receipt.workerGeneration &&
    row.worker_credential_id === receipt.workerCredentialId &&
    String(row.delivery_not_before_epoch_micros) === receipt.deliveryNotBeforeEpochMicros &&
    String(row.retain_until_epoch_micros) === receipt.retainUntilEpochMicros &&
    row.outcome === receipt.outcome && row.worker_run_id === receipt.workerRunId &&
    (row.sealed_at_epoch_micros === null
      ? receipt.sealedAtEpochMicros === null
      : String(row.sealed_at_epoch_micros) === receipt.sealedAtEpochMicros);
}

function exactReceipt(
  row: ReceiptRow,
  receipt: MeriHermesReservationReceiptClaimsV1,
  receiptSha256: string,
  commandKeyId: string,
  signature: string,
): boolean {
  return exactOperation(row, receipt) && row.contract_version === receipt.version &&
    row.receipt_purpose === receipt.purpose && row.attempt_nonce === receipt.attemptNonce &&
    row.command_key_id === commandKeyId && row.command_sha256 === receipt.commandSha256 &&
    row.native_request_body_sha256 === receipt.nativeBodySha256 &&
    row.native_response_body_sha256 === receipt.nativeResponseBodySha256 &&
    row.receipt_sha256 === receiptSha256 && row.worker_status === receipt.workerStatus &&
    row.native_http_status === receipt.nativeHttpStatus &&
    String(row.issued_at_epoch_micros) === receipt.notBeforeEpochMicros &&
    String(row.expires_at_epoch_micros) === receipt.notAfterEpochMicros &&
    String(row.observed_at_epoch_micros) === receipt.observedAtEpochMicros &&
    row.key_id === receipt.keyId && row.signature === signature;
}

async function lockSource(
  tx: MeriHermesRecoveryPersistenceTransactionV1,
  tenantId: string,
  runId: string,
): Promise<readonly SourceRow[]> {
  return tx.query<SourceRow>(`
    SELECT *
    FROM public.meri_phase4_lock_reservation_recovery_source($1::uuid, $2::uuid)
  `, [tenantId, runId]);
}

export class MeriHermesReservationRecoveryRepositoryV1 {
  constructor(private readonly database: MeriHermesRecoveryPersistenceDatabaseV1) {}

  async commitVerified(
    input: Readonly<MeriHermesVerifiedReservationRecoveryCommitV1>,
  ): Promise<MeriHermesReservationRecoveryCommitOutcomeV1> {
    const frozen = freezeInput(input);
    if (!frozen) throw new MeriHermesReservationRecoveryPersistenceVerificationError();

    return this.database.withRecoveryAuthorityTransaction(async (tx) => {
      await tx.execute('SET LOCAL ROLE meri_phase4_authority_owner', []);
      const principals = await tx.query<AuthorityRow>(
        'SELECT current_user::text AS current_user, session_user::text AS session_user', [],
      );
      if (principals.length !== 1 || principals[0]?.current_user !== OWNER ||
          principals[0].session_user === 'capiro_app') {
        throw new MeriHermesReservationRecoveryPersistenceAuthorityError();
      }

      // Shared ordering with claim and every revocation/route writer.
      const fence = await tx.query<FenceRow>(
        'SELECT revision FROM public.meri_phase4_lock_authority_fence($1::uuid)',
        [frozen.identity.tenantId],
      );
      if (fence.length !== 1 || canonicalMicros(fence[0]!.revision) === null) {
        throw new MeriHermesReservationRecoveryPersistenceAuthorityError();
      }
      const sources = await lockSource(tx, frozen.identity.tenantId, frozen.identity.runId);
      const intents = await tx.query<IntentRow>(`
        SELECT * FROM public.meri_agent_dispatch_intents
        WHERE tenant_id = $1::uuid AND run_id = $2::uuid
        FOR UPDATE
      `, [frozen.identity.tenantId, frozen.identity.runId]);
      if (sources.length !== 1 || intents.length !== 1) {
        throw new MeriHermesReservationRecoveryPersistenceConflictError();
      }
      const durableIdentity = identityFromRow(intents[0]!);
      if (!durableIdentity || !sameIdentity(durableIdentity, frozen.identity) ||
          !sourceMatchesIdentity(sources[0]!, durableIdentity)) {
        throw new MeriHermesReservationRecoveryPersistenceConflictError();
      }

      const clocks = await tx.query<ClockRow>(
        'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint AS db_now_epoch_micros',
        [],
      );
      const dbNow = clocks.length === 1
        ? canonicalMicros(clocks[0]!.db_now_epoch_micros) : null;
      if (!dbNow || BigInt(dbNow) < BigInt(frozen.deliveryNotBeforeEpochMicros) ||
          BigInt(dbNow) >= BigInt(frozen.identity.reconciliationNotAfterEpochMicros) ||
          BigInt(dbNow) >= BigInt(frozen.identity.retainUntilEpochMicros)) {
        throw new MeriHermesReservationRecoveryPersistenceAuthorityError();
      }

      const command = verifyMeriHermesReservationCommandV1(
        frozen.commandToken, frozen.identity, frozen.commandKey, dbNow,
      );
      const receipt = verifyMeriHermesReservationReceiptV1(
        frozen.receiptToken, frozen.commandToken, frozen.identity,
        frozen.commandKey, frozen.receiptKey, dbNow,
      );
      if (!command || !receipt ||
          !sameClaims(command, frozen.verifiedCommand, COMMAND_FIELDS) ||
          !sameClaims(receipt, frozen.verifiedReceipt, RECEIPT_FIELDS) ||
          command.idempotencyKey !== frozen.idempotencyKey ||
          command.deliveryNotBeforeEpochMicros !== frozen.deliveryNotBeforeEpochMicros) {
        throw new MeriHermesReservationRecoveryPersistenceVerificationError();
      }
      const signature = frozen.receiptToken.split('.')[2];
      if (!signature) throw new MeriHermesReservationRecoveryPersistenceVerificationError();
      const receiptSha256 = sha256Ascii(frozen.receiptToken);
      const intent = intents[0]!;
      const source = sources[0]!;

      let anchored: readonly OperationRow[];
      if (intent.state === 'prepared' && intent.worker_run_id === null &&
          intent.absence_proof_sha256 === null && source.existing_worker_run_id === null) {
        const insertedAnchor = await tx.query<OperationRow>(`
          INSERT INTO public.meri_phase4_reservation_recovery_operations (
            tenant_id, operation_id, run_id, request_sha256, idempotency_key,
            worker_audience, worker_ingress_id, worker_generation,
            worker_credential_id, delivery_not_before_epoch_micros,
            retain_until_epoch_micros, outcome, worker_run_id,
            sealed_at_epoch_micros
          ) VALUES (
            $1::uuid, $2::uuid, $3::uuid, $4::char(64), $5::varchar(200),
            $6::varchar(64), $7::varchar(128), $8::varchar(128),
            $9::varchar(128), $10::bigint, $11::bigint, $12::varchar(16),
            $13::varchar(120), $14::bigint
          ) ON CONFLICT (tenant_id, operation_id) DO NOTHING
          RETURNING *
        `, [
          receipt.tenantId, receipt.operationId, receipt.runId, receipt.requestSha256,
          receipt.idempotencyKey, receipt.workerAudience, receipt.workerIngressId,
          receipt.workerGeneration, receipt.workerCredentialId,
          BigInt(receipt.deliveryNotBeforeEpochMicros), BigInt(receipt.retainUntilEpochMicros),
          receipt.outcome, receipt.workerRunId,
          receipt.sealedAtEpochMicros === null ? null : BigInt(receipt.sealedAtEpochMicros),
        ]);
        if (insertedAnchor.length !== 1 || !exactOperation(insertedAnchor[0]!, receipt)) {
          throw new MeriHermesReservationRecoveryPersistenceConflictError();
        }
        anchored = insertedAnchor;

        if (receipt.outcome === 'reserved') {
          const boundRun = await tx.query<{ id: string }>(`
            UPDATE public.meri_agent_runs
            SET hermes_run_id = $3::varchar(120)
            WHERE tenant_id = $1::uuid AND id = $2::uuid
              AND hermes_run_id IS NULL AND dispatch_status = 'pending'
              AND status IN ('queued', 'provisioning', 'cancelling')
              AND floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint
                >= $4::bigint
              AND floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint
                < $5::bigint
              AND floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint
                < $6::bigint
            RETURNING id
          `, [
            receipt.tenantId, receipt.runId, receipt.workerRunId,
            BigInt(receipt.deliveryNotBeforeEpochMicros),
            BigInt(receipt.notAfterEpochMicros),
            BigInt(frozen.identity.reconciliationNotAfterEpochMicros),
          ]);
          if (boundRun.length !== 1) {
            throw new MeriHermesReservationRecoveryPersistenceConflictError();
          }
          const claimed = await tx.query<{ run_id: string }>(`
            UPDATE public.meri_agent_dispatch_intents
            SET state = 'claimed', worker_run_id = $3::varchar(120)
            WHERE tenant_id = $1::uuid AND run_id = $2::uuid
              AND request_sha256 = $4::char(64) AND state = 'prepared'
              AND floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint
                >= $5::bigint
              AND floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint
                < $6::bigint
              AND floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint
                < $7::bigint
            RETURNING run_id
          `, [
            receipt.tenantId, receipt.runId, receipt.workerRunId,
            receipt.requestSha256, BigInt(receipt.deliveryNotBeforeEpochMicros),
            BigInt(receipt.notAfterEpochMicros),
            BigInt(frozen.identity.reconciliationNotAfterEpochMicros),
          ]);
          if (claimed.length !== 1) {
            throw new MeriHermesReservationRecoveryPersistenceConflictError();
          }
        } else {
          const sealed = await tx.query<{ run_id: string }>(`
            UPDATE public.meri_agent_dispatch_intents
            SET state = 'sealed_absent', absence_proof_sha256 = $3::char(64)
            WHERE tenant_id = $1::uuid AND run_id = $2::uuid
              AND request_sha256 = $4::char(64) AND state = 'prepared'
              AND floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint
                >= $5::bigint
              AND floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint
                < $6::bigint
              AND floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint
                < $7::bigint
            RETURNING run_id
          `, [
            receipt.tenantId, receipt.runId, receiptSha256,
            receipt.requestSha256, BigInt(receipt.deliveryNotBeforeEpochMicros),
            BigInt(receipt.notAfterEpochMicros),
            BigInt(frozen.identity.reconciliationNotAfterEpochMicros),
          ]);
          if (sealed.length !== 1) {
            throw new MeriHermesReservationRecoveryPersistenceConflictError();
          }
        }
      } else {
        const finalMatches = receipt.outcome === 'reserved'
          ? intent.state === 'claimed' && intent.worker_run_id === receipt.workerRunId &&
            source.existing_worker_run_id === receipt.workerRunId
          : intent.state === 'sealed_absent' && intent.worker_run_id === null &&
            intent.absence_proof_sha256 !== null;
        if (!finalMatches) throw new MeriHermesReservationRecoveryPersistenceConflictError();
        anchored = await tx.query<OperationRow>(`
          SELECT * FROM public.meri_phase4_reservation_recovery_operations
          WHERE tenant_id = $1::uuid AND operation_id = $2::uuid
          FOR SHARE
        `, [receipt.tenantId, receipt.operationId]);
        // This is the provenance fence: an ordinary claimed/sealed intent can
        // never be reinterpreted as a reservation-recovery result.
        if (anchored.length !== 1 || !exactOperation(anchored[0]!, receipt) ||
            (receipt.outcome === 'sealed_absent' &&
              intent.absence_proof_sha256 !== receiptSha256)) {
          throw new MeriHermesReservationRecoveryPersistenceConflictError();
        }
      }

      const parameters: readonly unknown[] = [
        receipt.version, receipt.purpose, receipt.tenantId, receipt.runId,
        receipt.requestSha256, receipt.idempotencyKey, receipt.workerAudience,
        receipt.workerIngressId, receipt.workerGeneration, receipt.workerCredentialId,
        BigInt(receipt.deliveryNotBeforeEpochMicros), BigInt(receipt.retainUntilEpochMicros),
        receipt.outcome, receipt.workerRunId, receipt.workerStatus,
        receipt.sealedAtEpochMicros === null ? null : BigInt(receipt.sealedAtEpochMicros),
        receipt.operationId, receipt.attemptNonce, command.keyId, receipt.commandSha256,
        receipt.nativeBodySha256, receipt.nativeResponseBodySha256, receiptSha256,
        receipt.nativeHttpStatus, BigInt(receipt.notBeforeEpochMicros),
        BigInt(receipt.notAfterEpochMicros), BigInt(receipt.observedAtEpochMicros),
        receipt.keyId, signature,
      ];
      const inserted = await tx.query<ReceiptRow>(`
        INSERT INTO public.meri_phase4_reservation_recovery_receipts (
          contract_version, receipt_purpose, tenant_id, run_id, request_sha256,
          idempotency_key, worker_audience, worker_ingress_id, worker_generation,
          worker_credential_id, delivery_not_before_epoch_micros,
          retain_until_epoch_micros, outcome, worker_run_id, worker_status,
          sealed_at_epoch_micros, operation_id, attempt_nonce, command_key_id,
          command_sha256, native_request_body_sha256, native_response_body_sha256,
          receipt_sha256, native_http_status, issued_at_epoch_micros,
          expires_at_epoch_micros, observed_at_epoch_micros, key_id, signature
        ) VALUES (
          $1::smallint, $2::varchar(64), $3::uuid, $4::uuid, $5::char(64),
          $6::varchar(200), $7::varchar(64), $8::varchar(128), $9::varchar(128),
          $10::varchar(128), $11::bigint, $12::bigint, $13::varchar(16),
          $14::varchar(120), $15::varchar(32), $16::bigint, $17::uuid,
          $18::varchar(22), $19::varchar(128), $20::char(64), $21::char(64),
          $22::char(64), $23::char(64), $24::smallint, $25::bigint, $26::bigint,
          $27::bigint, $28::varchar(128), $29::varchar(43)
        ) ON CONFLICT DO NOTHING
        RETURNING *
      `, parameters);
      if (inserted.length === 1 && exactReceipt(
        inserted[0]!, receipt, receiptSha256, command.keyId, signature,
      )) {
        return receipt.outcome === 'reserved'
          ? Object.freeze({ kind: 'bound_worker' as const, workerRunId: receipt.workerRunId! })
          : Object.freeze({ kind: 'sealed_absent' as const });
      }
      if (inserted.length !== 0) {
        throw new MeriHermesReservationRecoveryPersistenceConflictError();
      }
      const prior = await tx.query<ReceiptRow>(`
        SELECT * FROM public.meri_phase4_reservation_recovery_receipts
        WHERE tenant_id = $1::uuid AND (
          receipt_sha256 = $2::char(64) OR attempt_nonce = $3::varchar(22) OR
          (key_id = $4::varchar(128) AND signature = $5::varchar(43))
        ) FOR SHARE
      `, [
        receipt.tenantId, receiptSha256, receipt.attemptNonce,
        receipt.keyId, signature,
      ]);
      if (prior.length !== 1 || !exactReceipt(
        prior[0]!, receipt, receiptSha256, command.keyId, signature,
      )) {
        throw new MeriHermesReservationRecoveryPersistenceConflictError();
      }
      return receipt.outcome === 'reserved'
        ? Object.freeze({ kind: 'bound_worker' as const, workerRunId: receipt.workerRunId! })
        : Object.freeze({ kind: 'sealed_absent' as const });
    });
  }
}
