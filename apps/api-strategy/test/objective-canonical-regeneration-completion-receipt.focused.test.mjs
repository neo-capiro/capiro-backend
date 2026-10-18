// Actual private request/basis/result codecs, with declared import rewrites.
// Retained-owner, execution and DB custody are synthetic here. No SDK/model,
// authority/native/runtime proof or semantic TypeScript compilation is claimed.
// Execution is admitted separately by the parent; authoring does not run this.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const custody = [];
const digest = value => createHash('sha256').update(value).digest('hex');
const asModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
async function sourceModule(path, replacements = []) {
  const url = new URL(path, import.meta.url), original = await readFile(url, 'utf8');
  let source = original;
  for (const [from, to] of replacements) {
    const parts = source.split(from); assert.equal(parts.length, 2, `one declared dependency ${from}`);
    source = parts.join(JSON.stringify(to));
  }
  const stripped = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: url.href });
  custody.push({ path, rawSha256: digest(original), transformedSha256: digest(stripped),
    replacementSpecifiers: replacements.map(([from]) => from) });
  return asModule(stripped);
}
const appUrl = await sourceModule('../src/planner/objective-canonical-application.ts');
const genUrl = await sourceModule('../src/meri/objective-canonical-generation.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl],
]);
const initialRequestUrl = await sourceModule('../src/meri/objective-canonical-request.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'./objective-canonical-generation.js'", genUrl],
]);
const unusedVersion = asModule("export const buildSnapshot=()=>{throw Error('UNUSED_DB_BASIS_OWNER');};");
const unusedProducer = asModule("export const readCanonicalGenerationProducer=()=>{throw Error('UNUSED_DB_BASIS_OWNER');};");
const unusedHistory = asModule("export const canonicalRegenerationSnapshot=()=>{throw Error('UNUSED_DB_HISTORY_OWNER');};export const checkCanonicalRegenerationNormalization=()=>{throw Error('UNUSED_DB_HISTORY_OWNER');};");
const basisUrl = await sourceModule('../src/meri/objective-canonical-basis.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'./objective-canonical-generation.js'", genUrl],
  ["'../strategy/versioning.js'", unusedVersion], ["'./objective-canonical-producer-ledger.js'", unusedProducer],
  ["'./objective-canonical-regeneration-ledger.js'", unusedHistory],
]);
const requestUrl = await sourceModule('../src/meri/objective-canonical-regeneration-request.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'./objective-canonical-generation.js'", genUrl],
  ["'./objective-canonical-basis.js'", basisUrl], ["'./objective-canonical-request.js'", initialRequestUrl],
]);
const initialCompletionUrl = await sourceModule('../src/meri/objective-canonical-completion-receipt.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'./objective-canonical-generation.js'", genUrl],
  ["'./objective-canonical-request.js'", initialRequestUrl],
]);
const resultUrl = await sourceModule('../src/meri/objective-canonical-regeneration-completion-receipt.ts', [
  ["'../planner/objective-canonical-application.js'", appUrl], ["'./objective-canonical-generation.js'", genUrl],
  ["'./objective-canonical-request.js'", initialRequestUrl], ["'./objective-canonical-regeneration-request.js'", requestUrl],
  ["'./objective-canonical-completion-receipt.js'", initialCompletionUrl],
]);
const { applicationHash, CanonicalApplicationError } = await import(appUrl);
const { canonicalGenerationAdmissionSha256, generationLedgerId, GENERATION_ADMISSION,
  GENERATION_ACCEPTANCE, GENERATION_NORMALIZATION, GENERATION_PRODUCER } = await import(genUrl);
const { candidateJcsSha256: initialJcs, privateRequestJcsSha256: jcs,
  createCanonicalRequestPublication: initialCreate } = await import(initialRequestUrl);
