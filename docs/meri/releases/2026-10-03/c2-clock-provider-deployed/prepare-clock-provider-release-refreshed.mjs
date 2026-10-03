// Read-only preparation of a concrete unsigned release packet. No human approval is inferred.
import {readFileSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {releaseOperator} from '../../meri-c1-20261002/scripts/meri-release.mjs';
import {candidateTask,fingerprint,taskInput} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const [evidenceCommit]=process.argv.slice(2);assert.match(evidenceCommit??'',/^[a-f0-9]{40}$/);
const root='C:/dev/main/outputs/meri-c2-20261003',repo='C:/dev/main/meri-c1-20261002';
const arc='docs/meri/releases/2026-10-03/c2-clock-provider-release/';
const versioned=name=>JSON.parse(execFileSync('git',['show',evidenceCommit+':'+arc+name],{cwd:repo,encoding:'utf8',windowsHide:true}));
const save=(name,value)=>{const fd=openSync(root+'/'+name,'wx');try{writeFileSync(fd,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}};
const qualification=versioned('release-qualification.json'),review=versioned('release-independent-review.json'),baseline=versioned('served-baseline.json');
assert.equal(qualification.status,'AUTOMATED_QUALIFICATION_PASSED_HUMAN_RELEASE_REVIEW_PENDING');
assert.equal(qualification.humanApproval,null);assert.equal(qualification.schemaChange,false);
assert.equal(qualification.currentSchema.status,'VERIFIED_READ_ONLY');assert.equal(review.result,'PASS');assert.equal(review.humanReleaseApproval,false);
assert.equal(aws(['sts','get-caller-identity']).Arn,'arn:aws:iam::967807252336:user/capirocli');
const operator=releaseOperator({aws}),services=[];
for(const service of ['api','meriv2-orchestrator','web-vnext']){
  const live=await operator.snapshot(service),expected=baseline.services.find(s=>s.service===service);
  assert.deepEqual(live.baseline,expected.baseline,service+' baseline drift');
  const c=live.task.containerDefinitions.find(c=>c.name===service);
  const sourceSha=c.environment.find(e=>e.name==='RELEASE_SHA')?.value??c.environment.find(e=>e.name==='GIT_SHA')?.value;
  assert.equal(sourceSha,expected.sourceSha);
  if(service==='web-vnext'){services.push({service,change:'NONE',sourceSha,image:c.image,baseline:live.baseline});continue;}
  const candidate=qualification.candidates[service];
  const buildPath='builds/'+service+'/build-readback.json',build=versioned(buildPath);
  assert.equal(build.status,'SUCCEEDED');assert.equal(build.qualification,'IMMUTABLE_BUILD_AND_OFFLINE_PROBES_PASS');
  assert.equal(build.sourceSha,candidate.sourceSha);assert.equal(build.image,candidate.image);
  for(const id of ['imageTag='+candidate.sourceSha,'imageDigest='+candidate.image.split('@')[1]]){
    const details=aws(['ecr','describe-images','--repository-name','capiro/dev/'+service,'--image-ids',id]).imageDetails;
    assert.equal(details.length,1);assert.equal(details[0].imageDigest,candidate.image.split('@')[1]);
  }
  const rollbackImage='967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/'+service+'@'+live.baseline.imageDigest;
  const rollback=aws(['ecr','describe-images','--repository-name','capiro/dev/'+service,'--image-ids','imageDigest='+live.baseline.imageDigest]).imageDetails;
  assert.equal(rollback.length,1);assert.equal(rollback[0].imageDigest,live.baseline.imageDigest);
  services.push({service,change:'IMAGE_AND_RELEASE_IDENTITY_ONLY',candidate,baseline:live.baseline,candidateTaskSha256:fingerprint(candidateTask(live.task,service,candidate.image,candidate.sourceSha)),rollbackImage,rollbackTaskSha256:fingerprint(candidateTask(live.task,service,rollbackImage)),configurationPreserved:true,buildEvidence:buildPath});
}
const nightly=baseline.retainedNightly;
const rule=aws(['events','describe-rule','--name',nightly.rule]);assert.equal(fingerprint(rule),nightly.ruleSha256);
const targets=aws(['events','list-targets-by-rule','--rule',nightly.rule]);assert.equal(targets.Targets.length,1);assert.equal(targets.NextToken,undefined);assert.equal(fingerprint(targets.Targets[0]),nightly.targetSha256);
assert.equal(targets.Targets[0].EcsParameters.TaskDefinitionArn,nightly.taskDefinition);
const td=aws(['ecs','describe-task-definition','--task-definition',nightly.taskDefinition,'--include','TAGS']);assert.equal(td.taskDefinition.status,'ACTIVE');
assert.equal(fingerprint(taskInput({...td.taskDefinition,tags:td.tags})),nightly.taskInputSha256);
assert.equal(aws(['events','describe-rule','--name','capiro-dev-memory-projection-worker']).State,'DISABLED');
const prefix='https://github.com/neo-capiro/capirov2/blob/'+evidenceCommit+'/'+arc;
const packet={kind:'C2 clock and provider exact release review packet',version:1,status:'AWAITING_HUMAN_REVIEW',preparedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60*60000).toISOString(),evidenceCommit,evidence:[prefix+'README.md',prefix+'release-qualification.json',prefix+'release-independent-review.json'],qualificationSha256:fingerprint(qualification),services,retainedNightly:nightly,
  executionOrder:['Promote the exact API image and verify all running tasks and ALB targets with unchanged configuration','Promote the exact orchestrator image and verify all running tasks and ALB targets with unchanged configuration','Read back the served pair, retained nightly136, disabled broad worker and unchanged sibling WebVNext388'],
  changeWindow:'One attended release owner from preparation through acceptance/rollback; concurrent service, autoscaling or configuration changes invalidate the baseline and require reconciliation.',
  rollback:{application:'Use the exact current API517 and orchestrator113 image digests listed per service.',database:'Retain migration452 and both existing additive indexes; no migration is run.',memory:'Retain completed cleanup and audit receipts, guarded nightly136 and the disabled broad worker. No fixture reset or replay.'},
  scope:{schemaChange:false,modelConfigurationChange:false,providerConfigurationChange:false,featureFlagChange:false,nightlyChange:false,webChange:false,capacityChange:false,newProviderCalls:0,newCaptureAuthority:false,captureBindingWrite:false,budgetInstallation:false,journalMutation:false},
  subsequentC2:'After this release, continue separately authorized C2 native capture preparation within the existing budget. Canonical binding, rate installation, spend reservation, served joins and human rubric remain separate checks; this packet does not claim them complete.',
  acceptance:{original75:0,cd:0,cw:0},awsWrites:0,humanReleaseApproval:null,deployableManifest:false,
  approvalRequirement:'docs/meri/deployment-prerequisite.md: Qualification is an explicit human-reviewed attestation.'};
const approvedPacket=JSON.parse(readFileSync(root+'/clock-provider-release-packet.json','utf8'));
const approval=JSON.parse(readFileSync(root+'/clock-provider-human-approval.json','utf8'));
assert.equal(approval.status,'APPROVED');assert.equal(approval.scope,'EXACT_C2_CLOCK_PROVIDER_RELEASE');
assert.equal(approval.packetSha256,fingerprint(approvedPacket));
assert.deepEqual({...packet,preparedAt:approvedPacket.preparedAt,expiresAt:approvedPacket.expiresAt},approvedPacket,'Approved release scope changed');
const currentSchema=JSON.parse(readFileSync(root+'/clock-provider-current-schema-v2/result.json','utf8'));
const cleanup=JSON.parse(readFileSync(root+'/clock-provider-current-schema-v2/cleanup.json','utf8'));
assert.equal(currentSchema.exitCode,0);assert.equal(currentSchema.receipts.length,1);assert.equal(currentSchema.receipts[0].status,'VERIFIED_READ_ONLY');
assert.ok(Date.parse(currentSchema.at)>Date.now()-30*60000);assert.equal(cleanup.taskStopped,true);assert.equal(cleanup.status,'INACTIVE');
const oldSchema=versioned('current-schema/result.json');assert.deepEqual(currentSchema.receipts[0],oldSchema.receipts[0]);
save('clock-provider-release-packet-refreshed.json',packet);
save('clock-provider-release-refresh.json',{status:'IDENTICAL_APPROVED_SCOPE_REVALIDATED',recordedAt:new Date().toISOString(),
  originalPacketSha256:fingerprint(approvedPacket),refreshedPacketSha256:fingerprint(packet),humanApprovalSha256:fingerprint(approval),
  changes:['preparedAt','expiresAt'],scopeChanged:false,candidateChanged:false,baselineChanged:false,configurationChanged:false,
  currentSchemaPath:'clock-provider-current-schema-v2/result.json',currentSchemaSha256:fingerprint(currentSchema),
  freshCloudImageAndBaselineChecks:true,originalSnapshotExpiryBypassed:false,
  approvalBasis:'Direct human approval of the exact original scope; successor changes freshness timestamps only.',awsWritesByPacketPreparation:0});
const digest=fingerprint(packet);
save('clock-provider-release-packet-refreshed.md',`# C2 clock and provider release review\n\nThe proposed API and orchestrator images passed native builds, packaged checks and independent technical review. They have not been deployed. [Versioned evidence](${prefix}README.md).\n\nPacket fingerprint: \`${digest}\`. Expires ${packet.expiresAt}.\n\n| Service | Source | Exact image digest | Current rollback digest |\n| --- | --- | --- | --- |\n${services.filter(s=>s.candidate).map(s=>`| ${s.service} | \`${s.candidate.sourceSha}\` | \`${s.candidate.image.split('@')[1]}\` | \`${s.rollbackImage.split('@')[1]}\` |`).join('\n')}\n\nThe release adds the qualified original-fixture clock and guards that bind native capture pricing to final provider request bytes, output limits, endpoints and Standard service tier. The orchestrator source differs from the API source only by a test correction and evidence; production code is identical.\n\nThe full native orchestrator run passes ${qualification.tests.nativeOrchestrator.numPassedTests} tests, with two existing live tests skipped. Provider-focused tests pass 159/159; actual local Prisma/PostgreSQL clock tests pass 22/22. The fresh production schema read verifies the unchanged 609-row ledger and both ready indexes. The original failed native test and correction remain preserved.\n\nPromote API first, then orchestrator, and verify the exact healthy pair. Preserve models, provider configuration, feature flags, roles, network and secret references. WebVNext388, guarded nightly136, the disabled broad worker and existing schema stay unchanged. Rollback uses the current API517/orchestrator113 images above.\n\nThis packet includes no paid captures, fixture binding, budget installation or journal mutation. Original benchmark acceptance remains 0/75, CD 0/7 and CW 0/8. Subsequent C2 captures use the existing authorization and remaining budget after their own admission checks.\n\n[Full packet and operation order](clock-provider-release-packet-refreshed.json). The [repository release rule](https://github.com/neo-capiro/capirov2/blob/${evidenceCommit}/docs/meri/deployment-prerequisite.md#qualification-evidence-and-migration-rules) requires: “Qualification is an explicit **human-reviewed attestation**.” The human has approved these exact images. This successor refresh changes timestamps only; the original packet and approval are retained in the linked refresh receipt.\n`);
console.log(JSON.stringify({status:packet.status,packetSha256:digest,evidenceCommit,expiresAt:packet.expiresAt,services:services.filter(s=>s.candidate).map(s=>({service:s.service,...s.candidate,baseline:s.baseline,candidateTaskSha256:s.candidateTaskSha256})),awsWrites:0},null,2));
