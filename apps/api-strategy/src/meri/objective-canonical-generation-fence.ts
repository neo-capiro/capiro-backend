import { requireClientObjectiveDestinationRevision, type ClientObjectiveDestinationTx } from '@capiro/shared';
import { applicationHash, CanonicalApplicationError, type CanonicalToken } from '../planner/objective-canonical-application.js';
import { GENERATION_ADMISSION_NAMESPACE, generationUuid, parseCanonicalGenerationAdmission,
  parseGenerationCanonicalToken, type CanonicalGenerationAdmission } from './objective-canonical-generation.js';

export interface CanonicalGenerationScope {
  tenantId: string; clientId: string; objectiveId: string; clerkUserId: string;
  generationJobId: string; generationRequestId: string;
}
type Tx = ClientObjectiveDestinationTx & {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
};
type Job = { id: string; clientId: string; ownerUserId: string; status: string; strategyId: string | null;
  requestKey: string; input: any; deadlineMs: string; attempt: number; claimedBy: string | null; claimedAt: unknown };
type Facts = { canonical: CanonicalToken; actorUserId: string; membershipId: string; rootActorUserId: string;
  consentId: string; controlVersion: number; nowMs: number; expiresAtMs: number };
const unavailable = (): never => { throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE'); };
const stale = (): never => { throw new CanonicalApplicationError('SOURCE_STALE'); };
const TOKEN_KEYS: Array<keyof CanonicalToken> = ['canonicalPlanId', 'tenantId', 'clientId', 'objectiveId',
  'canonicalStrategyId', 'canonicalProjectId', 'bindingVersion', 'epoch', 'requestedIntentId',
  'requestedObjectiveRevisionId', 'requestedObjectiveVersion', 'snapshotHash'];
function milliseconds(value: unknown): number {
  const n = typeof value === 'string' && /^\d+$/.exec(value)?.[0] === value ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 8_640_000_000_000_000 ? n : unavailable();
}
function scope(input: CanonicalGenerationScope): CanonicalGenerationScope {
  for (const key of ['tenantId', 'clientId', 'objectiveId', 'generationJobId', 'generationRequestId'] as const) generationUuid(input[key]);
  if (typeof input.clerkUserId !== 'string' || input.clerkUserId.length < 1 || input.clerkUserId.length > 128)
    return unavailable();
  return input;
}
async function clock(tx: Tx): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ nowMs: string }>>`
    SELECT ceil(extract(epoch FROM clock_timestamp())*1000)::text AS "nowMs"`;
  return rows.length === 1 ? milliseconds(rows[0]!.nowMs) : unavailable();
}
async function jobGate(tx: Tx, s: CanonicalGenerationScope, phase: 'admission' | 'before-write' | 'after-write'): Promise<Job> {
  const rows = await tx.$queryRaw<Job[]>`SELECT id::text AS id,client_id::text AS "clientId",owner_user_id AS "ownerUserId",
    status::text AS status,strategy_id::text AS "strategyId",request_key AS "requestKey",input,
    attempt,claimed_by AS "claimedBy",claimed_at AS "claimedAt",
    floor(extract(epoch FROM deadline_at)*1000)::text AS "deadlineMs"
    FROM sp_draft_job WHERE tenant_id=${s.tenantId}::uuid AND id=${s.generationJobId}::uuid FOR UPDATE`;
  const j = rows[0], request = j?.input?.objectiveGeneration?.request;
  if (rows.length !== 1 || !j || j.clientId !== s.clientId || j.ownerUserId !== s.clerkUserId ||
      (phase === 'admission' ? j.status !== 'queued' : phase === 'before-write' ? j.status !== 'running' : j.status !== 'completed') ||
      // Actual SpDraftJob default is 1; legacy claimNext increments before any
      // transport. Reclaimed queued jobs have attempt >=2 and cannot be adopted.
      (phase === 'admission' && (j.attempt !== 1 || j.claimedBy !== null || j.claimedAt !== null)) ||
      (phase !== 'after-write' && j.strategyId !== null) ||
      request?.requestId !== s.generationRequestId || request.clientId !== s.clientId || request.objective?.objectiveId !== s.objectiveId ||
      j.requestKey !== `objective-v1:${applicationHash([s.tenantId, s.clerkUserId, s.generationRequestId])}` ||
      j.input.objectiveGeneration.fingerprint !== applicationHash(request)) return unavailable();
  milliseconds(j.deadlineMs);
  return j;
}
async function canonicalHint(tx: Tx, s: CanonicalGenerationScope): Promise<CanonicalToken> {
  const rows = await tx.$queryRaw<CanonicalToken[]>`SELECT id::text AS "canonicalPlanId",tenant_id::text AS "tenantId",
    client_id::text AS "clientId",objective_id::text AS "objectiveId",canonical_strategy_id::text AS "canonicalStrategyId",
    canonical_project_id::text AS "canonicalProjectId",binding_version AS "bindingVersion",epoch,
    requested_intent_id::text AS "requestedIntentId",requested_objective_revision_id::text AS "requestedObjectiveRevisionId",
    requested_objective_version AS "requestedObjectiveVersion",requested_snapshot_hash AS "snapshotHash"
    FROM client_objective_canonical_plans WHERE tenant_id=${s.tenantId}::uuid
      AND client_id=${s.clientId}::uuid AND objective_id=${s.objectiveId}::uuid`;
  return rows.length === 1 ? parseGenerationCanonicalToken(rows[0]) : unavailable();
}
/** The owning producer must additionally verify its paired immutable producer
 * before adopting an existing reserved ID. This function derives a head; ID or
 * client equality alone deliberately does not assert canonical ownership. */
