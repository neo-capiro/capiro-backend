import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

// Source-stripped actual pure merge, normalizer, digest and snapshot helpers.
// Synthetic owner basis/rows are not current authority, result custody or SQL.
const custody = [];
const asModule = s => `data:text/javascript;base64,${Buffer.from(s).toString('base64')}`;
async function source(path, replacements = []) {
  const raw = await readFile(new URL(path, import.meta.url), 'utf8'); let transformed = raw;
  for (const [from, to] of replacements) {
    assert.equal(transformed.split(from).length, 2, `one dependency ${from}`); transformed = transformed.replace(from, JSON.stringify(to));
  }
  custody.push({ path, sha256: createHash('sha256').update(raw).digest('hex') });
  return asModule(stripTypeScriptTypes(transformed));
}
const appUrl = await source('../src/planner/objective-canonical-application.ts');
const generationUrl = await source('../src/meri/objective-canonical-generation.ts', [["'../planner/objective-canonical-application.js'", appUrl]]);
const snapshotUrl = await source('../src/strategy/versioning.ts');
const draftUrl = await source('../src/meri/objective-canonical-draft.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'./objective-canonical-generation.js'", generationUrl],
]);
const mergeUrl = await source('../src/meri/objective-canonical-regeneration.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'../strategy/versioning.js'", snapshotUrl],
]);
const app = await import(appUrl), generation = await import(generationUrl), draft = await import(draftUrl), merge = await import(mergeUrl);
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
const clone = structuredClone;
const hash = app.applicationHash;
const nodeId = key => merge.canonicalStrategySourceNodeId(id(1), key);
const snapshotNode = (key, changes = {}) => ({ id: nodeId(key), kind: 'action', subject: 'deliverable',
  title: `Machine ${key}`, note: `Machine note ${key}`, status: 'draft', ownerUserId: null,
  startsOn: '2026-10-16', endsOn: '2026-10-17', openEnded: false, dependsOnIds: [],
  provenance: null, targetRef: null, meriAuthored: true, createdByUserId: 'user_original',
  createdAt: '2026-10-16T00:00:00.000Z', ...changes });
function fixture() {
  const canonical = { canonicalPlanId: id(1), tenantId: id(2), clientId: id(3), objectiveId: id(4),
    canonicalStrategyId: id(5), canonicalProjectId: id(6), bindingVersion: 2, epoch: 1,
    requestedIntentId: id(7), requestedObjectiveRevisionId: id(8), requestedObjectiveVersion: 2, snapshotHash: 'a'.repeat(64) };
  const admission = { schemaVersion: 1, namespace: generation.GENERATION_ADMISSION_NAMESPACE, canonical,
    actorUserId: id(9), clerkUserId: 'user_current', consentId: id(10), controlVersion: 1,
    generationJobId: id(11), generationRequestId: id(12), admittedAtMs: 1000, effectExpiresAtMs: 20000, expectedStrategyVersionId: id(20) };
  const meta = { id: id(5), clientId: id(3), title: 'Human Strategy title', type: 'authorization',
    goal: 'Human goal', meriContext: 'Human context', meriSummary: 'Machine summary', targetDate: null,
    ownerUserId: 'user_original', createdByUserId: 'user_original', createdAt: '2026-10-16T00:00:00.000Z' };
  const initialNodes = [snapshotNode('first'), snapshotNode('second')];
  const current = {meta: clone(meta), nodes: clone(initialNodes)};
  const b = { schemaVersion: 1, namespace: 'capiro.objective-strategy.basis:v1', canonical,
    sourceAdmissionSha256: hash(admission), strategyId: id(5), expectedStrategyVersionId: id(20),
    snapshot: clone(current), snapshotSha256: hash(current), archiveIndex: [], archiveIndexSha256: hash([]),
    sourceIndex: initialNodes.map((node, i) => ({ sourceNodeKey: ['first','second'][i], nodeId: node.id, archived: false,
      lastMachine: {normalizationId: id(21), node: clone(node)} })), sourceIndexSha256: '',
    lastMachineStrategy: {normalizationId: id(21), meta: clone(meta)},
    provenance: [{ownerUserId: 'user_original', generationJobId: id(22), generationRequestId: id(23), canonicalBindingVersion: 1,
      admissionId: id(24), admissionSha256: 'b'.repeat(64), acceptanceId: id(25), acceptanceSha256: 'c'.repeat(64),
      normalizationId: id(21), normalizationSha256: 'd'.repeat(64), producerId: id(26), producerSha256: 'e'.repeat(64),
      strategyVersionId: id(27), snapshotSha256: 'f'.repeat(64)}] };
  const payload = { type: 'authorization', rationale: 'Synthetic complete regenerated proposal', summary: 'Next machine summary',
    nodes: ['first','second'].map(key => proposal(key)),
    coverage: {complete: true, omitted: [], assumptions: [], sources: [], pendingSources: []} };
  const x = {admission, basis: b, current, payload, archivedNodeIds: [], createdByUserId: 'user_current',
    createdAt: '2026-10-16T00:01:00.000Z', normalizationId: id(28)};
  refresh(x); return x;
}
function proposal(key, changes = {}) { return {sourceNodeKey: key, kind: 'action', subject: 'deliverable', title: `Next ${key}`,
  note: `Next note ${key}`, status: 'draft', ownerRef: null, startsOn: '2026-11-01', endsOn: '2026-11-02', openEnded: false,
  sources: [], dependsOn: [], ...changes}; }
