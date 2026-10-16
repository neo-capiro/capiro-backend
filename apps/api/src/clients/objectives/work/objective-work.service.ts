import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { requireClientObjectiveDestinationRevision, type TenantContext } from '@capiro/shared';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { TenantContextMiddleware } from '../../../tenant/tenant-context.middleware.js';
import type { ApplicationAuthorityIdentityProof } from '../../../auth/application-authority.js';
import { objectiveRevisionSnapshotHash, OBJECTIVE_WORK_BLOCKER, OBJECTIVE_WORK_PURPOSE } from '../objective-work-intent.js';
import { requireCanonicalObjectiveFence, type CanonicalObjectivePlanToken } from '../objective-canonical-plan.js';
import {
  ObjectiveWorkError, executeWorkCommand, readWorkGeneration, workFailure, workUuid,
  type WorkAction, type WorkAuthority, type WorkConsent, type WorkControl, type WorkOwner,
  type WorkPolicyFacts, type WorkReadRequest, type WorkReconciliation, type WorkRequest,
  type WorkSource, type WorkState, type WorkTransaction, type StoredWorkReceipt,
} from './objective-work-command.js';

type Tx = Prisma.TransactionClient;
type Row = Record<string, any>;
export const OBJECTIVE_WORK_OWNER = Symbol('OBJECTIVE_WORK_OWNER');
/** Only an actual owner binding may establish original operation accounting or
 * known stricter settings. No job absence, posted JSON or generic service secret
 * supplies these facts. This port performs local owner reads/locks only. */
