// Pure receiving-kernel cases only. Native Node type stripping erases the
// kernel's owner type import; this suite imports no Nest/Prisma/app runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CanonicalApplicationError,
  applicationHash,
  applicationJson,
  applicationUuid,
  applicationReceiptId,
  applicationHeadId,
  canonicalApplicationRequestId,
  parseCanonicalApplication,
  creationAck,
  checkStoredApplication,
  applicationObservation,
  executeCanonicalApplicationTransaction,
} from '../src/planner/objective-canonical-application.ts';

const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const sha = (char) => char.repeat(64);
const clone = (value) => structuredClone(value);
const at = '2026-10-16T04:00:00.000Z';
const reject = (run, code) => assert.throws(run,
  (error) => error instanceof CanonicalApplicationError && error.code === code);

function fixture() {
  const canonical = {
    canonicalPlanId: uuid(1), tenantId: uuid(2), clientId: uuid(3), objectiveId: uuid(4),
    canonicalStrategyId: uuid(5), canonicalProjectId: uuid(6), bindingVersion: 2, epoch: 1,
    requestedIntentId: uuid(7), requestedObjectiveRevisionId: uuid(8),
    requestedObjectiveVersion: 4, snapshotHash: sha('a'),
  };
  const actor = uuid(9);
  const request = {
    schemaVersion: 1, canonical,
    applicationRequestId: canonicalApplicationRequestId(canonical, actor),
    generationJobId: uuid(10), generationRequestId: uuid(11), strategyId: uuid(5),
    strategyVersionId: uuid(12), objectiveReceiptSha256: sha('b'), snapshotDigest: sha('c'),
  };
  const grant = {
    tenantId: canonical.tenantId, actorUserId: actor, clerkUserId: 'user_fixture',
    consentId: uuid(13), controlVersion: 3, tokenExpiresAtMs: 1792130400000,
    delegationExpiresAtMs: 1792130400000, claimExpiresAtMs: 1792130400000,
    requestSha256: applicationHash(request), canonicalSha256: applicationHash(canonical),
  };
  const source = {
    generationJobId: request.generationJobId, generationRequestId: request.generationRequestId,
    clientId: canonical.clientId, objectiveId: canonical.objectiveId,
    objectiveVersion: canonical.requestedObjectiveVersion,
    objectiveRevisionId: canonical.requestedObjectiveRevisionId,
    strategyId: request.strategyId, strategyVersionId: request.strategyVersionId,
    snapshotDigest: request.snapshotDigest,
  };
  const nodeIds = [uuid(20), uuid(21)];
  const available = (id) => ({ availability: 'available', id, createdVersion: 1, currentVersion: 1 });
  const result = {
    requestId: request.applicationRequestId, status: 'prepared', replayed: false,
    recordedAt: at, observedAt: at, source,
    projects: [{ groupKey: 'default', name: 'Saved plan', originalNodeIds: nodeIds,
      output: available(canonical.canonicalProjectId) }],
    tasks: nodeIds.map((sourceNodeId, i) => ({ sourceNodeId, originalGroupKeys: ['default'],
      currentGroupKeys: ['default'], output: available(uuid(30 + i)) })),
    context: [], edges: [], exclusions: [], issues: [],
    counts: { savedNodes: 2, actionableNodes: 2, contextNodes: 0, archivedNodes: 0,
      createdProjects: 1, createdTasks: 2 },
  };
  // The service obtains this shape from the owner's separately checked creation
  // lookup. These pure cases test the receiving projection, not that owner port.
  const owner = {
    receiptVersion: 2,
    input: { requestId: request.applicationRequestId, generationJobId: request.generationJobId,
      expected: { strategyId: request.strategyId, strategyVersionId: request.strategyVersionId,
        objectiveRevisionId: canonical.requestedObjectiveRevisionId } },
    binding: { canonical, generationRequestId: request.generationRequestId,
      objectiveReceiptSha256: request.objectiveReceiptSha256, snapshotDigest: request.snapshotDigest },
    fingerprint: sha('d'), snapshot: { meta: { id: request.strategyId }, nodes: [] },
    archivedSourceNodeIds: [], result,
  };
  const ownerReceiptId = uuid(40);
  const ack = creationAck(request, grant, owner, ownerReceiptId, at);
  const stored = { receiptVersion: 1, request, ack, ackSha256: applicationHash(ack) };
  return { request, grant, owner, ownerReceiptId, ack, stored };
}

