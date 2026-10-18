import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

// Native source stripping only: no module hooks, compiler or temporary source.
// Preserve custody of both original files before the one exact import rewrite.
const kernelUrl = new URL('../src/clients/objectives/work/objective-work-command.ts', import.meta.url);
const policyUrl = new URL('../src/auth/workload-authority/objective-consent-policy.ts', import.meta.url);
const kernelBytes = readFileSync(kernelUrl);
const policyBytes = readFileSync(policyUrl);
const kernelSource = kernelBytes.toString('utf8');
const policyImport = "'../../../auth/workload-authority/objective-consent-policy.js'";
assert.equal(kernelSource.split(policyImport).length - 1, 1, 'kernel must retain exactly one known policy import');
const strippedKernel = stripTypeScriptTypes(
  kernelSource.replace(policyImport, JSON.stringify(policyUrl.href)),
  { mode: 'strip', sourceUrl: kernelUrl.href },
);
const custody = {
  kernelSha256: createHash('sha256').update(kernelBytes).digest('hex'),
  policySha256: createHash('sha256').update(policyBytes).digest('hex'),
};
const {
  ObjectiveWorkError, parseWorkCommand, parseWorkRead, workDigest,
  executeWorkCommand, readWorkGeneration,
} = await import(`data:text/javascript;base64,${Buffer.from(strippedKernel).toString('base64')}`);

const ACTION = 'objective.strategy.draft';
const PLAN = 'objective.plan.prepare';
const INT_MAX = 2147483647;
const NOW = '2026-10-16T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const iso = (offset) => new Date(NOW_MS + offset).toISOString();
const id = (n) => `aaaaaaaa-bbbb-4ccc-8ddd-${n.toString(16).padStart(12, '0')}`;
const I = Object.freeze({
  tenant: id(1), client: id(2), objective: id(3), revision: id(4),
  rootActor: id(5), actor: id(6), membership: id(7), canonical: id(8),
  strategy: id(9), project: id(10), root: id(11), request: id(12),
});
const clone = (value) => structuredClone(value);
const key = (actor, action, requestId) => `${actor}:${action}:${requestId}`;
const body = (patch = {}) => ({
  schemaVersion: 1, requestId: I.request, command: 'retry', workAction: ACTION,
  expectedObjectiveVersion: 1, expectedControlVersion: 0,
  expectedCanonicalBindingVersion: 1, targetAuthorizationRequestId: null,
  ...patch,
});
const request = (patch = {}) => parseWorkCommand(I.client, I.objective, body(patch));
const readRequest = (patch = {}) => parseWorkRead(I.client, I.objective, { workAction: ACTION, ...patch });
const codeIs = (code) => (error) => {
  assert.ok(error instanceof ObjectiveWorkError);
  assert.equal(error.code, code);
  return true;
};
const fails = (run, code) => assert.rejects(run, codeIs(code));
const invalid = (run) => assert.throws(run, codeIs('INVALID_REQUEST'));

/** A synthetic owner with serialized writes, cloned transactions and real
 * rollback. Its reconciliation port is explicitly authoritative test input;
 * it models no provider, database, workload identity or runtime admission. */
class MemoryOwner {
  constructor() {
    const source = {
      canonicalPlanId: I.canonical, canonicalEpoch: 1,
      canonicalStrategyId: I.strategy, canonicalProjectId: I.project,
      canonicalBindingVersion: 1, rootIntentId: I.root,
      sourceRevisionId: I.revision, sourceObjectiveVersion: 1,
      sourceSnapshotHash: 'a'.repeat(64), rootActorUserId: I.rootActor,
    };
    this.data = {
      authority: {
        tenantId: I.tenant, actorUserId: I.actor, actorMembershipId: I.membership,
        clerkUserId: 'user_synthetic_writer', clientId: I.client, objectiveId: I.objective,
        objectiveRevisionId: I.revision, objectiveVersion: 1, objectiveStatus: 'ready',
      },
      states: {
        [ACTION]: { source: clone(source), control: null },
        [PLAN]: { source: clone(source), control: null },
      },
      consents: {}, receipts: {}, reconciliation: {},
      policy: {
        configuredDurationMs: null, tenantDurationLimitMs: null,
        actionDurationLimitMs: null, originalTokenExpiresAtMs: NOW_MS + 7200000,
        originalDelegationExpiresAtMs: null, limitReference: 'synthetic-current-authority',
      },
      now: NOW, clocks: [], nextId: 1000,
    };
    this.events = [];
    this.tail = Promise.resolve();
    this.denied = false;
    this.rejectCas = false;
    this.rejectReceipt = false;
    this.onState = null;
    this.beforeWrite = null;
    this.txSequence = 0;
  }

