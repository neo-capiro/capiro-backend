import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { planCanonicalRegeneration } from '../src/planner/canonical-regeneration-plan.ts';

// Execute the actual immutable materialization helpers with their actual pure
// calendar helper. Only Nest's error transport is replaced; no application,
// current authority, database, transaction or provider is simulated by it.
const source = new URL('../src/', import.meta.url);
const objective = readFileSync(new URL('meri/objective-generation.types.ts', source), 'utf8');
const uuidLine = objective.match(/^export const UUID = .*;$/m)?.[0];
const begin = objective.indexOf('export function digest('), end = objective.indexOf('\nfunction exact(', begin);
assert.ok(uuidLine && begin > 0 && end > begin, 'exact source digest boundary');
const moduleUrl = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const digestUrl = moduleUrl(stripTypeScriptTypes(`import {createHash} from 'node:crypto';\n${uuidLine}\n${objective.slice(begin, end)}`));
const errorsUrl = moduleUrl(`export class HttpException extends Error {
 constructor(response,status){super(String(response?.code));this.response=response;this.status=status;}
 getResponse(){return this.response;} getStatus(){return this.status;}
}`);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === '@nestjs/common') return nextResolve(errorsUrl, context);
  if (specifier === '@capiro/strategy-verifier')
    return nextResolve(new URL('../../../packages/strategy-verifier/src/planner.ts', source).href, context);
  let url;
  try { url = new URL(specifier, context.parentURL).href; } catch {}
  if (url === new URL('meri/objective-generation.types.js', source).href) return nextResolve(digestUrl, context);
  if (url === new URL('planner/canonical-regeneration-plan.js', source).href)
    return nextResolve(new URL('planner/canonical-regeneration-plan.ts', source).href, context);
  return nextResolve(specifier, context);
} });
const m = await import(new URL('planner/strategy-materialization.ts', source).href);
// Receipt hashes use the exact existing Objective digest copied above.
const { digest: hash } = await import(digestUrl);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clone = x => structuredClone(x);
function fixture() {
  const tenant = id(1), actor = 'user_fixture', at = '2026-10-16T04:00:00.000Z';
  const canonical = { canonicalPlanId: id(2), tenantId: tenant, clientId: id(3), objectiveId: id(4),
    canonicalStrategyId: id(5), canonicalProjectId: id(6), bindingVersion: 1, epoch: 1,
    requestedIntentId: id(7), requestedObjectiveRevisionId: id(8), requestedObjectiveVersion: 1,
    snapshotHash: 'a'.repeat(64) };
  const node = (n, title) => ({ id: id(n), kind: 'action', subject: 'deliverable', title, note: 'Saved note',
    ownerUserId: null, status: 'draft', startsOn: '2026-10-16', endsOn: '2026-10-17', openEnded: false,
    dependsOnIds: [], meriAuthored: true, createdByUserId: actor, createdAt: at });
  const input = { requestId: id(10), generationJobId: id(11), expected: {
    strategyId: id(5), strategyVersionId: id(12), objectiveRevisionId: id(8) } };
  const snapshot = { meta: { id: id(5), clientId: id(3), title: 'Original saved project' },
    nodes: [node(101, 'Original work'), node(102, 'Prior work')] };
  const source = { generationJobId: input.generationJobId, generationRequestId: id(13),
    clientId: id(3), objectiveId: id(4), objectiveVersion: 1, objectiveRevisionId: id(8),
    strategyId: id(5), strategyVersionId: id(12), snapshotDigest: hash(snapshot) };
  const binding = { canonical, generationRequestId: source.generationRequestId,
    objectiveReceiptSha256: 'b'.repeat(64), snapshotDigest: source.snapshotDigest };
  const plan = m.materializationPlan(snapshot, snapshot.nodes.map(n => ({ id: n.id, archivedAt: null })), input);
  const owner = { receiptVersion: 2, input, binding, fingerprint: m.canonicalMaterializationFingerprint(input, binding),
    snapshot, archivedSourceNodeIds: [], result: m.materializationResult(plan, input, source, tenant, actor, at,
      m.materializationOutputResolver(tenant, actor, input.requestId, binding)) };
  m.checkedCanonicalMaterialization(owner, binding, tenant, actor);
  const predecessor = { owner, applicationRequestId: input.requestId, applicationAckSha256: 'c'.repeat(64),
    ownerReceiptId: m.canonicalMaterializationReceiptId(tenant, actor, input.requestId), ownerReceiptSha256: hash(owner) };
  const previous = m.canonicalRegenerationPrevious(predecessor);
  const nextInput = { requestId: id(20), generationJobId: id(21), expected: {
    strategyId: id(5), strategyVersionId: id(22), objectiveRevisionId: id(18) } };
  const nextSnapshot = { meta: { ...snapshot.meta, title: 'Next saved project' },
    nodes: [node(101, 'New proposed work'), { ...node(103, 'New work'), dependsOnIds: [id(101)] }] };
  const nextSource = { ...source, generationJobId: id(21), generationRequestId: id(23), objectiveVersion: 2,
    objectiveRevisionId: id(18), strategyVersionId: id(22), snapshotDigest: hash(nextSnapshot) };
  const nextBinding = { canonical: { ...canonical, bindingVersion: 2, requestedIntentId: id(17),
    requestedObjectiveRevisionId: id(18), requestedObjectiveVersion: 2, snapshotHash: 'd'.repeat(64) },
    generationRequestId: id(23), objectiveReceiptSha256: 'e'.repeat(64), snapshotDigest: hash(nextSnapshot) };
  const nextPlan = m.materializationPlan(nextSnapshot, nextSnapshot.nodes.map(n => ({ id: n.id, archivedAt: null })), nextInput);
  const tasks = previous.taskIndex.map((entry, i) => ({ id: entry.taskId, version: 3, archived: false,
    data: { clientId: id(3), name: i === 0 ? 'PRIVATE_HUMAN_TITLE' : entry.baseline.name,
      description: entry.baseline.description, ...entry.baseline.schedule, dependencies: entry.baseline.dependencies,
      memberships: [], status: 'done', approval: 'approved', assigneeId: 'PRIVATE_HUMAN_ASSIGNEE',
      recurrence: null, startTime: null, dueTime: null, timeZone: null } }));
  const resolved = m.materializationOutputResolver(tenant, actor, nextInput.requestId, nextBinding);
  const prepared = planCanonicalRegeneration({ canonical: nextBinding.canonical,
    ownerReceiptId: m.canonicalMaterializationReceiptId(tenant, actor, nextInput.requestId), previous,
    project: { id: id(6), version: 4, archived: false, data: { clientId: id(3), name: 'PRIVATE_HUMAN_PROJECT',
      description: previous.project.baseline.description } }, currentTasks: tasks,
    proposed: { project: { name: nextPlan.groups[0].name, description: m.materializationProjectDescription(nextSource, nextInput.requestId) },
      tasks: nextPlan.actionable.map(n => ({ sourceNodeId: n.id,
        newTaskId: previous.taskIndex.some(t => t.sourceNodeId === n.id) ? null : resolved('task', n.id),
        fields: { name: n.title, description: n.note ?? '', schedule: { subtype: 'task', startOn: n.startsOn,
          dueOn: n.endsOn ?? n.startsOn } } })), sourceNodeIds: nextSnapshot.nodes.map(n => n.id), edges: nextPlan.edges },
    allTasks: tasks.map(t => ({ id: t.id, dependencies: t.data.dependencies })) });
  const witness = m.canonicalRegenerationWitness(prepared);
  const receipt = { receiptVersion: 3, input: nextInput, binding: nextBinding,
    fingerprint: m.canonicalMaterializationFingerprint(nextInput, nextBinding), snapshot: nextSnapshot,
    archivedSourceNodeIds: [], reconciliation: witness,
    result: m.canonicalRegenerationResult(nextPlan, nextInput, nextSource, witness, at) };
  return { tenant, actor, predecessor, receipt, binding: nextBinding, prepared };
}
const checked = x => m.checkedCanonicalMaterialization(x.receipt, x.binding, x.tenant, x.actor, x.predecessor);

