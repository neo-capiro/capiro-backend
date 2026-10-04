import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {aws,withAuth,ctx} from '../meri-fresh-20261003/auth-preflight.mjs';
import {releaseOperator} from '../../meri-c1-20261002/scripts/meri-release.mjs';
import {fingerprint,taskInput} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const out='C:/dev/main/outputs/meri-c2-20261003',root=out+'/sol-release-v1',read=p=>JSON.parse(readFileSync(p));
const path=root+'/served-readback.json';assert.equal(existsSync(path),false);
const initial=read(root+'/served-baseline.json'),source='4b228386df0ddd2f34aea8f4bc1fcc1d1a8f985e',operator=releaseOperator({aws});
const services=[],retiredTasks=[];
for(const s of initial.services){
 const live=await operator.snapshot(s.service);const c=live.task.containerDefinitions.find(c=>c.name===s.service);
 if(s.service==='web-vnext')assert.deepEqual(live.baseline,s.baseline);
 else{
  const packet=read(root+'/'+s.service+'/packet.json'),receipt=read(root+'/'+s.service+'/receipt.json');assert.equal(receipt.status,'ecs-healthy-manual-acceptance-required');
  assert.equal(live.baseline.taskDefinitionArn,receipt.candidateTaskDefinition);assert.equal(live.baseline.taskHash,packet.candidateTaskSha256);assert.equal(live.baseline.configHash,s.baseline.configHash);assert.equal(live.baseline.imageDigest,packet.candidate.image.split('@')[1]);assert.equal(c.environment.find(e=>e.name==='RELEASE_SHA').value,source);
  const before=packet.services.find(x=>x.service===s.service);const x=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',...before.oldTaskArns]);assert.equal(x.failures?.length??0,0);assert.deepEqual(x.tasks.map(t=>t.taskArn).sort(),[...before.oldTaskArns].sort());
  for(const t of x.tasks){assert.equal(t.group,'service:capiro-dev-'+s.service);assert.equal(t.taskDefinitionArn,before.baseline.taskDefinitionArn);assert.equal(t.lastStatus,'STOPPED','OLD_TASK_STILL_DRAINING');retiredTasks.push({taskArn:t.taskArn,taskDefinition:t.taskDefinitionArn,lastStatus:t.lastStatus,stoppedAt:t.stoppedAt});}
 }
 services.push({service:s.service,baseline:live.baseline,sourceSha:c.environment.find(e=>e.name==='RELEASE_SHA').value,health:'ALL_TASKS_AND_ACTUAL_ALB_TARGETS_HEALTHY'});
}
const n=initial.retainedNightly;assert.equal(fingerprint(aws(['events','describe-rule','--name',n.rule])),n.ruleSha256);
const targets=aws(['events','list-targets-by-rule','--rule',n.rule]);assert.equal(targets.NextToken,undefined);assert.equal(targets.Targets.length,1);assert.equal(fingerprint(targets.Targets[0]),n.targetSha256);
const td=aws(['ecs','describe-task-definition','--task-definition',n.taskDefinition,'--include','TAGS']);assert.equal(fingerprint(taskInput({...td.taskDefinition,tags:td.tags})),n.taskInputSha256);
assert.equal(fingerprint(aws(['events','describe-rule','--name','capiro-dev-memory-projection-worker'])),initial.broadProjectionWorker.ruleSha256);
let ordinaryIdentity,ordinaryMemoryRead;
await withAuth(async({bearer})=>{
 const get=async(path)=>{const r=await fetch('https://os.capiro.ai/api'+path,{headers:{Authorization:'Bearer '+bearer,'x-capiro-tenant':ctx.tenantSlug,'User-Agent':'Capiro-Meri-Authorized-QA/1.0'},redirect:'error',signal:AbortSignal.timeout(30000)});assert.equal(r.status,200);assert.equal(r.headers.get('x-capiro-release-sha'),source);return r.json();};
 const me=await get('/me');assert.equal(me.tenant?.id,ctx.tenantId);assert.equal(me.user?.id,ctx.userId);assert.equal(me.role,'standard_user');ordinaryIdentity={status:'ORDINARY_IDENTITY_ROUTE_PASS',actorUserId:ctx.userId,tenantId:ctx.tenantId,role:me.role,apiSourceSha:source};
 const clientId='41f9ec63-3963-479f-b747-59a3767ef44b',itemId='a740d74f-2c61-4888-bb59-5c9eea502e3f';const items=await get('/memory/items?clientId='+clientId);assert.ok(Array.isArray(items));assert.ok(items.every(i=>i.clientId===clientId));
 const found=items.filter(i=>i.id===itemId);assert.equal(found.length,1);const item=found[0];assert.equal(item.slug,'clio:70352101-16f8-42a3-9a4f-77c1c67111c9');assert.equal(item.visibility,'tenant');
 const doc=await get('/memory/items/'+encodeURIComponent(item.type)+'/'+encodeURIComponent(item.slug)+'/markdown');assert.equal(typeof doc.markdown,'string');
 for(const line of ['tenant_id: '+ctx.tenantId,'client_id: '+clientId,'slug: '+item.slug])assert.ok(doc.markdown.split('\n').includes(line));assert.ok(doc.markdown.includes('Synthetic Aster candidate for approval'));
 ordinaryMemoryRead={status:'ORDINARY_APPROVED_MEMORY_LIST_AND_MARKDOWN_PASS',tenantId:ctx.tenantId,actorUserId:ctx.userId,clientId,itemId,returnedListCount:items.length,markdownSha256:createHash('sha256').update(doc.markdown).digest('hex'),apiSourceSha:source,providerCalls:0};
});
const ack=read(out+'/sol-probe-budget-root-v1/native-ack.json');assert.equal(createHash('sha256').update(readFileSync('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl')).digest('hex'),ack.state.files['fresh-spend.jsonl'].sha256);
const proof={status:'SOL_COMPATIBLE_RELEASE_EXACT_SERVICES_ORDINARY_READ_AND_OLD_TASK_CLEANUP_PASS',at:new Date().toISOString(),services,retiredTasks,retainedNightly:n,broadProjectionWorker:'DISABLED',ordinaryIdentity,ordinaryMemoryRead,temporarySessionRevoked:true,providerCalls:0,journalMutations:0,acceptanceAuthority:false};writeFileSync(path,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:proof.status,services:services.map(s=>({service:s.service,taskDefinition:s.baseline.taskDefinitionArn,sourceSha:s.sourceSha})),ordinaryMemoryCount:ordinaryMemoryRead.returnedListCount}));
