import 'reflect-metadata';
import { test } from '@jest/globals';
import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '../generated/prisma-client/index.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { ObjectiveCanonicalApplicationService } from '../src/planner/objective-canonical-application.service.js';
import { ObjectiveCanonicalWorkloadAuthority } from '../src/planner/objective-canonical-authority.js';
import { PlannerService } from '../src/planner/planner.service.js';
import type { PlannerLinksService } from '../src/planner/planner-links.service.js';
import { applicationHash, applicationHeadId, applicationReceiptId, creationAck,
  type CanonicalApplicationGrant } from '../src/planner/objective-canonical-application.js';
import { producerApplication } from '../src/meri/objective-canonical-producer.js';
import { canonicalMaterializationFingerprint, canonicalMaterializationReceiptId,
  canonicalRegenerationPrevious, canonicalRegenerationResult, canonicalRegenerationWitness,
  checkedCanonicalMaterialization, materializationOutputResolver, materializationPlan,
  materializationProjectDescription, materializationResult, parseMaterialization,
  CANONICAL_MATERIALIZATION_RECEIPT, type CanonicalMaterializationBinding,
  type StoredCanonicalMaterializationV2, type StoredCanonicalMaterializationV3 } from '../src/planner/strategy-materialization.js';
import { planCanonicalRegeneration } from '../src/planner/canonical-regeneration-plan.js';
import { readPlannerRegenerationBindingWithinTx } from '../src/planner/objective-planner-regeneration.binding.js';
import { claimPlannerContinuationOperationWithinTx, finalizePlannerContinuationOperationWithinTx,
  insertPlannerContinuationOperationWithinTx, newPlannerContinuationOperation,
  PLANNER_CONTINUATION_OPERATION } from '../src/planner/objective-planner-continuation.store.js';
import { buildObjectivePlannerRegenerationFixture } from './objective-planner-regeneration.fixture.js';
import { ObjectivePlannerContinuationRuntime } from '../src/planner/objective-planner-continuation.runtime.js';
import { plannerContinuationGrantWithinTx } from '../src/planner/objective-planner-continuation.authority.js';
import type { StoredPlannerContinuationOperation } from '../src/planner/objective-planner-continuation.store.js';

const now = Date.parse('2026-10-17T06:00:00.000Z');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Real generation, basis, application and v2/v3 owner codecs; explicitly
 * synthetic ORM, lock/authority observations and in-process fixture execution.
 * No SQL, native transaction, provider or SDK custody result is claimed. */
