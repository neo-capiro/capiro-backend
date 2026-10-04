import {readFileSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import assert from 'node:assert/strict';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {fingerprint} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003',read=n=>JSON.parse(readFileSync(root+'/'+n,'utf8'));
const packet=read('case14-source-release-packet-v2.json'),approval=read('memory-source-human-approval.json');
assert.equal(fingerprint(packet),approval.packetSha256);assert.equal(approval.status,'APPROVED');
const services=[];
for(const target of packet.services){
  const key=target.service,receipt=read(key+'-memory-source-promotion-receipt.json');
  assert.equal(receipt.status,'ecs-healthy-manual-acceptance-required');
  const response=aws(['ecs','describe-services','--cluster','capiro-dev','--services','capiro-dev-'+key]);
  assert.equal(response.failures?.length??0,0);assert.equal(response.services.length,1);const service=response.services[0];
  assert.equal(service.taskDefinition,receipt.candidateTaskDefinition);assert.equal(service.deployments.length,1);assert.equal(service.deployments[0].id,receipt.deploymentId);assert.equal(service.deployments[0].rolloutState,'COMPLETED');
  const stopEvents=service.events.filter(e=>Date.parse(e.createdAt)>=Date.parse(approval.approvedAt)&&e.message.startsWith('(service capiro-dev-'+key+') has stopped '));
  const ids=[...new Set(stopEvents.flatMap(e=>[...e.message.matchAll(/\(task ([a-f0-9]{32})\)/g)].map(m=>m[1])))];
  assert.equal(ids.length,target.baseline.desiredCount,'Exact baseline retirement event inventory missing');
  const arns=ids.map(id=>'arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/'+id);
  const tasks=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',...arns]);
  assert.equal(tasks.failures?.length??0,0);assert.equal(tasks.tasks.length,arns.length);assert.deepEqual(tasks.tasks.map(t=>t.taskArn).sort(),[...arns].sort());
  const rows=tasks.tasks.map(t=>{
    assert.equal(t.clusterArn,'arn:aws:ecs:us-east-1:967807252336:cluster/capiro-dev');assert.equal(t.group,'service:capiro-dev-'+key);assert.equal(t.taskDefinitionArn,target.baseline.taskDefinitionArn);
    assert.equal(t.lastStatus,'STOPPED');assert.equal(t.desiredStatus,'STOPPED');assert.ok(Date.parse(t.stoppedAt)>=Date.parse(approval.approvedAt));
    const containers=t.containers.filter(c=>c.name===key);assert.equal(containers.length,1);assert.equal(containers[0].imageDigest,target.baseline.imageDigest);assert.equal(containers[0].lastStatus,'STOPPED');
    return {taskArn:t.taskArn,taskDefinitionArn:t.taskDefinitionArn,lastStatus:t.lastStatus,desiredStatus:t.desiredStatus,imageDigest:containers[0].imageDigest,stoppedAt:t.stoppedAt,stopCode:t.stopCode};
  });
  services.push({service:key,currentDeploymentId:receipt.deploymentId,currentTaskDefinition:receipt.candidateTaskDefinition,baselineDesiredCount:target.baseline.desiredCount,stopEvents,oldTasks:rows});
}
const proof={status:'EXACT_PRIOR_BASELINE_TASKS_STOPPED',recordedAt:new Date().toISOString(),packetSha256:fingerprint(packet),services,providerCalls:0,awsWrites:0,scope:'Supplement to served v1: its STOPPED-list response was empty and alone cannot establish old-task identities. Current service stop events locate exact prior task ARNs; describe-tasks verifies every expected prior baseline revision/digest and actual STOPPED state.'};
const fd=openSync(root+'/memory-source-old-task-readback-v1.json','wx');try{writeFileSync(fd,JSON.stringify(proof,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
console.log(JSON.stringify(proof,null,2));
