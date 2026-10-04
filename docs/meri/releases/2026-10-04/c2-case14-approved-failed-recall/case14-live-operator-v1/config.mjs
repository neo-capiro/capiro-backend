// Pure configuration builders. Native authorities are required by the actual collectors.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sha256Stable} from '../../../meri-c1-20261002/evals/meri/live-v1/artifact-collector.mjs';
import {inspectCase14ApprovalScope} from '../../../meri-c1-20261002/evals/meri/live-v1/case14-approval-capture.mjs';
import {inspectCase14RecallScope} from '../../../meri-c1-20261002/evals/meri/live-v1/case01-live-capture.mjs';
const SOURCE='c0f393f863bf73bd4e65e7a94e17c073e7be021e';
export function makeApprovalConfig(captureRunId,recipe,priorDeployment,qualification){
 assert.equal(recipe.fixtureInstanceId,'dee4e90e-8e91-4782-9488-10b8e52a2146');
 assert.equal(sha256Stable(recipe),'1668649c84550f701faea8e30617da11c944c84caeb99965afa311acd017e593');
 const deployment=structuredClone(priorDeployment),service='meriv2-orchestrator';
 assert.equal(deployment.apiSha,SOURCE);assert.equal(deployment.webSha,SOURCE);assert.equal(qualification.sourceSha,SOURCE);
 deployment.orchestratorSha=SOURCE;
 deployment.builds[service]={service,sourceSha:SOURCE,imageDigest:qualification.candidates[service].image.split('@')[1],buildId:qualification.builds[service].buildId,buildspecSha256:qualification.builds[service].buildspecSha256};
 return inspectCase14ApprovalScope({schemaVersion:1,caseId:'14',target:'https://os.capiro.ai',captureRunId,recipe:structuredClone(recipe),
  reviewer:{tenantId:'f2d6cf8f-057c-479a-8110-62fe5086d43f',tenantSlug:'meri-foundation-20260928-t1',userId:'fb218bf5-2674-4ced-bca3-7a5d0c01592f',clerkUserId:'user_3Jw2G2jbyyDlrrg6zCNd4gYUDfH',role:'user_admin'},
  clerkOrganizationId:'org_3Jw2G4KLYzp2j3xg0OXhyvbItRM',deployment,limits:{concurrency:1,maxApprovalSubmissions:1,maxSynthesisSubmissions:0}});
}
export function makeRecallConfig(approvalConfig,verifiedNativeSetup,conversation,contract){
 const a=approvalConfig,b=verifiedNativeSetup.value.results['recall-bind'];
 assert.equal(verifiedNativeSetup.value.captureRunId,a.captureRunId);assert.equal(b.status,'CASE14_RECALL_BOUND');
 assert.equal(conversation.captureRunId,a.captureRunId);assert.equal(conversation.actorUserId,a.reviewer.userId);
 assert.equal(conversation.tenantId,a.reviewer.tenantId);assert.equal(conversation.clientId,a.recipe.clients.ASTER.physicalId);
 const config={schemaVersion:1,provenance:'LIVE_CAPTURE',caseId:'14',captureRunId:a.captureRunId,conversationId:conversation.conversationId,
  target:{apiOrigin:'https://os.capiro.ai',environment:'capiro-dev'},limits:{concurrency:1,deadlineMs:900000,maxSpendUsd:14},
  contract:{fixtureSha256:contract.fixtureSha256,contractSourceSha256:contract.contractSourceSha256},
  fixture:{version:b.binding.fixtureVersion,namespace:'meri-foundation-20260928',sha256:contract.fixtureSha256,mappingSha256:sha256Stable(b.sourceMap),seedReceiptId:b.binding.seedReceiptId,resetReceiptId:b.binding.resetReceiptId},
  scope:{actors:{PRIYA:{role:'user_admin',tenantPhysicalId:a.reviewer.tenantId,userId:a.reviewer.userId,clerkUserId:a.reviewer.clerkUserId}},
   tenants:{T1:{physicalId:a.reviewer.tenantId,slug:a.reviewer.tenantSlug}},clients:{ASTER:{tenantPhysicalId:a.reviewer.tenantId,physicalId:a.recipe.clients.ASTER.physicalId}},sources:structuredClone(b.sourceMap)},deployment:structuredClone(a.deployment)};
 inspectCase14RecallScope(config,{MERI_LIVE_BEARER_TOKEN:'LOCAL_STATIC_SHAPE_CHECK_NOT_A_TOKEN'});return config;
}