async function fixture(seed = 'regeneration-binding-source', oldControlVersion = 1) {
  const f = await buildObjectivePlannerRegenerationFixture(now, { seed }), { tx, initial: old, regenerated: next } = f;
  old.work = { ...old.work, controlVersion: oldControlVersion };
  const calls: string[] = []; let revoked = false;
  const ownerBinding: CanonicalMaterializationBinding = { canonical: old.work.canonical,
    generationRequestId: old.work.generationRequestId, objectiveReceiptSha256: old.work.objectiveReceiptSha256,
    snapshotDigest: old.work.snapshotDigest };
  const input = parseMaterialization({ requestId: old.work.applicationRequestId, generationJobId: old.work.generationJobId,
    expected: { strategyId: old.work.strategyId, strategyVersionId: old.work.strategyVersionId,
      objectiveRevisionId: old.work.canonical.requestedObjectiveRevisionId } });
  const source = { generationJobId: old.work.generationJobId, generationRequestId: old.work.generationRequestId,
    clientId: old.source.clientId, objectiveId: old.source.objectiveId, objectiveVersion: old.source.objectiveVersion,
    objectiveRevisionId: old.source.objectiveRevisionId, strategyId: old.work.strategyId,
    strategyVersionId: old.work.strategyVersionId, snapshotDigest: old.work.snapshotDigest };
  const plan = materializationPlan(old.snapshot, old.snapshot.nodes.map(n => ({ id: n.id, archivedAt: null })), input);
  const owner: StoredCanonicalMaterializationV2 = { receiptVersion: 2, input, binding: ownerBinding,
    fingerprint: canonicalMaterializationFingerprint(input, ownerBinding), snapshot: plan.snapshot,
    archivedSourceNodeIds: [], result: materializationResult(plan, input, source, old.tenantId, old.clerkUserId,
      new Date(now - 50_000).toISOString(), materializationOutputResolver(old.tenantId, old.clerkUserId, input.requestId, ownerBinding)) };
  checkedCanonicalMaterialization(owner, ownerBinding, old.tenantId, old.clerkUserId);
  const grantFor = (work: typeof old.work): CanonicalApplicationGrant => ({ tenantId: old.tenantId,
    clerkUserId: old.clerkUserId, actorUserId: work.actorUserId, consentId: work.consentId, controlVersion: work.controlVersion,
    requestSha256: applicationHash(producerApplication(work)), canonicalSha256: applicationHash(work.canonical),
    tokenExpiresAtMs: now + 30_000, claimExpiresAtMs: now + 30_000, delegationExpiresAtMs: now + 30_000 });
  const ownerId = canonicalMaterializationReceiptId(old.tenantId, old.clerkUserId, input.requestId);
  const ack = creationAck(producerApplication(old.work), grantFor(old.work), owner, ownerId, new Date(now - 50_000).toISOString());
  const application = { receiptVersion: 1 as const, request: producerApplication(old.work), ack, ackSha256: applicationHash(ack) };
  const appId = applicationReceiptId(old.tenantId, old.clerkUserId, input.requestId);
  const resource = async (id: string, kind: string, data: unknown) => tx.spPlannerResource.create({ data: {
    id, tenantId: old.tenantId, ownerId: old.clerkUserId, kind, name: 'Regeneration qualification receipt',
    data: data as any, projectId: null, version: 1, archived: false, shareTokenHash: null } });
  await resource(ownerId, CANONICAL_MATERIALIZATION_RECEIPT, owner);
  await resource(appId, 'objective_canonical_application_receipt', application);
  await resource(applicationHeadId(old.canonical), 'objective_canonical_application_head', { schemaVersion: 1,
    canonical: old.canonical, applicationRequestId: input.requestId, ackSha256: application.ackSha256,
    source: ack.source, strategyId: old.work.strategyId, projectId: old.canonical.canonicalProjectId });
  const oldOperation = newPlannerContinuationOperation({ work: old.work, clerkUserId: old.clerkUserId,
    membershipId: old.membershipId, originalDeadlineAt: old.originalDeadlineAt });
  const oldQueued = await insertPlannerContinuationOperationWithinTx(tx, oldOperation);
  const oldClaimed = await claimPlannerContinuationOperationWithinTx(tx, oldQueued, { leaseToken: old.id('old-planner-lease'),
    nowMs: now - 51_000, leaseExpiresAtMs: now - 20_000 });
  assert.ok(oldClaimed);
  const oldApplied = await finalizePlannerContinuationOperationWithinTx(tx, oldClaimed, {
    state: 'applied', leaseToken: oldClaimed.data.lease!.token, terminalReceiptId: appId, nowMs: now - 49_000 });
  const currentData = newPlannerContinuationOperation({ work: next.work, clerkUserId: next.clerkUserId,
    membershipId: next.membershipId, originalDeadlineAt: next.originalDeadlineAt });
  const currentQueued = await insertPlannerContinuationOperationWithinTx(tx, currentData);
  const current = await claimPlannerContinuationOperationWithinTx(tx, currentQueued, { leaseToken: next.id('current-planner-lease'),
    nowMs: now, leaseExpiresAtMs: now + 30_000 }); assert.ok(current);
  const baseQuery = tx.$queryRaw.bind(tx);
  tx.$executeRaw = (async (parts: TemplateStringsArray) => { calls.push(parts.join('?')); return 1; }) as any;
  tx.$queryRaw = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join('?'); calls.push(sql);
    if (sql.includes('FROM sp_planner_resources') && sql.includes("kind LIKE 'objective_planner_continuation_%'"))
      return f.resources.filter(row => {
        const planId = row.data?.work?.canonical?.canonicalPlanId ?? row.data?.request?.canonical?.canonicalPlanId ??
          row.data?.binding?.canonical?.canonicalPlanId ?? row.data?.canonical?.canonicalPlanId;
        const objectiveId = row.data?.work?.canonical?.objectiveId ?? row.data?.request?.canonical?.objectiveId ??
          row.data?.binding?.canonical?.objectiveId ?? row.data?.canonical?.objectiveId;
        return row.tenantId === values[0] && (row.kind.startsWith('objective_planner_continuation_') ||
          ['objective_canonical_application_receipt', 'objective_canonical_materialization_receipt', 'objective_canonical_application_head'].includes(row.kind)) &&
          (planId == null || objectiveId == null || planId === values[4] || objectiveId === values[5]);
      })
        .slice(0, 257).map(row => ({ id: row.id, tenantId: row.tenantId, ownerId: row.ownerId, kind: row.kind }));
    if (sql.includes('FROM tenants t JOIN tenant_memberships')) return [{ userId: next.actorUserId, memoryWall: false }];
    if (sql.includes('FROM client_objectives')) return [{ id: next.source.objectiveId }];
    if (sql.includes('FROM sp_strategy')) return [{ id: next.work.strategyId }];
    return baseQuery(parts, ...values);
  }) as any;
  const prisma = { withTenant() { throw Error('A nested transaction must not run'); } } as unknown as PrismaService;
  const planner = new PlannerService(prisma, { validate() { throw Error('No external link transport'); } } as unknown as PlannerLinksService);
  const app = new ObjectiveCanonicalApplicationService(prisma, planner, new ObjectiveCanonicalWorkloadAuthority());
  const readPredecessor = () => app.readPredecessorWithinOwnerTransaction(tx, producerApplication(next.work), grantFor(next.work), async subject => {
    calls.push(`authority:${subject.purpose}`);
    assert.equal(subject.purpose, 'retained-result-read');
    if (revoked) throw Error('Synthetic current read authority revoked');
  });
  const read = () => readPlannerRegenerationBindingWithinTx(tx, { tenantId: next.tenantId, clerkUserId: next.clerkUserId },
    next.saved, next.work, { readPredecessor });
  return { ...f, owner, ownerId, application, appId, oldApplied, current, app, calls, readPredecessor, read, grantFor,
    revoke() { revoked = true; }, resource };
}

