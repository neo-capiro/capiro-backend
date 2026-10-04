import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003';
const read=n=>JSON.parse(readFileSync(root+'/'+n));
const approval=read('combined-c2-human-approval.json'),packet=read('combined-c2-release-packet-v1.json');
const served=read('combined-c2-served-readback-v1.json');assert.equal(served.status,'EXACT_RELEASE_AND_ORDINARY_IDENTITY_VERIFIED');
const services=aws(['ecs','describe-services','--cluster','capiro-dev','--services',...packet.services.map(s=>'capiro-dev-'+s.service)]);
assert.equal(services.failures?.length??0,0);assert.equal(services.services.length,3);
const proof=[];
for(const expected of packet.services){
 const service=services.services.find(s=>s.serviceName==='capiro-dev-'+expected.service);assert.ok(service);
 const events=service.events.filter(e=>Date.parse(e.createdAt)>=Date.parse(approval.approvedAt)&&/has stopped [1-9][0-9]* running tasks:/u.test(e.message));
 const ids=[...new Set(events.flatMap(e=>[...e.message.matchAll(/\(task ([a-f0-9]{32})\)/gu)].map(m=>m[1])))];
 assert.equal(ids.length,expected.baseline.desiredCount,'Exact old task count required, empty list cannot prove retirement');
 const described=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',...ids]);assert.equal(described.failures?.length??0,0);
 assert.equal(described.tasks.length,ids.length);assert.deepEqual(described.tasks.map(t=>t.taskArn.split('/').at(-1)).sort(),[...ids].sort());
 const tasks=described.tasks.map(t=>{
  assert.equal(t.group,'service:capiro-dev-'+expected.service);assert.equal(t.taskDefinitionArn,expected.baseline.taskDefinitionArn);
  assert.equal(t.desiredStatus,'STOPPED');assert.equal(t.lastStatus,'STOPPED');assert.ok(Date.parse(t.stoppedAt)>=Date.parse(approval.approvedAt));
  return {taskArn:t.taskArn,taskDefinitionArn:t.taskDefinitionArn,lastStatus:t.lastStatus,desiredStatus:t.desiredStatus,stoppedAt:t.stoppedAt};
 });
 proof.push({service:expected.service,expectedOldTaskCount:expected.baseline.desiredCount,events,tasks});
}
const output={status:'EXACT_PREVIOUS_SERVICE_TASKS_STOPPED',recordedAt:new Date().toISOString(),servedReadbackSha256:createHash('sha256').update(readFileSync(root+'/combined-c2-served-readback-v1.json')).digest('hex'),reason:'The final desired-STOPPED list query returned zero rows. This supplement resolves exact old task IDs from post-approval ECS service stop events and requires each exact old task definition to report STOPPED.',services:proof,awsWrites:0,providerCalls:0};
writeFileSync(root+'/combined-c2-retired-tasks-v1.json',JSON.stringify(output,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(output,null,2));
