import { types as nodeTypes } from 'node:util';
import { objectiveRevisionSnapshotHash } from '../../clients/objectives/objective-work-intent.js';

/** Source-only admission database observation. This is neither caller
 * authentication nor a token or permission to run a model. The proposed
 * delegation table is DB-disabled; the default is unavailable. Publish must
 * separately establish retained admission and canonicalGeneration markers. */
export type ObjectivePreacceptancePhase = 'admit';
export interface ObjectivePreacceptanceSelector {
  tenantId: string;
  delegationRef: string;
  consentId: string;
  generationJobId: string;
  phase: ObjectivePreacceptancePhase;
}
export interface ObjectiveCurrentSourceOptions {
  enabled: boolean;
  /** Operator-pinned digest of the reviewed, exact Objective workload policy. */
  policyRevision: string;
}
export interface ObjectiveCurrentTx {
  $queryRaw<T>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}
export interface ObjectivePreacceptanceFacts {
  readonly tenantId: string;
  readonly clientId: string;
  readonly objectiveId: string;
  readonly actorUserId: string;
  readonly membershipId: string;
  readonly clerkUserId: string;
  readonly objectiveRevisionId: string;
  readonly objectiveVersion: number;
  readonly canonicalPlanId: string;
  readonly canonicalStrategyId: string;
  readonly canonicalProjectId: string;
  readonly canonicalBindingVersion: number;
  readonly consentId: string;
  readonly controlId: string;
  readonly controlVersion: number;
  readonly delegationRef: string;
  readonly authorityVersion: number;
  readonly generationJobId: string;
  readonly generationRequestId: string;
  readonly generationRequestFingerprint: string;
  readonly policyRevision: string;
  readonly checkedAtMs: number;
  readonly consentExpiresAtMs: number;
  readonly delegationExpiresAtMs: number;
  readonly jobDeadlineAtMs: number;
  readonly effectExpiresAtMs: number;
}

type Job = { id: string; clientId: string; clerkUserId: string; status: string;
  attempt: number; claimedBy: string | null; claimedAt: unknown; strategyId: string | null;
  requestKey: string; input: any; deadlineAtMs: string };
type ConsentHint = { actorUserId: string; membershipId: string; objectiveVersion: number };
type Member = { actorUserId: string; membershipId: string; memoryWall: boolean };
type Objective = { version: number; status: string; revisionId: string };
type Canonical = { id: string; strategyId: string; projectId: string; epoch: number; bindingVersion: number;
  intentId: string; revisionId: string; objectiveVersion: number; snapshotHash: string };
type Root = { actorUserId: string; revisionActorUserId: string; revisionId: string; objectiveVersion: number;
  snapshotHash: string; purpose: string; state: string; blockedReason: string; operation: string; snapshot: any };
type Consent = { controlId: string; controlVersion: number; consentId: string; actorUserId: string; membershipId: string;
  rootActorUserId: string; canonicalPlanId: string; canonicalEpoch: number; strategyId: string; projectId: string;
  bindingVersion: number; intentId: string; revisionId: string; objectiveVersion: number; snapshotHash: string;
  policyId: string; policyRevision: number; confirmedAtMs: string; expiresAtMs: string; configuredMs: string;
  effectiveMs: string; expiryValid: boolean };
type Delegation = { ref: string; clientId: string; objectiveId: string; action: string; controlId: string;
  consentId: string; controlVersion: number; jobId: string; requestId: string; fingerprint: string;
  requestKey: string; clerkUserId: string; serviceSubject: string; audience: string; policyRevision: string;
  issuedAtMs: string; expiresAtMs: string; authorityVersion: number; enabled: boolean; cancelledAt: unknown };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const SELECTOR_KEYS = ['tenantId', 'delegationRef', 'consentId', 'generationJobId', 'phase'];
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
export class ObjectiveCurrentSourceUnavailable extends Error {
  constructor() { super('Objective current source unavailable'); }
}
const unavailable = (): never => { throw new ObjectiveCurrentSourceUnavailable(); };

