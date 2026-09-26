import { randomUUID } from 'node:crypto';
import { TENANT_ROLES, type TenantContext, type TenantRole } from '@capiro/shared';
import { Prisma } from '@prisma/client';
import { privateExecutionScopeId } from './meri-hermes-worker-token.js';
import {
  MERI_DISPATCH_RECOVERY_MARGIN_MICROS_V2,
  MERI_DISPATCH_RETENTION_MARGIN_MICROS_V2,
  meriDispatchCanonicalJsonSnapshot,
  meriDispatchExpectedPrivateSessionKeyV2,
  type MeriDispatchRequestMetadataV2,
} from './meri-hermes-dispatch-intent.contract.js';
import {
  MERI_PHASE4_AUTHORIZATION_POLICY_VERSION,
  computeMeriPhase4AuthorizationVersionV2,
  meriPhase4GrantVersionV2,
} from './meri-hermes-phase4-authorization.contract.js';
import type { MeriHermesToolPolicy } from './hermes-runtime.contracts.js';
import { brokerPolicySubsetForToolView } from './meri-hermes-broker-policy-subset.js';
import {
  isCompiledMeriHermesToolViewV1,
  MERI_HERMES_APPLIED_TOOL_VIEW_DIGEST_ALGORITHM_V1,
  MERI_HERMES_WORKER_CATALOG_DIGEST_ALGORITHM_V1,
  type MeriHermesToolViewV1,
} from './meri-hermes-tool-view.js';
import {
  MERI_PHASE4_CLAIM_ATTESTATION_PROTOCOL_V1,
  MERI_PHASE4_TOOL_VIEW_PROTOCOL_V1,
} from './meri-phase4-route-operator.contract.js';
import type {
  MeriHermesPreDispatchAuthorityContextV2,
  MeriHermesPreDispatchAuthorityDecisionV2,
  MeriHermesPreDispatchAuthorityV2,
  MeriHermesPreDispatchIntentV2,
} from './meri-hermes-predispatch-transaction.js';

interface ActorRow { role: string; tenant_slug: string; clerk_user_id: string }
interface IdRow { id: string }
interface ScopeRow {
  tenant_id: string; principal_type: string; principal_id: string;
  kind: string; authorization_version: string;
}
interface RouteRow {
  binding_id: string; enabled: boolean;
  closed_at_epoch_micros: bigint | null;
  not_before_epoch_micros: bigint; not_after_epoch_micros: bigint;
}
interface BindingV2Row {
  active: boolean; not_before_epoch_micros: bigint; not_after_epoch_micros: bigint;
  worker_image_digest: string; worker_build_id: string;
  worker_catalog_digest_algorithm: string; worker_catalog_digest: string;
  applied_tool_view_digest_algorithm: string;
  meri_catalog_version: string; meri_catalog_digest: string;
  capability_mapping_version: string; capability_mapping_digest: string;
  tool_view_protocol: string; claim_attestation_protocol: string;
  attestation_credential_id: string;
}

export interface MeriHermesPreDispatchBodyPolicyV2 {
  /** Trusted immutable compiler output; it owns both persisted digest meanings. */
  toolView: MeriHermesToolViewV1;
  /** Already signed by trusted API policy code when a request-local view exists. */
  extraBody?: Readonly<Record<string, unknown>>;
}

/** API-owned, pinned configuration; never populated from an HTTP request. */
export interface MeriHermesPreDispatchPinnedPolicyV2 {
  workerAudience: string;
  workerIngressId: string;
  workerGeneration: string;
  workerCredentialId: string;
  workerImageDigest: string;
  workerBuildId: string;
  catalogDigest: string;
  meriCatalogVersion: string;
  meriCatalogDigest: string;
  capabilityMappingVersion: string;
  capabilityMappingDigest: string;
  sessionHeaderKeyId: string;
  sessionHeaderHmacKey: Uint8Array;
  maxToolCalls: number;
  maxOutputTokens: number;
  maxWallClockMs: number;
  /** Pure local policy function. It must not perform I/O or consult caller authority. */
  bodyPolicy(intent: Readonly<MeriHermesPreDispatchIntentV2>): MeriHermesPreDispatchBodyPolicyV2;
}

const SHA256 = /^[0-9a-f]{64}$/;
const MICROS_PER_MS = 1_000n;
const CLAIM_TTL_MICROS = 60_000_000n;
const DELIVERY_TTL_MICROS = 300_000_000n;
const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;

