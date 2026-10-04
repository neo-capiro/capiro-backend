import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {releaseOperator} from '../../meri-c1-20261002/scripts/meri-release.mjs';
import {fingerprint,candidateTask,taskInput} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003',repo='C:/dev/main/meri-c1-20261002';
const commit='14030720eeec4959abe111f2c85407577374d2d8',arc='docs/meri/releases/2026-10-04/c2-case12-ecs-compat-release/';
const sha=b=>createHash('sha256').update(b).digest('hex'),read=n=>JSON.parse(readFileSync(root+'/'+n));
const versioned=n=>execFileSync('git',['show',commit+':'+arc+n],{cwd:repo,windowsHide:true});
const qualification=JSON.parse(versioned('release-qualification.json'));
for(const pin of qualification.artifactPins){const b=versioned(pin.path);assert.equal(b.length,pin.bytes);assert.equal(sha(b),pin.sha256);}
const approvalBytes=readFileSync(root+'/case12-ecs-compat-scope-approval-v1.json');
assert.equal(sha(approvalBytes),'9f6cd00ecd0c30a693603f7072b6f9062552248be77a36f366ac769475563c8f');
assert.deepEqual(approvalBytes,versioned('case12-ecs-compat-scope-approval-v1.json'));
const approval=JSON.parse(approvalBytes);assert.equal(approval.status,'APPROVED_SCOPED_CORRECTION');
assert.equal(qualification.candidate.sourceSha,approval.approvedSourceChange.mergedSourceSha);
assert.equal(qualification.checks.packagedMarkers,26);assert.equal(qualification.checks.nativeRegressionTests,47);
assert.equal(qualification.currentSchema.status,'VERIFIED_READ_ONLY');assert.equal(qualification.schemaChange,false);
const baseline=JSON.parse(versioned('served-baseline.json')),operator=releaseOperator({aws});
const services=[];
for(const s of baseline.services){const live=await operator.snapshot(s.service);assert.deepEqual(live.baseline,s.baseline);services.push({service:s.service,baseline:s.baseline,sourceSha:s.sourceSha});}
const live=await operator.snapshot('api'),image=qualification.candidate.image,sourceSha=qualification.candidate.sourceSha;
const listed=aws(['ecs','list-tasks','--cluster','capiro-dev','--service-name','capiro-dev-api','--desired-status','RUNNING']);assert.equal(listed.nextToken,undefined);assert.equal(listed.taskArns.length,2);
const tasks=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',...listed.taskArns]);assert.equal(tasks.failures?.length??0,0);assert.equal(tasks.tasks.length,2);
for(const t of tasks.tasks){assert.equal(t.taskDefinitionArn,live.baseline.taskDefinitionArn);assert.equal(t.lastStatus,'RUNNING');}
const nightly=baseline.retainedNightly;
assert.equal(fingerprint(aws(['events','describe-rule','--name',nightly.rule])),nightly.ruleSha256);
const targets=aws(['events','list-targets-by-rule','--rule',nightly.rule]);assert.equal(targets.Targets.length,1);assert.equal(targets.NextToken,undefined);assert.equal(fingerprint(targets.Targets[0]),nightly.targetSha256);
const td=aws(['ecs','describe-task-definition','--task-definition',nightly.taskDefinition,'--include','TAGS']);assert.equal(fingerprint(taskInput({...td.taskDefinition,tags:td.tags})),nightly.taskInputSha256);
assert.equal(aws(['events','describe-rule','--name','capiro-dev-memory-projection-worker']).State,'DISABLED');
const journalSha256=sha(readFileSync('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl'));assert.equal(journalSha256,'816b04a47be56432846d1ee602370c3bea985eb497a7de9e899aee4d53f8b39e');
const prefix='https://github.com/neo-capiro/capirov2/blob/'+commit+'/'+arc;
const q={schemaVersion:1,service:'api',sourceSha,image,status:'qualified',reviewer:approval.reviewer+'; scoped source approval bound by root to qualified immutable image',reviewedAt:approval.recordedAt,expiresAt:new Date(Date.now()+3600000).toISOString(),schemaChange:false,evidence:[prefix+'release-qualification.json',prefix+'case12-ecs-compat-scope-approval-v1.json'],checks:[['build','build/build-readback.json'],['automated-tests','release-qualification.json'],['retirement-compatibility','release-qualification.json']].map(([name,p])=>({name,status:'passed',sourceSha,image,url:prefix+p}))};
const manifest=await operator.prepare(q);assert.deepEqual(manifest.baseline,live.baseline);
const packet={kind:'C2 Case12 approved API-only compatibility release',preparedAt:new Date().toISOString(),expiresAt:q.expiresAt,evidenceCommit:commit,approvalSha256:sha(approvalBytes),manifestSha256:fingerprint(manifest),candidate:{sourceSha,image},candidateTaskSha256:fingerprint(candidateTask(live.task,'api',image,sourceSha)),rollbackTaskSha256:fingerprint(candidateTask(live.task,'api',live.task.containerDefinitions.find(c=>c.name==='api').image)),services,retainedNightly:nightly,budget:{journalSha256},oldApiTaskArns:listed.taskArns,scope:'API_IMAGE_AND_RELEASE_IDENTITY_ONLY_NO_ADDITIONAL_IAM_OR_SETUP_AUTHORITY'};
for(const [name,value] of [['case12-compat-human-qualification-v1.json',q],['case12-compat-release-manifest-v1.json',manifest],['case12-compat-release-packet-v1.json',packet]])writeFileSync(root+'/'+name,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({...packet,packetSha256:fingerprint(packet)},null,2));