const { createCanonicalRegenerationRequestPublication: createPublication } = await import(requestUrl);
const { verifyRetainedCanonicalCompletion: initialVerify } = await import(initialCompletionUrl);
const { verifyRetainedCanonicalRegenerationCompletion: verify,
  checkCanonicalRegenerationCompletionWitness: checkWitness,
  CORE_CANONICAL_REGENERATION_RESULT_VERSION } = await import(resultUrl);
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const hex = c => c.repeat(64);
const copy = value => structuredClone(value);
const refused = (run, code) => assert.throws(run, error => error instanceof CanonicalApplicationError &&
  (code === undefined || error.code === code));
const options = f => ({ admission: f.admission, acceptance: f.acceptance, publication: f.publication, nowMs: f.nowMs });
const historical = f => ({ admission: f.admission, acceptance: f.acceptance, publication: f.publication });
function node(nodeId, title, machine = true) {
  return { id: nodeId, kind: 'action', subject: 'Exact subject', title, note: null,
    ownerUserId: 'user_fixture', status: 'planned', startsOn: '2026-10-16', endsOn: null,
    openEnded: true, dependsOnIds: [], meriAuthored: machine,
    createdByUserId: machine ? 'user_fixture' : 'user_human', createdAt: '2026-10-15T12:00:00.000Z' };
}
function sealBasis(b) {
  b.snapshotSha256 = applicationHash(b.snapshot); b.sourceIndexSha256 = applicationHash(b.sourceIndex);
  b.archiveIndexSha256 = applicationHash(b.archiveIndex); return b;
}
function fixture() {
  const source = { clientId: id(3), objectiveId: id(4), objectiveVersion: 2, objectiveRevisionId: id(8) };
  const intent = { outcome: 'Preserve human work', governmentProblem: 'Exact government problem',
    askType: 'both', minimumWin: 'Exact minimum', limits: '' };
  const admission = { schemaVersion: 1, namespace: 'capiro.objective-strategy.admission:v1',
    canonical: { canonicalPlanId: id(1), tenantId: id(2), clientId: id(3), objectiveId: id(4),
      canonicalStrategyId: id(5), canonicalProjectId: id(6), bindingVersion: 2, epoch: 1,
      requestedIntentId: id(7), requestedObjectiveRevisionId: id(8), requestedObjectiveVersion: 2, snapshotHash: hex('a') },
    actorUserId: id(9), clerkUserId: 'user_fixture', consentId: id(12), controlVersion: 3,
    generationJobId: id(10), generationRequestId: id(11), admittedAtMs: 1_000_000,
    effectExpiresAtMs: 3_000_000, expectedStrategyVersionId: id(50) };
  const meta = { id: id(5), clientId: id(3), title: 'Human current title', type: 'authorization',
    goal: 'Human current goal', meriContext: null, meriSummary: 'Prior machine summary', targetDate: null,
    ownerUserId: 'user_fixture', createdByUserId: 'user_fixture', createdAt: '2026-10-15T12:00:00.000Z' };
  const oldJob = id(51), normId = generationLedgerId(GENERATION_NORMALIZATION, id(2), 'user_fixture', oldJob);
  const basis = sealBasis({ schemaVersion: 1, namespace: 'capiro.objective-strategy.basis:v1',
    canonical: copy(admission.canonical), sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission),
    strategyId: id(5), expectedStrategyVersionId: id(50),
    snapshot: { meta, nodes: [node(id(60), 'Human edited machine title'), node(id(61), 'Manual node', false)] },
    archiveIndex: [{ nodeId: id(62), archivedAt: '2026-10-16T05:00:00.000Z' }],
    sourceIndex: [
      { sourceNodeKey: 'archived_step', nodeId: id(62), archived: true,
        lastMachine: { normalizationId: normId, node: node(id(62), 'Archived prior machine node') } },
      { sourceNodeKey: 'machine_step', nodeId: id(60), archived: false,
        lastMachine: { normalizationId: normId, node: node(id(60), 'Prior machine title') } },
    ], lastMachineStrategy: { normalizationId: normId, meta: { ...copy(meta), title: 'Prior machine title' } },
    provenance: [{ ownerUserId: 'user_fixture', generationJobId: oldJob, generationRequestId: id(52), canonicalBindingVersion: 1,
      admissionId: generationLedgerId(GENERATION_ADMISSION, id(2), 'user_fixture', oldJob), admissionSha256: hex('b'),
      acceptanceId: generationLedgerId(GENERATION_ACCEPTANCE, id(2), 'user_fixture', oldJob), acceptanceSha256: hex('c'),
      normalizationId: normId, normalizationSha256: hex('d'),
      producerId: generationLedgerId(GENERATION_PRODUCER, id(2), 'user_fixture', oldJob), producerSha256: hex('e'),
      strategyVersionId: id(53), snapshotSha256: hex('f') }],
  });
  // These are actual historical JSON observations, not newly typed counters.
  basis.snapshot.nodes[0].provenance = { confidence: 0.75 };
  basis.snapshot.nodes[1].targetRef = { ranking: 0.125 };
  basis.sourceIndex[1].lastMachine.node.provenance = { confidence: 0.5 }; sealBasis(basis);
  const prompt = 'Literal original governed regeneration prompt\n';
  const publicationInput = { admission,
    dto: { clientId: id(3), type: 'authorization', goal: 'Original queued input', meriContext: null,
      ownerUserId: null, targetDate: '2028-02-29', attachmentIds: [] },
    context: { schemaVersion: 1, tenantId: id(2), clerkUserId: admission.clerkUserId, requestId: id(11), source, intent,
      snapshotSha256: admission.canonical.snapshotHash, sourceDigest: applicationHash({ source, intent }), packetId: id(20),
      compiledAt: new Date(1_005_000).toISOString(), coverageDigest: hex('b'), promptSha256: digest(prompt), evidence: [] },
    prompt, owners: [{ ownerRef: 'owner:fixture', clerkUserId: admission.clerkUserId }],
    delegation: { ref: id(30), revision: 'source-delegation:1', issuedAtMs: 999_000, absoluteExpiresAtMs: 4_000_000 },
    requestedAtMs: 1_010_000, effectExpiresAtMs: 2_000_000, basis };
  const publication = createPublication(publicationInput);
  const binding = { tenantId: id(2), actorId: admission.clerkUserId, conversationId: id(40), runId: id(41),
    attemptId: id(42), workerId: id(43), writerFence: 1 };
  const sourceRequestSha256 = hex('c');
  const acceptance = { schemaVersion: 1, sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission),
    sourceBinding: binding, sourceRequestSha256, acceptedAtMs: 1_020_000,
    issuance: { issuanceKey: applicationHash(binding), binding: copy(binding), requestSha256: sourceRequestSha256,
      expiresAtMs: 1_800_000, grantId: id(44), capabilitySha256: hex('d'), factsSha256: hex('e') } };
  const h = jcs({ binding, kind: 'completion' });
  const completionId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  const execution = { provider: 'trusted-provider-fixture', model: 'trusted-model-fixture',
    receiptRef: completionId, receiptSha256: hex('f'), bindingSha256: jcs(binding) };
  const payload = { type: 'authorization', rationale: 'Literal rationale', summary: 'Literal preserving proposal',
    nodes: [{ sourceNodeKey: 'machine_step', kind: 'action', subject: 'deliverable', title: 'Proposed machine title',
      note: null, status: 'suggested', ownerRef: null, startsOn: '2028-02-29', endsOn: null,
      openEnded: false, sources: [], dependsOn: [] }],
    coverage: { complete: true, omitted: [], assumptions: [], sources: [], pendingSources: [] } };
  const result = { resultVersion: CORE_CANONICAL_REGENERATION_RESULT_VERSION, operation: 'strategy.draft',
    requestId: admission.generationRequestId, jobId: admission.generationJobId, requestSha256: publication.requestSha256,
    inputSha256: publication.request.inputSha256, sourceSha256: jcs(publication.request.source),
    contextSha256: publication.request.context.contextSha256, basisSha256: applicationHash(publication.request.basis),
    binding: copy(binding), execution: copy(execution), resultRef: completionId, completedAtMs: 1_030_000,
    state: 'succeeded', payload, payloadSha256: jcs(payload), issues: [], resultSha256: '' };
  const raw = { schemaVersion: 1, generationJobId: admission.generationJobId, binding: copy(binding),
    sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission), sourceRequestSha256, typedRequestSha256: publication.requestSha256,
    completionId, checkpointId: id(70), checkpointSha256: hex('1'), resultRef: completionId, resultSha256: '',
    file: { path: 'meri-objective-strategy-regeneration.result.json', object: { objectId: 'opaque-object-ref',
      versionId: 'immutable-version-ref', sha256: '', bytes: 1, scopes: ['owner-fixture-scope'] } },
    rawFileSha256: '', execution: copy(execution), result, checkedAtMs: 1_040_000, expiresAtMs: 1_050_000 };
  const f = { admission, acceptance, publication, publicationInput, raw, nowMs: 1_040_001 }; reseal(f); return f;
}
function reseal(f) {
  const r = f.raw.result, { resultSha256: _discard, ...body } = r;
  r.resultSha256 = jcs(body); f.raw.resultSha256 = r.resultSha256;
  const bytes = Buffer.from(JSON.stringify(r), 'utf8');
  f.raw.rawFileSha256 = digest(bytes); f.raw.file.object.sha256 = f.raw.rawFileSha256; f.raw.file.object.bytes = bytes.length;
}
function resealPublication(f) {
  const { inputSha256: _discard, ...body } = f.publication.request;
  f.publication.request.inputSha256 = jcs(body); f.publication.requestSha256 = jcs(f.publication.request);
}

