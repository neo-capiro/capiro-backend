// Synthetic source cases only. No Nest graph, DB, provider, child, file writes,
// loader hooks or current-authority acceptance. Source custody is printed below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

const custody = [];
const sha = value => createHash('sha256').update(value).digest('hex');
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
function replaceOnce(source, from, to) {
  const parts = source.split(from);
  assert.equal(parts.length, 2, `one declared source dependency: ${from}`);
  return parts.join(to);
}
async function sourceModule(relative, replacements = [], mode = 'strip') {
  const url = new URL(relative, import.meta.url), original = await readFile(url, 'utf8');
  let source = original;
  for (const [from, to] of replacements) source = replaceOnce(source, from, to);
  // The existing shared helper has one TS parameter property, requiring Node's
  // built-in transform mode. No application source or test fixture is changed.
  const stripped = stripTypeScriptTypes(source, { mode, sourceUrl: url.href });
  custody.push({ path: relative, sha256: sha(original), mode,
    replacementSpecifiers: replacements.map(([from]) => from), transformedSha256: sha(stripped) });
  return dataModule(stripped);
}
const applicationUrl = await sourceModule('../src/planner/objective-canonical-application.ts');
const domainUrl = await sourceModule('../src/meri/objective-canonical-generation.ts', [
  ["'../planner/objective-canonical-application.js'", JSON.stringify(applicationUrl)],
]);
const sharedUrl = await sourceModule('../../../packages/shared/src/client-objective-destination.ts', [], 'transform');
const fenceUrl = await sourceModule('../src/meri/objective-canonical-generation-fence.ts', [
  ["'@capiro/shared'", JSON.stringify(sharedUrl)],
  ["'../planner/objective-canonical-application.js'", JSON.stringify(applicationUrl)],
  ["'./objective-canonical-generation.js'", JSON.stringify(domainUrl)],
]);
const app = await import(applicationUrl), domain = await import(domainUrl), fence = await import(fenceUrl);
const {
  GENERATION_ADMISSION, GENERATION_ACCEPTANCE, GENERATION_PRODUCER, GENERATION_ADMISSION_NAMESPACE,
  parseGenerationCanonicalToken, parseCanonicalGenerationAdmission, parseAcceptedRunBinding,
  parseCanonicalGenerationAcceptance, requireGenerationAcceptanceForAdmission,
  canonicalGenerationAdmissionSha256, generationBindingKey, generationLedgerId,
  generationUuid, generationSha256,
} = domain;
const { admitCanonicalGenerationWithinTx, requireCanonicalGenerationEffectWithinTx,
  requireCanonicalGenerationReadWithinTx } = fence;
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const copy = value => structuredClone(value);
const hash = char => char.repeat(64);
const invalid = run => assert.throws(run, e => e.code === 'INPUT_INVALID');
const unavailable = run => assert.rejects(run, e => e.code === 'AUTHORITY_UNAVAILABLE');
const stale = run => assert.rejects(run, e => e.code === 'SOURCE_STALE');

