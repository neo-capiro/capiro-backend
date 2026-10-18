import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

// Actual pure kernel and policy, native source stripping only. This synthetic
// transactional fixture proves no database, producer, workload identity or RLS.
const kernelUrl = new URL('../src/clients/objectives/work/objective-work-command.ts', import.meta.url);
const policyUrl = new URL('../src/auth/workload-authority/objective-consent-policy.ts', import.meta.url);
const kernelBytes = readFileSync(kernelUrl), policyBytes = readFileSync(policyUrl);
const kernelSource = kernelBytes.toString('utf8');
const policyImport = "'../../../auth/workload-authority/objective-consent-policy.js'";
assert.equal(kernelSource.split(policyImport).length - 1, 1);
const stripped = stripTypeScriptTypes(kernelSource.replace(policyImport, JSON.stringify(policyUrl.href)),
  { mode: 'strip', sourceUrl: kernelUrl.href });
const { ObjectiveWorkError, parseWorkPairConfirmation, executeWorkPairConfirmation, executeWorkCommand,
  parseWorkCommand } = await import(`data:text/javascript;base64,${Buffer.from(stripped).toString('base64')}`);
const SHA = bytes => createHash('sha256').update(bytes).digest('hex');
const STRATEGY = 'objective.strategy.draft', PLANNER = 'objective.plan.prepare';
const actions = [PLANNER, STRATEGY];
const NOW = '2026-10-16T12:00:00.000Z', MS = Date.parse(NOW);
const iso = offset => new Date(MS + offset).toISOString();
const id = n => `aaaaaaaa-bbbb-4ccc-8ddd-${n.toString(16).padStart(12, '0')}`;
const I = { tenant: id(1), client: id(2), objective: id(3), revision: id(4), actor: id(5),
  member: id(6), rootActor: id(7), root: id(8), canonical: id(9), strategy: id(10), project: id(11) };
const clone = value => structuredClone(value);
const receiptKey = (a, action, requestId) => `${a.actorUserId}:${action}:${requestId}`;
const body = () => ({ schemaVersion: 1, expectedObjectiveVersion: 1, expectedCanonicalBindingVersion: 1,
  strategy: { requestId: id(20), expectedControlVersion: 0, targetAuthorizationRequestId: null },
  planner: { requestId: id(21), expectedControlVersion: 0, targetAuthorizationRequestId: null } });
const request = raw => parseWorkPairConfirmation(I.client, I.objective, raw ?? body());
const code = expected => error => {
  assert.ok(error instanceof ObjectiveWorkError); assert.equal(error.code, expected); return true;
};
const fail = (run, expected) => assert.rejects(run, code(expected));
const invalid = run => assert.throws(run, code('INVALID_REQUEST'));

