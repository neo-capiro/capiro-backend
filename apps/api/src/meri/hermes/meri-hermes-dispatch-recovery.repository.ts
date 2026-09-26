import { createHash, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';
import {
  verifyMeriHermesRecoveryCommandV1,
  verifyMeriHermesRecoveryReceiptV1,
  type MeriHermesRecoveryCommandClaimsV1,
  type MeriHermesRecoveryCommandKeyV1,
  type MeriHermesRecoveryReceiptClaimsV1,
  type MeriHermesRecoveryReceiptKeyV1,
} from './meri-hermes-dispatch-recovery.contract.js';
import {
  isMeriDispatchRequestIdentityV2,
  type MeriDispatchRequestIdentityV2,
} from './meri-hermes-dispatch-intent.contract.js';

/**
 * Dormant Phase 4 recovery persistence boundary. It is not a Nest provider and
 * is not registered by any module, controller, scheduler, or runtime adapter.
 * The database adapter must open one transaction on a separately provisioned
 * privileged connection that is allowed to SET LOCAL ROLE to the NOLOGIN
 * authority owner. `capiro_app` is explicitly rejected and receives no grant.
 */

const OWNER = 'meri_phase4_authority_owner';
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const POSITIVE_MICROS = /^[1-9][0-9]{0,18}$/;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const MAX_DISPLAY_BODY_BYTES = 1_048_576;
const MAX_HERMES_SESSION_ID_LENGTH = 120;
const MAX_DISPLAY_OUTPUT_LENGTH = 1_000_000;
const MAX_DISPLAY_ERROR_LENGTH = 65_536;
const displayDecoder = new TextDecoder('utf-8', { fatal: true });

const COMMAND_FIELDS: ReadonlyArray<keyof MeriHermesRecoveryCommandClaimsV1> = [
  'version', 'purpose', 'keyId', 'tenantId', 'runId', 'requestSha256', 'workerRunId',
  'workerAudience', 'workerIngressId', 'workerGeneration', 'workerCredentialId',
  'action', 'operationId', 'attemptNonce', 'nativeMethod', 'nativePath',
  'nativeBodySha256', 'notBeforeEpochMicros', 'notAfterEpochMicros',
];
const RECEIPT_FIELDS: ReadonlyArray<keyof MeriHermesRecoveryReceiptClaimsV1> = [
  'version', 'purpose', 'keyId', 'tenantId', 'runId', 'requestSha256', 'workerRunId',
  'workerAudience', 'workerIngressId', 'workerGeneration', 'workerCredentialId',
  'action', 'operationId', 'attemptNonce', 'commandSha256', 'nativeMethod',
  'nativePath', 'nativeBodySha256', 'nativeHttpStatus',
  'nativeResponseBodySha256', 'observation', 'workerStatus',
  'observedAtEpochMicros', 'notBeforeEpochMicros', 'notAfterEpochMicros',
];
const KEY_FIELDS = [
  'purpose', 'keyId', 'tenantId', 'workerAudience', 'workerIngressId',
  'workerGeneration', 'workerCredentialId', 'secret',
  'notBeforeEpochMicros', 'notAfterEpochMicros',
] as const;

export interface MeriHermesRecoveryPersistenceTransactionV1 {
  /** Fixed SQL only; every data value is a positional bind parameter. */
  execute(sql: string, parameters: readonly unknown[]): Promise<void>;
  query<T extends object>(sql: string, parameters: readonly unknown[]): Promise<readonly T[]>;
}

export interface MeriHermesRecoveryPersistenceDatabaseV1 {
  /**
   * Opens and atomically commits/rolls back a privileged transaction. The
   * session must be capable of SET LOCAL ROLE, but must never be capiro_app.
   */
  withRecoveryAuthorityTransaction<T>(
    run: (tx: MeriHermesRecoveryPersistenceTransactionV1) => Promise<T>,
  ): Promise<T>;
}

export interface PersistVerifiedMeriHermesRecoveryReceiptV1 {
  readonly identity: Readonly<MeriDispatchRequestIdentityV2>;
  readonly workerRunId: string;
  readonly commandToken: string;
  readonly receiptToken: string;
  readonly commandKey: Readonly<MeriHermesRecoveryCommandKeyV1>;
  readonly receiptKey: Readonly<MeriHermesRecoveryReceiptKeyV1>;
  /** Claims previously returned by the strict recovery contract verifier. */
  readonly verifiedCommand: Readonly<MeriHermesRecoveryCommandClaimsV1>;
  readonly verifiedReceipt: Readonly<MeriHermesRecoveryReceiptClaimsV1>;
  /** Exact native response bytes; copied before the first async boundary. */
  readonly nativeResponseBodyBytes: Uint8Array;
}

export interface PersistedMeriHermesRecoveryReceiptV1 {
  readonly receiptId: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly workerRunId: string;
  readonly operationId: string;
  readonly attemptNonce: string;
  readonly action: 'status' | 'stop';
  readonly observation: 'run_nonterminal' | 'run_terminal' | 'stop_accepted' | 'not_found';
  readonly receiptSha256: string;
  readonly keyId: string;
  readonly issuedAtEpochMicros: string;
  readonly expiresAtEpochMicros: string;
  readonly observedAtEpochMicros: string;
}

export type PersistMeriHermesRecoveryReceiptResultV1 = Readonly<{
  kind: 'inserted' | 'replayed';
  receipt: Readonly<PersistedMeriHermesRecoveryReceiptV1>;
}>;

export class MeriHermesRecoveryPersistenceVerificationError extends Error {
  constructor() {
    super('Phase 4 recovery persistence requires an exact verified command/receipt pair');
    this.name = 'MeriHermesRecoveryPersistenceVerificationError';
  }
}

export class MeriHermesRecoveryPersistenceAuthorityError extends Error {
  constructor() {
    super('Phase 4 recovery persistence authority is unavailable');
    this.name = 'MeriHermesRecoveryPersistenceAuthorityError';
  }
}

export class MeriHermesRecoveryPersistenceConflictError extends Error {
  constructor() {
    super('Phase 4 recovery persistence conflict');
    this.name = 'MeriHermesRecoveryPersistenceConflictError';
  }
}

interface AuthorityRow { current_user: string; session_user: string }
interface ClockRow { db_now_epoch_micros: bigint | string }
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
  issued_at_epoch_micros: bigint | string;
  expires_at_epoch_micros: bigint | string;
  observed_at_epoch_micros: bigint | string;
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
  usage_jsonb: unknown;
  display_state: string;
  persisted_at: Date | string;
}

