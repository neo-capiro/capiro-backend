import type { Prisma } from '../../generated/prisma-client/index.js';
import { readCanonicalSavedGeneration, requireSavedGenerationApplication } from '../meri/objective-canonical-saved-generation.js';
import { applicationHash, CanonicalApplicationError, type CanonicalApplicationGrant } from './objective-canonical-application.js';
import { producerApplication } from '../meri/objective-canonical-producer.js';
import { savedGenerationPlannerContinuation } from './objective-canonical-continuation.js';
import { requireCanonicalApplicationFence, requireCanonicalApplicationRead } from './objective-canonical-fence.js';
import { readPlannerContinuationOperationWithinTx, type StoredPlannerContinuationOperation } from './objective-planner-continuation.store.js';

type Tx = Prisma.TransactionClient;
type Saved = Awaited<ReturnType<typeof readCanonicalSavedGeneration>>;
export const PLANNER_CONTINUATION_WORKER = 'capiro-objective-planner-continuation-worker:v1';
const unavailable = (): never => { throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE'); };
function generationDeadline(saved: Saved): number {
  const caps = [saved.admission.effectExpiresAtMs, saved.acceptance.issuance.expiresAtMs];
  if (caps.some(value => !Number.isSafeInteger(value) || value < 0)) return unavailable();
  return Math.min(...caps);
}

export async function plannerContinuationDatabaseNow(tx: Tx): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ ms: string }>>`
    SELECT ceil(extract(epoch FROM clock_timestamp())*1000)::text AS ms`;
  const value = Number(rows[0]?.ms);
  if (rows.length !== 1 || !Number.isSafeInteger(value) || value < 0) return unavailable();
  return value;
}

/** Named in-process owner admission. No Request, user token, digest or secret
 * is promoted to a workload credential. The owner must hold Planner -> job
 * locks, read the real saved generation, and recheck the existing effect fence.
 * The external generation JWT/delegation contract is deliberately untouched. */
export async function readPlannerContinuationConsentWithinTx(tx: Tx, saved: Saved) {
  const a = saved.admission, c = a.canonical;
  const rows = await tx.$queryRaw<Array<{ consentId: string; controlVersion: number; membershipId: string; expiresAtMs: string }>>`
    SELECT cs.id::text AS "consentId", ctl.version AS "controlVersion",
      cs.consenting_membership_id::text AS "membershipId",
      floor(extract(epoch FROM cs.expires_at)*1000)::text AS "expiresAtMs"
    FROM client_objective_work_controls ctl JOIN client_objective_work_consents cs
      ON cs.tenant_id=ctl.tenant_id AND cs.client_id=ctl.client_id AND cs.objective_id=ctl.objective_id
      AND cs.work_action=ctl.work_action AND cs.control_id=ctl.id AND cs.id=ctl.current_consent_id
    WHERE ctl.tenant_id=${c.tenantId}::uuid AND ctl.client_id=${c.clientId}::uuid
      AND ctl.objective_id=${c.objectiveId}::uuid AND ctl.work_action='objective.plan.prepare'
      AND ctl.cancelled_at IS NULL AND cs.consenting_actor_user_id=${a.actorUserId}::uuid
      AND cs.canonical_plan_id=${c.canonicalPlanId}::uuid AND cs.canonical_epoch=${c.epoch}
      AND cs.canonical_strategy_id=${c.canonicalStrategyId}::uuid AND cs.canonical_project_id=${c.canonicalProjectId}::uuid
      AND cs.canonical_binding_version=${c.bindingVersion} AND cs.root_intent_id=${c.requestedIntentId}::uuid
      AND cs.source_revision_id=${c.requestedObjectiveRevisionId}::uuid
      AND cs.source_objective_version=${c.requestedObjectiveVersion} AND cs.source_snapshot_hash=${c.snapshotHash}`;
  const row = rows[0], consentDeadline = Number(row?.expiresAtMs);
  if (rows.length !== 1 || !row || !Number.isSafeInteger(consentDeadline) || consentDeadline < 0) return unavailable();
  // The Planner consent cannot renew the saved generation's original effect
  // authority. These are the same immutable caps used by the Producer owner.
  const deadline = Math.min(consentDeadline, generationDeadline(saved));
  const work = savedGenerationPlannerContinuation(saved, { workAction: 'objective.plan.prepare',
    tenantId: c.tenantId, actorUserId: a.actorUserId, clerkUserId: a.clerkUserId, canonical: c,
    consentId: row.consentId, controlVersion: row.controlVersion });
  return { work, membershipId: row.membershipId, originalDeadlineAt: new Date(deadline).toISOString() };
}

