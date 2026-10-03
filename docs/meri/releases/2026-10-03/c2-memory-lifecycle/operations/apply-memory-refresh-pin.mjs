// Attended, single-attempt update of one existing scheduled target. No task invocation.
import {readFileSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {awsSingleAttempt} from './aws-single-attempt.mjs';
import {releaseOperator} from '../../meri-c1-20261002/scripts/meri-release.mjs';
import {fingerprint,taskInput} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003',repo='C:/dev/main/meri-c1-20261002';
const read=name=>JSON.parse(readFileSync(root+'/'+name,'utf8'));
const manifest=read('memory-refresh-pin-manifest.json'),packet=read('memory-lifecycle-release-packet.json'),approval=read('memory-lifecycle-human-approval.json');
assert.equal(approval.status,'APPROVED');assert.equal(approval.scope,'EXACT_C2_MEMORY_RELEASE_AND_BOUNDED_MAINTENANCE');
assert.equal(approval.packetSha256,fingerprint(packet));assert.equal(packet.nightlyManifestSha256,fingerprint(manifest));
assert.equal(manifest.status,'PREPARED_NOT_APPLIED');assert.equal(packet.status,'AWAITING_HUMAN_REVIEW');
assert.ok(Date.parse(manifest.expiresAt)>Date.now());assert.ok(Date.parse(packet.expiresAt)>Date.now());
assert.ok(typeof approval.reviewer==='string'&&approval.reviewer.trim());assert.ok(Date.parse(approval.approvedAt)<=Date.now());
const evidencePath='docs/meri/releases/2026-10-03/c2-memory-lifecycle/release-qualification.json';
const q=JSON.parse(execFileSync('git',['show',packet.evidenceCommit+':'+evidencePath],{cwd:repo,encoding:'utf8',windowsHide:true}));
assert.equal(fingerprint(q),manifest.qualificationSha256);assert.equal(q.sourceReview.result,'PASS');
assert.equal(q.cleanupPreview.status,'PROJECTION_CLEANUP_PREVIEW_ROLLED_BACK');assert.equal(q.currentSchema.status,'VERIFIED_READ_ONLY');
assert.deepEqual(q.candidates.api,{sourceSha:manifest.sourceSha,image:manifest.image});
assert.equal(aws(['sts','get-caller-identity']).Account,'967807252336');
const fd=openSync(root+'/memory-refresh-pin-apply-events.jsonl','wx');
const record=data=>{writeFileSync(fd,JSON.stringify({at:new Date().toISOString(),...data})+'\n');fsyncSync(fd);};
const save=(name,data)=>{const f=openSync(root+'/'+name,'wx');try{writeFileSync(f,JSON.stringify(data,null,2)+'\n');fsyncSync(f);}finally{closeSync(f);}};
let registeredArn;
try {
  record({status:'AUTHORIZED_PRECHECK',packetSha256:fingerprint(packet),manifestSha256:fingerprint(manifest),approvalSha256:fingerprint(approval),noAutomaticRetry:true});
  const operator=releaseOperator({aws});
  for(const service of ['api','meriv2-orchestrator']) {
    const live=await operator.snapshot(service),expected=packet.services.find(s=>s.service===service);
    assert.equal(live.baseline.imageDigest,expected.candidate.image.split('@')[1]);
    assert.equal(live.baseline.taskHash,expected.candidateTaskSha256);assert.equal(live.baseline.configHash,expected.baseline.configHash);
    const c=live.task.containerDefinitions.find(c=>c.name===service);
    assert.equal(c.image,expected.candidate.image);assert.equal(c.environment.find(e=>e.name==='RELEASE_SHA')?.value,expected.candidate.sourceSha);
  }
  const checkBaseline=()=>{
    const rule=aws(['events','describe-rule','--name',manifest.rule]);
    const targets=aws(['events','list-targets-by-rule','--rule',manifest.rule]).Targets;
    assert.equal(fingerprint(rule),manifest.baselineRuleSha256);assert.equal(rule.State,'ENABLED');assert.equal(targets.length,1);
    assert.equal(fingerprint(targets[0]),manifest.baselineTargetSha256);assert.equal(targets[0].Id,manifest.targetId);
    const result=aws(['ecs','describe-task-definition','--task-definition',manifest.baselineTaskDefinition,'--include','TAGS']);
    assert.equal(fingerprint(result.taskDefinition),manifest.baselineTaskSha256);assert.equal(fingerprint(result.tags),manifest.baselineTagsSha256);
    return {rule,target:targets[0],described:result};
  };
  const checkStrictWorker=()=>{
    const rule=aws(['events','describe-rule','--name','capiro-dev-memory-projection-worker']);
    const targets=aws(['events','list-targets-by-rule','--rule','capiro-dev-memory-projection-worker']).Targets;
    assert.equal(rule.State,'DISABLED');assert.equal(fingerprint(rule),manifest.strictProjectionWorker.ruleSha256);
    assert.equal(fingerprint(targets),manifest.strictProjectionWorker.targetsSha256);
  };
  const checkOwners=()=>{
    const refs=[...new Set(['RUNNING','STOPPED'].flatMap(status=>aws(['ecs','list-tasks','--cluster','capiro-dev','--family',manifest.taskFamily,'--desired-status',status]).taskArns))];
    const observed=[];
    for(let i=0;i<refs.length;i+=100){const chunk=refs.slice(i,i+100),r=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',...chunk]);assert.equal(r.failures?.length??0,0);assert.deepEqual(r.tasks.map(t=>t.taskArn).sort(),[...chunk].sort());observed.push(...r.tasks);}
    for(const task of observed.filter(t=>t.lastStatus!=='STOPPED')) {
      const td=aws(['ecs','describe-task-definition','--task-definition',task.taskDefinitionArn]).taskDefinition;
      const command=task.overrides?.containerOverrides?.find(c=>c.name==='api')?.command??td.containerDefinitions.find(c=>c.name==='api')?.command;
      assert.ok(Array.isArray(command)&&command.length,'Unverified active shared-family owner');
      assert.notEqual(command[0],'refresh-memory-graph','Existing nightly writer is still active');
    }
    return {observed:observed.length,activeNightlyWriters:0};
  };
  const before=checkBaseline();checkStrictWorker();const owners=checkOwners();
  const candidate=taskInput({...before.described.taskDefinition,tags:before.described.tags});
  const api=candidate.containerDefinitions.find(c=>c.name==='api');assert.equal(candidate.containerDefinitions.length,1);
  api.image=manifest.image;
  for(const name of ['GIT_SHA','RELEASE_SHA']){const entry=api.environment.find(e=>e.name===name);if(entry)entry.value=manifest.sourceSha;else api.environment.push({name,value:manifest.sourceSha});}
  assert.equal(fingerprint(candidate),manifest.taskInputSha256);
  const image=aws(['ecr','describe-images','--repository-name','capiro/dev/api','--image-ids','imageTag='+manifest.sourceSha]).imageDetails;
  assert.equal(image.length,1);assert.equal(manifest.image,'967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@'+image[0].imageDigest);
  save('memory-refresh-pin-task-input.private.json',candidate);
  assert.ok(Date.parse(manifest.expiresAt)>Date.now());assert.ok(Date.parse(packet.expiresAt)>Date.now());
  const attemptedAt=new Date().toISOString();record({status:'REGISTER_ATTEMPT_AUTHORIZED',attemptedAt,taskInputSha256:fingerprint(candidate),owners,awsMaxAttempts:1});
  try {registeredArn=awsSingleAttempt(['ecs','register-task-definition','--cli-input-json','file://'+root+'/memory-refresh-pin-task-input.private.json']).taskDefinition?.taskDefinitionArn;}
  catch {
    const refs=aws(['ecs','list-task-definitions','--family-prefix',manifest.taskFamily,'--status','ACTIVE','--sort','DESC']).taskDefinitionArns;
    const matches=[];
    for(const arn of refs){const r=aws(['ecs','describe-task-definition','--task-definition',arn,'--include','TAGS']);if(r.taskDefinition.family!==manifest.taskFamily)continue;if(Date.parse(r.taskDefinition.registeredAt)<Date.parse(attemptedAt)-1000)continue;if(fingerprint(taskInput({...r.taskDefinition,tags:r.tags}))===fingerprint(candidate))matches.push(arn);}
    record({status:'REGISTER_RESPONSE_RECONCILED',matchingDefinitions:matches});assert.equal(matches.length,1,'Registration outcome unverified; no automatic retry');registeredArn=matches[0];
  }
  assert.ok(typeof registeredArn==='string'&&registeredArn.startsWith('arn:aws:ecs:us-east-1:967807252336:task-definition/'+manifest.taskFamily+':'));
  const registered=aws(['ecs','describe-task-definition','--task-definition',registeredArn,'--include','TAGS']);
  assert.equal(registered.taskDefinition.status,'ACTIVE');assert.equal(fingerprint(taskInput({...registered.taskDefinition,tags:registered.tags})),manifest.taskInputSha256);
  record({status:'REGISTERED_NOT_PINNED',taskDefinition:registeredArn,taskInputSha256:manifest.taskInputSha256});
  const fresh=checkBaseline();checkStrictWorker();const freshOwners=checkOwners();
  assert.ok(Date.parse(manifest.expiresAt)>Date.now());assert.ok(Date.parse(packet.expiresAt)>Date.now());
  const target=structuredClone(fresh.target);target.EcsParameters.TaskDefinitionArn=registeredArn;
  save('memory-refresh-pin-target-input.private.json',{Rule:manifest.rule,Targets:[target]});
  record({status:'TARGET_UPDATE_ATTEMPT_AUTHORIZED',taskDefinition:registeredArn,targetSha256:fingerprint(target),owners:freshOwners,awsMaxAttempts:1});
  let response;
  try {response=awsSingleAttempt(['events','put-targets','--cli-input-json','file://'+root+'/memory-refresh-pin-target-input.private.json']);record({status:'TARGET_UPDATE_RESPONSE',failedEntryCount:response.FailedEntryCount,failedEntries:response.FailedEntries});}
  catch {record({status:'TARGET_UPDATE_RESPONSE_UNKNOWN',noAutomaticRetry:true});}
  const afterTargets=aws(['events','list-targets-by-rule','--rule',manifest.rule]).Targets;
  assert.equal(afterTargets.length,1);assert.equal(fingerprint(afterTargets[0]),fingerprint(target),'Target update not confirmed; retain receipt, reconcile before retry');
  assert.equal(fingerprint(aws(['events','describe-rule','--name',manifest.rule])),manifest.baselineRuleSha256);checkStrictWorker();
  const afterTask=aws(['ecs','describe-task-definition','--task-definition',registeredArn,'--include','TAGS']);
  assert.equal(fingerprint(taskInput({...afterTask.taskDefinition,tags:afterTask.tags})),manifest.taskInputSha256);
  const receipt={status:'EXACT_NIGHTLY_TARGET_PIN_VERIFIED',at:new Date().toISOString(),packetSha256:fingerprint(packet),manifestSha256:fingerprint(manifest),
    rule:manifest.rule,targetId:manifest.targetId,taskDefinition:registeredArn,sourceSha:manifest.sourceSha,image:manifest.image,
    baselineTaskDefinition:manifest.baselineTaskDefinition,targetSha256:fingerprint(target),taskInputSha256:manifest.taskInputSha256,
    ruleSha256:manifest.baselineRuleSha256,strictProjectionWorker:'DISABLED_UNCHANGED',scheduleAndCommand:'UNCHANGED',manualInvocation:false,
    providerCalls:0,corpusMutations:0,rollback:manifest.rollback};
  record(receipt);save('memory-refresh-pin-apply-result.json',receipt);console.log(JSON.stringify(receipt,null,2));
} catch(error) {record({status:'STOPPED_REQUIRES_RECONCILIATION',registeredTaskDefinition:registeredArn??null,errorClass:error?.name??'Error',noAutomaticRetry:true});throw error;}
finally {closeSync(fd);}
