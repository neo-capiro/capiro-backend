import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { plannerResourceCalendarDate, type TenantContext } from '@capiro/shared';
import { createPlannerApplicationCodec, createPlannerMaterializationCodec,
  type StoredCanonicalMaterialization, type StrategySnapshot } from '@capiro/shared/objective-planner-owner-codec';
import type { ApplicationAuthorityIdentityProof } from '../../../auth/application-authority.js';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import type { TenantContextMiddleware } from '../../../tenant/tenant-context.middleware.js';
import { objectiveRevisionSnapshotHash, OBJECTIVE_WORK_BLOCKER, OBJECTIVE_WORK_PURPOSE } from '../objective-work-intent.js';
import { ObjectivePlannerWorkOwner } from './objective-planner-work-owner.js';
import { decodeObjectivePlannerApplied, type ObjectivePlannerAppliedOperation, type ObjectivePlannerResource } from './objective-planner-applied.js';
import { ObjectiveWorkService, UNCONNECTED_OBJECTIVE_WORK_OWNER, type ObjectiveWorkOwnerPort } from './objective-work.service.js';
import { workDigest, type WorkAction, type WorkReadRequest } from './objective-work-command.js';

// Actual WorkService, Core read kernel, shared native Objective destination
// reader and concrete Planner owner. Only native SQL results, transaction and
// current request-proof callbacks are synthetic. No database, HTTP, model,
// issuance, retry, application writer or real advisory lock is exercised.
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const at = '2026-10-17T01:00:00.000Z', now = Date.parse(at);
const PLAN = 'objective.plan.prepare' as const;
const OPERATION = 'objective_planner_continuation_operation';
const NAMESPACE = 'capiro.objective-planner.continuation:v1';
type Json = Record<string, any>;
const privateId = (value: unknown) => {
  const h = workDigest(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const application = createPlannerApplicationCodec({ sha256, isProxy: nodeTypes.isProxy });
const materialization = createPlannerMaterializationCodec({ sha256,
  digest: value => sha256(JSON.stringify(JSON.parse(application.applicationJson(value)))),
  canonicalRegenerationHash: application.applicationHash, plannerCalendarDate: plannerResourceCalendarDate,
  materializationError: code => { throw Error(code); } });

// Equivalent to the codec suite's complete v2 fixture, rebuilt through actual
// shared factories for this service's exact tenant/source/actor/consent. These
// records represent already committed work, never a current write grant.
function fullAppliedRows(work: Json, clerkUserId: string) {
  const c = work.canonical;
  const snapshot: StrategySnapshot = { meta: { id: c.canonicalStrategyId, clientId: c.clientId,
    title: 'Saved canonical plan', type: 'legislative', goal: null, meriContext: null, meriSummary: null,
    targetDate: null, ownerUserId: clerkUserId, createdByUserId: clerkUserId,
    createdAt: new Date(now - 3_000).toISOString() },
    nodes: [{ id: id(101), kind: 'action', subject: 'deliverable', title: 'Approved original work', note: 'Saved note',
      ownerUserId: null, status: 'draft', startsOn: '2026-10-17', endsOn: '2026-10-18', openEnded: false,
      dependsOnIds: [], meriAuthored: true, createdByUserId: clerkUserId, createdAt: new Date(now - 3_000).toISOString() }] };
  work.snapshotDigest = sha256(JSON.stringify(JSON.parse(application.applicationJson(snapshot))));
  const { actorUserId, consentId, controlVersion, ...fields } = work;
  const request = application.parseCanonicalApplication({ schemaVersion: 1, ...fields });
  const input = { requestId: request.applicationRequestId, generationJobId: request.generationJobId,
    expected: { strategyId: request.strategyId, strategyVersionId: request.strategyVersionId,
      objectiveRevisionId: c.requestedObjectiveRevisionId } };
  const source = { generationJobId: request.generationJobId, generationRequestId: request.generationRequestId,
    clientId: c.clientId, objectiveId: c.objectiveId, objectiveVersion: c.requestedObjectiveVersion,
    objectiveRevisionId: c.requestedObjectiveRevisionId, strategyId: request.strategyId,
    strategyVersionId: request.strategyVersionId, snapshotDigest: request.snapshotDigest };
  const binding = { canonical: request.canonical, generationRequestId: request.generationRequestId,
    objectiveReceiptSha256: request.objectiveReceiptSha256, snapshotDigest: request.snapshotDigest };
  const plan = materialization.materializationPlan(snapshot, snapshot.nodes.map(n => ({ id: n.id, archivedAt: null })), input);
  const owner: StoredCanonicalMaterialization = { receiptVersion: 2, input, binding,
    fingerprint: materialization.canonicalMaterializationFingerprint(input, binding), snapshot, archivedSourceNodeIds: [],
    result: materialization.materializationResult(plan, input, source, c.tenantId, clerkUserId,
      new Date(now - 2_000).toISOString(), materialization.materializationOutputResolver(c.tenantId, clerkUserId, input.requestId, binding)) };
  materialization.checkedCanonicalMaterialization(owner, binding, c.tenantId, clerkUserId);
  const ownerId = materialization.canonicalMaterializationReceiptId(c.tenantId, clerkUserId, request.applicationRequestId);
  const ack = application.creationAck(request, { tenantId: c.tenantId, actorUserId, clerkUserId, consentId, controlVersion,
    tokenExpiresAtMs: now + 120_000, delegationExpiresAtMs: now + 60_000, claimExpiresAtMs: now + 30_000,
    requestSha256: application.applicationHash(request), canonicalSha256: application.applicationHash(request.canonical) },
    owner, ownerId, new Date(now - 1_500).toISOString());
  const stored = { receiptVersion: 1, request, ack, ackSha256: application.applicationHash(ack) };
  const receiptId = application.applicationReceiptId(c.tenantId, clerkUserId, request.applicationRequestId);
  const row = (rowId: string, kind: string, name: string, data: unknown) => ({ id: rowId, tenantId: c.tenantId,
    ownerId: clerkUserId, projectId: null, kind, name, data, version: 1, archived: false, shareTokenHash: null });
  const head = { schemaVersion: 1, canonical: request.canonical, applicationRequestId: request.applicationRequestId,
    ackSha256: stored.ackSha256, source: ack.source, strategyId: ack.source.strategyId, projectId: c.canonicalProjectId };
  return { owner, stored, receiptId, resources: [
    row(ownerId, 'objective_canonical_materialization_receipt', 'Strategy plan preparation receipt', owner),
    row(receiptId, 'objective_canonical_application_receipt', 'Objective canonical application receipt', stored),
    row(application.applicationHeadId(c), 'objective_canonical_application_head', 'Objective canonical application head', head),
  ] };
}

function fixture(mode: 'initial' | 'failed' | 'cancelled' | 'leased' | 'applied' | 'full_applied' = 'initial', legacy = false) {
  const ctx = { tenantId: id(1), userId: id(2), clerkUserId: 'user_status', role: 'standard_user' } as TenantContext;
  const request: WorkReadRequest = { clientId: id(4), objectiveId: id(5), workAction: PLAN };
  const trace: string[] = [], writes: string[] = [];
  const f = { ctx, request, trace, writes, mode, inTransaction: false, transactions: 0,
    requestRevoked: false, revokeBefore: false, revokeRelease: false, expireAtRelease: false,
    clientRevoked: false, membershipRevoked: false, nativeMembershipRevoked: false,
    memoryWall: false, memoryDenied: false, proofClockChecks: 0,
    nativeUserRevoked: false, nativeUserRevokedAtRelease: false,
    malformedNativeProof: null as 'clerk' | 'command' | 'revision_snapshot' | null,
    objectiveVersion: 1, objectiveRevisionId: id(6), resources: [] as Json[],
    control: null as Json | null, consent: null as Json | null, commandReceipt: null as Json | null,
    outputPresent: false, rawOwnerUnavailable: false };
  const sourceColumns = { canonical_plan_id: id(7), canonical_epoch: 1, canonical_strategy_id: id(8),
    canonical_project_id: id(9), canonical_binding_version: 1, root_intent_id: id(10),
    source_revision_id: id(6), source_objective_version: 1, source_snapshot_hash: '', root_actor_user_id: id(2) };
  let snapshot: Json = { id: id(5), clientId: id(4), version: 1, status: 'ready', deletedAt: null,
    outcome: 'Retain original operation authority', governmentProblem: 'Authority can expire',
    askType: 'policy_authority', minimumWin: 'Current approved work', limits: '' };
  sourceColumns.source_snapshot_hash = objectiveRevisionSnapshotHash(snapshot);
  let root: Json = { id: id(10), tenant_id: id(1), client_id: id(4), objective_id: id(5),
    objective_revision_id: id(6), objective_version: 1, actor_user_id: id(2),
    snapshot_hash: sourceColumns.source_snapshot_hash, purpose: OBJECTIVE_WORK_PURPOSE,
    state: 'pending', blocked_reason: OBJECTIVE_WORK_BLOCKER, created_at: new Date(now - 6_000).toISOString() };
  const canonical: Json = { id: id(7), epoch: 1, binding_version: 1, canonical_strategy_id: id(8), canonical_project_id: id(9),
    requested_intent_id: id(10), requested_objective_revision_id: id(6), requested_objective_version: 1,
    requested_snapshot_hash: sourceColumns.source_snapshot_hash };
  if (mode !== 'initial') {
    const command = { schemaVersion: 1, requestId: id(11), command: 'retry', workAction: PLAN,
      expectedObjectiveVersion: 1, expectedControlVersion: 0, expectedCanonicalBindingVersion: 1,
      targetAuthorizationRequestId: null };
    const payload = workDigest({ clientId: id(4), objectiveId: id(5), command });
    f.control = { id: id(13), version: 1, current_consent_id: id(14), cancelled_at: null,
      cancelled_by_user_id: null, canonical_plan_id: id(7), canonical_epoch: 1,
      canonical_strategy_id: id(8), canonical_project_id: id(9) };
    f.consent = { id: id(14), tenant_id: id(1), client_id: id(4), objective_id: id(5), work_action: PLAN,
      ...sourceColumns, control_id: id(13), previous_consent_id: null, consenting_actor_user_id: id(2),
      consenting_membership_id: id(3), consent_policy_id: 'capiro.objective-generation-consent', consent_policy_revision: 1,
      configured_duration_ms: 600_000, effective_duration_ms: 600_000, stricter_expires_at: null, stricter_limit_ref: null,
      confirmed_at: new Date(now - 5_000).toISOString(), expires_at: new Date(now + 595_000).toISOString(),
      command_request_id: id(11), command_receipt_id: id(12), payload_digest: payload };
    f.commandReceipt = { id: id(12), tenant_id: id(1), client_id: id(4), objective_id: id(5), work_action: PLAN,
      ...sourceColumns, control_id: id(13), created_consent_id: id(14), result_consent_id: id(14),
      actor_user_id: id(2), actor_membership_id: id(3), request_id: id(11), payload_digest: payload,
      command, command_kind: 'retry', outcome: 'reconsent_recorded', target_consent_id: null,
      control_version_before: 0, control_version_after: 1, command_revision_id: id(6), command_objective_version: 1,
      committed_at: new Date(now - 4_000).toISOString() };
    const c = { canonicalPlanId: id(7), tenantId: id(1), clientId: id(4), objectiveId: id(5),
      canonicalStrategyId: id(8), canonicalProjectId: id(9), bindingVersion: 1, epoch: 1,
      requestedIntentId: id(10), requestedObjectiveRevisionId: id(6), requestedObjectiveVersion: 1,
      snapshotHash: sourceColumns.source_snapshot_hash };
    const work = { canonical: c,
      applicationRequestId: privateId({ namespace: 'capiro.objective-plan.application:v1', canonical: c, actorUserId: id(2) }),
      generationJobId: id(15), generationRequestId: id(16), strategyId: id(8), strategyVersionId: id(17),
      objectiveReceiptSha256: 'b'.repeat(64), snapshotDigest: 'c'.repeat(64), actorUserId: id(2), consentId: id(14), controlVersion: 1 };
    const full = mode === 'full_applied' ? fullAppliedRows(work, ctx.clerkUserId) : null;
    const operationId = privateId([NAMESPACE, work.applicationRequestId, id(14), workDigest(work)]), deadline = new Date(now + 60_000).toISOString();
    const original = { operationId, attemptId: privateId([NAMESPACE, 'attempt', operationId]),
      runId: privateId([NAMESPACE, 'run', operationId]), workSha256: workDigest(work), originalDeadlineAt: deadline,
      requestFingerprint: workDigest({ namespace: NAMESPACE, workSha256: workDigest(work), clerkUserId: ctx.clerkUserId,
        membershipId: id(3), originalDeadlineAt: deadline }) };
    f.resources.push({ id: operationId, tenantId: id(1), ownerId: ctx.clerkUserId, projectId: null, kind: OPERATION,
      name: 'Objective Planner continuation operation', version: mode === 'leased' ? 2 : 3, archived: false, shareTokenHash: null,
      data: { schemaVersion: 1, namespace: NAMESPACE, tenantId: id(1), clerkUserId: ctx.clerkUserId, membershipId: id(3),
        work, original, state: mode === 'full_applied' ? 'applied' : mode,
        lease: mode === 'leased' ? { token: id(19), expiresAtMs: now + 30_000 } : null,
        terminal: mode === 'leased' ? null : { receiptId: full?.receiptId ?? (mode === 'applied' ? id(99) : operationId), recordedAtMs: now - 1_000 } } });
    if (full) f.resources.push(...full.resources);
  }

  const evidence = () => clone({ canonical, root, snapshot, control: f.control, consent: f.consent,
    receipt: f.commandReceipt, resources: f.resources });
  let tx: Prisma.TransactionClient;
  const execute = jest.fn(async function(this: unknown, strings: TemplateStringsArray, ...values: unknown[]) {
    expect(this).toBe(tx);expect(f.inTransaction).toBe(true);
    const sql = strings.join('?').replace(/\s+/g, ' ');
    if (sql.includes("set_config('statement_timeout'")) { trace.push('timeouts');return 1; }
    if (sql.includes('pg_advisory_xact_lock')) {
      expect(values).toEqual(['planner:' + ctx.tenantId]);trace.push('planner-gate');return 1;
    }
    writes.push(sql);throw Error('Status reads must never write native records');
  });
  const query = jest.fn(async function(this: unknown, strings: TemplateStringsArray, ...values: unknown[]) {
    expect(this).toBe(tx);expect(f.inTransaction).toBe(true);
    const sql = strings.join('?').replace(/\s+/g, ' ');
    if (/\b(INSERT|UPDATE|DELETE)\b/.test(sql)) { writes.push(sql);throw Error('Unexpected status write'); }
    if (sql.includes('clock_timestamp() <')) {
      f.proofClockChecks++;trace.push('proof-clock');
      expect(values).toEqual([new Date(now + 120_000).toISOString()]);
      return [{ valid: !(f.expireAtRelease && f.proofClockChecks === 2) }];
    }
    if (sql.includes('SELECT clock_timestamp() AS now')) { trace.push('observed-clock');return [{ now: new Date(now) }]; }
    if (sql.includes('FROM tenants t') && sql.includes('JOIN clients c')) {
      trace.push('native-client-lock');expect(values).toEqual([ctx.tenantId, ctx.userId, ctx.clerkUserId, request.clientId]);
      return f.clientRevoked || f.membershipRevoked || f.nativeUserRevoked ? [] : [{ userId: ctx.userId, memoryWall: f.memoryWall }];
    }
    if (sql.includes('FROM client_memory_access')) {
      trace.push('memory-wall-lock');expect(values).toEqual([ctx.tenantId, request.clientId, ctx.userId]);
      return f.memoryDenied ? [] : [{ id: id(21) }];
    }
    if (sql.includes('SELECT version FROM client_objectives')) {
      trace.push(sql.includes('FOR SHARE') ? 'objective-destination-lock' : 'current-authority');
      expect(values).toEqual([ctx.tenantId, request.clientId, request.objectiveId]);return [{ version: f.objectiveVersion }];
    }
    if (sql.includes('FROM client_objective_revisions') && sql.includes('SELECT id')) {
      trace.push('revision-read');expect(values).toEqual([ctx.tenantId, request.clientId, request.objectiveId, f.objectiveVersion]);
      return [{ id: f.objectiveRevisionId }];
    }
    if (sql.includes('FROM tenant_memberships m')) {
      trace.push('native-membership-lock');expect(values).toEqual([ctx.tenantId, ctx.userId, ctx.clerkUserId]);
      return f.nativeMembershipRevoked ? [] : [{ id: id(3) }];
    }
    if (sql.includes('SELECT status') && sql.includes('FROM client_objectives')) {
      trace.push('objective-status');expect(values).toEqual([ctx.tenantId, request.clientId, request.objectiveId, f.objectiveVersion]);
      return [{ status: 'ready' }];
    }
    if (sql.includes('FROM client_objective_canonical_plans')) {
      trace.push('canonical-state-lock');expect(sql).toContain('FOR SHARE');expect(values).toEqual([ctx.tenantId, request.clientId, request.objectiveId]);
      return [{ record: clone(canonical) }];
    }
    if (sql.includes('SELECT actor_user_id::text AS actor')) { trace.push('root-actor');return [{ actor: id(2) }]; }
    if (sql.includes('FROM client_objective_work_intents i JOIN client_objective_revisions')) {
      trace.push('root-evidence');return [{ record: clone(root), snapshot: clone(snapshot), operation: 'confirm_ready', revisionActor: id(2) }];
    }
    if (sql.includes('FROM client_objective_work_controls')) {
      trace.push('control-state-lock');expect(sql).toContain('FOR SHARE');
      expect(values).toEqual([ctx.tenantId, request.clientId, request.objectiveId, request.workAction]);
      return f.control && request.workAction === PLAN ? [{ record: clone(f.control) }] : [];
    }
    if (sql.includes('to_jsonb(c) AS consent') && sql.includes('to_jsonb(i) AS intent')) {
      trace.push('applied-native-chain-proof');
      expect(sql).toContain('FOR SHARE OF m,u,i,v');
      expect(values).toEqual([ctx.tenantId, request.clientId, request.objectiveId, PLAN, id(14), id(13)]);
      const row = { consent: clone(f.consent), receipt: clone(f.commandReceipt), intent: clone(root),
        revision: { id: f.objectiveRevisionId, tenant_id: ctx.tenantId, client_id: request.clientId,
          objective_id: request.objectiveId, version: f.objectiveVersion, operation: 'confirm_ready',
          actor_user_id: ctx.userId, snapshot: clone(snapshot), created_at: new Date(now - 6_000).toISOString() },
        clerkUserId: ctx.clerkUserId };
      if (f.malformedNativeProof === 'clerk') row.clerkUserId = 'user_other';
      else if (f.malformedNativeProof === 'command') row.receipt!.command.requestId = id(99);
      else if (f.malformedNativeProof === 'revision_snapshot') row.revision.snapshot.outcome = 'Corrupt original native evidence';
      return [row];
    }
    if (sql.includes('FROM client_objective_work_consents c')) {
      trace.push('consent-read');return f.consent ? [{ record: clone(f.consent) }] : [];
    }
    if (sql.includes('FROM client_objective_work_command_receipts r')) {
      trace.push('original-command-evidence');
      return f.commandReceipt ? [{ record: clone(f.commandReceipt), clerkUserId: ctx.clerkUserId }] : [];
    }
    if (sql.includes('FROM sp_planner_resources')) {
      trace.push('planner-owner-evidence');
      if (f.rawOwnerUnavailable) throw Error('Synthetic owner evidence unavailable');
      return clone(f.resources);
    }
    if (sql.includes('EXISTS') && sql.includes('sp_planner_projects') && sql.includes('sp_planner_tasks')) {
      trace.push('no-output-proof');expect(sql).not.toContain('archived');return [{ present: f.outputPresent }];
    }
    throw Error('Unexpected synthetic status SQL: ' + sql);
  });
  tx = { $executeRaw: execute, $queryRaw: query } as unknown as Prisma.TransactionClient;
  const principal = { tenantId: ctx.tenantId, actorId: ctx.userId };
  const recheck = jest.fn(async () => {
    const before = !f.inTransaction;trace.push(before ? 'proof-before' : 'proof-release');
    expect(f.inTransaction).toBe(!before);
    if (before ? f.revokeBefore : f.revokeRelease) throw Error('Synthetic current request revocation');
    if (f.nativeUserRevoked || !before && f.nativeUserRevokedAtRelease) throw Error('Synthetic request owner current native user refusal');
    return { principal, identityRevision: 'a'.repeat(64), expiresAtMs: now + 120_000 };
  });
  const proof: ApplicationAuthorityIdentityProof = { principal, identityRevision: 'a'.repeat(64), expiresAtMs: now + 120_000,
    recheckCurrent: recheck };
  const http = {} as Request;
  const readProof = jest.fn(async (seenHttp: Request, seenCtx: TenantContext) => {
    trace.push('request-proof');expect(seenHttp).toBe(http);expect(seenCtx).toBe(ctx);expect(f.inTransaction).toBe(false);
    if (f.requestRevoked) throw Error('Synthetic initial request refusal');return proof;
  });
  const withTenant = jest.fn(async (tenantId: string, run: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
    expect(tenantId).toBe(ctx.tenantId);expect(f.inTransaction).toBe(false);
    f.transactions++;f.inTransaction = true;trace.push('begin-tenant');
    try { return await run(tx); } finally { trace.push('end-tenant');f.inTransaction = false; }
  });
  const concrete = new ObjectivePlannerWorkOwner({ OBJECTIVE_PLANNER_CONTINUATION_ENABLED: 'true',
    OBJECTIVE_PLANNER_CONSENT_DURATION_MS: '600000' });
  const readLock = jest.spyOn(concrete, 'lockReadWithinTx'), reconcile = jest.spyOn(concrete, 'reconcileWithinTx');
  const writeLock = jest.spyOn(concrete, 'lockWithinTx'), policy = jest.spyOn(concrete, 'policyWithinTx');
  const ownerPort: ObjectiveWorkOwnerPort = legacy ? UNCONNECTED_OBJECTIVE_WORK_OWNER : concrete;
  const service = new ObjectiveWorkService({ withTenant } as unknown as PrismaService,
    { readApplicationAuthority: readProof } as unknown as TenantContextMiddleware, ownerPort);
  const read = () => service.read(ctx, http, request);
  const advanceSource = () => {
    f.objectiveVersion = 2;f.objectiveRevisionId = id(22);
    snapshot = { ...snapshot, version: 2, outcome: 'A changed Objective source' };
    canonical.binding_version = 2;canonical.requested_intent_id = id(23);
    canonical.requested_objective_revision_id = id(22);canonical.requested_objective_version = 2;
    canonical.requested_snapshot_hash = objectiveRevisionSnapshotHash(snapshot);
    root = { ...root, objective_revision_id: id(22), objective_version: 2, snapshot_hash: canonical.requested_snapshot_hash };
  };
  return { ...f, flags: f, tx, query, execute, read, evidence, advanceSource, concrete, readLock,
    reconcile, writeLock, policy, withTenant, readProof, recheck, proof, http, service };
}

function noEffects(f: ReturnType<typeof fixture>) {
  expect(f.writes).toEqual([]);expect(f.writeLock).not.toHaveBeenCalled();expect(f.policy).not.toHaveBeenCalled();
  expect(f.flags.inTransaction).toBe(false);
}

describe('actual WorkService Planner status reads (synthetic native SQL/proof only)', () => {
  it('takes the early Planner gate before current authority and Core state locks in the same native transaction', async () => {
    const f = fixture(), before = f.evidence(), result = await f.read();
    expect(result.reconciliation).toBe('not_started');expect(result.control.version).toBe(0);expect(result.consent).toBeNull();
    expect(f.withTenant).toHaveBeenCalledTimes(1);expect(f.readLock).toHaveBeenCalledWith(f.tx, f.ctx, f.request);
    expect(f.reconcile.mock.calls[0]![0]).toBe(f.tx);
    for (const lock of ['current-authority', 'native-client-lock', 'native-membership-lock', 'canonical-state-lock', 'control-state-lock'])
      expect(f.trace.indexOf('planner-gate')).toBeLessThan(f.trace.indexOf(lock));
    expect(f.trace.slice(0, 5)).toEqual(['request-proof', 'proof-before', 'begin-tenant', 'timeouts', 'planner-gate']);
    expect(f.recheck).toHaveBeenCalledTimes(2);expect(f.flags.proofClockChecks).toBe(2);
    expect(f.trace.slice(-3)).toEqual(['proof-release', 'proof-clock', 'end-tenant']);
    expect(f.evidence()).toEqual(before);noEffects(f);
  });

  it('fails closed when the early owner read gate rejects, before Core reads or proof release', async () => {
    const f = fixture(), before = f.evidence();f.readLock.mockRejectedValueOnce(Error('Synthetic Planner gate refusal'));
    await expect(f.read()).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
    expect(f.withTenant).toHaveBeenCalledTimes(1);expect(f.readLock).toHaveBeenCalledWith(f.tx, f.ctx, f.request);
    expect(f.query).not.toHaveBeenCalled();expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.recheck).toHaveBeenCalledTimes(1);expect(f.flags.proofClockChecks).toBe(0);
    expect(f.trace).toEqual(['request-proof', 'proof-before', 'begin-tenant', 'timeouts', 'end-tenant']);
    expect(f.evidence()).toEqual(before);noEffects(f);
  });

  it.each(['failed', 'cancelled'] as const)('reads verified original %s accounting without renewing consent or writing work', async outcome => {
    const f = fixture(outcome), before = f.evidence(), result = await f.read();
    expect(result.reconciliation).toBe('accounted');expect(result.control.currentAuthorizationRequestId).toBe(id(14));
    expect(result.consent).toMatchObject({ id: id(14), confirmedAt: f.flags.consent!.confirmed_at, expiresAt: f.flags.consent!.expires_at });
    expect(f.trace).toContain('original-command-evidence');expect(f.trace).toContain('no-output-proof');
    expect(f.recheck).toHaveBeenCalledTimes(2);expect(f.flags.proofClockChecks).toBe(2);expect(f.evidence()).toEqual(before);noEffects(f);
  });

  it('reads complete v2 applied owner/application/head accounting through the actual shared codecs and read kernel', async () => {
    const f = fixture('full_applied'), before = f.evidence();
    decodeObjectivePlannerApplied(f.resources[0]!.data as ObjectivePlannerAppliedOperation,
      f.resources.slice(1) as ObjectivePlannerResource[]);
    const result = await f.read();
    expect(result.reconciliation).toBe('accounted');expect(result.control.currentAuthorizationRequestId).toBe(id(14));
    expect(result.consent).toMatchObject({ id: id(14), confirmedAt: f.flags.consent!.confirmed_at,
      expiresAt: f.flags.consent!.expires_at });
    const operation = f.resources.find(row => row.kind === OPERATION)!.data;
    const receipt = f.resources.find(row => row.kind === 'objective_canonical_application_receipt')!;
    expect(await f.reconcile.mock.results[0]!.value).toMatchObject({ state: 'accounted', outcome: 'applied',
      terminalReceiptId: receipt.id, ...operation.original });
    expect(f.trace).toContain('original-command-evidence');expect(f.trace).toContain('planner-owner-evidence');
    expect(f.trace.filter(value => value === 'applied-native-chain-proof')).toHaveLength(1);
    expect(f.trace.indexOf('planner-owner-evidence')).toBeLessThan(f.trace.indexOf('applied-native-chain-proof'));
    expect(f.trace.indexOf('applied-native-chain-proof')).toBeLessThan(f.trace.indexOf('proof-release'));
    expect(f.trace).not.toContain('no-output-proof');expect(f.recheck).toHaveBeenCalledTimes(2);
    expect(f.flags.proofClockChecks).toBe(2);
    expect((await f.read()).reconciliation).toBe('accounted');
    expect(f.trace.filter(value => value === 'applied-native-chain-proof')).toHaveLength(2);
    expect(f.evidence()).toEqual(before);expect(f.flags.transactions).toBe(2);noEffects(f);
  });

  it.each(['clerk', 'command', 'revision_snapshot'] as const)
  ('keeps applied %s native lineage corruption uncertain without replacing the original source or consent', async malformed => {
    const f = fixture('full_applied'), before = f.evidence();f.flags.malformedNativeProof = malformed;
    expect((await f.read()).reconciliation).toBe('outcome_unconfirmed');
    expect(f.trace.filter(value => value === 'applied-native-chain-proof')).toHaveLength(1);
    expect(f.recheck).toHaveBeenCalledTimes(2);expect(f.evidence()).toEqual(before);noEffects(f);
  });

  it.each(['snapshot', 'fingerprint', 'deterministic_output'] as const)
  ('keeps malformed full applied %s evidence uncertain even after its surrounding hashes are recomputed', async malformed => {
    const f = fixture('full_applied');
    const owner = f.resources.find(row => row.kind === 'objective_canonical_materialization_receipt')!.data;
    const stored = f.resources.find(row => row.kind === 'objective_canonical_application_receipt')!.data;
    const head = f.resources.find(row => row.kind === 'objective_canonical_application_head')!.data;
    if (malformed === 'deterministic_output') {
      owner.result.tasks[0].output.id = id(99);stored.ack.tasks[0].taskId = id(99);
    }
    else delete owner[malformed];
    stored.ack.ownerReceiptSha256 = application.applicationHash(owner);
    stored.ackSha256 = application.applicationHash(stored.ack);head.ackSha256 = stored.ackSha256;
    const before = f.evidence();
    expect((await f.read()).reconciliation).toBe('outcome_unconfirmed');
    expect((await f.read()).reconciliation).toBe('outcome_unconfirmed');
    expect(f.recheck).toHaveBeenCalledTimes(4);expect(f.evidence()).toEqual(before);noEffects(f);
  });

  it.each(['nativeUserRevoked', 'nativeUserRevokedAtRelease'] as const)
  ('refuses applied accounting when the request owner reports %s through its current native identity proof', async flag => {
    const f = fixture('full_applied'), before = f.evidence();f.flags[flag] = true;
    await expect(f.read()).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
    if (flag === 'nativeUserRevoked') {
      expect(f.withTenant).not.toHaveBeenCalled();expect(f.reconcile).not.toHaveBeenCalled();
      expect(f.recheck).toHaveBeenCalledTimes(1);
    } else {
      expect(f.reconcile).toHaveBeenCalledTimes(1);
      expect(await f.reconcile.mock.results[0]!.value).toMatchObject({ state: 'accounted', outcome: 'applied' });
      expect(f.recheck).toHaveBeenCalledTimes(2);
    }
    expect(f.evidence()).toEqual(before);noEffects(f);
  });

  it('retains exact original command-receipt recovery under the current request and native scope checks', async () => {
    const f = fixture('failed');f.request.requestId = id(11);const result = await f.read();
    expect(result.commandReceipt).toMatchObject({ requestId: id(11), receiptId: id(12), authorizationRequestId: id(14),
      workAction: PLAN, outcome: 'reconsent_recorded' });
    expect(f.recheck).toHaveBeenCalledTimes(2);expect(f.flags.proofClockChecks).toBe(2);noEffects(f);
  });

  it.each(['requestRevoked', 'revokeBefore'] as const)('refuses %s before opening the status transaction or Planner gate', async flag => {
    const f = fixture();f.flags[flag] = true;
    await expect(f.read()).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(f.withTenant).not.toHaveBeenCalled();expect(f.readLock).not.toHaveBeenCalled();expect(f.reconcile).not.toHaveBeenCalled();noEffects(f);
  });

  it.each(['clientRevoked', 'membershipRevoked', 'nativeMembershipRevoked', 'memoryDenied'] as const)
  ('refuses current native %s with the Planner gate already held and no owner/effect read', async flag => {
    const f = fixture('failed');f.flags[flag] = true;if (flag === 'memoryDenied') f.flags.memoryWall = true;
    await expect(f.read()).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(f.trace.indexOf('planner-gate')).toBeLessThan(f.trace.indexOf('native-client-lock'));
    expect(f.reconcile).not.toHaveBeenCalled();expect(f.trace).not.toContain('planner-owner-evidence');noEffects(f);
  });

  it.each(['revokeRelease', 'expireAtRelease'] as const)('refuses %s after owner accounting rather than exposing a stale status result', async flag => {
    const f = fixture('failed'), before = f.evidence();f.flags[flag] = true;
    await expect(f.read()).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(f.reconcile).toHaveBeenCalledTimes(1);expect(f.recheck).toHaveBeenCalledTimes(2);
    expect(f.evidence()).toEqual(before);noEffects(f);
  });

  it('reports a changed current Objective/canonical binding as uncertain while retaining the original consent/operation', async () => {
    const f = fixture('failed');f.advanceSource();const before = f.evidence(), result = await f.read();
    expect(result.objective.revision).toEqual({ id: id(22), version: 2 });expect(result.reconciliation).toBe('outcome_unconfirmed');
    expect(result.consent!.id).toBe(id(14));expect(f.evidence()).toEqual(before);noEffects(f);
  });

  it.each(['leased', 'applied'] as const)('keeps actual %s owner state uncertain and a repeated status read never retries work', async state => {
    const f = fixture(state), before = f.evidence();
    expect((await f.read()).reconciliation).toBe('outcome_unconfirmed');
    expect((await f.read()).reconciliation).toBe('outcome_unconfirmed');
    expect(f.flags.transactions).toBe(2);expect(f.reconcile).toHaveBeenCalledTimes(2);expect(f.evidence()).toEqual(before);noEffects(f);
  });

  it.each(['corrupt_terminal', 'unavailable_owner', 'orphan_output'] as const)('keeps %s evidence uncertain without changing it into absence or retry authority', async state => {
    const f = fixture(state === 'orphan_output' ? 'initial' : 'failed');
    if (state === 'corrupt_terminal') f.flags.resources[0]!.data.terminal.receiptId = id(99);
    else if (state === 'unavailable_owner') f.flags.rawOwnerUnavailable = true;
    else f.flags.outputPresent = true;
    const before = f.evidence();expect((await f.read()).reconciliation).toBe('outcome_unconfirmed');
    expect(f.evidence()).toEqual(before);expect(f.recheck).toHaveBeenCalledTimes(2);noEffects(f);
  });

  it('supports the legacy owner without an optional early-read hook while remaining uncertain and read-only', async () => {
    const f = fixture('initial', true), result = await f.read();
    expect(result.reconciliation).toBe('outcome_unconfirmed');expect(f.trace).not.toContain('planner-gate');
    expect(f.recheck).toHaveBeenCalledTimes(2);expect(f.flags.proofClockChecks).toBe(2);noEffects(f);
  });

  it('keeps Strategy status reads independent of the Planner advisory gate and owner output accounting', async () => {
    const f = fixture();f.request.workAction = 'objective.strategy.draft' as WorkAction;
    expect((await f.read()).reconciliation).toBe('outcome_unconfirmed');
    expect(f.readLock).toHaveBeenCalledWith(f.tx, f.ctx, f.request);expect(f.trace).not.toContain('planner-gate');
    expect(f.trace).not.toContain('planner-owner-evidence');expect(f.recheck).toHaveBeenCalledTimes(2);
    expect(f.flags.proofClockChecks).toBe(2);noEffects(f);
  });
});
