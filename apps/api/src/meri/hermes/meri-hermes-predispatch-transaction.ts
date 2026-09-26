import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { TENANT_ROLES, type TenantContext } from '@capiro/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { MeriHermesAuthorizationEnvelope } from './hermes-runtime.contracts.js';
import { MeriHermesDbGovernor, meriHermesSharedDbGovernor } from './meri-hermes-db-governor.js';
import { MeriHermesDispatchIntentRepository } from './meri-hermes-dispatch-intent.repository.js';
import { MeriHermesExactDispatchRequestV2 } from './meri-hermes-exact-dispatch-request.js';
import { privateExecutionScopeId } from './meri-hermes-worker-token.js';
import type { MeriDispatchRequestMetadataV2 } from './meri-hermes-dispatch-intent.contract.js';
import {
  MERI_PHASE4_AUTHORIZATION_POLICY_VERSION,
  computeMeriPhase4AuthorizationVersionV2,
  meriPhase4GrantVersionV2,
} from './meri-hermes-phase4-authorization.contract.js';
import {
  isMeriDispatchRequestIdentityV2,
  matchesMeriDispatchReceivedRequestV2,
  meriDispatchCanonicalJsonSnapshot,
  meriDispatchSourceMessageSha256V2,
  type MeriDispatchRequestIdentityV2,
} from './meri-hermes-dispatch-intent.contract.js';
import {
  meriHermesScalingLimits,
  meriHermesTokensToMicroUsd,
  type MeriHermesScalingLimits,
} from './meri-hermes-scaling.config.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface LockedConversationRow {
  id: string;
  tenant_id: string;
  user_id: string;
  client_id: string | null;
  workspace_id: string | null;
  session_epoch_text: string | null;
  session_id: string | null;
}

interface ExistingRunRow {
  id: string;
  idempotency_key: string;
}

interface DbClockRow {
  db_now: Date;
  epoch_micros: bigint;
  period_date: Date | string;
}

/** Generated from current database authority after any scope-generation write. */
export interface MeriHermesPreDispatchAuthorityDecisionV2 {
  authorized: true;
  envelope: MeriHermesAuthorizationEnvelope;
  actorContext: TenantContext;
  metadata: MeriDispatchRequestMetadataV2;
  sessionId: string | null;
  sessionKey: string;
  /** Transient API keyring material; never persisted or returned to a caller. */
  sessionHeaderHmacKey: Uint8Array;
  /** Trusted policy-owned body extensions, including any signed tool view. */
  extraBody?: Readonly<Record<string, unknown>>;
}

export interface MeriHermesPreDispatchAuthorityContextV2 {
  intent: Readonly<MeriHermesPreDispatchIntentV2>;
  conversation: Readonly<LockedConversationRow>;
  userMessageId: string;
  priorIdentity: Readonly<MeriDispatchRequestIdentityV2> | null;
  /** Revision held under the exclusive tenant-fence lock. */
  fenceRevision: bigint;
}

/**
 * Required, no-default authority port. The implementation reads current
 * membership, grants, policy and operator-provisioned route under the exclusive
 * tenant fence. It may INSERT or UPDATE exactly one private execution scope to
 * synchronize its authorization generation, then must verify the final fence
 * revision. It cannot provision routes or trust caller authority material.
 */
export interface MeriHermesPreDispatchAuthorityV2 {
  deriveAndSyncScope(
    tx: Prisma.TransactionClient,
    context: Readonly<MeriHermesPreDispatchAuthorityContextV2>,
  ): Promise<MeriHermesPreDispatchAuthorityDecisionV2 | null>;
}

export interface MeriHermesPreDispatchMessageV2 {
  id: string;
  body: string;
  metadata?: Prisma.InputJsonValue;
}

export interface MeriHermesPreDispatchIntentV2 {
  tenantId: string;
  actorId: string;
  conversationId: string;
  runId: string;
  idempotencyKey: string;
  /** Exact body material is content, never an authorization claim. */
  body: Readonly<{
    input: string;
    instructions?: string;
    model?: string;
    provider?: string;
    modelOptions?: Record<string, unknown>;
  }>;
}

