// Read-only concrete release review packet. Human qualification remains absent.
import {readFileSync,writeFileSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {releaseOperator} from '../../meri-c1-20261002/scripts/meri-release.mjs';
import {candidateTask,fingerprint,taskInput} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const [evidenceCommit]=process.argv.slice(2);assert.match(evidenceCommit??'',/^[a-f0-9]{40}$/);
const root='C:/dev/main/outputs/meri-c2-20261003',repo='C:/dev/main/meri-c1-20261002',arc='docs/meri/releases/2026-10-03/c2-combined-release/';
const versioned=name=>JSON.parse(execFileSync('git',['show',evidenceCommit+':'+arc+name],{cwd:repo,encoding:'utf8',windowsHide:true}));
const save=(name,value)=>{const fd=openSync(root+'/'+name,'wx');try{writeFileSync(fd,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}};
const qualification=versioned('release-qualification.json'),review=versioned('release-independent-review.json'),baseline=versioned('served-baseline.json');
assert.equal(qualification.status,'AUTOMATED_QUALIFICATION_PASSED_HUMAN_RELEASE_REVIEW_PENDING');assert.equal(qualification.humanApproval,null);assert.equal(qualification.schemaChange,false);
assert.equal(qualification.currentSchema.status,'VERIFIED_READ_ONLY');assert.equal(review.result,'PASS');assert.equal(review.humanReleaseApproval,false);
const journal=readFileSync('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl');assert.equal(createHash('sha256').update(journal).digest('hex'),qualification.budgetCheckpoint.journalSha256);assert.equal(journal.toString('utf8').trim().split('\n').length,24);
assert.equal(aws(['sts','get-caller-identity']).Arn,'arn:aws:iam::967807252336:user/capirocli');
const operator=releaseOperator({aws}),services=[];
for(const service of ['api','meriv2-orchestrator','web-vnext']){
 const live=await operator.snapshot(service),expected=baseline.services.find(s=>s.service===service);assert.deepEqual(live.baseline,expected.baseline,service+' baseline drift');
 const c=live.task.containerDefinitions.find(c=>c.name===service),sourceSha=c.environment.find(e=>e.name==='RELEASE_SHA')?.value??c.environment.find(e=>e.name==='GIT_SHA')?.value;assert.equal(sourceSha,expected.sourceSha);
 const candidate=qualification.candidates[service],buildPath='builds/'+service+'/build-readback.json',build=versioned(buildPath);
 assert.equal(candidate.sourceSha,'c0f393f863bf73bd4e65e7a94e17c073e7be021e');assert.equal(build.status,'SUCCEEDED');assert.equal(build.qualification,'IMMUTABLE_BUILD_AND_OFFLINE_PROBES_PASS');assert.equal(build.sourceSha,candidate.sourceSha);assert.equal(build.image,candidate.image);
 for(const id of ['imageTag='+candidate.sourceSha,'imageDigest='+candidate.image.split('@')[1]]){const details=aws(['ecr','describe-images','--repository-name','capiro/dev/'+service,'--image-ids',id]).imageDetails;assert.equal(details.length,1);assert.equal(details[0].imageDigest,candidate.image.split('@')[1]);}
 const rollbackImage='967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/'+service+'@'+live.baseline.imageDigest;
 const rollback=aws(['ecr','describe-images','--repository-name','capiro/dev/'+service,'--image-ids','imageDigest='+live.baseline.imageDigest]).imageDetails;assert.equal(rollback.length,1);assert.equal(rollback[0].imageDigest,live.baseline.imageDigest);
 services.push({service,change:'IMAGE_AND_RELEASE_IDENTITY_ONLY',candidate,baseline:live.baseline,candidateTaskSha256:fingerprint(candidateTask(live.task,service,candidate.image,candidate.sourceSha)),rollbackImage,rollbackTaskSha256:fingerprint(candidateTask(live.task,service,rollbackImage)),configurationPreserved:true,buildEvidence:buildPath});
}
const nightly=baseline.retainedNightly,rule=aws(['events','describe-rule','--name',nightly.rule]);assert.equal(fingerprint(rule),nightly.ruleSha256);
const targets=aws(['events','list-targets-by-rule','--rule',nightly.rule]);assert.equal(targets.Targets.length,1);assert.equal(targets.NextToken,undefined);assert.equal(fingerprint(targets.Targets[0]),nightly.targetSha256);assert.equal(targets.Targets[0].EcsParameters.TaskDefinitionArn,nightly.taskDefinition);
const td=aws(['ecs','describe-task-definition','--task-definition',nightly.taskDefinition,'--include','TAGS']);assert.equal(td.taskDefinition.status,'ACTIVE');assert.equal(fingerprint(taskInput({...td.taskDefinition,tags:td.tags})),nightly.taskInputSha256);
assert.equal(aws(['events','describe-rule','--name','capiro-dev-memory-projection-worker']).State,'DISABLED');
const prefix='https://github.com/neo-capiro/capirov2/blob/'+evidenceCommit+'/'+arc;
const packet={kind:'C2 Case17 and Case20 three-service release review packet',version:1,status:'AWAITING_HUMAN_REVIEW',preparedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60*60000).toISOString(),evidenceCommit,evidence:[prefix+'README.md',prefix+'release-qualification.json',prefix+'release-independent-review.json'],qualificationSha256:fingerprint(qualification),services,retainedNightly:nightly,
 executionOrder:['Promote API and verify exact tasks/digest and ALB health','Promote orchestrator and verify exact tasks/digest and ALB health','Promote Web vNext and verify exact tasks/digest and ALB health','Verify authenticated served identities and Case17 provenance; continue separate C2 prerequisites'],
 changeWindow:'One attended release owner; any concurrent service/scaling/configuration change invalidates baseline and requires reconciliation.',
 rollback:{application:'Current API521/orchestrator117/Web388 exact digests, listed per service.',database:'Retain migration452 and ledger609; no migration.',memory:'Retain completed cleanup and audit receipts, nightly136 and disabled broad worker. No reset or replay.'},
 scope:{schemaChange:false,modelConfigurationChange:false,providerConfigurationChange:false,featureFlagChange:false,nightlyChange:false,webChange:true,capacityChange:false,newProviderCalls:0,newCaptureAuthority:false,captureBindingWrite:false,budgetInstallation:false,journalMutation:false},
 budget:qualification.budgetCheckpoint,acceptance:qualification.acceptance,awsWrites:0,humanReleaseApproval:null,deployableManifest:false,
 approvalRequirement:'docs/meri/deployment-prerequisite.md: Qualification is an explicit human-reviewed attestation; the exact new candidate packet is ready for that review.'};
save('combined-c2-release-packet-v1.json',packet);const digest=fingerprint(packet);
save('combined-c2-release-packet-v1.md',`# C2 exact backup release ready for review

The three immutable CodeBuild images below repair Case17 recorded proposal provenance and Case20 controlled-source receipt qualification. Source is merged in [PR1937](https://github.com/neo-capiro/capirov2/pull/1937). [Versioned qualification](${prefix}README.md) includes build logs, independent reviews, current schema and healthy rollback baseline. The service release is pending; C2 acceptance remains open.

Packet fingerprint: \`${digest}\`. Prepared ${packet.preparedAt}; snapshot expires ${packet.expiresAt}.

| Service | Candidate digest | Rollback digest |
| --- | --- | --- |
${services.map(s=>`| ${s.service} | \`${s.candidate.image.split('@')[1]}\` | \`${s.rollbackImage.split('@')[1]}\` |`).join('\n')}

