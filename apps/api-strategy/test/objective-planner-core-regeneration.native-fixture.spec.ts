import 'reflect-metadata';
import { test } from '@jest/globals';
import assert from 'node:assert/strict';
import type { Prisma } from '../generated/prisma-client/index.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { WorkReceipt } from '../../api/src/clients/objectives/work/objective-work-command.js';
import { parseWorkCommand, workDigest } from '../../api/src/clients/objectives/work/objective-work-command.js';
import { applicationHash } from '../src/planner/objective-canonical-application.js';
import { readCanonicalSavedGeneration, requireCanonicalBasisCustody } from '../src/meri/objective-canonical-saved-generation.js';
import { buildObjectivePlannerRegenerationFixture } from './objective-planner-regeneration.fixture.js';
import { seedObjectivePlannerCoreNativeRegeneration } from './objective-planner-core-regeneration.native-fixture.js';
import type { ObjectivePlannerNativeReadySource } from './objective-planner-core-retry.native-fixture.js';

const nowMs = Date.parse('2026-10-17T12:00:00.000Z');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
type Row = Record<string, any>;

/** SOURCE-ONLY contract fixture. These synthetic rows and SQL observations
 * test the helper's composition of production codecs; they prove no native
 * transaction, RLS/locks, actual Core command, external SDK or issuer custody.
 * The helper under test has no injected ORM/authority/provider replacement. */
