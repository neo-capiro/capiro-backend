// Actual Core codec + pure dependencies over synthetic retained-owner data.
// No SDK execution, Meri custody/authority, HTTP, DB or model proof is claimed.
// Root owns execution admission; this file may be authored without running it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

import { custody, application, generation, request, initialCodec, regenerationRequest, regenerationCodec,
  nativeFixture, storeResult } from './objective-native-codec-loader.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
const sha = digest;
const { applicationHash, CanonicalApplicationError } = application;
const { canonicalGenerationAdmissionSha256, generationLedgerId, GENERATION_ADMISSION,
  GENERATION_ACCEPTANCE, GENERATION_NORMALIZATION, GENERATION_PRODUCER } = generation;
const { createCanonicalRequestPublication, candidateJcsSha256: initialJcs, privateRequestJcsSha256: jcs } = request;
const { verifyRetainedCanonicalCompletion: verify, checkCanonicalCompletionWitness: checkWitness } = initialCodec;
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
    requestedAtMs: 1_010_000, effectExpiresAtMs: 1_800_000 });
  const binding = { tenantId: id(2), actorId: admission.actorUserId, conversationId: id(40), runId: id(41),
    attemptId: id(42), workerId: id(43), writerFence: 1 };
  const sourceRequestSha256 = jcs({ requestId: admission.generationRequestId, prompt: publication.executionContext.prompt, skill: null, window: null, windowRequest: null });
  const acceptance = { schemaVersion: 1, sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission),
    sourceBinding: binding, sourceRequestSha256, acceptedAtMs: 1_020_000,
    effectExpiresAtMs: 1_800_000 };
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
  const raw = nativeFixture(admission, publication, binding, result);
  return { admission, acceptance, publication, raw, result: JSON.parse(Buffer.from(raw.file.base64, 'base64')), nowMs: 1_040_001 };
}

function reseal(f) { storeResult(f); }
const options = f => ({ admission: f.admission, acceptance: f.acceptance, publication: f.publication, nowMs: f.nowMs });
const historical = f => ({ admission: f.admission, acceptance: f.acceptance, publication: f.publication });

import { nativeCompletionCases } from './objective-native-completion-cases.mjs';
nativeCompletionCases({ fixture, verify, checkWitness });
test('initial codec still refuses regeneration or unexpected private-version request', () => {
  const f=fixture();f.admission.expectedStrategyVersionId=id(99);
  refusal(()=>verify(f.raw,options(f)),'AUTHORITY_UNAVAILABLE');
  for(const mutate of [p=>{p.request.requestVersion='private-regeneration';},p=>{p.request.basis={};}]){
    const g=fixture();g.publication=copy(g.publication);mutate(g.publication);
    refusal(()=>verify(g.raw,options(g)),'AUTHORITY_UNAVAILABLE');
  }
});