function fixture() {
  const snapshot = { id: id(4), clientId: id(3), version: 4, status: 'ready', deletedAt: null };
  const canonical = { canonicalPlanId: id(1), tenantId: id(2), clientId: id(3), objectiveId: id(4),
    canonicalStrategyId: id(5), canonicalProjectId: id(6), bindingVersion: 2, epoch: 1,
    requestedIntentId: id(7), requestedObjectiveRevisionId: id(8), requestedObjectiveVersion: 4,
    snapshotHash: app.applicationHash(snapshot) };
  const scope = { tenantId: id(2), clientId: id(3), objectiveId: id(4), clerkUserId: 'user_fixture',
    generationJobId: id(10), generationRequestId: id(11) };
  const nowMs = 1_000_000;
  const admission = { schemaVersion: 1, namespace: GENERATION_ADMISSION_NAMESPACE, canonical,
    actorUserId: id(9), clerkUserId: scope.clerkUserId, consentId: id(12), controlVersion: 3,
    generationJobId: scope.generationJobId, generationRequestId: scope.generationRequestId,
    admittedAtMs: nowMs, effectExpiresAtMs: nowMs + 20_000, expectedStrategyVersionId: null };
  const request = { requestId: scope.generationRequestId, clientId: scope.clientId,
    objective: { objectiveId: scope.objectiveId, objectiveVersion: 4 } };
  const job = { id: scope.generationJobId, clientId: scope.clientId, ownerUserId: scope.clerkUserId,
    status: 'queued', strategyId: null, attempt: 1, claimedBy: null, claimedAt: null,
    requestKey: `objective-v1:${app.applicationHash([scope.tenantId, scope.clerkUserId, scope.generationRequestId])}`,
    input: { objectiveGeneration: { request, fingerprint: app.applicationHash(request) } },
    deadlineMs: String(nowMs + 20_000) };
  const root = { rootActorUserId: id(19), revisionActor: id(19), hash: canonical.snapshotHash,
    operation: 'confirm_ready', snapshot, purpose: 'objective_strategy_plan', state: 'pending',
    blocker: 'runtime_authority_unconnected', ready: true };
  const consent = { consentId: admission.consentId, controlVersion: 3, actorUserId: admission.actorUserId,
    membershipId: id(13), currentMembershipId: id(13), rootActorUserId: root.rootActorUserId,
    policyId: 'capiro.objective-generation-consent', policyRevision: 1,
    configured: '1800000', effective: '30000', confirmedMs: String(nowMs - 1),
    expiresMs: String(nowMs + 30_000), validExpiry: true };
  const binding = { tenantId: scope.tenantId, actorId: scope.clerkUserId, conversationId: id(20),
    runId: id(21), attemptId: id(22), workerId: id(23), writerFence: 1 };
  const acceptance = { schemaVersion: 1, sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission),
    sourceBinding: binding, sourceRequestSha256: hash('b'), acceptedAtMs: nowMs + 1,
    issuance: { issuanceKey: generationBindingKey(binding), binding: copy(binding), requestSha256: hash('b'),
      expiresAtMs: nowMs + 15_000, grantId: id(24), capabilitySha256: hash('c'), factsSha256: hash('d') } };
  return { snapshot, canonical, scope, nowMs, admission, job, root, consent, binding, acceptance };
}

// This is a tagged-SQL response fixture, not an SQL interpreter or DB proof.
// It exercises real fence control flow and the actual shared owner helper.
function database(x = fixture()) {
  const state = { ...x, calls: [], exists: false, latest: null, strategyClient: x.scope.clientId,
    archived: false, coalescible: false, currentMember: true, memoryWall: false, wallGrant: true,
    currentObjective: true, currentVersion: x.canonical.requestedObjectiveVersion,
    revisionId: x.canonical.requestedObjectiveRevisionId, actorHint: x.admission.actorUserId,
    feature: true, cancelled: false, action: 'objective.strategy.draft',
    saved: { snapshot: { meta: { id: x.canonical.canonicalStrategyId, clientId: x.scope.clientId } },
      authorKind: 'meri', coalescible: false }, sealCount: 1 };
  const tx = {
    async $queryRaw(strings, ...values) {
      const sql = strings.join('?').replace(/\s+/g, ' ').trim();
      state.calls.push({ sql, values });
      if (sql.includes('FROM sp_draft_job')) return [copy(state.job)];
      if (sql.includes('FROM sp_strategy')) return state.exists ? [{ id: state.canonical.canonicalStrategyId,
        clientId: state.strategyClient, archived: state.archived }] : [];
      if (sql.includes('FROM sp_version') && sql.startsWith('SELECT snapshot')) return [copy(state.saved)];
      if (sql.includes('FROM sp_version')) return state.latest ? [{ id: state.latest, coalescible: state.coalescible }] : [];
      if (sql.includes('FROM client_objective_canonical_plans')) return [copy(state.canonical)];
      if (sql.includes('FROM users u JOIN tenant_memberships')) return state.actorHint ? [{ actorUserId: state.actorHint }] : [];
      if (sql.startsWith('SELECT m.user_id')) return state.currentMember ? [{ userId: state.admission.actorUserId,
        memoryWall: state.memoryWall }] : [];
      if (sql.includes('FROM client_objective_work_intents')) return state.feature ? [copy(state.root)] : [];
      if (sql.includes('FROM client_objective_work_controls')) return !state.cancelled && state.action === 'objective.strategy.draft'
        ? [copy(state.consent)] : [];
      if (sql.startsWith('SELECT ceil(')) return [{ nowMs: String(state.nowMs) }];
      if (sql.includes('FROM client_memory_access')) return state.wallGrant ? [{ id: id(30) }] : [];
      if (sql.startsWith('SELECT version FROM client_objectives')) return state.currentObjective ? [{ version: state.currentVersion }] : [];
      if (sql.includes('FROM client_objective_revisions')) return state.revisionId ? [{ id: state.revisionId }] : [];
      if (sql.startsWith('SELECT u.id') && sql.includes('FROM tenants')) return state.currentMember && state.feature
        ? [{ actorUserId: state.admission.actorUserId, memoryWall: state.memoryWall }] : [];
      if (sql.startsWith('SELECT id::text AS id FROM client_objectives')) return state.currentObjective ? [{ id: state.scope.objectiveId }] : [];
      throw new Error(`Unexpected synthetic SQL: ${sql}`);
    },
    async $executeRaw(strings, ...values) {
      const sql = strings.join('?').replace(/\s+/g, ' ').trim();
      state.calls.push({ sql, values });
      assert.match(sql, /^UPDATE sp_version SET coalescible=false/);
      state.coalescible = false;
      return state.sealCount;
    },
  };
  return { tx, state };
}
const actualJob = x => ({ generationJobId: x.scope.generationJobId, generationRequestId: x.scope.generationRequestId });

