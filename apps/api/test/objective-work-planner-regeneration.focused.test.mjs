import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeWorkCommand, readWorkGeneration, ACTION, PLAN, NOW_MS, iso, id, I, clone, request, readRequest,
  fails, MemoryOwner, seedConsent, accounted, writes,
} from './objective-work-command.fixtures.mjs';

// Actual source-kernel regressions using the existing synthetic command fixture.
// MemoryOwner provides synthetic reconciliation/current-authority/policy ports,
// serialized writes and rollback. No native SQL, provider, dispatch or RLS is qualified.
function advancedApplied(action = PLAN) {
  const owner = new MemoryOwner(), originalConsent = seedConsent(owner, { action });
  const current = owner.data.states[action].source;
  Object.assign(current, { canonicalBindingVersion: current.canonicalBindingVersion + 1,
    rootIntentId: id(300), sourceRevisionId: id(301), sourceObjectiveVersion: current.sourceObjectiveVersion + 1,
    sourceSnapshotHash: 'd'.repeat(64) });
  Object.assign(owner.data.authority, { objectiveVersion: current.sourceObjectiveVersion,
    objectiveRevisionId: current.sourceRevisionId });
  const evidence = { ...accounted('applied'), regeneration: { state: 'not_started', source: clone(current) } };
  owner.data.reconciliation[action] = evidence;
  owner.data.policy.originalTokenExpiresAtMs = NOW_MS + 20000;
  const command = request({ workAction: action, expectedObjectiveVersion: current.sourceObjectiveVersion,
    expectedControlVersion: owner.data.states[action].control.version,
    expectedCanonicalBindingVersion: current.canonicalBindingVersion, targetAuthorizationRequestId: originalConsent.id });
  return { owner, command, originalConsent, originalEvidence: clone(evidence) };
}
function overrideWitness(owner, witness) {
  const transaction = owner.transaction.bind(owner);
  owner.transaction = (write, run) => transaction(write, tx => run({ ...tx,
    reconcile: async (...args) => ({ ...await tx.reconcile(...args), regeneration: witness }) }));
}

test('advanced Planner retry: only current advanced Planner witness allows a new explicit consent while original applied accounting remains immutable', async () => {
  const { owner, command, originalConsent, originalEvidence } = advancedApplied();
  const before = clone(owner.data.states[PLAN].source);
  const status = await readWorkGeneration(readRequest({ workAction: PLAN }), owner);
  assert.equal(status.reconciliation, 'accounted');assert.equal(status.consent.id, originalConsent.id);
  assert.equal(Object.hasOwn(status, 'regeneration'), false, 'internal witness does not become public status');
  assert.deepEqual(owner.data.reconciliation[PLAN], originalEvidence);
  owner.events.length = 0;
  const result = await executeWorkCommand(command, owner);
  assert.equal(result.outcome, 'reconsent_recorded');assert.equal(result.controlVersionAfter, 4);
  const fresh = owner.data.consents[result.consent.id];
  assert.deepEqual(fresh.source, before);assert.equal(fresh.previousConsentId, originalConsent.id);
  assert.equal(fresh.actorUserId, I.actor);assert.equal(fresh.actorMembershipId, I.membership);
  assert.equal(fresh.expiresAt, iso(20000), 'new explicit consent uses current native proof cap');
  assert.deepEqual(owner.data.consents[originalConsent.id], originalConsent, 'original consent bytes/expiry stay pinned');
  assert.deepEqual(owner.data.reconciliation[PLAN], originalEvidence, 'original applied identity/outcome never relabeled');
  const methods = owner.events.filter(e => e.write).map(e => e.method);
  assert.ok(methods.indexOf('lockOwner') < methods.indexOf('authority'));
  assert.ok(methods.indexOf('reconcile') < methods.indexOf('policy'));
  assert.ok(methods.indexOf('policy') < methods.indexOf('clock'), 'existing DB-time-after-owner-waits ordering retained');
  assert.equal(writes(owner).length, 3);
});