  async transaction(write, run) {
    let release = () => {};
    if (write) {
      const previous = this.tail;
      this.tail = new Promise((resolve) => { release = resolve; });
      await previous;
      if (this.beforeWrite) {
        const hook = this.beforeWrite; this.beforeWrite = null;
        await hook(this);
      }
    }
    const txId = ++this.txSequence;
    const draft = clone(this.data);
    const event = (method, extra = {}) => this.events.push({ txId, write, method, ...extra });
    const writable = () => assert.equal(write, true, 'GET/read transaction attempted a write');
    const tx = {
      lockOwner: async () => { writable(); event('lockOwner'); },
      currentAuthority: async () => {
        event('authority');
        if (this.denied) throw new ObjectiveWorkError('NOT_AVAILABLE');
        return clone(draft.authority);
      },
      receipt: async (authority, action, requestId) => {
        event('receipt', { action, requestId });
        return clone(draft.receipts[key(authority.actorUserId, action, requestId)] ?? null);
      },
      state: async (authority, action, createControl) => {
        event('state', { action, createControl });
        if (createControl) writable();
        if (this.onState) {
          const hook = this.onState; this.onState = null;
          await hook({ owner: this, draft, authority, action });
        }
        const state = draft.states[action];
        if (createControl && !state.control) {
          state.control = { id: id(action === ACTION ? 50 : 51), version: 0,
            currentConsentId: null, cancelledAt: null, cancelledByUserId: null };
        }
        return { source: clone(state.source), control: clone(state.control),
          consent: clone(draft.consents[state.control?.currentConsentId] ?? null) };
      },
      clock: async () => { event('clock'); return draft.clocks.shift() ?? draft.now; },
      reconcile: async (authority, action, state) => {
        event('reconcile', { action });
        return {
          state: 'not_started', tenantId: authority.tenantId, clientId: authority.clientId,
          objectiveId: authority.objectiveId, workAction: action,
          authorizationRequestId: state.control?.currentConsentId ?? null,
          rootIntentId: state.consent?.source.rootIntentId ?? state.source.rootIntentId,
          canonicalPlanId: state.source.canonicalPlanId, canonicalEpoch: state.source.canonicalEpoch,
          ...clone(draft.reconciliation[action] ?? {}),
        };
      },
      policy: async () => { event('policy'); return clone(draft.policy); },
      insertConsent: async (_authority, action, consent) => {
        writable(); event('insertConsent', { action });
        assert.equal(draft.consents[consent.id], undefined);
        draft.consents[consent.id] = clone(consent);
      },
      casControl: async (_authority, action, before, after) => {
        writable(); event('casControl', { action });
        const actual = draft.states[action].control;
        if (this.rejectCas || !actual || actual.version !== before.version ||
            actual.currentConsentId !== before.currentConsentId) return false;
        draft.states[action].control = clone(after);
        return true;
      },
      insertReceipt: async (authority, stored) => {
        writable(); event('insertReceipt');
        if (this.rejectReceipt) throw new Error('synthetic receipt insertion failure');
        const receiptKey = key(authority.actorUserId, stored.command.workAction, stored.command.requestId);
        assert.equal(draft.receipts[receiptKey], undefined);
        draft.receipts[receiptKey] = clone(stored);
      },
      newId: () => { writable(); event('newId'); return id(draft.nextId++); },
    };
    event('begin');
    try {
      const result = await run(tx);
      if (write) this.data = draft;
      event('commit');
      return result;
    } catch (error) {
      event('rollback');
      throw error;
    } finally { release(); }
  }
}

function seedConsent(owner, { action = ACTION, expired = true, version = 3 } = {}) {
  const source = clone(owner.data.states[action].source);
  const consent = {
    id: id(80), controlId: id(50), source, previousConsentId: null,
    actorUserId: id(81), actorMembershipId: id(82),
    policyId: 'capiro.objective-generation-consent', policyRevision: 1,
    configuredDurationMs: 1800000, effectiveDurationMs: 1800000,
    stricterExpiresAt: iso(expired ? -1 : 60000), stricterLimitRef: 'old-authority',
    confirmedAt: iso(expired ? -1800001 : -1740000), expiresAt: iso(expired ? -1 : 60000),
    commandRequestId: id(83), commandReceiptId: id(84), payloadDigest: 'b'.repeat(64),
  };
  owner.data.consents[consent.id] = clone(consent);
  owner.data.states[action].control = { id: consent.controlId, version,
    currentConsentId: consent.id, cancelledAt: null, cancelledByUserId: null };
  return clone(consent);
}
function accounted(outcome = 'failed') {
  return { state: 'accounted', operationId: id(90), attemptId: id(91), runId: id(92),
    requestFingerprint: 'c'.repeat(64), originalDeadlineAt: iso(-60000),
    terminalReceiptId: id(93), outcome };
}
const writes = (owner) => owner.events.filter((e) =>
  ['insertConsent', 'casControl', 'insertReceipt'].includes(e.method));