test('actual regenerated saved generation retains schema2 normalization, original basis custody and stable source identities', async () => {
  const f = await fixture();
  assert.equal(f.regeneratedSaved.normalization.schemaVersion, 2);
  assert.notEqual(f.initialSaved.receipt.objectiveReceipt.result!.strategyVersionId,
    f.regeneratedSaved.receipt.objectiveReceipt.result!.strategyVersionId);
  assert.equal(f.initialSaved.receipt.objectiveReceipt.result!.strategyId, f.regeneratedSaved.receipt.objectiveReceipt.result!.strategyId);
  assert.equal(f.plan.snapshot.nodes[0]!.id, f.initial.snapshot.nodes[0]!.id);
  assert.equal(f.basis.provenance[0]!.generationJobId, f.initial.scope.generationJobId);
  assert.equal(f.plan.snapshot.nodes[0]!.title, 'Human retained authorization request');
});

test('real application predecessor checker + basis + paired applied operation qualifies changed binding without absence', async () => {
  const f = await fixture(), before = copy(f.oldApplied);
  const binding = await f.read();
  assert.equal(binding.applications.length, 1);
  assert.equal(binding.priorAppliedOperation.id, f.oldApplied.id);
  assert.equal(binding.priorAppliedOperation.data.state, 'applied');
  assert.equal(binding.predecessor.ownerReceiptId, f.ownerId);
  assert.equal(binding.basisSha256, applicationHash(f.basis));
  assert.deepEqual(f.oldApplied, before);
  assert.equal(f.calls.filter(sql => sql === 'authority:retained-result-read').length, 2);
  assert.ok(f.calls.some(sql => sql.includes('pg_advisory_xact_lock')));
});

