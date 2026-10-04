// Local synthetic tests only; no child CLI, database, cloud, journal or provider.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PIN, stableHash, validateInput, sequence } from '../case14-postapproval-preparation-v2/case14-postapproval-inner-v2.mjs';
import {expectedProjection,validateProjectionSnapshot} from '../case14-approval-cost-supervision-v2/projection-terminal-inner-v1.mjs';
const now = Date.parse('2026-10-04T05:15:00.000Z');
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
  approvalWindow:{startedAtMs:now-1000,deadlineAtMs:now+14*60000},
  limits:{maxAttempts:32,maxTokens:500000,maxCostMicros:14000000},
  rateEvidence:JSON.parse(readFileSync(new URL('../case14-postapproval-preparation-v2/reviewed-rates-retained.json',import.meta.url),'utf8'))};
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
    assert.equal(body.caseId,'14');assert.equal(body.ctx.role,'user_admin');assert.equal(body.qualification.maxCostMicros,14000000);
    assert.equal(body.expectedCurrentVerifySha256,budgetPlan.currentVerifySha256);assert.equal(body.expectedCaptureBindingSha256,budgetPlan.captureBindingSha256);
    assert.equal(body.expectedPriorQualificationSha256,budgetPlan.priorQualificationSha256);assert.equal(body.expectedTenantRowVersion,'201');
    result={status:'PROVIDER_QUALIFICATION_INSTALLED',tenantId:PIN.tenantId,clientId:PIN.clientId,captureRunId:run,
      currentVerifySha256:body.expectedCurrentVerifySha256,captureBindingSha256:body.expectedCaptureBindingSha256,
      priorQualificationSha256:body.expectedPriorQualificationSha256,qualificationSha256:stableHash(body.qualification),tenantRowVersion:'202',
      maxCostMicros:input.limits.maxCostMicros,rateEvidenceSha256:PIN.rateEvidenceSha256,rateEvidenceExpiresAt:PIN.rateEvidenceExpiresAt,liveAcceptance:'NOT_RUN'};
  }
  return {status:0,bytes:Buffer.from(JSON.stringify(result)+'\n')};
}
function projectMock(p,emit){
 const e=expectedProjection(),stamp=new Date(now).toISOString(),clioId=p.approvedOwner.item.clioMemoryId;
 const proof=validateProjectionSnapshot(p,{canonicalOwner:p.approvedOwner,
  clio:[{id:clioId,tenantId:PIN.tenantId,clientId:PIN.clientId,ownerUserId:null,scope:'client',key:e.title,value:e.value,source:'meri_synthetic_fixture',createdAt:stamp,updatedAt:stamp,hasLegacyEmbedding:true,legacyDimensions:1536}],
  items:[{id:itemId,tenantId:PIN.tenantId,clientId:PIN.clientId,ownerUserId:null,status:'active',governedStatus:'active',sourceVersion:ownerBody.item.sourceVersion,sourceContentHash:ownerBody.item.contentSha256,rowVersion:'123',slug:'clio:'+clioId,title:e.title,sections:e.sections}],
  embeddings:[{tenantId:PIN.tenantId,clientId:PIN.clientId,ownerUserId:null,sourceType:'memory_item',sourceId:itemId,model:'amazon.titan-embed-text-v2:0',contentHash:e.projectionTextSha256,contentText:e.text,hasEmbedding:true,dimensions:1024,createdAt:stamp,updatedAt:stamp}],
  jobs:[{id:operationId,tenantId:PIN.tenantId,memoryItemId:itemId,clioMemoryId:clioId,operation:'index_memory_item',idempotencyKey:`index_memory_item:${clioId}:${stamp}:${e.projectionTextSha256}`,status:'completed',attempts:0,createdAt:stamp,completedAt:stamp,lastError:null,expectedSourceVersion:stamp,expectedContentHash:e.projectionTextSha256,leaseOwner:null,leaseExpiresAt:null}]},now);
 emit({phase:'TERMINAL',proof});return proof;
}

export {input,now,nativeMock,projectMock};