async function strategyHead(tx: Tx, s: CanonicalGenerationScope, c: CanonicalToken, seal: boolean) {
  const strategies = await tx.$queryRaw<Array<{ id: string; clientId: string; archived: boolean }>>`
    SELECT id::text AS id,client_id::text AS "clientId",(archived_at IS NOT NULL) AS archived
    FROM sp_strategy WHERE tenant_id=${s.tenantId}::uuid AND id=${c.canonicalStrategyId}::uuid FOR UPDATE`;
  if (strategies.length > 1) return unavailable();
  if (!strategies[0]) return null;
  if (strategies[0].clientId !== s.clientId || strategies[0].archived) return unavailable();
  const versions = await tx.$queryRaw<Array<{ id: string; coalescible: boolean }>>`
    SELECT id::text AS id,coalescible FROM sp_version WHERE tenant_id=${s.tenantId}::uuid
      AND strategy_id=${c.canonicalStrategyId}::uuid ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`;
  if (versions.length !== 1) return unavailable();
  const latest = versions[0]!;
  generationUuid(latest.id);
  if (seal && latest.coalescible) await tx.$executeRaw`UPDATE sp_version SET coalescible=false
    WHERE tenant_id=${s.tenantId}::uuid AND strategy_id=${c.canonicalStrategyId}::uuid AND id=${latest.id}::uuid AND coalescible=true`;
  else if (latest.coalescible) return stale();
  return latest.id;
}
async function currentFacts(tx: Tx, s: CanonicalGenerationScope, expected: CanonicalToken,
  expectedActor?: string, expectedConsent?: string, expectedControlVersion?: number): Promise<Facts> {
  // This first read is a hint only. The shared owner then locks and resolves
  // the exact native/Clerk membership, tenant/client/wall and Objective rows.
  const actors = await tx.$queryRaw<Array<{ actorUserId: string }>>`SELECT u.id::text AS "actorUserId"
    FROM users u JOIN tenant_memberships m ON m.user_id=u.id WHERE u.clerk_user_id=${s.clerkUserId}
      AND m.tenant_id=${s.tenantId}::uuid AND m.status::text='active'
      AND m.role::text IN ('standard_user','user_admin','capiro_admin')`;
  if (actors.length !== 1 || expectedActor && actors[0]!.actorUserId !== expectedActor) return unavailable();
  const actorUserId = actors[0]!.actorUserId;
  generationUuid(actorUserId);
  const revision = await requireClientObjectiveDestinationRevision(tx, { tenantId: s.tenantId,
    clerkUserId: s.clerkUserId, userId: actorUserId }, { clientId: s.clientId,
    objectiveId: s.objectiveId, objectiveVersion: expected.requestedObjectiveVersion }).catch(() => stale());
  if (revision.objectiveRevisionId !== expected.requestedObjectiveRevisionId) return stale();
  const roots = await tx.$queryRaw<Array<{ rootActorUserId: string; revisionActor: string; hash: string; operation: string;
    snapshot: any; purpose: string; state: string; blocker: string; ready: boolean }>>`
    SELECT i.actor_user_id::text AS "rootActorUserId",r.actor_user_id::text AS "revisionActor",i.snapshot_hash AS hash,
      r.operation,r.snapshot,i.purpose,i.state,i.blocked_reason AS blocker,(o.status::text='ready') AS ready
    FROM client_objective_work_intents i JOIN client_objective_revisions r ON r.tenant_id=i.tenant_id
      AND r.client_id=i.client_id AND r.objective_id=i.objective_id AND r.id=i.objective_revision_id AND r.version=i.objective_version
    JOIN client_objectives o ON o.tenant_id=i.tenant_id AND o.client_id=i.client_id AND o.id=i.objective_id AND o.version=i.objective_version
    JOIN tenants t ON t.id=o.tenant_id AND t.settings_jsonb->'clioFeatureFlags'->'strategyPlanner.enabled'='true'::jsonb
    WHERE i.tenant_id=${s.tenantId}::uuid AND i.client_id=${s.clientId}::uuid AND i.objective_id=${s.objectiveId}::uuid
      AND i.id=${expected.requestedIntentId}::uuid AND i.objective_revision_id=${expected.requestedObjectiveRevisionId}::uuid
      AND i.objective_version=${expected.requestedObjectiveVersion}`;
  const root = roots[0], snapshot = root?.snapshot;
  if (roots.length !== 1 || !root || !root.ready || root.rootActorUserId !== root.revisionActor ||
      root.operation !== 'confirm_ready' || root.purpose !== 'objective_strategy_plan' || root.state !== 'pending' ||
      root.blocker !== 'runtime_authority_unconnected' || !snapshot || Array.isArray(snapshot) ||
      snapshot.id !== s.objectiveId || snapshot.clientId !== s.clientId || snapshot.version !== expected.requestedObjectiveVersion ||
      snapshot.status !== 'ready' || snapshot.deletedAt != null || root.hash !== expected.snapshotHash ||
      applicationHash(snapshot) !== expected.snapshotHash) return stale();
  const heads = await tx.$queryRaw<CanonicalToken[]>`SELECT id::text AS "canonicalPlanId",tenant_id::text AS "tenantId",
    client_id::text AS "clientId",objective_id::text AS "objectiveId",canonical_strategy_id::text AS "canonicalStrategyId",
    canonical_project_id::text AS "canonicalProjectId",binding_version AS "bindingVersion",epoch,
    requested_intent_id::text AS "requestedIntentId",requested_objective_revision_id::text AS "requestedObjectiveRevisionId",
    requested_objective_version AS "requestedObjectiveVersion",requested_snapshot_hash AS "snapshotHash"
    FROM client_objective_canonical_plans WHERE tenant_id=${s.tenantId}::uuid
      AND client_id=${s.clientId}::uuid AND objective_id=${s.objectiveId}::uuid FOR UPDATE`;
  if (heads.length !== 1 || TOKEN_KEYS.some(k => heads[0]![k] !== expected[k])) return stale();
  const consents = await tx.$queryRaw<Array<{ consentId: string; controlVersion: number; actorUserId: string; membershipId: string;
    currentMembershipId: string; rootActorUserId: string; policyId: string; policyRevision: number;
    configured: string; effective: string; confirmedMs: string; expiresMs: string; validExpiry: boolean }>>`
    SELECT cs.id::text AS "consentId",ctl.version AS "controlVersion",cs.consenting_actor_user_id::text AS "actorUserId",
      cs.consenting_membership_id::text AS "membershipId",m.id::text AS "currentMembershipId",
      cs.root_actor_user_id::text AS "rootActorUserId",cs.consent_policy_id AS "policyId",cs.consent_policy_revision AS "policyRevision",
      cs.configured_duration_ms::text AS configured,cs.effective_duration_ms::text AS effective,
      ceil(extract(epoch FROM cs.confirmed_at)*1000)::text AS "confirmedMs",
      floor(extract(epoch FROM cs.expires_at)*1000)::text AS "expiresMs",
      (cs.expires_at>cs.confirmed_at AND cs.expires_at<=cs.confirmed_at+cs.effective_duration_ms*INTERVAL '1 millisecond'
        AND (cs.stricter_expires_at IS NULL OR cs.expires_at<=cs.stricter_expires_at)) AS "validExpiry"
    FROM client_objective_work_controls ctl JOIN client_objective_work_consents cs ON cs.tenant_id=ctl.tenant_id
      AND cs.client_id=ctl.client_id AND cs.objective_id=ctl.objective_id AND cs.work_action=ctl.work_action
      AND cs.control_id=ctl.id AND cs.id=ctl.current_consent_id AND cs.canonical_plan_id=ctl.canonical_plan_id
      AND cs.canonical_epoch=ctl.canonical_epoch AND cs.canonical_strategy_id=ctl.canonical_strategy_id
      AND cs.canonical_project_id=ctl.canonical_project_id
    JOIN users u ON u.id=cs.consenting_actor_user_id AND u.clerk_user_id=${s.clerkUserId}
    JOIN tenant_memberships m ON m.id=cs.consenting_membership_id AND m.tenant_id=cs.tenant_id AND m.user_id=u.id
      AND m.status::text='active' AND m.role::text IN ('standard_user','user_admin','capiro_admin')
    WHERE ctl.tenant_id=${s.tenantId}::uuid AND ctl.client_id=${s.clientId}::uuid AND ctl.objective_id=${s.objectiveId}::uuid
      AND ctl.work_action='objective.strategy.draft' AND ctl.cancelled_at IS NULL
      AND cs.consenting_actor_user_id=${actorUserId}::uuid AND cs.canonical_plan_id=${expected.canonicalPlanId}::uuid
      AND cs.canonical_epoch=${expected.epoch} AND cs.canonical_strategy_id=${expected.canonicalStrategyId}::uuid
      AND cs.canonical_project_id=${expected.canonicalProjectId}::uuid AND cs.canonical_binding_version=${expected.bindingVersion}
      AND cs.root_intent_id=${expected.requestedIntentId}::uuid AND cs.source_revision_id=${expected.requestedObjectiveRevisionId}::uuid
      AND cs.source_objective_version=${expected.requestedObjectiveVersion} AND cs.source_snapshot_hash=${expected.snapshotHash}
    FOR UPDATE OF ctl`;
  const consent = consents[0];
  if (consents.length !== 1 || !consent || consent.actorUserId !== actorUserId ||
      consent.membershipId !== consent.currentMembershipId || consent.rootActorUserId !== root.rootActorUserId ||
      consent.policyId !== 'capiro.objective-generation-consent' || consent.policyRevision !== 1 || !consent.validExpiry ||
      expectedConsent && consent.consentId !== expectedConsent ||
      expectedControlVersion !== undefined && consent.controlVersion !== expectedControlVersion) return unavailable();
  generationUuid(consent.consentId); generationUuid(consent.membershipId);
  const configured = milliseconds(consent.configured), effective = milliseconds(consent.effective);
  if (effective < 1 || configured < effective || configured > 1800000 || !Number.isInteger(consent.controlVersion) ||
      consent.controlVersion < 1 || consent.controlVersion > 2147483647) return unavailable();
  const nowMs = await clock(tx), expiresAtMs = milliseconds(consent.expiresMs);
  if (milliseconds(consent.confirmedMs) > nowMs || expiresAtMs <= nowMs) return unavailable();
  return { canonical: expected, actorUserId, membershipId: consent.membershipId, rootActorUserId: root.rootActorUserId,
    consentId: consent.consentId, controlVersion: consent.controlVersion, nowMs, expiresAtMs };
}
/** Caller creates the real Objective job in this same tx first, and verifies
 * paired canonical provenance for an existing Strategy before model dispatch.
 * Only this database-derived admission may be protected in Meri prepared facts. */