function regeneratedPlannerOwner(f: Awaited<ReturnType<typeof fixture>>,
  verified: Awaited<ReturnType<typeof readPlannerRegenerationBindingWithinTx>>) {
  const next = f.regenerated, work = next.work;
  const input = parseMaterialization({ requestId: work.applicationRequestId, generationJobId: work.generationJobId,
    expected: { strategyId: work.strategyId, strategyVersionId: work.strategyVersionId,
      objectiveRevisionId: work.canonical.requestedObjectiveRevisionId } });
  const source = { ...f.owner.result.source, generationJobId: work.generationJobId, generationRequestId: work.generationRequestId,
    objectiveVersion: work.canonical.requestedObjectiveVersion, objectiveRevisionId: work.canonical.requestedObjectiveRevisionId,
    strategyVersionId: work.strategyVersionId, snapshotDigest: work.snapshotDigest };
  const binding = { canonical: work.canonical, generationRequestId: work.generationRequestId,
    objectiveReceiptSha256: work.objectiveReceiptSha256, snapshotDigest: work.snapshotDigest };
  const plan = materializationPlan(next.snapshot, next.snapshot.nodes.map(n => ({ id: n.id, archivedAt: null })), input);
  const previous = canonicalRegenerationPrevious(verified.predecessor);
  const currentTasks = previous.taskIndex.map(entry => ({ id: entry.taskId, version: 3, archived: false, data: {
    clientId: next.source.clientId, name: 'Human Planner task name', description: entry.baseline.description,
    ...entry.baseline.schedule, dependencies: entry.baseline.dependencies, memberships: [], status: 'done',
    approval: 'approved', assigneeId: 'user_human', recurrence: null, startTime: null, dueTime: null, timeZone: null } }));
  const output = materializationOutputResolver(next.tenantId, next.clerkUserId, input.requestId, binding);
  const prepared = planCanonicalRegeneration({ canonical: work.canonical,
    ownerReceiptId: canonicalMaterializationReceiptId(next.tenantId, next.clerkUserId, input.requestId), previous,
    project: { id: work.canonical.canonicalProjectId, version: 3, archived: false,
      data: { clientId: next.source.clientId, name: 'Human Planner project name', description: previous.project.baseline.description } },
    currentTasks, proposed: { project: { name: plan.groups[0]!.name, description: materializationProjectDescription(source, input.requestId) },
      tasks: plan.actionable.map(n => ({ sourceNodeId: n.id, newTaskId: previous.taskIndex.some(t => t.sourceNodeId === n.id) ? null : output('task', n.id),
        fields: { name: n.title, description: n.note ?? '', schedule: { subtype: n.kind === 'milestone' ? 'milestone' as const : 'task' as const,
          startOn: n.startsOn, dueOn: n.endsOn ?? n.startsOn } } })), sourceNodeIds: plan.nodes.map(n => n.id), edges: plan.edges },
    allTasks: currentTasks.map(t => ({ id: t.id, dependencies: t.data.dependencies })) });
  const witness = canonicalRegenerationWitness(prepared);
  const receipt: StoredCanonicalMaterializationV3 = { receiptVersion: 3, input, binding,
    fingerprint: canonicalMaterializationFingerprint(input, binding), snapshot: plan.snapshot, archivedSourceNodeIds: [],
    reconciliation: witness, result: canonicalRegenerationResult(plan, input, source, witness, new Date(now).toISOString()) };
  const checked = checkedCanonicalMaterialization(receipt, binding, next.tenantId, next.clerkUserId, verified.predecessor);
  return { checked, prepared, receipt };
}

test('actual v3 planner codec reuses original outputs, preserves human edits and creates only new source work', async () => {
  const f = await fixture(), verified = await f.read(), { checked, prepared } = regeneratedPlannerOwner(f, verified);
  assert.equal(checked.result.counts.createdProjects, 0); assert.equal(checked.result.counts.createdTasks, 1);
  assert.equal(checked.result.tasks[0]!.output.id, f.owner.result.tasks[0]!.output.id);
  assert.equal(prepared.project.data.name, 'Human Planner project name');
  assert.equal(prepared.tasks[0]!.data!.name, 'Human Planner task name');
  assert.ok(checked.result.issues.some(issue => issue.code === 'HUMAN_EDITS_PRESERVED'));
});

test('persisted v3 predecessor retains every original v2 application and operation across a third saved generation', async () => {
  const f = await fixture(), verified = await f.read(), { receipt } = regeneratedPlannerOwner(f, verified), next = f.regenerated;
  const ownerId = canonicalMaterializationReceiptId(next.tenantId, next.clerkUserId, next.work.applicationRequestId);
  const ack = creationAck(producerApplication(next.work), f.grantFor(next.work), receipt, ownerId, new Date(now).toISOString());
  const application = { receiptVersion: 1 as const, request: producerApplication(next.work), ack, ackSha256: applicationHash(ack) };
  const appId = applicationReceiptId(next.tenantId, next.clerkUserId, next.work.applicationRequestId);
  await f.resource(ownerId, CANONICAL_MATERIALIZATION_RECEIPT, receipt);
  await f.resource(appId, 'objective_canonical_application_receipt', application);
  await f.tx.spPlannerResource.update({ where: { id: applicationHeadId(next.canonical), tenantId: next.tenantId },
    data: { version: { increment: 1 }, data: { schemaVersion: 1, canonical: next.canonical,
      applicationRequestId: next.work.applicationRequestId, ackSha256: application.ackSha256,
      source: ack.source, strategyId: next.work.strategyId, projectId: next.canonical.canonicalProjectId } as any } });
  const secondApplied = await finalizePlannerContinuationOperationWithinTx(f.tx, f.current, { state: 'applied',
    leaseToken: f.current.data.lease!.token, terminalReceiptId: appId, nowMs: now + 1 });
  const third = await f.appendRegeneration({ nowMs: now + 60_000, suffix: 'third-generation', newSourceNodeKey: 'review' });
  const thirdQueued = await insertPlannerContinuationOperationWithinTx(f.tx, newPlannerContinuationOperation({ work: third.work,
    clerkUserId: third.clerkUserId, membershipId: third.membershipId, originalDeadlineAt: third.originalDeadlineAt }));
  const thirdClaimed = await claimPlannerContinuationOperationWithinTx(f.tx, thirdQueued, { leaseToken: third.id('third-planner-lease'),
    nowMs: now + 60_000, leaseExpiresAtMs: now + 90_000 }); assert.ok(thirdClaimed);
  const grant = { ...f.grantFor(third.work), tokenExpiresAtMs: now + 120_000,
    claimExpiresAtMs: now + 120_000, delegationExpiresAtMs: now + 120_000 };
  const read = () => readPlannerRegenerationBindingWithinTx(f.tx, { tenantId: third.tenantId, clerkUserId: third.clerkUserId },
    third.saved, third.work, { readPredecessor: () => f.app.readPredecessorWithinOwnerTransaction(f.tx,
      producerApplication(third.work), grant, async subject => { assert.equal(subject.purpose, 'retained-result-read'); }) });
  const binding = await read();
  assert.equal(binding.predecessor.owner.receiptVersion, 3);
  assert.deepEqual(binding.applications.map(entry => entry.operation.id), [secondApplied.id, f.oldApplied.id]);
  assert.equal(binding.priorAppliedOperation.id, secondApplied.id);
  assert.equal(third.basis.provenance.length, 2);
  assert.equal(binding.basisSha256, applicationHash(third.basis));
  f.resources.splice(f.resources.findIndex(row => row.id === f.oldApplied.id), 1);
  await assert.rejects(read()); // A v3 head never makes an older accounting gap disappear.
});

