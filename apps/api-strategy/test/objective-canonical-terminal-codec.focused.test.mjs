// Actual Core codec and pure dependencies over synthetic retained-reader data.
// No SDK, genuine Meri custody, candidate semantic validator, public questions,
// current authority, framework or database qualification is claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

const custody = [];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const data = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
async function sourceModule(relative, replacements = []) {
  const path = new URL(relative, import.meta.url), raw = await readFile(path, 'utf8');
  let source = raw;
  for (const [from, to] of replacements) {
    assert.equal(source.split(from).length, 2, `one declared import rewrite: ${from}`);
    source = source.replace(from, JSON.stringify(to));
  }
  const transformed = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: path.href });
  custody.push({ path: relative, sha256: sha(raw), transformedSha256: sha(transformed),
    replacementSpecifiers: replacements.map(([from]) => from) });
  return data(transformed);
}
const appUrl = await sourceModule('../src/planner/objective-canonical-application.ts');
const generationUrl = await sourceModule('../src/meri/objective-canonical-generation.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl],
]);
const requestUrl = await sourceModule('../src/meri/objective-canonical-request.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl],
  ["'./objective-canonical-generation.js'", generationUrl],
]);
const codecUrl = await sourceModule('../src/meri/objective-canonical-completion-receipt.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl],
  ["'./objective-canonical-generation.js'", generationUrl],
  ["'./objective-canonical-request.js'", requestUrl],
]);
const { applicationHash, CanonicalApplicationError } = await import(appUrl);
const { canonicalGenerationAdmissionSha256 } = await import(generationUrl);
const { createCanonicalRequestPublication, candidateJcsSha256: jcs } = await import(requestUrl);
const { verifyRetainedCanonicalCompletion: success, verifyRetainedCanonicalNonSuccess: verify,
  checkStoredCanonicalNonSuccess: checkStored, checkCanonicalCompletionWitness: checkWitness } = await import(codecUrl);
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const hex = value => value.repeat(64);
const copy = value => structuredClone(value);
const json = value => JSON.parse(JSON.stringify(value));
function refuse(run, code) {
  assert.throws(run, error => error instanceof CanonicalApplicationError && (code === undefined || error.code === code));
}

