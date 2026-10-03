import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {releaseOperator} from '../../meri-c1-20261002/scripts/meri-release.mjs';
import {fingerprint,taskInput} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003';
const read=name=>JSON.parse(readFileSync(root+'/'+name,'utf8'));
function tasksFor(filter) {
  const refs=[...new Set(['RUNNING','STOPPED'].flatMap(status=>aws(['ecs','list-tasks','--cluster','capiro-dev',...filter,'--desired-status',status]).taskArns))];
  const tasks=[];
  for(let i=0;i<refs.length;i+=100){const chunk=refs.slice(i,i+100),r=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',...chunk]);assert.equal(r.failures?.length??0,0);assert.deepEqual(r.tasks.map(t=>t.taskArn).sort(),[...chunk].sort());tasks.push(...r.tasks);}
  return tasks;
}
export async function verifyMemoryWriters() {
  const packet=read('memory-lifecycle-release-packet.json'),approval=read('memory-lifecycle-human-approval.json');
  assert.equal(approval.status,'APPROVED');assert.equal(approval.packetSha256,fingerprint(packet));
  assert.equal(approval.scope,'EXACT_C2_MEMORY_RELEASE_AND_BOUNDED_MAINTENANCE');assert.ok(Date.parse(packet.expiresAt)>Date.now());
  const operator=releaseOperator({aws}),identities=[];let apiSnapshot;
  for(const service of ['api','meriv2-orchestrator','web-vnext']) {
    const live=await operator.snapshot(service),expected=packet.services.find(s=>s.service===service);
    if(service==='web-vnext')assert.deepEqual(live.baseline,expected.baseline);
    else {assert.equal(live.baseline.taskHash,expected.candidateTaskSha256);assert.equal(live.baseline.imageDigest,expected.candidate.image.split('@')[1]);assert.equal(live.baseline.configHash,expected.baseline.configHash);}
    identities.push({service,baseline:live.baseline});if(service==='api')apiSnapshot=live;
  }
  const apiTasks=tasksFor(['--service-name','capiro-dev-api']);
  const activeApi=apiTasks.filter(t=>t.lastStatus!=='STOPPED');
  assert.equal(activeApi.length,apiSnapshot.baseline.desiredCount);
  for(const t of activeApi){assert.equal(t.lastStatus,'RUNNING');assert.equal(t.taskDefinitionArn,apiSnapshot.baseline.taskDefinitionArn);assert.equal(t.containers.find(c=>c.name==='api')?.imageDigest,apiSnapshot.baseline.imageDigest);}
  const pin=read('memory-refresh-pin-apply-result.json'),manifest=read('memory-refresh-pin-manifest.json');
  assert.equal(pin.status,'EXACT_NIGHTLY_TARGET_PIN_VERIFIED');assert.equal(pin.packetSha256,fingerprint(packet));
  assert.equal(fingerprint(manifest),packet.nightlyManifestSha256);assert.equal(pin.manifestSha256,fingerprint(manifest));
  assert.equal(pin.image,manifest.image);assert.equal(pin.sourceSha,manifest.sourceSha);
  const rule=aws(['events','describe-rule','--name',manifest.rule]);assert.equal(fingerprint(rule),manifest.baselineRuleSha256);
  const targets=aws(['events','list-targets-by-rule','--rule',manifest.rule]).Targets;
  assert.equal(targets.length,1);assert.equal(fingerprint(targets[0]),pin.targetSha256);assert.equal(targets[0].EcsParameters.TaskDefinitionArn,pin.taskDefinition);
  const pinned=aws(['ecs','describe-task-definition','--task-definition',pin.taskDefinition,'--include','TAGS']);
  assert.equal(pinned.taskDefinition.status,'ACTIVE');assert.equal(fingerprint(taskInput({...pinned.taskDefinition,tags:pinned.tags})),manifest.taskInputSha256);
  const migrationTasks=tasksFor(['--family',manifest.taskFamily]),activeOtherCommands=[];
  for(const t of migrationTasks.filter(t=>t.lastStatus!=='STOPPED')) {
    const td=aws(['ecs','describe-task-definition','--task-definition',t.taskDefinitionArn]).taskDefinition;
    const command=t.overrides?.containerOverrides?.find(c=>c.name==='api')?.command??td.containerDefinitions.find(c=>c.name==='api')?.command;
    assert.ok(Array.isArray(command)&&command.length,'Unverified active shared-family task');
    assert.notEqual(command[0],'refresh-memory-graph','Nightly refresh still active');
    activeOtherCommands.push({taskArn:t.taskArn,commandName:command[0]});
  }
  const strict=aws(['events','describe-rule','--name','capiro-dev-memory-projection-worker']);
  assert.equal(strict.State,'DISABLED');assert.equal(fingerprint(strict),manifest.strictProjectionWorker.ruleSha256);
  const strictTargets=aws(['events','list-targets-by-rule','--rule','capiro-dev-memory-projection-worker']).Targets;
  assert.equal(fingerprint(strictTargets),manifest.strictProjectionWorker.targetsSha256);
  const strictTasks=tasksFor(['--family','capiro-dev-memory-projection-worker']);
  assert.equal(strictTasks.filter(t=>t.lastStatus!=='STOPPED').length,0,'Existing broad cleanup worker is still active');
  assert.ok(Date.parse(packet.expiresAt)>Date.now());
  return {apiSnapshot,proof:{status:'GUARDED_MEMORY_WRITERS_VERIFIED',at:new Date().toISOString(),packetSha256:fingerprint(packet),
    identities,activeApiTasks:activeApi.map(t=>({taskArn:t.taskArn,taskDefinition:t.taskDefinitionArn,lastStatus:t.lastStatus})),
    oldActiveApiWriters:0,oldStoppedApiTasks:apiTasks.filter(t=>t.lastStatus==='STOPPED'&&t.taskDefinitionArn!==apiSnapshot.baseline.taskDefinitionArn).map(t=>t.taskArn),
    nightlyTaskDefinition:pin.taskDefinition,activeNightlyWriters:0,activeOtherSharedFamilyCommands:activeOtherCommands,
    strictProjectionWorker:'DISABLED_NO_ACTIVE_TASKS',schemaOrServiceMutation:false}};
}
