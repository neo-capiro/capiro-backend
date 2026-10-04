import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {aws,withAuth,ctx} from '../meri-fresh-20261003/auth-preflight.mjs';
import {releaseOperator} from '../../meri-c1-20261002/scripts/meri-release.mjs';
import {fingerprint,taskInput} from '../../meri-c1-20261002/scripts/lib/meri-release-policy.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003';
const read=n=>JSON.parse(readFileSync(root+'/'+n));
const output=root+'/case12-planner-release-v1/served-readback.json';assert.equal(existsSync(output),false);
const newPacket=read('case12-planner-release-v1/packet.json');
assert.equal(fingerprint(newPacket),'4f614b21c7a9d954d0d0886dc2e27d1f2312f242b284431e181cc96cc2835a97');
const packet={...newPacket,...newPacket.baseline},receipt=read('case12-planner-release-v1/receipt.json');
assert.equal(receipt.status,'ecs-healthy-manual-acceptance-required');
const operator=releaseOperator({aws}),services=[];let api;
for(const s of packet.services){
 const live=await operator.snapshot(s.service);
 if(s.service==='api'){
  assert.equal(live.baseline.taskDefinitionArn,receipt.candidateTaskDefinition);assert.equal(live.baseline.taskHash,packet.candidateTaskSha256);assert.equal(live.baseline.imageDigest,packet.candidate.image.split('@')[1]);assert.equal(live.baseline.configHash,s.baseline.configHash);
  assert.equal(live.task.containerDefinitions.find(c=>c.name==='api').environment.find(e=>e.name==='RELEASE_SHA').value,packet.candidate.sourceSha);api=live;
 }else assert.deepEqual(live.baseline,s.baseline);
 services.push({service:s.service,baseline:live.baseline,health:'ALL_TASKS_AND_ACTUAL_ALB_TARGETS_HEALTHY'});
}
let oldTasks;const deadline=Date.now()+10*60000;
while(true){const x=aws(['ecs','describe-tasks','--cluster','capiro-dev','--tasks',...packet.oldApiTaskArns]);assert.equal(x.failures?.length??0,0);assert.deepEqual(x.tasks.map(t=>t.taskArn).sort(),[...packet.oldApiTaskArns].sort());
 for(const t of x.tasks){assert.equal(t.group,'service:capiro-dev-api');assert.equal(t.taskDefinitionArn,packet.services.find(s=>s.service==='api').baseline.taskDefinitionArn);}
 if(x.tasks.every(t=>t.lastStatus==='STOPPED')){oldTasks=x.tasks.map(t=>({taskArn:t.taskArn,taskDefinitionArn:t.taskDefinitionArn,lastStatus:t.lastStatus,stoppedAt:t.stoppedAt}));break;}
 assert.ok(Date.now()<deadline,'OLD_TASKS_STILL_DRAINING_NO_RETRY_MUTATION');await new Promise(r=>setTimeout(r,5000));
}
const nightly=packet.retainedNightly;assert.equal(fingerprint(aws(['events','describe-rule','--name',nightly.rule])),nightly.ruleSha256);
const targets=aws(['events','list-targets-by-rule','--rule',nightly.rule]);assert.equal(targets.Targets.length,1);assert.equal(targets.NextToken,undefined);assert.equal(fingerprint(targets.Targets[0]),nightly.targetSha256);
const td=aws(['ecs','describe-task-definition','--task-definition',nightly.taskDefinition,'--include','TAGS']);assert.equal(td.taskDefinition.status,'ACTIVE');assert.equal(fingerprint(taskInput({...td.taskDefinition,tags:td.tags})),nightly.taskInputSha256);
assert.equal(aws(['events','describe-rule','--name','capiro-dev-memory-projection-worker']).State,'DISABLED');
let ordinaryIdentity,ordinaryMemoryRead;
await withAuth(async({bearer})=>{
  const response=await fetch('https://os.capiro.ai/api/me',{headers:{Authorization:'Bearer '+bearer,'x-capiro-tenant':ctx.tenantSlug,'User-Agent':'Capiro-Meri-Authorized-QA/1.0'},redirect:'error',signal:AbortSignal.timeout(30000)});
  const me=await response.json();assert.equal(response.status,200);assert.equal(me.tenant?.id,ctx.tenantId);assert.equal(me.user?.id,ctx.userId);assert.equal(me.role,'standard_user');
  assert.equal(response.headers.get('x-capiro-release-sha'),packet.candidate.sourceSha);
  ordinaryIdentity={status:'ORDINARY_IDENTITY_ROUTE_PASS',httpStatus:200,actorUserId:ctx.userId,tenantId:ctx.tenantId,role:'standard_user',apiSourceSha:response.headers.get('x-capiro-release-sha')};
  const get=async(path)=>{const response=await fetch('https://os.capiro.ai/api'+path,{headers:{Authorization:'Bearer '+bearer,'x-capiro-tenant':ctx.tenantSlug,'User-Agent':'Capiro-Meri-Authorized-QA/1.0'},redirect:'error',signal:AbortSignal.timeout(30000)});assert.equal(response.status,200);assert.equal(response.headers.get('x-capiro-release-sha'),packet.candidate.sourceSha);return await response.json();};
  const clientId='41f9ec63-3963-479f-b747-59a3767ef44b',itemId='a740d74f-2c61-4888-bb59-5c9eea502e3f';
  const items=await get('/memory/items?clientId='+clientId);assert.ok(Array.isArray(items));assert.ok(items.every(i=>i.clientId===clientId));
  const matches=items.filter(i=>i.id===itemId);assert.equal(matches.length,1);const item=matches[0];assert.equal(item.slug,'clio:70352101-16f8-42a3-9a4f-77c1c67111c9');assert.equal(item.visibility,'tenant');
  const path='/memory/items/'+encodeURIComponent(item.type)+'/'+encodeURIComponent(item.slug)+'/markdown';
  const document=await get(path);assert.equal(typeof document.markdown,'string');assert.equal(typeof document.path,'string');
  for(const line of ['tenant_id: '+ctx.tenantId,'client_id: '+clientId,'slug: '+item.slug])assert.ok(document.markdown.split('\n').includes(line));
  assert.ok(document.markdown.includes('Synthetic Aster candidate for approval'));
  ordinaryMemoryRead={status:'ORDINARY_APPROVED_MEMORY_LIST_AND_MARKDOWN_PASS',httpStatuses:[200,200],actorUserId:ctx.userId,tenantId:ctx.tenantId,clientId,itemId,type:item.type,slug:item.slug,visibility:item.visibility,updatedAt:item.updatedAt,returnedListCount:items.length,markdownBytes:Buffer.byteLength(document.markdown),markdownSha256:createHash('sha256').update(document.markdown).digest('hex'),path:document.path,apiSourceSha:packet.candidate.sourceSha,providerCalls:0,scope:'Ordinary authenticated product read only; no search embedding, capture policy, replay, acceptance or canonical completeness assertion.'};

});
const journal=readFileSync('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl');assert.equal(createHash('sha256').update(journal).digest('hex'),read('budget-amendment-root-v1/result.json').journalAfterSha256);
const proof={status:'EXACT_API_PLANNER_RELEASE_ORDINARY_READ_AND_OLD_TASK_CLEANUP_VERIFIED',recordedAt:new Date().toISOString(),packetSha256:fingerprint(newPacket),services,oldApiTasks:oldTasks,retainedNightly:nightly,broadProjectionWorker:'DISABLED',ordinaryIdentity,ordinaryMemoryRead,temporarySessionRevoked:true,providerCalls:0,conversationCreations:0,journalMutations:0,fixtureMutations:0,originalAcceptance:'UNCHANGED_NOT_RUN'};
writeFileSync(output,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(proof,null,2));