test('advanced Planner retry: same-source applied remains denied even with a matching-looking not-started witness', async () => {
  const owner = new MemoryOwner(), consent = seedConsent(owner, { action: PLAN });
  owner.data.reconciliation[PLAN] = { ...accounted('applied'),
    regeneration: { state: 'not_started', source: clone(owner.data.states[PLAN].source) } };
  const command = request({ workAction: PLAN, expectedControlVersion: 3, targetAuthorizationRequestId: consent.id });
  const before = clone(owner.data);
  await fails(() => executeWorkCommand(command, owner), 'OUTCOME_UNCONFIRMED');
  assert.deepEqual(owner.data, before);assert.equal(writes(owner).length, 0);
  assert.equal(owner.events.some(e => ['policy', 'clock', 'newId'].includes(e.method)), false);
});

test('advanced Planner retry: advanced Strategy applied cannot use a Planner regeneration witness', async () => {
  const { owner, command } = advancedApplied(ACTION), before = clone(owner.data);
  await fails(() => executeWorkCommand(command, owner), 'OUTCOME_UNCONFIRMED');
  assert.deepEqual(owner.data, before);assert.equal(writes(owner).length, 0);
  assert.equal(owner.events.some(e => e.method === 'policy'), false);
});

for (const state of ['outcome_unconfirmed', 'unavailable', 'pending', 'queued', 'leased'])
  test(`advanced Planner retry: ${state} never becomes retry authority because of an advanced-source witness`, async () => {
    const { owner, command } = advancedApplied();owner.data.reconciliation[PLAN].state = state;
    const before = clone(owner.data);
    await fails(() => executeWorkCommand(command, owner), state === 'unavailable' ? 'AUTHORITY_UNAVAILABLE' : 'OUTCOME_UNCONFIRMED');
    assert.deepEqual(owner.data, before);assert.equal(writes(owner).length, 0);
    assert.equal(owner.events.some(e => ['policy', 'clock', 'newId'].includes(e.method)), false);
  });

const malformedWitnesses = [
  ['missing', () => undefined], ['null', () => null], ['array', () => []],
  ['unknown state', f => ({ ...clone(f.originalEvidence.regeneration), state: 'pending' })],
  ['extra witness field', f => ({ ...clone(f.originalEvidence.regeneration), receiptId: id(99) })],
  ['missing source field', f => { const w = clone(f.originalEvidence.regeneration);delete w.source.rootActorUserId;return w; }],
  ['extra source field', f => { const w = clone(f.originalEvidence.regeneration);w.source.owner = I.actor;return w; }],
  ['old source', f => ({ state: 'not_started', source: clone(f.originalConsent.source) })],
  ['wrong source binding', f => { const w = clone(f.originalEvidence.regeneration);w.source.canonicalBindingVersion++;return w; }],
  ['wrong root', f => { const w = clone(f.originalEvidence.regeneration);w.source.rootIntentId = id(333);return w; }],
  ['wrong snapshot', f => { const w = clone(f.originalEvidence.regeneration);w.source.sourceSnapshotHash = 'e'.repeat(64);return w; }],
  ['non-exact hash', f => { const w = clone(f.originalEvidence.regeneration);w.source.sourceSnapshotHash += '\n';return w; }],
];
for (const [label, build] of malformedWitnesses) test(`advanced Planner retry: malformed ${label} witness refuses without policy, identities or writes`, async () => {
  const f = advancedApplied(), before = clone(f.owner.data);overrideWitness(f.owner, build(f));
  await fails(() => executeWorkCommand(f.command, f.owner), 'OUTCOME_UNCONFIRMED');
  assert.deepEqual(f.owner.data, before);assert.equal(writes(f.owner).length, 0);
  assert.equal(f.owner.events.some(e => ['policy', 'clock', 'newId'].includes(e.method)), false);
});

test('advanced Planner retry: nested witness accessors and proxies are rejected before any getter/trap invocation', async () => {
  for (const where of ['witness getter', 'source getter', 'witness proxy', 'source proxy']) {
    const f = advancedApplied();let invoked = 0;const witness = clone(f.originalEvidence.regeneration);
    let raw = witness;
    if (where === 'witness getter') Object.defineProperty(witness, 'source', { enumerable: true,
      get() { invoked++;throw Error('must not run'); } });
    if (where === 'source getter') Object.defineProperty(witness.source, 'rootIntentId', { enumerable: true,
      get() { invoked++;throw Error('must not run'); } });
    const traps = { ownKeys() { invoked++;throw Error('must not run'); },
      getPrototypeOf() { invoked++;throw Error('must not run'); } };
    if (where === 'witness proxy') raw = new Proxy(witness, traps);
    if (where === 'source proxy') witness.source = new Proxy(witness.source, traps);
    overrideWitness(f.owner, raw);
    await fails(() => executeWorkCommand(f.command, f.owner), 'OUTCOME_UNCONFIRMED');
    assert.equal(invoked, 0, where);assert.equal(writes(f.owner).length, 0);
  }
});

