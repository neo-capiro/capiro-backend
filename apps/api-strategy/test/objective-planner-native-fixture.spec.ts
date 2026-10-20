import 'reflect-metadata';
import { test } from '@jest/globals';
import assert from 'node:assert/strict';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { buildObjectivePlannerNativeFixture, seedObjectivePlannerNativeFixture } from './objective-planner-native-fixture.js';
import { applicationHash } from '../src/planner/objective-canonical-application.js';
import { readCanonicalSavedGeneration } from '../src/meri/objective-canonical-saved-generation.js';
import { checkCanonicalCompletionWitness } from '../src/meri/objective-canonical-completion-receipt.js';
import { canonicalGenerationProducer } from '../src/meri/objective-canonical-producer.js';
import { GENERATION_PRODUCER } from '../src/meri/objective-canonical-generation.js';
import { readCanonicalPlannerContinuation } from '../src/planner/objective-canonical-continuation.js';

/** Source fixture validation only. Actual production factories/readers are
 * imported without rewrites; the DB transaction below is explicitly synthetic. */
function transactionFixture(f: ReturnType<typeof buildObjectivePlannerNativeFixture>) {
  type Row = Record<string, any>;
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const rows = { resources: [] as Row[], jobs: [] as Row[], versions: [] as Row[], nodes: [] as Row[], strategies: [] as Row[] };
  const statements: string[] = [];
  const matches = (r: Row, where: Row = {}) => Object.entries(where).every(([key, value]) => r[key] === value);
  const model = (items: Row[], defaults: Row = {}) => ({
    async create({ data }: { data: Row }) { const row = { ...defaults, ...copy(data) }; items.push(row); return row; },
    async findFirst({ where }: { where: Row }) { return copy(items.find(row => matches(row, where)) ?? null); },
    async findMany({ where, select }: { where: Row; select?: Row }) {
      return items.filter(row => matches(row, where)).map(row => select ? { id: row.id } : copy(row));
    },
    async update({ where, data }: { where: Row; data: Row }) {
      const row = items.find(r => matches(r, where)); assert.ok(row); Object.assign(row, copy(data)); return row;
    },
  });
  const tx = {
    spPlannerResource: model(rows.resources, { projectId: null, version: 1, archived: false, shareTokenHash: null }),
    spDraftJob: model(rows.jobs, { strategyId: null, errorMessage: null }),
    spStrategy: model(rows.strategies), spVersion: model(rows.versions), spNode: model(rows.nodes),
    async $executeRaw(parts: TemplateStringsArray, ..._values: unknown[]) { statements.push(parts.join('?')); return 1; },
    async $queryRaw(parts: TemplateStringsArray, ..._values: unknown[]) {
      assert.match(parts.join('?'), /FROM client_objective_revisions/);
      return [{ snapshot: copy(f.objectiveSnapshot) }];
    },
  };
  let transactions = 0;
  const prisma = { async withTenant(tenant: string, fn: (value: typeof tx) => Promise<unknown>) {
    assert.equal(tenant, f.tenantId); transactions++; return fn(tx);
  } } as unknown as PrismaService;
  return { tx, prisma, rows, statements, transactions: () => transactions };
}
const nowMs = Date.parse('2026-10-17T00:00:00.000Z');