test('custody records all four exact source inputs and declared dependency rewrites', t => {
  assert.equal(custody.length, 4);
  assert.deepEqual(custody.map(x => x.replacementSpecifiers.length), [0, 1, 0, 3]);
  t.diagnostic(JSON.stringify({ sourceCustody: custody }));
});

test('admission and all nested tokens are exact, immutable semantic values', () => {
  const x = fixture(), a = parseCanonicalGenerationAdmission(x.admission);
  assert.deepEqual(a, x.admission);
  assert.equal(Object.keys(a).length, 12); assert.equal(Object.keys(a.canonical).length, 12);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.canonical));
  x.admission.canonical.bindingVersion++;
  assert.equal(a.canonical.bindingVersion, 2);
});

test('closed admission rejects missing, unknown, symbol, accessor, exotic and proxy records', () => {
  const x = fixture();
  for (const key of Object.keys(x.admission)) {
    const a = copy(x.admission); delete a[key]; invalid(() => parseCanonicalGenerationAdmission(a));
  }
  invalid(() => parseCanonicalGenerationAdmission({ ...x.admission, extra: true }));
  invalid(() => parseCanonicalGenerationAdmission({ ...x.admission, [Symbol('extra')]: true }));
  const getter = copy(x.admission); Object.defineProperty(getter, 'consentId', { enumerable: true, get() { throw Error('must not invoke'); } });
  invalid(() => parseCanonicalGenerationAdmission(getter));
  invalid(() => parseCanonicalGenerationAdmission(Object.assign(Object.create({ extra: true }), x.admission)));
  invalid(() => parseCanonicalGenerationAdmission(new Proxy(x.admission, { ownKeys() { throw Error('must not invoke'); } })));
  const revocable = Proxy.revocable({}, {}); revocable.revoke(); invalid(() => parseCanonicalGenerationAdmission(revocable.proxy));
});

test('all UUID and digest fields refuse final newline and uppercase encodings', () => {
  const x = fixture();
  for (const key of ['actorUserId', 'consentId', 'generationJobId', 'generationRequestId', 'expectedStrategyVersionId']) {
    const a = copy(x.admission); a[key] = `${id(42)}\n`; invalid(() => parseCanonicalGenerationAdmission(a));
  }
  for (const key of Object.keys(x.canonical).filter(k => typeof x.canonical[k] === 'string')) {
    const c = copy(x.canonical); c[key] += '\n'; invalid(() => parseGenerationCanonicalToken(c));
  }
  invalid(() => generationUuid('ABCDEFAB-0000-4000-8000-000000000001'));
  invalid(() => generationSha256(hash('a') + '\n'));
  invalid(() => generationSha256(hash('A')));
});

