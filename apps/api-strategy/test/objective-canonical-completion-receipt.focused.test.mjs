// Actual Core codec + pure dependencies over synthetic retained-owner data.
// No SDK execution, Meri custody/authority, HTTP, DB or model proof is claimed.
// Root owns execution admission; this file may be authored without running it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

const custody = [];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
async function sourceModule(relative, replacements = []) {
  const url = new URL(relative, import.meta.url), original = await readFile(url, 'utf8');
  let source = original;
  for (const [from, to] of replacements) {
    const pieces = source.split(from); assert.equal(pieces.length, 2, `one declared source dependency: ${from}`);
    source = pieces.join(JSON.stringify(to));
  }
  const stripped = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: url.href });
  custody.push({ path: relative, rawSha256: digest(original), transformedSha256: digest(stripped),
    replacementSpecifiers: replacements.map(([from]) => from) });
  return dataModule(stripped);
}
const applicationUrl = await sourceModule('../src/planner/objective-canonical-application.ts');
const generationUrl = await sourceModule('../src/meri/objective-canonical-generation.ts', [
  ["'../planner/objective-canonical-application.js'", applicationUrl],
]);
const requestUrl = await sourceModule('../src/meri/objective-canonical-request.ts', [
  ["'../planner/objective-canonical-application.js'", applicationUrl], ["'./objective-canonical-generation.js'", generationUrl],
]);
const completionUrl = await sourceModule('../src/meri/objective-canonical-completion-receipt.ts', [
  ["'../planner/objective-canonical-application.js'", applicationUrl], ["'./objective-canonical-generation.js'", generationUrl],
  ["'./objective-canonical-request.js'", requestUrl],
]);
const { applicationHash, CanonicalApplicationError } = await import(applicationUrl);
const { canonicalGenerationAdmissionSha256 } = await import(generationUrl);
const { createCanonicalRequestPublication, candidateJcsSha256: jcs } = await import(requestUrl);
const { verifyRetainedCanonicalCompletion: verify, checkCanonicalCompletionWitness: checkWitness } = await import(completionUrl);
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const hex = char => char.repeat(64);
const copy = value => structuredClone(value);
const refusal = (run, code) => assert.throws(run, error => error instanceof CanonicalApplicationError &&
  (code === undefined || error.code === code));