interface NormalizedDisplayEnvelope {
  readonly workerStatus: string;
  readonly hermesSessionId: string | null;
  readonly outputText: string | null;
  readonly errorText: string | null;
  readonly usage: Readonly<Record<string, number>> | null;
  readonly displayState: 'available' | 'unavailable';
}

interface FrozenInput {
  readonly identity: Readonly<MeriDispatchRequestIdentityV2>;
  readonly workerRunId: string;
  readonly commandToken: string;
  readonly receiptToken: string;
  readonly commandKey: MeriHermesRecoveryCommandKeyV1;
  readonly receiptKey: MeriHermesRecoveryReceiptKeyV1;
  readonly verifiedCommand: Readonly<MeriHermesRecoveryCommandClaimsV1>;
  readonly verifiedReceipt: Readonly<MeriHermesRecoveryReceiptClaimsV1>;
  readonly nativeResponseBodyBytes: Uint8Array;
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
  const snapshot: Record<string, unknown> = {};
  for (const field of fields) snapshot[field as string] = row[field as string];
  return Object.freeze(snapshot) as Readonly<T>;
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
  left: Readonly<T>,
  right: Readonly<T>,
  fields: ReadonlyArray<keyof T>,
): boolean {
  return fields.every((field) => left[field] === right[field]);
}