/** Current native authority is read on every admission/release. The exact
 * original membership is retained; a replacement membership is not adopted. */
async function native(tx: Tx, stored: StoredPlannerContinuationOperation) {
  const d = stored.data, w = d.work, c = w.canonical;
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT m.id::text AS id FROM tenant_memberships m
    JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id
    WHERE m.tenant_id=${c.tenantId}::uuid AND m.id=${d.membershipId}::uuid
      AND m.user_id=${w.actorUserId}::uuid AND u.clerk_user_id=${d.clerkUserId}
      AND m.status::text='active' AND m.role::text IN ('standard_user','user_admin','capiro_admin')
      AND t.status::text='active'
      AND t.settings_jsonb->'objectivePlannerContinuation'->'enabled'='true'::jsonb
    FOR SHARE OF m,u,t`;
  if (rows.length !== 1 || rows[0]!.id !== d.membershipId) return unavailable();
}

/** Concrete local delegation: the private owner row, fixed work/consent,
 * original deadline and current lease are checked under the Planner gate.
 * This grant never crosses HTTP and cannot authorize a generation phase. */
export async function plannerContinuationGrantWithinTx(tx: Tx, expected: StoredPlannerContinuationOperation,
  purpose: 'effect' | 'retained-result-read', leaseToken: string | null): Promise<CanonicalApplicationGrant> {
  const actual = await readPlannerContinuationOperationWithinTx(tx, { tenantId: expected.tenantId,
    clerkUserId: expected.ownerId, operationId: expected.id });
  if (!actual || applicationHash(actual.data.original) !== applicationHash(expected.data.original) ||
      applicationHash(actual.data.work) !== applicationHash(expected.data.work) ||
      actual.data.membershipId !== expected.data.membershipId) return unavailable();
  const d = actual.data, w = d.work, request = producerApplication(w);
  // Preserve the existing materializer's Planner -> job -> Strategy -> saved
  // version -> Core order. Saved-generation reconstruction alone is a plain
  // read and does not establish either of these row locks.
  const strategies = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM sp_strategy
    WHERE tenant_id=${actual.tenantId}::uuid AND client_id=${w.canonical.clientId}::uuid
      AND id=${w.strategyId}::uuid FOR SHARE`;
  const versions = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM sp_version
    WHERE tenant_id=${actual.tenantId}::uuid AND strategy_id=${w.strategyId}::uuid
      AND id=${w.strategyVersionId}::uuid FOR SHARE`;
  if (strategies.length !== 1 || strategies[0]!.id !== w.strategyId ||
      versions.length !== 1 || versions[0]!.id !== w.strategyVersionId) return unavailable();
  await native(tx, actual);
  const now = await plannerContinuationDatabaseNow(tx);
  const deadline = Date.parse(d.original.originalDeadlineAt);
  if (purpose === 'effect' && (d.state !== 'leased' || d.lease?.token !== leaseToken ||
      d.lease.expiresAtMs <= now || deadline <= now)) return unavailable();
  if (purpose === 'effect') {
    const saved = await readCanonicalSavedGeneration(tx, { tenantId: actual.tenantId,
      clerkUserId: actual.ownerId, generationJobId: w.generationJobId });
    requireSavedGenerationApplication(saved, w.actorUserId, request);
    if (deadline > generationDeadline(saved)) return unavailable();
  }
  // A fresh retained read is bookkeeping only. It does not extend the original
  // operation deadline, revive a lease, or permit a new Planner write.
  const readUntil = now + 30_000;
  const grant: CanonicalApplicationGrant = { tenantId: actual.tenantId, actorUserId: w.actorUserId,
    clerkUserId: actual.ownerId, consentId: w.consentId, controlVersion: w.controlVersion,
    requestSha256: applicationHash(request), canonicalSha256: applicationHash(w.canonical),
    tokenExpiresAtMs: purpose === 'effect' ? deadline : readUntil,
    delegationExpiresAtMs: purpose === 'effect' ? deadline : readUntil,
    claimExpiresAtMs: purpose === 'effect' ? d.lease!.expiresAtMs : readUntil };
  if (purpose === 'effect') await requireCanonicalApplicationFence(tx, grant, request);
  else await requireCanonicalApplicationRead(tx, grant, w.canonical);
  return grant;
}
