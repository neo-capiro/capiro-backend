// Actual private request/basis/result codecs, with declared import rewrites.
// Retained-owner, execution and DB custody are synthetic here. No SDK/model,
// authority/native/runtime proof or semantic TypeScript compilation is claimed.
// Execution is admitted separately by the parent; authoring does not run this.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

import { custody, application, generation, request, initialCodec, regenerationRequest, regenerationCodec,
  nativeFixture, storeResult } from './objective-native-codec-loader.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
const sha = digest;
const { applicationHash, CanonicalApplicationError } = application;
const { canonicalGenerationAdmissionSha256, generationLedgerId, GENERATION_ADMISSION,
  GENERATION_ACCEPTANCE, GENERATION_NORMALIZATION, GENERATION_PRODUCER } = generation;
const { createCanonicalRequestPublication, candidateJcsSha256: initialJcs, privateRequestJcsSha256: jcs } = request;
const { createCanonicalRegenerationRequestPublication: createPublication } = regenerationRequest;
const initialCreate = createCanonicalRequestPublication;
const { verifyRetainedCanonicalCompletion: initialVerify } = initialCodec;
const { verifyRetainedCanonicalRegenerationCompletion: verify, checkCanonicalRegenerationCompletionWitness: checkWitness, CORE_CANONICAL_REGENERATION_RESULT_VERSION } = regenerationCodec;
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
    requestedAtMs: 1_010_000, effectExpiresAtMs: 1_800_000, basis };
  const publication = createPublication(publicationInput);
  const binding = { tenantId: id(2), actorId: admission.actorUserId, conversationId: id(40), runId: id(41),
    attemptId: id(42), workerId: id(43), writerFence: 1 };
  const sourceRequestSha256 = jcs({ requestId: admission.generationRequestId, prompt: publication.executionContext.prompt, skill: null, window: null, windowRequest: null });
  const acceptance = { schemaVersion: 1, sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission),
    sourceBinding: binding, sourceRequestSha256, acceptedAtMs: 1_020_000,
    effectExpiresAtMs: 1_800_000 };
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
  const raw = nativeFixture(admission, publication, binding, result);
  return { admission, acceptance, publication, publicationInput, raw, result: JSON.parse(Buffer.from(raw.file.base64, 'base64')), nowMs: 1_040_001 };
}

function reseal(f) { storeResult(f); }
function resealPublication(f) {
  const { inputSha256: _discard, ...body } = f.publication.request;
  f.publication.request.inputSha256 = jcs(body); f.publication.requestSha256 = jcs(f.publication.request);
}

import { nativeCompletionCases } from './objective-native-completion-cases.mjs';
nativeCompletionCases({ fixture, verify, checkWitness });
test('whole private basis preserves fractional historical JSON without widening initial4d8', () => {
  const f = fixture(), value = verify(f.raw, options(f));
  assert.equal(f.publication.request.basis.snapshot.nodes[0].provenance.confidence, 0.75);
  assert.equal(f.publication.request.basis.snapshot.nodes[1].targetRef.ranking, 0.125);
  assert.equal(f.result.basisSha256, applicationHash(f.publication.request.basis));
  refused(() => initialJcs(f.publication.request), 'INPUT_INVALID');
  refused(() => initialVerify(f.raw, options(f)), 'AUTHORITY_UNAVAILABLE');
  assert.equal(value.witness.typedRequestSha256, f.publication.requestSha256);
});

test('only exact resultVersion is accepted; candidateVersion cannot alias or accompany it', () => {
  for (const mutate of [r => { r.resultVersion = 'future-version'; }, r => { delete r.resultVersion; },
    r => { r.candidateVersion = r.resultVersion; delete r.resultVersion; }, r => { r.candidateVersion = r.resultVersion; }]) {
    const f = fixture(); mutate(f.result); reseal(f); refused(() => verify(f.raw, options(f)));
  }
});

test('success-only slice refuses all terminal/nonterminal labels and nonempty issues', () => {
  for (const state of ['needs-information', 'refused', 'failed', 'cancelled', 'unknown', 'running']) {
    const f = fixture(); f.result.state = state; reseal(f); refused(() => verify(f.raw, options(f)), 'OUTCOME_UNCONFIRMED');
  }
  for (const mutate of [r => { r.payload = null; }, r => { r.payload = []; }, r => { r.payload.type = 'appropriation'; },
    r => { r.issues = [{ code: 'private', message: 'Do not publish' }]; }, r => { r.issues = {}; }]) {
    const f = fixture(); mutate(f.result); f.result.payloadSha256 = jcs(f.result.payload); reseal(f);
    refused(() => verify(f.raw, options(f)), 'REQUEST_CONFLICT');
  }
});

test('result basis hash covers original whole basis, not snapshot/request/source hashes', () => {
  const f = fixture(); assert.notEqual(applicationHash(f.publication.request.basis), f.publication.request.basis.snapshotSha256);
  for (const hash of [null, f.publication.request.basis.snapshotSha256, f.publication.requestSha256,
    f.result.sourceSha256, hex('9')]) {
    const bad = fixture(); bad.result.basisSha256 = hash; reseal(bad);
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

test('private verifier refuses initial publication/null expected version with no format fallback', () => {
  const f = fixture(), initial = copy(f.publicationInput); delete initial.basis; initial.admission.expectedStrategyVersionId = null;
  const p = initialCreate(initial);
  refused(() => verify(f.raw, { ...options(f), admission: initial.admission, publication: p }), 'AUTHORITY_UNAVAILABLE');
  const g = fixture(); g.publication = copy(g.publication); g.publication.request.basis = null;
  refused(() => verify(g.raw, options(g)), 'AUTHORITY_UNAVAILABLE');
});

test('source packet/context hash cannot be replaced by execution-context/request/basis hash', () => {
  const f = fixture(); assert.notEqual(jcs(f.publication.executionContext), f.result.contextSha256);
  for (const hash of [jcs(f.publication.executionContext), f.publication.requestSha256, f.result.basisSha256]) {
    const g = fixture(); g.result.contextSha256 = hash; reseal(g); refused(() => verify(g.raw, options(g)), 'REQUEST_CONFLICT');
  }
});

test('options and historical expected objects are closed with no caller time/authority override', () => {
  const f = fixture(), witness = verify(f.raw, options(f)).witness;
  refused(() => verify(f.raw, { ...options(f), basis: f.publication.request.basis }), 'INPUT_INVALID');
  refused(() => checkWitness(witness, { ...historical(f), nowMs: f.nowMs }), 'INPUT_INVALID');
});