test('missing checked predecessor and current read revocation remain uncertainty, with no replacement lineage', async () => {
  const f = await fixture(), before = applicationHash(f.resources);
  await assert.rejects(readPlannerRegenerationBindingWithinTx(f.tx, { tenantId: f.regenerated.tenantId,
    clerkUserId: f.regenerated.clerkUserId }, f.regenerated.saved, f.regenerated.work, { readPredecessor: async () => undefined }));
  f.revoke(); await assert.rejects(f.read()); assert.equal(applicationHash(f.resources), before);
});

for (const field of ['basis', 'completion', 'normalization'] as const)
  test(`actual retained regeneration ${field} corruption cannot admit existing Planner outputs`, async () => {
    const f = await fixture();
    if (field === 'basis') {
      f.regenerated.saved = copy(f.regenerated.saved);
      (f.regenerated.saved.publication.request as any).basis.provenance[0].snapshotSha256 = 'f'.repeat(64);
    }
    if (field === 'completion') f.jobs[0]!.input.canonicalCompletion.corePayloadSha256 = 'f'.repeat(64);
    if (field === 'normalization') f.resources.find(row => row.kind === 'objective_canonical_generation_normalization')!.data.snapshotDigest = 'f'.repeat(64);
    await assert.rejects(f.read());
  });

for (const state of ['queued', 'leased'] as const)
  test(`older ${state} operation never becomes absence from an elapsed lease`, async () => {
    const f = await fixture(), row = f.resources.find(row => row.id === f.oldApplied.id)!;
    row.data.state = state; row.data.terminal = null; row.version = state === 'queued' ? 1 : 2;
    row.data.lease = state === 'leased' ? { token: f.initial.id('stale-lease'), expiresAtMs: now - 1 } : null;
    await assert.rejects(f.read());
  });

for (const missing of ['operation', 'application', 'owner'] as const)
  test(`orphan prior accounting missing ${missing} stays uncertain`, async () => {
    const f = await fixture(), target = missing === 'operation' ? f.oldApplied.id : missing === 'application' ? f.appId : f.ownerId;
    f.resources.splice(f.resources.findIndex(row => row.id === target), 1); await assert.rejects(f.read());
  });

test('unknown operation kind, shared metadata and changed source are refused', async () => {
  for (const corrupt of ['kind', 'share', 'source']) {
    const f = await fixture(), row = f.resources.find(row => row.id === f.oldApplied.id)!;
    if (corrupt === 'kind') row.kind = 'objective_planner_continuation_unknown';
    if (corrupt === 'share') row.shareTokenHash = 'shared';
    if (corrupt === 'source') row.data.work.strategyVersionId = f.initial.id('substituted-version');
    await assert.rejects(f.read());
  }
});

