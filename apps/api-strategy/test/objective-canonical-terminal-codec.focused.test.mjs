// Actual Core codec and pure dependencies over synthetic retained-reader data.
// No SDK, genuine Meri custody, candidate semantic validator, public questions,
// current authority, framework or database qualification is claimed.
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
const { verifyRetainedCanonicalCompletion: success, verifyRetainedCanonicalNonSuccess: verify, checkStoredCanonicalNonSuccess: checkStored, checkCanonicalCompletionWitness: checkWitness } = initialCodec;
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
    requestedAtMs: 1_010_000, effectExpiresAtMs: 1_800_000 });
  const binding = { tenantId: id(2), actorId: admission.actorUserId, conversationId: id(40), runId: id(41),
    attemptId: id(42), workerId: id(43), writerFence: 1 };
  const sourceRequestSha256 = jcs({ requestId: admission.generationRequestId, prompt: publication.executionContext.prompt, skill: null, window: null, windowRequest: null });
  const acceptance = { schemaVersion: 1, sourceAdmissionSha256: canonicalGenerationAdmissionSha256(admission),
    sourceBinding: binding, sourceRequestSha256, acceptedAtMs: 1_020_000,
    effectExpiresAtMs: 1_800_000 };
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
  const raw = nativeFixture(admission, publication, binding, result);
  return { admission, acceptance, publication, raw, result: JSON.parse(Buffer.from(raw.file.base64, 'base64')), nowMs: 1_040_001 };
}

function reseal(f) { storeResult(f); }
const expected = f => ({ admission: f.admission, acceptance: f.acceptance, publication: f.publication });
const options = f => ({ ...expected(f), nowMs: f.nowMs });
const nonSuccess = f => verify(f.raw, options(f));