test('advanced Planner retry: current authority is checked on miss and again under writer admission before advanced retry', async () => {
  const f = advancedApplied(), before = clone(f.owner.data);f.owner.beforeWrite = owner => { owner.denied = true; };
  await fails(() => executeWorkCommand(f.command, f.owner), 'NOT_AVAILABLE');
  assert.deepEqual(f.owner.data, before);assert.equal(writes(f.owner).length, 0);
  assert.equal(f.owner.events.filter(e => e.method === 'authority').length, 2);
  assert.equal(f.owner.events.some(e => e.method === 'reconcile'), false);
});

test('advanced Planner retry: current source/Objective mismatch denies before reconciliation or new consent', async () => {
  const f = advancedApplied();f.owner.data.authority.objectiveRevisionId = id(555);const before = clone(f.owner.data);
  await fails(() => executeWorkCommand(f.command, f.owner), 'OBJECTIVE_VERSION_CONFLICT');
  assert.deepEqual(f.owner.data, before);assert.equal(writes(f.owner).length, 0);
  assert.equal(f.owner.events.some(e => e.method === 'reconcile'), false);
});

test('advanced Planner retry: exact advanced retry replay remains historical, idempotent and current-authority gated', async () => {
  const f = advancedApplied(), originalConsent = clone(f.originalConsent);
  const first = await executeWorkCommand(f.command, f.owner), committed = clone(f.owner.data);
  Object.assign(f.owner.data.authority, { objectiveVersion: 99, objectiveRevisionId: id(999), objectiveStatus: 'draft' });
  f.owner.data.reconciliation[PLAN] = { state: 'unavailable' };f.owner.data.now = iso(7200000);f.owner.events.length = 0;
  assert.deepEqual(await executeWorkCommand(f.command, f.owner), first);
  assert.deepEqual(f.owner.data.consents, committed.consents);assert.equal(writes(f.owner).length, 0);
  assert.equal(f.owner.events.some(e => ['state', 'reconcile', 'policy', 'clock', 'newId'].includes(e.method)), false);
  await fails(() => executeWorkCommand({ ...f.command, command: { ...f.command.command, expectedControlVersion: 99 } }, f.owner),
    'REQUEST_ID_CONFLICT');
  f.owner.denied = true;f.owner.events.length = 0;
  await fails(() => executeWorkCommand(f.command, f.owner), 'NOT_AVAILABLE');
  assert.equal(f.owner.events.some(e => e.method === 'receipt'), false);
  assert.deepEqual(f.owner.data.consents[originalConsent.id], originalConsent);
});

test('advanced Planner retry: simultaneous exact advanced retries commit one new consent and receipt', async () => {
  const f = advancedApplied(), results = await Promise.all([executeWorkCommand(f.command, f.owner), executeWorkCommand(f.command, f.owner)]);
  assert.deepEqual(results[0], results[1]);assert.equal(Object.keys(f.owner.data.consents).length, 2);
  assert.equal(Object.keys(f.owner.data.receipts).length, 1);assert.equal(writes(f.owner).length, 3);
  assert.deepEqual(f.owner.data.reconciliation[PLAN], f.originalEvidence);
});

test('advanced Planner retry: expiry sampled after policy wait still rolls back all new advanced consent/receipt writes', async () => {
  const f = advancedApplied();f.owner.data.clocks = [iso(19000), iso(20000)];const before = clone(f.owner.data);
  await fails(() => executeWorkCommand(f.command, f.owner), 'AUTHORITY_UNAVAILABLE');
  assert.deepEqual(f.owner.data, before);assert.equal(f.owner.events.at(-1).method, 'rollback');
  assert.deepEqual(f.owner.data.reconciliation[PLAN], f.originalEvidence);
});