function sha256Ascii(value: string): string {
  return createHash('sha256').update(value, 'ascii').digest('hex');
}

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function exactSha256(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === 32 && rightBytes.length === 32 &&
    timingSafeEqual(leftBytes, rightBytes);
}

function optionalBoundedString(
  row: Record<string, unknown>,
  field: string,
  maximumLength: number,
): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(row, field)) return null;
  const value = row[field];
  return typeof value === 'string' && value.length <= maximumLength ? value : undefined;
}

function normalizedUsage(value: unknown): Readonly<Record<string, number>> | null | undefined {
  if (value === undefined) return null;
  const row = record(value);
  if (!row) return undefined;
  const usage: Record<string, number> = {};
  for (const field of ['input_tokens', 'output_tokens', 'total_tokens'] as const) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) continue;
    const tokens = row[field];
    if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) {
      return undefined;
    }
    usage[field] = tokens;
  }
  return Object.freeze(usage);
}

function normalizeDisplayEnvelope(
  bytes: Uint8Array,
  receipt: MeriHermesRecoveryReceiptClaimsV1,
): Readonly<NormalizedDisplayEnvelope> | null {
  if (receipt.observation !== 'run_terminal' || receipt.workerStatus === null) return null;
  const unavailable = (): Readonly<NormalizedDisplayEnvelope> => Object.freeze({
    workerStatus: receipt.workerStatus!,
    hermesSessionId: null,
    outputText: null,
    errorText: null,
    usage: null,
    displayState: 'unavailable',
  });
  if (bytes.length > MAX_DISPLAY_BODY_BYTES) return unavailable();
  let decoded: unknown;
  try {
    decoded = JSON.parse(displayDecoder.decode(bytes));
  } catch {
    return unavailable();
  }
  const row = record(decoded);
  if (!row || row.run_id !== receipt.workerRunId || row.status !== receipt.workerStatus) {
    return unavailable();
  }
  const hermesSessionId = optionalBoundedString(
    row, 'session_id', MAX_HERMES_SESSION_ID_LENGTH,
  );
  const outputText = optionalBoundedString(row, 'output', MAX_DISPLAY_OUTPUT_LENGTH);
  const errorText = optionalBoundedString(row, 'error', MAX_DISPLAY_ERROR_LENGTH);
  const usage = normalizedUsage(row.usage);
  if (hermesSessionId === undefined || outputText === undefined ||
      errorText === undefined || usage === undefined) return unavailable();
  return Object.freeze({
    workerStatus: receipt.workerStatus,
    hermesSessionId,
    outputText,
    errorText,
    usage,
    displayState: receipt.workerStatus === 'completed' &&
      outputText !== null && outputText.length > 0 ? 'available' : 'unavailable',
  });
}

function canonicalMicros(value: bigint | string): string | null {
  const text = typeof value === 'bigint' ? value.toString() : value;
  return POSITIVE_MICROS.test(text) && BigInt(text) <= MAX_INT64 ? text : null;
}

function sharedSecret(
  commandKey: MeriHermesRecoveryCommandKeyV1,
  receiptKey: MeriHermesRecoveryReceiptKeyV1,
): boolean {
  return commandKey.secret.length === receiptKey.secret.length &&
    timingSafeEqual(commandKey.secret, receiptKey.secret);
}