export interface ObjectiveWorkOwnerPort {
  lockWithinTx(tx: Tx, ctx: TenantContext, request: WorkRequest): Promise<void>;
  reconcileWithinTx(tx: Tx, authority: WorkAuthority, action: WorkAction, state: WorkState): Promise<WorkReconciliation>;
  policyWithinTx(tx: Tx, authority: WorkAuthority, action: WorkAction, state: WorkState): Promise<
    Omit<WorkPolicyFacts, 'originalTokenExpiresAtMs'>>;
}
export const UNCONNECTED_OBJECTIVE_WORK_OWNER: ObjectiveWorkOwnerPort = Object.freeze({
  // Core commands only record local consent/control. No effect owner is bound,
  // and no publication can infer a shared cross-database gate from this no-op.
  async lockWithinTx() {},
  async reconcileWithinTx(_tx: Tx, a: WorkAuthority, action: WorkAction, state: WorkState) {
    return { state: 'unavailable' as const, tenantId: a.tenantId, clientId: a.clientId,
      objectiveId: a.objectiveId, workAction: action,
      authorizationRequestId: state.control?.currentConsentId ?? null,
      rootIntentId: state.consent?.source.rootIntentId ?? state.source.rootIntentId,
      canonicalPlanId: state.source.canonicalPlanId, canonicalEpoch: state.source.canonicalEpoch };
  },
  async policyWithinTx() { return workFailure('AUTHORITY_UNAVAILABLE'); },
});
function iso(value: unknown): string {
  const d = value instanceof Date ? value : new Date(value as string);
  if (!Number.isFinite(d.getTime())) return workFailure('RECEIPT_UNVERIFIABLE');
  return d.toISOString();
}
function source(row: Row): WorkSource {
  return { canonicalPlanId: row.canonical_plan_id, canonicalEpoch: row.canonical_epoch,
    canonicalStrategyId: row.canonical_strategy_id, canonicalProjectId: row.canonical_project_id,
    canonicalBindingVersion: row.canonical_binding_version, rootIntentId: row.root_intent_id,
    sourceRevisionId: row.source_revision_id, sourceObjectiveVersion: row.source_objective_version,
    sourceSnapshotHash: row.source_snapshot_hash, rootActorUserId: row.root_actor_user_id };
}
function control(row: Row): WorkControl {
  return { id: row.id, version: row.version, currentConsentId: row.current_consent_id,
    cancelledAt: row.cancelled_at === null ? null : iso(row.cancelled_at),
    cancelledByUserId: row.cancelled_by_user_id };
}
function consent(row: Row): WorkConsent {
  return { id: row.id, controlId: row.control_id, source: source(row), previousConsentId: row.previous_consent_id,
    actorUserId: row.consenting_actor_user_id, actorMembershipId: row.consenting_membership_id,
    policyId: row.consent_policy_id, policyRevision: row.consent_policy_revision,
    configuredDurationMs: Number(row.configured_duration_ms), effectiveDurationMs: Number(row.effective_duration_ms),
    stricterExpiresAt: row.stricter_expires_at === null ? null : iso(row.stricter_expires_at), stricterLimitRef: row.stricter_limit_ref,
    confirmedAt: iso(row.confirmed_at), expiresAt: iso(row.expires_at), commandRequestId: row.command_request_id,
    commandReceiptId: row.command_receipt_id, payloadDigest: row.payload_digest };
}
@Injectable()
export class ObjectiveWorkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextMiddleware,
    @Inject(OBJECTIVE_WORK_OWNER) private readonly ownerPort: ObjectiveWorkOwnerPort,
  ) {}
  private async proof(ctx: TenantContext, req: Request): Promise<ApplicationAuthorityIdentityProof> {
    try {
      if (!['standard_user', 'user_admin', 'capiro_admin'].includes(ctx?.role)) workFailure('NOT_AVAILABLE');
      workUuid(ctx.tenantId); workUuid(ctx.userId);
      const proof = await this.tenant.readApplicationAuthority(req, ctx);
      if (proof.principal.tenantId !== ctx.tenantId || proof.principal.actorId !== ctx.userId ||
          !Number.isSafeInteger(proof.expiresAtMs)) workFailure('NOT_AVAILABLE');
      return proof;
    } catch { return workFailure('NOT_AVAILABLE'); }
  }
  async command(ctx: TenantContext, req: Request, request: WorkRequest) {
    return executeWorkCommand(request, this.store(ctx, request, await this.proof(ctx, req)));
  }
  async read(ctx: TenantContext, req: Request, request: WorkReadRequest) {
    return readWorkGeneration(request, this.store(ctx, request, await this.proof(ctx, req)));
  }
  private store(ctx: TenantContext, request: WorkRequest | WorkReadRequest, proof: ApplicationAuthorityIdentityProof): WorkOwner {
    const action = 'command' in request ? request.command.workAction : request.workAction;
    const requestId = 'command' in request ? request.command.requestId : request.requestId ?? null;
    return { transaction: async <T>(write: boolean, run: (ports: WorkTransaction) => Promise<T>) => {
      try {
        // The existing request-local owner rechecks its local membership/session
        // evidence before opening our transaction. No HTTP/provider under locks.
        const current = await proof.recheckCurrent().catch(() => workFailure('NOT_AVAILABLE', requestId));
        if (current.principal.tenantId !== ctx.tenantId || current.principal.actorId !== ctx.userId ||
            current.identityRevision !== proof.identityRevision || current.expiresAtMs !== proof.expiresAtMs)
          workFailure('NOT_AVAILABLE', requestId);
        return await this.prisma.withTenant(ctx.tenantId, async tx => {
          await tx.$executeRaw`SELECT set_config('statement_timeout','12000',true),set_config('lock_timeout','3000',true)`;
          const result = await run(this.ports(tx, ctx, request, action, proof, write));
          // Existing owner callback is local read-only withSystem work on its
          // separate connection; it performs no Clerk HTTP call. Native scope
          // locks remain held by this outer tx. This is not atomic session or
          // cross-service revocation: the original verified session is bounded
          // by its captured expiry, while local identity/impersonation is reread.
          const released = await proof.recheckCurrent().catch(() => workFailure('NOT_AVAILABLE', requestId));
          if (released.principal.tenantId !== ctx.tenantId || released.principal.actorId !== ctx.userId ||
              released.identityRevision !== proof.identityRevision || released.expiresAtMs !== proof.expiresAtMs)
            workFailure('NOT_AVAILABLE', requestId);
          // Includes historical replay, read and cancellation. Expiry of the
          // CURRENT request is separate from expiry of any historical consent.
          await this.currentProofWithinTx(tx, proof);
          return result;
        }, { timeoutMs: 15000 });
      } catch (error) {
        if (error instanceof ObjectiveWorkError) throw error;
        workFailure('AUTHORITY_UNAVAILABLE', requestId);
      }
    } };
  }
  private ports(tx: Tx, ctx: TenantContext, request: WorkRequest | WorkReadRequest,
    action: WorkAction, proof: ApplicationAuthorityIdentityProof, write: boolean): WorkTransaction {
    let lockedSource: WorkSource | undefined;
    const sameAction = (kind: WorkAction) => { if (kind !== action) workFailure('AUTHORITY_UNAVAILABLE'); };
    const requireWrite = () => { if (!write) workFailure('AUTHORITY_UNAVAILABLE'); };
    return {
      lockOwner: async () => {
        requireWrite();
        if (!('command' in request)) workFailure('AUTHORITY_UNAVAILABLE');
        await this.ownerPort.lockWithinTx(tx, ctx, request);
      },
      currentAuthority: async () => {
        const authority = await this.currentAuthority(tx, ctx, request.clientId, request.objectiveId);
        await this.currentProofWithinTx(tx, proof);
        return authority;
      },
      receipt: (a, kind, id) => { sameAction(kind); return this.receipt(tx, a, kind, id); },
      state: async (a, kind, create) => {
        sameAction(kind); if (create) requireWrite();
        const state = await this.state(tx, ctx, a, kind, create, 'command' in request ? request.command.command : null);
        if (create) lockedSource = state.source;
        return state;
      },
      clock: async () => {
        const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
        if (rows.length !== 1) workFailure('AUTHORITY_UNAVAILABLE');
        return iso(rows[0]!.now);
      },
      reconcile: (a, kind, state) => { sameAction(kind); return this.ownerPort.reconcileWithinTx(tx, a, kind, state); },
      policy: async (a, kind, state) => {
        requireWrite(); sameAction(kind);
        const facts = await this.ownerPort.policyWithinTx(tx, a, kind, state);
        // The bound owner may only reduce; the original verified request expiry
        // is captured once and cannot be replaced by the browser or owner.
        return { ...facts, originalTokenExpiresAtMs: proof.expiresAtMs };
      },
      insertConsent: (a, kind, row) => { requireWrite(); sameAction(kind); return this.insertConsent(tx, a, kind, row); },
      casControl: async (a, kind, before, after) => {
        requireWrite(); sameAction(kind);
        if (!lockedSource) workFailure('AUTHORITY_UNAVAILABLE');
        const s = lockedSource;
        const changed = await tx.$executeRaw`UPDATE client_objective_work_controls
          SET version=${after.version},current_consent_id=${after.currentConsentId}::uuid,
            cancelled_at=${after.cancelledAt}::timestamptz,cancelled_by_user_id=${after.cancelledByUserId}::uuid,
            updated_at=clock_timestamp()
          WHERE id=${before.id}::uuid AND tenant_id=${a.tenantId}::uuid AND client_id=${a.clientId}::uuid
            AND objective_id=${a.objectiveId}::uuid AND work_action=${kind} AND version=${before.version}
            AND current_consent_id IS NOT DISTINCT FROM ${before.currentConsentId}::uuid
            AND cancelled_at IS NOT DISTINCT FROM ${before.cancelledAt}::timestamptz
            AND cancelled_by_user_id IS NOT DISTINCT FROM ${before.cancelledByUserId}::uuid
            AND canonical_plan_id=${s.canonicalPlanId}::uuid AND canonical_epoch=${s.canonicalEpoch}
            AND canonical_strategy_id=${s.canonicalStrategyId}::uuid AND canonical_project_id=${s.canonicalProjectId}::uuid`;
        return changed === 1;
      },
      insertReceipt: (a, stored) => {
        requireWrite(); sameAction(stored.receipt.workAction); return this.insertReceipt(tx, a, stored);
      },
      newId: randomUUID,
    };
  }
  private async currentProofWithinTx(tx: Tx, proof: ApplicationAuthorityIdentityProof) {
    const rows = await tx.$queryRaw<Array<{ valid: boolean }>>`SELECT
      clock_timestamp() < ${new Date(proof.expiresAtMs).toISOString()}::timestamptz AS valid`;
    if (rows.length !== 1 || rows[0]!.valid !== true) workFailure('NOT_AVAILABLE');
  }
  private async currentAuthority(tx: Tx, ctx: TenantContext, clientId: string, objectiveId: string): Promise<WorkAuthority> {
    const rows = await tx.$queryRaw<Array<{ version: number }>>`SELECT version FROM client_objectives
      WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${clientId}::uuid AND id=${objectiveId}::uuid AND deleted_at IS NULL`;
    if (rows.length !== 1) workFailure('NOT_AVAILABLE');
    let binding;
    try { binding = await requireClientObjectiveDestinationRevision(tx, ctx, { clientId, objectiveId, objectiveVersion: rows[0]!.version }); }
    catch { return workFailure('NOT_AVAILABLE'); }
    const members = await tx.$queryRaw<Array<{ id: string }>>`SELECT m.id::text AS id
      FROM tenant_memberships m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id
      WHERE m.tenant_id=${ctx.tenantId}::uuid AND m.user_id=${ctx.userId}::uuid AND u.clerk_user_id=${ctx.clerkUserId}
        AND m.status::text='active' AND t.status::text='active'
        AND m.role::text IN ('standard_user','user_admin','capiro_admin') FOR SHARE OF m,u,t`;
    const objectives = await tx.$queryRaw<Array<{ status: WorkAuthority['objectiveStatus'] }>>`SELECT status
      FROM client_objectives WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${clientId}::uuid
        AND id=${objectiveId}::uuid AND version=${binding.objectiveVersion} AND deleted_at IS NULL`;
    if (members.length !== 1 || objectives.length !== 1 || !['draft', 'in_review', 'ready'].includes(objectives[0]!.status))
      workFailure('NOT_AVAILABLE');
    return { tenantId: ctx.tenantId, actorUserId: ctx.userId, actorMembershipId: members[0]!.id, clerkUserId: ctx.clerkUserId,
      clientId, objectiveId, objectiveRevisionId: binding.objectiveRevisionId, objectiveVersion: binding.objectiveVersion,
      objectiveStatus: objectives[0]!.status };
  }
  private async root(tx: Tx, a: WorkAuthority, s: WorkSource) {
    const rows = await tx.$queryRaw<Array<{ record: Row; snapshot: Prisma.JsonValue; operation: string; revisionActor: string }>>`
      SELECT to_jsonb(i) AS record,r.snapshot,r.operation,r.actor_user_id::text AS "revisionActor"
      FROM client_objective_work_intents i JOIN client_objective_revisions r
        ON r.tenant_id=i.tenant_id AND r.client_id=i.client_id AND r.objective_id=i.objective_id
          AND r.id=i.objective_revision_id AND r.version=i.objective_version
      WHERE i.tenant_id=${a.tenantId}::uuid AND i.client_id=${a.clientId}::uuid AND i.objective_id=${a.objectiveId}::uuid
        AND i.id=${s.rootIntentId}::uuid`;
    const row = rows[0], i = row?.record, snapshot = row?.snapshot as Row | undefined;
    if (rows.length !== 1 || !i || !snapshot || row!.operation !== 'confirm_ready' ||
        snapshot.status !== 'ready' || snapshot.deletedAt !== null || snapshot.id !== a.objectiveId || snapshot.clientId !== a.clientId ||
        snapshot.version !== s.sourceObjectiveVersion || i.objective_revision_id !== s.sourceRevisionId ||
        i.objective_version !== s.sourceObjectiveVersion || i.actor_user_id !== s.rootActorUserId ||
        row!.revisionActor !== s.rootActorUserId || i.snapshot_hash !== s.sourceSnapshotHash ||
        i.snapshot_hash !== objectiveRevisionSnapshotHash(row!.snapshot) || i.purpose !== OBJECTIVE_WORK_PURPOSE ||
        i.state !== 'pending' || i.blocked_reason !== OBJECTIVE_WORK_BLOCKER) workFailure('AUTHORITY_UNAVAILABLE');
  }
  private async consent(tx: Tx, a: WorkAuthority, action: WorkAction, id: string): Promise<WorkConsent> {
    const rows = await tx.$queryRaw<Array<{ record: Row }>>`SELECT to_jsonb(c) AS record FROM client_objective_work_consents c
      WHERE tenant_id=${a.tenantId}::uuid AND client_id=${a.clientId}::uuid AND objective_id=${a.objectiveId}::uuid
        AND work_action=${action} AND id=${id}::uuid`;
    if (rows.length !== 1) workFailure('RECEIPT_UNVERIFIABLE');
    return consent(rows[0]!.record);
  }
  private async state(tx: Tx, ctx: TenantContext, a: WorkAuthority, action: WorkAction, create: boolean,
    command: 'retry' | 'cancel' | null): Promise<WorkState> {
    const canonical = create
      ? await tx.$queryRaw<Array<{ record: Row }>>`SELECT to_jsonb(p) AS record FROM client_objective_canonical_plans p
          WHERE tenant_id=${a.tenantId}::uuid AND client_id=${a.clientId}::uuid AND objective_id=${a.objectiveId}::uuid FOR UPDATE`
      : await tx.$queryRaw<Array<{ record: Row }>>`SELECT to_jsonb(p) AS record FROM client_objective_canonical_plans p
          WHERE tenant_id=${a.tenantId}::uuid AND client_id=${a.clientId}::uuid AND objective_id=${a.objectiveId}::uuid FOR SHARE`;
    if (canonical.length !== 1) workFailure('NOT_AVAILABLE');
    const p = canonical[0]!.record;
    let s: WorkSource = { canonicalPlanId: p.id, canonicalEpoch: p.epoch, canonicalBindingVersion: p.binding_version,
      canonicalStrategyId: p.canonical_strategy_id, canonicalProjectId: p.canonical_project_id,
      rootIntentId: p.requested_intent_id, sourceRevisionId: p.requested_objective_revision_id,
      sourceObjectiveVersion: p.requested_objective_version, sourceSnapshotHash: p.requested_snapshot_hash,
      rootActorUserId: '' };
    const roots = await tx.$queryRaw<Array<{ actor: string }>>`SELECT actor_user_id::text AS actor FROM client_objective_work_intents
      WHERE tenant_id=${a.tenantId}::uuid AND client_id=${a.clientId}::uuid AND objective_id=${a.objectiveId}::uuid AND id=${s.rootIntentId}::uuid`;
    if (roots.length !== 1) workFailure('AUTHORITY_UNAVAILABLE');
    s.rootActorUserId = roots[0]!.actor;
    await this.root(tx, a, s);
    if (create && command === 'retry') {
      const token: CanonicalObjectivePlanToken = { canonicalPlanId: s.canonicalPlanId, tenantId: a.tenantId,
        clientId: a.clientId, objectiveId: a.objectiveId, canonicalStrategyId: s.canonicalStrategyId,
        canonicalProjectId: s.canonicalProjectId, bindingVersion: s.canonicalBindingVersion, epoch: s.canonicalEpoch,
        requestedIntentId: s.rootIntentId, requestedObjectiveRevisionId: s.sourceRevisionId,
        requestedObjectiveVersion: s.sourceObjectiveVersion, snapshotHash: s.sourceSnapshotHash };
      await requireCanonicalObjectiveFence(tx, ctx, token);
    }
    if (create) await tx.$executeRaw`INSERT INTO client_objective_work_controls
      (id,tenant_id,client_id,objective_id,work_action,canonical_plan_id,canonical_epoch,canonical_strategy_id,canonical_project_id)
      VALUES (${randomUUID()}::uuid,${a.tenantId}::uuid,${a.clientId}::uuid,${a.objectiveId}::uuid,${action},
        ${s.canonicalPlanId}::uuid,${s.canonicalEpoch},${s.canonicalStrategyId}::uuid,${s.canonicalProjectId}::uuid)
      ON CONFLICT (tenant_id,client_id,objective_id,work_action) DO NOTHING`;
    const heads = create
      ? await tx.$queryRaw<Array<{ record: Row }>>`SELECT to_jsonb(c) AS record FROM client_objective_work_controls c
          WHERE tenant_id=${a.tenantId}::uuid AND client_id=${a.clientId}::uuid AND objective_id=${a.objectiveId}::uuid
            AND work_action=${action} FOR UPDATE`
      : await tx.$queryRaw<Array<{ record: Row }>>`SELECT to_jsonb(c) AS record FROM client_objective_work_controls c
          WHERE tenant_id=${a.tenantId}::uuid AND client_id=${a.clientId}::uuid AND objective_id=${a.objectiveId}::uuid
            AND work_action=${action} FOR SHARE`;
    if (heads.length > 1 || create && !heads[0]) workFailure('AUTHORITY_UNAVAILABLE');
    if (!heads[0]) return { source: s, control: null, consent: null };
    const row = heads[0].record;
    if (row.canonical_plan_id !== s.canonicalPlanId || row.canonical_epoch !== s.canonicalEpoch ||
        row.canonical_strategy_id !== s.canonicalStrategyId || row.canonical_project_id !== s.canonicalProjectId)
      workFailure('AUTHORITY_UNAVAILABLE');
    const head = control(row);
    const saved = head.currentConsentId ? await this.consent(tx, a, action, head.currentConsentId) : null;
    if (saved && saved.controlId !== head.id) workFailure('RECEIPT_UNVERIFIABLE');
    if (saved && command === 'cancel') {
      s = { ...saved.source, canonicalBindingVersion: s.canonicalBindingVersion };
      await this.root(tx, a, s);
    }
    return { source: s, control: head, consent: saved };
  }
  private async receipt(tx: Tx, a: WorkAuthority, action: WorkAction, id: string): Promise<StoredWorkReceipt | null> {
    const rows = await tx.$queryRaw<Array<{ record: Row }>>`SELECT to_jsonb(r) AS record FROM client_objective_work_command_receipts r
      WHERE tenant_id=${a.tenantId}::uuid AND client_id=${a.clientId}::uuid AND objective_id=${a.objectiveId}::uuid
        AND work_action=${action} AND actor_user_id=${a.actorUserId}::uuid AND request_id=${id}::uuid`;
    if (!rows.length) return null;
    if (rows.length !== 1) workFailure('RECEIPT_UNVERIFIABLE', id);
    const r = rows[0]!.record;
    const s = source(r);
    try { await this.root(tx, a, s); } catch { workFailure('RECEIPT_UNVERIFIABLE', id); }
    const created = r.created_consent_id ? await this.consent(tx, a, action, r.created_consent_id) : null;
    if (created && (created.commandReceiptId !== r.id || created.commandRequestId !== r.request_id ||
        created.payloadDigest !== r.payload_digest || created.actorUserId !== r.actor_user_id ||
        created.actorMembershipId !== r.actor_membership_id || created.controlId !== r.control_id ||
        created.previousConsentId !== r.target_consent_id || created.id !== r.result_consent_id ||
        Object.keys(s).some(key => created.source[key as keyof WorkSource] !== s[key as keyof WorkSource])))
      workFailure('RECEIPT_UNVERIFIABLE', id);
    if (r.command_kind === 'retry' ? !created || r.created_consent_id !== r.result_consent_id
      : r.created_consent_id !== null || r.result_consent_id !== r.target_consent_id)
      workFailure('RECEIPT_UNVERIFIABLE', id);
    return { actorUserId: r.actor_user_id, actorMembershipId: r.actor_membership_id, controlId: r.control_id,
      command: r.command, source: s, receipt: {
        schemaVersion: 1, receiptId: r.id, requestId: r.request_id, payloadDigest: r.payload_digest,
        clientId: r.client_id, objectiveId: r.objective_id, command: r.command_kind, workAction: r.work_action,
        commandRevision: { id: r.command_revision_id, version: r.command_objective_version },
        sourceRevision: { id: r.source_revision_id, version: r.source_objective_version }, rootIntentId: r.root_intent_id,
        controlVersionBefore: r.control_version_before, controlVersionAfter: r.control_version_after,
        targetAuthorizationRequestId: r.target_consent_id, authorizationRequestId: r.result_consent_id,
        consent: created ? { id: created.id, confirmedAt: created.confirmedAt, expiresAt: created.expiresAt } : null,
        outcome: r.outcome, committedAt: iso(r.committed_at) } };
  }
  private async insertConsent(tx: Tx, a: WorkAuthority, action: WorkAction, c: WorkConsent) {
    const s = c.source;
    await tx.$executeRaw`INSERT INTO client_objective_work_consents
      (id,tenant_id,client_id,objective_id,work_action,canonical_plan_id,canonical_epoch,canonical_strategy_id,canonical_project_id,
       canonical_binding_version,root_intent_id,source_revision_id,source_objective_version,source_snapshot_hash,root_actor_user_id,
       control_id,previous_consent_id,consenting_actor_user_id,consenting_membership_id,consent_policy_id,consent_policy_revision,
       configured_duration_ms,effective_duration_ms,stricter_expires_at,stricter_limit_ref,confirmed_at,expires_at,
       command_request_id,command_receipt_id,payload_digest)
      VALUES (${c.id}::uuid,${a.tenantId}::uuid,${a.clientId}::uuid,${a.objectiveId}::uuid,${action},
       ${s.canonicalPlanId}::uuid,${s.canonicalEpoch},${s.canonicalStrategyId}::uuid,${s.canonicalProjectId}::uuid,
       ${s.canonicalBindingVersion},${s.rootIntentId}::uuid,${s.sourceRevisionId}::uuid,${s.sourceObjectiveVersion},
       ${s.sourceSnapshotHash},${s.rootActorUserId}::uuid,${c.controlId}::uuid,${c.previousConsentId}::uuid,
       ${c.actorUserId}::uuid,${c.actorMembershipId}::uuid,${c.policyId},${c.policyRevision},${c.configuredDurationMs}::bigint,
       ${c.effectiveDurationMs}::bigint,${c.stricterExpiresAt}::timestamptz,${c.stricterLimitRef},${c.confirmedAt}::timestamptz,
       ${c.expiresAt}::timestamptz,${c.commandRequestId}::uuid,${c.commandReceiptId}::uuid,${c.payloadDigest})`;
  }
  private async insertReceipt(tx: Tx, a: WorkAuthority, stored: StoredWorkReceipt) {
    const r = stored.receipt, s = stored.source;
    await tx.$executeRaw`INSERT INTO client_objective_work_command_receipts
      (id,tenant_id,client_id,objective_id,work_action,canonical_plan_id,canonical_epoch,canonical_strategy_id,canonical_project_id,
       canonical_binding_version,root_intent_id,source_revision_id,source_objective_version,source_snapshot_hash,root_actor_user_id,
       control_id,actor_user_id,actor_membership_id,request_id,payload_digest,command,command_kind,command_revision_id,
       command_objective_version,control_version_before,control_version_after,target_consent_id,created_consent_id,result_consent_id,
       outcome,committed_at)
      VALUES (${r.receiptId}::uuid,${a.tenantId}::uuid,${a.clientId}::uuid,${a.objectiveId}::uuid,${r.workAction},
       ${s.canonicalPlanId}::uuid,${s.canonicalEpoch},${s.canonicalStrategyId}::uuid,${s.canonicalProjectId}::uuid,
       ${s.canonicalBindingVersion},${s.rootIntentId}::uuid,${s.sourceRevisionId}::uuid,${s.sourceObjectiveVersion},
       ${s.sourceSnapshotHash},${s.rootActorUserId}::uuid,${stored.controlId}::uuid,${stored.actorUserId}::uuid,
       ${stored.actorMembershipId}::uuid,${r.requestId}::uuid,${r.payloadDigest},${JSON.stringify(stored.command)}::jsonb,
       ${r.command},${r.commandRevision.id}::uuid,${r.commandRevision.version},${r.controlVersionBefore},${r.controlVersionAfter},
       ${r.targetAuthorizationRequestId}::uuid,${r.consent?.id ?? null}::uuid,${r.authorizationRequestId}::uuid,
       ${r.outcome},${r.committedAt}::timestamptz)`;
  }
}