test('admission rejects unsupported epochs, versions, durations and identity strings', () => {
  for (const [key, value] of [['schemaVersion', 2], ['namespace', 'other'], ['controlVersion', 0],
    ['controlVersion', 2147483648], ['clerkUserId', ''], ['clerkUserId', 'x'.repeat(129)], ['admittedAtMs', NaN],
    ['effectExpiresAtMs', Number.MAX_SAFE_INTEGER], ['effectExpiresAtMs', 1_000_000]]) {
    const a = fixture().admission; a[key] = value; invalid(() => parseCanonicalGenerationAdmission(a));
  }
  for (const [key, value] of [['epoch', 2], ['bindingVersion', 0], ['requestedObjectiveVersion', 2147483648]]) {
    const c = fixture().canonical; c[key] = value; invalid(() => parseGenerationCanonicalToken(c));
  }
});

test('RunBinding is closed, readonly, full-domain and has a deterministic actual issuer key', () => {
  const x = fixture(), b = parseAcceptedRunBinding(x.binding);
  assert.equal(Object.keys(b).length, 7); assert.ok(Object.isFrozen(b));
  assert.equal(generationBindingKey(b), app.applicationHash(b));
  for (const value of [0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    invalid(() => parseAcceptedRunBinding({ ...b, writerFence: value }));
  }
  assert.equal(parseAcceptedRunBinding({ ...b, writerFence: Number.MAX_SAFE_INTEGER }).writerFence, Number.MAX_SAFE_INTEGER);
  invalid(() => parseAcceptedRunBinding({ ...b, selected_outputs: [] }));
  for (const key of Object.keys(b).filter(k => !['writerFence','actorId'].includes(k)))
    invalid(() => parseAcceptedRunBinding({ ...b, [key]: b[key] + '\n' }));
  assert.equal(parseAcceptedRunBinding({ ...b, actorId: 'opaque:subject@example.test' }).actorId, 'opaque:subject@example.test');
  for (const actorId of ['', 'x'.repeat(129)]) invalid(() => parseAcceptedRunBinding({ ...b, actorId }));
});

test('actual whole facts/request/capability hashes remain separate from semantic admission SHA', () => {
  const x = fixture(), a = requireGenerationAcceptanceForAdmission(x.acceptance, x.admission);
  assert.notEqual(a.issuance.factsSha256, a.sourceAdmissionSha256);
  assert.notEqual(a.sourceRequestSha256, a.sourceAdmissionSha256);
  assert.deepEqual(a, x.acceptance);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.sourceBinding) && Object.isFrozen(a.issuance) && Object.isFrozen(a.issuance.binding));
  // This proves metadata coherence only, never that an issuer protected facts.
});

test('acceptance refuses every missing/unknown issuer field and internal binding/request/key mismatch', () => {
  for (const key of Object.keys(fixture().acceptance.issuance)) {
    const x = fixture(); delete x.acceptance.issuance[key]; invalid(() => parseCanonicalGenerationAcceptance(x.acceptance));
  }
  for (const mutate of [a => { a.issuance.other = true; }, a => { a.sourceBinding.runId = id(99); },
    a => { a.issuance.requestSha256 = hash('e'); }, a => { a.issuance.issuanceKey = hash('e'); },
    a => { a.issuance.factsSha256 += '\n'; }, a => { a.sourceAdmissionSha256 += '\n'; },
    a => { a.issuance.expiresAtMs = a.acceptedAtMs; }]) {
    const x = fixture(); mutate(x.acceptance); invalid(() => parseCanonicalGenerationAcceptance(x.acceptance));
  }
});