function fixture() {
  const source = { clientId: id(3), objectiveId: id(4), objectiveVersion: 2, objectiveRevisionId: id(8) };
  const intent = { outcome: 'Source outcome', governmentProblem: 'Source problem', askType: 'both', minimumWin: 'Source minimum', limits: '' };
  const admission = { schemaVersion: 1, namespace: 'capiro.objective-strategy.admission:v1',
    canonical: { canonicalPlanId: id(1), tenantId: id(2), clientId: id(3), objectiveId: id(4),
      canonicalStrategyId: id(5), canonicalProjectId: id(6), bindingVersion: 2, epoch: 1,
      requestedIntentId: id(7), requestedObjectiveRevisionId: id(8), requestedObjectiveVersion: 2, snapshotHash: hex('a') },
    actorUserId: id(9), clerkUserId: 'trusted_clerk_fixture', consentId: id(12), controlVersion: 3,
    generationJobId: id(10), generationRequestId: id(11), admittedAtMs: 1_000_000,
    effectExpiresAtMs: 3_000_000, expectedStrategyVersionId: null };
  const prompt = 'Literal original governed prompt\n';
  const publication = createCanonicalRequestPublication({ admission,
    dto: { clientId: id(3), type: 'authorization', goal: 'Original input', meriContext: null,
      ownerUserId: null, targetDate: null, attachmentIds: [] },
    context: { schemaVersion: 1, tenantId: id(2), clerkUserId: admission.clerkUserId, requestId: id(11), source, intent,
      snapshotSha256: admission.canonical.snapshotHash, sourceDigest: applicationHash({ source, intent }), packetId: id(20),
      compiledAt: new Date(1_005_000).toISOString(), coverageDigest: hex('b'), promptSha256: digest(prompt), evidence: [] },
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
  // receiptSha256 is intentionally an opaque genuine-owner observation here.
  // The fixture never fabricates an SDK sessionId or a fake successful SDK call.
  const execution = { provider: 'trusted-provider-fixture', model: 'trusted-model-fixture',
    receiptRef: completionId, receiptSha256: hex('f'), bindingSha256: jcs(binding) };
  const payload = { type: 'authorization', rationale: 'Exact rationale', summary: 'Exact summary',
    nodes: [{ sourceNodeKey: 'prepare', kind: 'action', subject: 'deliverable', title: 'Exact title',
      note: null, status: 'suggested', ownerRef: null, startsOn: '2028-02-29', endsOn: null,
      openEnded: false, sources: [], dependsOn: [] }],
    coverage: { complete: true, omitted: [], assumptions: [], sources: [], pendingSources: [] } };
  const result = { candidateVersion: publication.request.candidateVersion, operation: 'strategy.draft',
    requestId: admission.generationRequestId, jobId: admission.generationJobId, requestSha256: publication.requestSha256,
    inputSha256: publication.request.inputSha256, sourceSha256: jcs(publication.request.source),
    contextSha256: publication.request.context.contextSha256, basisSha256: null, binding: copy(binding), execution: copy(execution),
    resultRef: completionId, completedAtMs: 1_030_000, state: 'succeeded', payload, payloadSha256: jcs(payload), issues: [], resultSha256: '' };
  const raw = { schemaVersion: 1, generationJobId: admission.generationJobId, binding: copy(binding),
    sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission), sourceRequestSha256, typedRequestSha256: publication.requestSha256,
    completionId, checkpointId: id(50), checkpointSha256: hex('1'), resultRef: completionId, resultSha256: '',
    file: { path: 'meri-objective-strategy-draft.result.json', object: { objectId: 'opaque-object-ref',
      versionId: 'immutable-version-ref', sha256: '', bytes: 1, scopes: ['owner-fixture-scope'] } }, rawFileSha256: '',
    execution: copy(execution), result, checkedAtMs: 1_040_000, expiresAtMs: 1_050_000 };
  const f = { admission, acceptance, publication, raw, nowMs: 1_040_001 };
  reseal(f); return f;
}
function reseal(f) {
  const r = f.raw.result, { resultSha256: _discard, ...body } = r;
  r.resultSha256 = jcs(body); f.raw.resultSha256 = r.resultSha256;
  const bytes = Buffer.from(JSON.stringify(r), 'utf8');
  f.raw.rawFileSha256 = digest(bytes); f.raw.file.object.sha256 = f.raw.rawFileSha256;
  f.raw.file.object.bytes = bytes.length;
}
const options = f => ({ admission: f.admission, acceptance: f.acceptance, publication: f.publication, nowMs: f.nowMs });
const historical = f => ({ admission: f.admission, acceptance: f.acceptance, publication: f.publication });

test('dependency custody names four exact source modules without behavior rewrites', t => {
  assert.equal(custody.length, 4); assert.deepEqual(custody.map(c => c.replacementSpecifiers.length), [0, 1, 2, 3]);
  t.diagnostic(JSON.stringify({ sourceCustody: custody }));
});
test('genuine-owner projection consistency produces an immutable private witness and literal payload', () => {
  const f = fixture(), before = copy(f.raw), value = verify(f.raw, options(f));
  assert.deepEqual(f.raw, before); assert.deepEqual(JSON.parse(JSON.stringify(value.payload)), f.raw.result.payload);
  assert.equal(value.witness.sourceBindingSha256, jcs(f.acceptance.sourceBinding));
  assert.equal(value.witness.corePayloadSha256, applicationHash(f.raw.result.payload));
  assert.equal(value.witness.payloadSha256, jcs(f.raw.result.payload));
  assert.equal(value.witness.executionContextSha256, jcs(f.publication.executionContext));
  assert.notEqual(value.witness.executionContextSha256, f.raw.result.contextSha256);
  assert.deepEqual(checkWitness(value.witness, historical(f)), value.witness);
  assert.equal(Object.isFrozen(value), true); assert.equal(Object.isFrozen(value.payload.nodes[0]), true);
  assert.equal(Object.isFrozen(value.witness), true);
  assert.equal(Object.hasOwn(value.witness, 'checkedAtMs'), false); assert.equal(Object.hasOwn(value.witness, 'expiresAtMs'), false);
  assert.equal(Object.hasOwn(value.witness, 'file'), false); assert.equal(Object.hasOwn(value.witness, 'binding'), false);
});
test('fresh retained reading after original effect expiry preserves only the original timely completion', () => {
  const f = fixture(); f.raw.checkedAtMs = 5_000_000; f.raw.expiresAtMs = 5_000_100; f.nowMs = 5_000_001;
  assert.equal(verify(f.raw, options(f)).witness.completedAtMs, 1_030_000);
});
test('per-read freshness cannot change the immutable completion witness', () => {
  const f = fixture(), first = verify(f.raw, options(f)).witness;
  f.raw.checkedAtMs += 100; f.raw.expiresAtMs += 100; f.nowMs += 100;
  assert.deepEqual(verify(f.raw, options(f)).witness, first);
});
for (const field of ['generationJobId', 'sourceAdmissionSha256', 'sourceRequestSha256', 'typedRequestSha256', 'completionId', 'resultRef']) {
  test(`outer ${field} cannot substitute another original work identity`, () => {
    const f = fixture(); f.raw[field] = field.endsWith('Sha256') ? hex('9') : id(99);
    refusal(() => verify(f.raw, options(f)), 'REQUEST_CONFLICT');
  });
}
for (const field of ['runId', 'attemptId', 'workerId', 'writerFence', 'actorId', 'tenantId']) {
  test(`retained binding ${field} must equal the accepted original`, () => {
    const f = fixture(); f.raw.binding[field] = field === 'writerFence' ? 2 : field === 'actorId' ? 'other-subject' : id(99);
    refusal(() => verify(f.raw, options(f)), 'REQUEST_CONFLICT');
  });
}
for (const field of ['requestId', 'jobId', 'requestSha256', 'inputSha256', 'sourceSha256', 'contextSha256', 'basisSha256']) {
  test(`self-consistent result hashing cannot replace original result ${field}`, () => {
    const f = fixture(); f.raw.result[field] = field.endsWith('Sha256') ? hex('9') : id(99); reseal(f);
    refusal(() => verify(f.raw, options(f)), 'REQUEST_CONFLICT');
  });
}
test('candidate context packet SHA cannot be replaced by execution-context sidecar SHA', () => {
  const f = fixture(); f.raw.result.contextSha256 = jcs(f.publication.executionContext); reseal(f);
  refusal(() => verify(f.raw, options(f)), 'REQUEST_CONFLICT');
});
for (const state of ['needs-information', 'refused', 'unknown', 'running', 'failed']) {
  test(`non-success state ${state} has no application payload`, () => {
    const f = fixture(); f.raw.result.state = state; reseal(f);
    refusal(() => verify(f.raw, options(f)), 'OUTCOME_UNCONFIRMED');
  });
}
for (const completedAtMs of [999_999, 1_009_999, 1_019_999, 1_800_000, 2_000_000, 3_000_000]) {
  test(`completion at ${completedAtMs} must lie inside all original time bounds`, () => {
    const f = fixture(); f.raw.result.completedAtMs = completedAtMs; reseal(f);
    refusal(() => verify(f.raw, options(f)), 'SOURCE_STALE');
  });
}
test('completed result cannot be observed before completion or released from a future/expired read proof', () => {
  const f = fixture(); f.raw.result.completedAtMs = f.raw.checkedAtMs + 1; reseal(f);
  refusal(() => verify(f.raw, options(f)), 'OUTCOME_UNCONFIRMED');
  for (const mutate of [g => { g.raw.checkedAtMs = g.nowMs + 1; }, g => { g.raw.expiresAtMs = g.nowMs; }]) {
    const g = fixture(); mutate(g); refusal(() => verify(g.raw, options(g)), 'AUTHORITY_UNAVAILABLE');
  }
});
for (const locator of [f => { f.raw.file.path = '../result.json'; }, f => { f.raw.file.object.versionId = null; },
  f => { f.raw.file.object.versionId = 'null'; }, f => { f.raw.file.object.bytes = 2_097_153; },
  f => { f.raw.file.object.sha256 = hex('9'); }, f => { f.raw.file.object.bytes++; }]) {
  test('immutable fixed file locator/byte constraints reject drift without following another object', () => {
    const f = fixture(); locator(f); refusal(() => verify(f.raw, options(f)));
  });
}
test('raw file SHA and candidate semantic result SHA are distinct and both checked', () => {
  const f = fixture(); assert.notEqual(f.raw.resultSha256, f.raw.rawFileSha256);
  f.raw.rawFileSha256 = f.raw.resultSha256; f.raw.file.object.sha256 = f.raw.rawFileSha256;
  refusal(() => verify(f.raw, options(f)), 'REQUEST_CONFLICT');
});
test('whole result SHA excludes exactly its own field and payload hash covers the entire literal payload', () => {
  const f = fixture(); f.raw.result.payload.summary = 'Tampered literal'; reseal(f);
  refusal(() => verify(f.raw, options(f)), 'REQUEST_CONFLICT');
  const g = fixture(); g.raw.result.resultSha256 = jcs(g.raw.result); g.raw.resultSha256 = g.raw.result.resultSha256;
  refusal(() => verify(g.raw, options(g)), 'REQUEST_CONFLICT');
});
test('outer/result execution must match; receipt SHA is retained rather than fabricated from an unavailable session', () => {
  const f = fixture(); f.raw.result.execution.model = 'different'; reseal(f);
  refusal(() => verify(f.raw, options(f)), 'REQUEST_CONFLICT');
  const g = fixture(); g.raw.execution.receiptSha256 = hex('8'); g.raw.result.execution.receiptSha256 = hex('8'); reseal(g);
  assert.equal(verify(g.raw, options(g)).witness.executionSha256, jcs(g.raw.execution));
});
for (const at of ['outer', 'result', 'execution', 'file', 'object', 'witness']) {
  test(`closed ${at} projection rejects unknown fields`, () => {
    const f = fixture();
    if (at === 'witness') {
      const w = { ...verify(f.raw, options(f)).witness, unknown: true };
      refusal(() => checkWitness(w, historical(f))); return;
    }
    const target = at === 'outer' ? f.raw : at === 'result' ? f.raw.result : at === 'execution' ? f.raw.execution : at === 'file' ? f.raw.file : f.raw.file.object;
    target.unknown = true; refusal(() => verify(f.raw, options(f)));
  });
}
test('accessors, proxies, cycles, sparse arrays, toJSON and invalid numeric/Unicode data refuse without invocation', () => {
  let calls = 0;
  const f = fixture(); Object.defineProperty(f.raw, 'result', { enumerable: true, get() { calls++; throw Error('must not execute'); } });
  refusal(() => verify(f.raw, options(f)));
  const g = fixture(); g.raw.result.payload = new Proxy({}, { ownKeys() { calls++; throw Error('must not execute'); } });
  refusal(() => verify(g.raw, options(g)));
  for (const value of [new Array(2), new Date(0), { toJSON() { calls++; throw Error('must not execute'); } },
    { bad: NaN }, { bad: 0.5 }, { bad: '\ud800' }]) {
    const h = fixture(); h.raw.result.payload = value; refusal(() => verify(h.raw, options(h)));
  }
  const h = fixture(); h.raw.result.payload.self = h.raw.result.payload; refusal(() => verify(h.raw, options(h)));
  assert.equal(calls, 0);
});
test('payload over 2 MiB refuses instead of truncating or slicing', () => {
  const f = fixture(); f.raw.result.payload.summary = 'x'.repeat(2_097_153);
  refusal(() => verify(f.raw, options(f)), 'INPUT_INVALID');
});
test('all regeneration/private version paths remain genuinely unsupported by B99 initial codec', () => {
  const f = fixture(); f.admission.expectedStrategyVersionId = id(99);
  refusal(() => verify(f.raw, options(f)), 'AUTHORITY_UNAVAILABLE');
  for (const mutate of [p => { p.request.requestVersion = 'private-regeneration'; }, p => { p.request.basis = {}; }]) {
    const g = fixture(); g.publication = copy(g.publication); mutate(g.publication);
    refusal(() => verify(g.raw, options(g)), 'AUTHORITY_UNAVAILABLE');
  }
});
test('stored witness pins every expected original identity without claiming current read freshness', () => {
  const f = fixture(), witness = verify(f.raw, options(f)).witness;
  for (const field of ['generationJobId', 'generationRequestId', 'sourceAdmissionSha256', 'sourceRequestSha256',
    'sourceBindingSha256', 'typedRequestSha256', 'executionContextSha256', 'completionId', 'resultRef']) {
    const changed = { ...witness, [field]: field.endsWith('Sha256') ? hex('9') : id(99) };
    refusal(() => checkWitness(changed, historical(f)), 'REQUEST_CONFLICT');
  }
  refusal(() => checkWitness({ ...witness, completedAtMs: 1_800_000 }, historical(f)), 'SOURCE_STALE');
  refusal(() => checkWitness({ ...witness, corePayloadSha256: null }, historical(f)), 'INPUT_INVALID');
});
