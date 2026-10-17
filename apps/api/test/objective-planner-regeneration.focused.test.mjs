// Structural internal witness checks only. Native original consent/application
// lineage and exclusive owner absence are separately qualified by Core tests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const url = new URL('../src/clients/objectives/work/objective-planner-regeneration.ts', import.meta.url);
const source = stripTypeScriptTypes(await readFile(url, 'utf8'), { mode: 'strip', sourceUrl: url.href });
const { objectivePlannerAdvancedSource, verifiedObjectivePlannerRegenerationWitness: verified } =
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
function fixture() {
  const original = { canonicalPlanId: id(1), canonicalEpoch: 1, canonicalStrategyId: id(2), canonicalProjectId: id(3),
    canonicalBindingVersion: 1, rootIntentId: id(4), sourceRevisionId: id(5), sourceObjectiveVersion: 1,
    sourceSnapshotHash: 'a'.repeat(64), rootActorUserId: id(6) };
  const current = { ...original, canonicalBindingVersion: 2, rootIntentId: id(7), sourceRevisionId: id(8),
    sourceObjectiveVersion: 2, sourceSnapshotHash: 'b'.repeat(64), rootActorUserId: id(9) };
  const a = { objectiveStatus: 'ready', objectiveVersion: 2, objectiveRevisionId: id(8) };
  const state = { source: current, consent: { id: id(10), source: original }, control: { currentConsentId: id(10) } };
  return { a, state, witness: { state: 'not_started', source: structuredClone(current) } };
}
test('exact advanced current source is independently identified without changing original source', () => {
  const f = fixture(), before = structuredClone(f.state.consent.source);
  assert.equal(verified(f.witness, f.a, f.state), true);
  const source = objectivePlannerAdvancedSource(f.a, f.state); assert.deepEqual(source, f.state.source);
  source.sourceObjectiveVersion++;
  assert.equal(f.state.source.sourceObjectiveVersion, 2); assert.deepEqual(f.state.consent.source, before);
});
test('same binding and absent prior consent have no regeneration witness', () => {
  const f = fixture(); f.state.source = structuredClone(f.state.consent.source);
  assert.equal(objectivePlannerAdvancedSource(f.a, f.state), null); assert.equal(verified(f.witness, f.a, f.state), false);
  f.state.consent = null; assert.equal(objectivePlannerAdvancedSource(f.a, f.state), null);
});
for (const [name, mutate] of [
  ['extra witness field', f => { f.witness.permission = true; }],
  ['extra source field', f => { f.witness.source.permission = true; }],
  ['caller-selected source', f => { f.witness.source.rootIntentId = id(50); }],
  ['not ready', f => { f.a.objectiveStatus = 'draft'; }],
  ['wrong current revision', f => { f.a.objectiveRevisionId = id(51); }],
  ['wrong current version', f => { f.a.objectiveVersion = 1; }],
  ['different canonical identity', f => { f.state.source.canonicalProjectId = id(52); f.witness.source.canonicalProjectId = id(52); }],
  ['same root', f => { f.state.source.rootIntentId = f.state.consent.source.rootIntentId; f.witness.source.rootIntentId = f.state.source.rootIntentId; }],
  ['same revision', f => { f.state.source.sourceRevisionId = f.state.consent.source.sourceRevisionId; f.a.objectiveRevisionId = f.state.source.sourceRevisionId; f.witness.source.sourceRevisionId = f.state.source.sourceRevisionId; }],
  ['same binding', f => { f.state.source.canonicalBindingVersion = 1; f.witness.source.canonicalBindingVersion = 1; }],
  ['same Objective version', f => { f.state.source.sourceObjectiveVersion = 1; f.a.objectiveVersion = 1; f.witness.source.sourceObjectiveVersion = 1; }],
  ['same snapshot hash', f => { f.state.source.sourceSnapshotHash = f.state.consent.source.sourceSnapshotHash; f.witness.source.sourceSnapshotHash = f.state.source.sourceSnapshotHash; }],
  ['different current consent', f => { f.state.control.currentConsentId = id(53); }],
  ['malformed source', f => { f.witness.source.canonicalEpoch = '1'; }],
]) test(`internal witness refuses ${name}`, () => {
  const f = fixture(); mutate(f); assert.equal(verified(f.witness, f.a, f.state), false);
});
test('witness/source getters and proxies are rejected before evaluation', () => {
  for (const kind of ['getter', 'proxy']) {
    const f = fixture(); let read = false;
    if (kind === 'getter') Object.defineProperty(f.witness, 'source', { enumerable: true, get() { read = true; throw Error(); } });
    else f.witness = new Proxy(f.witness, { ownKeys() { read = true; throw Error(); } });
    assert.equal(verified(f.witness, f.a, f.state), false); assert.equal(read, false);
  }
});