export async function admitCanonicalGenerationWithinTx(tx: Tx, input: CanonicalGenerationScope): Promise<CanonicalGenerationAdmission> {
  const s = scope(input), job = await jobGate(tx, s, 'admission'), c = await canonicalHint(tx, s);
  const expectedStrategyVersionId = await strategyHead(tx, s, c, true);
  const facts = await currentFacts(tx, s, c);
  const effectExpiresAtMs = Math.min(facts.expiresAtMs, milliseconds(job.deadlineMs));
  if (effectExpiresAtMs <= facts.nowMs) return unavailable();
  const request = job.input.objectiveGeneration.request;
  if (request.objective.objectiveVersion !== c.requestedObjectiveVersion) return stale();
  return parseCanonicalGenerationAdmission({ schemaVersion: 1, namespace: GENERATION_ADMISSION_NAMESPACE, canonical: c,
    actorUserId: facts.actorUserId, clerkUserId: s.clerkUserId, consentId: facts.consentId, controlVersion: facts.controlVersion,
    generationJobId: job.id, generationRequestId: s.generationRequestId, admittedAtMs: facts.nowMs,
    effectExpiresAtMs, expectedStrategyVersionId });
}
/** Existing worker additionally verifies its exact claim token/attempt before
 * calling. After-write reads saved IDs from the real completed job receipt;
 * it never accepts a supplied output ID or treats a model result as committed. */
