import {
  isMeriHermesClarificationEffectIdentityV1,
  isMeriHermesMemoryProposalEffectIdentityV1,
  isMeriHermesRecordTurnEffectIdentityV1,
  meriHermesClarificationEffectResultV1,
  meriHermesClarificationRequestSha256V1,
  meriHermesMemoryProposalEffectResultV1,
  meriHermesMemoryProposalRequestSha256V1,
  meriHermesBrokerEffectResultV1,
  meriHermesRecordTurnRequestSha256V1,
  normalizeMeriHermesClarificationRequestV1,
  normalizeMeriHermesMemoryProposalRequestV1,
  parseMeriHermesClarificationEffectReceiptV1,
  parseMeriHermesMemoryProposalEffectReceiptV1,
  parseMeriHermesBrokerEffectReceiptV1,
  type MeriHermesClarificationEffectIdentityV1,
  type MeriHermesClarificationEffectResultV1,
  type MeriHermesClarificationRequestV1,
  type MeriHermesMemoryProposalEffectIdentityV1,
  type MeriHermesMemoryProposalEffectResultV1,
  type MeriHermesMemoryProposalRequestV1,
  type MeriHermesBrokerEffectReceiptKeyV1,
  type MeriHermesBrokerEffectReceiptRowV1,
  type MeriHermesBrokerEffectResultV1,
  type MeriHermesRecordTurnEffectIdentityV1,
  type MeriHermesRecordTurnRequestV1,
} from './meri-hermes-broker-effect.contract.js';

/**
 * Dormant Phase 4 `meri_record_turn` effect adapter. The injected database is
 * a dedicated caller connection; this class is intentionally not registered
 * with Nest and cannot manufacture or persist signer attestations.
 */

const OPERATOR = 'meri_phase4_broker_effect_operator';
const SET_ROLE_SQL = 'SET LOCAL ROLE meri_phase4_broker_effect_operator';
const PRINCIPAL_SQL = 'SELECT current_user, session_user';
const RECORD_TURN_SQL = `SELECT receipt_id, result, detail,
       broker_calls_before, broker_calls_after, event_seq, applied_at,
       applied_at_epoch_micros, retain_until_epoch_micros,
       signed_claims_sha256, signer_key_id, signature,
       signature_verified_at_epoch_micros, qualification_sha256, receipt_sha256
  FROM public.meri_phase4_record_turn_effect(
    $1::uuid, $2::uuid, $3::varchar, $4::char(64), $5::varchar,
    $6::uuid, $7::char(64), $8::integer, $9::integer, $10::varchar
  )`;
const CLARIFICATION_SQL = `SELECT receipt_id, result, detail,
       broker_calls_before, broker_calls_after, event_seq, applied_at,
       applied_at_epoch_micros, retain_until_epoch_micros,
       signed_claims_sha256, signer_key_id, signature,
       signature_verified_at_epoch_micros, qualification_sha256, receipt_sha256
  FROM public.meri_phase4_request_clarification_effect(
    $1::uuid, $2::uuid, $3::varchar, $4::char(64), $5::varchar,
    $6::uuid, $7::char(64), $8::text, $9::jsonb, $10::boolean, $11::varchar
  )`;
const MEMORY_PROPOSAL_SQL = `SELECT receipt_id, result, detail, scope,
       broker_calls_before, broker_calls_after, event_seq, applied_at,
       applied_at_epoch_micros, retain_until_epoch_micros,
       signed_claims_sha256, signer_key_id, signature,
       signature_verified_at_epoch_micros, qualification_sha256, receipt_sha256
  FROM public.meri_phase4_propose_memory_effect(
    $1::uuid, $2::uuid, $3::varchar, $4::char(64), $5::varchar,
    $6::uuid, $7::char(64), $8::varchar, $9::text, $10::varchar,
    $11::uuid, $12::float8, $13::text, $14::varchar
  )`;

export interface MeriHermesBrokerEffectTransactionV1 {
  execute(sql: string, parameters: readonly unknown[]): Promise<void>;
  query<T extends object>(sql: string, parameters: readonly unknown[]): Promise<readonly T[]>;
}