test('source custody declares seven actual modules and only unused throwing DB-owner bindings', t => {
  assert.deepEqual(custody.map(x => x.replacementSpecifiers.length), [0, 1, 2, 5, 4, 3, 5]);
  t.diagnostic(JSON.stringify({ sourceCustody: custody, unusedDbBindings: true, nativeOrSdkProof: false }));
});

test('private33 exact result18/read17 yields the same19-field immutable completion witness API', () => {
  const f = fixture(), before = copy(f.raw), value = verify(f.raw, options(f));
  assert.deepEqual(f.raw, before); assert.equal(Object.keys(f.raw).length, 17); assert.equal(Object.keys(f.raw.result).length, 18);
  assert.deepEqual(Object.keys(value), ['payload', 'witness', 'checkedAtMs', 'expiresAtMs']);
  assert.equal(Object.keys(value.witness).length, 19); assert.equal(value.witness.namespace, 'capiro.objective-strategy.completion:v1');
  assert.deepEqual(JSON.parse(JSON.stringify(value.payload)), f.raw.result.payload);
  assert.equal(value.witness.typedRequestSha256, jcs(f.publication.request));
  assert.equal(value.witness.payloadSha256, jcs(f.raw.result.payload));
  assert.equal(value.witness.corePayloadSha256, applicationHash(f.raw.result.payload));
  assert.deepEqual(checkWitness(value.witness, historical(f)), value.witness);
  assert.equal(Object.isFrozen(value), true); assert.equal(Object.isFrozen(value.payload.nodes[0]), true);
});