function freezeInput(input: PersistVerifiedMeriHermesRecoveryReceiptV1): FrozenInput | null {
  const identity = Object.freeze({ ...input.identity });
  const commandKey = snapshotKey<MeriHermesRecoveryCommandKeyV1>(input.commandKey);
  const receiptKey = snapshotKey<MeriHermesRecoveryReceiptKeyV1>(input.receiptKey);
  const verifiedCommand = snapshotClaims<MeriHermesRecoveryCommandClaimsV1>(
    input.verifiedCommand, COMMAND_FIELDS,
  );
  const verifiedReceipt = snapshotClaims<MeriHermesRecoveryReceiptClaimsV1>(
    input.verifiedReceipt, RECEIPT_FIELDS,
  );
  if (!isMeriDispatchRequestIdentityV2(identity) ||
      typeof input.workerRunId !== 'string' ||
      typeof input.commandToken !== 'string' || typeof input.receiptToken !== 'string' ||
      !(input.nativeResponseBodyBytes instanceof Uint8Array) ||
      !commandKey || !receiptKey || !verifiedCommand || !verifiedReceipt ||
      !KEY_ID.test(commandKey.keyId) || !KEY_ID.test(receiptKey.keyId) ||
      sharedSecret(commandKey, receiptKey)) return null;
  return Object.freeze({
    identity,
    workerRunId: input.workerRunId,
    commandToken: input.commandToken,
    receiptToken: input.receiptToken,
    commandKey,
    receiptKey,
    verifiedCommand,
    verifiedReceipt,
    nativeResponseBodyBytes: Uint8Array.from(input.nativeResponseBodyBytes),
  });
}

function exactOperation(row: OperationRow, receipt: MeriHermesRecoveryReceiptClaimsV1): boolean {
  return row.tenant_id === receipt.tenantId && row.operation_id === receipt.operationId &&
    row.run_id === receipt.runId && row.request_sha256 === receipt.requestSha256 &&
    row.worker_run_id === receipt.workerRunId &&
    row.worker_audience === receipt.workerAudience &&
    row.worker_ingress_id === receipt.workerIngressId &&
    row.worker_generation === receipt.workerGeneration &&
    row.worker_credential_id === receipt.workerCredentialId && row.action === receipt.action;
}

function exactReceipt(
  row: ReceiptRow,
  receipt: MeriHermesRecoveryReceiptClaimsV1,
  receiptSha256: string,
  commandKeyId: string,
  keyId: string,
  signature: string,
): boolean {
  return exactOperation(row, receipt) && row.contract_version === receipt.version &&
    row.receipt_purpose === receipt.purpose && row.attempt_nonce === receipt.attemptNonce &&
    row.command_key_id === commandKeyId &&
    row.command_sha256 === receipt.commandSha256 &&
    row.native_request_body_sha256 === receipt.nativeBodySha256 &&
    row.native_response_body_sha256 === receipt.nativeResponseBodySha256 &&
    row.receipt_sha256 === receiptSha256 && row.observation === receipt.observation &&
    row.worker_status === receipt.workerStatus &&
    row.native_http_status === receipt.nativeHttpStatus &&
    String(row.issued_at_epoch_micros) === receipt.notBeforeEpochMicros &&
    String(row.expires_at_epoch_micros) === receipt.notAfterEpochMicros &&
    String(row.observed_at_epoch_micros) === receipt.observedAtEpochMicros &&
    row.key_id === keyId && row.signature === signature;
}

function exactUsage(
  value: unknown,
  expected: Readonly<Record<string, number>> | null,
): boolean {
  if (expected === null) return value === null;
  const row = record(value);
  if (!row) return false;
  const expectedKeys = Object.keys(expected);
  return exactKeys(row, expectedKeys) &&
    expectedKeys.every((field) => row[field] === expected[field]);
}

function exactDisplayReceipt(
  row: DisplayReceiptRow,
  persistedReceipt: ReceiptRow,
  receipt: MeriHermesRecoveryReceiptClaimsV1,
  display: Readonly<NormalizedDisplayEnvelope>,
): boolean {
  return row.receipt_id === persistedReceipt.receipt_id &&
    row.tenant_id === receipt.tenantId && row.run_id === receipt.runId &&
    row.operation_id === receipt.operationId && row.attempt_nonce === receipt.attemptNonce &&
    row.native_response_body_sha256 === receipt.nativeResponseBodySha256 &&
    row.worker_status === display.workerStatus &&
    row.hermes_session_id === display.hermesSessionId &&
    row.output_text === display.outputText && row.error_text === display.errorText &&
    exactUsage(row.usage_jsonb, display.usage) && row.display_state === display.displayState &&
    (row.persisted_at instanceof Date || typeof row.persisted_at === 'string');
}