export function canonicalMeriHermesToolPolicyV2(policy: MeriHermesToolPolicy): MeriHermesToolPolicy {
  if (!policy || !Array.isArray(policy.allow) || !Array.isArray(policy.deny) ||
      typeof policy.readOnly !== 'boolean' ||
      [...policy.allow, ...policy.deny].some((name) =>
        typeof name !== 'string' || !name.length || name.trim() !== name ||
        /[\u0000-\u001f\u007f]/.test(name))) {
    throw new Error('invalid Phase 4 broker tool policy');
  }
  return {
    allow: [...new Set(policy.allow)].sort(),
    deny: [...new Set(policy.deny)].sort(),
    readOnly: policy.readOnly,
  };
}

function epoch(text: string | null): number | null {
  if (text === null) return 0;
  if (!/^(0|[1-9][0-9]*)$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Dormant database authority for one private-user pre-dispatch admission.
 * The caller owns content and stable request IDs; this class owns every
 * authorization field. It never creates or mutates an operator worker route.
 */
export class MeriHermesPreDispatchDbCurrentAuthorityV2
implements MeriHermesPreDispatchAuthorityV2 {
  private readonly key: Uint8Array;
  private readonly policy: Omit<MeriHermesPreDispatchPinnedPolicyV2, 'sessionHeaderHmacKey' | 'bodyPolicy'>;
  private readonly bodyPolicy: MeriHermesPreDispatchPinnedPolicyV2['bodyPolicy'];

  constructor(pinned: MeriHermesPreDispatchPinnedPolicyV2) {
    const token = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
    if (!SHA256.test(pinned.catalogDigest) || !SHA256.test(pinned.workerImageDigest) ||
        !SHA256.test(pinned.meriCatalogDigest) ||
        !SHA256.test(pinned.capabilityMappingDigest) ||
        !token.test(pinned.workerBuildId) || !token.test(pinned.meriCatalogVersion) ||
        !token.test(pinned.capabilityMappingVersion) ||
        pinned.sessionHeaderHmacKey.length < 32 ||
        !pinned.workerAudience || !pinned.workerIngressId || !pinned.workerGeneration ||
        !pinned.workerCredentialId || !pinned.sessionHeaderKeyId ||
        !Number.isSafeInteger(pinned.maxToolCalls) || pinned.maxToolCalls < 0 ||
        !Number.isSafeInteger(pinned.maxOutputTokens) || pinned.maxOutputTokens < 0 ||
        !Number.isSafeInteger(pinned.maxWallClockMs) || pinned.maxWallClockMs < 300_000 ||
        pinned.maxWallClockMs > 86_400_000 ||
        typeof pinned.bodyPolicy !== 'function') {
      throw new Error('invalid pinned Phase 4 pre-dispatch policy');
    }
    const { sessionHeaderHmacKey: _key, bodyPolicy: _bodyPolicy, ...publicPolicy } = pinned;
    this.key = Uint8Array.from(pinned.sessionHeaderHmacKey);
    this.policy = Object.freeze({ ...publicPolicy });
    this.bodyPolicy = pinned.bodyPolicy;
  }

  async deriveAndSyncScope(
    tx: Prisma.TransactionClient,
    context: Readonly<MeriHermesPreDispatchAuthorityContextV2>,
  ): Promise<MeriHermesPreDispatchAuthorityDecisionV2 | null> {
    const { intent, conversation } = context;
    const scopeId = privateExecutionScopeId(intent.tenantId, intent.actorId);
    const conversationEpoch = epoch(conversation.session_epoch_text);
    if (conversationEpoch === null || conversation.tenant_id !== intent.tenantId ||
        conversation.user_id !== intent.actorId || conversation.id !== intent.conversationId) return null;

    const actors = await tx.$queryRaw<ActorRow[]>(Prisma.sql`
      SELECT m.role::text AS role, t.slug::text AS tenant_slug,
        u.clerk_user_id AS clerk_user_id
      FROM tenant_memberships m
      JOIN tenants t ON t.id = m.tenant_id
      JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = ${intent.tenantId}::uuid
        AND m.user_id = ${intent.actorId}::uuid
        AND m.status = 'active' AND t.status = 'active'
      FOR SHARE OF m, t, u NOWAIT
    `);
    const actor = actors[0];
    if (actors.length !== 1 || !actor ||
        !TENANT_ROLES.includes(actor.role as TenantRole) ||
        !actor.tenant_slug || !actor.clerk_user_id) return null;

    // Exactly the predicates used by the current claim verifier and active
    // securityEnvelope. The exclusive fence blocks their committed mutation.
    const clients = await tx.$queryRaw<IdRow[]>(Prisma.sql`
      SELECT c.id FROM clients c
      WHERE c.tenant_id = ${intent.tenantId}::uuid
        AND (c.memory_wall = false OR EXISTS (
          SELECT 1 FROM client_memory_access a
          WHERE a.tenant_id = c.tenant_id AND a.client_id = c.id
            AND a.user_id = ${intent.actorId}::uuid
        )) ORDER BY c.id
    `);
    const mailboxes = await tx.$queryRaw<IdRow[]>(Prisma.sql`
      SELECT id FROM engagement_connections
      WHERE tenant_id = ${intent.tenantId}::uuid
        AND created_by_user_id = ${intent.actorId}::uuid
        AND provider::text IN ('microsoft_365', 'google_workspace', 'imap_caldav')
      ORDER BY id
    `);
    const clientIds = clients.map((row) => row.id);
    const mailboxIds = mailboxes.map((row) => row.id);
    if (conversation.client_id !== null && !clientIds.includes(conversation.client_id)) return null;

    const advisory = await tx.$queryRaw<Array<{ locked: boolean }>>(Prisma.sql`
      SELECT pg_try_advisory_xact_lock(hashtext(${scopeId})) AS locked
    `);
    if (advisory[0]?.locked !== true) return null;
    const scopes = await tx.$queryRaw<ScopeRow[]>(Prisma.sql`
      SELECT tenant_id, principal_type, principal_id, kind, authorization_version
      FROM meri_execution_scopes
      WHERE tenant_id = ${intent.tenantId}::uuid AND id = ${scopeId}
      FOR UPDATE NOWAIT
    `);
    const scope = scopes[0];
    if (scope && (scope.tenant_id !== intent.tenantId || scope.principal_type !== 'user' ||
        scope.principal_id !== intent.actorId || scope.kind !== 'private')) return null;

    const fenceRows = await tx.$queryRaw<Array<{ revision: bigint; policy_version: string }>>(Prisma.sql`
      SELECT revision, policy_version
      FROM meri_phase4_try_lock_authority_fence_exclusive(${intent.tenantId}::uuid)
    `);
    const fence = fenceRows[0];
    if (fenceRows.length !== 1 || !fence || fence.revision !== context.fenceRevision ||
        fence.policy_version !== MERI_PHASE4_AUTHORIZATION_POLICY_VERSION) return null;
    const routes = await tx.$queryRaw<RouteRow[]>(Prisma.sql`
      SELECT binding_id, enabled, closed_at_epoch_micros,
        not_before_epoch_micros, not_after_epoch_micros
      FROM meri_phase4_lock_worker_route_bound(
        ${intent.tenantId}::uuid, ${scopeId}::varchar,
        ${this.policy.workerAudience}, ${this.policy.workerIngressId},
        ${this.policy.workerGeneration}, ${this.policy.workerCredentialId}
      )
    `);
    const route = routes[0];
    if (routes.length !== 1 || !route || route.enabled !== true ||
        route.closed_at_epoch_micros !== null) return null;
    const bindings = await tx.$queryRaw<BindingV2Row[]>(Prisma.sql`
      SELECT * FROM meri_phase4_lock_worker_binding_v2(
        ${route.binding_id}::uuid, ${intent.tenantId}::uuid, ${scopeId}::varchar,
        ${this.policy.workerAudience}, ${this.policy.workerIngressId},
        ${this.policy.workerGeneration}, ${this.policy.workerCredentialId}
      )
    `);
    const binding = bindings[0];
    if (bindings.length !== 1 || !binding || binding.active !== true ||
        binding.worker_image_digest !== this.policy.workerImageDigest ||
        binding.worker_build_id !== this.policy.workerBuildId ||
        binding.worker_catalog_digest_algorithm !==
          MERI_HERMES_WORKER_CATALOG_DIGEST_ALGORITHM_V1 ||
        binding.worker_catalog_digest !== this.policy.catalogDigest ||
        binding.applied_tool_view_digest_algorithm !==
          MERI_HERMES_APPLIED_TOOL_VIEW_DIGEST_ALGORITHM_V1 ||
        binding.meri_catalog_version !== this.policy.meriCatalogVersion ||
        binding.meri_catalog_digest !== this.policy.meriCatalogDigest ||
        binding.capability_mapping_version !== this.policy.capabilityMappingVersion ||
        binding.capability_mapping_digest !== this.policy.capabilityMappingDigest ||
        binding.tool_view_protocol !== MERI_PHASE4_TOOL_VIEW_PROTOCOL_V1 ||
        binding.claim_attestation_protocol !==
          MERI_PHASE4_CLAIM_ATTESTATION_PROTOCOL_V1 ||
        binding.attestation_credential_id !== this.policy.workerCredentialId) return null;
    const versionAt = (revision: bigint) => computeMeriPhase4AuthorizationVersionV2({
      tenantId: intent.tenantId, actorId: intent.actorId, role: actor.role,
      policyVersion: fence.policy_version,
      grantVersion: meriPhase4GrantVersionV2(revision),
      authorizedClientIds: clientIds, authorizedMailboxConnectionIds: mailboxIds,
    });
    const writeScope = !scope || scope.authorization_version !== versionAt(fence.revision);
    const finalRevision = fence.revision + (writeScope ? 1n : 0n);
    const authorizationVersion = versionAt(finalRevision);
    const prior = context.priorIdentity;
    if (prior && (prior.authorizationVersion !== authorizationVersion ||
        prior.grantVersion !== meriPhase4GrantVersionV2(finalRevision) ||
        prior.authorizationPolicyVersion !== fence.policy_version ||
        prior.scopeId !== scopeId || prior.workerAudience !== this.policy.workerAudience ||
        prior.workerIngressId !== this.policy.workerIngressId ||
        prior.workerGeneration !== this.policy.workerGeneration ||
        prior.workerCredentialId !== this.policy.workerCredentialId ||
        prior.catalogDigest !== this.policy.catalogDigest ||
        prior.sessionHeaderKeyId !== this.policy.sessionHeaderKeyId)) return null;
    if (writeScope) {
      if (scope) {
        await tx.meriExecutionScope.update({ where: { id: scopeId },
          data: { authorizationVersion } });
      } else {
        await tx.meriExecutionScope.create({ data: {
          id: scopeId, tenantId: intent.tenantId, principalType: 'user',
          principalId: intent.actorId, kind: 'private', authorizationVersion,
        } });
      }
    }
    const finalFence = await tx.$queryRaw<Array<{ revision: bigint; policy_version: string }>>(Prisma.sql`
      SELECT revision, policy_version
      FROM meri_phase4_try_lock_authority_fence_exclusive(${intent.tenantId}::uuid)
    `);
    if (finalFence.length !== 1 || finalFence[0]?.revision !== finalRevision ||
        finalFence[0].policy_version !== fence.policy_version) return null;

    const clocks = await tx.$queryRaw<Array<{ now_epoch_micros: bigint }>>(Prisma.sql`
      SELECT floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint AS now_epoch_micros
    `);
    const now = clocks[0]?.now_epoch_micros;
    if (clocks.length !== 1 || typeof now !== 'bigint' ||
        now < route.not_before_epoch_micros || now >= route.not_after_epoch_micros ||
        now < binding.not_before_epoch_micros ||
        now >= binding.not_after_epoch_micros) return null;
    const expires = now + BigInt(this.policy.maxWallClockMs + 300_000) * MICROS_PER_MS;
    const claim = prior ? BigInt(prior.claimNotAfterEpochMicros) : now + CLAIM_TTL_MICROS;
    const delivery = prior ? BigInt(prior.deliveryNotAfterEpochMicros) : now + DELIVERY_TTL_MICROS;
    const credential = prior ? BigInt(prior.workerCredentialNotAfterEpochMicros)
      : [route.not_after_epoch_micros, binding.not_after_epoch_micros, expires]
        .reduce((earliest, value) => value < earliest ? value : earliest);
    const reconciliation = prior ? BigInt(prior.reconciliationNotAfterEpochMicros)
      : credential + MERI_DISPATCH_RECOVERY_MARGIN_MICROS_V2;
    const retain = prior ? BigInt(prior.retainUntilEpochMicros)
      : reconciliation + MERI_DISPATCH_RETENTION_MARGIN_MICROS_V2;
    if (now >= claim || now >= delivery || now >= credential ||
        claim > now + CLAIM_TTL_MICROS || delivery > now + DELIVERY_TTL_MICROS ||
        claim > delivery || delivery > credential || credential > expires ||
        credential > route.not_after_epoch_micros ||
        credential > binding.not_after_epoch_micros ||
        reconciliation !== credential + MERI_DISPATCH_RECOVERY_MARGIN_MICROS_V2 ||
        retain !== reconciliation + MERI_DISPATCH_RETENTION_MARGIN_MICROS_V2) return null;
    const chosenBodyPolicy = this.bodyPolicy(intent);
    if (!chosenBodyPolicy || !isCompiledMeriHermesToolViewV1(chosenBodyPolicy.toolView) ||
        chosenBodyPolicy.toolView.catalogDigest !== this.policy.catalogDigest ||
        chosenBodyPolicy.toolView.catalogVersion !== this.policy.meriCatalogVersion ||
        chosenBodyPolicy.toolView.meriCatalogDigest !== this.policy.meriCatalogDigest ||
        chosenBodyPolicy.toolView.capabilityMappingVersion !==
          this.policy.capabilityMappingVersion ||
        chosenBodyPolicy.toolView.capabilityMappingDigest !==
          this.policy.capabilityMappingDigest ||
        (chosenBodyPolicy.extraBody !== undefined &&
          (!chosenBodyPolicy.extraBody || typeof chosenBodyPolicy.extraBody !== 'object' ||
            Array.isArray(chosenBodyPolicy.extraBody)))) return null;
    let bodyPolicy: {
      readonly toolPolicy: MeriHermesToolPolicy;
      readonly extraBody?: Readonly<Record<string, unknown>>;
    };
    try {
      const extraBody = chosenBodyPolicy.extraBody === undefined
        ? undefined
        : meriDispatchCanonicalJsonSnapshot(chosenBodyPolicy.extraBody);
      bodyPolicy = Object.freeze({
        toolPolicy: canonicalMeriHermesToolPolicyV2(
          brokerPolicySubsetForToolView(chosenBodyPolicy.toolView),
        ),
        ...(extraBody === undefined ? {} : { extraBody }),
      });
    } catch {
      return null;
    }
    const toolViewDigest = chosenBodyPolicy.toolView.toolViewDigest;
    if (prior && prior.toolViewDigest !== toolViewDigest) return null;
    if (expires > MAX_SIGNED_INT64 || reconciliation > MAX_SIGNED_INT64 ||
        retain > MAX_SIGNED_INT64 ||
        !Number.isFinite(Number(now / MICROS_PER_MS)) ||
        !Number.isFinite(Number(expires / MICROS_PER_MS)) ||
        Number(expires / MICROS_PER_MS) > 8_640_000_000_000_000) return null;

    const metadata: MeriDispatchRequestMetadataV2 = {
      version: 2, tenantId: intent.tenantId, actorType: 'user', actorId: intent.actorId,
      meriAudience: 'private', clientId: conversation.client_id,
      workspaceId: conversation.workspace_id, scopeId,
      conversationId: intent.conversationId, userMessageId: context.userMessageId,
      runId: intent.runId, idempotencyKey: intent.idempotencyKey,
      conversationEpoch, workerAudience: this.policy.workerAudience,
      workerIngressId: this.policy.workerIngressId,
      workerGeneration: this.policy.workerGeneration,
      workerCredentialId: this.policy.workerCredentialId,
      authorizationVersion, authorizationPolicyVersion: fence.policy_version,
      grantVersion: meriPhase4GrantVersionV2(finalRevision),
      catalogDigest: chosenBodyPolicy.toolView.catalogDigest, toolViewDigest,
      sessionHeaderKeyId: this.policy.sessionHeaderKeyId,
      claimNotAfterEpochMicros: claim.toString(),
      deliveryNotAfterEpochMicros: delivery.toString(),
      workerCredentialNotAfterEpochMicros: credential.toString(),
      reconciliationNotAfterEpochMicros: reconciliation.toString(),
      retainUntilEpochMicros: retain.toString(),
    };
    const actorContext: TenantContext = {
      tenantId: intent.tenantId, tenantSlug: actor.tenant_slug,
      userId: intent.actorId, clerkUserId: actor.clerk_user_id,
      role: actor.role as TenantRole,
    };
    const issuedAt = new Date(Number(now / MICROS_PER_MS)).toISOString();
    const expiresAt = new Date(Number(expires / MICROS_PER_MS)).toISOString();
    return {
      authorized: true, metadata, actorContext,
      envelope: {
        version: 1, tenantId: intent.tenantId, actorType: 'user', actorId: intent.actorId,
        conversationId: intent.conversationId, workspaceId: conversation.workspace_id,
        executionScopeId: scopeId, audience: 'private',
        authorizedClientIds: clientIds, authorizedMailboxConnectionIds: mailboxIds,
        toolPolicy: bodyPolicy.toolPolicy, authorizationVersion,
        runId: intent.runId, traceId: randomUUID(), issuedAt, expiresAt,
        budget: { maxToolCalls: this.policy.maxToolCalls,
          maxOutputTokens: this.policy.maxOutputTokens,
          maxWallClockMs: this.policy.maxWallClockMs },
      },
      sessionId: conversation.session_id || null,
      sessionKey: meriDispatchExpectedPrivateSessionKeyV2(metadata),
      sessionHeaderHmacKey: Uint8Array.from(this.key),
      ...(bodyPolicy.extraBody ? { extraBody: bodyPolicy.extraBody } : {}),
    };
  }
}