const storedReceipt = (owner, action = ACTION, actor = I.actor, requestId = I.request) =>
  owner.data.receipts[key(actor, action, requestId)];

test('source custody records hashes of the original kernel and actual policy', (t) => {
  assert.match(custody.kernelSha256, /^[a-f0-9]{64}$/);
  assert.match(custody.policySha256, /^[a-f0-9]{64}$/);
  t.diagnostic(JSON.stringify(custody));
});

test('closed command/read parsers normalize UUIDs and retain the exact eight-field identity', () => {
  const parsed = parseWorkCommand(I.client.toUpperCase(), I.objective.toUpperCase(),
    body({ requestId: I.request.toUpperCase(), targetAuthorizationRequestId: id(60).toUpperCase() }));
  assert.equal(parsed.clientId, I.client);
  assert.equal(parsed.objectiveId, I.objective);
  assert.equal(parsed.command.requestId, I.request);
  assert.equal(parsed.command.targetAuthorizationRequestId, id(60));
  assert.equal(Object.keys(parsed.command).length, 8);
  assert.deepEqual(parseWorkRead(I.client, I.objective, { workAction: PLAN, requestId: I.request.toUpperCase() }),
    { clientId: I.client, objectiveId: I.objective, workAction: PLAN, requestId: I.request });
  const nullPrototype = Object.assign(Object.create(null), body());
  assert.deepEqual(parseWorkCommand(I.client, I.objective, nullPrototype), request());
});

test('newline-suffixed work UUIDs are rejected before parsing or digest identity is produced', () => {
  const cases = [
    ['command client', () => parseWorkCommand(`${I.client}\n`, I.objective, body())],
    ['command objective', () => parseWorkCommand(I.client, `${I.objective}\n`, body())],
    ['command request', () => request({ requestId: `${I.request}\n` })],
    ['command target', () => request({ targetAuthorizationRequestId: `${id(60)}\n` })],
    ['read client', () => parseWorkRead(`${I.client}\n`, I.objective, { workAction: ACTION })],
    ['read objective', () => parseWorkRead(I.client, `${I.objective}\n`, { workAction: ACTION })],
    ['read request', () => readRequest({ requestId: `${I.request}\n` })],
  ];
  for (const [label, parse] of cases) {
    let parsed, digest, failure;
    try { parsed = parse(); digest = workDigest(parsed); } catch (error) { failure = error; }
    assert.ok(failure instanceof ObjectiveWorkError, label);
    assert.equal(failure.code, 'INVALID_REQUEST', label);
    assert.equal(parsed, undefined, label);
    assert.equal(digest, undefined, label);
  }
});

test('parsers reject unknown, missing, nested, symbolic, accessor, proxy and inherited input without invoking it', () => {
  for (const raw of [null, [], new Date(), Object.create(body()), { ...body(), actorId: I.actor },
    { ...body(), deadline: NOW }, { ...body(), groups: [] }, { ...body(), workAction: { value: ACTION } }]) {
    invalid(() => parseWorkCommand(I.client, I.objective, raw));
  }
  for (const field of Object.keys(body())) {
    const raw = body(); delete raw[field];
    invalid(() => parseWorkCommand(I.client, I.objective, raw));
  }
  let invoked = 0;
  const getter = body();
  Object.defineProperty(getter, 'requestId', { enumerable: true, get() { invoked++; throw Error('must not run'); } });
  const queryGetter = {};
  Object.defineProperty(queryGetter, 'workAction', { enumerable: true, get() { invoked++; throw Error('must not run'); } });
  const symbol = { ...body(), [Symbol('extra')]: true };
  const nonenumerable = body();
  Object.defineProperty(nonenumerable, 'requestId', { value: I.request, enumerable: false });
  const proxy = new Proxy(body(), { ownKeys() { invoked++; throw Error('must not run'); },
    getPrototypeOf() { invoked++; throw Error('must not run'); } });
  const revocable = Proxy.revocable(body(), {}); revocable.revoke();
  for (const raw of [getter, symbol, nonenumerable, proxy, revocable.proxy])
    invalid(() => parseWorkCommand(I.client, I.objective, raw));
  for (const raw of [{}, { workAction: ACTION, requestId: null }, { workAction: ACTION, requestId: undefined },
    { workAction: ACTION, requestId: [I.request] }, { workAction: ACTION, extra: true },
    { workAction: ACTION, [Symbol('extra')]: true }, queryGetter, new Proxy({ workAction: ACTION }, {})])
    invalid(() => parseWorkRead(I.client, I.objective, raw));
  assert.equal(invoked, 0);
});