function persisted(row: ReceiptRow): Readonly<PersistedMeriHermesRecoveryReceiptV1> {
  return Object.freeze({
    receiptId: row.receipt_id,
    tenantId: row.tenant_id,
    runId: row.run_id,
    workerRunId: row.worker_run_id,
    operationId: row.operation_id,
    attemptNonce: row.attempt_nonce,
    action: row.action as 'status' | 'stop',
    observation: row.observation as PersistedMeriHermesRecoveryReceiptV1['observation'],
    receiptSha256: row.receipt_sha256,
    keyId: row.key_id,
    issuedAtEpochMicros: String(row.issued_at_epoch_micros),
    expiresAtEpochMicros: String(row.expires_at_epoch_micros),
    observedAtEpochMicros: String(row.observed_at_epoch_micros),
  });
}

async function persistDisplayReceipt(
  tx: MeriHermesRecoveryPersistenceTransactionV1,
  persistedReceipt: ReceiptRow,
  receipt: MeriHermesRecoveryReceiptClaimsV1,
  display: Readonly<NormalizedDisplayEnvelope>,
): Promise<void> {
  const parameters: readonly unknown[] = [
    persistedReceipt.receipt_id, receipt.tenantId, receipt.runId, receipt.operationId,
    receipt.attemptNonce, receipt.nativeResponseBodySha256, display.workerStatus,
    display.hermesSessionId, display.outputText, display.errorText,
    display.usage === null ? null : JSON.stringify(display.usage), display.displayState,
  ];
  const inserted = await tx.query<DisplayReceiptRow>(`
    INSERT INTO public.meri_phase4_recovery_display_receipts (
      receipt_id, tenant_id, run_id, operation_id, attempt_nonce,
      native_response_body_sha256, worker_status, hermes_session_id,
      output_text, error_text, usage_jsonb, display_state
    ) VALUES (
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::varchar(22),
      $6::char(64), $7::varchar(32), $8::text,
      $9::text, $10::text, $11::jsonb, $12::varchar(16)
    ) ON CONFLICT DO NOTHING
    RETURNING receipt_id, tenant_id, run_id, operation_id, attempt_nonce,
      native_response_body_sha256, worker_status, hermes_session_id,
      output_text, error_text, usage_jsonb, display_state, persisted_at
  `, parameters);
  if (inserted.length === 1 && exactDisplayReceipt(
    inserted[0]!, persistedReceipt, receipt, display,
  )) return;
  if (inserted.length !== 0) throw new MeriHermesRecoveryPersistenceConflictError();

  const prior = await tx.query<DisplayReceiptRow>(`
    SELECT receipt_id, tenant_id, run_id, operation_id, attempt_nonce,
      native_response_body_sha256, worker_status, hermes_session_id,
      output_text, error_text, usage_jsonb, display_state, persisted_at
    FROM public.meri_phase4_recovery_display_receipts
    WHERE receipt_id = $1::uuid
    FOR SHARE
  `, [persistedReceipt.receipt_id]);
  if (prior.length !== 1 || !exactDisplayReceipt(
    prior[0]!, persistedReceipt, receipt, display,
  )) throw new MeriHermesRecoveryPersistenceConflictError();
}

export class MeriHermesDispatchRecoveryRepositoryV1 {
  constructor(private readonly database: MeriHermesRecoveryPersistenceDatabaseV1) {}