test('initial generation and changed actor cannot be substituted as a regeneration binding', async () => {
  const f = await fixture();
  await assert.rejects(readPlannerRegenerationBindingWithinTx(f.tx, { tenantId: f.initial.tenantId, clerkUserId: f.initial.clerkUserId },
    f.initial.saved, f.initial.work, { readPredecessor: f.readPredecessor }));
  const work = copy(f.regenerated.work); work.actorUserId = f.initial.id('other-actor');
  await assert.rejects(readPlannerRegenerationBindingWithinTx(f.tx, { tenantId: f.regenerated.tenantId, clerkUserId: f.regenerated.clerkUserId },
    f.regenerated.saved, work, { readPredecessor: f.readPredecessor }));
});

test('an earlier failed consent is distinguished from a later paired application on the same action identity', async () => {
  const f = await fixture('earlier-failure-accounting', 3), old = f.initial;
  const work = { ...old.work, consentId: old.id('earlier-failed-planner-consent'), controlVersion: 1 };
  const data = newPlannerContinuationOperation({ work, clerkUserId: old.clerkUserId, membershipId: old.membershipId,
    originalDeadlineAt: old.originalDeadlineAt });
  const queued = await insertPlannerContinuationOperationWithinTx(f.tx, data);
  const claimed = await claimPlannerContinuationOperationWithinTx(f.tx, queued, { leaseToken: old.id('earlier-failed-lease'),
    nowMs: now - 55_000, leaseExpiresAtMs: now - 25_000 }); assert.ok(claimed);
  await finalizePlannerContinuationOperationWithinTx(f.tx, claimed, { state: 'failed', terminalReceiptId: claimed.id,
    leaseToken: claimed.data.lease!.token, nowMs: now - 54_000 });
  const verified = await f.read();
  assert.equal(verified.applications.length, 1); assert.equal(verified.priorAppliedOperation.id, f.oldApplied.id);
});

test('a foreign Clerk cannot borrow current saved-generation custody for a terminal operation', async () => {
  const f = await fixture(), next = f.regenerated;
  const work = { ...next.work, consentId: next.id('foreign-clerk-consent'), controlVersion: 1 };
  const queued = await insertPlannerContinuationOperationWithinTx(f.tx, newPlannerContinuationOperation({ work,
    clerkUserId: 'user_foreign_fixture', membershipId: next.id('foreign-membership'), originalDeadlineAt: next.originalDeadlineAt }));
  const claimed = await claimPlannerContinuationOperationWithinTx(f.tx, queued, { leaseToken: next.id('foreign-lease'),
    nowMs: now - 1_000, leaseExpiresAtMs: now + 30_000 }); assert.ok(claimed);
  await finalizePlannerContinuationOperationWithinTx(f.tx, claimed, { state: 'failed', terminalReceiptId: claimed.id,
    leaseToken: claimed.data.lease!.token, nowMs: now });
  await assert.rejects(f.read());
});

test('unreferenced application or owner accounting cannot hide outside the verified predecessor chain', async () => {
  for (const kind of ['objective_canonical_application_receipt', 'objective_canonical_materialization_receipt']) {
    const f = await fixture(), id = f.initial.id(`orphan-${kind}`);
    await f.resource(id, kind, kind === 'objective_canonical_application_receipt' ? f.application : f.owner);
    await assert.rejects(f.read());
  }
});

for (const kind of ['objective_canonical_application_receipt', 'objective_canonical_materialization_receipt',
  'objective_canonical_application_head'] as const)
  test(`same-Objective ${kind} cannot hide by claiming a different canonical plan`, async () => {
    const f = await fixture(), data: any = copy(kind === 'objective_canonical_application_receipt' ? f.application :
      kind === 'objective_canonical_materialization_receipt' ? f.owner :
        f.resources.find(row => row.kind === 'objective_canonical_application_head')!.data);
    const canonical = data.request?.canonical ?? data.binding?.canonical ?? data.canonical;
    canonical.canonicalPlanId = f.initial.id('different-claimed-plan');
    await f.resource(f.initial.id(`same-objective-orphan-${kind}`), kind, data);
    await assert.rejects(f.read());
  });

test('exact current application and owner identities cannot hide behind an unrelated embedded scope or kind', async () => {
  for (const identity of ['application', 'owner'] as const) {
    const f = await fixture(), work = f.regenerated.work;
    const id = identity === 'application' ? applicationReceiptId(f.regenerated.tenantId, f.regenerated.clerkUserId, work.applicationRequestId) :
      canonicalMaterializationReceiptId(f.regenerated.tenantId, f.regenerated.clerkUserId, work.applicationRequestId);
    await f.resource(id, 'corrupt_private_kind', { canonical: { ...work.canonical,
      objectiveId: f.initial.id('different-claimed-objective'), canonicalPlanId: f.initial.id('different-claimed-plan') } });
    await assert.rejects(f.read());
  }
});

