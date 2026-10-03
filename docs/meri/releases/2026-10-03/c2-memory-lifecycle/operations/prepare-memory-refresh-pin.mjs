// Read-only preparation for the ONE existing nightly refresh target.
import {readFileSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {fingerprint,taskInput} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003';
const repo='C:/dev/main/meri-c1-20261002';
const [evidenceCommit]=process.argv.slice(2);assert.match(evidenceCommit??'',/^[a-f0-9]{40}$/);
const evidencePath='docs/meri/releases/2026-10-03/c2-memory-lifecycle/release-qualification.json';
const qualification=JSON.parse(execFileSync('git',['show',evidenceCommit+':'+evidencePath],{cwd:repo,encoding:'utf8',windowsHide:true}));
assert.equal(qualification.status,'AUTOMATED_QUALIFICATION_PASSED_HUMAN_RELEASE_REVIEW_PENDING');
assert.equal(qualification.sourceReview.result,'PASS');assert.equal(qualification.currentSchema.status,'VERIFIED_READ_ONLY');
assert.equal(qualification.cleanupPreview.status,'PROJECTION_CLEANUP_PREVIEW_ROLLED_BACK');
assert.equal(qualification.schemaChange,false);assert.equal(qualification.humanApproval,null);
const previous=JSON.parse(readFileSync(root+'/memory-scheduled-writers.json','utf8')).records.find(row=>row.name==='capiro-dev-refresh-memory-graph');
const build=JSON.parse(readFileSync(root+'/api-lifecycle-build/build-readback.json','utf8'));
assert.equal(build.status,'SUCCEEDED');assert.match(build.sourceSha,/^[a-f0-9]{40}$/);
assert.equal(build.resolvedSourceSha,build.sourceSha);
assert.deepEqual({sourceSha:build.sourceSha,image:build.image},qualification.candidates.api);
assert.equal(build.buildLogSha256,qualification.buildLogSha256);
for(const marker of ['OFFLINE_RUNTIME_IMPORT_PASS','OFFLINE_CASE01_FIXTURE_PACKAGE_IMPORT_PASS','EXACT_452_IMAGE_MIGRATION_HASHES_PASS','OFFLINE_PACKAGED_C2_MEMORY_PASS','OFFLINE_PACKAGED_C2_RECONCILIATION_PASS','OFFLINE_PACKAGED_C2_TERMINAL_LIFECYCLE_PASS','OFFLINE_PACKAGED_C2_TS_SOURCE_IMPORT_PASS','LOCAL_REPODIGEST_ECR_MATCH_PASS'])assert.ok(build.passedMarkers.includes(marker));
const name=previous.name;
assert.equal(aws(['sts','get-caller-identity']).Account,'967807252336');
const rule=aws(['events','describe-rule','--name',name]);
const targets=aws(['events','list-targets-by-rule','--rule',name]).Targets;
assert.equal(fingerprint(rule),previous.ruleSha256);assert.equal(targets.length,1);
const target=targets[0];assert.equal(fingerprint(target),previous.targets[0].targetSha256);
assert.equal(rule.State,'ENABLED');assert.equal(rule.ScheduleExpression,'cron(30 4 * * ? *)');
assert.equal(target.Id,'refresh-memory-graph-target');
assert.deepEqual(JSON.parse(target.Input),{containerOverrides:[{name:'api',command:['refresh-memory-graph','--all-tenants']}]});
const described=aws(['ecs','describe-task-definition','--task-definition',target.EcsParameters.TaskDefinitionArn,'--include','TAGS']);
const task=described.taskDefinition;assert.ok(Array.isArray(described.tags));
assert.equal(fingerprint(task),previous.targets[0].taskDefinitionSha256);
assert.equal(task.family,'capiro-dev-api-migrate');assert.equal(task.runtimePlatform.cpuArchitecture,'ARM64');
const candidate=taskInput({...task,tags:described.tags});assert.equal(candidate.containerDefinitions.length,1);
const api=candidate.containerDefinitions[0];assert.equal(api.name,'api');assert.deepEqual(api.command,['migrate']);
assert.equal(api.environmentFiles?.length??0,0);
const baseline=structuredClone(candidate);
api.image=build.image;
for(const name of ['GIT_SHA','RELEASE_SHA']){
  assert.ok(!api.secrets?.some(row=>row.name===name));
  assert.ok(api.environment.filter(row=>row.name===name).length<=1);
  const entry=api.environment.find(row=>row.name===name);
  if(entry)entry.value=build.sourceSha;else api.environment.push({name,value:build.sourceSha});
}
const normalized=structuredClone(candidate), old=baseline.containerDefinitions[0], next=normalized.containerDefinitions[0];
next.image=old.image;
next.environment=next.environment.filter(row=>!['GIT_SHA','RELEASE_SHA'].includes(row.name));
old.environment=old.environment.filter(row=>!['GIT_SHA','RELEASE_SHA'].includes(row.name));
assert.deepEqual(normalized,baseline);
const details=aws(['ecr','describe-images','--repository-name','capiro/dev/api','--image-ids','imageTag='+build.sourceSha]).imageDetails;
assert.equal(details.length,1);assert.equal(build.image,'967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@'+details[0].imageDigest);
const refs=[...new Set(['RUNNING','STOPPED'].flatMap(status=>aws(['ecs','list-tasks','--cluster','capiro-dev','--family',task.family,'--desired-status',status]).taskArns))];
const observed=[];
for(let i=0;i<refs.length;i+=100){
  const chunk=refs.slice(i,i+100),result=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',...chunk]);
  assert.equal(result.failures?.length??0,0);assert.deepEqual(result.tasks.map(t=>t.taskArn).sort(),[...chunk].sort());observed.push(...result.tasks);
}
const activeNightly=[];
for(const t of observed.filter(t=>t.lastStatus!=='STOPPED')){
  const td=aws(['ecs','describe-task-definition','--task-definition',t.taskDefinitionArn]).taskDefinition;
  assert.equal(td.family,task.family);
  const command=t.overrides?.containerOverrides?.find(c=>c.name==='api')?.command??td.containerDefinitions.find(c=>c.name==='api')?.command;
  assert.ok(Array.isArray(command)&&command.length,'Active shared-family task command is unverified');
  if(command[0]==='refresh-memory-graph')activeNightly.push(t.taskArn);
}
assert.equal(activeNightly.length,0,'Wait for the existing nightly owner before changing its pin');
const strictPrior=JSON.parse(readFileSync(root+'/memory-scheduled-writers.json','utf8')).records.find(row=>row.name==='capiro-dev-memory-projection-worker');
const strictRule=aws(['events','describe-rule','--name',strictPrior.name]);
const strictTargets=aws(['events','list-targets-by-rule','--rule',strictPrior.name]).Targets;
assert.equal(strictRule.State,'DISABLED');assert.equal(fingerprint(strictRule),strictPrior.ruleSha256);
assert.deepEqual(strictTargets.map(t=>({id:t.Id,sha256:fingerprint(t)})).sort((a,b)=>a.id.localeCompare(b.id)),strictPrior.targets.map(t=>({id:t.id,sha256:t.targetSha256})).sort((a,b)=>a.id.localeCompare(b.id)));
const manifest={kind:'C2 existing nightly memory refresh image pin',version:1,status:'PREPARED_NOT_APPLIED',
  preparedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),rule:name,targetId:target.Id,baselineRuleSha256:fingerprint(rule),
  baselineTargetSha256:fingerprint(target),baselineTaskDefinition:task.taskDefinitionArn,baselineTaskSha256:fingerprint(task),
  baselineTagsSha256:fingerprint(described.tags),preservedUserTagCount:(candidate.tags??[]).length,
  sourceSha:build.sourceSha,image:build.image,taskInputSha256:fingerprint(candidate),taskFamily:candidate.family,
  qualificationSha256:fingerprint(qualification),qualificationEvidence:'https://github.com/neo-capiro/capirov2/blob/'+evidenceCommit+'/'+evidencePath,
  allowedChanges:['api.image','api.environment.GIT_SHA','api.environment.RELEASE_SHA','target.EcsParameters.TaskDefinitionArn'],
  unchanged:['rule state/schedule','target command','roles/network','secrets/configuration/model flags','all other targets/services'],
  invocation:'No manual invocation; next existing scheduled admission uses the new image',activeNightlyWriters:[],
  rollback:'Retain this backward-compatible guarded writer for unrelated service rollback. If this writer fails qualification, disable only this nightly rule pending repair; do not restore an enabled known-unsafe writer.',
  strictProjectionWorker:{state:strictRule.State,ruleSha256:fingerprint(strictRule),targetsSha256:fingerprint(strictTargets)},
  applyRequirements:['Fresh qualification and every baseline hash immediately before target change','Repeat RUNNING/STOPPED task reconciliation and require no active nightly writer','Verify exact new target/task/image/config/tags and unchanged rule/strict worker after write','Preserve durable dispatch intent; reconcile unknown AWS responses before any retry'],
  humanReleaseApproval:null,awsWrites:0};
const fd=openSync(root+'/memory-refresh-pin-manifest.json','wx');
try{writeFileSync(fd,JSON.stringify(manifest,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
console.log(JSON.stringify({...manifest,manifestSha256:fingerprint(manifest)},null,2));