async function fixture(seed: string) {
  const memory = await buildObjectivePlannerRegenerationFixture(nowMs - 60_000, { seed });
  const f = memory.initial, { rows } = memory;
  rows.resources.splice(5);
  rows.jobs.splice(1); rows.versions.splice(0, rows.versions.length, ...rows.versions.filter(row => row.id === f.id('version')));
  Object.assign(rows.strategies[0]!, { ...copy(f.strategy), createdAt: new Date(f.strategy.createdAt) });
  rows.nodes.splice(0, rows.nodes.length, ...f.snapshot.nodes.map(n => ({ ...copy(n), tenantId: f.tenantId,
    strategyId: f.strategy.id, startsOn: new Date(n.startsOn), endsOn: n.endsOn ? new Date(n.endsOn) : null,
    createdAt: new Date(n.createdAt), archivedAt: null })));
  memory.revisions.splice(1);
  const source = { ...f.source, objectiveVersion: 4, objectiveRevisionId: f.id('actual-core-random-revision') };
  const objectiveSnapshot = { ...copy(f.objectiveSnapshot), version: 4, minimumWin: 'Actual ready revision minimum win' };
  const canonical = { ...copy(f.canonical), bindingVersion: 2, requestedObjectiveVersion: 4,
    requestedObjectiveRevisionId: source.objectiveRevisionId, requestedIntentId: f.id('actual-core-random-intent'),
    snapshotHash: applicationHash(objectiveSnapshot) };
  memory.revisions.push({ id: source.objectiveRevisionId, version: 4, snapshot: objectiveSnapshot });
  const advanced = { tenantId: f.tenantId, actorUserId: f.actorUserId, clerkUserId: f.clerkUserId, membershipId: f.membershipId,
    source, canonical, objectiveSnapshot, draft: {}, ready: {}, revision: {}, intent: {}, original: {} } as unknown as ObjectivePlannerNativeReadySource;
  const requestId = f.id('actual-core-plan-request'), receiptId = f.id('actual-core-plan-receipt'), consentId = f.id('actual-core-plan-consent');
  const request = parseWorkCommand(canonical.clientId, canonical.objectiveId, { schemaVersion: 1, requestId, command: 'retry',
    workAction: 'objective.plan.prepare', expectedObjectiveVersion: 4, expectedControlVersion: 1,
    expectedCanonicalBindingVersion: 2, targetAuthorizationRequestId: f.plannerConsentId });
  const at = new Date(nowMs - 1).toISOString(), expiresAt = new Date(nowMs + 600_000).toISOString();
  const receipt: WorkReceipt = { schemaVersion: 1, receiptId, requestId, payloadDigest: workDigest(request), clientId: source.clientId,
    objectiveId: source.objectiveId, command: 'retry', workAction: 'objective.plan.prepare',
    commandRevision: { id: source.objectiveRevisionId, version: 4 }, sourceRevision: { id: source.objectiveRevisionId, version: 4 },
    rootIntentId: canonical.requestedIntentId, controlVersionBefore: 1, controlVersionAfter: 2,
    targetAuthorizationRequestId: f.plannerConsentId, authorizationRequestId: consentId,
    consent: { id: consentId, confirmedAt: at, expiresAt }, outcome: 'reconsent_recorded', committedAt: at };
  const scope = { tenant_id: f.tenantId, client_id: source.clientId, objective_id: source.objectiveId,
    work_action: 'objective.plan.prepare', control_id: f.plannerControlId, canonical_plan_id: canonical.canonicalPlanId,
    canonical_epoch: 1, canonical_strategy_id: canonical.canonicalStrategyId, canonical_project_id: canonical.canonicalProjectId,
    canonical_binding_version: 2, root_intent_id: canonical.requestedIntentId, source_revision_id: source.objectiveRevisionId,
    source_objective_version: 4, source_snapshot_hash: canonical.snapshotHash, root_actor_user_id: f.actorUserId };
  const proof = { consent: { ...scope, id: consentId, previous_consent_id: f.plannerConsentId, command_receipt_id: receiptId,
    command_request_id: requestId, payload_digest: receipt.payloadDigest, consenting_actor_user_id: f.actorUserId,
    consenting_membership_id: f.membershipId, confirmed_at: at, expires_at: expiresAt,
    consent_policy_id: 'capiro.objective-generation-consent', consent_policy_revision: 1 },
  receipt: { ...scope, id: receiptId, request_id: requestId, payload_digest: receipt.payloadDigest, actor_user_id: f.actorUserId,
    actor_membership_id: f.membershipId, command_kind: 'retry', outcome: 'reconsent_recorded', target_consent_id: f.plannerConsentId,
    created_consent_id: consentId, result_consent_id: consentId, command_revision_id: source.objectiveRevisionId,
    command_objective_version: 4, control_version_before: 1, control_version_after: 2, command: request.command, committed_at: at },
  control: { id: f.plannerControlId, version: 2, current_consent_id: consentId, cancelled_at: null, ...scope },
  intent: { id: canonical.requestedIntentId, actor_user_id: f.actorUserId, objective_revision_id: source.objectiveRevisionId,
    objective_version: 4, snapshot_hash: canonical.snapshotHash, purpose: 'objective_strategy_plan', state: 'pending',
    blocked_reason: 'runtime_authority_unconnected' },
  revision: { id: source.objectiveRevisionId, version: 4, operation: 'confirm_ready', actor_user_id: f.actorUserId, snapshot: objectiveSnapshot },
  canonical: { id: canonical.canonicalPlanId, binding_version: 2, requested_intent_id: canonical.requestedIntentId,
    requested_objective_revision_id: source.objectiveRevisionId, requested_objective_version: 4, requested_snapshot_hash: canonical.snapshotHash } };
  const statements: string[] = [], baseQuery = memory.tx.$queryRaw.bind(memory.tx), baseUpdate = memory.tx.spNode.update.bind(memory.tx.spNode);
  const tx = { ...memory.tx,
    spNode: { ...memory.tx.spNode, async update(args: Row) {
      return baseUpdate({ ...args, data: Object.fromEntries(Object.entries(args.data).filter(([, value]) => value !== undefined)) } as any);
    } },
    async $executeRaw(parts: TemplateStringsArray, ..._values: unknown[]) { statements.push(parts.join('?')); return 1; },
    async $queryRaw(parts: TemplateStringsArray, ...values: unknown[]) {
      const sql = parts.join('?'); statements.push(sql);
      if (sql.includes('clock_timestamp()')) return [{ ms: String(nowMs) }];
      if (sql.includes('to_jsonb(cs) AS consent')) return [copy(proof)];
      if (sql.includes("work_action='objective.strategy.draft'")) return [{ id: f.id('generation-control'), version: 1, currentConsentId: f.admission.consentId }];
      return baseQuery(parts, ...values);
    },
  } as unknown as Prisma.TransactionClient;
  const prisma = { async withTenant(tenantId: string, callback: (tx: Prisma.TransactionClient) => Promise<unknown>) {
    assert.equal(tenantId, f.tenantId); return callback(tx);
  } } as unknown as PrismaService;
  return { f, advanced, receipt, proof, memory, tx, prisma, statements };
}

