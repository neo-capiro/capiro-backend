import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GENERATION_PRODUCER } from '../meri/objective-canonical-generation.js';
import { readCanonicalSavedGeneration } from '../meri/objective-canonical-saved-generation.js';
import { producerApplication, type CanonicalProducerWork } from '../meri/objective-canonical-producer.js';
import { ObjectiveCanonicalApplicationService } from './objective-canonical-application.service.js';
import { applicationHash, applicationReceiptId, applicationUuid, CanonicalApplicationError } from './objective-canonical-application.js';
import type { CanonicalAuthoritySubject } from './objective-canonical-authority.js';
import { continueCanonicalPlanner, type CanonicalPlannerContinuationOutcome,
  type CanonicalPlannerContinuationReconciliation } from './objective-canonical-continuation.js';
import { PLANNER_CONTINUATION_OPERATION, newPlannerContinuationOperation,
  readPlannerContinuationOperationWithinTx, insertPlannerContinuationOperationWithinTx,
  claimPlannerContinuationOperationWithinTx, finalizePlannerContinuationOperationWithinTx,
  type StoredPlannerContinuationOperation } from './objective-planner-continuation.store.js';
import { plannerContinuationDatabaseNow, plannerContinuationGrantWithinTx,
  readPlannerContinuationConsentWithinTx } from './objective-planner-continuation.authority.js';
import { requireCanonicalApplicationFence } from './objective-canonical-fence.js';
import { canonicalMaterializationReceiptId } from './strategy-materialization.js';

