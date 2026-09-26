import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  isMeriDispatchIntentStateV2,
  isMeriDispatchRequestIdentityV2,
  meriDispatchSourceMessageSha256V2,
  type MeriDispatchIntentObservationV2,
  type MeriDispatchIntentStateV2,
  type MeriDispatchRequestIdentityV2,
} from './meri-hermes-dispatch-intent.contract.js';

/**
 * Dormant Phase 4 persistence boundary. This repository is deliberately not a
 * Nest provider and is not imported by the adapter, controller, runtime client,
 * or worker overlay. Its transitions are persistence facts only: even a newly
 * `claimed` row is not, by itself, permission to launch or perform an effect.
 *
 * The eventual admission writer MUST call `prepareInTransaction` with the same
 * tenant-scoped transaction that inserts the user message and API run. A caller
 * that loses the outer commit response must report `commit_unconfirmed`; it may
 * only observe status and must never reconstruct/resend the request.
 */

const SHA256 = /^[0-9a-f]{64}$/;

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
  conversation_epoch: bigint;
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
  claim_not_after_epoch_micros: bigint;
  delivery_not_after_epoch_micros: bigint;
  worker_credential_not_after_epoch_micros: bigint;
  reconciliation_not_after_epoch_micros: bigint;
  retain_until_epoch_micros: bigint;
  source_message_sha256: string;
  body_length_bytes: bigint;
  body_sha256: string;
  request_assembly_sha256: string;
  session_header_hmac_sha256: string;
  request_sha256: string;
  state: string;
  worker_run_id: string | null;
  claimed_at_epoch_micros: bigint | null;
  sealed_absent_at_epoch_micros: bigint | null;
  absence_proof_sha256: string | null;
  tombstoned_at_epoch_micros: bigint | null;
  operation_namespace: string | null;
}

interface LockedSourceRow {
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
  stop_requested_at: Date | null;
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

export interface MeriDispatchLockedContextV2 {
  identity: Readonly<MeriDispatchRequestIdentityV2>;
  runStatus: string;
  dispatchStatus: string;
  stopRequestedAt: Date | null;
  scopeAuthorizationVersion: string;
}

/** Immutable durable identity only; never grants access to source or status. */
export interface MeriDispatchClaimAuthenticationContextV2 {
  readonly identity: Readonly<MeriDispatchRequestIdentityV2>;
}

/** The verified bearer's exclusive deadline is enforced again at both writes. */
export type MeriDispatchClaimAuthenticationDecisionV2 =
  | false
  | { readonly authenticated: true; readonly notAfterEpochMicros: string };

export type AuthenticateMeriDispatchClaimV2 = (
  tx: Prisma.TransactionClient,
  context: Readonly<MeriDispatchClaimAuthenticationContextV2>,
) => Promise<MeriDispatchClaimAuthenticationDecisionV2>;

/**
 * Runs inside the same transaction after the source and intent rows are locked.
 * A future private gate must use this callback to lock/check the authoritative
 * grant/revocation fence, worker credential/generation, route closure, Stop,
 * and exact received request material. `true` is still not a launch grant;
 * only the repository's committed transition can become an admission fact.
 */
export type VerifyMeriDispatchTransitionV2 = (
  tx: Prisma.TransactionClient,
  context: Readonly<MeriDispatchLockedContextV2>,
) => Promise<boolean>;

type KnownObservation = Extract<MeriDispatchIntentObservationV2, { kind: 'known' }>;

export type MeriDispatchPrepareResultV2 =
  | { kind: 'inserted'; observation: KnownObservation }
  | { kind: 'status_only'; observation: KnownObservation }
  | { kind: 'rejected'; reason: 'invalid_identity' | 'source_mismatch' | 'identity_conflict' };

export type MeriDispatchReplayResolutionV2 =
  | { kind: 'missing' }
  | { kind: 'status_only'; observation: KnownObservation }
  | { kind: 'rejected'; reason: 'invalid_identity' | 'identity_conflict' };

export type MeriDispatchTransitionResultV2 =
  | { kind: 'transitioned'; observation: KnownObservation;
      operationNamespace: string }
  | { kind: 'status_only'; observation: KnownObservation }
  | { kind: 'rejected'; reason:
      'invalid_request' | 'source_mismatch' | 'identity_conflict' |
      'different_worker_run_id' | 'different_absence_proof' |
      'state_closed' | 'verification_denied' }
  | Extract<MeriDispatchIntentObservationV2, { kind: 'UNKNOWN' }>;

export interface MeriDispatchClaimInputV2 {
  tenantId: string;
  runId: string;
  requestSha256: string;
  workerRunId: string;
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
    claimNotAfterEpochMicros: row.claim_not_after_epoch_micros.toString(),
    deliveryNotAfterEpochMicros: row.delivery_not_after_epoch_micros.toString(),
    workerCredentialNotAfterEpochMicros: row.worker_credential_not_after_epoch_micros.toString(),
    reconciliationNotAfterEpochMicros: row.reconciliation_not_after_epoch_micros.toString(),
    retainUntilEpochMicros: row.retain_until_epoch_micros.toString(),
    sourceMessageSha256: row.source_message_sha256,
    bodyLengthBytes: Number(row.body_length_bytes),
    bodySha256: row.body_sha256,
    requestAssemblySha256: row.request_assembly_sha256,
    sessionHeaderHmacSha256: row.session_header_hmac_sha256,
    requestSha256: row.request_sha256,
  };
  return isMeriDispatchRequestIdentityV2(identity) ? identity : null;
}