test('source-only native-helper composition appends schema2 from actual supplied source/receipt and retains original generation', async () => {
  const h = await fixture('native-core-regeneration-source-contract');
  const original = applicationHash(copy({ resources: h.memory.resources, jobs: h.memory.jobs, versions: h.memory.versions }));
  const result = await seedObjectivePlannerCoreNativeRegeneration(h.prisma, h.f, h.advanced, h.receipt);
  assert.equal(result.normalization.schemaVersion, 2);
  assert.deepEqual(result.canonical, h.advanced.canonical);
  assert.deepEqual(result.source, h.advanced.source);
  assert.equal(result.work.consentId, h.receipt.authorizationRequestId);
  assert.equal(result.work.controlVersion, h.receipt.controlVersionAfter);
  assert.notEqual(result.admission.consentId, result.work.consentId);
  assert.equal(result.normalized.nodeIds[0], h.f.normalized.nodeIds[0]);
  assert.equal(result.plan.newNodes.length, 1);
  assert.equal(result.basis.provenance.length, 1);
  assert.equal(result.basis.expectedStrategyVersionId, h.f.id('version'));
  assert.equal(result.publication.request.source.objectiveRevisionId, h.advanced.source.objectiveRevisionId);
  assert.equal(result.publication.request.source.intent.minimumWin, h.advanced.objectiveSnapshot.minimumWin);
  assert.equal(result.work.generationJobId, result.scope.generationJobId);
  assert.equal((await readCanonicalSavedGeneration(h.tx, result.scope)).normalization.schemaVersion, 2);
  await requireCanonicalBasisCustody(h.tx, result.basis);
  assert.equal((await readCanonicalSavedGeneration(h.tx, h.f.scope)).normalization.schemaVersion, 1);
  assert.equal(applicationHash(copy({ resources: h.memory.resources.slice(0, 5), jobs: h.memory.jobs.slice(0, 1),
    versions: h.memory.versions.slice(0, 1) })), original);
  const coreWrites = h.statements.filter(sql => /INSERT INTO client_objective_work_|UPDATE client_objective_work_/.test(sql));
  assert.equal(coreWrites.length, 3);
  assert.ok(coreWrites.every(sql => sql.includes('objective.strategy.draft') || sql.includes('UPDATE client_objective_work_controls')));
  assert.ok(h.statements.every(sql => !/DISABLE TRIGGER|\bGRANT\b|ALTER TABLE|TRUNCATE|DELETE FROM/i.test(sql)));
});

for (const [label, corrupt] of [
  ['caller receipt ID', (h: Awaited<ReturnType<typeof fixture>>) => { h.receipt.receiptId = h.f.id('wrong-receipt'); }],
  ['native consent membership', (h: Awaited<ReturnType<typeof fixture>>) => { h.proof.consent.consenting_membership_id = h.f.id('wrong-member'); }],
  ['native command digest', (h: Awaited<ReturnType<typeof fixture>>) => { h.proof.receipt.payload_digest = '0'.repeat(64); }],
  ['native current control', (h: Awaited<ReturnType<typeof fixture>>) => { h.proof.control.current_consent_id = h.f.plannerConsentId; }],
  ['native ready snapshot', (h: Awaited<ReturnType<typeof fixture>>) => { h.proof.revision.snapshot.minimumWin = 'wrong snapshot'; }],
] as const) test(`source-only helper refuses mismatched ${label} before synthetic generation writes`, async () => {
  const h = await fixture(`native-core-regeneration-${label.replace(/ /g, '-')}`); corrupt(h);
  await assert.rejects(seedObjectivePlannerCoreNativeRegeneration(h.prisma, h.f, h.advanced, h.receipt));
  assert.equal(h.memory.jobs.length, 1);
  assert.ok(h.statements.every(sql => !/INSERT INTO|UPDATE client_objective_work_controls/.test(sql)));
});

test('source-only helper rejects unchanged or caller-invented advanced canonical source before transaction', async () => {
  const h = await fixture('native-core-regeneration-stale-source');
  h.advanced.canonical = copy(h.f.canonical);
  await assert.rejects(seedObjectivePlannerCoreNativeRegeneration(h.prisma, h.f, h.advanced, h.receipt));
  assert.equal(h.statements.length, 0);
});
