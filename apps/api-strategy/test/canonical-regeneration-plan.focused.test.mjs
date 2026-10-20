import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CanonicalRegenerationError,
  canonicalRegenerationHash,
  planCanonicalRegeneration,
} from '../src/planner/canonical-regeneration-plan.ts';

// One native Node source-stripped process. No Nest graph, compiler, database,
// provider, subprocess, write fixture or proof of current authorization.
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const copy = x => structuredClone(x);
const schedule = (changes = {}) => ({ subtype: 'task', startOn: '2026-10-16', dueOn: '2026-10-17', ...changes });
const fields = (n, changes = {}) => ({ name: `Saved ${n}`, description: `Note ${n}`, schedule: schedule(), ...changes });
function fixture() {
  const prior = { canonicalPlanId: id(1), tenantId: id(2), clientId: id(3), objectiveId: id(4),
    canonicalStrategyId: id(5), canonicalProjectId: id(6), bindingVersion: 1, epoch: 1,
    requestedIntentId: id(7), requestedObjectiveRevisionId: id(8), requestedObjectiveVersion: 1,
    snapshotHash: 'a'.repeat(64) };
  const canonical = { ...prior, bindingVersion: 2, requestedIntentId: id(9),
    requestedObjectiveRevisionId: id(10), requestedObjectiveVersion: 2, snapshotHash: 'b'.repeat(64) };
  const taskIndex = [101, 102].map((n, i) => ({ sourceNodeId: id(n), taskId: id(201 + i),
    createdVersion: 1, appliedVersion: 1, firstOwnerReceiptId: id(700), originalGroupKeys: ['default'],
    baseline: { ...fields(n), dependencies: [] } }));
  const currentTasks = taskIndex.map(entry => ({ id: entry.taskId, version: 3, archived: false,
    data: { clientId: id(3), name: entry.baseline.name, description: entry.baseline.description,
      ...entry.baseline.schedule, dependencies: [], startTime: null, dueTime: null, timeZone: null,
      recurrence: null, status: 'done', approval: 'approved', assigneeId: 'user_human',
      memberships: [{ projectId: id(6), sectionId: id(21), position: 7 }, { projectId: id(22), sectionId: null, position: 1 }],
      priority: 'high', parentId: id(23), customValues: { [id(24)]: 'Human custom value' },
      tags: ['manual'], collaborators: ['user_other'], estimateMinutes: 321, meetingId: id(25),
      recurrenceSuccessorId: id(26), deadlineAt: '2026-10-17T00:00:00.000Z' } }));
  return { canonical, ownerReceiptId: id(701), previous: { canonical: prior,
    applicationRequestId: id(702), applicationAckSha256: 'c'.repeat(64), ownerReceiptId: id(700),
    ownerReceiptSha256: 'd'.repeat(64), project: { createdVersion: 1, appliedVersion: 1,
      baseline: { name: 'Saved project', description: 'Saved project description' } }, taskIndex },
    project: { id: id(6), version: 4, archived: false, data: { clientId: id(3), name: 'Saved project',
      description: 'Saved project description', privacy: 'private', health: 'on_hold', defaultView: 'board',
      color: '#123456', members: [{ userId: 'user_other', role: 'editor' }],
      sections: [{ id: id(21), name: 'Human section' }], fields: [], startOn: null, dueOn: null } },
    currentTasks, proposed: { project: { name: 'Saved project', description: 'Saved project description' },
      tasks: taskIndex.map(entry => ({ sourceNodeId: entry.sourceNodeId, newTaskId: null,
        fields: { name: entry.baseline.name, description: entry.baseline.description, schedule: schedule() } })),
      sourceNodeIds: [id(101), id(102), id(103), id(104)], edges: [] },
    allTasks: [...currentTasks.map(t => ({ id: t.id, dependencies: [] })), { id: id(203), dependencies: [] }] };
}
const rejects = (input, code) => assert.throws(() => planCanonicalRegeneration(input), error =>
  error instanceof CanonicalRegenerationError && error.code === code);
const row = (plan, sourceNodeId = id(101)) => plan.tasks.find(t => t.sourceNodeId === sourceNodeId);
function add(input, n = 105, task = 205) {
  input.proposed.sourceNodeIds.push(id(n));
  input.proposed.tasks.push({ sourceNodeId: id(n), newTaskId: id(task), fields: fields(n) });
}
function humanDependencies(input, taskIndex, dependencies) {
  input.currentTasks[taskIndex].data.dependencies = dependencies;
  input.allTasks.find(t => t.id === input.currentTasks[taskIndex].id).dependencies = [...dependencies];
}