function selector(raw: ObjectivePreacceptanceSelector): ObjectivePreacceptanceSelector {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || nodeTypes.isProxy(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
      Reflect.ownKeys(raw).length !== SELECTOR_KEYS.length) return unavailable();
  const captured: Record<string, unknown> = Object.create(null);
  for (const key of SELECTOR_KEYS) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d || !d.enumerable || !('value' in d)) return unavailable();
    captured[key] = d.value;
  }
  if (Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !SELECTOR_KEYS.includes(key)) ||
      ![captured.tenantId, captured.delegationRef, captured.consentId, captured.generationJobId]
        .every(value => typeof value === 'string' && UUID.test(value)) ||
      captured.phase !== 'admit') return unavailable();
  return captured as unknown as ObjectivePreacceptanceSelector;
}
function one<T>(rows: T[]): T {
  return Array.isArray(rows) && rows.length === 1 && rows[0] ? rows[0] : unavailable();
}
function ms(value: unknown): number {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : unavailable();
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2147483647;
}

/** Must run in an already tenant-scoped transaction, after authenticating the
 * named caller. The caller later rechecks this observation under its actual
 * effect/issuance lock and verifies immutable operation replay separately.
 * Lock order here is job -> native scope -> canonical -> control -> delegation.
 * Every raw SQL statement has an explicit tenant predicate because the app
 * role can bypass RLS even inside withTenant(). No remote I/O runs here. */