test('versions/actions/UUIDs are bounded and full normalized request digest is order independent', () => {
  for (const [field, values] of [
    ['expectedObjectiveVersion', [0, -1, 1.5, INT_MAX + 1, '1', true, NaN, Infinity]],
    ['expectedControlVersion', [-1, 0.5, INT_MAX + 1, '0', false, NaN]],
    ['expectedCanonicalBindingVersion', [0, -1, INT_MAX + 1, null]],
  ]) for (const value of values) invalid(() => request({ [field]: value }));
  for (const patch of [{ schemaVersion: 2 }, { command: 'resume' }, { workAction: 'task.create' },
    { requestId: 'not-a-uuid' }, { targetAuthorizationRequestId: undefined }]) invalid(() => request(patch));
  assert.equal(request({ expectedControlVersion: INT_MAX }).command.expectedControlVersion, INT_MAX);
  const baseline = request();
  const digest = workDigest(baseline);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(workDigest({ command: Object.fromEntries(Object.entries(baseline.command).reverse()),
    objectiveId: I.objective, clientId: I.client }), digest);
  assert.equal(workDigest(parseWorkCommand(I.client.toUpperCase(), I.objective.toUpperCase(),
    body({ requestId: I.request.toUpperCase() }))), digest);
  for (const patch of [{ schemaVersion: 2 }, { requestId: id(20) }, { command: 'cancel' },
    { workAction: PLAN }, { expectedObjectiveVersion: 2 }, { expectedControlVersion: 1 },
    { expectedCanonicalBindingVersion: 2 }, { targetAuthorizationRequestId: id(21) }])
    assert.notEqual(workDigest({ ...baseline, command: { ...baseline.command, ...patch } }), digest);
  assert.notEqual(workDigest({ ...baseline, clientId: id(22) }), digest);
  assert.notEqual(workDigest({ ...baseline, objectiveId: id(23) }), digest);
  invalid(() => parseWorkCommand('not-a-uuid', I.objective, body()));
  invalid(() => parseWorkRead(I.client, 'not-a-uuid', { workAction: ACTION }));
});

test('new retry locks owner before write authority, uses actual 30-minute rev1 policy and preserves root actor', async () => {
  const owner = new MemoryOwner();
  const receipt = await executeWorkCommand(request(), owner);
  const events = owner.events.filter((e) => e.write);
  assert.ok(events.findIndex((e) => e.method === 'lockOwner') < events.findIndex((e) => e.method === 'authority'));
  assert.ok(events.findIndex((e) => e.method === 'reconcile') < events.findIndex((e) => e.method === 'policy'));
  assert.ok(events.findIndex((e) => e.method === 'policy') < events.findIndex((e) => e.method === 'clock'));
  assert.equal(receipt.outcome, 'reconsent_recorded');
  assert.equal(receipt.controlVersionBefore, 0);
  assert.equal(receipt.controlVersionAfter, 1);
  assert.equal(receipt.authorizationRequestId, receipt.consent.id);
  assert.equal(receipt.consent.expiresAt, iso(1800000));
  const consent = owner.data.consents[receipt.authorizationRequestId];
  assert.equal(consent.policyId, 'capiro.objective-generation-consent');
  assert.equal(consent.policyRevision, 1);
  assert.equal(consent.configuredDurationMs, 1800000);
  assert.equal(consent.effectiveDurationMs, 1800000);
  assert.equal(consent.source.rootActorUserId, I.rootActor);
  assert.equal(consent.actorUserId, I.actor);
  assert.equal(consent.actorMembershipId, I.membership);
  assert.notEqual(consent.actorUserId, consent.source.rootActorUserId);
  assert.equal(storedReceipt(owner).actorMembershipId, I.membership);
});

test('fresh authority precedes historical exact replay; replay preserves committed bytes across later source versions', async () => {
  const owner = new MemoryOwner();
  const original = await executeWorkCommand(request(), owner);
  owner.data.authority.objectiveVersion = 9;
  owner.data.authority.objectiveRevisionId = id(99);
  owner.data.authority.objectiveStatus = 'draft';
  owner.events.length = 0;
  const replay = await executeWorkCommand(request(), owner);
  assert.equal(JSON.stringify(replay), JSON.stringify(original));
  assert.deepEqual(owner.events.filter((e) => !['begin', 'commit'].includes(e.method)).map((e) => e.method), ['authority', 'receipt']);
  owner.denied = true;
  owner.events.length = 0;
  await fails(() => executeWorkCommand(request(), owner), 'NOT_AVAILABLE');
  assert.equal(owner.events.some((e) => e.method === 'receipt'), false);
  assert.equal(writes(owner).length, 0);
});

test('authority is resolved again after entering the write transaction', async () => {
  const revoked = new MemoryOwner();
  revoked.beforeWrite = (owner) => { owner.denied = true; };
  await fails(() => executeWorkCommand(request(), revoked), 'NOT_AVAILABLE');
  assert.equal(revoked.events.filter((e) => e.method === 'authority').length, 2);
  assert.equal(revoked.events.some((e) => e.method === 'state'), false);
  assert.equal(writes(revoked).length, 0);
  const changed = new MemoryOwner();
  changed.beforeWrite = (owner) => { owner.data.authority.objectiveVersion = 2; };
  await fails(() => executeWorkCommand(request(), changed), 'OBJECTIVE_VERSION_CONFLICT');
  assert.equal(writes(changed).length, 0);
});