test('whole private basis preserves fractional historical JSON without widening initial4d8', () => {
  const f = fixture(), value = verify(f.raw, options(f));
  assert.equal(f.publication.request.basis.snapshot.nodes[0].provenance.confidence, 0.75);
  assert.equal(f.publication.request.basis.snapshot.nodes[1].targetRef.ranking, 0.125);
  assert.equal(f.raw.result.basisSha256, applicationHash(f.publication.request.basis));
  refused(() => initialJcs(f.publication.request), 'INPUT_INVALID');
  refused(() => initialVerify(f.raw, options(f)), 'AUTHORITY_UNAVAILABLE');
  assert.equal(value.witness.typedRequestSha256, f.publication.requestSha256);
});

test('fresh authorized historical read may follow original effect expiry but completion cannot', () => {
  const f = fixture(), witness = verify(f.raw, options(f)).witness;
  f.raw.checkedAtMs = 5_000_000; f.raw.expiresAtMs = 5_000_100; f.nowMs = 5_000_001;
  assert.deepEqual(verify(f.raw, options(f)).witness, witness);
  f.raw.result.completedAtMs = 5_000_000; reseal(f); refused(() => verify(f.raw, options(f)), 'SOURCE_STALE');
});

test('only exact resultVersion is accepted; candidateVersion cannot alias or accompany it', () => {
  for (const mutate of [r => { r.resultVersion = 'future-version'; }, r => { delete r.resultVersion; },
    r => { r.candidateVersion = r.resultVersion; delete r.resultVersion; }, r => { r.candidateVersion = r.resultVersion; }]) {
    const f = fixture(); mutate(f.raw.result); reseal(f); refused(() => verify(f.raw, options(f)));
  }
});