export interface MeriHermesBrokerEffectDatabaseV1 {
  withBrokerEffectTransaction<T>(
    run: (tx: MeriHermesBrokerEffectTransactionV1) => Promise<T>,
  ): Promise<T>;
}

export interface ApplyMeriHermesRecordTurnEffectV1 {
  readonly identity: Readonly<MeriHermesRecordTurnEffectIdentityV1>;
  readonly request: Readonly<MeriHermesRecordTurnRequestV1>;
  readonly effectDisposition: 'attempt' | 'effect_unknown';
  /** Public verification material only; private keys are never accepted. */
  readonly verificationKeys: ReadonlyMap<
    string,
    Readonly<MeriHermesBrokerEffectReceiptKeyV1>
  >;
}

export interface ApplyMeriHermesClarificationEffectV1 {
  readonly identity: Readonly<MeriHermesClarificationEffectIdentityV1>;
  readonly request: Readonly<{
    question: string;
    choices?: readonly string[];
    multiSelect?: boolean;
  }>;
  readonly effectDisposition: 'attempt' | 'effect_unknown';
  readonly verificationKeys: ReadonlyMap<
    string,
    Readonly<MeriHermesBrokerEffectReceiptKeyV1>
  >;
}

export interface ApplyMeriHermesMemoryProposalEffectV1 {
  readonly identity: Readonly<MeriHermesMemoryProposalEffectIdentityV1>;
  readonly request: Readonly<{
    key: string;
    value: string;
    scope: 'personal' | 'firm' | 'client';
    clientId?: string | null;
    confidence?: number | null;
    sourceExcerpt?: string | null;
  }>;
  readonly effectDisposition: 'attempt' | 'effect_unknown';
  readonly verificationKeys: ReadonlyMap<
    string,
    Readonly<MeriHermesBrokerEffectReceiptKeyV1>
  >;
}

export class MeriHermesBrokerEffectInputError extends Error {
  constructor() {
    super('Phase 4 broker-effect input is invalid');
    this.name = 'MeriHermesBrokerEffectInputError';
  }
}

export class MeriHermesBrokerEffectAuthorityError extends Error {
  constructor() {
    super('Phase 4 broker-effect operator authority is unavailable');
    this.name = 'MeriHermesBrokerEffectAuthorityError';
  }
}

interface PrincipalRow { current_user: string; session_user: string }

interface FrozenInput {
  readonly identity: Readonly<MeriHermesRecordTurnEffectIdentityV1>;
  readonly request: Readonly<MeriHermesRecordTurnRequestV1>;
  readonly effectDisposition: 'attempt' | 'effect_unknown';
  readonly verificationKeys: ReadonlyMap<
    string,
    Readonly<MeriHermesBrokerEffectReceiptKeyV1>
  >;
}

interface FrozenClarificationInput {
  readonly identity: Readonly<MeriHermesClarificationEffectIdentityV1>;
  readonly request: Readonly<MeriHermesClarificationRequestV1>;
  readonly effectDisposition: 'attempt' | 'effect_unknown';
  readonly verificationKeys: ReadonlyMap<
    string,
    Readonly<MeriHermesBrokerEffectReceiptKeyV1>
  >;
}

function snapshotKey(
  key: Readonly<MeriHermesBrokerEffectReceiptKeyV1>,
): Readonly<MeriHermesBrokerEffectReceiptKeyV1> {
  return Object.freeze({
    purpose: key?.purpose,
    keyId: key?.keyId,
    tenantId: key?.tenantId,
    scopeId: key?.scopeId,
    publicKeySpkiDer: Uint8Array.from(key?.publicKeySpkiDer ?? []),
    publicKeySpkiSha256: key?.publicKeySpkiSha256,
    notBeforeEpochMicros: key?.notBeforeEpochMicros,
    notAfterEpochMicros: key?.notAfterEpochMicros,
    qualificationSha256: key?.qualificationSha256,
  });
}