test('same-action UUID payload conflict wins over stale expected versions; other actions have separate identities', async () => {
  const owner = new MemoryOwner();
  await executeWorkCommand(request(), owner);
  owner.events.length = 0;
  await fails(() => executeWorkCommand(request({ expectedObjectiveVersion: 77,
    expectedControlVersion: 88, expectedCanonicalBindingVersion: 99 }), owner), 'REQUEST_ID_CONFLICT');
  assert.equal(owner.events.some((e) => e.method === 'state'), false);
  assert.equal(writes(owner).length, 0);
  const planReceipt = await executeWorkCommand(request({ workAction: PLAN }), owner);
  assert.equal(planReceipt.workAction, PLAN);
  assert.equal(Object.keys(owner.data.receipts).length, 2);
  assert.notEqual(storedReceipt(owner).receipt.payloadDigest, storedReceipt(owner, PLAN).receipt.payloadDigest);
});

test('receipt appearing at the locked state boundary is rechecked before policy, CAS or consent creation', async () => {
  const committed = new MemoryOwner();
  const expected = await executeWorkCommand(request(), committed);
  const owner = new MemoryOwner();
  owner.onState = ({ draft }) => {
    draft.states = clone(committed.data.states);
    draft.consents = clone(committed.data.consents);
    draft.receipts = clone(committed.data.receipts);
  };
  assert.deepEqual(await executeWorkCommand(request(), owner), expected);
  assert.equal(owner.events.filter((e) => e.method === 'receipt').length, 3);
  assert.equal(owner.events.some((e) => ['policy', 'reconcile', 'newId'].includes(e.method)), false);
  assert.equal(writes(owner).length, 0);
});

