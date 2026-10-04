// Local synthetic tests only; no child CLI, database, cloud, journal or provider.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PIN, stableHash, validateInput, sequence } from './case14-postapproval-inner-v1.mjs';
const now = Date.parse('2026-10-04T04:25:00.000Z');
const run = '11111111-1111-4111-8111-111111111111';
const itemId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const ownerBody = { kind:'meri-case14-current-memory-owner', schemaVersion:1, caseId:'14', fixtureNamespace:PIN.namespace,
  fixtureVersion:'meri-live-v1-2026-09-26.1', fixtureInstanceId:PIN.fixtureInstanceId, manifestContentSha256:PIN.manifestContentSha256,
  recipeSha256:PIN.recipeSha256, seedPlanSha256:PIN.seedPlanSha256, setupReceiptSha256:PIN.setupReceiptSha256,
  tenantId:PIN.tenantId, clientId:PIN.clientId, proposerUserId:PIN.proposerId, reviewerUserId:PIN.reviewerId,
  reviewerRole:'user_admin', logicalSourceId:'MEM-PROPOSAL-14', candidateId:PIN.candidateId, candidateRowVersion:'123',revision:1,
  ownershipMarkerSha256:PIN.ownershipMarkerSha256,payloadSha256:PIN.payloadSha256,text:'Synthetic Aster candidate for approval',state:'approved',
  item:{id:itemId,clioMemoryId:'44444444-4444-4444-8444-444444444444',rowVersion:'123',sourceVersion:'candidate:'+PIN.candidateId,
    contentSha256:'d'.repeat(64),status:'active',governedStatus:'active'},
  decision:{transitionAuditId:'55555555-5555-4555-8555-555555555555',actorUserId:PIN.reviewerId,decision:'approved'} };
const input = {kind:'case14-postapproval-native-setup-input',version:1,sourceSha:PIN.source,captureRunId:run,
  ctx:{tenantId:PIN.tenantId,tenantSlug:PIN.tenantSlug,userId:PIN.reviewerId,clerkUserId:PIN.reviewerClerkId,role:'user_admin'},
  clientId:PIN.clientId,approvalEvidenceSha256:'e'.repeat(64), approvedOwner:{...ownerBody,currentVerifySha256:stableHash(ownerBody)},
  limits:{maxAttempts:32,maxTokens:500000,maxCostMicros:14000000},
  rateEvidence:JSON.parse(readFileSync(new URL('./reviewed-rates-retained.json',import.meta.url),'utf8'))};
const seal = v => ({...v,contentSha256:stableHash(v)});
const sourceMap = {'MEM-PROPOSAL-14':{frozenFixtureId:'MEM-PROPOSAL-14',kind:'memory',physicalId:itemId,
  tenantPhysicalId:PIN.tenantId,clientPhysicalId:PIN.clientId,version:'candidate:'+PIN.candidateId}};
const planBody={kind:'meri-case14-recall-binding-plan',schemaVersion:1,caseId:'14',captureRunId:run,tenantId:PIN.tenantId,
  actorUserId:PIN.reviewerId,clientId:PIN.clientId,tenantRowVersion:'200',priorSettingsSha256:'f'.repeat(64),
  approvedOwnerSha256:input.approvedOwner.currentVerifySha256,physicalMapSha256:stableHash(sourceMap),sharedCorpusWrites:0,approvalDecisions:0,liveAcceptance:'NOT_RUN'};
const plan={...planBody,planSha256:stableHash(planBody)};
const seed=seal({schemaVersion:1,contractVersion:'synthetic-test-only',kind:'meri-synthetic-fixture-seed-receipt',owner:'meri_case14_canonical_approval_v1',
  operationId,tenantId:PIN.tenantId,actorUserId:PIN.reviewerId,clientId:PIN.clientId,caseId:'14',captureRunId:run,
  approvedOwnerSha256:input.approvedOwner.currentVerifySha256,physicalMapSha256:stableHash(sourceMap),setupReceiptSha256:PIN.setupReceiptSha256,
  transitionAuditId:ownerBody.decision.transitionAuditId});
const reset=seal({schemaVersion:1,contractVersion:'synthetic-test-only',kind:'meri-synthetic-fixture-reset-receipt',owner:seed.owner,operationId,
  scope:'replace_owned_capture_binding_only_after_canonical_approval',priorSettingsSha256:plan.priorSettingsSha256,sharedCorpusWrites:0});
const binding={caseId:'14',captureRunId:run,fixtureVersion:ownerBody.fixtureVersion,physicalMapSha256:stableHash(sourceMap),
  seedReceiptId:'meri-synthetic-fixture-seed-receipt:sha256:'+seed.contentSha256,resetReceiptId:'meri-synthetic-fixture-reset-receipt:sha256:'+reset.contentSha256,
  fixtureNamespace:PIN.namespace,actorUserId:PIN.reviewerId,clientId:PIN.clientId,currentVerifySha256:stableHash({kind:'meri-case14-current-approved-source',
    schemaVersion:1,canonicalOwner:input.approvedOwner,seedReceiptSha256:seed.contentSha256,resetReceiptSha256:reset.contentSha256})};