function stateFromRow(row: IntentRow): MeriDispatchIntentStateV2 | null {
  const state = {
    version: 2,
    state: row.state,
    workerRunId: row.worker_run_id,
    claimedAtEpochMicros: row.claimed_at_epoch_micros?.toString() ?? null,
    sealedAbsentAtEpochMicros: row.sealed_absent_at_epoch_micros?.toString() ?? null,
    absenceProofSha256: row.absence_proof_sha256,
  };
  return isMeriDispatchIntentStateV2(state) ? state : null;
}

function known(row: IntentRow): KnownObservation {
  const intent = stateFromRow(row);
  if (!intent || !identityFromRow(row)) throw new Error('corrupt Meri dispatch intent row');
  return { version: 2, kind: 'known', intent };
}

function exactIdentity(row: IntentRow, expected: MeriDispatchRequestIdentityV2): boolean {
  const actual = identityFromRow(row);
  if (!actual) return false;
  return (Object.keys(actual) as Array<keyof MeriDispatchRequestIdentityV2>)
    .every((key) => actual[key] === expected[key]);
}

function canonicalConversationEpoch(text: string | null): number | null {
  if (text === null) return 0;
  if (!/^(0|[1-9][0-9]*)$/.test(text)) return null;
  const epoch = Number(text);
  return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : null;
}

function sourceMatchesIdentity(
  source: LockedSourceRow,
  identity: MeriDispatchRequestIdentityV2,
  mode: 'prepare' | 'claim' | 'absence',
): boolean {
  const epoch = canonicalConversationEpoch(source.conversation_epoch_text);
  return source.run_id === identity.runId &&
    source.tenant_id === identity.tenantId &&
    source.scope_id === identity.scopeId &&
    source.actor_id === identity.actorId &&
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
    epoch === identity.conversationEpoch &&
    source.message_tenant_id === identity.tenantId &&
    source.message_user_id === identity.actorId &&
    source.message_client_id === identity.clientId &&
    source.message_conversation_id === identity.conversationId &&
    source.message_role === 'user' &&
    meriDispatchSourceMessageSha256V2(identity, {
      body: source.message_body,
      metadata: source.message_metadata_jsonb,
    }) === identity.sourceMessageSha256 &&
    source.existing_worker_run_id === null &&
    source.dispatch_status === 'pending' &&
    (mode === 'prepare'
      ? source.stop_requested_at === null && source.run_status === 'queued'
      : mode === 'claim'
        ? source.stop_requested_at === null &&
          (source.run_status === 'queued' || source.run_status === 'provisioning')
        : (source.run_status === 'queued' || source.run_status === 'provisioning' ||
          source.run_status === 'cancelling'));
}

export class MeriHermesDispatchIntentRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Exact durable replay lookup that does not consult mutable conversation,
   * session, membership, grant, or credential state. It grants no launch: an
   * exact tombstone is status-only even after its source rows are archived or
   * deleted, while any colliding identity is rejected.
   */
  async resolveReplayInTransaction(
    tx: Prisma.TransactionClient,
    identity: MeriDispatchRequestIdentityV2,
  ): Promise<MeriDispatchReplayResolutionV2> {
    if (!isMeriDispatchRequestIdentityV2(identity)) {
      return { kind: 'rejected', reason: 'invalid_identity' };
    }
    const candidates = await this.lockIdentityCandidates(tx, identity);
    if (candidates.length === 0) return { kind: 'missing' };
    if (candidates.length !== 1 || !exactIdentity(candidates[0]!, identity)) {
      return { kind: 'rejected', reason: 'identity_conflict' };
    }
    return { kind: 'status_only', observation: known(candidates[0]!) };
  }

  /**
   * Must be called inside the caller's existing tenant-scoped transaction.
   * This method neither opens nor commits a transaction, making it possible to
   * persist message + run + prepared intent atomically before any POST.
   */
  async prepareInTransaction(
    tx: Prisma.TransactionClient,
    identity: MeriDispatchRequestIdentityV2,
  ): Promise<MeriDispatchPrepareResultV2> {
    if (!isMeriDispatchRequestIdentityV2(identity)) {
      return { kind: 'rejected', reason: 'invalid_identity' };
    }
    const source = await this.lockSource(tx, identity.tenantId, identity.runId, identity.userMessageId);
    if (!source || !sourceMatchesIdentity(source, identity, 'prepare')) {
      const replay = await this.lockIdentityCandidates(tx, identity);
      if (replay.length === 1 && exactIdentity(replay[0]!, identity)) {
        return { kind: 'status_only', observation: known(replay[0]!) };
      }
      return { kind: 'rejected', reason: 'source_mismatch' };
    }

    const inserted = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
      INSERT INTO meri_agent_dispatch_intents (
        run_id, tenant_id, identity_version, actor_type, actor_id,
        meri_audience, client_id, workspace_id, scope_id, conversation_id,
        user_message_id, idempotency_key, conversation_epoch, worker_audience,
        worker_ingress_id, worker_generation, worker_credential_id,
        authorization_version, authorization_policy_version, grant_version,
        catalog_digest, tool_view_digest, session_header_key_id,
        claim_not_after_epoch_micros, delivery_not_after_epoch_micros,
        worker_credential_not_after_epoch_micros,
        reconciliation_not_after_epoch_micros, retain_until_epoch_micros,
        source_message_sha256, body_length_bytes, body_sha256,
        request_assembly_sha256, session_header_hmac_sha256,
        request_sha256
      ) VALUES (
        ${identity.runId}::uuid, ${identity.tenantId}::uuid, ${identity.version},
        ${identity.actorType}, ${identity.actorId}::uuid, ${identity.meriAudience},
        ${identity.clientId}::uuid, ${identity.workspaceId}::uuid, ${identity.scopeId},
        ${identity.conversationId}::uuid, ${identity.userMessageId}::uuid,
        ${identity.idempotencyKey}, ${BigInt(identity.conversationEpoch)},
        ${identity.workerAudience}, ${identity.workerIngressId},
        ${identity.workerGeneration}, ${identity.workerCredentialId},
        ${identity.authorizationVersion}, ${identity.authorizationPolicyVersion},
        ${identity.grantVersion}, ${identity.catalogDigest}, ${identity.toolViewDigest},
        ${identity.sessionHeaderKeyId}, ${BigInt(identity.claimNotAfterEpochMicros)},
        ${BigInt(identity.deliveryNotAfterEpochMicros)},
        ${BigInt(identity.workerCredentialNotAfterEpochMicros)},
        ${BigInt(identity.reconciliationNotAfterEpochMicros)},
        ${BigInt(identity.retainUntilEpochMicros)}, ${identity.sourceMessageSha256},
        ${BigInt(identity.bodyLengthBytes)}, ${identity.bodySha256},
        ${identity.requestAssemblySha256}, ${identity.sessionHeaderHmacSha256}, ${identity.requestSha256}
      ) ON CONFLICT DO NOTHING
      RETURNING *
    `);
    if (inserted.length === 1) {
      return { kind: 'inserted', observation: known(inserted[0]!) };
    }

    const existing = await this.lockIdentityCandidates(tx, identity);
    if (existing.length !== 1 || !exactIdentity(existing[0]!, identity)) {
      return { kind: 'rejected', reason: 'identity_conflict' };
    }
    return { kind: 'status_only', observation: known(existing[0]!) };
  }

  async observe(tenantId: string, runId: string): Promise<MeriDispatchIntentObservationV2> {
    try {
      return await this.prisma.withTenant(tenantId, async (tx): Promise<MeriDispatchIntentObservationV2> => {
        const rows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
          SELECT * FROM meri_agent_dispatch_intents
          WHERE tenant_id = ${tenantId}::uuid AND run_id = ${runId}::uuid
        `);
        if (rows.length !== 1) return { version: 2, kind: 'UNKNOWN', reason: 'absence_unproven' };
        return known(rows[0]!);
      });
    } catch {
      return { version: 2, kind: 'UNKNOWN', reason: 'read_unavailable' };
    }
  }

  async claim(
    input: MeriDispatchClaimInputV2,
    authenticate: AuthenticateMeriDispatchClaimV2,
    verifyTransition: VerifyMeriDispatchTransitionV2,
  ): Promise<MeriDispatchTransitionResultV2> {
    if (!SHA256.test(input.requestSha256) || input.workerRunId.length === 0 ||
        input.workerRunId.trim() !== input.workerRunId || input.workerRunId.length > 120 ||
        /[\u0000-\u001f\u007f]/.test(input.workerRunId)) {
      return { kind: 'rejected', reason: 'invalid_request' };
    }
    try {
      return await this.prisma.withTenant(input.tenantId, async (tx): Promise<MeriDispatchTransitionResultV2> => {
        // All authority writers touch this tenant row in their own transaction.
        // Acquire it before source-row locks so an absent grant/route is fenced.
        const fence = await tx.$queryRaw<Array<{ revision: bigint }>>(Prisma.sql`
          SELECT revision FROM meri_phase4_lock_authority_fence(${input.tenantId}::uuid)
        `);
        if (fence.length !== 1 || typeof fence[0]?.revision !== 'bigint') {
          return { kind: 'rejected', reason: 'verification_denied' };
        }
        const source = await this.lockSource(tx, input.tenantId, input.runId, null);
        const rows = await this.lockIntent(tx, input.tenantId, input.runId);
        if (rows.length !== 1) return { kind: 'rejected', reason: 'identity_conflict' };
        const row = rows[0]!;
        const identity = identityFromRow(row);
        if (!identity) {
          return { kind: 'rejected', reason: 'identity_conflict' };
        }
        const immutableIdentity = Object.freeze(identity);
        // Authentication is mandatory even for a claimed/status-only row. Its
        // callback samples the DB clock after both locks and sees no source data.
        const authenticated = await authenticate(tx, Object.freeze({ identity: immutableIdentity }));
        if (authenticated === false || authenticated?.authenticated !== true ||
            Object.keys(authenticated).length !== 2 ||
            !/^[1-9][0-9]{0,18}$/.test(authenticated.notAfterEpochMicros) ||
            BigInt(authenticated.notAfterEpochMicros) > 9_223_372_036_854_775_807n ||
            BigInt(authenticated.notAfterEpochMicros) > BigInt(identity.claimNotAfterEpochMicros)) {
          return { kind: 'rejected', reason: 'verification_denied' };
        }
        const active = await tx.$queryRaw<Array<{ bearer_active: boolean }>>(Prisma.sql`
          SELECT floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint
            < ${BigInt(authenticated.notAfterEpochMicros)}::bigint AS bearer_active
        `);
        if (active.length !== 1 || active[0]?.bearer_active !== true) {
          return { kind: 'rejected', reason: 'verification_denied' };
        }
        if (identity.requestSha256 !== input.requestSha256) {
          return { kind: 'rejected', reason: 'identity_conflict' };
        }
        if (row.state === 'claimed') {
          if (row.worker_run_id !== input.workerRunId) {
            return { kind: 'rejected', reason: 'different_worker_run_id' };
          }
          if (source && source.existing_worker_run_id !== input.workerRunId) {
            return { kind: 'rejected', reason: 'identity_conflict' };
          }
          return { kind: 'status_only', observation: known(row) };
        }
        if (row.state !== 'prepared') return { kind: 'rejected', reason: 'state_closed' };
        if (!source || !sourceMatchesIdentity(source, identity, 'claim')) {
          return { kind: 'rejected', reason: 'source_mismatch' };
        }
        if ((await verifyTransition(tx, this.lockedContext(immutableIdentity, source))) !== true) {
          return { kind: 'rejected', reason: 'verification_denied' };
        }
        const boundRun = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE meri_agent_runs
          SET hermes_run_id = ${input.workerRunId}
          WHERE tenant_id = ${input.tenantId}::uuid
            AND id = ${input.runId}::uuid
            AND hermes_run_id IS NULL
            AND dispatch_status = 'pending'
            AND stop_requested_at IS NULL
            AND status IN ('queued', 'provisioning')
            AND floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint
              < ${BigInt(authenticated.notAfterEpochMicros)}::bigint
          RETURNING id
        `);
        if (boundRun.length !== 1) throw new Error('dispatch run binding conditional write lost');
        const transitioned = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
          UPDATE meri_agent_dispatch_intents
          SET state = 'claimed', worker_run_id = ${input.workerRunId},
            operation_namespace = gen_random_uuid()
          WHERE tenant_id = ${input.tenantId}::uuid
            AND run_id = ${input.runId}::uuid
            AND request_sha256 = ${input.requestSha256}
            AND state = 'prepared'
            AND floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint
              < ${BigInt(authenticated.notAfterEpochMicros)}::bigint
            AND floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint
              < ${BigInt(identity.deliveryNotAfterEpochMicros)}::bigint
            AND EXISTS (
              SELECT 1 FROM meri_agent_runs current_run
              WHERE current_run.tenant_id = ${input.tenantId}::uuid
                AND current_run.id = ${input.runId}::uuid
                AND clock_timestamp() <
                  (current_run.envelope_jsonb->>'expiresAt')::timestamptz
            )
            AND EXISTS (
              SELECT 1 FROM meri_phase4_worker_routes route
              WHERE route.tenant_id = ${input.tenantId}::uuid
                AND route.scope_id = ${identity.scopeId}
                AND route.worker_audience = ${identity.workerAudience}
                AND route.worker_ingress_id = ${identity.workerIngressId}
                AND route.worker_generation = ${identity.workerGeneration}
                AND route.worker_credential_id = ${identity.workerCredentialId}
                AND route.enabled = true AND route.closed_at_epoch_micros IS NULL
                AND route.not_before_epoch_micros <=
                  floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint
                AND floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint
                  < route.not_after_epoch_micros
            )
          RETURNING *
        `);
        if (transitioned.length !== 1) throw new Error('dispatch claim conditional write lost');
        const claimedRow = transitioned[0]!;
        if (!claimedRow.operation_namespace) {
          throw new Error('dispatch claim did not generate operation namespace');
        }
        return {
          kind: 'transitioned',
          observation: known(claimedRow),
          operationNamespace: claimedRow.operation_namespace,
        };
      });
    } catch {
      return { version: 2, kind: 'UNKNOWN', reason: 'commit_unconfirmed' };
    }
  }

  private lockedContext(
    identity: MeriDispatchRequestIdentityV2,
    source: LockedSourceRow,
  ): MeriDispatchLockedContextV2 {
    return {
      identity,
      runStatus: source.run_status,
      dispatchStatus: source.dispatch_status,
      stopRequestedAt: source.stop_requested_at,
      scopeAuthorizationVersion: source.scope_authorization_version,
    };
  }

  private lockIntent(
    tx: Prisma.TransactionClient,
    tenantId: string,
    runId: string,
  ): Promise<IntentRow[]> {
    return tx.$queryRaw<IntentRow[]>(Prisma.sql`
      SELECT * FROM meri_agent_dispatch_intents
      WHERE tenant_id = ${tenantId}::uuid AND run_id = ${runId}::uuid
      FOR UPDATE
    `);
  }

  private lockIdentityCandidates(
    tx: Prisma.TransactionClient,
    identity: MeriDispatchRequestIdentityV2,
  ): Promise<IntentRow[]> {
    return tx.$queryRaw<IntentRow[]>(Prisma.sql`
      SELECT * FROM meri_agent_dispatch_intents
      WHERE tenant_id = ${identity.tenantId}::uuid AND (
        run_id = ${identity.runId}::uuid OR
        (scope_id = ${identity.scopeId} AND idempotency_key = ${identity.idempotencyKey}) OR
        user_message_id = ${identity.userMessageId}::uuid
      )
      FOR UPDATE
    `);
  }

  private async lockSource(
    tx: Prisma.TransactionClient,
    tenantId: string,
    runId: string,
    userMessageId: string | null,
  ): Promise<LockedSourceRow | null> {
    const rows = await tx.$queryRaw<LockedSourceRow[]>(Prisma.sql`
      SELECT
        r.id AS run_id, r.tenant_id, r.scope_id, r.actor_id,
        r.conversation_id, r.user_message_id, r.idempotency_key,
        r.status AS run_status, r.dispatch_status,
        r.hermes_run_id AS existing_worker_run_id, r.stop_requested_at,
        r.envelope_jsonb->>'authorizationVersion' AS envelope_authorization_version,
        s.principal_type AS scope_principal_type,
        s.principal_id AS scope_principal_id,
        s.kind AS scope_kind,
        s.authorization_version AS scope_authorization_version,
        c.user_id AS conversation_user_id,
        c.client_id AS conversation_client_id,
        c.workspace_id AS conversation_workspace_id,
        c.metadata_jsonb #>> '{hermes,sessionEpoch}' AS conversation_epoch_text,
        m.tenant_id AS message_tenant_id,
        m.user_id AS message_user_id,
        m.client_id AS message_client_id,
        m.conversation_id AS message_conversation_id,
        m.role AS message_role,
        m.body AS message_body,
        m.metadata_jsonb AS message_metadata_jsonb
      FROM meri_agent_runs r
      JOIN meri_execution_scopes s
        ON s.id = r.scope_id AND s.tenant_id = r.tenant_id
      JOIN clio_conversations c
        ON c.id = r.conversation_id AND c.tenant_id = r.tenant_id
      JOIN clio_messages m
        ON m.id = r.user_message_id AND m.tenant_id = r.tenant_id
      WHERE r.tenant_id = ${tenantId}::uuid
        AND r.id = ${runId}::uuid
        AND (${userMessageId}::uuid IS NULL OR m.id = ${userMessageId}::uuid)
      FOR UPDATE OF r, s, c, m
    `);
    return rows.length === 1 ? rows[0]! : null;
  }
}