function refresh(x) {
  x.basis.snapshot = clone(x.current); x.basis.snapshotSha256 = hash(x.current);
  x.basis.sourceIndexSha256 = hash(x.basis.sourceIndex); x.basis.archiveIndexSha256 = hash(x.basis.archiveIndex);
}
function input(x) {
  return {basis: x.basis, current: x.current, archivedNodeIds: x.archivedNodeIds,
    createdByUserId: x.createdByUserId, createdAt: x.createdAt, normalizationId: x.normalizationId,
    normalized: draft.normalizeCanonicalRegenerationDraft(x.payload, {admission: x.admission,
      queuedType: 'authorization', basis: x.basis, ownerMap: new Map([['member', 'user_proposed']])})};
}
const plan = x => merge.planCanonicalStrategyRegeneration(input(x));
const refuses = (run, code) => assert.throws(run, e => e instanceof merge.CanonicalStrategyRegenerationError && e.code === code);
const baseline = (p, key = 'first') => p.sourceIndex.find(n => n.sourceNodeKey === key).lastMachine.node;
const observed = (p, key = 'first') => p.snapshot.nodes.find(n => n.id === nodeId(key));
function archive(x, key) {
  x.current.nodes = x.current.nodes.filter(n => n.id !== nodeId(key));
  x.archivedNodeIds.push(nodeId(key)); x.basis.archiveIndex.push({nodeId: nodeId(key), archivedAt: '2026-10-16T00:00:30.000Z'});
  x.basis.sourceIndex.find(n => n.sourceNodeKey === key).archived = true; refresh(x);
}
function retouchNormalized(n) {
  n.normalizationWitness.normalizedResponseSha256 = hash(n.response);
  n.normalizationWitness.nodeIdsSha256 = hash(n.nodeIds);
  n.normalizationWitness.sourceKeysSha256 = hash(n.sourceKeys);
}

