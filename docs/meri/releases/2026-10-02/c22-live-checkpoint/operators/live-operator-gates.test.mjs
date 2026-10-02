import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BASE,RELEASE_SOURCE,WEB_SOURCE,inspectBuildReadback,assertDocsOnly,assertSameRelease,readPriorCase17,inspectCase01Inputs,stableHash} from './live-operator-gates.mjs';
const hash='a'.repeat(64),spec='b'.repeat(64),now=Date.UTC(2026,9,2,10,0,0);
const mutate=(value,callback)=>{const changed=structuredClone(value);callback(changed);return changed;};
function readback(){return {service:'api',verdict:'PASS',buildStatus:'SUCCEEDED',sourceSha:RELEASE_SOURCE,resolvedSourceSha:RELEASE_SOURCE,
actualBuildspecSha256:spec,buildId:'capiro-build-web-dev:3498c216-5032-4b14-9c98-71790ffafbc0',imageDigest:'sha256:'+hash,
image:'967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:'+hash,observedAt:'2026-10-02T10:00:00Z',
phases:['PRE_BUILD','BUILD','POST_BUILD'].map(phase=>({phase,status:'SUCCEEDED'})),executedMarkers:[{line:'UNIT_ONLY_MARKER'}]};}
test('unit build evidence requires exact source, spec, immutable image and completed phases',()=>{
 assert.equal(inspectBuildReadback(readback(),'api',RELEASE_SOURCE,spec,['UNIT_ONLY_MARKER']).sourceSha,RELEASE_SOURCE);
 for(const change of [r=>r.verdict='NOT_RUN',r=>r.buildStatus='IN_PROGRESS',r=>r.sourceSha=WEB_SOURCE,r=>r.resolvedSourceSha=WEB_SOURCE,
 r=>r.actualBuildspecSha256=hash,r=>r.image=r.image.replace('/api@','/web-vnext@'),r=>r.phases[1].status='FAILED',r=>r.phases.push(r.phases[1]),r=>r.executedMarkers=[]])
  assert.throws(()=>inspectBuildReadback(mutate(readback(),change),'api',RELEASE_SOURCE,spec,['UNIT_ONLY_MARKER']));
});
test('documentation lineage only and immutable operator release binding',()=>{
 assert.doesNotThrow(()=>assertDocsOnly(['docs/meri/build.json','']));
 for(const paths of [['apps/api/src/main.ts'],['docs\\main.ts'],['package.json'],['docs/deleted.md','apps/renamed.ts']])assert.throws(()=>assertDocsOnly(paths));
 assert.doesNotThrow(()=>assertSameRelease({sourceSha:RELEASE_SOURCE},{sourceSha:RELEASE_SOURCE}));
 assert.throws(()=>assertSameRelease({sourceSha:RELEASE_SOURCE},{sourceSha:WEB_SOURCE}));
});
test('actual preserved three failed attempts and existing fixture receipt remain hash exact; local read only',()=>{
 const recipe=readPriorCase17();assert.equal(recipe.caseId,'17');assert.equal(recipe.ctx.role,'user_admin');
});
function case01(){
 const sourceMap={'MA1-v2':{physicalId:'unit-item',version:'memory-version:unit',kind:'memory'}};
 const binding={caseId:'01',captureRunId:'unit-run',physicalMapSha256:stableHash(sourceMap),currentVerifySha256:hash};
 const setup={kind:'meri-case01-execution-setup-receipt',schemaVersion:1,status:'SETUP_COMPLETE',synthesisSubmissionCount:0,
 captureRunId:'unit-run',conversationId:'unit-conversation',ctx:{userId:'unit-pat',tenantId:'unit-tenant',role:'standard_user'},clientId:'unit-client',
 binding,bindingSha256:stableHash(binding),currentVerifySha256:hash,seedReceiptId:'unit-seed',resetReceiptId:'unit-reset',sourceMap};
 const release={sourceSha:RELEASE_SOURCE,builds:{api:{sourceSha:RELEASE_SOURCE},'meriv2-orchestrator':{sourceSha:RELEASE_SOURCE}}};
 const config={caseId:'01',provenance:'LIVE_CAPTURE',captureRunId:setup.captureRunId,conversationId:setup.conversationId,
 scope:{actors:{PAT:{userId:'unit-pat'}},tenants:{T1:{physicalId:'unit-tenant'}},clients:{ASTER:{physicalId:'unit-client'}},sources:sourceMap},
 fixture:{mappingSha256:binding.physicalMapSha256,seedReceiptId:setup.seedReceiptId,resetReceiptId:setup.resetReceiptId},
 limits:{maxSpendUsd:3},deployment:{apiSha:RELEASE_SOURCE,orchestratorSha:RELEASE_SOURCE,builds:release.builds}};
 const installed={status:'PROVIDER_QUALIFICATION_INSTALLED',tenantId:'unit-tenant',clientId:'unit-client',captureRunId:setup.captureRunId,
 currentVerifySha256:hash,captureBindingSha256:setup.bindingSha256,qualificationSha256:hash,rateEvidenceSha256:hash,maxCostMicros:3000000,rateEvidenceExpiresAt:new Date(now+7200000).toISOString()};
 return {config,release,recovery:{status:'VERIFIED',mode:'setup-recovery-execute',sourceSha:RELEASE_SOURCE,containerExitCode:0,
 ownerReceipts:[{stage:'COMPLETE',phase:'VERIFIED',receipt:setup}]},budget:{status:'VERIFIED',mode:'budget-install',sourceSha:RELEASE_SOURCE,
 containerExitCode:0,ownerReceipts:[installed]},now};
}
test('unit-only successful recovery, installation and source joins permit configuration only',()=>{
 assert.equal(inspectCase01Inputs(case01()).owner.conversationId,'unit-conversation');
});
test('setup or budget failure, wrong mode or stale source blocks before authentication',()=>{
 for(const change of [r=>r.recovery.status='RECONCILIATION_REQUIRED',r=>r.recovery.mode='setup-execute',r=>r.recovery.sourceSha=WEB_SOURCE,
 r=>r.budget.containerExitCode=1,r=>r.budget.ownerReceipts=[],r=>r.recovery.ownerReceipts.push(r.recovery.ownerReceipts[0])])
  assert.throws(()=>inspectCase01Inputs(mutate(case01(),change)));
});
test('foreign conversation, actor, physical source and current owner/binding all fail',()=>{
 for(const change of [r=>r.config.conversationId='foreign',r=>r.config.scope.actors.PAT.userId='foreign',r=>r.config.scope.sources['MA1-v2'].physicalId='foreign',
 r=>r.budget.ownerReceipts[0].currentVerifySha256='f'.repeat(64),r=>r.budget.ownerReceipts[0].captureBindingSha256='f'.repeat(64),
 r=>r.config.fixture.seedReceiptId='foreign',r=>r.config.deployment.orchestratorSha=WEB_SOURCE])
  assert.throws(()=>inspectCase01Inputs(mutate(case01(),change)));
});
test('explicit three dollar bound and rate lifetime covering the whole signed policy',()=>{
 for(const change of [r=>r.config.limits.maxSpendUsd=3.01,r=>r.config.limits.maxSpendUsd=0,r=>r.budget.ownerReceipts[0].maxCostMicros=2000000,
 r=>r.budget.ownerReceipts[0].rateEvidenceExpiresAt=new Date(now+1799999).toISOString()])assert.throws(()=>inspectCase01Inputs(mutate(case01(),change)));
});
test('operators retain no-send17 and single source-owned01 call with cleanup before offline grading',()=>{
 const c17=readFileSync(BASE+'/run-case17-authenticated-v4.mjs','utf8'),c01=readFileSync(BASE+'/run-case01-authenticated-v2.mjs','utf8');
 assert.match(c17,/storage\.init\(/);assert.match(c17,/originalPromptSubmission:'NOT_RUN'/);assert.match(c17,/fullOriginalRow17Acceptance:false/);
 assert.equal((c17.match(/await collectCase17LiveCapture\(/g)||[]).length,1);assert.doesNotMatch(c17,/\.send\(|executeCase01LiveCapture/);
 assert.equal((c01.match(/await executeCase01LiveCapture\(/g)||[]).length,1);assert.doesNotMatch(c01,/\.fill\(|\.click\(/);
 assert(c01.indexOf('await revokeOwned();')<c01.indexOf("const command=await new Promise"));
 assert.match(c01,/nativeExecutionInvoked\?null:0/);assert.match(c01,/readCase01Inputs\(release\)/);
});
