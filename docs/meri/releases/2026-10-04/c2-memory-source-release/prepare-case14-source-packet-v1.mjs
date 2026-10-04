// Read-only concrete packet; deliberately not a deployable/human-approved manifest.
import {readFileSync,writeFileSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {releaseOperator} from '../../meri-c1-20261002/scripts/meri-release.mjs';
import {candidateTask,fingerprint,taskInput} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const [evidenceCommit,...extra]=process.argv.slice(2);assert.match(evidenceCommit??'',/^[a-f0-9]{40}$/);assert.equal(extra.length,0);
const root='C:/dev/main/outputs/meri-c2-20261003',repo='C:/dev/main/meri-c1-20261002',arc='docs/meri/releases/2026-10-04/c2-memory-source-release/';
const versioned=name=>JSON.parse(execFileSync('git',['show',evidenceCommit+':'+arc+name],{cwd:repo,encoding:'utf8',windowsHide:true}));
const save=(name,value)=>{const fd=openSync(root+'/'+name,'wx');try{writeFileSync(fd,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}};
const qualification=versioned('release-qualification.json'),review=versioned('release-independent-review.json'),baseline=versioned('served-baseline.json');
assert.equal(qualification.status,'AUTOMATED_QUALIFICATION_PASSED_HUMAN_RELEASE_REVIEW_PENDING');assert.equal(qualification.humanApproval,null);assert.equal(qualification.schemaChange,false);
assert.equal(qualification.currentSchema.status,'VERIFIED_READ_ONLY');assert.equal(review.result,'PASS');assert.equal(review.humanReleaseApproval,false);
const journal=readFileSync('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl');assert.equal(createHash('sha256').update(journal).digest('hex'),qualification.budgetCheckpoint.journalSha256);assert.equal(journal.toString('utf8').trim().split('\n').length,26);
assert.equal(aws(['sts','get-caller-identity']).Arn,'arn:aws:iam::967807252336:user/capirocli');
const operator=releaseOperator({aws}),services=[];
for(const service of ['api','meriv2-orchestrator']){
  const live=await operator.snapshot(service),expected=baseline.services.find(s=>s.service===service);assert.deepEqual(live.baseline,expected.baseline,service+' baseline drift');
  const c=live.task.containerDefinitions.find(c=>c.name===service);assert.equal(c.environment.find(e=>e.name==='RELEASE_SHA')?.value,expected.sourceSha);
  const candidate=qualification.candidates[service],buildPath='builds/'+service+'/build-readback.json',build=versioned(buildPath);
  assert.equal(candidate.sourceSha,'945179d44223882f9fe1da2fb4e41213bf5813c2');assert.equal(build.status,'SUCCEEDED');assert.equal(build.qualification,'IMMUTABLE_BUILD_AND_OFFLINE_PROBES_PASS');assert.equal(build.sourceSha,candidate.sourceSha);assert.equal(build.image,candidate.image);
  for(const id of ['imageTag='+candidate.sourceSha,'imageDigest='+candidate.image.split('@')[1]]){
    const details=aws(['ecr','describe-images','--repository-name','capiro/dev/'+service,'--image-ids',id]).imageDetails;assert.equal(details.length,1);assert.equal(details[0].imageDigest,candidate.image.split('@')[1]);
  }
  const rollbackImage='967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/'+service+'@'+live.baseline.imageDigest;
  const rollback=aws(['ecr','describe-images','--repository-name','capiro/dev/'+service,'--image-ids','imageDigest='+live.baseline.imageDigest]).imageDetails;assert.equal(rollback.length,1);assert.equal(rollback[0].imageDigest,live.baseline.imageDigest);
  services.push({service,change:'IMAGE_AND_RELEASE_IDENTITY_ONLY',candidate,baseline:live.baseline,candidateTaskSha256:fingerprint(candidateTask(live.task,service,candidate.image,candidate.sourceSha)),rollbackImage,rollbackTaskSha256:fingerprint(candidateTask(live.task,service,rollbackImage)),configurationPreserved:true,buildEvidence:buildPath});
}
const web=await operator.snapshot('web-vnext');assert.deepEqual(web.baseline,baseline.services.find(s=>s.service==='web-vnext').baseline);
const nightly=baseline.retainedNightly,rule=aws(['events','describe-rule','--name',nightly.rule]);assert.equal(fingerprint(rule),nightly.ruleSha256);
const targets=aws(['events','list-targets-by-rule','--rule',nightly.rule]);assert.equal(targets.Targets.length,1);assert.equal(targets.NextToken,undefined);assert.equal(fingerprint(targets.Targets[0]),nightly.targetSha256);assert.equal(targets.Targets[0].EcsParameters.TaskDefinitionArn,nightly.taskDefinition);
const td=aws(['ecs','describe-task-definition','--task-definition',nightly.taskDefinition,'--include','TAGS']);assert.equal(td.taskDefinition.status,'ACTIVE');assert.equal(fingerprint(taskInput({...td.taskDefinition,tags:td.tags})),nightly.taskInputSha256);
assert.equal(aws(['events','describe-rule','--name','capiro-dev-memory-projection-worker']).State,'DISABLED');
const prefix='https://github.com/neo-capiro/capirov2/blob/'+evidenceCommit+'/'+arc;
const packet={kind:'C2 canonical memory source two-service release review packet',version:1,status:'AWAITING_HUMAN_REVIEW',preparedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60*60000).toISOString(),evidenceCommit,evidence:[prefix+'README.md',prefix+'release-qualification.json',prefix+'release-independent-review.json'],qualificationSha256:fingerprint(qualification),services,unchangedWebBaseline:web.baseline,retainedNightly:nightly,
  executionOrder:['Promote API and verify exact tasks/digest and ALB health','Promote orchestrator and verify exact tasks/digest and ALB health','Verify authenticated served release identities and ordinary memory reads; continue separately qualified C2 work'],
  changeWindow:'One attended owner; concurrent service/scaling/configuration changes require reconciliation.',
  rollback:{application:'Current API523 and orchestrator119 exact digests, listed per service.',database:'Retain migration452 and ledger609; no migration.',memory:'Retain approved candidate, failed captures, consumed claims and native26-event journal. No reset/replay.'},
  scope:{schemaChange:false,modelConfigurationChange:false,providerConfigurationChange:false,featureFlagChange:false,nightlyChange:false,webChange:false,capacityChange:false,newProviderCalls:0,newCaptureAuthority:false,captureBindingWrite:false,budgetInstallation:false,journalMutation:false},
  budget:qualification.budgetCheckpoint,acceptance:qualification.acceptance,awsWrites:0,humanReleaseApproval:null,deployableManifest:false,
  approvalRequirement:'docs/meri/deployment-prerequisite.md: Qualification is an explicit human-reviewed attestation. These new digests were not included in the previous completed release approval.'};
save('case14-source-release-packet-v1.json',packet);const digest=fingerprint(packet);
save('case14-source-release-packet-v1.md',`# C2 memory source repair: exact release ready for review

Both immutable CodeBuild candidates passed source and packaged qualification. They repair canonical memory source ownership/receipt joins and internal-tool HTTP success status. Source is merged in [PR1941](https://github.com/neo-capiro/capirov2/pull/1941). [Versioned evidence](${prefix}README.md) includes build logs, source/release reviews, read-only schema proof and the healthy rollback baseline. Production promotion is pending; C2 acceptance remains open.

Packet fingerprint: \`${digest}\`. Prepared ${packet.preparedAt}; snapshot expires ${packet.expiresAt}.

| Service | Candidate digest | Rollback digest |
| --- | --- | --- |
${services.map(s=>`| ${s.service} | \`${s.candidate.image.split('@')[1]}\` | \`${s.rollbackImage.split('@')[1]}\` |`).join('\n')}