export async function requireCanonicalGenerationEffectWithinTx(tx: Tx, raw: unknown,
  actual: { generationJobId: string; generationRequestId: string }, phase: 'before-write' | 'after-write' = 'before-write') {
  const a = parseCanonicalGenerationAdmission(raw);
  if (phase !== 'before-write' && phase !== 'after-write') return unavailable();
  if (actual.generationJobId !== a.generationJobId || actual.generationRequestId !== a.generationRequestId) return unavailable();
  const s = scope({ tenantId: a.canonical.tenantId, clientId: a.canonical.clientId, objectiveId: a.canonical.objectiveId,
    clerkUserId: a.clerkUserId, generationJobId: a.generationJobId, generationRequestId: a.generationRequestId });
  const job = await jobGate(tx, s, phase), latest = await strategyHead(tx, s, a.canonical, false);
  if (job.input.objectiveGeneration.request.objective.objectiveVersion !== a.canonical.requestedObjectiveVersion) return stale();
  if (phase === 'before-write') {
    if (latest !== a.expectedStrategyVersionId || job.strategyId !== null) return stale();
  } else {
    const result = job.input.objectiveGeneration.receipt?.result;
    if (!result || job.strategyId !== a.canonical.canonicalStrategyId || result.strategyId !== job.strategyId ||
        result.strategyVersionId !== latest) return unavailable();
    generationUuid(result.strategyVersionId);
    const versions = await tx.$queryRaw<Array<{ snapshot: any; authorKind: string; coalescible: boolean }>>`
      SELECT snapshot,author_kind::text AS "authorKind",coalescible FROM sp_version
      WHERE tenant_id=${s.tenantId}::uuid AND strategy_id=${job.strategyId}::uuid AND id=${latest}::uuid FOR SHARE`;
    if (versions.length !== 1 || versions[0]!.authorKind !== 'meri' || versions[0]!.coalescible ||
        versions[0]!.snapshot?.meta?.id !== job.strategyId || versions[0]!.snapshot?.meta?.clientId !== s.clientId) return unavailable();
  }
  const facts = await currentFacts(tx, s, a.canonical, a.actorUserId, a.consentId, a.controlVersion);
  if (facts.nowMs < a.admittedAtMs || facts.nowMs >= a.effectExpiresAtMs ||
      facts.nowMs >= milliseconds(job.deadlineMs)) return unavailable();
  return facts;
}
/** Current retained-read authority only. Old consent expiry/head/source version
 * never becomes a fresh effect grant, and current visibility cannot be inferred
 * from the stored admission. The caller separately validates/filter outputs. */