test('the exact current durable operation is required before existing outputs can be qualified', async () => {
  for (const corrupt of ['missing', 'terminal', 'shared'] as const) {
    const f = await fixture(), row = f.resources.find(row => row.id === f.current.id)!;
    if (corrupt === 'missing') f.resources.splice(f.resources.indexOf(row), 1);
    if (corrupt === 'terminal') {
      row.data.state = 'failed'; row.data.lease = null;
      row.data.terminal = { receiptId: row.id, recordedAtMs: now }; row.version++;
    }
    if (corrupt === 'shared') row.shareTokenHash = 'shared';
    await assert.rejects(f.read());
  }
});

test('operation scan overflow stays uncertain rather than qualifying only the first page', async () => {
  const f = await fixture();
  while (f.resources.filter(row => row.kind === PLANNER_CONTINUATION_OPERATION).length < 257) {
    const id = f.initial.id(`overflow-operation-${f.resources.length}`);
    await f.resource(id, PLANNER_CONTINUATION_OPERATION, f.oldApplied.data);
  }
  await assert.rejects(f.read());
});

test('caller mutation after the first await cannot replace the pinned saved generation or work', async () => {
  const f = await fixture(), expected = f.oldApplied.id, work = copy(f.regenerated.work), saved = copy(f.regenerated.saved);
  const read = readPlannerRegenerationBindingWithinTx(f.tx, { tenantId: f.regenerated.tenantId,
    clerkUserId: f.regenerated.clerkUserId }, saved, work, { readPredecessor: f.readPredecessor });
  work.actorUserId = f.initial.id('mutated-after-entry');
  saved.admission.actorUserId = f.initial.id('mutated-saved-after-entry');
  const binding = await read;
  assert.equal(binding.priorAppliedOperation.id, expected);
  assert.equal(binding.predecessor.ownerReceiptId, f.ownerId);
});

/** Actual runtime/application/authority code over explicit synthetic native
 * row observations. This exercises owner composition and refusal order; it
 * cannot qualify native SQL, RLS, transaction rollback or deployed authority. */
async function runtimeFixture() {
  const f = await fixture(), next = f.regenerated, baseQuery = f.tx.$queryRaw.bind(f.tx), calls: string[] = [];
  let nativeReads = 0, allowedNativeReads = Number.POSITIVE_INFINITY, fenceNow = now;
  f.tx.$queryRaw = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const sql = parts.join('?').replace(/\s+/g, ' ').trim(); calls.push(sql);
    if (sql.startsWith('SELECT m.id::text AS id FROM tenant_memberships m')) {
      nativeReads++;
      return nativeReads <= allowedNativeReads ? [{ id: next.membershipId }] : [];
    }
    if (sql.includes('FROM tenants t') && sql.includes('JOIN tenant_memberships'))
      return [{ userId: next.actorUserId, memoryWall: false }];
    if (sql.includes('FROM sp_version') && sql.includes('FOR SHARE'))
      return f.versions.filter(row => row.tenantId === values[0] && row.strategyId === values[1] && row.id === values[2])
        .map(row => ({ id: row.id }));
    if (sql.includes('clock_timestamp()') && sql.endsWith('AS ms')) return [{ ms: String(now) }];
    if (sql.includes('clock_timestamp()') && sql.endsWith('AS "nowMs"')) return [{ nowMs: String(fenceNow) }];
    if (sql.startsWith('SELECT version FROM client_objectives')) return [{ version: next.source.objectiveVersion }];
    if (sql.startsWith('SELECT id FROM client_objective_revisions')) return [{ id: next.source.objectiveRevisionId }];
    if (sql.includes('FROM client_objectives o JOIN tenants')) return [{ status: 'ready' }];
    if (sql.includes('FROM client_objective_work_intents')) return [{ id: next.canonical.requestedIntentId,
      objectiveRevisionId: next.source.objectiveRevisionId, objectiveVersion: next.source.objectiveVersion,
      actorUserId: next.actorUserId, revisionActorUserId: next.actorUserId, snapshotHash: next.canonical.snapshotHash,
      purpose: 'objective_strategy_plan', state: 'pending', blockedReason: 'runtime_authority_unconnected',
      revisionOperation: 'confirm_ready', revisionSnapshot: next.objectiveSnapshot }];
    if (sql.includes('FROM client_objective_canonical_plans')) return [copy(next.canonical)];
    if (sql.includes('FROM client_objective_work_controls')) return [{ consentingActorUserId: next.actorUserId,
      membershipId: next.membershipId, nativeMembershipId: next.membershipId, rootActorUserId: next.actorUserId,
      policyId: 'capiro.objective-generation-consent', policyRevision: 1, expiryValid: true,
      configuredDurationMs: 600_000, effectiveDurationMs: 600_000,
      confirmedAtMs: String(now - 1_000), expiresAtMs: String(next.plannerExpiresAtMs) }];
    if (sql.startsWith('SELECT EXISTS(')) return [{ present: true }];
    return baseQuery(parts, ...values);
  }) as any;
  const config = new ConfigService({ OBJECTIVE_PLANNER_CONTINUATION_ENABLED: 'true' });
  const runtime = new ObjectivePlannerContinuationRuntime({ withTenant() { throw Error('No native transaction in source qualification'); } } as unknown as PrismaService,
    f.app, config);
  type Eligibility = { requireEligibleEffect(tx: Prisma.TransactionClient, stored: StoredPlannerContinuationOperation,
    saved?: typeof next.saved, grant?: CanonicalApplicationGrant): Promise<void> };
  const eligible = (saved?: typeof next.saved, grant?: CanonicalApplicationGrant) =>
    (runtime as unknown as Eligibility).requireEligibleEffect(f.tx, f.current, saved, grant);
  const effectThenEligible = async (token = f.current.data.lease!.token, saved?: typeof next.saved) => {
    const grant = await plannerContinuationGrantWithinTx(f.tx, f.current, 'effect', token);
    return eligible(saved, grant);
  };
  return { ...f, runtime, eligible, effectThenEligible, runtimeCalls: calls,
    nativeReads: () => nativeReads, allowNativeReads(value: number) { allowedNativeReads = value; },
    fenceNow(value: number) { fenceNow = value; }, disable() { config.set('OBJECTIVE_PLANNER_CONTINUATION_ENABLED', 'false'); } };
}