test('task-owned fixture builds actual candidate, normalization, preserved snapshot and completion codecs', () => {
  const f = buildObjectivePlannerNativeFixture(nowMs, { seed: 'deterministic-source-fixture' });
  assert.equal(f.admission.consentId === f.plannerConsentId, false);
  assert.equal(f.normalized.normalizationWitness.proposedPayloadSha256, f.input.canonicalCompletion!.corePayloadSha256);
  assert.equal(f.snapshot.nodes[0]!.id, f.normalized.nodeIds[0]);
  assert.deepEqual(checkCanonicalCompletionWitness(f.input.canonicalCompletion,
    { admission: f.admission, acceptance: f.acceptance, publication: f.publication }), f.input.canonicalCompletion);
  const producer = canonicalGenerationProducer({ admission: f.admission, acceptance: f.acceptance,
    jobId: f.scope.generationJobId, requestId: f.admission.generationRequestId, attempt: 2,
    coreFingerprint: f.input.objectiveGeneration!.fingerprint, receipt: f.receipt,
    strategyId: f.strategy.id, strategyVersionId: f.id('version'), snapshotDigest: applicationHash(f.snapshot) });
  assert.equal(producer.generation.jobId, f.scope.generationJobId);
});
test('seeding composes actual retained ledger readers in one synthetic transaction and keeps separate action consents', async () => {
  const f = buildObjectivePlannerNativeFixture(nowMs, { seed: 'ledger-source-fixture' }), h = transactionFixture(f);
  const seeded = await seedObjectivePlannerNativeFixture(h.prisma, f);
  assert.equal(h.transactions(), 1); assert.equal(h.rows.resources.length, 5);
  assert.equal(h.rows.resources.filter(row => row.kind === GENERATION_PRODUCER).length, 1);
  assert.equal(seeded.work.consentId, f.plannerConsentId);
  assert.equal(seeded.work.strategyVersionId, f.id('version'));
  assert.equal(h.rows.jobs[0]!.status, 'completed');
  const reconstructed = await readCanonicalSavedGeneration(h.tx as any, f.scope);
  assert.equal(reconstructed.receipt.snapshotDigest, applicationHash(f.snapshot));
  assert.equal(h.statements.filter(sql => sql.includes('INSERT INTO client_objective_work_consents')).length, 2);
  assert.equal(h.statements.filter(sql => sql.includes('INSERT INTO client_objective_work_command_receipts')).length, 2);
  assert.ok(h.statements.every(sql => !/DISABLE TRIGGER|\bGRANT\b|ALTER TABLE|TRUNCATE|DELETE FROM/i.test(sql)));
});
test('independent fixtures derive disjoint tenant, actor, canonical, job and node IDs', () => {
  const a = buildObjectivePlannerNativeFixture(nowMs, { seed: 'case-a' });
  const b = buildObjectivePlannerNativeFixture(nowMs, { seed: 'case-b' });
  for (const field of ['tenantId', 'actorUserId', 'plannerConsentId', 'membershipId'] as const)
    assert.notEqual(a[field], b[field]);
  assert.notEqual(a.scope.generationJobId, b.scope.generationJobId);
  assert.notEqual(a.normalized.nodeIds[0], b.normalized.nodeIds[0]);
});
test('actual retained reconstruction refuses tampered publication or saved version in prepared fixture', async () => {
  const f = buildObjectivePlannerNativeFixture(nowMs, { seed: 'corruption-source-fixture' }), h = transactionFixture(f);
  await seedObjectivePlannerNativeFixture(h.prisma, f);
  h.rows.versions[0]!.snapshot.meta.title = 'Tampered saved bytes';
  await assert.rejects(readCanonicalSavedGeneration(h.tx as any, f.scope), { code: 'OUTCOME_UNCONFIRMED' });
});
test('actual continuation reconstruction accepts the prepared fixture in the native test runner realm', async () => {
  const f = buildObjectivePlannerNativeFixture(nowMs, { seed: 'continuation-runner-realm' }), h = transactionFixture(f);
  const seeded = await seedObjectivePlannerNativeFixture(h.prisma, f);
  const work = await readCanonicalPlannerContinuation(h.tx as any, f.scope, { workAction: 'objective.plan.prepare',
    tenantId: f.tenantId, actorUserId: f.actorUserId, clerkUserId: f.clerkUserId, canonical: f.canonical,
    consentId: f.plannerConsentId, controlVersion: 1 });
  assert.equal(applicationHash(work), applicationHash(seeded.work));
});