function fixture(state = 'needs-information') {
  const source = { clientId: id(3), objectiveId: id(4), objectiveVersion: 2, objectiveRevisionId: id(8) };
  const intent = { outcome: 'Synthetic outcome', governmentProblem: 'Synthetic problem', askType: 'both',
    minimumWin: 'Synthetic minimum', limits: '' };
  const admission = { schemaVersion: 1, namespace: 'capiro.objective-strategy.admission:v1',
    canonical: { canonicalPlanId: id(1), tenantId: id(2), clientId: id(3), objectiveId: id(4),
      canonicalStrategyId: id(5), canonicalProjectId: id(6), bindingVersion: 2, epoch: 1,
      requestedIntentId: id(7), requestedObjectiveRevisionId: id(8), requestedObjectiveVersion: 2, snapshotHash: hex('a') },
    actorUserId: id(9), clerkUserId: 'trusted_clerk_fixture', consentId: id(12), controlVersion: 3,
    generationJobId: id(10), generationRequestId: id(11), admittedAtMs: 1_000_000,
    effectExpiresAtMs: 3_000_000, expectedStrategyVersionId: null };
  const prompt = 'Literal synthetic original prompt\n';
  const publication = createCanonicalRequestPublication({ admission,
    dto: { clientId: id(3), type: 'authorization', goal: 'Original input', meriContext: null,
      ownerUserId: null, targetDate: null, attachmentIds: [] },
    context: { schemaVersion: 1, tenantId: id(2), clerkUserId: admission.clerkUserId, requestId: id(11), source, intent,
      snapshotSha256: admission.canonical.snapshotHash, sourceDigest: applicationHash({ source, intent }), packetId: id(20),
      compiledAt: new Date(1_005_000).toISOString(), coverageDigest: hex('b'), promptSha256: sha(prompt), evidence: [] },
    prompt, owners: [{ ownerRef: 'owner:fixture', clerkUserId: admission.clerkUserId }],
    delegation: { ref: id(30), revision: 'source-delegation:1', issuedAtMs: 999_000, absoluteExpiresAtMs: 4_000_000 },
    requestedAtMs: 1_010_000, effectExpiresAtMs: 2_000_000 });
  const binding = { tenantId: id(2), actorId: admission.clerkUserId, conversationId: id(40), runId: id(41),
    attemptId: id(42), workerId: id(43), writerFence: 1 };
  const sourceRequestSha256 = hex('c');
  const acceptance = { schemaVersion: 1, sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission),
    sourceBinding: binding, sourceRequestSha256, acceptedAtMs: 1_020_000,
    issuance: { issuanceKey: applicationHash(binding), binding, requestSha256: sourceRequestSha256,
      expiresAtMs: 1_800_000, grantId: id(44), capabilitySha256: hex('d'), factsSha256: hex('e') } };
  const h = jcs({ binding, kind: 'completion' });
  const completionId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  const execution = { provider: 'synthetic-provider', model: 'synthetic-model', receiptRef: completionId,
    receiptSha256: hex('f'), bindingSha256: jcs(binding) };
  const payload = state === 'succeeded' ? { type: 'authorization', rationale: 'Exact rationale', summary: 'Exact summary',
    nodes: [{ sourceNodeKey: 'prepare', kind: 'action', subject: 'deliverable', title: 'Exact title', note: null,
      status: 'suggested', ownerRef: null, startsOn: '2028-02-29', endsOn: null, openEnded: false, sources: [], dependsOn: [] }],
    coverage: { complete: true, omitted: [], assumptions: [], sources: [], pendingSources: [] } } : null;
  const result = { candidateVersion: publication.request.candidateVersion, operation: 'strategy.draft',
    requestId: admission.generationRequestId, jobId: admission.generationJobId, requestSha256: publication.requestSha256,
    inputSha256: publication.request.inputSha256, sourceSha256: jcs(publication.request.source),
    contextSha256: publication.request.context.contextSha256, basisSha256: null, binding: copy(binding), execution: copy(execution),
    resultRef: completionId, completedAtMs: 1_030_000, state, payload, payloadSha256: jcs(payload),
    issues: state === 'succeeded' ? [] : [{ code: 'synthetic-input-required', message: 'Private synthetic issue text' }], resultSha256: '' };
  const raw = { schemaVersion: 1, generationJobId: admission.generationJobId, binding: copy(binding),
    sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission), sourceRequestSha256, typedRequestSha256: publication.requestSha256,
    completionId, checkpointId: id(50), checkpointSha256: hex('1'), resultRef: completionId, resultSha256: '',
    file: { path: 'meri-objective-strategy-draft.result.json', object: { objectId: 'opaque-original-object',
      versionId: 'immutable-original-version', sha256: '', bytes: 1, scopes: ['synthetic-owner-scope'] } }, rawFileSha256: '',
    execution: copy(execution), result, checkedAtMs: 1_040_000, expiresAtMs: 1_050_000 };
  const f = { admission, acceptance, publication, raw, nowMs: 1_040_001 };
  reseal(f);return f;
}
function reseal(f) {
  const r = f.raw.result, { resultSha256: _discard, ...body } = r;
  r.resultSha256 = jcs(body);f.raw.resultSha256 = r.resultSha256;
  const bytes = Buffer.from(JSON.stringify(r), 'utf8');
  f.raw.rawFileSha256 = sha(bytes);f.raw.file.object.sha256 = f.raw.rawFileSha256;f.raw.file.object.bytes = bytes.length;
}
const expected = f => ({ admission: f.admission, acceptance: f.acceptance, publication: f.publication });
const options = f => ({ ...expected(f), nowMs: f.nowMs });
const nonSuccess = f => verify(f.raw, options(f));

