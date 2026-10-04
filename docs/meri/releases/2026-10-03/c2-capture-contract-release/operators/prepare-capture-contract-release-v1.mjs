// Read-only preparation of a concrete unsigned release packet. No human approval is inferred.
import {readFileSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {releaseOperator} from '../../meri-c1-20261002/scripts/meri-release.mjs';
import {candidateTask,fingerprint,taskInput} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const [evidenceCommit]=process.argv.slice(2);assert.match(evidenceCommit??'',/^[a-f0-9]{40}$/);
const root='C:/dev/main/outputs/meri-c2-20261003',repo='C:/dev/main/meri-c1-20261002';
const arc='docs/meri/releases/2026-10-03/c2-capture-contract-release/';
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
const packet={kind:'C2 capture-contract exact release review packet',version:1,status:'AWAITING_HUMAN_REVIEW',preparedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60*60000).toISOString(),evidenceCommit,evidence:[prefix+'README.md',prefix+'release-qualification.json',prefix+'release-independent-review.json'],qualificationSha256:fingerprint(qualification),services,retainedNightly:nightly,
  executionOrder:['Promote the exact API image and verify all running tasks and ALB targets with unchanged configuration','Promote the exact orchestrator image and verify all running tasks and ALB targets with unchanged configuration','Read back the served pair, retained nightly136, disabled broad worker and unchanged sibling WebVNext388'],
  changeWindow:'One attended release owner from preparation through acceptance/rollback; concurrent service, autoscaling or configuration changes invalidate the baseline and require reconciliation.',
  rollback:{application:'Use the exact current API519 and orchestrator115 image digests listed per service.',database:'Retain migration452 and both existing additive indexes; no migration is run.',memory:'Retain completed cleanup and audit receipts, guarded nightly136 and the disabled broad worker. No fixture reset or replay.'},
  scope:{schemaChange:false,modelConfigurationChange:false,providerConfigurationChange:false,featureFlagChange:false,nightlyChange:false,webChange:false,capacityChange:false,newProviderCalls:0,newCaptureAuthority:false,captureBindingWrite:false,budgetInstallation:false,journalMutation:false},
  subsequentC2:'After this release, continue separately authorized C2 native capture preparation within the existing budget. Canonical binding, rate installation, spend reservation, served joins and human rubric remain separate checks; this packet does not claim them complete.',
  acceptance:{original75:0,cd:0,cw:0},awsWrites:0,humanReleaseApproval:null,deployableManifest:false,
  approvalRequirement:'docs/meri/deployment-prerequisite.md: Qualification is an explicit human-reviewed attestation.'};
save('capture-contract-release-packet.json',packet);
const digest=fingerprint(packet);
save('capture-contract-release-packet.md',`# C2 capture-contract release review

Release the reviewed repair for original capture proposal reads, signed receipt persistence and the admitted budget ceiling. [Versioned qualification and limitations](${prefix}README.md).

Packet fingerprint: \`${digest}\`. Expires ${packet.expiresAt}.

| Service | Source | Exact candidate image | Rollback image |
| --- | --- | --- | --- |
${services.filter(s=>s.candidate).map(s=>`| ${s.service} | \`${s.candidate.sourceSha}\` | \`${s.candidate.image.split('@')[1]}\` | \`${s.rollbackImage.split('@')[1]}\` |`).join('\n')}

The API omits absent clock proof before signing, permits the existing own-pending proposal read under original01/14 scope, and checks the signed receipt against the actual admitted ceiling. The orchestrator records the actual scoped proposal response, including healthy empty results. Missing, partial or failed evidence stays blocked. This fixes the capture path; it does not turn the previous failed run into a pass.

Qualification includes ${qualification.tests.nativeOrchestrator.numPassedTests} native orchestrator tests, 281 focused checks, four actual PostgreSQL tests on the final combined source, packaged image probes, and independent review. Two existing live tests remain skipped. The fresh production schema read verifies the unchanged609-row ledger and both indexes. The initial zero-job Actions failures and build-request size rejections are retained; the successful fallback executes the exact reviewed phase commands through a compressed carrier.

Promote API first, verify it, then promote and verify the orchestrator. Preserve service configuration, models, flags, secrets, network, capacity, WebVNext388, guarded nightly136 and the disabled broad worker. Run no migrations or memory cleanup. Rollback retains the compatible current API519/orchestrator115 images shown above.

This release packet includes no paid capture, fixture binding, budget installation or journal mutation. The original Case01 run remains failed/uncertain. The saved22-event journal has no active reservation and $17.866117 remaining under the existing authorization. Original acceptance remains0/75, CD0/7 and CW0/8. After release, Case20 proceeds only after its own existing source, fixture, admission, cost and authentication checks; human grading remains required.

[Full packet](capture-contract-release-packet.json). The [repository release rule](https://github.com/neo-capiro/capirov2/blob/${evidenceCommit}/docs/meri/deployment-prerequisite.md#qualification-evidence-and-migration-rules) requires: “Qualification is an explicit **human-reviewed attestation**.” Approval for these exact new images is pending.
`);
console.log(JSON.stringify({status:packet.status,packetSha256:digest,evidenceCommit,expiresAt:packet.expiresAt,services:services.filter(s=>s.candidate).map(s=>({service:s.service,...s.candidate,baseline:s.baseline,candidateTaskSha256:s.candidateTaskSha256})),awsWrites:0},null,2));