function freezeInput(value: Readonly<ApplyMeriHermesRecordTurnEffectV1>): FrozenInput {
  if (!value || typeof value !== 'object' ||
      !isMeriHermesRecordTurnEffectIdentityV1(value.identity) ||
      (value.effectDisposition !== 'attempt' && value.effectDisposition !== 'effect_unknown') ||
      !(value.verificationKeys instanceof Map)) {
    throw new MeriHermesBrokerEffectInputError();
  }
  const request = Object.freeze({
    userChars: value.request?.userChars,
    assistantChars: value.request?.assistantChars,
  });
  let requestSha256: string;
  try {
    requestSha256 = meriHermesRecordTurnRequestSha256V1({
      tenantId: value.identity.tenantId,
      runId: value.identity.runId,
      workerRunId: value.identity.workerRunId,
      dispatchRequestSha256: value.identity.dispatchRequestSha256,
      scopeId: value.identity.scopeId,
      request,
    });
  } catch {
    throw new MeriHermesBrokerEffectInputError();
  }
  if (requestSha256 !== value.identity.requestSha256 ||
      Object.keys(value.request ?? {}).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(value.request, 'userChars') ||
      !Object.prototype.hasOwnProperty.call(value.request, 'assistantChars')) {
    throw new MeriHermesBrokerEffectInputError();
  }
  const identity = Object.freeze({ ...value.identity });
  const keys = new Map<string, Readonly<MeriHermesBrokerEffectReceiptKeyV1>>();
  try {
    for (const [mapKey, key] of value.verificationKeys) {
      if (typeof mapKey !== 'string' || mapKey !== key?.keyId || keys.has(mapKey)) {
        throw new Error('invalid key registry');
      }
      keys.set(mapKey, snapshotKey(key));
    }
  } catch {
    throw new MeriHermesBrokerEffectInputError();
  }
  return Object.freeze({
    identity,
    request,
    effectDisposition: value.effectDisposition,
    verificationKeys: keys,
  });
}

function freezeClarificationInput(
  value: Readonly<ApplyMeriHermesClarificationEffectV1>,
): FrozenClarificationInput {
  if (!value || typeof value !== 'object' ||
      !isMeriHermesClarificationEffectIdentityV1(value.identity) ||
      (value.effectDisposition !== 'attempt' && value.effectDisposition !== 'effect_unknown') ||
      !(value.verificationKeys instanceof Map)) {
    throw new MeriHermesBrokerEffectInputError();
  }
  let request: MeriHermesClarificationRequestV1;
  let requestSha256: string;
  try {
    request = normalizeMeriHermesClarificationRequestV1(value.request);
    requestSha256 = meriHermesClarificationRequestSha256V1({
      tenantId: value.identity.tenantId,
      runId: value.identity.runId,
      workerRunId: value.identity.workerRunId,
      dispatchRequestSha256: value.identity.dispatchRequestSha256,
      scopeId: value.identity.scopeId,
      request,
    });
  } catch {
    throw new MeriHermesBrokerEffectInputError();
  }
  if (requestSha256 !== value.identity.requestSha256) {
    throw new MeriHermesBrokerEffectInputError();
  }
  const identity = Object.freeze({ ...value.identity });
  const keys = new Map<string, Readonly<MeriHermesBrokerEffectReceiptKeyV1>>();
  try {
    for (const [mapKey, key] of value.verificationKeys) {
      if (typeof mapKey !== 'string' || mapKey !== key?.keyId || keys.has(mapKey)) {
        throw new Error('invalid key registry');
      }
      keys.set(mapKey, snapshotKey(key));
    }
  } catch {
    throw new MeriHermesBrokerEffectInputError();
  }
  return Object.freeze({
    identity,
    request,
    effectDisposition: value.effectDisposition,
    verificationKeys: keys,
  });
}

interface FrozenMemoryProposalInput {
  readonly identity: Readonly<MeriHermesMemoryProposalEffectIdentityV1>;
  readonly request: Readonly<MeriHermesMemoryProposalRequestV1>;
  readonly effectDisposition: 'attempt' | 'effect_unknown';
  readonly verificationKeys: ReadonlyMap<
    string,
    Readonly<MeriHermesBrokerEffectReceiptKeyV1>
  >;
}

