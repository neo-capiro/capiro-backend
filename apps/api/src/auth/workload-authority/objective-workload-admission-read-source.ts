import { types as nodeTypes } from 'node:util';
import { objectiveRevisionSnapshotHash as hash } from '../../clients/objectives/objective-work-intent.js';
import { ObjectiveCurrentSourceUnavailable, type ObjectiveCurrentTx,
  type ObjectiveCurrentSourceOptions } from './objective-workload-current.js';
import { decideObjectiveLaterCurrentWithinTx, type ObjectiveLaterCurrentTx,
  type ObjectiveLaterSelector, type ObjectiveLaterAdmission, type ObjectiveLaterNative,
  type ObjectiveLaterJob, type ObjectiveLaterDelegation } from './objective-workload-later-current.js';

const unavailable = (): never => { throw new ObjectiveCurrentSourceUnavailable(); };
const KIND = 'objective_canonical_generation_admission';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ADMISSION_KEYS = ['schemaVersion','namespace','canonical','actorUserId','clerkUserId',
  'consentId','controlVersion','generationJobId','generationRequestId','admittedAtMs',
  'effectExpiresAtMs','expectedStrategyVersionId'];
const CANONICAL_KEYS = ['canonicalPlanId','tenantId','clientId','objectiveId','canonicalStrategyId',
  'canonicalProjectId','bindingVersion','epoch','requestedIntentId','requestedObjectiveRevisionId',
  'requestedObjectiveVersion','snapshotHash'];

function record(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || nodeTypes.isProxy(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return unavailable();
  const own = Reflect.ownKeys(raw);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return unavailable();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d?.enumerable || !('value' in d)) return unavailable();
    copy[key] = d.value;
  }
  return copy;
}
function one<T>(rows: T[]): T {
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]) return unavailable();
  return rows[0];
}
function milliseconds(raw: unknown): number {
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) return unavailable();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 8_640_000_000_000_000) return unavailable();
  return value;
}

/** Source-only adapter for an already-open tenant transaction. The caller must
 * retain this transaction through its own authority/issuance checks. No route
 * mounts this function, and it cannot enable a DB-fenced delegation. It never
 * infers acceptance absence or permits a second effect from a historical read.
 * Domain checks stay in the existing later-current kernel; this adapter owns
 * SQL predicates, private resource custody and original consent association. */