  async persistVerified(
    input: PersistVerifiedMeriHermesRecoveryReceiptV1,
  ): Promise<PersistMeriHermesRecoveryReceiptResultV1> {
    // Snapshot every caller-owned object and secret before the first async
    // boundary. Delayed database callbacks never observe later mutations.
    const frozen = freezeInput(input);
    if (!frozen) throw new MeriHermesRecoveryPersistenceVerificationError();

    return this.database.withRecoveryAuthorityTransaction(async (tx) => {
      await tx.execute('SET LOCAL ROLE meri_phase4_authority_owner', []);
      const principals = await tx.query<AuthorityRow>(
        'SELECT current_user::text AS current_user, session_user::text AS session_user',
        [],
      );
      if (principals.length !== 1 || principals[0]?.current_user !== OWNER ||
          principals[0].session_user === 'capiro_app') {
        throw new MeriHermesRecoveryPersistenceAuthorityError();
      }
      const clocks = await tx.query<ClockRow>(
        'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint AS db_now_epoch_micros',
        [],
      );
      const dbNow = clocks.length === 1 && clocks[0]
        ? canonicalMicros(clocks[0].db_now_epoch_micros) : null;
      if (!dbNow) throw new MeriHermesRecoveryPersistenceAuthorityError();

      const command = verifyMeriHermesRecoveryCommandV1(
        frozen.commandToken, frozen.identity, frozen.workerRunId, frozen.commandKey, dbNow,
      );
      const receipt = verifyMeriHermesRecoveryReceiptV1(
        frozen.receiptToken, frozen.commandToken, frozen.identity, frozen.workerRunId,
        frozen.commandKey, frozen.receiptKey, dbNow,
      );
      if (!command || !receipt ||
          !sameClaims(command, frozen.verifiedCommand, COMMAND_FIELDS) ||
          !sameClaims(receipt, frozen.verifiedReceipt, RECEIPT_FIELDS)) {
        throw new MeriHermesRecoveryPersistenceVerificationError();
      }
      if (!exactSha256(
        sha256Bytes(frozen.nativeResponseBodyBytes), receipt.nativeResponseBodySha256,
      )) throw new MeriHermesRecoveryPersistenceVerificationError();
      // Display data is optional derived state. A valid signed receipt remains
      // durable even when its response is not a safe normalized envelope.
      const display = normalizeDisplayEnvelope(frozen.nativeResponseBodyBytes, receipt);
      const signature = frozen.receiptToken.split('.')[2];
      if (!signature) throw new MeriHermesRecoveryPersistenceVerificationError();
      const receiptSha256 = sha256Ascii(frozen.receiptToken);

      await tx.query<OperationRow>(`
        INSERT INTO public.meri_phase4_dispatch_recovery_operations (
          tenant_id, operation_id, run_id, request_sha256, worker_run_id,
          worker_audience, worker_ingress_id, worker_generation,
          worker_credential_id, action
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::char(64), $5::varchar(120),
          $6::varchar(64), $7::varchar(128), $8::varchar(128),
          $9::varchar(128), $10::varchar(8)
        ) ON CONFLICT (tenant_id, operation_id) DO NOTHING
        RETURNING tenant_id, operation_id, run_id, request_sha256, worker_run_id,
          worker_audience, worker_ingress_id, worker_generation,
          worker_credential_id, action
      `, [
        receipt.tenantId, receipt.operationId, receipt.runId, receipt.requestSha256,
        receipt.workerRunId, receipt.workerAudience, receipt.workerIngressId,
        receipt.workerGeneration, receipt.workerCredentialId, receipt.action,
      ]);
      const operations = await tx.query<OperationRow>(`
        SELECT tenant_id, operation_id, run_id, request_sha256, worker_run_id,
          worker_audience, worker_ingress_id, worker_generation,
          worker_credential_id, action
        FROM public.meri_phase4_dispatch_recovery_operations
        WHERE tenant_id = $1::uuid AND operation_id = $2::uuid
        FOR SHARE
      `, [receipt.tenantId, receipt.operationId]);
      if (operations.length !== 1 || !exactOperation(operations[0]!, receipt)) {
        throw new MeriHermesRecoveryPersistenceConflictError();
      }

      const receiptParameters: readonly unknown[] = [
        receipt.version, receipt.purpose, receipt.tenantId, receipt.runId,
        receipt.requestSha256, receipt.workerRunId, receipt.workerAudience,
        receipt.workerIngressId, receipt.workerGeneration, receipt.workerCredentialId,
        receipt.action, receipt.operationId, receipt.attemptNonce, command.keyId,
        receipt.commandSha256, receipt.nativeBodySha256,
        receipt.nativeResponseBodySha256, receiptSha256,
        receipt.observation, receipt.workerStatus, receipt.nativeHttpStatus,
        BigInt(receipt.notBeforeEpochMicros), BigInt(receipt.notAfterEpochMicros),
        BigInt(receipt.observedAtEpochMicros), receipt.keyId, signature,
      ];
      const inserted = await tx.query<ReceiptRow>(`
        INSERT INTO public.meri_phase4_dispatch_recovery_receipts (
          contract_version, receipt_purpose, tenant_id, run_id, request_sha256,
          worker_run_id, worker_audience, worker_ingress_id, worker_generation,
          worker_credential_id, action, operation_id, attempt_nonce,
          command_key_id, command_sha256, native_request_body_sha256,
          native_response_body_sha256, receipt_sha256, observation, worker_status,
          native_http_status, issued_at_epoch_micros, expires_at_epoch_micros,
          observed_at_epoch_micros, key_id, signature
        ) VALUES (
          $1::smallint, $2::varchar(64), $3::uuid, $4::uuid, $5::char(64),
          $6::varchar(120), $7::varchar(64), $8::varchar(128), $9::varchar(128),
          $10::varchar(128), $11::varchar(8), $12::uuid, $13::varchar(22),
          $14::varchar(128), $15::char(64), $16::char(64), $17::char(64),
          $18::char(64), $19::varchar(24), $20::varchar(32), $21::smallint,
          $22::bigint, $23::bigint, $24::bigint, $25::varchar(128),
          $26::varchar(43)
        ) ON CONFLICT DO NOTHING
        RETURNING *
      `, receiptParameters);
      let resultKind: 'inserted' | 'replayed';
      let persistedReceipt: ReceiptRow;
      if (inserted.length === 1 && exactReceipt(
        inserted[0]!, receipt, receiptSha256, command.keyId, receipt.keyId, signature,
      )) {
        resultKind = 'inserted';
        persistedReceipt = inserted[0]!;
      } else {
        if (inserted.length !== 0) throw new MeriHermesRecoveryPersistenceConflictError();

        // Each database uniqueness fence participates in recovery. Exactly one
        // matching row is an idempotent replay; split or drifted matches fail.
        const prior = await tx.query<ReceiptRow>(`
          SELECT * FROM public.meri_phase4_dispatch_recovery_receipts
          WHERE tenant_id = $1::uuid AND (
            receipt_sha256 = $2::char(64) OR attempt_nonce = $3::varchar(22) OR
            (key_id = $4::varchar(128) AND signature = $5::varchar(43))
          ) FOR SHARE
        `, [
          receipt.tenantId, receiptSha256, receipt.attemptNonce,
          receipt.keyId, signature,
        ]);
        if (prior.length !== 1 || !exactReceipt(
          prior[0]!, receipt, receiptSha256, command.keyId, receipt.keyId, signature,
        )) {
          throw new MeriHermesRecoveryPersistenceConflictError();
        }
        resultKind = 'replayed';
        persistedReceipt = prior[0]!;
      }
      if (display) await persistDisplayReceipt(tx, persistedReceipt, receipt, display);
      return Object.freeze({ kind: resultKind, receipt: persisted(persistedReceipt) });
    });
  }
}