test('actual codec custody contains four exact source modules and declared import rewrites only', t => {
  assert.equal(custody.length, 4);assert.deepEqual(custody.map(value => value.replacementSpecifiers.length), [0, 1, 2, 3]);
  t.diagnostic(JSON.stringify({ sourceCustody: custody, qualification: 'synthetic-retained-owner-consistency-only' }));
});

test('both typed non-success states retain the original 17-field observation privately and frozen', () => {
  for (const state of ['needs-information', 'refused']) {
    const f = fixture(state), original = copy(f.raw), value = nonSuccess(f);
    assert.deepEqual(Object.keys(value), ['outcome', 'evidence', 'checkedAtMs', 'expiresAtMs']);
    assert.equal(value.outcome, state);assert.equal(value.evidence.kind, 'typed-result');
    assert.equal(value.evidence.outcome, state);assert.equal(Object.keys(value.evidence.retained).length, 17);
    assert.deepEqual(json(value.evidence.retained), original);assert.deepEqual(f.raw, original);
    assert.equal(value.checkedAtMs, f.raw.checkedAtMs);assert.equal(value.expiresAtMs, f.raw.expiresAtMs);
    assert.equal(Object.hasOwn(value, 'payload'), false);assert.equal(Object.hasOwn(value, 'issues'), false);
    assert.equal(Object.isFrozen(value.evidence.retained.result.issues[0]), true);
    assert.equal(Object.isFrozen(value.evidence.witness), true);
    assert.ok(Buffer.byteLength(JSON.stringify(value.evidence)) <= 2_097_152);
  }
});

test('new accounting API refuses success and generic failed/cancelled/running/unknown run labels', () => {
  for (const state of ['succeeded', 'failed', 'cancelled', 'running', 'unknown']) {
    const f = fixture(state);refuse(() => nonSuccess(f), 'OUTCOME_UNCONFIRMED');
  }
});

test('existing success API still refuses both typed non-success states', () => {
  for (const state of ['needs-information', 'refused']) {
    const f = fixture(state);refuse(() => success(f.raw, options(f)), 'OUTCOME_UNCONFIRMED');
  }
});

test('known non-success structure requires null payload and nonempty closed code/message issues', () => {
  for (const mutate of [f => { f.raw.result.payload = { type: 'authorization' };f.raw.result.payloadSha256 = jcs(f.raw.result.payload); },
    f => { f.raw.result.issues = []; }, f => { f.raw.result.issues = null; },
    f => { f.raw.result.issues[0].extra = 'unallocated-question-field'; },
    f => { f.raw.result.issues[0].code = 1; }, f => { f.raw.result.issues[0].message = null; },
    f => { f.raw.result.issues[0].message = ' '; }]) {
    const f = fixture();mutate(f);reseal(f);refuse(() => nonSuccess(f));
  }
});

test('retained work identities and every accepted run-binding identity are checked before accounting', () => {
  for (const field of ['generationJobId', 'sourceAdmissionSha256', 'sourceRequestSha256', 'typedRequestSha256', 'completionId', 'resultRef']) {
    const f = fixture();f.raw[field] = field.endsWith('Sha256') ? hex('9') : id(99);
    refuse(() => nonSuccess(f), 'REQUEST_CONFLICT');
  }
  for (const field of ['tenantId', 'actorId', 'runId', 'attemptId', 'workerId', 'writerFence']) {
    const f = fixture();f.raw.binding[field] = field === 'writerFence' ? 2 : field === 'actorId' ? 'other-actor' : id(99);
    refuse(() => nonSuccess(f), 'REQUEST_CONFLICT');
  }
});