type Tx = Prisma.TransactionClient;
export interface PlannerContinuationJob { tenantId: string; clerkUserId: string; generationJobId: string }
const fail = (): never => { throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED'); };

/** Concrete composition of durable source discovery, original-operation owner,
 * current native/Planner consent and the existing validated application writer.
 * All output effects and operation accounting use ONE native transaction. */
@Injectable()
export class ObjectivePlannerContinuationRuntime {
  private readonly cursors = new Map<string, string>();
  constructor(private readonly prisma: PrismaService, private readonly application: ObjectiveCanonicalApplicationService,
    private readonly config: ConfigService) {}
  get enabled() { return this.config.get<string>('OBJECTIVE_PLANNER_CONTINUATION_ENABLED') === 'true'; }
  private async gate(tx: Tx, tenantId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`planner:${tenantId}`}, 0))`;
  }
  private transaction<T>(tenantId: string, run: (tx: Tx) => Promise<T>) {
    applicationUuid(tenantId);
    return this.prisma.withTenant(tenantId, async tx => {
      await this.gate(tx, tenantId);
      return run(tx);
    }, { timeoutMs: 15_000 });
  }
  private async job(tx: Tx, scope: PlannerContinuationJob) {
    applicationUuid(scope.generationJobId);
    if (typeof scope.clerkUserId !== 'string' || !scope.clerkUserId || scope.clerkUserId.length > 128) return fail();
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM sp_draft_job
      WHERE tenant_id=${scope.tenantId}::uuid AND id=${scope.generationJobId}::uuid
        AND owner_user_id=${scope.clerkUserId} AND status='completed' FOR SHARE`;
    if (rows.length !== 1 || rows[0]!.id !== scope.generationJobId) return fail();
  }
  private async stored(tx: Tx, expected: StoredPlannerContinuationOperation) {
    const actual = await readPlannerContinuationOperationWithinTx(tx, { tenantId: expected.tenantId,
      clerkUserId: expected.ownerId, operationId: expected.id });
    if (!actual || applicationHash(actual.data.original) !== applicationHash(expected.data.original) ||
        applicationHash(actual.data.work) !== applicationHash(expected.data.work)) return fail();
    return actual;
  }
  private async applicationRow(tx: Tx, stored: StoredPlannerContinuationOperation) {
    return tx.spPlannerResource.findFirst({ where: { tenantId: stored.tenantId,
      id: applicationReceiptId(stored.tenantId, stored.ownerId, stored.data.work.applicationRequestId) } });
  }
  private async requireNoPriorEffect(tx: Tx, stored: StoredPlannerContinuationOperation) {
    if (await this.applicationRow(tx, stored)) return fail();
    const owner = await tx.spPlannerResource.findFirst({ where: { tenantId: stored.tenantId,
      id: canonicalMaterializationReceiptId(stored.tenantId, stored.ownerId, stored.data.work.applicationRequestId) } });
    if (owner) return fail();
    const projectId = stored.data.work.canonical.canonicalProjectId;
    const rows = await tx.$queryRaw<Array<{ present: boolean }>>`SELECT
      EXISTS(SELECT 1 FROM sp_planner_projects WHERE tenant_id=${stored.tenantId}::uuid AND id=${projectId}::uuid) OR
      EXISTS(SELECT 1 FROM sp_planner_tasks WHERE tenant_id=${stored.tenantId}::uuid AND ${projectId}::uuid=ANY(project_ids)) AS present`;
    // Include archived outputs. An orphan or prior canonical output cannot be
    // turned into a no-effect claim just because its current receipt is absent.
    if (rows.length !== 1 || rows[0]!.present !== false) return fail();
  }
  private async settleInactive(tx: Tx, stored: StoredPlannerContinuationOperation) {
    if (stored.data.terminal) return stored;
    await plannerContinuationGrantWithinTx(tx, stored, 'retained-result-read', null);
    const w = stored.data.work, c = w.canonical;
    const controls = await tx.$queryRaw<Array<{ version: number; consentId: string | null; cancelled: boolean }>>`
      SELECT version,current_consent_id::text AS "consentId",cancelled_at IS NOT NULL AS cancelled
      FROM client_objective_work_controls WHERE tenant_id=${stored.tenantId}::uuid
        AND client_id=${c.clientId}::uuid AND objective_id=${c.objectiveId}::uuid
        AND work_action='objective.plan.prepare'`;
    const objectives = await tx.$queryRaw<Array<{ version: number; status: string }>>`
      SELECT version,status::text AS status FROM client_objectives WHERE tenant_id=${stored.tenantId}::uuid
        AND client_id=${c.clientId}::uuid AND id=${c.objectiveId}::uuid AND deleted_at IS NULL`;
    if (controls.length !== 1 || objectives.length !== 1) return fail();
    const ctl = controls[0]!, source = objectives[0]!, now = await plannerContinuationDatabaseNow(tx);
    const cancelled = ctl.cancelled || ctl.consentId !== w.consentId || ctl.version !== w.controlVersion;
    const stale = source.version !== c.requestedObjectiveVersion || source.status !== 'ready';
    if (!cancelled && !stale && now < Date.parse(stored.data.original.originalDeadlineAt)) return stored;
    // With the Planner gate held, a nonterminal owner row plus the concrete
    // atomic writer invariant establishes no committed effect. A mismatched
    // application receipt is uncertainty and cannot be terminal-accounted.
    await this.requireNoPriorEffect(tx, stored);
    return finalizePlannerContinuationOperationWithinTx(tx, stored, { state: cancelled ? 'cancelled' : 'failed',
      terminalReceiptId: stored.id, leaseToken: stored.data.lease?.token ?? null, nowMs: now });
  }
  private async resolve(scope: PlannerContinuationJob) {
    return this.transaction(scope.tenantId, async tx => {
      await this.job(tx, scope);
      const saved = await readCanonicalSavedGeneration(tx, scope);
      const rows = await tx.spPlannerResource.findMany({ where: { tenantId: scope.tenantId,
        ownerId: scope.clerkUserId, kind: PLANNER_CONTINUATION_OPERATION,
        data: { path: ['work','generationJobId'], equals: scope.generationJobId } }, take: 101 });
      if (rows.length > 100) return fail(); // Explicitly incomplete, never a first-N success.
      const operations: StoredPlannerContinuationOperation[] = [];
      for (const row of rows) {
        const actual = await readPlannerContinuationOperationWithinTx(tx, { tenantId: scope.tenantId,
          clerkUserId: scope.clerkUserId, operationId: row.id });
        if (!actual) return fail();
        operations.push(await this.settleInactive(tx, actual));
      }
      const applied = operations.filter(o => o.data.state === 'applied');
      if (applied.length > 1) return fail();
      if (applied[0]) return { stored: applied[0] }; // Fresh read admission is separate from expired effect authority.
      let consent;
      try { consent = await readPlannerContinuationConsentWithinTx(tx, saved); }
      catch (error) {
        const terminal = operations.filter(o => o.data.terminal).sort((a, b) =>
          b.data.terminal!.recordedAtMs - a.data.terminal!.recordedAtMs)[0];
        if (terminal && operations.every(o => o.data.terminal)) return { stored: terminal };
        throw error;
      }
      const operation = newPlannerContinuationOperation({ ...consent, clerkUserId: scope.clerkUserId });
      const same = operations.find(o => o.id === operation.original.operationId);
      if (same) return { stored: same };
      // A foreign/older ambiguous operation may still own an effect. A successor
      // consent cannot turn that uncertainty into permission to start another.
      if (operations.some(o => o.data.state === 'queued' || o.data.state === 'leased')) return fail();
      const prospective: StoredPlannerContinuationOperation = { id: operation.original.operationId,
        tenantId: scope.tenantId, ownerId: scope.clerkUserId, version: 1, data: operation };
      await this.requireNoPriorEffect(tx, prospective);
      // The queued row is a durable local delegation scoped to the real source
      // and separate Planner consent. Validate it before committing admission.
      const stored = await insertPlannerContinuationOperationWithinTx(tx, operation);
      const now = await plannerContinuationDatabaseNow(tx);
      const claimed = await claimPlannerContinuationOperationWithinTx(tx, stored, { leaseToken: randomUUID(),
        nowMs: now, leaseExpiresAtMs: Math.min(now + 30_000, Date.parse(operation.original.originalDeadlineAt)) });
      if (!claimed) return fail();
      await plannerContinuationGrantWithinTx(tx, claimed, 'effect', claimed.data.lease!.token);
      return { stored: claimed, claimedToken: claimed.data.lease!.token };
    });
  }
  async consumeJob(scope: PlannerContinuationJob): Promise<CanonicalPlannerContinuationOutcome | { outcome: 'disabled' }> {
    if (!this.enabled) return { outcome: 'disabled' };
    applicationHash(scope);
    if (Object.keys(scope).sort().join(',') !== 'clerkUserId,generationJobId,tenantId') return fail();
    const pinned = JSON.parse(JSON.stringify(scope)) as PlannerContinuationJob;
    const resolved = await this.resolve(pinned);
    let operation = resolved.stored;
    // resolve may commit the first lease. Keep that lease, never allocate another
    // original operation/attempt/run when this invocation continues or recovers.
    const leaseToken = resolved.claimedToken ?? randomUUID();
    const work = operation.data.work, original = operation.data.original;
    const identity = (seen: CanonicalProducerWork) => {
      if (applicationHash(seen) !== applicationHash(work)) return fail();
    };
    const current = (tx: Tx, stored: StoredPlannerContinuationOperation) => async (subject: CanonicalAuthoritySubject) => {
      if (!this.enabled || subject.applicationRequestId !== work.applicationRequestId || subject.producerPhase !== undefined ||
          subject.requestSha256 !== null && subject.requestSha256 !== applicationHash(producerApplication(work))) return fail();
      await plannerContinuationGrantWithinTx(tx, stored, subject.purpose, subject.purpose === 'effect' ? leaseToken : null);
    };
    return continueCanonicalPlanner(work, original, {
      reconcile: async seen => {
        identity(seen);
        return this.transaction(pinned.tenantId, async tx => {
          await this.job(tx, pinned);
          let actual = await this.stored(tx, operation);
          const terminal = actual.data.terminal;
          if (terminal) {
            await plannerContinuationGrantWithinTx(tx, actual, 'retained-result-read', null);
            if (actual.data.state !== 'applied' && terminal.receiptId !== actual.id) return fail();
            return { state: 'accounted', original, terminalReceiptId: terminal.receiptId,
              outcome: actual.data.state } as CanonicalPlannerContinuationReconciliation;
          }
          // The operation owner invariant is concrete: the only writer below
          // finalizes accounting with the application outputs in the same tx.
          // A receipt without accounting is an invariant violation, not adoption.
          await this.requireNoPriorEffect(tx, actual);
          const now = await plannerContinuationDatabaseNow(tx);
          if (actual.data.lease?.token !== leaseToken || actual.data.lease.expiresAtMs <= now) {
            const claimed = await claimPlannerContinuationOperationWithinTx(tx, actual, { leaseToken,
              nowMs: now, leaseExpiresAtMs: Math.min(now + 30_000, Date.parse(original.originalDeadlineAt)),
              reclaimExpiredLease: 'application-and-operation-atomic' });
            if (!claimed) return fail();
            actual = claimed;
          }
          await plannerContinuationGrantWithinTx(tx, actual, 'effect', leaseToken);
          operation = actual;
          return { state: 'not_started', original, terminalReceiptId: null, outcome: null };
        });
      },
      prepare: async seen => {
        identity(seen);
        return this.transaction(pinned.tenantId, async tx => {
          await this.job(tx, pinned);
          const actual = await this.stored(tx, operation);
          const grant = await plannerContinuationGrantWithinTx(tx, actual, 'effect', leaseToken);
          const result = await this.application.prepareWithinOwnerTransaction(tx, producerApplication(work), grant, current(tx, actual));
          await current(tx, actual)({ purpose: 'effect', applicationRequestId: work.applicationRequestId,
            requestSha256: applicationHash(producerApplication(work)) });
          operation = await finalizePlannerContinuationOperationWithinTx(tx, actual, { state: 'applied', leaseToken,
            terminalReceiptId: applicationReceiptId(actual.tenantId, actual.ownerId, work.applicationRequestId),
            nowMs: await plannerContinuationDatabaseNow(tx) });
          // Accounting adds a write after the application's own release gate.
          // Recheck the actual DB clock with the ORIGINAL captured lease/grant
          // after that write; an expiry throws and rolls back both owners.
          if (!this.enabled) return fail();
          await requireCanonicalApplicationFence(tx, grant, producerApplication(work));
          return result;
        });
      },
      lookup: async request => this.transaction(pinned.tenantId, async tx => {
        await this.job(tx, pinned);
        const actual = await this.stored(tx, operation);
        if (actual.data.state !== 'applied' || !actual.data.terminal || actual.data.terminal.receiptId !==
            applicationReceiptId(actual.tenantId, actual.ownerId, work.applicationRequestId)) return fail();
        const grant = await plannerContinuationGrantWithinTx(tx, actual, 'retained-result-read', null);
        return this.application.lookupWithinOwnerTransaction(tx, request, grant, current(tx, actual));
      }),
    });
  }
  async consumeTenant(tenantId: string): Promise<void> {
    if (!this.enabled) return;
    applicationUuid(tenantId);
    const cursor = this.cursors.get(tenantId);
    const rows = await this.prisma.withTenant(tenantId, tx => tx.spPlannerResource.findMany({ where: {
      tenantId, kind: GENERATION_PRODUCER, archived: false, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: 'asc' }, take: 20, select: { id: true, ownerId: true, data: true } }));
    for (const row of rows) {
      try {
        const jobId = (row.data as { sourceAdmission?: { generationJobId?: string } })?.sourceAdmission?.generationJobId;
        if (jobId) await this.consumeJob({ tenantId, clerkUserId: row.ownerId, generationJobId: jobId });
      } catch { /* A blocked source cannot starve the next durable source. No payload is logged. */ }
    }
    if (rows.length === 20) this.cursors.set(tenantId, rows[rows.length - 1]!.id);
    else this.cursors.delete(tenantId);
    if (this.cursors.size > 10_000) this.cursors.clear();
  }
}