class PairOwner {
  constructor() {
    const source = { canonicalPlanId: I.canonical, canonicalEpoch: 1, canonicalStrategyId: I.strategy,
      canonicalProjectId: I.project, canonicalBindingVersion: 1, rootIntentId: I.root,
      sourceRevisionId: I.revision, sourceObjectiveVersion: 1, sourceSnapshotHash: 'a'.repeat(64), rootActorUserId: I.rootActor };
    const policy = { configuredDurationMs: null, tenantDurationLimitMs: null, actionDurationLimitMs: null,
      originalTokenExpiresAtMs: MS + 7200000, originalDelegationExpiresAtMs: null, limitReference: 'synthetic-owner' };
    this.data = { authority: { tenantId: I.tenant, actorUserId: I.actor, actorMembershipId: I.member,
      clerkUserId: 'user_synthetic', clientId: I.client, objectiveId: I.objective, objectiveRevisionId: I.revision,
      objectiveVersion: 1, objectiveStatus: 'ready' }, states: Object.fromEntries(actions.map(action =>
      [action, { source: clone(source), control: null }])), policy: Object.fromEntries(actions.map(action => [action, clone(policy)])),
      // Explicit synthetic owner evidence; absence is never converted to this state.
      evidence: Object.fromEntries(actions.map(action => [action, { state: 'not_started' }])),
      consents: {}, receipts: {}, clocks: [], nextId: 1000 };
    this.events = []; this.denied = false; this.failure = null; this.beforeWrite = null; this.onState = null;
    this.rejectFinalAuthority = false; this.sequence = 0;
  }
  single(action) {
    return { transaction: (write, run) => this.transaction(write, pair => run(pair[action === PLANNER ? 'planner' : 'strategy'])) };
  }
  async transaction(write, run) {
    if (write && this.beforeWrite) { const hook = this.beforeWrite; this.beforeWrite = null; await hook(this); }
    const data = clone(this.data), txId = ++this.sequence;
    const event = (method, action, detail = {}) => this.events.push({ method, action, write, txId, ...detail });
    const writable = () => assert.equal(write, true);
    const reject = (method, action) => {
      if (this.failure?.method === method && this.failure.action === action) throw Error(`synthetic ${method} failure`);
    };
    const ports = action => ({
      lockOwner: async () => { writable(); event('lockOwner', action); reject('lockOwner', action); },
      currentAuthority: async () => {
        event('authority', action); if (this.denied) throw new ObjectiveWorkError('NOT_AVAILABLE');
        return clone(data.authority);
      },
      receipt: async (a, kind, requestId) => {
        assert.equal(kind, action); event('receipt', action);
        return clone(data.receipts[receiptKey(a, kind, requestId)] ?? null);
      },
      state: async (_a, kind, create, lockOnly = false) => {
        assert.equal(kind, action); event('state', action, { create, lockOnly });
        if (create || lockOnly) writable();
        if (this.onState) { const hook = this.onState; this.onState = null; await hook(data, action); }
        const state = data.states[action];
        if (create && !state.control) {
          event('insertControl', action); reject('insertControl', action);
          state.control = { id: id(action === PLANNER ? 50 : 51), version: 0, currentConsentId: null,
            cancelledAt: null, cancelledByUserId: null };
        }
        return { ...clone(state), consent: clone(data.consents[state.control?.currentConsentId] ?? null) };
      },
      reconcile: async (a, kind, state) => {
        assert.equal(kind, action); event('reconcile', action);
        return { tenantId: a.tenantId, clientId: a.clientId, objectiveId: a.objectiveId, workAction: action,
          authorizationRequestId: state.control?.currentConsentId ?? null,
          rootIntentId: state.consent?.source.rootIntentId ?? state.source.rootIntentId,
          canonicalPlanId: state.source.canonicalPlanId, canonicalEpoch: state.source.canonicalEpoch, ...clone(data.evidence[action]) };
      },
      policy: async () => { event('policy', action); return clone(data.policy[action]); },
      clock: async () => { event('clock', action); return data.clocks.shift() ?? NOW; },
      newId: () => { writable(); event('newId', action); return id(data.nextId++); },
      insertConsent: async (_a, kind, consent) => {
        writable(); assert.equal(kind, action); event('insertConsent', action); reject('insertConsent', action);
        assert.equal(data.consents[consent.id], undefined); data.consents[consent.id] = clone(consent);
      },
      casControl: async (_a, kind, before, after) => {
        writable(); assert.equal(kind, action); event('casControl', action);
        if (this.failure?.method === 'casControl' && this.failure.action === action) return false;
        assert.deepEqual(data.states[action].control, before); data.states[action].control = clone(after); return true;
      },
      insertReceipt: async (a, stored) => {
        writable(); event('insertReceipt', action); reject('insertReceipt', action);
        const key = receiptKey(a, action, stored.command.requestId);
        assert.equal(data.receipts[key], undefined); data.receipts[key] = clone(stored);
      },
    });
    event('begin');
    try {
      const result = await run({ strategy: ports(STRATEGY), planner: ports(PLANNER) });
      if (write && this.rejectFinalAuthority) throw new ObjectiveWorkError('NOT_AVAILABLE');
      if (write) this.data = data;
      event('commit'); return result;
    } catch (error) { event('rollback'); throw error; }
  }
}
const writes = owner => owner.events.filter(e => ['insertControl', 'insertConsent', 'casControl', 'insertReceipt'].includes(e.method));
const stored = (owner, r) => owner.data.receipts[receiptKey(owner.data.authority, r.command.workAction, r.command.requestId)];
const seedSingle = (owner, r) => executeWorkCommand(r, owner.single(r.command.workAction));