test('actual runtime eligibility composes the real saved reader, full predecessor owner and paired operation without changing old receipts', async () => {
  const f = await runtimeFixture(), before = applicationHash(f.resources), original = copy(f.oldApplied);
  await f.effectThenEligible();
  assert.ok(f.nativeReads() >= 3);
  assert.ok(f.runtimeCalls.some(sql => sql.includes('FROM client_objective_work_controls')));
  assert.ok(f.calls.some(sql => sql.includes("kind LIKE 'objective_planner_continuation_%'")));
  assert.equal(applicationHash(f.resources), before); assert.deepEqual(f.oldApplied, original);
});

test('actual runtime eligibility refuses orphaned original application and a substituted saved generation', async () => {
  const orphan = await runtimeFixture();
  orphan.resources.splice(orphan.resources.findIndex(row => row.id === orphan.appId), 1);
  await assert.rejects(orphan.effectThenEligible());
  const substituted = await runtimeFixture();
  await assert.rejects(substituted.effectThenEligible(undefined, substituted.initial.saved));
});

test('actual runtime effect admission refuses a wrong lease and revoked native actor before regeneration qualification', async () => {
  const wrongLease = await runtimeFixture();
  await assert.rejects(wrongLease.effectThenEligible(wrongLease.initial.id('wrong-current-lease')));
  assert.equal(wrongLease.calls.some(sql => sql.includes("kind LIKE 'objective_planner_continuation_%'")), false);
  const revoked = await runtimeFixture(); revoked.allowNativeReads(0);
  await assert.rejects(revoked.effectThenEligible());
  assert.equal(revoked.calls.some(sql => sql.includes("kind LIKE 'objective_planner_continuation_%'")), false);
});

test('actual runtime eligibility requires fresh native read after predecessor reconstruction and an enabled worker', async () => {
  const revoked = await runtimeFixture(), before = applicationHash(revoked.resources);
  revoked.allowNativeReads(2); // initial effect, then pre-owner read succeed; final owner read is revoked.
  await assert.rejects(revoked.effectThenEligible()); assert.equal(revoked.nativeReads(), 3);
  assert.equal(applicationHash(revoked.resources), before);
  const disabled = await runtimeFixture(); disabled.disable(); await assert.rejects(disabled.effectThenEligible());
});

test('actual runtime effect admission samples the final fence clock before releasing regeneration eligibility', async () => {
  const f = await runtimeFixture(); f.fenceNow(now + 30_001); // lease expires at now + 30s.
  await assert.rejects(f.effectThenEligible());
  assert.ok(f.runtimeCalls.some(sql => sql.endsWith('AS "nowMs"')));
  assert.equal(f.calls.some(sql => sql.includes("kind LIKE 'objective_planner_continuation_%'")), false);
});