test('coherent rehashing cannot replace typed request, source/context, original input or result binding', () => {
  for (const field of ['requestId', 'jobId', 'requestSha256', 'inputSha256', 'sourceSha256', 'contextSha256', 'basisSha256']) {
    const f = fixture();f.raw.result[field] = field.endsWith('Sha256') ? hex('9') : id(99);reseal(f);
    refuse(() => nonSuccess(f), 'REQUEST_CONFLICT');
  }
  const f = fixture();f.raw.result.binding.attemptId = id(99);reseal(f);
  refuse(() => nonSuccess(f), 'REQUEST_CONFLICT');
});

test('execution receipt and original completion identity cannot be replaced or omitted', () => {
  for (const mutate of [f => { f.raw.execution = null; }, f => { f.raw.result.execution = null; },
    f => { f.raw.execution.receiptRef = id(99);f.raw.result.execution.receiptRef = id(99); },
    f => { f.raw.result.execution.model = 'different-model'; },
    f => { f.raw.execution.bindingSha256 = hex('9');f.raw.result.execution.bindingSha256 = hex('9'); }]) {
    const f = fixture();mutate(f);reseal(f);refuse(() => nonSuccess(f));
  }
});

test('semantic result SHA, null-payload SHA and raw immutable file SHA remain separate checked domains', () => {
  const f = fixture();assert.notEqual(f.raw.resultSha256, f.raw.rawFileSha256);
  f.raw.result.payloadSha256 = hex('9');reseal(f);refuse(() => nonSuccess(f), 'REQUEST_CONFLICT');
  const g = fixture();g.raw.result.resultSha256 = jcs(g.raw.result);g.raw.resultSha256 = g.raw.result.resultSha256;
  refuse(() => nonSuccess(g), 'REQUEST_CONFLICT');
  const h = fixture();h.raw.rawFileSha256 = h.raw.resultSha256;h.raw.file.object.sha256 = h.raw.rawFileSha256;
  refuse(() => nonSuccess(h), 'REQUEST_CONFLICT');
});

test('raw typed file must keep original fixed path, version, byte count and exact representation', () => {
  for (const mutate of [f => { f.raw.file.path = '../caller.json'; }, f => { f.raw.file.object.versionId = null; },
    f => { f.raw.file.object.versionId = 'null'; }, f => { f.raw.file.object.bytes++; },
    f => { f.raw.file.object.sha256 = hex('9'); }, f => { f.raw.file.object.bytes = 2_097_153; }]) {
    const f = fixture();mutate(f);refuse(() => nonSuccess(f));
  }
});

test('fresh accounting refuses future, expired or impossible original reader observations', () => {
  for (const mutate of [f => { f.raw.checkedAtMs = f.nowMs + 1; }, f => { f.raw.expiresAtMs = f.nowMs; },
    f => { f.raw.checkedAtMs = f.raw.expiresAtMs; }]) {
    const f = fixture();mutate(f);refuse(() => nonSuccess(f), 'AUTHORITY_UNAVAILABLE');
  }
});

test('original completion must remain inside original admission/request/issuance window and no later than observation', () => {
  for (const value of [999_999, 1_009_999, 1_019_999, 1_800_000, 2_000_000, 3_000_000]) {
    const f = fixture();f.raw.result.completedAtMs = value;reseal(f);refuse(() => nonSuccess(f), 'SOURCE_STALE');
  }
  const f = fixture();f.raw.result.completedAtMs = f.raw.checkedAtMs + 1;reseal(f);
  refuse(() => nonSuccess(f), 'OUTCOME_UNCONFIRMED');
});

test('fresh read after original effect expiry preserves the original timely typed terminal result', () => {
  const f = fixture();f.raw.checkedAtMs = 5_000_000;f.raw.expiresAtMs = 5_000_100;f.nowMs = 5_000_001;
  const value = nonSuccess(f);assert.equal(value.evidence.witness.completedAtMs, 1_030_000);
  assert.equal(value.checkedAtMs, 5_000_000);assert.equal(value.expiresAtMs, 5_000_100);
});