const bind={status:'CASE14_RECALL_BOUND',operationId,binding,sourceMap,seedReceipt:seed,resetReceipt:reset,sharedCorpusWrites:0,
  approvalDecisions:0,synthesisSubmissionCount:0,liveAcceptance:'NOT_RUN'};
const budgetPlan={status:'READY_FOR_RATE_QUALIFICATION',caseId:'14',captureRunId:run,currentVerifySha256:binding.currentVerifySha256,
  captureBindingSha256:stableHash(binding),priorQualificationSha256:stableHash(null),tenantRowVersion:'201',liveAcceptance:'NOT_RUN'};
const frames=[],calls=[];
function nativeMock(stage,body){
  calls.push(stage.name);
  let result = {'recall-plan':plan,'recall-bind':bind,'budget-plan':budgetPlan}[stage.name];
  if(stage.name==='recall-bind'){assert.equal(body.expectedPlanSha256,plan.planSha256);assert.equal(body.confirmation,'BIND_EXISTING_CASE14_CANONICAL_APPROVAL');}
  if(stage.name==='budget-install'){
    assert.equal(body.caseId,'14');assert.equal(body.ctx.role,'user_admin');
    assert.equal(body.expectedCurrentVerifySha256,budgetPlan.currentVerifySha256);assert.equal(body.expectedCaptureBindingSha256,budgetPlan.captureBindingSha256);
    assert.equal(body.expectedPriorQualificationSha256,budgetPlan.priorQualificationSha256);assert.equal(body.expectedTenantRowVersion,'201');
    result={status:'PROVIDER_QUALIFICATION_INSTALLED',tenantId:PIN.tenantId,clientId:PIN.clientId,captureRunId:run,
      currentVerifySha256:body.expectedCurrentVerifySha256,captureBindingSha256:body.expectedCaptureBindingSha256,
      priorQualificationSha256:body.expectedPriorQualificationSha256,qualificationSha256:stableHash(body.qualification),tenantRowVersion:'202',
      maxCostMicros:input.limits.maxCostMicros,rateEvidenceSha256:PIN.rateEvidenceSha256,rateEvidenceExpiresAt:PIN.rateEvidenceExpiresAt,liveAcceptance:'NOT_RUN'};
  }
  return {status:0,bytes:Buffer.from(JSON.stringify(result)+'\n')};
}
const passed=[];
const success=await sequence(input,nativeMock,x=>frames.push(x),()=>now);
assert.equal(success.status,'RECALL_BOUND_AND_BUDGET_INSTALLED');assert.deepEqual(calls,['recall-plan','recall-bind','budget-plan','budget-install']);
assert.equal(frames.filter(x=>x.phase==='RECEIPT').length,4);passed.push('four ordered native phases, exact binding plan and four fresh install fences');
for(const [name,mutate] of [['wrong role',x=>x.ctx.role='standard_user'],['wrong candidate',x=>x.approvedOwner.candidateId=run],
 ['changed rates',x=>x.rateEvidence.rates[0].inputMicrosPerMillion=1],['extended expiry',x=>x.rateEvidence.expiresAt='2027-01-01T00:00:00Z'],
 ['wrong owner hash',x=>x.approvedOwner.currentVerifySha256='0'.repeat(64)],['overspend',x=>x.limits.maxCostMicros=15000001]]){
 const changed=structuredClone(input);mutate(changed);assert.throws(()=>validateInput(changed,now));passed.push('reject '+name);
}
assert.throws(()=>validateInput(input,Date.parse(PIN.rateEvidenceExpiresAt)-44*60000));passed.push('reject insufficient unchanged rate lifetime');
for(const failureStage of ['recall-plan','recall-bind','budget-plan','budget-install']){
 const observed=[],seen=[];
 await assert.rejects(sequence(input,(s,b)=>{seen.push(s.name);return s.name===failureStage?{status:null,bytes:null}:nativeMock(s,b);},x=>observed.push(x),()=>now));
 assert.equal(seen.at(-1),failureStage);assert.equal(new Set(seen).size,seen.length);
 assert.equal(observed.filter(x=>x.phase==='RECEIPT').length,seen.length-1);assert.equal(observed.at(-1).phase,'FAILURE');
 if(seen.includes('recall-bind'))assert.equal(observed.at(-1).effectStatus,'RECONCILE_PARTIAL_NATIVE_SETUP_NO_RETRY');
 passed.push('stop once and retain completed receipts after '+failureStage+' unknown failure');
}
const mismatchFrames=[];let mismatchCalls=0;
await assert.rejects(sequence(input,(s,b)=>{mismatchCalls++;const r=nativeMock(s,b);if(s.name==='recall-plan'){
 const wrong=JSON.parse(r.bytes);wrong.approvedOwnerSha256='0'.repeat(64);const {planSha256,...p}=wrong;wrong.planSha256=stableHash(p);r.bytes=Buffer.from(JSON.stringify(wrong));}return r;},x=>mismatchFrames.push(x),()=>now));
assert.equal(mismatchCalls,1);passed.push('wrong live approved owner blocks binding before write');
console.log(JSON.stringify({preparedBy:'Codex',status:'PASS',tests:passed.length,checks:passed,execution:'LOCAL_SYNTHETIC_ONLY',cloudCalls:0,databaseCalls:0,providerCalls:0,journalMutations:0},null,2));