Both candidates use source \`945179d44223882f9fe1da2fb4e41213bf5813c2\`. Native core97 and orchestrator1570 tests across130 suites passed; two existing live tests remain skipped. API final-image request/source proof and HTTP status/guard probes passed. Both Hermes reviews and root checks are retained, including repaired failures. Current schema609/index/retired-table checks passed, and the read task stopped with its definition inactive.

Promote API, then orchestrator, verifying each before proceeding. Preserve Web390, all configuration/models/providers/flags/capacity/schema/schedules, nightly136 and the disabled broad worker. No new capture, model call, fixture reset/reapproval, budget admission or journal change is included. Prior failed captures remain failed; human benchmark grading is separate. The26-event journal remains $16.200909 committed/$13.799091 available, including $1 conservative approval cost.

Tenant-wide null-client memory and changed/shortened citation bytes remain outside accepted client-bound source evidence. The source repair does not close initial-context coverage, the answer's date issue, the original Case14 prompt/final recall UI or human grading.

[Full packet](case14-source-release-packet-v1.json). The [repository release rule](https://github.com/neo-capiro/capirov2/blob/${evidenceCommit}/docs/meri/deployment-prerequisite.md#qualification-evidence-and-migration-rules) requires an explicit human-reviewed attestation. This is a new exact image pair; the previously approved three-image release is already complete.
`);
console.log(JSON.stringify({status:packet.status,packetSha256:digest,evidenceCommit,expiresAt:packet.expiresAt,services:services.map(s=>({service:s.service,...s.candidate,candidateTaskSha256:s.candidateTaskSha256})),awsWrites:0},null,2));