test('typed outcomes retain the actual six-field native envelope privately and frozen', () => {
  for(const state of ['needs-information','refused']) {
    const f=fixture(state), before=copy(f.raw), value=nonSuccess(f);
    assert.deepEqual(Object.keys(value),['outcome','evidence']);
    assert.equal(value.outcome,state);assert.equal(value.evidence.kind,'typed-result');
    assert.deepEqual(json(value.evidence.retained),before);assert.deepEqual(f.raw,before);
    assert.equal(Object.keys(value.evidence.retained).length,6);
    assert.ok(Object.isFrozen(value.evidence.retained.completion.proof));
    assert.ok(Object.isFrozen(value.evidence.witness));
    assert.equal(Object.hasOwn(value,'payload'),false);assert.equal(Object.hasOwn(value,'issues'),false);
    assert.ok(Buffer.byteLength(JSON.stringify(value.evidence))<=8*1024*1024);
    assert.deepEqual(checkStored(value.evidence,expected(f)),value.evidence);
  }
});
for(const state of ['succeeded','failed','cancelled','running','unknown'])test(`terminal accounting refuses ${state}`,()=>{
  const f=fixture(state);refuse(()=>nonSuccess(f),'OUTCOME_UNCONFIRMED');
});
test('success API refuses typed non-success without publishing questions or issues',()=>{
  for(const state of ['needs-information','refused']) { const f=fixture(state);refuse(()=>success(f.raw,options(f)),'OUTCOME_UNCONFIRMED'); }
});
test('known non-success requires null payload and nonempty closed code/message issues',()=>{
  for(const mutate of [f=>{f.result.payload={type:'authorization'};f.result.payloadSha256=jcs(f.result.payload);},
    f=>{f.result.issues=[];},f=>{f.result.issues=null;},f=>{f.result.issues[0].extra=true;},
    f=>{f.result.issues[0].code=1;},f=>{f.result.issues[0].message=null;},f=>{f.result.issues[0].message=' ';}]){
    const f=fixture();mutate(f);reseal(f);refuse(()=>nonSuccess(f));
  }
});
for(const field of ['generationJobId','sourceAdmissionSha256','sourceRequestSha256','typedRequestSha256'])test(`native record ${field} cannot substitute source`,()=>{
  const f=fixture();f.raw.record[field]=field.endsWith('Sha256')?hex('9'):id(99);refuse(()=>nonSuccess(f));
});
test('every accepted binding field and native completion identity stays exact',()=>{
  for(const field of ['tenantId','actorId','conversationId','runId','attemptId','workerId','writerFence']){
    const f=fixture();f.raw.record.binding[field]=field==='writerFence'?2:id(99);refuse(()=>nonSuccess(f));
  }
  for(const field of ['completionId','checkpointId']){const f=fixture();f.raw.completion[field]=id(99);refuse(()=>nonSuccess(f));}
});
test('coherent hashes cannot replace original typed request/input/source/context/job/binding',()=>{
  for(const field of ['requestId','jobId','requestSha256','inputSha256','sourceSha256','contextSha256','basisSha256']){
    const f=fixture();f.result[field]=field.endsWith('Sha256')?hex('9'):id(99);reseal(f);refuse(()=>nonSuccess(f));
  }
  const f=fixture();f.result.binding.actorId=id(99);reseal(f);refuse(()=>nonSuccess(f));
});
test('native execution receipt cannot be replaced, even in both mirror and raw bytes',()=>{
  for(const field of ['provider','model','receiptRef','receiptSha256','bindingSha256']){
    const f=fixture();f.result.execution[field]=field.endsWith('Sha256')?hex('9'):id(99);
    storeResult(f,{observation:false});refuse(()=>nonSuccess(f));
  }
  const f=fixture();f.result.execution.receiptSha256=hex('9');f.raw.completion.typedResult.execution.receiptSha256=hex('9');
  storeResult(f,{observation:false});refuse(()=>nonSuccess(f));
});
test('semantic result/null payload/raw file hashes remain separate and all verified',()=>{
  const f=fixture();assert.notEqual(f.result.resultSha256,f.raw.file.object.sha256);
  f.result.payloadSha256=hex('9');reseal(f);refuse(()=>nonSuccess(f));
  const g=fixture();g.result.resultSha256=jcs(g.result);storeResult(g,{semantic:false});refuse(()=>nonSuccess(g));
  const h=fixture();h.raw.file.object.sha256=h.result.resultSha256;refuse(()=>nonSuccess(h));
});
test('fixed file path, unique manifest, immutable version and exact raw bytes refuse drift',()=>{
  for(const mutate of [f=>{f.raw.file.path='../result.json';},f=>{f.raw.file.object.versionId=null;},
    f=>{f.raw.file.object.versionId='null';},f=>{f.raw.file.object.bytes++;},f=>{f.raw.file.object.bytes=2_097_153;},
    f=>{f.raw.file.base64=f.raw.file.base64.slice(4);},f=>{f.raw.completion.proof.files.workspace.entries=[];}]){
    const f=fixture();mutate(f);refuse(()=>nonSuccess(f));
  }
});
test('completion stays within original admission/request/acceptance expiry and current observation',()=>{
  for(const at of [999_999,1_009_999,1_019_999,1_800_000,2_000_000,3_000_000]){
    const f=fixture();f.result.completedAtMs=at;reseal(f);refuse(()=>nonSuccess(f),'SOURCE_STALE');
  }
  const f=fixture();f.nowMs=1_029_999;refuse(()=>nonSuccess(f),'OUTCOME_UNCONFIRMED');
  for(const now of [NaN,Infinity,-1,1.5]){const g=fixture();g.nowMs=now;refuse(()=>nonSuccess(g));}
});
test('fresh authorized accounting and stored reconstruction never renew original effects',()=>{
  const f=fixture(),first=nonSuccess(f);f.nowMs=5_000_000;
  assert.deepEqual(nonSuccess(f),first);assert.deepEqual(checkStored(first.evidence,expected(f)),first.evidence);
  assert.equal(first.evidence.witness.completedAtMs,1_030_000);
  assert.equal(Object.hasOwn(first.evidence.retained,'checkedAtMs'),false);
  assert.equal(Object.hasOwn(first.evidence.retained,'expiresAtMs'),false);
});
test('stored outcome, every witness pin and original bytes are reverified',()=>{
  const f=fixture(),e=nonSuccess(f).evidence;
  for(const field of Object.keys(e.witness)){
    const changed=copy(e);changed.witness[field]=typeof changed.witness[field]==='number'?0:'different';
    refuse(()=>checkStored(changed,expected(f)));
  }
  const changed=copy(e);changed.outcome='refused';refuse(()=>checkStored(changed,expected(f)));
  const corrupt=copy(e);corrupt.retained.file.base64=corrupt.retained.file.base64.slice(4);refuse(()=>checkStored(corrupt,expected(f)));
});
test('closed evidence/native read/result/witness refuse extra public fields',()=>{
  const f=fixture(),e=nonSuccess(f).evidence;
  for(const field of ['questions','payload','expiresAtMs'])refuse(()=>checkStored({...e,[field]:[]},expected(f)));
  for(const target of ['outer','record','completion','file','result']){
    const g=fixture();(target==='result'?g.result:target==='outer'?g.raw:g.raw[target]).extra=true;
    if(target==='result')reseal(g);refuse(()=>nonSuccess(g));
  }
});
test('wire getters/proxies/custom JSON/cycles/invalid values are refused before invocation',()=>{
  let calls=0;const f=fixture();Object.defineProperty(f.raw,'completion',{enumerable:true,get(){calls++;throw Error('unexpected');}});refuse(()=>nonSuccess(f));
  for(const value of [new Proxy({}, {ownKeys(){calls++;throw Error('unexpected');}}),new Date(0),new Array(2),
    {toJSON(){calls++;throw Error('unexpected');}},{x:NaN},{x:'\ud800'}]){
    const g=fixture();g.raw.completion=value;refuse(()=>nonSuccess(g));
  }
  const g=fixture();g.raw.self=g.raw;refuse(()=>nonSuccess(g));assert.equal(calls,0);
});
test('oversized private terminal bytes refuse rather than truncating issues',()=>{
  const f=fixture();f.result.issues[0].message='x'.repeat(2_097_153);reseal(f);refuse(()=>nonSuccess(f));
});
test('non-success witness hashes null payload and original native execution/file domains',()=>{
  const f=fixture(),w=nonSuccess(f).evidence.witness;
  assert.equal(w.payloadSha256,jcs(null));assert.equal(w.corePayloadSha256,applicationHash(null));
  assert.equal(w.executionSha256,jcs(f.result.execution));assert.equal(w.checkpointSha256,f.raw.completion.proof.checkpointSha256);
  assert.equal(w.rawFileSha256,f.raw.file.object.sha256);assert.equal(w.completionId,f.acceptance.sourceBinding.runId);
});
test('initial candidate refuses regeneration; success API keeps only payload and immutable witness',()=>{
  const f=fixture();f.admission.expectedStrategyVersionId=id(99);refuse(()=>nonSuccess(f),'AUTHORITY_UNAVAILABLE');
  const g=fixture('succeeded'),v=success(g.raw,options(g));
  assert.deepEqual(Object.keys(v),['payload','witness']);assert.deepEqual(checkWitness(v.witness,expected(g)),v.witness);
});
