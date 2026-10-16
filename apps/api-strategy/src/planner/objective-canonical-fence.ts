import {
  requireClientObjectiveDestinationRevision,
  ClientObjectiveDestinationError,
  type ClientObjectiveDestinationTx,
} from '@capiro/shared';
import {
  applicationHash,
  CanonicalApplicationError,
  type CanonicalApplicationGrant,
  type CanonicalApplicationRequest,
  type CanonicalToken,
} from './objective-canonical-application.js';

const TOKEN_KEYS: Array<keyof CanonicalToken> = [
  'canonicalPlanId', 'tenantId', 'clientId', 'objectiveId', 'canonicalStrategyId',
  'canonicalProjectId', 'bindingVersion', 'epoch', 'requestedIntentId',
  'requestedObjectiveRevisionId', 'requestedObjectiveVersion', 'snapshotHash',
];
const unavailable = (): never => { throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE'); };
const stale = (): never => { throw new CanonicalApplicationError('SOURCE_STALE'); };
const sameTime = (value: unknown): number => {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > 8_640_000_000_000_000)
    return unavailable();
  return n;
};
function grantScope(grant: CanonicalApplicationGrant, canonical: CanonicalToken) {
  if (grant.tenantId !== canonical.tenantId || grant.canonicalSha256 !== applicationHash(canonical) ||
      typeof grant.clerkUserId !== 'string' || !grant.clerkUserId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(grant.actorUserId))
    return unavailable();
}
async function databaseNow(tx: ClientObjectiveDestinationTx) {
  const rows = await tx.$queryRaw<Array<{ nowMs: string }>>`
    SELECT ceil(extract(epoch FROM clock_timestamp())*1000)::text AS "nowMs"`;
  if (rows.length !== 1) return unavailable();
  return sameTime(rows[0]!.nowMs);
}

/** A retained creation ACK has a separate current read admission. It is not an
 * effect retry: the old ready revision, consent and worker deadline are ignored.
 * The caller verifies the stored request/ACK and filters every current output. */
