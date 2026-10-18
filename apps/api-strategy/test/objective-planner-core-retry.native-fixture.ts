import type { TenantContext } from '@capiro/shared';
import type { PrismaService as CorePrismaService } from '../../api/src/prisma/prisma.service.js';
import { ClientObjectivesService } from '../../api/src/clients/objectives/objectives.service.js';
import { requireCanonicalObjectiveFence, type CanonicalObjectivePlanToken } from '../../api/src/clients/objectives/objective-canonical-plan.js';
import { objectiveRevisionSnapshotHash, OBJECTIVE_WORK_BLOCKER, OBJECTIVE_WORK_PURPOSE } from '../../api/src/clients/objectives/objective-work-intent.js';
import { applicationHash, applicationJson } from '../src/planner/objective-canonical-application.js';
import type { ObjectivePlannerNativeFixture } from './objective-planner-native-fixture.js';

type Row = Record<string, any>;
type CoreTx = Parameters<Parameters<CorePrismaService['withTenant']>[1]>[0];
type Draft = Awaited<ReturnType<ClientObjectivesService['update']>>;
type Ready = Awaited<ReturnType<ClientObjectivesService['transition']>>;
export interface ObjectivePlannerNativeOriginalSource {
  canonical: CanonicalObjectivePlanToken;
  revision: Row;
  intent: Row;
  plannerControl: Row;
  plannerConsent: Row;
  plannerCommandReceipt: Row;
}
export interface ObjectivePlannerNativeReadySource {
  tenantId: string;
  actorUserId: string;
  clerkUserId: string;
  membershipId: string;
  source: ObjectivePlannerNativeFixture['source'];
  canonical: CanonicalObjectivePlanToken;
  objectiveSnapshot: Row;
  draft: Draft;
  ready: Ready;
  revision: Row;
  intent: Row;
  original: ObjectivePlannerNativeOriginalSource;
}
const copy = <T>(value: T): T => JSON.parse(applicationJson(value)) as T;
const fail = (): never => { throw Error('Native changed Objective source fixture is unconfirmed'); };
function token(p: Row): CanonicalObjectivePlanToken {
  return { canonicalPlanId: p.id, tenantId: p.tenant_id, clientId: p.client_id, objectiveId: p.objective_id,
    canonicalStrategyId: p.canonical_strategy_id, canonicalProjectId: p.canonical_project_id,
    bindingVersion: p.binding_version, epoch: p.epoch, requestedIntentId: p.requested_intent_id,
    requestedObjectiveRevisionId: p.requested_objective_revision_id, requestedObjectiveVersion: p.requested_objective_version,
    snapshotHash: p.requested_snapshot_hash };
}
async function originalWithinTx(tx: CoreTx, original: { canonical: CanonicalObjectivePlanToken;
  actorUserId: string; plannerControlId: string; plannerConsentId: string }): Promise<ObjectivePlannerNativeOriginalSource> {
  const c = original.canonical;
  const rows = await tx.$queryRaw<Array<{ revision: Row; intent: Row; plannerControl: Row;
    plannerConsent: Row; plannerCommandReceipt: Row }>>`
    SELECT to_jsonb(v) AS revision,to_jsonb(i) AS intent,to_jsonb(ctl) AS "plannerControl",
      to_jsonb(cs) AS "plannerConsent",to_jsonb(r) AS "plannerCommandReceipt"
    FROM client_objective_revisions v
    JOIN client_objective_work_intents i ON i.tenant_id=v.tenant_id AND i.client_id=v.client_id AND i.objective_id=v.objective_id
      AND i.objective_revision_id=v.id AND i.objective_version=v.version
    JOIN client_objective_work_controls ctl ON ctl.tenant_id=v.tenant_id AND ctl.client_id=v.client_id AND ctl.objective_id=v.objective_id
      AND ctl.work_action='objective.plan.prepare' AND ctl.id=${original.plannerControlId}::uuid
    JOIN client_objective_work_consents cs ON cs.tenant_id=ctl.tenant_id AND cs.client_id=ctl.client_id AND cs.objective_id=ctl.objective_id
      AND cs.work_action=ctl.work_action AND cs.control_id=ctl.id AND cs.id=${original.plannerConsentId}::uuid
    JOIN client_objective_work_command_receipts r ON r.tenant_id=cs.tenant_id AND r.client_id=cs.client_id AND r.objective_id=cs.objective_id
      AND r.work_action=cs.work_action AND r.control_id=cs.control_id AND r.id=cs.command_receipt_id
    WHERE v.tenant_id=${c.tenantId}::uuid AND v.client_id=${c.clientId}::uuid AND v.objective_id=${c.objectiveId}::uuid
      AND v.id=${c.requestedObjectiveRevisionId}::uuid AND v.version=${c.requestedObjectiveVersion} AND i.id=${c.requestedIntentId}::uuid`;
  if (rows.length !== 1) return fail();
  const row = copy(rows[0]!);
  if (row.revision.operation !== 'confirm_ready' || row.revision.actor_user_id !== original.actorUserId ||
      row.intent.actor_user_id !== original.actorUserId || row.intent.snapshot_hash !== c.snapshotHash ||
      row.intent.purpose !== OBJECTIVE_WORK_PURPOSE || row.intent.state !== 'pending' || row.intent.blocked_reason !== OBJECTIVE_WORK_BLOCKER ||
      objectiveRevisionSnapshotHash(row.revision.snapshot) !== c.snapshotHash ||
      row.plannerConsent.id !== original.plannerConsentId || row.plannerConsent.control_id !== original.plannerControlId ||
      row.plannerCommandReceipt.created_consent_id !== original.plannerConsentId || row.plannerCommandReceipt.result_consent_id !== original.plannerConsentId ||
      row.plannerCommandReceipt.actor_user_id !== original.actorUserId || row.plannerCommandReceipt.command_kind !== 'retry') fail();
  return { canonical: copy(c), ...row };
}