export interface MeriHermesPreDispatchPrepareInputV2 {
  /** Supplied only by the authenticated API entry point, never request JSON. */
  authenticatedPrincipal: Readonly<Pick<TenantContext, 'tenantId' | 'userId'>>;
  userMessage: Readonly<MeriHermesPreDispatchMessageV2>;
  intent: Readonly<MeriHermesPreDispatchIntentV2>;
  /** Required for an exact retry after an uncertain or committed preparation. */
  priorRequest?: MeriHermesExactDispatchRequestV2;
}

export type MeriHermesPreDispatchPrepareResultV2 =
  | { version: 2; kind: 'prepared'; runId: string; userMessageId: string;
      requestSha256: string; request: MeriHermesExactDispatchRequestV2;
      periodDate: string; launchAuthorized: false }
  | { version: 2; kind: 'status_only'; runId: string; requestSha256: string;
      launchAuthorized: false }
  | { version: 2; kind: 'rejected'; reason:
      'invalid_input' | 'conversation_mismatch' | 'conversation_occupied' |
      'budget_exhausted' | 'identity_conflict' | 'authority_denied' |
      'authority_contention' | 'request_expired' | 'session_mismatch';
      occupyingRunId?: string;
      launchAuthorized: false }
  | { version: 2; kind: 'UNKNOWN'; reason: 'commit_unconfirmed'; runId: string;
      requestSha256: string | null; request: MeriHermesExactDispatchRequestV2 | null;
      launchAuthorized: false };

interface ImmutablePrepareSnapshot {
  intent: Readonly<MeriHermesPreDispatchIntentV2>;
  priorRequest: MeriHermesExactDispatchRequestV2 | null;
  userMessage: Readonly<{ id: string; body: string; metadata: Prisma.InputJsonValue }>;
}

class RollbackPreDispatch extends Error {
  constructor(readonly result: MeriHermesPreDispatchPrepareResultV2) {
    super('roll back dormant Meri pre-dispatch preparation');
  }
}

/** Prisma raw-query errors commonly wrap PostgreSQL SQLSTATE in `meta.code`. */
export function isMeriHermesAuthorityContentionV2(error: unknown): boolean {
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > 4 || value === null || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    const row = value as Record<string, unknown>;
    if (row.code === '55P03' || row.sqlState === '55P03' || row.sqlstate === '55P03') return true;
    return ['meta', 'cause', 'originalError'].some((key) => visit(row[key], depth + 1));
  };
  return visit(error, 0);
}