test('closed request retains exactly the nine declared fields', () => {
  const { request } = fixture();
  assert.deepEqual(parseCanonicalApplication(request), request);
  assert.equal(Object.keys(parseCanonicalApplication(request)).length, 9);
});

test('unknown owner receipt versions cannot bypass creation or reconstruction guards', () => {
  const { request, grant, owner, ownerReceiptId, stored } = fixture();
  owner.receiptVersion = 4;
  owner.result.projects[0].output.currentVersion = 7;
  owner.result.counts.createdProjects = 0;
  reject(() => creationAck(request, grant, owner, ownerReceiptId, at), 'OUTCOME_UNCONFIRMED');
  reject(() => checkStoredApplication(stored, owner, ownerReceiptId), 'OUTCOME_UNCONFIRMED');
});

for (const field of ['schemaVersion', 'canonical', 'applicationRequestId', 'generationJobId',
  'generationRequestId', 'strategyId', 'strategyVersionId', 'objectiveReceiptSha256', 'snapshotDigest']) {
  test(`request rejects missing ${field}`, () => {
    const request = fixture().request;
    delete request[field];
    reject(() => parseCanonicalApplication(request), 'INPUT_INVALID');
  });
}
for (const field of ['actorUserId', 'clerkUserId', 'groups', 'model', 'resultRef', 'operation']) {
  test(`request rejects caller-owned ${field}`, () => {
    const request = { ...fixture().request, [field]: 'untrusted' };
    reject(() => parseCanonicalApplication(request), 'INPUT_INVALID');
  });
}
test('canonical token is closed and epoch replacement remains unavailable', () => {
  const request = fixture().request;
  request.canonical.epoch = 2;
  reject(() => parseCanonicalApplication(request), 'INPUT_INVALID');
  request.canonical.epoch = 1;
  request.canonical.applied = true;
  reject(() => parseCanonicalApplication(request), 'INPUT_INVALID');
});
test('positive integer bounds and exact hashes are enforced', () => {
  for (const key of ['bindingVersion', 'requestedObjectiveVersion']) {
    for (const value of [0, -1, 1.5, 2147483648, '2']) {
      const request = fixture().request;
      request.canonical[key] = value;
      reject(() => parseCanonicalApplication(request), 'INPUT_INVALID');
    }
  }
  for (const value of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), null]) {
    const request = fixture().request;
    request.objectiveReceiptSha256 = value;
    reject(() => parseCanonicalApplication(request), 'INPUT_INVALID');
  }
});
test('UUID syntax is exact and selected Strategy must be the reservation', () => {
  reject(() => applicationUuid(uuid(10).toUpperCase()), 'INPUT_INVALID');
  reject(() => applicationUuid(`${uuid(10)}\n`), 'INPUT_INVALID');
  reject(() => applicationUuid('not-a-uuid'), 'INPUT_INVALID');
  const request = fixture().request;
  request.strategyId = uuid(99);
  reject(() => parseCanonicalApplication(request), 'INPUT_INVALID');
});
test('every UUID and hash position refuses a final newline', () => {
  for (const field of ['applicationRequestId', 'generationJobId', 'generationRequestId',
    'strategyId', 'strategyVersionId', 'objectiveReceiptSha256', 'snapshotDigest']) {
    const request = fixture().request;
    request[field] += '\n';
    reject(() => parseCanonicalApplication(request), 'INPUT_INVALID');
  }
  for (const field of ['canonicalPlanId', 'tenantId', 'clientId', 'objectiveId',
    'canonicalStrategyId', 'canonicalProjectId', 'requestedIntentId',
    'requestedObjectiveRevisionId', 'snapshotHash']) {
    const request = fixture().request;
    request.canonical[field] += '\n';
    reject(() => parseCanonicalApplication(request), 'INPUT_INVALID');
  }
});
test('request accessors never execute, including nested canonical accessors', () => {
  for (const nested of [false, true]) {
    const request = fixture().request;
    let reads = 0;
    Object.defineProperty(nested ? request.canonical : request,
      nested ? 'snapshotHash' : 'snapshotDigest', {
        enumerable: true, get() { reads++; throw new Error('getter executed'); },
      });
    reject(() => parseCanonicalApplication(request), 'INPUT_INVALID');
    assert.equal(reads, 0);
  }
});
test('request rejects proxy, symbols and hidden data fields', () => {
  reject(() => parseCanonicalApplication(new Proxy(fixture().request, {})), 'INPUT_INVALID');
  const withSymbol = fixture().request;
  withSymbol[Symbol('extra')] = true;
  reject(() => parseCanonicalApplication(withSymbol), 'INPUT_INVALID');
  const hidden = fixture().request;
  Object.defineProperty(hidden, 'snapshotDigest', { value: sha('c'), enumerable: false });
  reject(() => parseCanonicalApplication(hidden), 'INPUT_INVALID');
});
test('null-prototype JSON data records are accepted', () => {
  const request = fixture().request;
  const canonical = Object.assign(Object.create(null), request.canonical);
  assert.deepEqual(parseCanonicalApplication(Object.assign(Object.create(null), request, { canonical })), request);
});
test('digest sorts object keys and retains array order', () => {
  assert.equal(applicationJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(applicationHash({ b: 2, a: 1 }), applicationHash({ a: 1, b: 2 }));
  assert.notEqual(applicationHash([1, 2]), applicationHash([2, 1]));
  for (const value of [undefined, NaN, Infinity, new Date(), [1, , 3]]) {
    reject(() => applicationHash(value), 'INPUT_INVALID');
  }
});
test('effect identity is deterministic, actor isolated and binds the full original token', () => {
  const { request, grant } = fixture();
  assert.equal(canonicalApplicationRequestId(clone(request.canonical), grant.actorUserId), request.applicationRequestId);
  assert.notEqual(canonicalApplicationRequestId(request.canonical, uuid(99)), request.applicationRequestId);
  for (const field of ['canonicalPlanId', 'requestedIntentId', 'requestedObjectiveRevisionId',
    'canonicalProjectId', 'canonicalStrategyId', 'clientId', 'objectiveId', 'tenantId']) {
    const c = { ...request.canonical, [field]: uuid(99) };
    assert.notEqual(canonicalApplicationRequestId(c, grant.actorUserId), request.applicationRequestId);
  }
  assert.notEqual(canonicalApplicationRequestId({ ...request.canonical, bindingVersion: 3 }, grant.actorUserId), request.applicationRequestId);
  assert.notEqual(canonicalApplicationRequestId({ ...request.canonical, snapshotHash: sha('f') }, grant.actorUserId), request.applicationRequestId);
});
test('private ledger IDs isolate actor/request and head tracks the stable canonical plan', () => {
  const { request, grant } = fixture();
  const id = applicationReceiptId(grant.tenantId, grant.clerkUserId, request.applicationRequestId);
  assert.equal(applicationUuid(id), id);
  assert.notEqual(id, applicationReceiptId(grant.tenantId, 'user_other', request.applicationRequestId));
  assert.notEqual(id, applicationReceiptId(uuid(99), grant.clerkUserId, request.applicationRequestId));
  assert.notEqual(id, applicationHeadId(request.canonical));
  assert.equal(applicationHeadId(request.canonical), applicationHeadId({ ...request.canonical, bindingVersion: 3 }));
});
test('ACK binds fixed operation, actual reserved row, native actor and owner content', () => {
  const { request, grant, owner, ownerReceiptId, ack } = fixture();
  assert.equal(ack.operation, 'objective.plan.prepare');
  assert.equal(ack.actorUserId, grant.actorUserId);
  assert.deepEqual(ack.canonical, request.canonical);
  assert.equal(ack.ownerReceiptId, ownerReceiptId);
  assert.equal(ack.ownerReceiptSha256, applicationHash(owner));
  assert.equal(ack.projects[0].projectId, request.canonical.canonicalProjectId);
  assert.deepEqual(ack.tasks.map(t => t.taskId), owner.result.tasks.map(t => t.output.id));
  assert.equal(ack.outcome, 'applied');
  assert.ok(!Object.hasOwn(ack, 'model'));
});
test('ACK represents bounded owner issues without promoting partial creation', () => {
  const f = fixture();
  f.owner.result.issues = [{ code: 'CONTEXT_ONLY_DEPENDENCY', sourceNodeIds: [uuid(20)], message: 'context' }];
  assert.equal(creationAck(f.request, f.grant, f.owner, f.ownerReceiptId, at).outcome, 'applied_with_issues');
  f.owner.result.status = 'partial';
  reject(() => creationAck(f.request, f.grant, f.owner, f.ownerReceiptId, at), 'OUTCOME_UNCONFIRMED');
});
for (const field of ['generationJobId', 'generationRequestId', 'strategyId', 'strategyVersionId',
  'clientId', 'objectiveId', 'objectiveRevisionId']) {
  test(`ACK refuses mismatched owner ${field}`, () => {
    const f = fixture();
    f.owner.result.source[field] = uuid(99);
    reject(() => creationAck(f.request, f.grant, f.owner, f.ownerReceiptId, at), 'OUTCOME_UNCONFIRMED');
  });
}
test('ACK refuses mismatched hashes, original actor, replay and output versions', () => {
  const mutations = [
    f => { f.grant.requestSha256 = sha('f'); },
    f => { f.grant.canonicalSha256 = sha('f'); },
    f => { f.grant.actorUserId = uuid(99); },
    f => { f.owner.result.source.snapshotDigest = sha('f'); },
    f => { f.owner.binding.objectiveReceiptSha256 = sha('f'); },
    f => { f.owner.binding = clone(f.owner.binding); f.owner.binding.canonical.bindingVersion++; },
    f => { f.owner.result.replayed = true; },
    f => { f.owner.result.projects[0].output.id = uuid(99); },
    f => { f.owner.result.projects[0].groupKey = 'manual-first'; },
    f => { f.owner.result.tasks[0].output.currentVersion = 2; },
    f => { f.owner.result.tasks[0].output.createdVersion = 2; },
    f => { f.owner.result.tasks[0].output.availability = 'unavailable'; },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    reject(() => creationAck(f.request, f.grant, f.owner, f.ownerReceiptId, at), 'OUTCOME_UNCONFIRMED');
  }
});
test('stored ACK is rebuilt, not accepted from its self-reported digest', () => {
  const f = fixture();
  assert.deepEqual(checkStoredApplication(f.stored, f.owner, f.ownerReceiptId), f.stored);
  for (const mutate of [
    s => { s.ack.operation = 'objective.strategy.draft'; },
    s => { s.ack.outcome = 'applied_with_issues'; },
    s => { s.ack.requestSha256 = sha('f'); },
    s => { s.ack.ownerReceiptSha256 = sha('f'); },
    s => { s.ack.projects[0].projectId = uuid(99); },
    s => { s.ack.tasks[0].taskId = uuid(99); },
    s => { s.ack.source.strategyVersionId = uuid(99); },
    s => { s.ack.extra = true; },
  ]) {
    const stored = clone(f.stored);
    mutate(stored);
    stored.ackSha256 = applicationHash(stored.ack);
    reject(() => checkStoredApplication(stored, f.owner, f.ownerReceiptId), 'OUTCOME_UNCONFIRMED');
  }
});
test('stored receipt and request extra fields or bad digest are refused', () => {
  const f = fixture();
  for (const mutate of [
    s => { s.extra = true; }, s => { s.receiptVersion = 2; },
    s => { s.ackSha256 = sha('f'); }, s => { s.request.groups = []; },
  ]) {
    const stored = clone(f.stored);
    mutate(stored);
    reject(() => checkStoredApplication(stored, f.owner, f.ownerReceiptId), 'OUTCOME_UNCONFIRMED');
  }
});
test('human edits are current observations and preserve original ACK bytes', () => {
  const f = fixture();
  const current = clone(f.owner.result);
  current.replayed = true;
  current.observedAt = '2026-10-16T05:00:00.000Z';
  current.projects[0].name = 'Human renamed';
  current.projects[0].output.currentVersion = 4;
  current.tasks[0].output.currentVersion = 7;
  current.tasks[0].currentGroupKeys = [];
  const result = applicationObservation(f.stored, current);
  assert.equal(result.creation.availability, 'available');
  assert.deepEqual(result.creation.ack, f.ack);
  assert.equal(result.creation.sha256, f.stored.ackSha256);
  assert.equal(result.current.tasks[0].output.currentVersion, 7);
  assert.equal(result.creation.ack.tasks[0].createdVersion, 1);
});
test('permission loss withholds the complete creation ACK and its digest', () => {
  const f = fixture();
  const current = clone(f.owner.result);
  current.status = 'partial';
  current.tasks[1].output = { availability: 'unavailable', id: null, createdVersion: 1, currentVersion: null };
  const result = applicationObservation(f.stored, current);
  assert.deepEqual(result.creation, { availability: 'unavailable', ack: null, sha256: null });
  assert.equal(result.current.tasks[1].output.id, null);
  assert.equal(f.stored.ack.tasks[1].taskId, uuid(31));
});
test('readable archived output preserves creation history without claiming current availability', () => {
  const f = fixture();
  const current = clone(f.owner.result);
  current.status = 'partial';
  current.projects[0].output.availability = 'archived';
  const result = applicationObservation(f.stored, current);
  assert.equal(result.creation.availability, 'available');
  assert.equal(result.current.projects[0].output.availability, 'archived');
});
test('observation cannot rebind source or application request identity', () => {
  const f = fixture();
  const current = clone(f.owner.result);
  current.source.objectiveVersion++;
  reject(() => applicationObservation(f.stored, current), 'OUTCOME_UNCONFIRMED');
  current.source = clone(f.owner.result.source);
  current.requestId = uuid(99);
  reject(() => applicationObservation(f.stored, current), 'OUTCOME_UNCONFIRMED');
});
test('current projection cannot drop or substitute original outputs', () => {
  const f = fixture();
  for (const mutate of [
    c => { c.tasks.pop(); },
    c => { c.projects = []; },
    c => { c.tasks[0].output.id = uuid(99); },
    c => { c.tasks[0].sourceNodeId = uuid(99); },
    c => { c.projects[0].groupKey = 'replacement'; },
    c => { c.tasks[0].output.createdVersion = 2; },
  ]) {
    const current = clone(f.owner.result);
    mutate(current);
    reject(() => applicationObservation(f.stored, current), 'OUTCOME_UNCONFIRMED');
  }
});

// The following exercises the actual exported choreography with a deliberately
// small in-memory owner transaction. It proves call order/error propagation and
// the synthetic adapter's rollback only, not PostgreSQL locks/isolation/rollback.
function syntheticTransaction(options = {}) {
  const f = fixture();
  const calls = [];
  let state = { projects: [], tasks: [], ownerReceipt: options.ownerReplay ? clone(f.owner) : null,
    applicationReceipt: null, head: null };
  const initial = clone(state);
  let assertions = 0;
  let fences = 0;
  const failure = new CanonicalApplicationError('AUTHORITY_UNAVAILABLE');
  const ports = {
    lockPlanner: async () => { calls.push('lock'); },
    previous: async () => { calls.push('previous'); return options.previous ?? null; },
    read: async previous => {
      calls.push('read');
      assert.equal(previous, options.previous);
      if (options.readConflict) throw new CanonicalApplicationError('REQUEST_CONFLICT');
      const current = clone(f.owner.result);
      current.replayed = true;
      current.projects[0].output.currentVersion = 9;
      return applicationObservation(f.stored, current);
    },
    assertEffect: async () => {
      calls.push(`assert:${++assertions}`);
      if (assertions === options.failAssertion) throw failure;
    },
    prepare: async beforeWrite => {
      calls.push('prepare');
      if (options.ownerReplay) return { stored: f.owner, replayed: true };
      await beforeWrite();
      calls.push('output-write');
      state.projects = clone(f.owner.result.projects);
      state.tasks = clone(f.owner.result.tasks);
      calls.push('owner-receipt-write');
      state.ownerReceipt = clone(f.owner);
      return { stored: f.owner, replayed: false };
    },
    fence: async () => {
      calls.push(`fence:${++fences}`);
      if (fences === options.failFence) throw failure;
    },
    clock: async () => { calls.push('clock'); return at; },
    ownerReceiptId: f.ownerReceiptId,
    insert: async stored => {
      calls.push('application-write');
      state.applicationReceipt = clone(stored);
      if (options.failInsert) throw failure;
    },
    advanceHead: async stored => {
      calls.push('head-write');
      state.head = { applicationRequestId: stored.request.applicationRequestId, sha256: stored.ackSha256 };
      if (options.failHead) throw failure;
    },
  };
  return {
    calls, initial, state: () => clone(state),
    run: async () => {
      try { return await executeCanonicalApplicationTransaction(f.request, f.grant, ports); }
      catch (error) { state = clone(initial); throw error; }
    },
  };
}
test('real choreography gates the owner and releases only after all paired writes', async () => {
  const tx = syntheticTransaction();
  const result = await tx.run();
  assert.deepEqual(tx.calls, ['lock', 'previous', 'assert:1', 'prepare', 'assert:2', 'fence:1',
    'output-write', 'owner-receipt-write', 'assert:3', 'fence:2', 'clock',
    'application-write', 'head-write', 'assert:4', 'fence:3']);
  assert.equal(result.creation.availability, 'available');
  assert.equal(tx.state().projects.length, 1);
  assert.equal(tx.state().tasks.length, 2);
  assert.ok(tx.state().ownerReceipt);
  assert.ok(tx.state().applicationReceipt);
  assert.ok(tx.state().head);
});
test('retained replay precedes every current-effect/source fence', async () => {
  const tx = syntheticTransaction({ previous: { retained: true }, failAssertion: 1, failFence: 1 });
  const result = await tx.run();
  assert.deepEqual(tx.calls, ['lock', 'previous', 'read']);
  assert.equal(result.current.projects[0].output.currentVersion, 9);
  assert.equal(result.creation.ack.projects[0].createdVersion, 1);
  assert.deepEqual(tx.state(), tx.initial);
});
test('retained read conflict does not fall through to prepare', async () => {
  const tx = syntheticTransaction({ previous: { retained: true }, readConflict: true });
  await assert.rejects(tx.run, e => e instanceof CanonicalApplicationError && e.code === 'REQUEST_CONFLICT');
  assert.deepEqual(tx.calls, ['lock', 'previous', 'read']);
  assert.deepEqual(tx.state(), tx.initial);
});
test('owner-only replay without its paired application ACK remains uncertainty', async () => {
  const tx = syntheticTransaction({ ownerReplay: true });
  await assert.rejects(tx.run, e => e instanceof CanonicalApplicationError && e.code === 'OUTCOME_UNCONFIRMED');
  assert.deepEqual(tx.calls, ['lock', 'previous', 'assert:1', 'prepare']);
  assert.deepEqual(tx.state(), tx.initial);
  assert.ok(tx.state().ownerReceipt);
  assert.equal(tx.state().applicationReceipt, null);
});
for (const phase of [1, 2, 3]) {
  test(`source/consent fence ${phase} failure escapes and rolls back the synthetic owner transaction`, async () => {
    const tx = syntheticTransaction({ failFence: phase });
    await assert.rejects(tx.run, e => e instanceof CanonicalApplicationError && e.code === 'AUTHORITY_UNAVAILABLE');
    assert.deepEqual(tx.state(), tx.initial);
    assert.equal(tx.calls.at(-1), `fence:${phase}`);
    assert.equal(tx.calls.includes('output-write'), phase > 1);
    assert.equal(tx.calls.includes('head-write'), phase === 3);
  });
}
test('claim loss at the final release rolls back outputs and both receipt/head writes', async () => {
  const tx = syntheticTransaction({ failAssertion: 4 });
  await assert.rejects(tx.run, e => e instanceof CanonicalApplicationError && e.code === 'AUTHORITY_UNAVAILABLE');
  assert.ok(tx.calls.includes('output-write'));
  assert.ok(tx.calls.includes('owner-receipt-write'));
  assert.ok(tx.calls.includes('application-write'));
  assert.ok(tx.calls.includes('head-write'));
  assert.equal(tx.calls.at(-1), 'assert:4');
  assert.deepEqual(tx.state(), tx.initial);
});
for (const phase of ['Insert', 'Head']) {
  test(`application ${phase.toLowerCase()} failure cannot leave an acknowledged partial synthetic commit`, async () => {
    const tx = syntheticTransaction({ [`fail${phase}`]: true });
    await assert.rejects(tx.run, e => e instanceof CanonicalApplicationError && e.code === 'AUTHORITY_UNAVAILABLE');
    assert.ok(tx.calls.includes('output-write'));
    assert.ok(tx.calls.includes('owner-receipt-write'));
    assert.deepEqual(tx.state(), tx.initial);
  });
}