test('acceptance cannot expand the semantic deadline or switch tenant/native-Clerk lineage', () => {
  const conflict = x => assert.throws(() => requireGenerationAcceptanceForAdmission(x.acceptance, x.admission), e => e.code === 'REQUEST_CONFLICT');
  for (const mutate of [x => { x.acceptance.sourceAdmissionSha256 = hash('f'); },
    x => { x.acceptance.acceptedAtMs = x.admission.admittedAtMs - 1; },
    x => { x.acceptance.issuance.expiresAtMs = x.admission.effectExpiresAtMs + 1; },
    x => { x.acceptance.sourceBinding.tenantId = id(99); }, x => { x.acceptance.sourceBinding.actorId = 'user_other'; }]) {
    const x = fixture(); mutate(x);
    x.acceptance.issuance.binding = copy(x.acceptance.sourceBinding);
    x.acceptance.issuance.issuanceKey = generationBindingKey(x.acceptance.sourceBinding); conflict(x);
  }
  const boundary = fixture(); boundary.acceptance.issuance.expiresAtMs = boundary.admission.effectExpiresAtMs;
  assert.ok(requireGenerationAcceptanceForAdmission(boundary.acceptance, boundary.admission));
  const late = fixture(); late.acceptance.acceptedAtMs = late.admission.effectExpiresAtMs;
  late.acceptance.issuance.expiresAtMs = late.admission.effectExpiresAtMs + 1; conflict(late);
});

test('private ledger IDs are deterministic and separated by all three kinds and original identity', () => {
  const x = fixture(), kinds = [GENERATION_ADMISSION, GENERATION_ACCEPTANCE, GENERATION_PRODUCER];
  const ids = kinds.map(k => generationLedgerId(k, x.scope.tenantId, x.scope.clerkUserId, x.scope.generationJobId));
  assert.equal(new Set(ids).size, 3);
  assert.equal(ids[0], generationLedgerId(kinds[0], x.scope.tenantId, x.scope.clerkUserId, x.scope.generationJobId));
  assert.notEqual(ids[0], generationLedgerId(kinds[0], x.scope.tenantId, 'user_other', x.scope.generationJobId));
  assert.notEqual(ids[0], generationLedgerId(kinds[0], x.scope.tenantId, x.scope.clerkUserId, id(90)));
  for (const value of ids) assert.equal(generationUuid(value), value);
  invalid(() => generationLedgerId('arbitrary', x.scope.tenantId, x.scope.clerkUserId, x.scope.generationJobId));
});

test('real SQL admission derives native actor/current consent and clips to actual job deadline after locks', async () => {
  const x = fixture(), { tx, state } = database(x);
  const a = await admitCanonicalGenerationWithinTx(tx, x.scope);
  assert.deepEqual(a, x.admission);
  assert.notEqual(a.actorUserId, x.root.rootActorUserId); // renewed consent may have a different current consenting writer.
  const index = text => state.calls.findIndex(c => c.sql.includes(text));
  assert.ok(index('FROM sp_draft_job') < index('FROM sp_strategy'));
  assert.ok(index('FROM sp_strategy') < index('SELECT m.user_id'));
  assert.ok(index('FOR UPDATE OF ctl') < index('SELECT ceil('));
  assert.equal(state.calls.at(-1).sql.startsWith('SELECT ceil('), true);
  const consentSql = state.calls.find(c => c.sql.includes('FROM client_objective_work_controls')).sql;
  assert.match(consentSql, /ctl.work_action='objective.strategy.draft'/);
  assert.match(consentSql, /cs.id=ctl.current_consent_id/);
  assert.match(consentSql, /m.id=cs.consenting_membership_id/);
  assert.match(consentSql, /FOR UPDATE OF ctl$/);
});

test('existing latest Strategy head is derived and sealed before model admission', async () => {
  const x = fixture(), { tx, state } = database(x);
  state.exists = true; state.latest = id(40); state.coalescible = true;
  const a = await admitCanonicalGenerationWithinTx(tx, x.scope);
  assert.equal(a.expectedStrategyVersionId, id(40)); assert.equal(state.coalescible, false);
  const seal = state.calls.findIndex(c => c.sql.startsWith('UPDATE sp_version'));
  const source = state.calls.findIndex(c => c.sql.includes('SELECT m.user_id'));
  assert.ok(seal >= 0 && seal < source);
  assert.match(state.calls.find(c => c.sql.includes('ORDER BY created_at')).sql, /ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE/);
});