export async function loadObjectiveAdmissionReadCurrentFactsWithinTx(
  tx: ObjectiveCurrentTx,
  selector: ObjectiveLaterSelector,
  options?: ObjectiveCurrentSourceOptions,
) {
  // Inspect the phase without evaluating a caller accessor. The kernel checks
  // the complete selector and enable/policy options before the first SQL call.
  if (!selector || typeof selector !== 'object' || nodeTypes.isProxy(selector)) return unavailable();
  const phase = Object.getOwnPropertyDescriptor(selector, 'phase');
  if (!phase || !('value' in phase) || phase.value !== 'admission-read') return unavailable();
  let originalControlId: string | undefined;
  const source: ObjectiveLaterCurrentTx = {
    async lockJob(s) {
      const row = one(await tx.$queryRaw<Array<Omit<ObjectiveLaterJob, 'deadlineAtMs'> & { deadlineAtMs: string }>>`
        SELECT id::text AS id,tenant_id::text AS "tenantId",client_id::text AS "clientId",
          owner_user_id AS "clerkUserId",status::text AS status,attempt,claimed_by AS "claimedBy",
          claimed_at AS "claimedAt",strategy_id::text AS "strategyId",request_key AS "requestKey",input,
          floor(extract(epoch FROM deadline_at)*1000)::text AS "deadlineAtMs"
        FROM sp_draft_job WHERE tenant_id=${s.tenantId}::uuid AND id=${s.generationJobId}::uuid FOR UPDATE`);
      return { ...row, deadlineAtMs: milliseconds(row.deadlineAtMs) };
    },
    async readAdmission(s, job) {
      const digest = hash([KIND,s.tenantId,job.clerkUserId,job.id]);
      const id = `${digest.slice(0,8)}-${digest.slice(8,12)}-8${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`;
      const row = one(await tx.$queryRaw<Array<{ id: string; tenantId: string; ownerId: string; kind: string;
        projectId: string | null; version: number; archived: boolean; shareTokenHash: string | null; data: unknown }>>`
        SELECT id::text AS id,tenant_id::text AS "tenantId",owner_id AS "ownerId",kind,
          project_id::text AS "projectId",version,archived,share_token_hash AS "shareTokenHash",data
        FROM sp_planner_resources WHERE tenant_id=${s.tenantId}::uuid AND id=${id}::uuid FOR SHARE`);
      if (row.id !== id || row.tenantId !== s.tenantId || row.ownerId !== job.clerkUserId || row.kind !== KIND ||
          row.projectId !== null || row.version !== 1 || row.archived !== false || row.shareTokenHash !== null) return unavailable();
      const data = record(row.data, ADMISSION_KEYS);
      const canonical = record(data.canonical, CANONICAL_KEYS);
      // The kernel validates every admission field and its job/tenant binding.
      return Object.freeze({ ...data, canonical: Object.freeze(canonical) }) as unknown as ObjectiveLaterAdmission;
    },
    async readCurrentNative(s, a) {
      const c = a.canonical;
      const row = one(await tx.$queryRaw<Array<{ tenantId: string; clientId: string; objectiveId: string;
        actorUserId: string; membershipId: string; clerkUserId: string; controlId: string; memoryWall: boolean }>>`
        SELECT t.id::text AS "tenantId",c.id::text AS "clientId",o.id::text AS "objectiveId",
          u.id::text AS "actorUserId",m.id::text AS "membershipId",u.clerk_user_id AS "clerkUserId",
          cs.control_id::text AS "controlId",c.memory_wall AS "memoryWall"
        FROM client_objective_work_consents cs
        JOIN tenants t ON t.id=cs.tenant_id
        JOIN tenant_memberships m ON m.tenant_id=t.id AND m.id=cs.consenting_membership_id
          AND m.user_id=cs.consenting_actor_user_id
        JOIN users u ON u.id=m.user_id
        JOIN clients c ON c.tenant_id=t.id AND c.id=cs.client_id
        JOIN client_objectives o ON o.tenant_id=t.id AND o.client_id=c.id AND o.id=cs.objective_id
        WHERE cs.tenant_id=${s.tenantId}::uuid AND cs.id=${s.consentId}::uuid
          AND cs.client_id=${c.clientId}::uuid AND cs.objective_id=${c.objectiveId}::uuid
          AND cs.work_action='objective.strategy.draft' AND cs.consenting_actor_user_id=${a.actorUserId}::uuid
          AND cs.canonical_plan_id=${c.canonicalPlanId}::uuid AND cs.canonical_epoch=${c.epoch}
          AND cs.canonical_strategy_id=${c.canonicalStrategyId}::uuid AND cs.canonical_project_id=${c.canonicalProjectId}::uuid
          AND cs.canonical_binding_version=${c.bindingVersion} AND cs.root_intent_id=${c.requestedIntentId}::uuid
          AND cs.source_revision_id=${c.requestedObjectiveRevisionId}::uuid
          AND cs.source_objective_version=${c.requestedObjectiveVersion} AND cs.source_snapshot_hash=${c.snapshotHash}
          AND cs.consent_policy_id='capiro.objective-generation-consent' AND cs.consent_policy_revision=1
          AND t.status::text='active' AND t.settings_jsonb->'clioFeatureFlags'->'strategyPlanner.enabled'='true'::jsonb
          AND m.status::text='active' AND m.role::text IN ('standard_user','user_admin','capiro_admin')
          AND u.clerk_user_id=${a.clerkUserId} AND c.status::text<>'archived' AND o.deleted_at IS NULL
        FOR SHARE OF cs,t,m,u,c,o`);
      if (typeof row.controlId !== 'string' || UUID.exec(row.controlId)?.[0] !== row.controlId) return unavailable();
      originalControlId = row.controlId;
      if (row.memoryWall === true) {
        const wall = one(await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id::text AS id FROM client_memory_access WHERE tenant_id=${s.tenantId}::uuid
            AND client_id=${c.clientId}::uuid AND user_id=${a.actorUserId}::uuid FOR SHARE`);
        if (typeof wall.id !== 'string' || UUID.exec(wall.id)?.[0] !== wall.id) return unavailable();
      } else if (row.memoryWall !== false) return unavailable();
      return { tenantId: row.tenantId, clientId: row.clientId, objectiveId: row.objectiveId,
        actorUserId: row.actorUserId, membershipId: row.membershipId, clerkUserId: row.clerkUserId,
        tenantActive: true, membershipActive: true, roleAllowed: true, featureEnabled: true,
        clientActive: true, wallAllowed: true, objectiveExists: true } satisfies ObjectiveLaterNative;
    },
    async lockDelegation(s) {
      const row = one(await tx.$queryRaw<Array<Omit<ObjectiveLaterDelegation, 'issuedAtMs' | 'absoluteExpiresAtMs'> & {
        issuedAtMs: string; absoluteExpiresAtMs: string }>>`
        SELECT delegation_ref::text AS ref,tenant_id::text AS "tenantId",client_id::text AS "clientId",
          objective_id::text AS "objectiveId",work_action AS action,control_id::text AS "controlId",
          consent_id::text AS "consentId",control_version AS "controlVersion",generation_job_id::text AS "generationJobId",
          generation_request_id::text AS "generationRequestId",generation_request_fingerprint AS "generationRequestFingerprint",
          job_request_key AS "jobRequestKey",clerk_user_id AS "clerkUserId",service_subject AS "serviceSubject",audience,
          policy_revision AS "policyRevision",floor(extract(epoch FROM issued_at)*1000)::text AS "issuedAtMs",
          floor(extract(epoch FROM absolute_expires_at)*1000)::text AS "absoluteExpiresAtMs",
          authority_version AS "authorityVersion",enabled,cancelled_at AS "cancelledAt"
        FROM client_objective_workload_delegations WHERE tenant_id=${s.tenantId}::uuid
          AND delegation_ref=${s.delegationRef}::uuid AND consent_id=${s.consentId}::uuid
          AND generation_job_id=${s.generationJobId}::uuid FOR UPDATE`);
      if (!originalControlId || row.controlId !== originalControlId) return unavailable();
      return { ...row, issuedAtMs: milliseconds(row.issuedAtMs), absoluteExpiresAtMs: milliseconds(row.absoluteExpiresAtMs) };
    },
    async databaseNowMs() {
      const row = one(await tx.$queryRaw<Array<{ nowMs: string }>>`
        SELECT ceil(extract(epoch FROM clock_timestamp())*1000)::text AS "nowMs"`);
      return milliseconds(row.nowMs);
    },
    // This adapter cannot accidentally become a later-phase source when the
    // kernel grows: every unrelated source capability remains unavailable.
    readCurrentEffect: async () => unavailable(), readPublication: async () => unavailable(),
    readAcceptance: async () => unavailable(), readTerminalNoWrites: async () => unavailable(),
    readRetainedOutcome: async () => unavailable(),
  };
  return decideObjectiveLaterCurrentWithinTx(source, selector, options);
}