test('v3 reconstructs exact reused/new outputs, truthful versions/counts and canonical-only issues', () => {
  const x = fixture(), result = checked(x).result;
  assert.equal(result.projects[0].output.id, x.binding.canonical.canonicalProjectId);
  assert.equal(result.projects[0].output.createdVersion, 1);
  assert.equal(result.projects[0].output.currentVersion, 5);
  assert.equal(result.tasks[0].output.id, x.predecessor.owner.result.tasks[0].output.id);
  assert.equal(result.tasks[0].output.currentVersion, 3);
  assert.equal(result.counts.createdProjects, 0); assert.equal(result.counts.createdTasks, 1);
  assert.deepEqual(result.tasks[0].currentGroupKeys, []);
  assert.deepEqual(result.issues.map(i => i.code), ['HUMAN_EDITS_PRESERVED', 'PRIOR_WORK_RETAINED']);
  assert.equal(Object.hasOwn(m.MATERIALIZATION_ISSUES, 'HUMAN_EDITS_PRESERVED'), false);
  assert.equal(Object.hasOwn(m.MATERIALIZATION_ISSUES, 'PRIOR_WORK_RETAINED'), false);
});
test('v3 witness does not persist current human row data or the complete tenant graph', () => {
  const x = fixture(), json = JSON.stringify(x.receipt);
  assert.equal(json.includes('PRIVATE_HUMAN_'), false);
  assert.equal(Object.hasOwn(x.receipt.reconciliation.project, 'data'), false);
  assert.ok(x.receipt.reconciliation.tasks.every(t => !Object.hasOwn(t, 'data')));
  assert.equal(Object.hasOwn(x.receipt.reconciliation, 'allTasks'), false);
  assert.match(x.receipt.reconciliation.mergedGraphSha256, /^[0-9a-f]{64}$/);
});
test('v2 remains exact and v3 cannot be admitted through the public v1 checker', () => {
  const x = fixture();
  assert.deepEqual(m.checkedCanonicalMaterialization(x.predecessor.owner, x.predecessor.owner.binding,
    x.tenant, x.actor), x.predecessor.owner);
  assert.throws(() => m.checkedMaterialization(x.receipt, x.receipt.result.source, x.tenant, x.actor));
});
for (const [name, mutate] of [
  ['output identity', x => { x.receipt.result.tasks[0].output.id = id(999); }],
  ['count', x => { x.receipt.result.counts.createdTasks = 2; }],
  ['applied version', x => { x.receipt.reconciliation.tasks[0].appliedVersion = 4; }],
  ['baseline', x => { x.receipt.reconciliation.taskIndex[0].baseline.name = 'Forged'; }],
  ['field hash', x => { x.receipt.reconciliation.tasks[0].fields[0].proposedSha256 = 'f'.repeat(64); }],
  ['edge omission', x => { x.receipt.reconciliation.edges = []; }],
  ['issue omission', x => { x.receipt.result.issues = []; }],
  ['retained mapping', x => { x.receipt.reconciliation.taskIndex.pop(); }],
  ['extra field', x => { x.receipt.reconciliation.project.data = {}; }],
  ['predecessor hash', x => { x.predecessor.ownerReceiptSha256 = 'f'.repeat(64); }],
]) test(`v3 rejects tampered ${name}`, () => { const x = fixture(); mutate(x); assert.throws(() => checked(x)); });