test('wrong actual job scope, status, request, fingerprint or absent deadline refuses admission', async () => {
  for (const mutate of [s => { s.job.ownerUserId = 'user_other'; }, s => { s.job.clientId = id(99); },
    s => { s.job.status = 'running'; }, s => { s.job.strategyId = id(5); }, s => { s.job.requestKey = 'posted'; },
    s => { s.job.attempt = 0; }, s => { s.job.attempt = 2; },
    s => { s.job.claimedBy = 'old_worker'; }, s => { s.job.claimedAt = 'old_claim'; },
    s => { s.job.input.objectiveGeneration.fingerprint = hash('a'); }, s => { s.job.deadlineMs = null; },
    s => { s.job.deadlineMs = String(s.nowMs); }, s => { s.job.input.objectiveGeneration.request.requestId = id(99); }]) {
    const x = fixture(), { tx, state } = database(x); mutate(state);
    await unavailable(() => admitCanonicalGenerationWithinTx(tx, x.scope));
  }
});

test('current Objective revision, full source snapshot, feature flag and canonical binding must remain exact', async () => {
  for (const mutate of [s => { s.currentVersion++; }, s => { s.revisionId = id(99); },
    s => { s.root.snapshot.status = 'draft'; }, s => { s.root.snapshot.extra = 'changed'; },
    s => { s.root.revisionActor = id(99); }, s => { s.feature = false; }, s => { s.root.ready = false; },
    s => { s.root.blocker = 'different'; }]) {
    const x = fixture(), { tx, state } = database(x); mutate(state);
    await stale(() => admitCanonicalGenerationWithinTx(tx, x.scope));
  }
  const x = fixture(), { tx } = database(x), actual = tx.$queryRaw;
  tx.$queryRaw = async function(strings, ...values) {
    const rows = await actual(strings, ...values);
    if (strings.join('?').includes('FROM client_objective_canonical_plans') && strings.join('?').includes('FOR UPDATE')) rows[0].bindingVersion++;
    return rows;
  };
  await stale(() => admitCanonicalGenerationWithinTx(tx, x.scope));
});

test('revoked membership, wall, cancelled/wrong-action consent and invalid policy fail closed', async () => {
  for (const mutate of [s => { s.actorHint = null; }, s => { s.cancelled = true; }, s => { s.action = 'objective.plan.prepare'; },
    s => { s.consent.actorUserId = id(99); }, s => { s.consent.currentMembershipId = id(99); },
    s => { s.consent.rootActorUserId = id(99); }, s => { s.consent.policyRevision = 2; },
    s => { s.consent.validExpiry = false; }, s => { s.consent.effective = '1800001'; s.consent.configured = '1800001'; },
    s => { s.consent.confirmedMs = String(s.nowMs + 1); }, s => { s.consent.expiresMs = String(s.nowMs); }]) {
    const x = fixture(), { tx, state } = database(x); mutate(state);
    await unavailable(() => admitCanonicalGenerationWithinTx(tx, x.scope));
  }
  for (const mutate of [s => { s.currentMember = false; }, s => { s.memoryWall = true; s.wallGrant = false; }]) {
    const x = fixture(), { tx, state } = database(x); mutate(state);
    await stale(() => admitCanonicalGenerationWithinTx(tx, x.scope));
  }
});

test('admission refuses absent, archived or cross-client existing Strategy version data', async () => {
  for (const mutate of [s => {}, s => { s.archived = true; }, s => { s.strategyClient = id(99); }]) {
    const x = fixture(), { tx, state } = database(x); state.exists = true; mutate(state);
    await unavailable(() => admitCanonicalGenerationWithinTx(tx, x.scope));
  }
});