function freezeMemoryProposalInput(
  value: Readonly<ApplyMeriHermesMemoryProposalEffectV1>,
): FrozenMemoryProposalInput {
  if (!value || typeof value !== 'object' ||
      !isMeriHermesMemoryProposalEffectIdentityV1(value.identity) ||
      (value.effectDisposition !== 'attempt' && value.effectDisposition !== 'effect_unknown') ||
      !(value.verificationKeys instanceof Map)) {
    throw new MeriHermesBrokerEffectInputError();
  }
  let request: MeriHermesMemoryProposalRequestV1;
  let requestSha256: string;
  try {
    request = normalizeMeriHermesMemoryProposalRequestV1(value.request);
    requestSha256 = meriHermesMemoryProposalRequestSha256V1({
      tenantId: value.identity.tenantId,
      runId: value.identity.runId,
      workerRunId: value.identity.workerRunId,
      dispatchRequestSha256: value.identity.dispatchRequestSha256,
      scopeId: value.identity.scopeId,
      request,
    });
  } catch {
    throw new MeriHermesBrokerEffectInputError();
  }
  if (requestSha256 !== value.identity.requestSha256) {
    throw new MeriHermesBrokerEffectInputError();
  }
  const identity = Object.freeze({ ...value.identity });
  const keys = new Map<string, Readonly<MeriHermesBrokerEffectReceiptKeyV1>>();
  try {
    for (const [mapKey, key] of value.verificationKeys) {
      if (typeof mapKey !== 'string' || mapKey !== key?.keyId || keys.has(mapKey)) {
        throw new Error('invalid key registry');
      }
      keys.set(mapKey, snapshotKey(key));
    }
  } catch {
    throw new MeriHermesBrokerEffectInputError();
  }
  return Object.freeze({
    identity,
    request,
    effectDisposition: value.effectDisposition,
    verificationKeys: keys,
  });
}

function unknown(): MeriHermesBrokerEffectResultV1 {
  return Object.freeze({ kind: 'effect_unknown' as const, receipt: null });
}

function unknownClarification(): MeriHermesClarificationEffectResultV1 {
  return Object.freeze({ kind: 'effect_unknown' as const, receipt: null });
}

function unknownMemoryProposal(): MeriHermesMemoryProposalEffectResultV1 {
  return Object.freeze({ kind: 'effect_unknown' as const, receipt: null });
}

export class MeriHermesBrokerEffectRepositoryV1 {
  readonly #database: MeriHermesBrokerEffectDatabaseV1;

  constructor(database: MeriHermesBrokerEffectDatabaseV1) {
    if (!database || typeof database.withBrokerEffectTransaction !== 'function') {
      throw new Error('Phase 4 broker-effect repository configuration is invalid');
    }
    this.#database = database;
  }