test('plans source-owned patches while preserving the same Strategy and node identities', () => {
  const x = fixture(), p = plan(x);
  assert.equal(p.schemaVersion, 2); assert.equal(p.phase, 'planned'); assert.equal(p.strategyId, id(5));
  assert.deepEqual(p.nodePatches.map(n => n.nodeId), [nodeId('first'),nodeId('second')]);
  assert.equal(observed(p).title, 'Next first'); assert.equal(baseline(p).title, 'Next first');
  assert.deepEqual(p.metaPatch, {meriSummary: 'Next machine summary'});
  assert.equal(p.snapshot.meta.title, 'Human Strategy title'); assert.equal(p.snapshot.meta.goal, 'Human goal');
  assert.equal(p.snapshot.meta.meriContext, 'Human context');
  assert.deepEqual(p.planning, {createdByUserId: x.createdByUserId, createdAt: x.createdAt});
  assert.deepEqual(p.normalized, input(x).normalized); assert.equal(p.counts.createdNodes, 0);
});
test('human title, note, schedule and summary win without resetting machine baselines', () => {
  const x = fixture(); x.current.nodes[0].title = 'Human title'; x.current.nodes[0].note = 'Human note';
  x.current.nodes[0].startsOn = '2026-12-01'; x.current.nodes[0].endsOn = null; x.current.meta.meriSummary = 'Human summary'; refresh(x);
  const p = plan(x);
  assert.equal(observed(p).title, 'Human title'); assert.equal(baseline(p).title, 'Machine first');
  assert.equal(observed(p).note, 'Human note'); assert.equal(baseline(p).note, 'Machine note first');
  assert.equal(observed(p).startsOn, '2026-12-01'); assert.equal(baseline(p).startsOn, '2026-10-16');
  assert.equal(p.snapshot.meta.meriSummary, 'Human summary'); assert.equal(p.lastMachineStrategy.meta.meriSummary, 'Machine summary');
  assert.equal(p.counts.humanPreservedFields, 4);
});
test('proposal convergence to a human value still retains the original machine baseline', () => {
  const x = fixture(); x.current.nodes[0].title = 'Converged human value'; x.payload.nodes[0].title = 'Converged human value'; refresh(x);
  const p = plan(x); assert.equal(baseline(p).title, 'Machine first');
  assert.equal(p.fields.find(f => f.nodeId === nodeId('first') && f.field === 'title').resolution, 'human_preserved');
});
test('existing status, owner, target reference, provenance and creation identity never become source patches', () => {
  const x = fixture(); Object.assign(x.current.nodes[0], {status:'completed', ownerUserId:'user_human',
    targetRef:{kind:'manual-target',value:'retained'}, provenance:{sources:[{section:'manual',ref:'human'}],human:true}});
  x.payload.nodes[0].status='active'; x.payload.nodes[0].ownerRef='member';
  x.payload.nodes[0].sources=[{section:'new-evidence',ref:'source'}]; refresh(x);
  const p = plan(x), n = observed(p);
  for (const field of ['status','ownerUserId','targetRef','provenance','createdByUserId','createdAt','meriAuthored'])
    assert.deepEqual(n[field], x.current.nodes[0][field]);
  assert.deepEqual(p.proposedDisagreements.map(d=>d.field).sort(), ['ownerUserId','provenance','status']);
  assert.ok(p.nodePatches.every(n=>Object.keys(n.patch).every(k=>!['status','ownerUserId','provenance','targetRef','createdAt'].includes(k))));
});
test('new keys receive the existing deterministic namespace and source-owned initial values exactly once', () => {
  const x=fixture(); x.payload.nodes.push(proposal('new_step',{dependsOn:['first'],ownerRef:'member',sources:[{section:'fixture',ref:'new'}]}));
  const p=plan(x), n=p.newNodes[0];
  assert.equal(n.id,nodeId('new_step')); assert.equal(n.ownerUserId,'user_proposed');
  assert.deepEqual(n.dependsOnIds,[nodeId('first')]); assert.equal(n.createdByUserId,x.createdByUserId);
  assert.equal(n.createdAt,x.createdAt); assert.equal(p.counts.createdNodes,1);
  assert.equal(p.sourceIndex.find(e=>e.sourceNodeKey==='new_step').lastMachine.normalizationId,x.normalizationId);
});
test('omitted generated and unassociated manual nodes remain live and untouched', () => {
  const x=fixture(), manual={...snapshotNode('unused'),id:id(100),title:'Manual addition',meriAuthored:false};
  x.current.nodes.push(manual); x.payload.nodes=x.payload.nodes.filter(n=>n.sourceNodeKey==='second'); refresh(x);
  const p=plan(x);
  assert.deepEqual(p.snapshot.nodes.find(n=>n.id===nodeId('first')),x.current.nodes[0]);
  assert.deepEqual(p.snapshot.nodes.find(n=>n.id===manual.id),manual);
  assert.deepEqual(p.retainedNodeIds,[nodeId('first'),manual.id]); assert.equal(p.sourceIndex.length,2);
  assert.equal(baseline(p).title,'Machine first');
});
test('readded omitted work reuses the cumulative node ID instead of cloning it', () => {
  const x=fixture(); x.payload.nodes=x.payload.nodes.filter(n=>n.sourceNodeKey==='second'); const prior=plan(x);
  x.basis.sourceIndex=prior.sourceIndex; x.basis.lastMachineStrategy=prior.lastMachineStrategy; x.current=prior.snapshot;
  x.payload.nodes.push(proposal('first')); refresh(x);
  const p=plan(x); assert.equal(p.newNodes.length,0); assert.equal(p.sourceIndex.find(n=>n.sourceNodeKey==='first').nodeId,nodeId('first'));
});
test('omitted archives keep their identity/baseline without appearing in the live snapshot', () => {
  const x=fixture(); archive(x,'first'); x.payload.nodes=x.payload.nodes.filter(n=>n.sourceNodeKey!=='first');
  const p=plan(x); assert.equal(p.sourceIndex.find(n=>n.sourceNodeKey==='first').archived,true);
  assert.equal(p.sourceIndex.find(n=>n.sourceNodeKey==='first').lastMachine.node.title,'Machine first');
  assert.ok(!p.snapshot.nodes.some(n=>n.id===nodeId('first'))); assert.deepEqual(p.archivedNodeIds,[nodeId('first')]);
});
test('a proposed archived key refuses instead of resurrecting or silently omitting it', () => {
  const x=fixture(); archive(x,'first'); refuses(()=>plan(x),'ARCHIVED_NODE_PROPOSED');
});
test('new deterministic ID collision with an unassociated human node refuses', () => {
  const x=fixture(); x.current.nodes.push({...snapshotNode('new_step'),meriAuthored:false}); x.payload.nodes.push(proposal('new_step')); refresh(x);
  refuses(()=>plan(x),'IDENTITY_COLLISION');
});
test('complete merged graph rejects missing references in untouched manual work', () => {
  const x=fixture(); x.current.nodes.push({...snapshotNode('manual'),id:id(100),dependsOnIds:[id(999)],meriAuthored:false}); refresh(x);
  refuses(()=>plan(x),'MISSING_DEPENDENCY');
});
test('complete merged graph rejects cycles wholly among untouched manual work', () => {
  const x=fixture(); x.current.nodes.push({...snapshotNode('manual'),id:id(100),dependsOnIds:[id(101)],meriAuthored:false},
    {...snapshotNode('manual_two'),id:id(101),dependsOnIds:[id(100)],meriAuthored:false}); refresh(x);
  refuses(()=>plan(x),'CYCLIC_DEPENDENCY');
});
test('human/source mixed cycle refuses before returning any mutation plan', () => {
  const x=fixture(); x.current.nodes[1].dependsOnIds=[nodeId('first')]; x.payload.nodes[0].dependsOn=['second']; refresh(x);
  refuses(()=>plan(x),'CYCLIC_DEPENDENCY');
});
test('human-preserved dependency field cannot silently discard a proposed edge', () => {
  const x=fixture(); x.current.nodes.push({...snapshotNode('manual'),id:id(100),meriAuthored:false});
  x.current.nodes[0].dependsOnIds=[id(100)]; x.payload.nodes[0].dependsOn=['second']; refresh(x);
  refuses(()=>plan(x),'PROPOSED_DEPENDENCY_UNAPPLIED');
});
test('human dependencies containing all proposed edges remain preserved with the old machine baseline', () => {
  const x=fixture(); x.current.nodes[0].dependsOnIds=[nodeId('second')]; x.payload.nodes[0].dependsOn=['second']; refresh(x);
  const p=plan(x); assert.deepEqual(observed(p).dependsOnIds,[nodeId('second')]); assert.deepEqual(baseline(p).dependsOnIds,[]);
});
test('a stale current snapshot refuses even when its node IDs still match', () => {
  const x=fixture(), i=input(x); i.current=clone(i.current); i.current.nodes[0].note='Changed after basis';
  refuses(()=>merge.planCanonicalStrategyRegeneration(i),'BASIS_MISMATCH');
});
for(const [name,mutate] of [
  ['old normalization v1',i=>{i.normalized=clone(i.normalized);i.normalized.normalizationWitness.schemaVersion=1;}],
  ['wrong immutable basis hash',i=>{i.normalized=clone(i.normalized);i.normalized.normalizationWitness.basisSha256='f'.repeat(64);}],
  ['wrong source-key hash',i=>{i.normalized=clone(i.normalized);i.normalized.normalizationWitness.sourceKeysSha256='f'.repeat(64);}],
  ['wrong head pin',i=>{i.normalized=clone(i.normalized);i.normalized.normalizationWitness.expectedStrategyVersionId=id(999);}],
]) test(`refuses ${name}`,()=>{
  const i=input(fixture());mutate(i);refuses(()=>merge.planCanonicalStrategyRegeneration(i),'BASIS_MISMATCH');
});
test('recomputed hashes do not authorize swapped model-selected node identities', () => {
  const i=input(fixture());i.normalized=clone(i.normalized);i.normalized.nodeIds.reverse();retouchNormalized(i.normalized);
  refuses(()=>merge.planCanonicalStrategyRegeneration(i),'INPUT_INVALID');
});
test('coerced kind/status fields refuse after digest recomputation', () => {
  for(const field of ['kind','subject','status']){
    const i=input(fixture());i.normalized=clone(i.normalized);i.normalized.response.nodes[0][field]=[i.normalized.response.nodes[0][field]];
    retouchNormalized(i.normalized);refuses(()=>merge.planCanonicalStrategyRegeneration(i),'INPUT_INVALID');
  }
});
test('full merged graph is not truncated to the candidate draft-node bound', () => {
  const x=fixture();for(let n=100;n<175;n++)x.current.nodes.push({...snapshotNode('manual'),id:id(n),meriAuthored:false});refresh(x);
  const p=plan(x);assert.equal(p.snapshot.nodes.length,77);assert.equal(p.retainedNodeIds.length,75);
});
test('pure planner does not mutate its input and returns no execution claim', () => {
  const i=input(fixture()), before=hash(i), p=merge.planCanonicalStrategyRegeneration(i);
  assert.equal(hash(i),before);assert.equal(p.phase,'planned');assert.ok(!Object.hasOwn(p,'strategyVersionId'));
  assert.ok(!Object.hasOwn(p,'receiptId'));assert.ok(custody.some(x=>x.path.endsWith('objective-canonical-regeneration.ts')));
});