test('before-write rechecks exact job, current actor/consent/control, sealed head and actual fresh expiry', async () => {
  const x = fixture(), { tx, state } = database(x); state.job.status = 'running'; state.nowMs++;
  assert.equal((await requireCanonicalGenerationEffectWithinTx(tx, x.admission, actualJob(x))).consentId, x.admission.consentId);
  for (const mutate of [s => { s.consent.consentId = id(99); }, s => { s.consent.controlVersion++; },
    s => { s.actorHint = id(99); }, s => { s.nowMs = s.admission.effectExpiresAtMs; },
    s => { s.job.deadlineMs = String(s.nowMs); }, s => { s.nowMs = s.admission.admittedAtMs - 1; }]) {
    const f = fixture(), d = database(f); d.state.job.status = 'running'; mutate(d.state);
    await unavailable(() => requireCanonicalGenerationEffectWithinTx(d.tx, f.admission, actualJob(f)));
  }
  await unavailable(() => requireCanonicalGenerationEffectWithinTx(tx, x.admission, { ...actualJob(x), generationJobId: id(99) }));
});

test('before-write never reseals a changed or coalescible head after model work', async () => {
  for (const coalescible of [false, true]) {
    const x = fixture(), { tx, state } = database(x); state.job.status = 'running';
    state.exists = true; state.latest = id(41); state.coalescible = coalescible;
    await stale(() => requireCanonicalGenerationEffectWithinTx(tx, x.admission, actualJob(x)));
    assert.equal(state.calls.some(c => c.sql.startsWith('UPDATE ')), false);
  }
});

function completedDatabase() {
  const x = fixture(), d = database(x); d.state.job.status = 'completed'; d.state.exists = true;
  d.state.latest = id(50); d.state.job.strategyId = x.canonical.canonicalStrategyId;
  d.state.job.input.objectiveGeneration.receipt = { result: { strategyId: x.canonical.canonicalStrategyId, strategyVersionId: id(50) } };
  return { x, ...d };
}
test('after-write derives the saved Meri version from the actual completed job receipt', async () => {
  const { x, tx, state } = completedDatabase();
  const result = await requireCanonicalGenerationEffectWithinTx(tx, x.admission, actualJob(x), 'after-write');
  assert.equal(result.actorUserId, x.admission.actorUserId);
  assert.ok(state.calls.some(c => c.sql.startsWith('SELECT snapshot,author_kind')));
  assert.equal(state.calls.some(c => c.sql.startsWith('UPDATE ')), false);
});

test('after-write rejects caller/model pointers, unsaved/manual/coalescible or foreign snapshots', async () => {
  for (const mutate of [s => { delete s.job.input.objectiveGeneration.receipt; },
    s => { s.job.input.objectiveGeneration.receipt.result.strategyVersionId = id(99); },
    s => { s.job.strategyId = id(99); }, s => { s.saved.authorKind = 'user'; },
    s => { s.saved.coalescible = true; }, s => { s.saved.snapshot.meta.clientId = id(99); },
    s => { s.saved.snapshot.meta.id = id(99); }]) {
    const { x, tx, state } = completedDatabase(); mutate(state);
    await unavailable(() => requireCanonicalGenerationEffectWithinTx(tx, x.admission, actualJob(x), 'after-write'));
  }
});

test('historical read ignores expired historical consent/source but checks current actor/scope/wall', async () => {
  const x = fixture(), { tx, state } = database(x);
  state.nowMs = x.admission.effectExpiresAtMs + 999999; state.currentVersion++;
  state.cancelled = true; state.job.status = 'failed';
  await requireCanonicalGenerationReadWithinTx(tx, x.admission, x.scope.clerkUserId);
  assert.equal(state.calls.some(c => /sp_draft_job|work_controls|clock_timestamp|sp_version/.test(c.sql)), false);
  assert.equal(state.calls.some(c => c.sql.startsWith('UPDATE ')), false);
  await unavailable(() => requireCanonicalGenerationReadWithinTx(tx, x.admission, 'user_other'));
  for (const mutate of [s => { s.currentMember = false; }, s => { s.feature = false; },
    s => { s.currentObjective = false; }, s => { s.memoryWall = true; s.wallGrant = false; }]) {
    const f = fixture(), d = database(f); mutate(d.state);
    await unavailable(() => requireCanonicalGenerationReadWithinTx(d.tx, f.admission, f.scope.clerkUserId));
  }
});