function canonicalEpoch(text: string | null): number | null {
  if (text === null) return 0;
  if (!/^(0|[1-9][0-9]*)$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function deepFreezeJson<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}

/** Dormant atomic preparation boundary; it never performs network I/O. */
export class MeriHermesPreDispatchTransactionV2 {
  env: NodeJS.ProcessEnv = process.env;
  readonly governor: MeriHermesDbGovernor;
  readonly intents: MeriHermesDispatchIntentRepository;

  constructor(
    private readonly prisma: PrismaService,
    private readonly authority: MeriHermesPreDispatchAuthorityV2,
    governor?: MeriHermesDbGovernor,
    intents?: MeriHermesDispatchIntentRepository,
  ) {
    if (!authority || typeof authority.deriveAndSyncScope !== 'function') {
      throw new Error('Phase 4 pre-dispatch authority verifier is required');
    }
    this.governor = governor ?? meriHermesSharedDbGovernor();
    this.intents = intents ?? new MeriHermesDispatchIntentRepository(prisma);
  }

  async prepare(input: MeriHermesPreDispatchPrepareInputV2):
  Promise<MeriHermesPreDispatchPrepareResultV2> {
    // Synchronous and first: no caller-owned graph survives the first await.
    const snapshot = this.snapshotAtEntry(input);
    if (!snapshot) return this.rejected('invalid_input');
    const { intent, userMessage, priorRequest } = snapshot;
    const limits = Object.freeze({ ...meriHermesScalingLimits(this.env) });
    const estimateTokens = limits.maxRunTokens;
    const estimateMicroUsd = meriHermesTokensToMicroUsd(estimateTokens, limits.usdPerMillionTokens);
    let exactRequest: MeriHermesExactDispatchRequestV2 | null = priorRequest;

    try {
      return await this.governor.withTenantTx(
        this.prisma,
        'dispatch.prepare',
        intent.tenantId,
        async (tx): Promise<MeriHermesPreDispatchPrepareResultV2> => {
          // Every attempt using this stable run ID must observe the outcome of
          // its predecessor before deciding that the durable identity is absent.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${intent.runId}))`;
          // A durable retry is observed before any mutable authority read. A
          // retained capsule permits exact replay; a submission without one
          // can only learn status, never mint a replacement request.
          if (priorRequest) {
            const replay = await this.intents.resolveReplayInTransaction(tx, priorRequest.identity);
            if (replay.kind === 'status_only') {
              return { version: 2, kind: 'status_only', runId: intent.runId,
                requestSha256: priorRequest.identity.requestSha256, launchAuthorized: false };
            }
            if (replay.kind === 'rejected') throw new RollbackPreDispatch(this.rejected('identity_conflict'));
          }
          const candidates = await tx.$queryRaw<Array<{
            run_id: string; actor_id: string; client_id: string | null;
            conversation_id: string; user_message_id: string;
            idempotency_key: string; source_message_sha256: string; request_sha256: string;
          }>>(Prisma.sql`
            SELECT run_id, actor_id, client_id, conversation_id,
              user_message_id, idempotency_key, source_message_sha256, request_sha256
            FROM meri_agent_dispatch_intents
            WHERE tenant_id = ${intent.tenantId}::uuid AND (
              run_id = ${intent.runId}::uuid OR
              (scope_id = ${privateExecutionScopeId(intent.tenantId, intent.actorId)}
                AND idempotency_key = ${intent.idempotencyKey}) OR
              user_message_id = ${userMessage.id}::uuid
            ) FOR UPDATE
          `);
          if (candidates.length) {
            const row = candidates[0];
            if (candidates.length !== 1 || !row || row.run_id !== intent.runId ||
                row.actor_id !== intent.actorId ||
                row.conversation_id !== intent.conversationId ||
                row.user_message_id !== userMessage.id ||
                row.idempotency_key !== intent.idempotencyKey ||
                row.source_message_sha256 !== meriDispatchSourceMessageSha256V2({
                  tenantId: intent.tenantId, actorId: intent.actorId, clientId: row.client_id,
                  conversationId: intent.conversationId, userMessageId: userMessage.id,
                }, userMessage) ||
                (priorRequest && row.request_sha256 !== priorRequest.identity.requestSha256)) {
              throw new RollbackPreDispatch(this.rejected('identity_conflict'));
            }
            return { version: 2, kind: 'status_only', runId: intent.runId,
              requestSha256: row.request_sha256, launchAuthorized: false };
          }
          const fences = await tx.$queryRaw<Array<{ revision: bigint; policy_version: string }>>(Prisma.sql`
            SELECT revision, policy_version
            FROM meri_phase4_try_lock_authority_fence_exclusive(${intent.tenantId}::uuid)
          `);
          const fence = fences[0];
          if (fences.length !== 1 || !fence || typeof fence.revision !== 'bigint' ||
              fence.policy_version !== MERI_PHASE4_AUTHORIZATION_POLICY_VERSION) {
            return this.rejected('authority_denied');
          }
          const advisory = await tx.$queryRaw<Array<{ locked: boolean }>>(Prisma.sql`
            SELECT pg_try_advisory_xact_lock(hashtext(${intent.conversationId})) AS locked
          `);
          if (advisory[0]?.locked !== true) throw new RollbackPreDispatch(this.rejected('conversation_occupied'));

          const idempotent = await tx.$queryRaw<ExistingRunRow[]>(Prisma.sql`
            SELECT id, idempotency_key FROM meri_agent_runs
            WHERE tenant_id = ${intent.tenantId}::uuid
              AND scope_id = ${privateExecutionScopeId(intent.tenantId, intent.actorId)}
              AND idempotency_key = ${intent.idempotencyKey}
            FOR UPDATE
          `);
          if (idempotent[0]) throw new RollbackPreDispatch(this.rejected('identity_conflict'));
          if (estimateTokens > limits.tenantDailyTokens || estimateMicroUsd > limits.tenantDailyMicroUsd) {
            return this.rejected('budget_exhausted');
          }

          const conversations = await tx.$queryRaw<LockedConversationRow[]>(Prisma.sql`
            SELECT id, tenant_id, user_id, client_id, workspace_id,
                   metadata_jsonb #>> '{hermes,sessionEpoch}' AS session_epoch_text,
                   metadata_jsonb #>> '{hermes,sessionId}' AS session_id
            FROM clio_conversations
            WHERE tenant_id = ${intent.tenantId}::uuid
              AND id = ${intent.conversationId}::uuid
              AND archived_at IS NULL
            FOR UPDATE NOWAIT
          `);
          const conversation = conversations[0];
          if (!conversation || conversation.user_id !== intent.actorId ||
              canonicalEpoch(conversation.session_epoch_text) === null) {
            return this.rejected('conversation_mismatch');
          }

          const existing = await tx.$queryRaw<ExistingRunRow[]>(Prisma.sql`
            SELECT id, idempotency_key FROM meri_agent_runs
            WHERE tenant_id = ${intent.tenantId}::uuid
              AND conversation_id = ${intent.conversationId}::uuid
              AND status NOT IN ('completed', 'cancelled', 'failed', 'interrupted', 'expired')
            FOR UPDATE
          `);
          if (existing[0]) {
            return { version: 2, kind: 'rejected', reason: 'conversation_occupied',
              occupyingRunId: existing[0].id, launchAuthorized: false };
          }

          const returnedAuthority = await this.authority.deriveAndSyncScope(tx, {
            intent, conversation, userMessageId: userMessage.id,
            priorIdentity: priorRequest?.identity ?? null,
            fenceRevision: fence.revision,
          });
          // The authority may have written the scope. Every denial from here
          // must abort the transaction, including late budget/freshness checks.
          const authority = this.snapshotAuthority(returnedAuthority);
          if (!authority) throw new RollbackPreDispatch(this.rejected('authority_denied'));
          const { envelope, actorContext } = authority;
          const finalFence = await tx.$queryRaw<Array<{ revision: bigint; policy_version: string }>>(Prisma.sql`
            SELECT revision, policy_version
            FROM meri_phase4_try_lock_authority_fence_exclusive(${intent.tenantId}::uuid)
          `);
          if (finalFence.length !== 1 || !finalFence[0] ||
              (finalFence[0].revision !== fence.revision &&
               finalFence[0].revision !== fence.revision + 1n) ||
              finalFence[0].policy_version !== MERI_PHASE4_AUTHORIZATION_POLICY_VERSION ||
              authority.metadata.grantVersion !== meriPhase4GrantVersionV2(finalFence[0].revision)) {
            throw new RollbackPreDispatch(this.rejected('authority_denied'));
          }
          const finalScope = await tx.$queryRaw<Array<{
            tenant_id: string; principal_type: string; principal_id: string;
            kind: string; authorization_version: string;
          }>>(Prisma.sql`
            SELECT tenant_id, principal_type, principal_id, kind, authorization_version
            FROM meri_execution_scopes
            WHERE tenant_id = ${intent.tenantId}::uuid
              AND id = ${privateExecutionScopeId(intent.tenantId, intent.actorId)}
            FOR SHARE NOWAIT
          `);
          const scopeRow = finalScope[0];
          if (finalScope.length !== 1 || !scopeRow ||
              scopeRow.tenant_id !== intent.tenantId ||
              scopeRow.principal_type !== 'user' ||
              scopeRow.principal_id !== intent.actorId ||
              scopeRow.kind !== 'private' ||
              scopeRow.authorization_version !== authority.metadata.authorizationVersion) {
            throw new RollbackPreDispatch(this.rejected('authority_denied'));
          }
          const builtRequest = priorRequest ?? MeriHermesExactDispatchRequestV2.build({
            input: { ...intent.body, sessionId: authority.sessionId ?? undefined,
              sessionKey: authority.sessionKey, idempotencyKey: intent.idempotencyKey },
            metadata: authority.metadata, sourceMessage: userMessage,
            sessionHeaderHmacKey: authority.sessionHeaderHmacKey,
            extraBody: authority.extraBody,
          });
          exactRequest = builtRequest;
          const identity = builtRequest.identity;
          if (!this.matchesAuthoritativeDecision(identity, authority, intent, conversation,
            userMessage.id, builtRequest)) {
            throw new RollbackPreDispatch(this.rejected('authority_denied'));
          }

          // Take the sole clock sample after every contended lock and just
          // before the first durable admission write.
          const clocks = await tx.$queryRaw<DbClockRow[]>(Prisma.sql`
            WITH authoritative_clock AS MATERIALIZED (SELECT clock_timestamp() AS db_now)
            SELECT db_now,
                   floor(extract(epoch FROM db_now) * 1000000)::BIGINT AS epoch_micros,
                   (db_now AT TIME ZONE 'UTC')::date AS period_date
            FROM authoritative_clock
          `);
          const clock = clocks[0];
          if (!clock) throw new Error('database clock unavailable');
          if (!this.isFreshAtDbClock(identity, authority, clock.epoch_micros)) {
            throw new RollbackPreDispatch(this.rejected('request_expired'));
          }

          const period = await this.reserveBudgetInTransaction(
            tx, identity, limits, estimateTokens, estimateMicroUsd, clock,
          );
          if (!period) throw new RollbackPreDispatch(this.rejected('budget_exhausted'));
          await tx.clioMessage.create({ data: {
            id: userMessage.id, tenantId: identity.tenantId, userId: identity.actorId,
            clientId: identity.clientId, conversationId: identity.conversationId,
            role: 'user', body: userMessage.body, metadata: userMessage.metadata,
          } });
          await tx.meriAgentRun.create({ data: {
            id: identity.runId, tenantId: identity.tenantId, scopeId: identity.scopeId,
            actorId: identity.actorId, conversationId: identity.conversationId,
            userMessageId: userMessage.id, status: 'queued',
            idempotencyKey: identity.idempotencyKey,
            envelope: envelope as unknown as Prisma.InputJsonValue,
            actorContext: actorContext as unknown as Prisma.InputJsonValue, lastSeq: 1,
          } });
          await tx.meriAgentRunEvent.create({ data: {
            runId: identity.runId, seq: 1, kind: 'run.accepted', visibility: 'public',
            payload: { idempotencyKey: identity.idempotencyKey,
              executionScopeId: identity.scopeId,
              frames: [{ type: 'run_accepted', runId: identity.runId, status: 'queued', seq: 1 }],
            } as Prisma.InputJsonValue,
          } });
          const prepared = await this.intents.prepareInTransaction(tx, identity);
          if (prepared.kind !== 'inserted') {
            throw new RollbackPreDispatch(this.rejected('identity_conflict'));
          }
          return { version: 2, kind: 'prepared', runId: identity.runId,
            userMessageId: userMessage.id, requestSha256: identity.requestSha256,
            request: builtRequest, periodDate: period, launchAuthorized: false };
        },
      );
    } catch (error) {
      if (error instanceof RollbackPreDispatch) return error.result;
      if (isMeriHermesAuthorityContentionV2(error)) {
        return this.rejected('authority_contention');
      }
      return { version: 2, kind: 'UNKNOWN', reason: 'commit_unconfirmed',
        runId: intent.runId, requestSha256: exactRequest?.identity.requestSha256 ?? null,
        request: exactRequest, launchAuthorized: false };
    }
  }

  private snapshotAtEntry(input: MeriHermesPreDispatchPrepareInputV2): ImmutablePrepareSnapshot | null {
    try {
      const rawIntent = input?.intent;
      const message = input?.userMessage;
      const principal = input?.authenticatedPrincipal;
      if (!rawIntent || !message || !principal || !rawIntent.body ||
          principal.tenantId !== rawIntent.tenantId || principal.userId !== rawIntent.actorId ||
          ![rawIntent.tenantId, rawIntent.actorId, rawIntent.conversationId,
            rawIntent.runId, message.id].every((id) => typeof id === 'string' && UUID.test(id)) ||
          typeof rawIntent.idempotencyKey !== 'string' ||
          !/^[\x21-\x7e]{1,200}$/.test(rawIntent.idempotencyKey) ||
          typeof rawIntent.body.input !== 'string' || !rawIntent.body.input.length ||
          typeof message.body !== 'string' || !message.body.length) return null;
      const intent = deepFreezeJson(meriDispatchCanonicalJsonSnapshot(rawIntent));
      const metadata = meriDispatchCanonicalJsonSnapshot(
        message.metadata ?? ({ runtime: 'hermes' } as Prisma.InputJsonValue),
      ) as Prisma.InputJsonValue;
      const userMessage = deepFreezeJson({ id: String(message.id), body: message.body, metadata });
      const priorRequest = input.priorRequest ?? null;
      if (priorRequest !== null) {
        if (!(priorRequest instanceof MeriHermesExactDispatchRequestV2) ||
            !isMeriDispatchRequestIdentityV2(priorRequest.identity)) return null;
        const previous = priorRequest.identity;
        const bytes = priorRequest.copyExactBodyBytes();
        if (createHash('sha256').update(bytes).digest('hex') !== previous.bodySha256 ||
            bytes.length !== previous.bodyLengthBytes ||
            previous.tenantId !== intent.tenantId || previous.actorId !== intent.actorId ||
            previous.conversationId !== intent.conversationId || previous.runId !== intent.runId ||
            previous.userMessageId !== userMessage.id ||
            previous.idempotencyKey !== intent.idempotencyKey ||
            meriDispatchSourceMessageSha256V2(previous, userMessage) !== previous.sourceMessageSha256) return null;
      }
      return Object.freeze({ intent, priorRequest, userMessage });
    } catch {
      return null;
    }
  }

  private snapshotAuthority(authority: MeriHermesPreDispatchAuthorityDecisionV2 | null):
  Readonly<MeriHermesPreDispatchAuthorityDecisionV2> | null {
    if (!authority) return null;
    try {
      const { sessionHeaderHmacKey, ...publicMaterial } = authority;
      if (!(sessionHeaderHmacKey instanceof Uint8Array) || sessionHeaderHmacKey.length < 32) return null;
      const detached = deepFreezeJson(meriDispatchCanonicalJsonSnapshot(publicMaterial));
      return Object.freeze({ ...detached, sessionHeaderHmacKey: Uint8Array.from(sessionHeaderHmacKey) });
    } catch {
      return null;
    }
  }

  private matchesAuthoritativeDecision(
    identity: MeriDispatchRequestIdentityV2,
    authority: Readonly<MeriHermesPreDispatchAuthorityDecisionV2>,
    intent: Readonly<MeriHermesPreDispatchIntentV2>,
    conversation: Readonly<LockedConversationRow>,
    userMessageId: string,
    request: MeriHermesExactDispatchRequestV2,
  ): boolean {
    const { envelope, actorContext } = authority;
    const clients = envelope?.authorizedClientIds;
    const mailboxes = envelope?.authorizedMailboxConnectionIds;
    const toolPolicy = envelope?.toolPolicy;
    const validSet = (values: unknown): values is string[] => Array.isArray(values) &&
      values.every((value) => typeof value === 'string' && value.length > 0) &&
      new Set(values).size === values.length;
    const sorted = (values: string[]) => values.every((value, index) =>
      index === 0 || values[index - 1]! < value);
    const reserved = new Set(['input', 'session_id', 'instructions', 'model',
      'provider', 'model_options']);
    if (Object.keys(authority.extraBody ?? {}).some((key) =>
      !/^[a-z][a-z0-9_]*$/.test(key) || reserved.has(key))) return false;
    let expectedBody: Record<string, unknown>;
    let actualBody: unknown;
    try {
      expectedBody = { input: intent.body.input, ...(authority.extraBody ?? {}) };
      if (intent.body.instructions) expectedBody.instructions = intent.body.instructions;
      if (intent.body.model) expectedBody.model = intent.body.model;
      if (intent.body.provider) expectedBody.provider = intent.body.provider;
      if (intent.body.modelOptions) expectedBody.model_options = intent.body.modelOptions;
      if (authority.sessionId) expectedBody.session_id = authority.sessionId;
      actualBody = JSON.parse(Buffer.from(request.copyExactBodyBytes()).toString('utf8'));
    } catch { return false; }
    let expectedAuthorization: string;
    try {
      if (!validSet(clients) || !validSet(mailboxes) || !actorContext ||
          typeof actorContext.role !== 'string') return false;
      expectedAuthorization = computeMeriPhase4AuthorizationVersionV2({
        tenantId: identity.tenantId, actorId: identity.actorId,
        role: actorContext.role, policyVersion: identity.authorizationPolicyVersion,
        grantVersion: identity.grantVersion, authorizedClientIds: clients,
        authorizedMailboxConnectionIds: mailboxes,
      });
    } catch { return false; }
    return authority.authorized === true &&
      isDeepStrictEqual(actualBody, expectedBody) &&
      matchesMeriDispatchReceivedRequestV2(identity, request.copyExactBodyBytes(),
        request.sessionKeyHeaderValue, request.idempotencyKey,
        authority.sessionHeaderHmacKey) &&
      request.idempotencyKey === intent.idempotencyKey &&
      request.sessionId === authority.sessionId &&
      request.sessionKeyHeaderValue === authority.sessionKey &&
      authority.metadata.tenantId === intent.tenantId &&
      authority.metadata.version === 2 &&
      authority.metadata.actorType === 'user' &&
      authority.metadata.actorId === intent.actorId &&
      authority.metadata.meriAudience === 'private' &&
      authority.metadata.clientId === conversation.client_id &&
      authority.metadata.workspaceId === conversation.workspace_id &&
      authority.metadata.scopeId === privateExecutionScopeId(intent.tenantId, intent.actorId) &&
      authority.metadata.conversationId === intent.conversationId &&
      authority.metadata.userMessageId === userMessageId &&
      authority.metadata.runId === intent.runId &&
      authority.metadata.idempotencyKey === intent.idempotencyKey &&
      authority.metadata.authorizationVersion === identity.authorizationVersion &&
      identity.authorizationVersion === expectedAuthorization &&
      identity.tenantId === intent.tenantId && identity.actorId === intent.actorId &&
      identity.conversationId === intent.conversationId && identity.runId === intent.runId &&
      identity.userMessageId === userMessageId &&
      identity.idempotencyKey === intent.idempotencyKey &&
      identity.clientId === conversation.client_id &&
      identity.workspaceId === conversation.workspace_id &&
      identity.conversationEpoch === canonicalEpoch(conversation.session_epoch_text) &&
      authority.sessionId === (conversation.session_id || null) &&
      envelope?.version === 1 &&
      envelope.actorType === identity.actorType && envelope.audience === identity.meriAudience &&
      envelope.tenantId === identity.tenantId && envelope.actorId === identity.actorId &&
      envelope.conversationId === identity.conversationId && envelope.workspaceId === identity.workspaceId &&
      envelope.executionScopeId === identity.scopeId && envelope.runId === identity.runId &&
      envelope.authorizationVersion === identity.authorizationVersion &&
      typeof envelope.traceId === 'string' && envelope.traceId.length > 0 &&
      validSet(clients) && sorted(clients) && clients.every((id) => UUID.test(id)) &&
      (identity.clientId === null || clients.includes(identity.clientId)) &&
      validSet(mailboxes) && sorted(mailboxes) && toolPolicy !== null && typeof toolPolicy === 'object' &&
      !Array.isArray(toolPolicy) && validSet(toolPolicy.allow) && validSet(toolPolicy.deny) &&
      sorted(toolPolicy.allow) && sorted(toolPolicy.deny) &&
      typeof toolPolicy.readOnly === 'boolean' &&
      envelope.budget !== null && typeof envelope.budget === 'object' &&
      Number.isSafeInteger(envelope.budget.maxToolCalls) && envelope.budget.maxToolCalls >= 0 &&
      Number.isSafeInteger(envelope.budget.maxOutputTokens) && envelope.budget.maxOutputTokens >= 0 &&
      Number.isSafeInteger(envelope.budget.maxWallClockMs) && envelope.budget.maxWallClockMs >= 0 &&
      actorContext?.tenantId === identity.tenantId && actorContext.userId === identity.actorId &&
      typeof actorContext.tenantSlug === 'string' && actorContext.tenantSlug.length > 0 &&
      typeof actorContext.clerkUserId === 'string' && actorContext.clerkUserId.length > 0 &&
      TENANT_ROLES.includes(actorContext.role) &&
      authority.metadata.conversationEpoch === identity.conversationEpoch &&
      authority.metadata.authorizationPolicyVersion === identity.authorizationPolicyVersion &&
      authority.metadata.grantVersion === identity.grantVersion &&
      authority.metadata.workerAudience === identity.workerAudience &&
      authority.metadata.workerIngressId === identity.workerIngressId &&
      authority.metadata.workerGeneration === identity.workerGeneration &&
      authority.metadata.workerCredentialId === identity.workerCredentialId &&
      authority.metadata.catalogDigest === identity.catalogDigest &&
      authority.metadata.toolViewDigest === identity.toolViewDigest &&
      authority.metadata.sessionHeaderKeyId === identity.sessionHeaderKeyId &&
      authority.metadata.claimNotAfterEpochMicros === identity.claimNotAfterEpochMicros &&
      authority.metadata.deliveryNotAfterEpochMicros === identity.deliveryNotAfterEpochMicros &&
      authority.metadata.workerCredentialNotAfterEpochMicros === identity.workerCredentialNotAfterEpochMicros &&
      authority.metadata.reconciliationNotAfterEpochMicros === identity.reconciliationNotAfterEpochMicros &&
      authority.metadata.retainUntilEpochMicros === identity.retainUntilEpochMicros;
  }

  private isFreshAtDbClock(
    identity: MeriDispatchRequestIdentityV2,
    authority: Readonly<MeriHermesPreDispatchAuthorityDecisionV2>,
    dbNowEpochMicros: bigint,
  ): boolean {
    try {
      const issuedMs = Date.parse(authority.envelope.issuedAt);
      const expiresMs = Date.parse(authority.envelope.expiresAt);
      if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs)) return false;
      const issuedMicros = BigInt(Math.trunc(issuedMs)) * 1_000n;
      const expiresMicros = BigInt(Math.trunc(expiresMs)) * 1_000n;
      const claim = BigInt(identity.claimNotAfterEpochMicros);
      const delivery = BigInt(identity.deliveryNotAfterEpochMicros);
      const credential = BigInt(identity.workerCredentialNotAfterEpochMicros);
      return issuedMicros <= dbNowEpochMicros && dbNowEpochMicros < expiresMicros &&
        dbNowEpochMicros < claim && dbNowEpochMicros < delivery && dbNowEpochMicros < credential &&
        claim <= expiresMicros && delivery <= expiresMicros && delivery <= credential;
    } catch {
      return false;
    }
  }

  private rejected(reason: Extract<MeriHermesPreDispatchPrepareResultV2,
  { kind: 'rejected' }>['reason']):
  Extract<MeriHermesPreDispatchPrepareResultV2, { kind: 'rejected' }> {
    return { version: 2, kind: 'rejected', reason, launchAuthorized: false };
  }

  private async reserveBudgetInTransaction(
    tx: Prisma.TransactionClient,
    identity: MeriDispatchRequestIdentityV2,
    limits: MeriHermesScalingLimits,
    estimateTokens: number,
    estimateMicroUsd: number,
    clock: DbClockRow,
  ): Promise<string | null> {
    const periodDate = clock.period_date instanceof Date
      ? clock.period_date.toISOString().slice(0, 10)
      : String(clock.period_date).slice(0, 10);
    const committed = await tx.$queryRaw<Array<{ period_date: Date | string }>>(Prisma.sql`
      INSERT INTO meri_agent_budget_periods
        (tenant_id, period_date, committed_tokens, committed_micro_usd, admitted_runs)
      VALUES (${identity.tenantId}::uuid, ${periodDate}::date,
        ${estimateTokens}::bigint, ${estimateMicroUsd}::bigint, 1)
      ON CONFLICT (tenant_id, period_date) DO UPDATE
        SET committed_tokens = meri_agent_budget_periods.committed_tokens + EXCLUDED.committed_tokens,
            committed_micro_usd = meri_agent_budget_periods.committed_micro_usd + EXCLUDED.committed_micro_usd,
            admitted_runs = meri_agent_budget_periods.admitted_runs + 1,
            updated_at = ${clock.db_now}
        WHERE meri_agent_budget_periods.committed_tokens + EXCLUDED.committed_tokens
                <= ${limits.tenantDailyTokens}::bigint
          AND meri_agent_budget_periods.committed_micro_usd + EXCLUDED.committed_micro_usd
                <= ${limits.tenantDailyMicroUsd}::bigint
      RETURNING period_date
    `);
    if (!committed[0]?.period_date) {
      await tx.$executeRaw(Prisma.sql`
        UPDATE meri_agent_budget_periods
        SET refused_admissions = refused_admissions + 1, updated_at = ${clock.db_now}
        WHERE tenant_id = ${identity.tenantId}::uuid AND period_date = ${periodDate}::date
      `);
      return null;
    }
    const inserted = await tx.$queryRaw<Array<{ run_id: string }>>(Prisma.sql`
      INSERT INTO meri_agent_run_reservations
        (run_id, tenant_id, scope_id, conversation_id, period_date, max_run_tokens,
         estimated_tokens, estimated_micro_usd)
      VALUES (${identity.runId}::uuid, ${identity.tenantId}::uuid, ${identity.scopeId},
        ${identity.conversationId}::uuid, ${periodDate}::date, ${limits.maxRunTokens},
        ${estimateTokens}, ${estimateMicroUsd}::bigint)
      ON CONFLICT (run_id) DO NOTHING RETURNING run_id
    `);
    if (inserted.length !== 1) throw new RollbackPreDispatch(this.rejected('identity_conflict'));
    return periodDate;
  }
}