export async function requireCanonicalApplicationRead(
  tx: ClientObjectiveDestinationTx,
  grant: CanonicalApplicationGrant,
  canonical: CanonicalToken,
): Promise<void> {
  grantScope(grant, canonical);
  const scope = await tx.$queryRaw<Array<{ userId: string; memoryWall: boolean }>>`
    SELECT u.id::text AS "userId", c.memory_wall AS "memoryWall"
    FROM tenants t JOIN tenant_memberships m ON m.tenant_id=t.id
    JOIN users u ON u.id=m.user_id JOIN clients c ON c.tenant_id=t.id
    WHERE t.id=${grant.tenantId}::uuid AND t.status::text='active'
      AND t.settings_jsonb->'clioFeatureFlags'->'strategyPlanner.enabled'='true'::jsonb
      AND u.id=${grant.actorUserId}::uuid AND u.clerk_user_id=${grant.clerkUserId}
      AND m.status::text='active' AND m.role::text IN ('standard_user','user_admin','capiro_admin')
      AND c.id=${canonical.clientId}::uuid AND c.status::text<>'archived'
    FOR SHARE OF t,m,u,c`;
  if (scope.length !== 1 || scope[0]!.userId !== grant.actorUserId) return unavailable();
  if (scope[0]!.memoryWall) {
    const walls = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM client_memory_access WHERE tenant_id=${grant.tenantId}::uuid
        AND client_id=${canonical.clientId}::uuid AND user_id=${grant.actorUserId}::uuid FOR SHARE`;
    if (walls.length !== 1) return unavailable();
  }
  const objectives = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id::text AS id FROM client_objectives WHERE tenant_id=${grant.tenantId}::uuid
      AND client_id=${canonical.clientId}::uuid AND id=${canonical.objectiveId}::uuid
      AND deleted_at IS NULL FOR SHARE`;
  if (objectives.length !== 1) return unavailable();
  const strategies = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id::text AS id FROM sp_strategy WHERE tenant_id=${grant.tenantId}::uuid
      AND client_id=${canonical.clientId}::uuid AND id=${canonical.canonicalStrategyId}::uuid FOR SHARE`;
  if (strategies.length !== 1) return unavailable();
}

/** Called only in the receiving owner's existing Planner transaction, after its
 * Planner -> generation-job -> Strategy -> saved-version locks. Native Core
 * authority -> Objective parent -> canonical head -> work control locks follow.
 * Append-only intent/revision/consent rows are SELECT-only and never row-locked.
 * The final clock sample is an actual DB clock taken after all locks, not the
 * transaction-start timestamp. No remote, model or identity operation runs here. */
export async function requireCanonicalApplicationFence(
  tx: ClientObjectiveDestinationTx,
  grant: CanonicalApplicationGrant,
  request: CanonicalApplicationRequest,
): Promise<void> {
  const c = request.canonical;
  grantScope(grant, c);
  if (grant.requestSha256 !== applicationHash(request)) return unavailable();
  const source = await requireClientObjectiveDestinationRevision(tx, {
    tenantId: grant.tenantId, clerkUserId: grant.clerkUserId, userId: grant.actorUserId,
  }, { clientId: c.clientId, objectiveId: c.objectiveId, objectiveVersion: c.requestedObjectiveVersion }).catch(error => {
    if (error instanceof ClientObjectiveDestinationError && error.code === 'OBJECTIVE_VERSION_CONFLICT') return stale();
    return unavailable();
  });
  if (source.objectiveRevisionId !== c.requestedObjectiveRevisionId) return stale();
  const current = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT o.status::text AS status FROM client_objectives o JOIN tenants t ON t.id=o.tenant_id
    WHERE o.tenant_id=${grant.tenantId}::uuid AND o.client_id=${c.clientId}::uuid
      AND o.id=${c.objectiveId}::uuid AND o.version=${c.requestedObjectiveVersion}
      AND o.deleted_at IS NULL
      AND t.settings_jsonb->'clioFeatureFlags'->'strategyPlanner.enabled'='true'::jsonb`;
  if (current.length !== 1 || current[0]!.status !== 'ready') return stale();
  const intents = await tx.$queryRaw<Array<{
    id: string; objectiveRevisionId: string; objectiveVersion: number; actorUserId: string;
    revisionActorUserId: string; snapshotHash: string; purpose: string; state: string;
    blockedReason: string; revisionOperation: string; revisionSnapshot: unknown;
  }>>`
    SELECT i.id::text AS id, i.objective_revision_id::text AS "objectiveRevisionId",
      i.objective_version AS "objectiveVersion", i.actor_user_id::text AS "actorUserId",
      r.actor_user_id::text AS "revisionActorUserId", i.snapshot_hash AS "snapshotHash",
      i.purpose, i.state, i.blocked_reason AS "blockedReason", r.operation AS "revisionOperation",
      r.snapshot AS "revisionSnapshot"
    FROM client_objective_work_intents i JOIN client_objective_revisions r
      ON r.tenant_id=i.tenant_id AND r.client_id=i.client_id AND r.objective_id=i.objective_id
      AND r.id=i.objective_revision_id AND r.version=i.objective_version
    WHERE i.id=${c.requestedIntentId}::uuid AND i.tenant_id=${grant.tenantId}::uuid
      AND i.client_id=${c.clientId}::uuid AND i.objective_id=${c.objectiveId}::uuid`;
  const intent = intents[0];
  const snapshot = intent?.revisionSnapshot as Record<string, unknown> | null;
  if (intents.length !== 1 || !intent || intent.id !== c.requestedIntentId ||
      intent.objectiveRevisionId !== c.requestedObjectiveRevisionId ||
      intent.objectiveVersion !== c.requestedObjectiveVersion ||
      intent.actorUserId !== intent.revisionActorUserId || intent.purpose !== 'objective_strategy_plan' ||
      intent.state !== 'pending' || intent.blockedReason !== 'runtime_authority_unconnected' ||
      intent.revisionOperation !== 'confirm_ready' || !snapshot || Array.isArray(snapshot) ||
      snapshot.id !== c.objectiveId || snapshot.clientId !== c.clientId ||
      snapshot.version !== c.requestedObjectiveVersion || snapshot.status !== 'ready' ||
      snapshot.deletedAt != null || intent.snapshotHash !== c.snapshotHash ||
      applicationHash(snapshot) !== c.snapshotHash) return stale();
  const heads = await tx.$queryRaw<CanonicalToken[]>`
    SELECT id::text AS "canonicalPlanId", tenant_id::text AS "tenantId", client_id::text AS "clientId",
      objective_id::text AS "objectiveId", canonical_strategy_id::text AS "canonicalStrategyId",
      canonical_project_id::text AS "canonicalProjectId", binding_version AS "bindingVersion", epoch,
      requested_intent_id::text AS "requestedIntentId",
      requested_objective_revision_id::text AS "requestedObjectiveRevisionId",
      requested_objective_version AS "requestedObjectiveVersion", requested_snapshot_hash AS "snapshotHash"
    FROM client_objective_canonical_plans WHERE tenant_id=${grant.tenantId}::uuid
      AND client_id=${c.clientId}::uuid AND objective_id=${c.objectiveId}::uuid FOR UPDATE`;
  if (heads.length !== 1 || TOKEN_KEYS.some(k => heads[0]![k] !== c[k])) return stale();
  const consents = await tx.$queryRaw<Array<{
    consentingActorUserId: string; membershipId: string; nativeMembershipId: string;
    rootActorUserId: string; confirmedAtMs: string; expiresAtMs: string;
    configuredDurationMs: bigint | string | number; effectiveDurationMs: bigint | string | number;
    policyId: string; policyRevision: number; expiryValid: boolean;
  }>>`
    SELECT cs.consenting_actor_user_id::text AS "consentingActorUserId",
      cs.consenting_membership_id::text AS "membershipId", m.id::text AS "nativeMembershipId",
      cs.root_actor_user_id::text AS "rootActorUserId", cs.consent_policy_id AS "policyId",
      cs.consent_policy_revision AS "policyRevision", cs.configured_duration_ms AS "configuredDurationMs",
      cs.effective_duration_ms AS "effectiveDurationMs",
      ceil(extract(epoch FROM cs.confirmed_at)*1000)::text AS "confirmedAtMs",
      ceil(extract(epoch FROM cs.expires_at)*1000)::text AS "expiresAtMs",
      (cs.expires_at>cs.confirmed_at AND cs.expires_at<=cs.confirmed_at+cs.effective_duration_ms*INTERVAL '1 millisecond'
        AND (cs.stricter_expires_at IS NULL OR cs.expires_at<=cs.stricter_expires_at)) AS "expiryValid"
    FROM client_objective_work_controls ctl JOIN client_objective_work_consents cs
      ON cs.tenant_id=ctl.tenant_id AND cs.client_id=ctl.client_id AND cs.objective_id=ctl.objective_id
      AND cs.work_action=ctl.work_action AND cs.control_id=ctl.id AND cs.id=ctl.current_consent_id
      AND cs.canonical_plan_id=ctl.canonical_plan_id AND cs.canonical_epoch=ctl.canonical_epoch
      AND cs.canonical_strategy_id=ctl.canonical_strategy_id AND cs.canonical_project_id=ctl.canonical_project_id
    JOIN tenant_memberships m ON m.tenant_id=cs.tenant_id AND m.user_id=cs.consenting_actor_user_id
      AND m.id=cs.consenting_membership_id AND m.status::text='active'
      AND m.role::text IN ('standard_user','user_admin','capiro_admin')
    WHERE ctl.tenant_id=${grant.tenantId}::uuid AND ctl.client_id=${c.clientId}::uuid
      AND ctl.objective_id=${c.objectiveId}::uuid AND ctl.work_action='objective.plan.prepare'
      AND ctl.version=${grant.controlVersion} AND ctl.cancelled_at IS NULL
      AND cs.id=${grant.consentId}::uuid AND cs.consenting_actor_user_id=${grant.actorUserId}::uuid
      AND cs.canonical_plan_id=${c.canonicalPlanId}::uuid AND cs.canonical_epoch=${c.epoch}
      AND cs.canonical_strategy_id=${c.canonicalStrategyId}::uuid AND cs.canonical_project_id=${c.canonicalProjectId}::uuid
      AND cs.canonical_binding_version=${c.bindingVersion} AND cs.root_intent_id=${c.requestedIntentId}::uuid
      AND cs.source_revision_id=${c.requestedObjectiveRevisionId}::uuid
      AND cs.source_objective_version=${c.requestedObjectiveVersion} AND cs.source_snapshot_hash=${c.snapshotHash}
    FOR UPDATE OF ctl`;
  const consent = consents[0];
  if (consents.length !== 1 || !consent || consent.consentingActorUserId !== grant.actorUserId ||
      consent.membershipId !== consent.nativeMembershipId || consent.rootActorUserId !== intent.actorUserId ||
      consent.policyId !== 'capiro.objective-generation-consent' || consent.policyRevision !== 1 ||
      !consent.expiryValid) return unavailable();
  const configured = Number(consent.configuredDurationMs), effective = Number(consent.effectiveDurationMs);
  if (!Number.isSafeInteger(configured) || !Number.isSafeInteger(effective) ||
      effective < 1 || configured < effective || configured > 1800000) return unavailable();
  const now = await databaseNow(tx);
  const confirmed = sameTime(consent.confirmedAtMs), expires = sameTime(consent.expiresAtMs);
  if (confirmed > now || expires <= now ||
      sameTime(grant.tokenExpiresAtMs) <= now || sameTime(grant.delegationExpiresAtMs) <= now ||
      sameTime(grant.claimExpiresAtMs) <= now) return unavailable();
}