All three candidates use source \`c0f393f863bf73bd4e65e7a94e17c073e7be021e\`. API packaged checks, 1568 orchestrator tests across130 suites (two existing skipped), and175 Web tests across11 files pass. The initial failed API harness and stale local build remain recorded; the corrected harness preserves assertions and passes on the actual candidate. Current ledger609/index hashes/retired-table checks pass.

Promote API, then orchestrator, then Web, verifying each before proceeding. Preserve all configuration, models, providers, flags, capacity, schema, nightly136 and disabled broad worker. No migration, cleanup replay, paid capture, budget installation or new admission is included. Case14 has a successful native plan only. The journal remains24 events, no active hold and $16.368942 capacity; consumed Case01/20 runs stay failed. Human benchmark grading remains separate.

[Full packet](combined-c2-release-packet-v1.json). The [repository release rule](https://github.com/neo-capiro/capirov2/blob/${evidenceCommit}/docs/meri/deployment-prerequisite.md#qualification-evidence-and-migration-rules) states: “Qualification is an explicit **human-reviewed attestation**.” This packet is ready for that review; no human approval is fabricated from automated/Hermes checks.
`);
console.log(JSON.stringify({status:packet.status,packetSha256:digest,evidenceCommit,expiresAt:packet.expiresAt,services:services.map(s=>({service:s.service,...s.candidate,candidateTaskSha256:s.candidateTaskSha256})),awsWrites:0},null,2));