test('only the fixed regeneration file is accepted with no draft-file or traversal fallback', () => {
  for (const path of ['meri-objective-strategy-draft.result.json', '../meri-objective-strategy-regeneration.result.json',
    '/meri-objective-strategy-regeneration.result.json', 'other.result.json']) {
    const f = fixture(); f.raw.file.path = path; refused(() => verify(f.raw, options(f)), 'REQUEST_CONFLICT');
  }
});

test('success-only slice refuses all terminal/nonterminal labels and nonempty issues', () => {
  for (const state of ['needs-information', 'refused', 'failed', 'cancelled', 'unknown', 'running']) {
    const f = fixture(); f.raw.result.state = state; reseal(f); refused(() => verify(f.raw, options(f)), 'OUTCOME_UNCONFIRMED');
  }
  for (const mutate of [r => { r.payload = null; }, r => { r.payload = []; }, r => { r.payload.type = 'appropriation'; },
    r => { r.issues = [{ code: 'private', message: 'Do not publish' }]; }, r => { r.issues = {}; }]) {
    const f = fixture(); mutate(f.raw.result); f.raw.result.payloadSha256 = jcs(f.raw.result.payload); reseal(f);
    refused(() => verify(f.raw, options(f)), 'REQUEST_CONFLICT');
  }
});

test('result basis hash covers original whole basis, not snapshot/request/source hashes', () => {
  const f = fixture(); assert.notEqual(applicationHash(f.publication.request.basis), f.publication.request.basis.snapshotSha256);
  for (const hash of [null, f.publication.request.basis.snapshotSha256, f.publication.requestSha256,
    f.raw.result.sourceSha256, hex('9')]) {
    const bad = fixture(); bad.raw.result.basisSha256 = hash; reseal(bad);
    refused(() => verify(bad.raw, options(bad)), 'REQUEST_CONFLICT');
  }
});

test('self-rehashed publication cannot replace target/mode/version or corrupt original basis', () => {
  for (const mutate of [p => { p.request.applicationTarget.mode = 'create'; },
    p => { p.request.applicationTarget.expectedStrategyVersionId = id(999); },
    p => { p.request.applicationTarget.canonical.epoch++; }, p => { p.request.requestVersion = 'other'; },
    p => { p.request.basis.snapshot.nodes[0].title = 'Unhashed mutation'; },
    p => { p.request.basisSha256 = p.request.basis.snapshotSha256; }]) {
    const f = fixture(); f.publication = copy(f.publication); mutate(f.publication); resealPublication(f);
    refused(() => verify(f.raw, options(f)), 'OUTCOME_UNCONFIRMED');
  }
});

test('outer original job/source/request/completion identities cannot be substituted', () => {
  for (const field of ['generationJobId', 'sourceAdmissionSha256', 'sourceRequestSha256', 'typedRequestSha256', 'completionId', 'resultRef']) {
    const f = fixture(); f.raw[field] = field.endsWith('Sha256') ? hex('9') : id(999);
    refused(() => verify(f.raw, options(f)), 'REQUEST_CONFLICT');
  }
});