test('updates only unmodified source fields using the same project and mapped tasks', () => {
  const x = fixture();
  x.proposed.project = { name: 'New saved project', description: 'New source description' };
  x.proposed.tasks[0].fields = fields(101, { name: 'New work', description: 'New note',
    schedule: schedule({ subtype: 'milestone', startOn: '2026-11-01', dueOn: '2026-11-01' }) });
  const p = planCanonicalRegeneration(x), t = row(p);
  assert.equal(p.receiptVersion, 3); assert.equal(p.phase, 'planned');
  assert.equal(p.project.id, x.canonical.canonicalProjectId); assert.equal(p.project.appliedVersion, 5);
  assert.equal(t.taskId, x.previous.taskIndex[0].taskId); assert.equal(t.appliedVersion, 4);
  assert.equal(t.disposition, 'updated'); assert.equal(t.data.name, 'New work');
  assert.equal(t.data.subtype, 'milestone');
  for (const key of ['status', 'approval', 'assigneeId', 'memberships', 'priority', 'parentId', 'customValues',
    'tags', 'collaborators', 'estimateMinutes', 'meetingId', 'recurrenceSuccessorId'])
    assert.deepEqual(t.data[key], x.currentTasks[0].data[key], key);
  for (const key of ['privacy', 'health', 'defaultView', 'color', 'members', 'sections', 'fields'])
    assert.deepEqual(p.project.data[key], x.project.data[key], key);
  assert.deepEqual(p.counts, { createdProjects: 0, updatedProjects: 1, createdTasks: 0,
    updatedTasks: 1, reusedTasks: 1, retainedTasks: 0, humanPreservedFields: 0 });
});
test('preserves changed human fields and keeps last machine-applied baselines', () => {
  const x = fixture();
  x.project.data.name = 'Human project'; x.project.data.description = 'Human project note';
  x.currentTasks[0].data.name = 'Human task'; x.currentTasks[0].data.description = 'Human task note';
  Object.assign(x.currentTasks[0].data, { subtype: 'approval', startOn: null, dueOn: null });
  humanDependencies(x, 0, [id(203)]);
  x.proposed.tasks[0].fields = fields(101, { name: 'New model title', description: 'New model note' });
  x.proposed.edges = [{ sourceNodeId: id(101), dependsOnSourceNodeId: id(102), disposition: 'task_dependency' }];
  const p = planCanonicalRegeneration(x), t = row(p), index = p.taskIndex[0];
  assert.equal(p.project.write, false); assert.equal(t.disposition, 'reused');
  assert.deepEqual(t.data, x.currentTasks[0].data);
  assert.deepEqual(p.project.baseline, x.previous.project.baseline);
  assert.deepEqual(index.baseline, x.previous.taskIndex[0].baseline);
  assert.equal(p.counts.humanPreservedFields, 6);
  assert.deepEqual(p.edges, [{ ...x.proposed.edges[0], applied: false }]);
});
for (const [guard, value] of [['startTime', '09:30'], ['dueTime', '12:00'], ['timeZone', 'America/New_York'],
  ['recurrence', { frequency: 'weekly', interval: 1 }]]) {
  test(`human ${guard} preserves the full source date/subtype cluster`, () => {
    const x = fixture(); x.currentTasks[0].data[guard] = value;
    x.proposed.tasks[0].fields.schedule = schedule({ startOn: '2026-11-10', dueOn: '2026-11-11' });
    const p = planCanonicalRegeneration(x), t = row(p);
    assert.equal(t.data.startOn, '2026-10-16'); assert.equal(t.data.dueOn, '2026-10-17');
    assert.deepEqual(t.data[guard], value);
    assert.equal(t.fields.find(f => f.field === 'schedule').resolution, 'human_preserved');
    assert.deepEqual(p.taskIndex[0].baseline.schedule, x.previous.taskIndex[0].baseline.schedule);
  });
}
test('model convergence does not erase a previously observed human baseline difference', () => {
  const x = fixture(); x.currentTasks[0].data.name = 'Human title'; x.proposed.tasks[0].fields.name = 'Human title';
  const p = planCanonicalRegeneration(x);
  assert.equal(p.taskIndex[0].baseline.name, 'Saved 101');
  assert.equal(row(p).fields.find(f => f.field === 'name').resolution, 'human_preserved');
});
test('creates only genuinely new source IDs using explicit server-resolved task IDs', () => {
  const x = fixture(); add(x);
  x.proposed.edges = [{ sourceNodeId: id(105), dependsOnSourceNodeId: id(101), disposition: 'task_dependency' }];
  const p = planCanonicalRegeneration(x), t = row(p, id(105));
  assert.equal(t.taskId, id(205)); assert.equal(t.disposition, 'created'); assert.equal(t.createdVersion, 1);
  assert.equal(t.beforeVersion, null); assert.deepEqual(t.data.dependencies, [id(201)]);
  assert.equal(Object.hasOwn(t.data, 'status'), false, 'owner supplies canonical creation defaults');
  assert.equal(p.counts.createdTasks, 1); assert.equal(p.counts.createdProjects, 0);
  assert.deepEqual(p.taskIndex.find(i => i.sourceNodeId === id(105)).originalGroupKeys, ['default']);
});
test('retains removed tasks and their cumulative mapping without row mutation or archive', () => {
  const x = fixture(); x.proposed.tasks.splice(0, 1);
  const p = planCanonicalRegeneration(x), t = row(p);
  assert.equal(t.disposition, 'retained'); assert.equal(t.data, null); assert.equal(t.appliedVersion, 3);
  assert.equal(p.taskIndex.find(i => i.sourceNodeId === id(101)).active, false);
  assert.equal(p.taskIndex.find(i => i.sourceNodeId === id(101)).taskId, id(201));
  assert.equal(x.currentTasks[0].archived, false); assert.equal(p.counts.retainedTasks, 1);
});
test('removed and later readded source nodes reuse historical task identity', () => {
  const x = fixture(); x.proposed.tasks.splice(0, 1);
  const p = planCanonicalRegeneration(x);
  const next = fixture(); next.previous.canonical = x.canonical;
  next.canonical = { ...x.canonical, bindingVersion: 3, requestedObjectiveVersion: 3,
    requestedObjectiveRevisionId: id(30), requestedIntentId: id(31), snapshotHash: 'e'.repeat(64) };
  next.previous.taskIndex = p.taskIndex;
  next.previous.project = { createdVersion: 1, appliedVersion: p.project.appliedVersion, baseline: p.project.baseline };
  next.previous.ownerReceiptId = id(701); next.ownerReceiptId = id(703);
  const result = planCanonicalRegeneration(next);
  assert.equal(row(result).taskId, id(201)); assert.notEqual(row(result).disposition, 'created');
  assert.equal(result.counts.createdTasks, 0);
});
test('retains unavailable removed history but refuses to recreate a readded missing task', () => {
  const x = fixture(); x.proposed.tasks.splice(0, 1); x.currentTasks.splice(0, 1); x.allTasks.splice(0, 1);
  const p = planCanonicalRegeneration(x);
  assert.equal(row(p).appliedVersion, null); assert.equal(row(p).disposition, 'retained');
  const active = fixture(); active.currentTasks.splice(0, 1); active.allTasks.splice(0, 1);
  rejects(active, 'OUTPUT_UNAVAILABLE');
});
test('never restores archived mapped tasks or adopts a moved client row', () => {
  const x = fixture(); x.currentTasks[0].archived = true; rejects(x, 'OUTPUT_UNAVAILABLE');
  const moved = fixture(); moved.currentTasks[0].data.clientId = id(99); rejects(moved, 'OUTPUT_UNAVAILABLE');
});
test('preserves human multihoming, positions and intentional removal from the default project', () => {
  const x = fixture(); x.currentTasks[0].data.memberships.splice(0, 1); x.proposed.tasks[0].fields.name = 'New source title';
  const p = planCanonicalRegeneration(x);
  assert.deepEqual(row(p).data.memberships, [{ projectId: id(22), sectionId: null, position: 1 }]);
  assert.deepEqual(p.taskIndex[0].originalGroupKeys, ['default']);
});
test('rejects a cycle created by the merge with retained human dependency edges', () => {
  const x = fixture(); humanDependencies(x, 1, [id(203)]);
  x.allTasks.find(t => t.id === id(203)).dependencies = [id(201)];
  x.proposed.edges = [{ sourceNodeId: id(101), dependsOnSourceNodeId: id(102), disposition: 'task_dependency' }];
  rejects(x, 'CYCLIC_DEPENDENCY');
});
test('rejects missing human dependency references and incomplete current graph witnesses', () => {
  const x = fixture(); humanDependencies(x, 0, [id(999)]); rejects(x, 'MISSING_DEPENDENCY');
  const incomplete = fixture(); incomplete.allTasks.splice(0, 1); rejects(incomplete, 'BASELINE_INVALID');
});
test('checks source cycles involving context nodes and missing source references', () => {
  const x = fixture(); x.proposed.edges = [
    { sourceNodeId: id(103), dependsOnSourceNodeId: id(104), disposition: 'context_only' },
    { sourceNodeId: id(104), dependsOnSourceNodeId: id(103), disposition: 'context_only' },
  ]; rejects(x, 'CYCLIC_DEPENDENCY');
  const missing = fixture(); missing.proposed.edges = [{ sourceNodeId: id(103), dependsOnSourceNodeId: id(999), disposition: 'context_only' }];
  rejects(missing, 'MISSING_DEPENDENCY');
});
test('context and archived edges remain explicit non-task dependencies', () => {
  const x = fixture(); x.proposed.edges = [
    { sourceNodeId: id(101), dependsOnSourceNodeId: id(103), disposition: 'context_only' },
    { sourceNodeId: id(101), dependsOnSourceNodeId: id(104), disposition: 'archived_source' },
  ];
  const p = planCanonicalRegeneration(x);
  assert.deepEqual(p.edges, x.proposed.edges.map(e => ({ ...e, applied: false })));
  assert.deepEqual(row(p).data.dependencies, []);
});
test('refuses ID collisions, reidentification of retained nodes and duplicate source keys', () => {
  const x = fixture(); add(x, 105, 203); rejects(x, 'IDENTITY_COLLISION');
  const retained = fixture(); retained.proposed.tasks[0].newTaskId = id(205); rejects(retained, 'IDENTITY_COLLISION');
  const duplicate = fixture(); duplicate.proposed.tasks.push(copy(duplicate.proposed.tasks[0])); rejects(duplicate, 'INPUT_INVALID');
});
test('a machine baseline cannot claim ownership of an unrelated human task dependency', () => {
  const x = fixture(); x.previous.taskIndex[0].baseline.dependencies = [id(203)];
  humanDependencies(x, 0, [id(203)]);
  rejects(x, 'BASELINE_INVALID');
});
test('first scope requires an advancing ready revision and unchanged canonical output identities', () => {
  const x = fixture(); x.canonical = copy(x.previous.canonical); rejects(x, 'SOURCE_NOT_ADVANCED');
  const sameRevision = fixture(); sameRevision.canonical.requestedObjectiveRevisionId = id(8); rejects(sameRevision, 'SOURCE_NOT_ADVANCED');
  const replacement = fixture(); replacement.canonical.canonicalStrategyId = id(99); rejects(replacement, 'BASELINE_INVALID');
});
test('refuses version overflow only when the output would actually be written', () => {
  const x = fixture(); x.currentTasks[0].version = 2147483647; x.proposed.tasks[0].fields.name = 'Changed';
  rejects(x, 'VERSION_EXHAUSTED');
  const unchanged = fixture(); unchanged.currentTasks[0].version = 2147483647;
  assert.equal(row(planCanonicalRegeneration(unchanged)).appliedVersion, 2147483647);
});
test('rejects malformed source and current kind/date representations without coercion', () => {
  const x = fixture(); x.currentTasks[0].data.subtype = ['task']; rejects(x, 'INPUT_INVALID');
  const badDate = fixture(); badDate.proposed.tasks[0].fields.schedule.startOn = '2026-02-30'; rejects(badDate, 'INPUT_INVALID');
});
test('does not mutate input objects and produces deterministic private witnesses', () => {
  const x = fixture(), before = copy(x), p = planCanonicalRegeneration(x);
  assert.deepEqual(x, before); assert.deepEqual(planCanonicalRegeneration(copy(x)), p);
  p.tasks[0].data.customValues[id(24)] = 'Changed result copy';
  assert.deepEqual(x, before);
  assert.equal(canonicalRegenerationHash({ b: 'Unicode α', a: [1, null] }),
    canonicalRegenerationHash({ a: [1, null], b: 'Unicode α' }));
});