test('two writers with the same expected head admit one retry and make the other reload', async () => {
  const owner = new MemoryOwner();
  const results = await Promise.allSettled([
    executeWorkCommand(request({ requestId: id(30) }), owner),
    executeWorkCommand(request({ requestId: id(31) }), owner),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected');
  assert.equal(rejected.reason.code, 'CONTROL_VERSION_CONFLICT');
  assert.equal(owner.data.states[ACTION].control.version, 1);
  assert.equal(Object.keys(owner.data.consents).length, 1);
  assert.equal(Object.keys(owner.data.receipts).length, 1);
});

test('a newly authorized actor consents without rewriting old actor, membership, expiry or canonical lineage', async () => {
  const owner = new MemoryOwner();
  const old = seedConsent(owner);
  const receipt = await executeWorkCommand(request({ expectedControlVersion: 3,
    targetAuthorizationRequestId: old.id }), owner);
  const consent = owner.data.consents[receipt.authorizationRequestId];
  assert.deepEqual(owner.data.consents[old.id], old);
  assert.equal(consent.previousConsentId, old.id);
  assert.equal(consent.source.rootActorUserId, I.rootActor);
  assert.equal(consent.actorUserId, I.actor);
  assert.equal(consent.actorMembershipId, I.membership);
  assert.deepEqual(consent.source, old.source);
  assert.equal(owner.data.authority.objectiveVersion, 1);
  assert.equal(owner.data.authority.objectiveRevisionId, I.revision);
  assert.equal(consent.expiresAt, iso(1800000));
});

test('UNKNOWN, missing owner evidence and applied original outcome create no identities, consent or CAS', async () => {
  for (const evidence of [{ state: 'outcome_unconfirmed' }, { state: 'unavailable' }, accounted('applied')]) {
    const owner = new MemoryOwner();
    owner.data.reconciliation[ACTION] = evidence;
    const before = clone(owner.data);
    await fails(() => executeWorkCommand(request(), owner), evidence.state === 'unavailable' ? 'AUTHORITY_UNAVAILABLE' : 'OUTCOME_UNCONFIRMED');
    assert.deepEqual(owner.data, before);
    assert.equal(writes(owner).length, 0);
    assert.equal(owner.events.some((e) => e.method === 'newId'), false);
  }
});

test('newline-suffixed fingerprints cannot account for failed or cancelled original work', async () => {
  for (const outcome of ['failed', 'cancelled']) {
    const owner = new MemoryOwner();
    owner.data.reconciliation[ACTION] = { ...accounted(outcome), requestFingerprint: `${'c'.repeat(64)}\n` };
    const before = clone(owner.data);
    await fails(() => executeWorkCommand(request(), owner), 'OUTCOME_UNCONFIRMED');
    assert.deepEqual(owner.data, before, `${outcome}: control, consent and receipt data must remain unchanged`);
    assert.equal(writes(owner).length, 0, outcome);
    assert.equal(owner.events.some((e) => e.method === 'newId'), false, outcome);
    assert.equal(owner.events.some((e) => e.method === 'policy'), false, outcome);
  }
});

test('only authoritative not-started or bound failed/cancelled original accounting permits retry', async () => {
  for (const evidence of [{ state: 'not_started' }, accounted('failed'), accounted('cancelled')]) {
    const owner = new MemoryOwner();
    owner.data.reconciliation[ACTION] = evidence;
    assert.equal((await executeWorkCommand(request(), owner)).outcome, 'reconsent_recorded');
    assert.deepEqual(owner.data.reconciliation[ACTION], evidence, 'original accounting facts were rewritten');
  }
  for (const patch of [{ operationId: undefined }, { attemptId: 'bad' }, { runId: undefined },
    { requestFingerprint: 'not-a-hash' }, { originalDeadlineAt: undefined }, { terminalReceiptId: undefined },
    { outcome: undefined }, { workAction: PLAN }, { rootIntentId: id(200) },
    { canonicalPlanId: id(201) }, { canonicalEpoch: 2 }, { authorizationRequestId: id(202) },
    { tenantId: id(203) }, { clientId: id(204) }, { objectiveId: id(205) }]) {
    const owner = new MemoryOwner();
    owner.data.reconciliation[ACTION] = { ...accounted(), ...patch };
    await fails(() => executeWorkCommand(request(), owner), 'OUTCOME_UNCONFIRMED');
    assert.equal(writes(owner).length, 0);
  }
});

test('current source, Objective, canonical and target conflicts fail without writes', async () => {
  for (const [configure, expected] of [
    [(o) => { o.data.authority.clientId = id(300); }, 'NOT_AVAILABLE'],
    [(o) => { o.data.authority.objectiveVersion = 2; }, 'OBJECTIVE_VERSION_CONFLICT'],
    [(o) => { o.data.authority.objectiveStatus = 'draft'; }, 'OBJECTIVE_VERSION_CONFLICT'],
    [(o) => { o.data.authority.objectiveRevisionId = id(301); }, 'OBJECTIVE_VERSION_CONFLICT'],
    [(o) => { o.data.states[ACTION].source.sourceObjectiveVersion = 2; }, 'OBJECTIVE_VERSION_CONFLICT'],
    [(o) => { o.data.states[ACTION].source.canonicalBindingVersion = 2; }, 'CANONICAL_VERSION_CONFLICT'],
    [(o) => { o.data.states[ACTION].source.canonicalEpoch = 2; }, 'AUTHORITY_UNAVAILABLE'],
    [(o) => { o.data.states[ACTION].source.sourceSnapshotHash = 'bad'; }, 'AUTHORITY_UNAVAILABLE'],
  ]) {
    const owner = new MemoryOwner(); configure(owner);
    await fails(() => executeWorkCommand(request(), owner), expected);
    assert.equal(writes(owner).length, 0);
  }
  const owner = new MemoryOwner();
  const old = seedConsent(owner);
  await fails(() => executeWorkCommand(request({ expectedControlVersion: 3,
    targetAuthorizationRequestId: id(302) }), owner), 'CONTROL_VERSION_CONFLICT');
  assert.equal(owner.data.states[ACTION].control.currentConsentId, old.id);
});

test('real policy selects the strictest duration and rejects token expiry equality or unavailable facts', async () => {
  const configured = new MemoryOwner();
  configured.data.policy.configuredDurationMs = 60000;
  assert.equal((await executeWorkCommand(request(), configured)).consent.expiresAt, iso(60000));
  const owner = new MemoryOwner();
  Object.assign(owner.data.policy, { tenantDurationLimitMs: 60000, actionDurationLimitMs: 45000,
    originalTokenExpiresAtMs: NOW_MS + 30000, originalDelegationExpiresAtMs: NOW_MS + 10000 });
  const receipt = await executeWorkCommand(request(), owner);
  assert.equal(receipt.consent.expiresAt, iso(10000));
  assert.equal(owner.data.consents[receipt.authorizationRequestId].effectiveDurationMs, 10000);
  for (const patch of [{ originalTokenExpiresAtMs: NOW_MS }, { originalTokenExpiresAtMs: NOW_MS - 1 },
    { originalTokenExpiresAtMs: null }, { originalDelegationExpiresAtMs: NOW_MS },
    { configuredDurationMs: 1800001 }, { configuredDurationMs: 0 },
    { actionDurationLimitMs: 0 }, { tenantDurationLimitMs: -1 }, { limitReference: '' }]) {
    const denied = new MemoryOwner(); Object.assign(denied.data.policy, patch);
    const before = clone(denied.data);
    await fails(() => executeWorkCommand(request(), denied), 'AUTHORITY_UNAVAILABLE');
    assert.deepEqual(denied.data, before);
    assert.equal(denied.events.some((e) => e.method === 'newId'), false);
  }
});

test('expiry reached between confirmation and commit rolls back consent and head atomically', async () => {
  const owner = new MemoryOwner();
  owner.data.policy.originalTokenExpiresAtMs = NOW_MS + 1;
  owner.data.clocks = [NOW, iso(1)];
  const before = clone(owner.data);
  await fails(() => executeWorkCommand(request(), owner), 'AUTHORITY_UNAVAILABLE');
  assert.deepEqual(owner.data, before);
  assert.equal(owner.events.some((e) => e.method === 'insertReceipt'), false);
});

test('cancel fences expired UNKNOWN work while preserving consent and unresolved owner facts', async () => {
  const owner = new MemoryOwner();
  const old = seedConsent(owner);
  owner.data.reconciliation[ACTION] = { state: 'outcome_unconfirmed' };
  owner.data.policy.originalTokenExpiresAtMs = NOW_MS - 1;
  const receipt = await executeWorkCommand(request({ command: 'cancel', expectedControlVersion: 3,
    targetAuthorizationRequestId: old.id }), owner);
  assert.equal(receipt.outcome, 'cancellation_recorded');
  assert.equal(receipt.controlVersionAfter, 4);
  assert.equal(receipt.authorizationRequestId, old.id);
  assert.equal(receipt.consent, null);
  assert.equal(owner.data.states[ACTION].control.cancelledAt, NOW);
  assert.deepEqual(owner.data.consents[old.id], old);
  assert.deepEqual(owner.data.reconciliation[ACTION], { state: 'outcome_unconfirmed' });
  assert.equal(owner.events.some((e) => ['reconcile', 'policy', 'insertConsent'].includes(e.method)), false);
  await fails(() => executeWorkCommand(request({ requestId: id(400), expectedControlVersion: 4,
    targetAuthorizationRequestId: old.id }), owner), 'OUTCOME_UNCONFIRMED');
});

test('null-head original cancellation advances once; exact replay and new repeated cancel do not advance again', async () => {
  const owner = new MemoryOwner();
  owner.data.reconciliation[ACTION] = { state: 'outcome_unconfirmed' };
  const cancel = request({ command: 'cancel' });
  const first = await executeWorkCommand(cancel, owner);
  assert.equal(first.controlVersionAfter, 1);
  assert.equal(first.authorizationRequestId, null);
  assert.equal(first.consent, null);
  assert.deepEqual(await executeWorkCommand(cancel, owner), first);
  owner.events.length = 0;
  owner.data.now = iso(1000);
  const repeat = await executeWorkCommand(request({ requestId: id(401), command: 'cancel', expectedControlVersion: 1 }), owner);
  assert.equal(repeat.outcome, 'unchanged');
  assert.equal(repeat.controlVersionBefore, 1);
  assert.equal(repeat.controlVersionAfter, 1);
  assert.equal(owner.data.states[ACTION].control.cancelledAt, NOW);
  assert.equal(owner.events.some((e) => e.method === 'casControl'), false);
  assert.equal(Object.keys(owner.data.receipts).length, 2);
});

test('cancellation pins current command revision separately from old saved-work source', async () => {
  const owner = new MemoryOwner();
  owner.data.authority.objectiveVersion = 2;
  owner.data.authority.objectiveRevisionId = id(410);
  owner.data.authority.objectiveStatus = 'draft';
  const receipt = await executeWorkCommand(request({ command: 'cancel', expectedObjectiveVersion: 2 }), owner);
  assert.deepEqual(receipt.commandRevision, { id: id(410), version: 2 });
  assert.deepEqual(receipt.sourceRevision, { id: I.revision, version: 1 });
});

test('control version overflow cannot wrap; already-cancelled max-version head may remain unchanged', async () => {
  for (const command of ['retry', 'cancel']) {
    const owner = new MemoryOwner();
    seedConsent(owner, { version: INT_MAX });
    const before = clone(owner.data);
    await fails(() => executeWorkCommand(request({ command, expectedControlVersion: INT_MAX,
      targetAuthorizationRequestId: id(80) }), owner), 'CONTROL_VERSION_CONFLICT');
    assert.deepEqual(owner.data, before);
    assert.equal(writes(owner).length, 0);
  }
  const owner = new MemoryOwner();
  seedConsent(owner, { version: INT_MAX });
  Object.assign(owner.data.states[ACTION].control, { cancelledAt: NOW, cancelledByUserId: I.actor });
  const receipt = await executeWorkCommand(request({ command: 'cancel', expectedControlVersion: INT_MAX,
    targetAuthorizationRequestId: id(80) }), owner);
  assert.equal(receipt.outcome, 'unchanged');
  assert.equal(receipt.controlVersionAfter, INT_MAX);
});

test('CAS loss and receipt insertion failure roll back every staged local change', async () => {
  for (const mode of ['cas', 'receipt']) {
    const owner = new MemoryOwner();
    owner.rejectCas = mode === 'cas'; owner.rejectReceipt = mode === 'receipt';
    const before = clone(owner.data);
    if (mode === 'cas') await fails(() => executeWorkCommand(request(), owner), 'CONTROL_VERSION_CONFLICT');
    else await assert.rejects(() => executeWorkCommand(request(), owner), /synthetic receipt insertion failure/);
    assert.deepEqual(owner.data, before);
    assert.equal(owner.events.some((e) => e.method === 'rollback' && e.write), true);
  }
});

test('GET is read-only, minimal, and uses authoritative reconciliation rather than inferring absence', async () => {
  const owner = new MemoryOwner();
  const before = clone(owner.data);
  const view = await readWorkGeneration(readRequest(), owner);
  assert.deepEqual(Object.keys(view).sort(), ['schemaVersion', 'clientId', 'objective', 'workAction',
    'control', 'consent', 'reconciliation', 'commandReceipt', 'observedAt'].sort());
  assert.deepEqual(view.control, { version: 0, currentAuthorizationRequestId: null, cancelledAt: null });
  assert.equal(view.commandReceipt, null);
  assert.equal(view.consent, null);
  assert.equal(view.reconciliation, 'not_started');
  assert.deepEqual(owner.data, before);
  assert.equal(owner.events.every((e) => !e.write), true);
  assert.equal(owner.events.find((e) => e.method === 'state').createControl, false);
  for (const state of ['unavailable', 'outcome_unconfirmed']) {
    owner.data.reconciliation[ACTION] = { state };
    assert.equal((await readWorkGeneration(readRequest(), owner)).reconciliation, 'outcome_unconfirmed');
  }
  const json = JSON.stringify(view);
  for (const privateValue of [I.canonical, I.strategy, I.project, I.membership, 'a'.repeat(64)])
    assert.equal(json.includes(privateValue), false);
});

test('GET reports expiry equality, recovers only current actor/action receipt and never revives consent', async () => {
  const owner = new MemoryOwner();
  const receipt = await executeWorkCommand(request(), owner);
  owner.data.now = receipt.consent.expiresAt;
  owner.events.length = 0;
  const before = clone(owner.data);
  const view = await readWorkGeneration(readRequest({ requestId: I.request }), owner);
  assert.equal(view.consent.expired, true);
  assert.deepEqual(view.commandReceipt, receipt);
  const publicJson = JSON.stringify(view);
  for (const privateValue of [I.canonical, I.strategy, I.project, I.membership, 'a'.repeat(64)])
    assert.equal(publicJson.includes(privateValue), false);
  assert.deepEqual(owner.data, before);
  assert.equal(writes(owner).length, 0);
  assert.equal(owner.events.every((e) => !e.write), true);
  await fails(() => readWorkGeneration(readRequest({ workAction: PLAN, requestId: I.request }), owner), 'NOT_AVAILABLE');
  owner.data.authority.actorUserId = id(500);
  owner.data.authority.actorMembershipId = id(501);
  await fails(() => readWorkGeneration(readRequest({ requestId: I.request }), owner), 'NOT_AVAILABLE');
  owner.denied = true;
  owner.events.length = 0;
  await fails(() => readWorkGeneration(readRequest({ requestId: I.request }), owner), 'NOT_AVAILABLE');
  assert.equal(owner.events.some((e) => e.method === 'receipt'), false);
});

test('GET rejects an inconsistent ledger head instead of projecting missing consent as authority', async () => {
  const owner = new MemoryOwner();
  owner.data.states[ACTION].control = { id: id(50), version: 1,
    currentConsentId: id(80), cancelledAt: null, cancelledByUserId: null };
  const before = clone(owner.data);
  await fails(() => readWorkGeneration(readRequest(), owner), 'AUTHORITY_UNAVAILABLE');
  assert.deepEqual(owner.data, before);
  assert.equal(writes(owner).length, 0);
});

test('historical receipts with a false digest or invalid confirmation/commit/expiry window are unverifiable', async () => {
  for (const tamper of [
    (r) => { r.payloadDigest = '0'.repeat(64); },
    (r) => { r.committedAt = r.consent.expiresAt; },
    (r) => { r.consent.confirmedAt = iso(1); },
  ]) {
    const owner = new MemoryOwner();
    await executeWorkCommand(request(), owner);
    tamper(storedReceipt(owner).receipt);
    await fails(() => readWorkGeneration(readRequest({ requestId: I.request }), owner), 'RECEIPT_UNVERIFIABLE');
    await fails(() => executeWorkCommand(request(), owner), 'RECEIPT_UNVERIFIABLE');
  }
});
