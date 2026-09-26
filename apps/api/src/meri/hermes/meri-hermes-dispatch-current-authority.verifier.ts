import { Prisma } from '@prisma/client';
import type { MeriHermesDispatchCurrentAuthorityVerifierV2 } from './meri-hermes-dispatch-claim-boundary.js';
import type { MeriDispatchGateBearerClaimsV1 } from './meri-hermes-dispatch-gate-bearer.js';
import type { MeriDispatchLockedContextV2 } from './meri-hermes-dispatch-intent.repository.js';
import {
  computeMeriPhase4AuthorizationVersionV2,
  MERI_PHASE4_AUTHORIZATION_POLICY_VERSION,
  meriPhase4GrantVersionV2,
} from './meri-hermes-phase4-authorization.contract.js';
import {
  MERI_HERMES_APPLIED_TOOL_VIEW_DIGEST_ALGORITHM_V1,
  MERI_HERMES_WORKER_CATALOG_DIGEST_ALGORITHM_V1,
} from './meri-hermes-tool-view.js';
import {
  MERI_PHASE4_CLAIM_ATTESTATION_PROTOCOL_V1,
  MERI_PHASE4_TOOL_VIEW_PROTOCOL_V1,
} from './meri-phase4-route-operator.contract.js';

interface FenceRow { revision: bigint; policy_version: string }
interface ActorRow { role: string; tenant_slug: string; clerk_user_id: string }
interface IdRow { id: string }
interface SourceRow {
  status: string;
  archived_at: Date | null;
  envelope_jsonb: unknown;
  actor_context_jsonb: unknown;
}
interface RouteRow {
  binding_id: string;
  enabled: boolean;
  closed_at_epoch_micros: bigint | null;
  not_before_epoch_micros: bigint;
  not_after_epoch_micros: bigint;
}
interface BindingRow {
  active: boolean;
  not_before_epoch_micros: bigint;
  not_after_epoch_micros: bigint;
  worker_image_digest: string;
  worker_build_id: string;
  worker_catalog_digest_algorithm: string;
  worker_catalog_digest: string;
  applied_tool_view_digest_algorithm: string;
  meri_catalog_version: string;
  meri_catalog_digest: string;
  capability_mapping_version: string;
  capability_mapping_digest: string;
  tool_view_protocol: string;
  claim_attestation_protocol: string;
  attestation_credential_id: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function sameIds(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length &&
    value.every((id, index) => id === expected[index]);
}

/**
 * Dormant same-transaction claim adapter. The repository acquires the fence
 * before source locks; this repeated shared lock verifies that prerequisite and
 * keeps the exact revision locked through the claim commit. No registration.
 */
export class MeriHermesDispatchDbCurrentAuthorityVerifierV2
implements MeriHermesDispatchCurrentAuthorityVerifierV2 {
  async verifyCurrentAuthorityInTransaction(
    tx: Prisma.TransactionClient,
    context: Readonly<MeriDispatchLockedContextV2>,
    claims: Readonly<MeriDispatchGateBearerClaimsV1>,
    proposedWorkerRunId: string,
  ): Promise<boolean> {
    try {
      const identity = context.identity;
      if (context.runStatus !== 'queued' && context.runStatus !== 'provisioning') return false;
      if (context.dispatchStatus !== 'pending' || context.stopRequestedAt !== null ||
          context.scopeAuthorizationVersion !== identity.authorizationVersion ||
          typeof proposedWorkerRunId !== 'string' || proposedWorkerRunId.length === 0 ||
          claims.tenantId !== identity.tenantId || claims.actorId !== identity.actorId ||
          claims.scopeId !== identity.scopeId ||
          claims.runId !== identity.runId || claims.requestSha256 !== identity.requestSha256 ||
          claims.workerAudience !== identity.workerAudience ||
          claims.workerIngressId !== identity.workerIngressId ||
          claims.workerGeneration !== identity.workerGeneration ||
          claims.workerCredentialId !== identity.workerCredentialId ||
          claims.authorizationVersion !== identity.authorizationVersion) return false;

      const fences = await tx.$queryRaw<FenceRow[]>(Prisma.sql`
        SELECT revision, policy_version
        FROM meri_phase4_lock_authority_fence(${identity.tenantId}::uuid)
      `);
      const fence = fences[0];
      if (fences.length !== 1 || !fence || typeof fence.revision !== 'bigint' ||
          fence.policy_version !== MERI_PHASE4_AUTHORIZATION_POLICY_VERSION) return false;
      const grantVersion = meriPhase4GrantVersionV2(fence.revision);
      if (identity.grantVersion !== grantVersion ||
          identity.authorizationPolicyVersion !== fence.policy_version) return false;

      const actors = await tx.$queryRaw<ActorRow[]>(Prisma.sql`
        SELECT m.role::text AS role, t.slug::text AS tenant_slug,
          u.clerk_user_id AS clerk_user_id
        FROM tenant_memberships m
        JOIN tenants t ON t.id = m.tenant_id
        JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = ${identity.tenantId}::uuid
          AND m.user_id = ${identity.actorId}::uuid
          AND m.status = 'active' AND t.status = 'active'
      `);
      if (actors.length !== 1 || !actors[0]) return false;
      const { role, tenant_slug: tenantSlug, clerk_user_id: clerkUserId } = actors[0];
      if (!tenantSlug || !clerkUserId) return false;

      // Exact current securityEnvelope predicates: wall or explicit access,
      // and actor-owned connections from the three mailbox providers.
      const clientRows = await tx.$queryRaw<IdRow[]>(Prisma.sql`
        SELECT c.id FROM clients c
        WHERE c.tenant_id = ${identity.tenantId}::uuid
          AND (c.memory_wall = false OR EXISTS (
            SELECT 1 FROM client_memory_access a
            WHERE a.tenant_id = c.tenant_id AND a.client_id = c.id
              AND a.user_id = ${identity.actorId}::uuid
          )) ORDER BY c.id
      `);
      const mailboxRows = await tx.$queryRaw<IdRow[]>(Prisma.sql`
        SELECT id FROM engagement_connections
        WHERE tenant_id = ${identity.tenantId}::uuid
          AND created_by_user_id = ${identity.actorId}::uuid
          AND provider::text IN ('microsoft_365', 'google_workspace', 'imap_caldav')
        ORDER BY id
      `);
      const clientIds = clientRows.map((row) => row.id);
      const mailboxIds = mailboxRows.map((row) => row.id);
      if (identity.clientId !== null && !clientIds.includes(identity.clientId)) return false;
      const authorizationVersion = computeMeriPhase4AuthorizationVersionV2({
        tenantId: identity.tenantId, actorId: identity.actorId, role,
        policyVersion: fence.policy_version, grantVersion,
        authorizedClientIds: clientIds, authorizedMailboxConnectionIds: mailboxIds,
      });
      if (identity.authorizationVersion !== authorizationVersion) return false;

      // The claim repository already locked and compared this run, its scope,
      // conversation/session epoch, message, and Stop marker. Check additional
      // open-state and exact persisted authority content from those locked rows.
      const sources = await tx.$queryRaw<SourceRow[]>(Prisma.sql`
        SELECT c.status, c.archived_at, r.envelope_jsonb, r.actor_context_jsonb
        FROM meri_agent_runs r JOIN clio_conversations c
          ON c.id = r.conversation_id AND c.tenant_id = r.tenant_id
        WHERE r.tenant_id = ${identity.tenantId}::uuid
          AND r.id = ${identity.runId}::uuid
          AND c.id = ${identity.conversationId}::uuid
      `);
      const source = sources[0];
      if (sources.length !== 1 || !source || source.status !== 'active' ||
          source.archived_at !== null) return false;
      const envelope = object(source.envelope_jsonb);
      const actorContext = object(source.actor_context_jsonb);
      if (!envelope || !actorContext || envelope.version !== 1 ||
          envelope.tenantId !== identity.tenantId || envelope.actorType !== identity.actorType ||
          envelope.actorId !== identity.actorId ||
          envelope.conversationId !== identity.conversationId ||
          envelope.workspaceId !== identity.workspaceId ||
          envelope.executionScopeId !== identity.scopeId ||
          envelope.audience !== identity.meriAudience || envelope.runId !== identity.runId ||
          envelope.authorizationVersion !== authorizationVersion ||
          actorContext.role !== role || actorContext.tenantId !== identity.tenantId ||
          actorContext.userId !== identity.actorId ||
          actorContext.tenantSlug !== tenantSlug ||
          actorContext.clerkUserId !== clerkUserId ||
          !sameIds(envelope.authorizedClientIds, clientIds) ||
          !sameIds(envelope.authorizedMailboxConnectionIds, mailboxIds)) return false;

      const routes = await tx.$queryRaw<RouteRow[]>(Prisma.sql`
        SELECT binding_id, enabled, closed_at_epoch_micros,
          not_before_epoch_micros, not_after_epoch_micros
        FROM meri_phase4_lock_worker_route_bound(
          ${identity.tenantId}::uuid, ${identity.scopeId}::varchar,
          ${identity.workerAudience},
          ${identity.workerIngressId}, ${identity.workerGeneration},
          ${identity.workerCredentialId}
        )
      `);
      const route = routes[0];
      if (routes.length !== 1 || !route || route.enabled !== true ||
          route.closed_at_epoch_micros !== null) return false;
      const bindings = await tx.$queryRaw<BindingRow[]>(Prisma.sql`
        SELECT active, not_before_epoch_micros, not_after_epoch_micros,
          worker_image_digest, worker_build_id,
          worker_catalog_digest_algorithm, worker_catalog_digest,
          applied_tool_view_digest_algorithm,
          meri_catalog_version, meri_catalog_digest,
          capability_mapping_version, capability_mapping_digest,
          tool_view_protocol, claim_attestation_protocol,
          attestation_credential_id
        FROM meri_phase4_lock_worker_binding_v2(
          ${route.binding_id}::uuid, ${identity.tenantId}::uuid,
          ${identity.scopeId}::varchar, ${identity.workerAudience},
          ${identity.workerIngressId}, ${identity.workerGeneration},
          ${identity.workerCredentialId}
        )
      `);
      const binding = bindings[0];
      if (bindings.length !== 1 || !binding || binding.active !== true ||
          !SHA256.test(binding.worker_image_digest) || !TOKEN.test(binding.worker_build_id) ||
          binding.worker_catalog_digest_algorithm !==
            MERI_HERMES_WORKER_CATALOG_DIGEST_ALGORITHM_V1 ||
          binding.worker_catalog_digest !== identity.catalogDigest ||
          binding.applied_tool_view_digest_algorithm !==
            MERI_HERMES_APPLIED_TOOL_VIEW_DIGEST_ALGORITHM_V1 ||
          !TOKEN.test(binding.meri_catalog_version) ||
          !SHA256.test(binding.meri_catalog_digest) ||
          !TOKEN.test(binding.capability_mapping_version) ||
          !SHA256.test(binding.capability_mapping_digest) ||
          binding.tool_view_protocol !== MERI_PHASE4_TOOL_VIEW_PROTOCOL_V1 ||
          binding.claim_attestation_protocol !==
            MERI_PHASE4_CLAIM_ATTESTATION_PROTOCOL_V1 ||
          binding.attestation_credential_id !== identity.workerCredentialId) return false;
      const clocks = await tx.$queryRaw<Array<{ now_epoch_micros: bigint }>>(Prisma.sql`
        SELECT floor(extract(epoch FROM clock_timestamp()) * 1000000)::bigint AS now_epoch_micros
      `);
      const now = clocks[0]?.now_epoch_micros;
      if (clocks.length !== 1 || typeof now !== 'bigint') return false;
      const issued = Date.parse(String(envelope.issuedAt));
      const expires = Date.parse(String(envelope.expiresAt));
      return Number.isFinite(issued) && Number.isFinite(expires) &&
        BigInt(Math.trunc(issued)) * 1000n <= now &&
        now < BigInt(Math.trunc(expires)) * 1000n &&
        route.not_before_epoch_micros <= now && now < route.not_after_epoch_micros &&
        binding.not_before_epoch_micros <= now && now < binding.not_after_epoch_micros &&
        now < BigInt(identity.claimNotAfterEpochMicros) &&
        now < BigInt(identity.deliveryNotAfterEpochMicros) &&
        now < BigInt(identity.workerCredentialNotAfterEpochMicros);
    } catch {
      // A read/lock failure is indeterminate to the outer boundary, never an
      // authorization success. The outer claim maps it to UNKNOWN.
      throw new Error('current authority unavailable');
    }
  }
}