  async apply(
    value: Readonly<ApplyMeriHermesRecordTurnEffectV1>,
  ): Promise<MeriHermesBrokerEffectResultV1> {
    const input = freezeInput(value);
    try {
      return await this.#database.withBrokerEffectTransaction(async (tx) => {
        await tx.execute(SET_ROLE_SQL, []);
        const principals = await tx.query<PrincipalRow>(PRINCIPAL_SQL, []);
        if (!Array.isArray(principals) || principals.length !== 1 ||
            principals[0]?.current_user !== OPERATOR ||
            typeof principals[0]?.session_user !== 'string' ||
            principals[0].session_user === OPERATOR) {
          throw new MeriHermesBrokerEffectAuthorityError();
        }
        const rows = await tx.query<MeriHermesBrokerEffectReceiptRowV1>(
          RECORD_TURN_SQL,
          [
            input.identity.tenantId,
            input.identity.runId,
            input.identity.workerRunId,
            input.identity.dispatchRequestSha256,
            input.identity.scopeId,
            input.identity.operationId,
            input.identity.requestSha256,
            input.request.userChars,
            input.request.assistantChars,
            input.effectDisposition,
          ],
        );
        if (!Array.isArray(rows) || rows.length !== 1) return unknown();
        const receipt = parseMeriHermesBrokerEffectReceiptV1(
          rows[0], input.identity, input.verificationKeys,
        );
        return meriHermesBrokerEffectResultV1(receipt);
      });
    } catch (error) {
      if (error instanceof MeriHermesBrokerEffectAuthorityError) throw error;
      return unknown();
    }
  }

  async applyClarification(
    value: Readonly<ApplyMeriHermesClarificationEffectV1>,
  ): Promise<MeriHermesClarificationEffectResultV1> {
    const input = freezeClarificationInput(value);
    try {
      return await this.#database.withBrokerEffectTransaction(async (tx) => {
        await tx.execute(SET_ROLE_SQL, []);
        const principals = await tx.query<PrincipalRow>(PRINCIPAL_SQL, []);
        if (!Array.isArray(principals) || principals.length !== 1 ||
            principals[0]?.current_user !== OPERATOR ||
            typeof principals[0]?.session_user !== 'string' ||
            principals[0].session_user === OPERATOR) {
          throw new MeriHermesBrokerEffectAuthorityError();
        }
        const rows = await tx.query<MeriHermesBrokerEffectReceiptRowV1>(
          CLARIFICATION_SQL,
          [
            input.identity.tenantId,
            input.identity.runId,
            input.identity.workerRunId,
            input.identity.dispatchRequestSha256,
            input.identity.scopeId,
            input.identity.operationId,
            input.identity.requestSha256,
            input.request.question,
            JSON.stringify(input.request.choices),
            input.request.multiSelect,
            input.effectDisposition,
          ],
        );
        if (!Array.isArray(rows) || rows.length !== 1) return unknownClarification();
        const receipt = parseMeriHermesClarificationEffectReceiptV1(
          rows[0], input.identity, input.verificationKeys,
        );
        return meriHermesClarificationEffectResultV1(receipt);
      });
    } catch (error) {
      if (error instanceof MeriHermesBrokerEffectAuthorityError) throw error;
      return unknownClarification();
    }
  }

  async applyMemoryProposal(
    value: Readonly<ApplyMeriHermesMemoryProposalEffectV1>,
  ): Promise<MeriHermesMemoryProposalEffectResultV1> {
    const input = freezeMemoryProposalInput(value);
    try {
      return await this.#database.withBrokerEffectTransaction(async (tx) => {
        await tx.execute(SET_ROLE_SQL, []);
        const principals = await tx.query<PrincipalRow>(PRINCIPAL_SQL, []);
        if (!Array.isArray(principals) || principals.length !== 1 ||
            principals[0]?.current_user !== OPERATOR ||
            typeof principals[0]?.session_user !== 'string' ||
            principals[0].session_user === OPERATOR) {
          throw new MeriHermesBrokerEffectAuthorityError();
        }
        const rows = await tx.query<MeriHermesBrokerEffectReceiptRowV1>(
          MEMORY_PROPOSAL_SQL,
          [
            input.identity.tenantId,
            input.identity.runId,
            input.identity.workerRunId,
            input.identity.dispatchRequestSha256,
            input.identity.scopeId,
            input.identity.operationId,
            input.identity.requestSha256,
            input.request.key,
            input.request.value,
            input.request.scope,
            input.request.clientId,
            input.request.confidence,
            input.request.sourceExcerpt,
            input.effectDisposition,
          ],
        );
        if (!Array.isArray(rows) || rows.length !== 1) return unknownMemoryProposal();
        const receipt = parseMeriHermesMemoryProposalEffectReceiptV1(
          rows[0], input.identity, input.verificationKeys,
        );
        return meriHermesMemoryProposalEffectResultV1(receipt, input.request.scope);
      });
    } catch (error) {
      if (error instanceof MeriHermesBrokerEffectAuthorityError) throw error;
      return unknownMemoryProposal();
    }
  }
}