test('self-consistent result hashes cannot substitute request/input/source/context/job pins', () => {
  for (const field of ['requestId', 'jobId', 'requestSha256', 'inputSha256', 'sourceSha256', 'contextSha256']) {
    const f = fixture(); f.raw.result[field] = field.endsWith('Sha256') ? hex('9') : id(999); reseal(f);
    refused(() => verify(f.raw, options(f)), 'REQUEST_CONFLICT');
  }
  const f = fixture(); f.raw.result.operation = 'strategy.edit'; reseal(f); refused(() => verify(f.raw, options(f)), 'REQUEST_CONFLICT');
});

test('outer and result binding must equal full original accepted run, attempt and fence', () => {
  for (const where of ['binding', 'result']) for (const field of ['tenantId', 'actorId', 'conversationId', 'runId', 'attemptId', 'workerId', 'writerFence']) {
    const f = fixture(), target = where === 'binding' ? f.raw.binding : f.raw.result.binding;
    target[field] = field === 'writerFence' ? 2 : field === 'actorId' ? 'other-clerk' : id(999); reseal(f);
    refused(() => verify(f.raw, options(f)), 'REQUEST_CONFLICT');
  }
});

test('accepted original source identity cannot be rebound to a different Clerk actor or issuance', () => {
  for (const mutate of [a => { a.sourceBinding.actorId = 'other-clerk'; }, a => { a.issuance.factsSha256 = null; },
    a => { a.sourceRequestSha256 = hex('9'); }, a => { a.issuance.expiresAtMs = 2_100_000; }]) {
    const f = fixture(); f.acceptance = copy(f.acceptance); mutate(f.acceptance); refused(() => verify(f.raw, options(f)));
  }
});

test('execution equality and bound original receipt remain separate from semantic result hash', () => {
  const f = fixture(); f.raw.result.execution.model = 'different'; reseal(f); refused(() => verify(f.raw, options(f)), 'REQUEST_CONFLICT');
  for (const field of ['receiptRef', 'bindingSha256']) {
    const g = fixture(), value = field === 'receiptRef' ? id(999) : hex('9');
    g.raw.execution[field] = value; g.raw.result.execution[field] = value; reseal(g);
    refused(() => verify(g.raw, options(g)), 'REQUEST_CONFLICT');
  }
  const g = fixture(); g.raw.execution.receiptSha256 = hex('8'); g.raw.result.execution.receiptSha256 = hex('8'); reseal(g);
  assert.equal(verify(g.raw, options(g)).witness.executionSha256, jcs(g.raw.execution));
});

test('raw file representation length/SHA are checked independently of sorted semantic SHA', () => {
  const f = fixture(); assert.notEqual(f.raw.rawFileSha256, f.raw.resultSha256);
  const reversed = Object.fromEntries(Object.entries(f.raw.result).reverse());
  f.raw.result = reversed; refused(() => verify(f.raw, options(f)), 'REQUEST_CONFLICT');
  reseal(f); assert.equal(verify(f.raw, options(f)).witness.resultSha256, f.raw.resultSha256);
  f.raw.rawFileSha256 = f.raw.resultSha256; f.raw.file.object.sha256 = f.raw.rawFileSha256;
  refused(() => verify(f.raw, options(f)), 'REQUEST_CONFLICT');
});

test('payload hash covers whole literal payload and result hash excludes only itself', () => {
  const f = fixture(); f.raw.result.payload.summary = 'Unbound change'; reseal(f); refused(() => verify(f.raw, options(f)), 'REQUEST_CONFLICT');
  const g = fixture(); g.raw.result.resultSha256 = jcs(g.raw.result); g.raw.resultSha256 = g.raw.result.resultSha256;
  refused(() => verify(g.raw, options(g)), 'REQUEST_CONFLICT');
  const h = fixture(); h.raw.result.payload.summary = 'A distinct literal proposal';
  h.raw.result.payloadSha256 = jcs(h.raw.result.payload); reseal(h);
  assert.equal(verify(h.raw, options(h)).witness.corePayloadSha256, applicationHash(h.raw.result.payload));
});