export async function requireCanonicalGenerationReadWithinTx(tx: Tx, raw: unknown, currentClerkUserId: string) {
  const a = parseCanonicalGenerationAdmission(raw), c = a.canonical;
  if (currentClerkUserId !== a.clerkUserId) return unavailable();
  const rows = await tx.$queryRaw<Array<{ actorUserId: string; memoryWall: boolean }>>`
    SELECT u.id::text AS "actorUserId",c.memory_wall AS "memoryWall"
    FROM tenants t JOIN tenant_memberships m ON m.tenant_id=t.id JOIN users u ON u.id=m.user_id JOIN clients c ON c.tenant_id=t.id
    WHERE t.id=${c.tenantId}::uuid AND t.status::text='active' AND m.status::text='active'
      AND t.settings_jsonb->'clioFeatureFlags'->'strategyPlanner.enabled'='true'::jsonb
      AND m.role::text IN ('standard_user','user_admin','capiro_admin') AND u.id=${a.actorUserId}::uuid
      AND u.clerk_user_id=${currentClerkUserId} AND c.id=${c.clientId}::uuid AND c.status::text<>'archived'
    FOR SHARE OF t,m,u,c`;
  if (rows.length !== 1 || rows[0]!.actorUserId !== a.actorUserId) return unavailable();
  if (rows[0]!.memoryWall) {
    const walls = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM client_memory_access
      WHERE tenant_id=${c.tenantId}::uuid AND client_id=${c.clientId}::uuid AND user_id=${a.actorUserId}::uuid FOR SHARE`;
    if (walls.length !== 1) return unavailable();
  }
  const objectives = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM client_objectives
    WHERE tenant_id=${c.tenantId}::uuid AND client_id=${c.clientId}::uuid AND id=${c.objectiveId}::uuid
      AND deleted_at IS NULL FOR SHARE`;
  if (objectives.length !== 1) return unavailable();
}