test('stored reconstruction accepts expired original read/issuance without inventing any timestamp or locator', () => {
  const f = fixture(), original = nonSuccess(f).evidence;
  const stored = checkStored(original, expected(f));
  assert.deepEqual(json(stored), json(original));
  assert.equal(stored.retained.checkedAtMs, f.raw.checkedAtMs);assert.equal(stored.retained.expiresAtMs, f.raw.expiresAtMs);
  assert.equal(stored.witness.completedAtMs, f.raw.result.completedAtMs);
  assert.equal(stored.witness.resultRef, f.raw.resultRef);
  f.nowMs = 5_000_000;refuse(() => nonSuccess(f), 'AUTHORITY_UNAVAILABLE');
  assert.deepEqual(json(checkStored(original, expected(f))), json(original));
});

test('stored reconstruction still enforces completed<=observed<original-read-expiry', () => {
  const f = fixture(), evidence = json(nonSuccess(f).evidence);
  evidence.retained.checkedAtMs = evidence.retained.result.completedAtMs - 1;
  refuse(() => checkStored(evidence, expected(f)), 'OUTCOME_UNCONFIRMED');
  const g = fixture(), bad = json(nonSuccess(g).evidence);bad.retained.checkedAtMs = bad.retained.expiresAtMs;
  refuse(() => checkStored(bad, expected(g)), 'AUTHORITY_UNAVAILABLE');
});

test('stored declared outcome and every immutable witness field must match reverified original retained bytes', () => {
  const f = fixture(), evidence = nonSuccess(f).evidence;
  const changedOutcome = json(evidence);changedOutcome.outcome = 'refused';
  refuse(() => checkStored(changedOutcome, expected(f)), 'REQUEST_CONFLICT');
  for (const key of ['resultSha256', 'rawFileSha256', 'executionSha256', 'payloadSha256', 'corePayloadSha256', 'checkpointSha256']) {
    const changed = json(evidence);changed.witness[key] = hex('9');
    refuse(() => checkStored(changed, expected(f)), 'REQUEST_CONFLICT');
  }
  const changed = json(evidence);changed.witness.resultRef = id(99);
  refuse(() => checkStored(changed, expected(f)), 'REQUEST_CONFLICT');
});

test('stored original raw/result hashes are rechecked rather than trusting a private state label', () => {
  const f = fixture(), evidence = json(nonSuccess(f).evidence);
  evidence.retained.result.issues[0].message = 'Changed after retention';
  refuse(() => checkStored(evidence, expected(f)), 'REQUEST_CONFLICT');
  const g = fixture(), bad = json(nonSuccess(g).evidence);bad.kind = 'generic-run';
  refuse(() => checkStored(bad, expected(g)), 'INPUT_INVALID');
});

test('closed evidence/read/result/witness records refuse any public projection or extra field', () => {
  const f = fixture(), evidence = nonSuccess(f).evidence;
  for (const where of ['evidence', 'retained', 'result', 'witness']) {
    const bad = json(evidence), target = where === 'evidence' ? bad : where === 'retained' ? bad.retained
      : where === 'result' ? bad.retained.result : bad.witness;
    target.extra = true;refuse(() => checkStored(bad, expected(f)));
  }
  refuse(() => checkStored({ ...json(evidence), checkedAtMs: f.nowMs }, expected(f)), 'INPUT_INVALID');
});

test('getters, proxies, custom JSON, sparse arrays, cycles and invalid numeric/Unicode values never execute', () => {
  let invoked = 0;
  const f = fixture();Object.defineProperty(f.raw, 'result', { enumerable: true,
    get() { invoked++;throw Error('getter must not run'); } });
  refuse(() => nonSuccess(f));
  const g = fixture();g.raw.result.issues = new Proxy([], { ownKeys() { invoked++;throw Error('proxy must not run'); } });
  refuse(() => nonSuccess(g));
  for (const value of [new Array(2), { toJSON() { invoked++;throw Error('toJSON must not run'); } },
    { invalid: NaN }, { invalid: 0.5 }, { invalid: '\ud800' }]) {
    const h = fixture();h.raw.result.issues = value;refuse(() => nonSuccess(h));
  }
  const h = fixture();h.raw.result.issues.push(h.raw);refuse(() => nonSuccess(h));
  const storedFixture = fixture(), evidence = json(nonSuccess(storedFixture).evidence);
  Object.defineProperty(evidence, 'retained', { enumerable: true, get() { invoked++;throw Error('stored getter'); } });
  refuse(() => checkStored(evidence, expected(storedFixture)));
  assert.equal(invoked, 0);
});