test('completion stays within every original admission/request/acceptance/issuance bound', () => {
  for (const completedAtMs of [999_999, 1_009_999, 1_019_999, 1_800_000, 2_000_000, 3_000_000]) {
    const f = fixture(); f.raw.result.completedAtMs = completedAtMs; reseal(f);
    refused(() => verify(f.raw, options(f)), 'SOURCE_STALE');
  }
});

test('typed clocks and fences remain safe integers despite private fractional historical JSON', () => {
  for (const mutate of [f => { f.raw.result.completedAtMs += 0.5; }, f => { f.raw.checkedAtMs += 0.5; },
    f => { f.raw.expiresAtMs = Infinity; }, f => { f.nowMs += 0.5; }, f => { f.raw.binding.writerFence = 1.5; }]) {
    const f = fixture(); mutate(f); refused(() => verify(f.raw, options(f)));
  }
});

test('future/expired read or completion after observation refuses without extending original grant', () => {
  for (const mutate of [f => { f.raw.checkedAtMs = f.nowMs + 1; }, f => { f.raw.expiresAtMs = f.nowMs; },
    f => { f.raw.checkedAtMs = f.raw.expiresAtMs; }]) {
    const f = fixture(); mutate(f); refused(() => verify(f.raw, options(f)), 'AUTHORITY_UNAVAILABLE');
  }
  const f = fixture(); f.raw.result.completedAtMs = f.raw.checkedAtMs + 1; reseal(f);
  refused(() => verify(f.raw, options(f)), 'OUTCOME_UNCONFIRMED');
});

test('immutable locator versions/bytes/hash refuse drift without following another object', () => {
  for (const mutate of [f => { f.raw.file.object.versionId = null; }, f => { f.raw.file.object.versionId = 'null'; },
    f => { f.raw.file.object.bytes++; }, f => { f.raw.file.object.bytes = 2_097_153; },
    f => { f.raw.file.object.sha256 = hex('9'); }, f => { f.raw.file.object.objectId = ''; }]) {
    const f = fixture(); mutate(f); refused(() => verify(f.raw, options(f)));
  }
});

test('reader/result/execution/file/reference and witness projections are closed', () => {
  for (const at of ['outer', 'result', 'execution', 'file', 'object']) {
    const f = fixture(), target = at === 'outer' ? f.raw : at === 'result' ? f.raw.result : at === 'execution' ? f.raw.execution :
      at === 'file' ? f.raw.file : f.raw.file.object;
    target.extra = true; refused(() => verify(f.raw, options(f)));
  }
  const f = fixture(); refused(() => checkWitness({ ...verify(f.raw, options(f)).witness, basisSha256: hex('9') }, historical(f)));
});

test('accessors/proxies/toJSON are refused before invocation', () => {
  let calls = 0;
  const f = fixture(); Object.defineProperty(f.raw, 'result', { enumerable: true, get() { calls++; throw Error('not evaluated'); } });
  refused(() => verify(f.raw, options(f)));
  const g = fixture(); g.raw.result.payload = new Proxy({}, { ownKeys() { calls++; throw Error('not evaluated'); } });
  refused(() => verify(g.raw, options(g)));
  const h = fixture(); h.raw.result.payload = { toJSON() { calls++; throw Error('not evaluated'); } };
  refused(() => verify(h.raw, options(h))); assert.equal(calls, 0);
});

test('private finite domain still refuses nonfinite/invalid Unicode/sparse/custom/cyclic data', () => {
  for (const value of [{ bad: NaN }, { bad: Infinity }, { bad: '\ud800' }, new Array(2), new Date(0)]) {
    const f = fixture(); f.raw.result.payload = value; refused(() => verify(f.raw, options(f)));
  }
  const f = fixture(); f.raw.result.payload.self = f.raw.result.payload; refused(() => verify(f.raw, options(f)));
});