/** PREPARATION HELPER ONLY: call after the original native runtime has applied
 * this independently owned fixture. The caller owns opt-in, target/catalog/role
 * qualification and native execution; importing this file opens no connection.
 *
 * The actual production Objective service performs BOTH version CAS mutations,
 * immutable revision writes, ready-intent append and canonical reservation
 * advancement. Its current client/membership/ethical-wall checks receive the
 * original caller context unchanged. No HTTP/controller/authentication result,
 * Meri execution, new consent or Planner operation is synthesized here.
 *
 * update and confirm_ready are their normal separate service transactions. The
 * final read checks the new current native fence and unchanged original native
 * records; the original fixture object, consents, receipts, jobs and outputs are
 * never rewritten by this helper. A failed confirmation may leave its ordinary
 * draft edit committed in this task-owned fixture, as the production route does. */
export async function advanceObjectivePlannerNativeReadySource(corePrisma: CorePrismaService,
  rawContext: TenantContext, f: ObjectivePlannerNativeFixture): Promise<ObjectivePlannerNativeReadySource> {
  const ctx = copy(rawContext), original = { canonical: copy(f.canonical), actorUserId: f.actorUserId,
    plannerControlId: f.plannerControlId, plannerConsentId: f.plannerConsentId };
  const old = original.canonical;
  if (ctx.tenantId !== f.tenantId || old.tenantId !== ctx.tenantId || old.clientId !== f.source.clientId ||
      old.objectiveId !== f.source.objectiveId || old.requestedObjectiveRevisionId !== f.source.objectiveRevisionId ||
      old.requestedObjectiveVersion !== f.source.objectiveVersion || !ctx.userId || !ctx.clerkUserId) fail();
  const objectives = new ClientObjectivesService(corePrisma);
  const before = await objectives.get(ctx, old.clientId, old.objectiveId);
  if (before.status !== 'ready' || before.version !== old.requestedObjectiveVersion) fail();
  const originalRecords = await corePrisma.withTenant(ctx.tenantId, async tx => {
    await requireCanonicalObjectiveFence(tx, ctx, old);
    return originalWithinTx(tx, original);
  });
  const draft = await objectives.update(ctx, old.clientId, old.objectiveId, before.version,
    { minimumWin: `${before.minimumWin}; changed ready source for native Planner retry qualification` });
  if (draft.status !== 'draft' || draft.version !== before.version + 1) fail();
  const ready = await objectives.transition(ctx, old.clientId, old.objectiveId, draft.version, 'confirm_ready');
  if (ready.status !== 'ready' || ready.version !== draft.version + 1) fail();
  return corePrisma.withTenant(ctx.tenantId, async tx => {
    const rows = await tx.$queryRaw<Array<{ reservation: Row; revision: Row; intent: Row; membershipId: string }>>`
      SELECT to_jsonb(p) AS reservation,to_jsonb(v) AS revision,to_jsonb(i) AS intent,m.id::text AS "membershipId"
      FROM client_objective_canonical_plans p
      JOIN client_objective_work_intents i ON i.tenant_id=p.tenant_id AND i.client_id=p.client_id AND i.objective_id=p.objective_id
        AND i.id=p.requested_intent_id AND i.objective_revision_id=p.requested_objective_revision_id AND i.objective_version=p.requested_objective_version
      JOIN client_objective_revisions v ON v.tenant_id=i.tenant_id AND v.client_id=i.client_id AND v.objective_id=i.objective_id
        AND v.id=i.objective_revision_id AND v.version=i.objective_version
      JOIN tenant_memberships m ON m.tenant_id=p.tenant_id AND m.user_id=${ctx.userId}::uuid AND m.status::text='active'
        AND m.role::text IN ('standard_user','user_admin','capiro_admin')
      JOIN users u ON u.id=m.user_id AND u.clerk_user_id=${ctx.clerkUserId}
      WHERE p.tenant_id=${ctx.tenantId}::uuid AND p.client_id=${old.clientId}::uuid AND p.objective_id=${old.objectiveId}::uuid
        AND p.id=${old.canonicalPlanId}::uuid`;
    if (rows.length !== 1) return fail();
    const row = copy(rows[0]!), canonical = token(row.reservation);
    await requireCanonicalObjectiveFence(tx, ctx, canonical);
    const snapshot = row.revision.snapshot;
    if (['canonicalPlanId', 'tenantId', 'clientId', 'objectiveId', 'canonicalStrategyId', 'canonicalProjectId', 'epoch']
      .some(key => canonical[key as keyof CanonicalObjectivePlanToken] !== old[key as keyof CanonicalObjectivePlanToken]) ||
        canonical.bindingVersion !== old.bindingVersion + 1 || canonical.requestedObjectiveVersion !== ready.version ||
        canonical.requestedIntentId === old.requestedIntentId || canonical.requestedObjectiveRevisionId === old.requestedObjectiveRevisionId ||
        canonical.snapshotHash === old.snapshotHash || row.revision.operation !== 'confirm_ready' || row.revision.actor_user_id !== ctx.userId ||
        row.intent.actor_user_id !== ctx.userId || row.intent.snapshot_hash !== canonical.snapshotHash ||
        row.intent.purpose !== OBJECTIVE_WORK_PURPOSE || row.intent.state !== 'pending' || row.intent.blocked_reason !== OBJECTIVE_WORK_BLOCKER ||
        !snapshot || snapshot.id !== old.objectiveId || snapshot.clientId !== old.clientId || snapshot.version !== ready.version ||
        snapshot.status !== 'ready' || snapshot.deletedAt !== null || snapshot.minimumWin !== draft.minimumWin ||
        objectiveRevisionSnapshotHash(snapshot) !== canonical.snapshotHash) fail();
    const afterOriginal = await originalWithinTx(tx, original);
    if (applicationHash(afterOriginal) !== applicationHash(originalRecords)) fail();
    return { tenantId: ctx.tenantId, actorUserId: ctx.userId, clerkUserId: ctx.clerkUserId, membershipId: row.membershipId,
      source: { clientId: old.clientId, objectiveId: old.objectiveId, objectiveVersion: canonical.requestedObjectiveVersion,
        objectiveRevisionId: canonical.requestedObjectiveRevisionId }, canonical: copy(canonical), objectiveSnapshot: copy(snapshot),
      draft, ready, revision: row.revision, intent: row.intent, original: originalRecords };
  });
}