test('oversized private terminal data refuses without slicing provider text or issues', () => {
  const f = fixture();f.raw.result.issues[0].message = 'x'.repeat(2_097_153);
  refuse(() => nonSuccess(f), 'INPUT_INVALID');
  const g = fixture(), evidence = json(nonSuccess(g).evidence);evidence.retained.result.issues[0].message = 'x'.repeat(2_097_153);
  refuse(() => checkStored(evidence, expected(g)), 'INPUT_INVALID');
});

test('non-success private witness hashes null payload and retains all original execution/checkpoint pin domains', () => {
  const f = fixture(), value = nonSuccess(f), witness = value.evidence.witness;
  assert.equal(witness.payloadSha256, jcs(null));assert.equal(witness.corePayloadSha256, applicationHash(null));
  assert.equal(witness.sourceBindingSha256, jcs(f.acceptance.sourceBinding));
  assert.equal(witness.executionContextSha256, jcs(f.publication.executionContext));
  assert.equal(witness.executionSha256, jcs(f.raw.execution));
  assert.equal(witness.checkpointId, f.raw.checkpointId);assert.equal(witness.checkpointSha256, f.raw.checkpointSha256);
  assert.deepEqual(checkWitness(witness, expected(f)), witness);
});

test('initial candidate remains closed to private regeneration or an existing Strategy basis', () => {
  for (const mutate of [f => { f.admission.expectedStrategyVersionId = id(99); },
    f => { f.publication = copy(f.publication);f.publication.request.requestVersion = 'private-regeneration'; },
    f => { f.publication = copy(f.publication);f.publication.request.basis = {}; }]) {
    const f = fixture();mutate(f);refuse(() => nonSuccess(f), 'AUTHORITY_UNAVAILABLE');
  }
});

test('existing success API and witness retain their exact original field order and hash values', () => {
  const f = fixture('succeeded'), value = success(f.raw, options(f));
  const expectedWitness = { schemaVersion: 1, namespace: 'capiro.objective-strategy.completion:v1',
    generationJobId: f.admission.generationJobId, generationRequestId: f.admission.generationRequestId,
    sourceAdmissionSha256: canonicalGenerationAdmissionSha256(f.admission), sourceRequestSha256: f.acceptance.sourceRequestSha256,
    sourceBindingSha256: jcs(f.acceptance.sourceBinding), typedRequestSha256: f.publication.requestSha256,
    executionContextSha256: jcs(f.publication.executionContext), completionId: f.raw.completionId,
    checkpointId: f.raw.checkpointId, checkpointSha256: f.raw.checkpointSha256, resultRef: f.raw.resultRef,
    resultSha256: f.raw.result.resultSha256, rawFileSha256: f.raw.rawFileSha256, executionSha256: jcs(f.raw.execution),
    completedAtMs: f.raw.result.completedAtMs, payloadSha256: f.raw.result.payloadSha256, corePayloadSha256: applicationHash(f.raw.result.payload) };
  assert.deepEqual(Object.keys(value), ['payload', 'witness', 'checkedAtMs', 'expiresAtMs']);
  assert.equal(JSON.stringify(value.witness), JSON.stringify(expectedWitness));
  assert.equal(Object.hasOwn(value, 'evidence'), false);assert.equal(Object.hasOwn(value, 'outcome'), false);
  assert.deepEqual(json(value.payload), f.raw.result.payload);assert.equal(Object.isFrozen(value.witness), true);
});