test('whole retained/publication budget and depth refuse rather than truncating', () => {
  const f = fixture(); f.raw.result.payload.summary = 'x'.repeat(2_097_153); refused(() => verify(f.raw, options(f)), 'INPUT_INVALID');
  const g = fixture(); let nested = {}; for (let i = 0; i < 66; i++) nested = { nested };
  g.raw.result.payload = nested; refused(() => verify(g.raw, options(g)), 'INPUT_INVALID');
  const h = fixture(); h.publication = copy(h.publication); h.publication.request.basis.snapshot.meta.opaque = 'x'.repeat(2_097_153);
  refused(() => verify(h.raw, options(h)), 'INPUT_INVALID');
});

test('private verifier refuses initial publication/null expected version with no format fallback', () => {
  const f = fixture(), initial = copy(f.publicationInput); delete initial.basis; initial.admission.expectedStrategyVersionId = null;
  const p = initialCreate(initial);
  refused(() => verify(f.raw, { ...options(f), admission: initial.admission, publication: p }), 'AUTHORITY_UNAVAILABLE');
  const g = fixture(); g.publication = copy(g.publication); g.publication.request.basis = null;
  refused(() => verify(g.raw, options(g)), 'AUTHORITY_UNAVAILABLE');
});

test('historical witness has no refreshed read clock or new basis field and retains exact original source', () => {
  const f = fixture(), witness = verify(f.raw, options(f)).witness;
  for (const key of ['checkedAtMs', 'expiresAtMs', 'basisSha256', 'file', 'binding']) assert.equal(Object.hasOwn(witness, key), false);
  assert.deepEqual(checkWitness(copy(witness), historical(f)), witness);
  assert.equal(Object.isFrozen(checkWitness(witness, historical(f))), true);
  f.nowMs = 9_000_000; assert.deepEqual(checkWitness(witness, historical(f)), witness);
});

test('historical witness binds all original identity pins and validates retained hash syntax', () => {
  const f = fixture(), witness = verify(f.raw, options(f)).witness;
  for (const field of ['generationJobId', 'generationRequestId', 'sourceAdmissionSha256', 'sourceRequestSha256',
    'sourceBindingSha256', 'typedRequestSha256', 'executionContextSha256', 'completionId', 'resultRef']) {
    refused(() => checkWitness({ ...witness, [field]: field.endsWith('Sha256') ? hex('9') : id(999) }, historical(f)), 'REQUEST_CONFLICT');
  }
  for (const field of ['checkpointSha256', 'resultSha256', 'rawFileSha256', 'executionSha256', 'payloadSha256', 'corePayloadSha256'])
    refused(() => checkWitness({ ...witness, [field]: null }, historical(f)), 'INPUT_INVALID');
  refused(() => checkWitness({ ...witness, namespace: 'capiro.objective-strategy.completion:v2' }, historical(f)), 'REQUEST_CONFLICT');
});

test('historical witness still refuses late/future original completion and altered typed request', () => {
  const f = fixture(), witness = verify(f.raw, options(f)).witness;
  refused(() => checkWitness({ ...witness, completedAtMs: 1_800_000 }, historical(f)), 'SOURCE_STALE');
  const g = fixture(); g.publication = copy(g.publication); g.publication.request.basisSha256 = hex('9'); resealPublication(g);
  refused(() => checkWitness(witness, historical(g)), 'OUTCOME_UNCONFIRMED');
});

test('source packet/context hash cannot be replaced by execution-context/request/basis hash', () => {
  const f = fixture(); assert.notEqual(jcs(f.publication.executionContext), f.raw.result.contextSha256);
  for (const hash of [jcs(f.publication.executionContext), f.publication.requestSha256, f.raw.result.basisSha256]) {
    const g = fixture(); g.raw.result.contextSha256 = hash; reseal(g); refused(() => verify(g.raw, options(g)), 'REQUEST_CONFLICT');
  }
});

test('options and historical expected objects are closed with no caller time/authority override', () => {
  const f = fixture(), witness = verify(f.raw, options(f)).witness;
  refused(() => verify(f.raw, { ...options(f), basis: f.publication.request.basis }), 'INPUT_INVALID');
  refused(() => checkWitness(witness, { ...historical(f), nowMs: f.nowMs }), 'INPUT_INVALID');
});