export async function loadObjectivePreacceptanceCurrentFactsWithinTx(
  tx: ObjectiveCurrentTx,
  rawSelector: ObjectivePreacceptanceSelector,
  options?: ObjectiveCurrentSourceOptions,
): Promise<Readonly<ObjectivePreacceptanceFacts>> {
  if (options?.enabled !== true || typeof options.policyRevision !== 'string' ||
      !HASH.test(options.policyRevision)) return unavailable();
  const s = selector(rawSelector);
  try {
    const job = one(await tx.$queryRaw<Job[]>`SELECT id::text AS id,client_id::text AS "clientId",
      owner_user_id AS "clerkUserId",status::text AS status,attempt,claimed_by AS "claimedBy",
      claimed_at AS "claimedAt",strategy_id::text AS "strategyId",request_key AS "requestKey",input,
      floor(extract(epoch FROM deadline_at)*1000)::text AS "deadlineAtMs"
      FROM sp_draft_job WHERE tenant_id=${s.tenantId}::uuid AND id=${s.generationJobId}::uuid FOR UPDATE`);
    const request = job.input?.objectiveGeneration?.request;
    if (job.id !== s.generationJobId || !UUID.test(job.clientId) ||
        typeof job.clerkUserId !== 'string' || !job.clerkUserId || job.clerkUserId.length > 128 ||
        job.status !== 'queued' || job.attempt !== 1 || job.claimedBy !== null ||
        job.claimedAt !== null || job.strategyId !== null || !request ||
        typeof request !== 'object' || Array.isArray(request) ||
        !UUID.test(request.requestId) || request.clientId !== job.clientId ||
        !UUID.test(request.objective?.objectiveId) || !positive(request.objective?.objectiveVersion) ||
        // Core and Strategy hash ordinary stored JSON using the same sorted
        // object-key convention; focused vectors check this source parity.
        job.input.objectiveGeneration.fingerprint !== objectiveRevisionSnapshotHash(request) ||
        job.requestKey !== `objective-v1:${objectiveRevisionSnapshotHash([s.tenantId, job.clerkUserId, request.requestId])}`)
      return unavailable();
    const objectiveId = request.objective.objectiveId as string;

    // Immutable consent is only a routing hint until the control and exact
    // current consent are locked below. No authority is returned from this read.
    const hint = one(await tx.$queryRaw<ConsentHint[]>`SELECT consenting_actor_user_id::text AS "actorUserId",
      consenting_membership_id::text AS "membershipId",source_objective_version AS "objectiveVersion"
      FROM client_objective_work_consents WHERE tenant_id=${s.tenantId}::uuid AND client_id=${job.clientId}::uuid
        AND objective_id=${objectiveId}::uuid AND work_action='objective.strategy.draft' AND id=${s.consentId}::uuid`);
    if (!UUID.test(hint.actorUserId) || !UUID.test(hint.membershipId) ||
        hint.objectiveVersion !== request.objective.objectiveVersion) return unavailable();
    const member = one(await tx.$queryRaw<Member[]>`SELECT u.id::text AS "actorUserId",m.id::text AS "membershipId",
      c.memory_wall AS "memoryWall" FROM tenants t JOIN tenant_memberships m ON m.tenant_id=t.id
      JOIN users u ON u.id=m.user_id JOIN clients c ON c.tenant_id=t.id
      WHERE t.id=${s.tenantId}::uuid AND t.status::text='active'
        AND t.settings_jsonb->'clioFeatureFlags'->'strategyPlanner.enabled'='true'::jsonb
        AND m.user_id=${hint.actorUserId}::uuid AND m.id=${hint.membershipId}::uuid
        AND m.status::text='active' AND m.role::text IN ('standard_user','user_admin','capiro_admin')
        AND u.clerk_user_id=${job.clerkUserId} AND c.id=${job.clientId}::uuid
        AND c.status::text<>'archived' FOR SHARE OF t,m,u,c`);
    if (member.actorUserId !== hint.actorUserId || member.membershipId !== hint.membershipId) return unavailable();
    if (member.memoryWall) {
      const wall = one(await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM client_memory_access
        WHERE tenant_id=${s.tenantId}::uuid AND client_id=${job.clientId}::uuid
          AND user_id=${hint.actorUserId}::uuid FOR SHARE`);
      if (!UUID.test(wall.id)) return unavailable();
    } else if (member.memoryWall !== false) return unavailable();
    const objective = one(await tx.$queryRaw<Objective[]>`SELECT o.version,o.status::text AS status,
      r.id::text AS "revisionId" FROM client_objectives o JOIN client_objective_revisions r
      ON r.tenant_id=o.tenant_id AND r.client_id=o.client_id AND r.objective_id=o.id AND r.version=o.version
      WHERE o.tenant_id=${s.tenantId}::uuid AND o.client_id=${job.clientId}::uuid
        AND o.id=${objectiveId}::uuid AND o.deleted_at IS NULL FOR SHARE OF o`);
    if (objective.version !== request.objective.objectiveVersion || objective.status !== 'ready' ||
        !UUID.test(objective.revisionId)) return unavailable();
    const canonical = one(await tx.$queryRaw<Canonical[]>`SELECT id::text AS id,
      canonical_strategy_id::text AS "strategyId",canonical_project_id::text AS "projectId",
      epoch,binding_version AS "bindingVersion",requested_intent_id::text AS "intentId",
      requested_objective_revision_id::text AS "revisionId",requested_objective_version AS "objectiveVersion",
      requested_snapshot_hash AS "snapshotHash" FROM client_objective_canonical_plans
      WHERE tenant_id=${s.tenantId}::uuid AND client_id=${job.clientId}::uuid
        AND objective_id=${objectiveId}::uuid FOR UPDATE`);
    if (!UUID.test(canonical.id) || !UUID.test(canonical.strategyId) || !UUID.test(canonical.projectId) ||
        !UUID.test(canonical.intentId) || canonical.epoch !== 1 || !positive(canonical.bindingVersion) ||
        canonical.revisionId !== objective.revisionId ||
        canonical.objectiveVersion !== objective.version || !HASH.test(canonical.snapshotHash)) return unavailable();
    const root = one(await tx.$queryRaw<Root[]>`SELECT i.actor_user_id::text AS "actorUserId",
      r.actor_user_id::text AS "revisionActorUserId",i.objective_revision_id::text AS "revisionId",
      i.objective_version AS "objectiveVersion",i.snapshot_hash AS "snapshotHash",i.purpose,i.state,
      i.blocked_reason AS "blockedReason",r.operation,r.snapshot
      FROM client_objective_work_intents i JOIN client_objective_revisions r
      ON r.tenant_id=i.tenant_id AND r.client_id=i.client_id AND r.objective_id=i.objective_id
        AND r.id=i.objective_revision_id AND r.version=i.objective_version
      WHERE i.tenant_id=${s.tenantId}::uuid AND i.client_id=${job.clientId}::uuid
        AND i.objective_id=${objectiveId}::uuid AND i.id=${canonical.intentId}::uuid`);
    const snapshot = root.snapshot;
    if (root.actorUserId !== root.revisionActorUserId || root.revisionId !== objective.revisionId ||
        root.objectiveVersion !== objective.version || root.snapshotHash !== canonical.snapshotHash ||
        root.purpose !== 'objective_strategy_plan' || root.state !== 'pending' ||
        root.blockedReason !== 'runtime_authority_unconnected' || root.operation !== 'confirm_ready' ||
        !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
        snapshot.id !== objectiveId || snapshot.clientId !== job.clientId ||
        snapshot.version !== objective.version || snapshot.status !== 'ready' ||
        snapshot.deletedAt != null || objectiveRevisionSnapshotHash(snapshot) !== root.snapshotHash)
      return unavailable();
    const consent = one(await tx.$queryRaw<Consent[]>`SELECT ctl.id::text AS "controlId",ctl.version AS "controlVersion",
      cs.id::text AS "consentId",cs.consenting_actor_user_id::text AS "actorUserId",
      cs.consenting_membership_id::text AS "membershipId",cs.root_actor_user_id::text AS "rootActorUserId",
      cs.canonical_plan_id::text AS "canonicalPlanId",cs.canonical_epoch AS "canonicalEpoch",
      cs.canonical_strategy_id::text AS "strategyId",cs.canonical_project_id::text AS "projectId",
      cs.canonical_binding_version AS "bindingVersion",cs.root_intent_id::text AS "intentId",
      cs.source_revision_id::text AS "revisionId",cs.source_objective_version AS "objectiveVersion",
      cs.source_snapshot_hash AS "snapshotHash",cs.consent_policy_id AS "policyId",
      cs.consent_policy_revision AS "policyRevision",
      ceil(extract(epoch FROM cs.confirmed_at)*1000)::text AS "confirmedAtMs",
      floor(extract(epoch FROM cs.expires_at)*1000)::text AS "expiresAtMs",
      cs.configured_duration_ms::text AS "configuredMs",cs.effective_duration_ms::text AS "effectiveMs",
      (cs.expires_at>cs.confirmed_at AND cs.expires_at<=cs.confirmed_at+cs.effective_duration_ms*INTERVAL '1 millisecond'
        AND (cs.stricter_expires_at IS NULL OR cs.expires_at<=cs.stricter_expires_at)) AS "expiryValid"
      FROM client_objective_work_controls ctl JOIN client_objective_work_consents cs
      ON cs.tenant_id=ctl.tenant_id AND cs.client_id=ctl.client_id AND cs.objective_id=ctl.objective_id
        AND cs.work_action=ctl.work_action AND cs.control_id=ctl.id AND cs.id=ctl.current_consent_id
      WHERE ctl.tenant_id=${s.tenantId}::uuid AND ctl.client_id=${job.clientId}::uuid
        AND ctl.objective_id=${objectiveId}::uuid AND ctl.work_action='objective.strategy.draft'
        AND ctl.cancelled_at IS NULL AND cs.id=${s.consentId}::uuid FOR UPDATE OF ctl`);
    if (consent.consentId !== s.consentId || !UUID.test(consent.controlId) ||
        !positive(consent.controlVersion) || consent.actorUserId !== member.actorUserId ||
        consent.membershipId !== member.membershipId || consent.rootActorUserId !== root.actorUserId ||
        consent.canonicalPlanId !== canonical.id || consent.canonicalEpoch !== canonical.epoch ||
        consent.strategyId !== canonical.strategyId || consent.projectId !== canonical.projectId ||
        consent.bindingVersion !== canonical.bindingVersion || consent.intentId !== canonical.intentId ||
        consent.revisionId !== canonical.revisionId || consent.objectiveVersion !== canonical.objectiveVersion ||
        consent.snapshotHash !== canonical.snapshotHash ||
        consent.policyId !== 'capiro.objective-generation-consent' || consent.policyRevision !== 1 ||
        consent.expiryValid !== true) return unavailable();
    const configured = ms(consent.configuredMs), effective = ms(consent.effectiveMs);
    if (effective < 1 || configured < effective || configured > 1_800_000) return unavailable();
    const delegation = one(await tx.$queryRaw<Delegation[]>`SELECT delegation_ref::text AS ref,
      client_id::text AS "clientId",objective_id::text AS "objectiveId",work_action AS action,
      control_id::text AS "controlId",consent_id::text AS "consentId",control_version AS "controlVersion",
      generation_job_id::text AS "jobId",generation_request_id::text AS "requestId",
      generation_request_fingerprint AS fingerprint,job_request_key AS "requestKey",
      clerk_user_id AS "clerkUserId",service_subject AS "serviceSubject",audience,policy_revision AS "policyRevision",
      floor(extract(epoch FROM issued_at)*1000)::text AS "issuedAtMs",
      floor(extract(epoch FROM absolute_expires_at)*1000)::text AS "expiresAtMs",
      authority_version AS "authorityVersion",enabled,cancelled_at AS "cancelledAt"
      FROM client_objective_workload_delegations
      WHERE tenant_id=${s.tenantId}::uuid AND delegation_ref=${s.delegationRef}::uuid
        AND consent_id=${s.consentId}::uuid AND generation_job_id=${s.generationJobId}::uuid FOR UPDATE`);
    if (delegation.ref !== s.delegationRef || delegation.clientId !== job.clientId ||
        delegation.objectiveId !== objectiveId || delegation.action !== 'objective.strategy.draft' ||
        delegation.controlId !== consent.controlId || delegation.consentId !== consent.consentId ||
        delegation.controlVersion !== consent.controlVersion || delegation.jobId !== job.id ||
        delegation.requestId !== request.requestId || delegation.fingerprint !== job.input.objectiveGeneration.fingerprint ||
        delegation.requestKey !== job.requestKey || delegation.clerkUserId !== job.clerkUserId ||
        delegation.serviceSubject !== 'capiro-objective-generation-worker:v1' ||
        delegation.audience !== 'capiro:objective-strategy-api:v1' ||
        delegation.policyRevision !== options.policyRevision || !positive(delegation.authorityVersion) ||
        delegation.enabled !== true || delegation.cancelledAt !== null) return unavailable();

    const clock = one(await tx.$queryRaw<Array<{ nowMs: string }>>`
      SELECT ceil(extract(epoch FROM clock_timestamp())*1000)::text AS "nowMs"`);
    const now = ms(clock.nowMs), confirmed = ms(consent.confirmedAtMs),
      consentExpires = ms(consent.expiresAtMs), delegatedAt = ms(delegation.issuedAtMs),
      delegationExpires = ms(delegation.expiresAtMs), jobDeadline = ms(job.deadlineAtMs);
    if (confirmed > now || delegatedAt < confirmed || delegatedAt > now ||
        delegationExpires <= delegatedAt || delegationExpires > confirmed + ONE_DAY_MS ||
        [consentExpires, delegationExpires, jobDeadline].some(deadline => deadline <= now)) return unavailable();
    return Object.freeze({ tenantId: s.tenantId, clientId: job.clientId, objectiveId,
      actorUserId: member.actorUserId, membershipId: member.membershipId, clerkUserId: job.clerkUserId,
      objectiveRevisionId: objective.revisionId, objectiveVersion: objective.version,
      canonicalPlanId: canonical.id, canonicalStrategyId: canonical.strategyId,
      canonicalProjectId: canonical.projectId, canonicalBindingVersion: canonical.bindingVersion,
      consentId: consent.consentId, controlId: consent.controlId,
      controlVersion: consent.controlVersion,
      delegationRef: delegation.ref, authorityVersion: delegation.authorityVersion,
      generationJobId: job.id, generationRequestId: request.requestId,
      generationRequestFingerprint: delegation.fingerprint, policyRevision: delegation.policyRevision,
      checkedAtMs: now, consentExpiresAtMs: consentExpires, delegationExpiresAtMs: delegationExpires,
      jobDeadlineAtMs: jobDeadline, effectExpiresAtMs: Math.min(consentExpires, delegationExpires, jobDeadline) });
  } catch { return unavailable(); }
}