test('actual source custody and explicit route retain one proof/transaction owner and unavailable default', t => {
  const service = readFileSync(new URL('../src/clients/objectives/work/objective-work.service.ts', import.meta.url), 'utf8');
  const controller = readFileSync(new URL('../src/clients/objectives/work/objective-work.controller.ts', import.meta.url), 'utf8');
  assert.match(controller, /@Post\('confirm-pair'\)/);
  const pairStore = service.slice(service.indexOf('private pairStore'), service.indexOf('private async proofTransaction'));
  assert.equal((pairStore.match(/this\.proofTransaction\(/g) ?? []).length, 1);
  assert.match(pairStore, /const owned = this\.ports\(tx,/);
  assert.match(pairStore, /strategy: port\(request\.strategy, 'objective\.strategy\.draft'\)/);
  assert.match(pairStore, /planner: port\(request\.planner, 'objective\.plan\.prepare'\)/);
  assert.match(pairStore, /if \(expires\.length === 0\) return/);
  assert.match(pairStore, /LEAST\(\$\{expires\[0\]!\}::timestamptz,\$\{expires\[1\]!\}::timestamptz\)/);
  assert.match(service, /state: 'unavailable' as const/);
  t.diagnostic(JSON.stringify({ kernelSha256: SHA(kernelBytes), policySha256: SHA(policyBytes),
    serviceSha256: SHA(service), controllerSha256: SHA(controller) }));
});

test('pair parser expands fixed action domains into the existing eight-key retry command', () => {
  const raw = body(); raw.strategy.requestId = raw.strategy.requestId.toUpperCase();
  const r = parseWorkPairConfirmation(I.client.toUpperCase(), I.objective.toUpperCase(), raw);
  assert.equal(r.clientId, I.client); assert.equal(r.strategy.command.requestId, id(20));
  for (const [name, action] of [['strategy', STRATEGY], ['planner', PLANNER]]) {
    assert.equal(r[name].command.command, 'retry'); assert.equal(r[name].command.workAction, action);
    assert.equal(Object.keys(r[name].command).length, 8);
    assert.deepEqual(parseWorkCommand(I.client, I.objective, r[name].command), r[name]);
  }
  assert.deepEqual(request(Object.assign(Object.create(null), raw)), r);
  const sharedRequestId = body(); sharedRequestId.planner.requestId = sharedRequestId.strategy.requestId;
  const separateDomains = request(sharedRequestId);
  assert.equal(separateDomains.strategy.command.requestId, separateDomains.planner.command.requestId);
  assert.notEqual(separateDomains.strategy.command.workAction, separateDomains.planner.command.workAction);
});

test('pair parser rejects extra identities, missing keys, malformed versions and hostile nested input without calls', () => {
  for (const field of Object.keys(body())) { const raw = body(); delete raw[field]; invalid(() => request(raw)); }
  for (const name of ['strategy', 'planner']) {
    for (const field of Object.keys(body()[name])) { const raw = body(); delete raw[name][field]; invalid(() => request(raw)); }
    for (const value of [-1, 0.5, Infinity, NaN, '0', 2147483648]) {
      const raw = body(); raw[name].expectedControlVersion = value; invalid(() => request(raw));
    }
    for (const value of ['bad', `${id(20)}\n`, undefined]) {
      const raw = body(); raw[name].requestId = value; invalid(() => request(raw));
    }
    const raw = body(); raw[name].workAction = STRATEGY; invalid(() => request(raw));
  }
  for (const field of ['expectedObjectiveVersion', 'expectedCanonicalBindingVersion'])
    for (const value of [0, -1, 1.5, '1', NaN, Infinity, 2147483648]) {
      const raw = body(); raw[field] = value; invalid(() => request(raw));
    }
  for (const extra of ['requestId', 'actorUserId', 'expiresAt', 'consentPolicyId']) {
    const raw = body(); raw[extra] = id(30); invalid(() => request(raw));
  }
  let calls = 0;
  const getter = body(); Object.defineProperty(getter.strategy, 'requestId', { enumerable: true, get() { calls++; } });
  const proxy = body(); proxy.planner = new Proxy(proxy.planner, { ownKeys() { calls++; throw Error('no call'); } });
  const revoked = Proxy.revocable(body(), {}); revoked.revoke();
  for (const raw of [getter, proxy, revoked.proxy, [], { ...body(), [Symbol('extra')]: 1 }]) invalid(() => request(raw));
  assert.equal(calls, 0);
});

test('new pair uses one write transaction, distinct consent/control identities and the real 30-minute policy', async () => {
  const owner = new PairOwner(), r = request();
  const result = await executeWorkPairConfirmation(r, owner);
  assert.deepEqual(Object.keys(result).sort(), ['planner', 'schemaVersion', 'strategy']);
  assert.equal(new Set(writes(owner).map(e => e.txId)).size, 1);
  assert.equal(owner.events.filter(e => e.method === 'begin' && e.write).length, 1);
  assert.notEqual(result.strategy.consent.id, result.planner.consent.id);
  assert.notEqual(owner.data.states[STRATEGY].control.id, owner.data.states[PLANNER].control.id);
  for (const name of ['strategy', 'planner']) {
    const receipt = result[name], consent = owner.data.consents[receipt.consent.id];
    assert.equal(receipt.controlVersionAfter, 1); assert.equal(receipt.consent.expiresAt, iso(1800000));
    assert.equal(consent.policyId, 'capiro.objective-generation-consent'); assert.equal(consent.policyRevision, 1);
    assert.equal(consent.actorUserId, I.actor); assert.equal(consent.actorMembershipId, I.member);
    assert.equal(consent.source.rootActorUserId, I.rootActor); assert.equal(consent.commandReceiptId, receipt.receiptId);
    assert.deepEqual(stored(owner, r[name]).receipt, receipt);
  }
});

test('both owner locks, row locks, reconciliation and policies precede the first empty-control insertion', async () => {
  const owner = new PairOwner(); await executeWorkPairConfirmation(request(), owner);
  const events = owner.events.filter(e => e.write), firstWrite = events.findIndex(e => e.method === 'insertControl');
  assert.deepEqual(events.filter(e => e.method === 'lockOwner').map(e => e.action), [PLANNER, STRATEGY]);
  assert.ok(events.findIndex(e => e.method === 'authority') > events.findIndex(e => e.method === 'lockOwner' && e.action === STRATEGY));
  for (const action of actions) for (const method of ['state', 'reconcile', 'policy']) {
    const i = events.findIndex(e => e.method === method && e.action === action);
    assert.ok(i >= 0 && i < firstWrite, `${action} ${method} must preflight`);
    if (method === 'state') assert.deepEqual([events[i].create, events[i].lockOnly], [false, true]);
  }
});

test('either UNKNOWN, unavailable or already-applied owner outcome prevents all writes', async () => {
  for (const action of actions) for (const state of ['unavailable', 'outcome_unconfirmed', 'applied']) {
    const owner = new PairOwner(); owner.data.evidence[action] = state === 'applied'
      ? { state: 'accounted', outcome: 'applied', operationId: id(70), attemptId: id(71), runId: id(72),
        requestFingerprint: 'b'.repeat(64), originalDeadlineAt: iso(-1), terminalReceiptId: id(73) } : { state };
    const before = clone(owner.data);
    await fail(() => executeWorkPairConfirmation(request(), owner), state === 'unavailable' ? 'AUTHORITY_UNAVAILABLE' : 'OUTCOME_UNCONFIRMED');
    assert.deepEqual(owner.data, before); assert.equal(writes(owner).length, 0);
  }
});

test('invalid second policy and different original token bounds fail before control insertion', async () => {
  for (const patch of [{ configuredDurationMs: 1800001 }, { originalTokenExpiresAtMs: MS },
    { originalDelegationExpiresAtMs: MS }, { limitReference: '' }, { originalTokenExpiresAtMs: MS + 1000 }]) {
    const owner = new PairOwner(); Object.assign(owner.data.policy[STRATEGY], patch);
    const before = clone(owner.data);
    await fail(() => executeWorkPairConfirmation(request(), owner), 'AUTHORITY_UNAVAILABLE');
    assert.deepEqual(owner.data, before); assert.equal(writes(owner).length, 0);
  }
});

test('Objective, canonical, source and control preflight conflicts leave both actions untouched', async () => {
  for (const [change, expected] of [
    [o => { o.data.authority.objectiveStatus = 'draft'; }, 'OBJECTIVE_VERSION_CONFLICT'],
    [o => { o.data.authority.objectiveVersion = 2; }, 'OBJECTIVE_VERSION_CONFLICT'],
    [o => { o.data.states[STRATEGY].source.canonicalBindingVersion = 2; }, 'CANONICAL_VERSION_CONFLICT'],
    [o => { o.data.states[STRATEGY].source.rootIntentId = id(99); }, 'AUTHORITY_UNAVAILABLE'],
    [o => { o.data.states[STRATEGY].source.sourceSnapshotHash = 'bad'; }, 'AUTHORITY_UNAVAILABLE'],
  ]) {
    const owner = new PairOwner(); change(owner); const before = clone(owner.data);
    await fail(() => executeWorkPairConfirmation(request(), owner), expected);
    assert.deepEqual(owner.data, before); assert.equal(writes(owner).length, 0);
  }
  const owner = new PairOwner(), raw = body(); raw.strategy.expectedControlVersion = 1;
  await fail(() => executeWorkPairConfirmation(request(raw), owner), 'CONTROL_VERSION_CONFLICT');
  assert.equal(writes(owner).length, 0);
});

test('failure in second control/consent/CAS/receipt and final admission rolls back both staged actions', async () => {
  for (const method of ['insertControl', 'insertConsent', 'casControl', 'insertReceipt', 'finalAuthority']) {
    const owner = new PairOwner(), before = clone(owner.data);
    if (method === 'finalAuthority') owner.rejectFinalAuthority = true;
    else owner.failure = { method, action: STRATEGY };
    const run = () => executeWorkPairConfirmation(request(), owner);
    if (method === 'casControl') await fail(run, 'CONTROL_VERSION_CONFLICT');
    else if (method === 'finalAuthority') await fail(run, 'NOT_AVAILABLE');
    else await assert.rejects(run, new RegExp(`synthetic ${method} failure`));
    assert.deepEqual(owner.data, before);
    if (method === 'insertReceipt' || method === 'finalAuthority')
      assert.equal(owner.events.some(e => e.method === 'insertReceipt' && e.action === PLANNER), true);
    if (method === 'finalAuthority')
      assert.equal(owner.events.some(e => e.method === 'insertReceipt' && e.action === STRATEGY), true);
  }
});

test('expiry at receipt time or after both receipt writes rolls back the whole pair', async () => {
  for (const clocks of [[NOW, iso(1)], [NOW, NOW, iso(1)]]) {
    const owner = new PairOwner(); for (const action of actions) owner.data.policy[action].originalTokenExpiresAtMs = MS + 1;
    owner.data.clocks = clocks; const before = clone(owner.data);
    await fail(() => executeWorkPairConfirmation(request(), owner), 'AUTHORITY_UNAVAILABLE');
    assert.deepEqual(owner.data, before);
  }
});

test('partial historical receipt presence refuses without materializing the missing action', async () => {
  for (const name of ['strategy', 'planner']) {
    const owner = new PairOwner(), r = request(); await seedSingle(owner, r[name]);
    owner.events.length = 0; const before = clone(owner.data);
    await fail(() => executeWorkPairConfirmation(r, owner), 'OUTCOME_UNCONFIRMED');
    assert.deepEqual(owner.data, before); assert.equal(writes(owner).length, 0);
    assert.equal(owner.events.some(e => e.method === 'lockOwner'), false);
  }
});

test('two independently recorded exact receipts replay as two historical receipts after source/expiry changes', async () => {
  const owner = new PairOwner(), r = request();
  const strategy = await seedSingle(owner, r.strategy), planner = await seedSingle(owner, r.planner);
  owner.data.authority.objectiveVersion = 9; owner.data.authority.objectiveRevisionId = id(90);
  owner.data.authority.objectiveStatus = 'draft'; owner.data.evidence[STRATEGY] = { state: 'unavailable' };
  owner.data.clocks = [iso(7200000)]; owner.events.length = 0;
  assert.deepEqual(await executeWorkPairConfirmation(r, owner), { schemaVersion: 1, strategy, planner });
  assert.equal(writes(owner).length, 0); assert.equal(owner.events.some(e => e.method === 'state'), false);
  owner.denied = true; owner.events.length = 0;
  await fail(() => executeWorkPairConfirmation(r, owner), 'NOT_AVAILABLE');
  assert.equal(owner.events.some(e => e.method === 'receipt'), false);
});

test('same action request UUID with changed payload refuses before expected-version checks', async () => {
  const owner = new PairOwner(); await executeWorkPairConfirmation(request(), owner);
  const raw = body(); raw.strategy.expectedControlVersion = 20; owner.events.length = 0;
  await fail(() => executeWorkPairConfirmation(request(raw), owner), 'REQUEST_ID_CONFLICT');
  assert.equal(writes(owner).length, 0); assert.equal(owner.events.some(e => e.method === 'state'), false);
});

test('write admission resolves fresh native authority again after the read-only miss', async () => {
  const owner = new PairOwner(); owner.beforeWrite = o => { o.denied = true; };
  await fail(() => executeWorkPairConfirmation(request(), owner), 'NOT_AVAILABLE');
  assert.equal(owner.events.filter(e => e.method === 'authority').length, 2);
  assert.equal(owner.events.some(e => e.method === 'state'), false);
  assert.equal(writes(owner).length, 0);
});

test('both receipts appearing before write admission replay; a partial receipt appearing under locks refuses', async () => {
  const prepared = new PairOwner(), r = request(); await executeWorkPairConfirmation(r, prepared);
  const owner = new PairOwner(); owner.beforeWrite = o => { o.data = clone(prepared.data); };
  const result = await executeWorkPairConfirmation(r, owner);
  assert.equal(result.strategy.receiptId, stored(prepared, r.strategy).receipt.receiptId);
  assert.equal(writes(owner).length, 0);
  const partial = new PairOwner();
  partial.onState = data => { const saved = stored(prepared, r.strategy);
    data.receipts[receiptKey(data.authority, STRATEGY, r.strategy.command.requestId)] = clone(saved); };
  await fail(() => executeWorkPairConfirmation(r, partial), 'OUTCOME_UNCONFIRMED');
  assert.equal(writes(partial).length, 0);
});

test('new paired reconsent preserves old immutable terms and independent action versions/limits', async () => {
  const owner = new PairOwner(), first = request(); await executeWorkPairConfirmation(first, owner);
  const prior = clone(owner.data.consents);
  const extra = parseWorkCommand(I.client, I.objective, { ...first.planner.command, requestId: id(80),
    expectedControlVersion: 1, targetAuthorizationRequestId: stored(owner, first.planner).receipt.consent.id });
  await seedSingle(owner, extra);
  const raw = body(); raw.strategy = { requestId: id(81), expectedControlVersion: 1,
    targetAuthorizationRequestId: stored(owner, first.strategy).receipt.consent.id };
  raw.planner = { requestId: id(82), expectedControlVersion: 2, targetAuthorizationRequestId: stored(owner, extra).receipt.consent.id };
  owner.data.policy[PLANNER].actionDurationLimitMs = 10000; owner.data.policy[STRATEGY].tenantDurationLimitMs = 20000;
  const result = await executeWorkPairConfirmation(request(raw), owner);
  assert.equal(result.strategy.controlVersionAfter, 2); assert.equal(result.planner.controlVersionAfter, 3);
  assert.equal(result.strategy.consent.expiresAt, iso(20000)); assert.equal(result.planner.consent.expiresAt, iso(10000));
  for (const [consentId, consent] of Object.entries(prior)) assert.deepEqual(owner.data.consents[consentId], consent);
});

test('malformed retained receipts fail closed and internal pair domains cannot be swapped', async () => {
  const owner = new PairOwner(), r = request(); await executeWorkPairConfirmation(r, owner);
  stored(owner, r.planner).receipt.payloadDigest = '0'.repeat(64);
  await fail(() => executeWorkPairConfirmation(r, owner), 'RECEIPT_UNVERIFIABLE');
  const swapped = request(); [swapped.strategy, swapped.planner] = [swapped.planner, swapped.strategy];
  await fail(() => executeWorkPairConfirmation(swapped, new PairOwner()), 'INVALID_REQUEST');
});
