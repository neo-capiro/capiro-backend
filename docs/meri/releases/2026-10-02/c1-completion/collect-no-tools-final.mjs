import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {releaseOperator} from '../../meri-c1-20261002/scripts/meri-release.mjs';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root='C:/dev/main/outputs/meri-c1-20261002';
const ui=JSON.parse(readFileSync(root+'/browser-no-tools-final.json','utf8'));
const promotion=JSON.parse(readFileSync(root+'/orchestrator-no-tools-promotion.json','utf8'));
const approval=JSON.parse(readFileSync(root+'/owner-no-tools-approval.json','utf8'));
assert.equal(promotion.status,'ecs-healthy-manual-acceptance-required');
assert.equal(promotion.manifestHash,approval.effectiveManifestHash);
assert.equal(ui.sourceSha,approval.sourceSha);
assert.equal(ui.cases.length,4);
const previous=JSON.parse(readFileSync(root+'/mail-defaults-final-service-readback.json','utf8'));
const op=releaseOperator({aws});
const identities=[];
for(const service of ['api','meriv2-orchestrator','web-vnext']){
  const r=await op.snapshot(service);
  const container=r.task.containerDefinitions.find(c=>c.name===service);
  const source=container.environment?.find(e=>e.name==='RELEASE_SHA')?.value??container.environment?.find(e=>e.name==='GIT_SHA')?.value;
  assert.match(source??'',/^[a-f0-9]{40}$/);
  if(service==='meriv2-orchestrator'){
    assert.equal(r.baseline.taskDefinitionArn,promotion.candidateTaskDefinition);
    assert.equal(r.baseline.configHash,promotion.configHash);assert.equal(r.baseline.taskHash,promotion.candidateTaskHash);
    assert.equal(r.baseline.imageDigest,promotion.candidateImage.split('@')[1]);assert.equal(source,ui.sourceSha);
  }else{assert.deepEqual(r.baseline,previous.identities.find(i=>i.service===service).baseline);}
  identities.push({service,baseline:r.baseline,image:container.image,sourceSha:source,
    rollout:r.service.deployments.map(d=>({id:d.id,status:d.status,rolloutState:d.rolloutState,runningCount:d.runningCount,pendingCount:d.pendingCount,failedTasks:d.failedTasks}))});
}
writeFileSync(root+'/no-tools-final-service-readback.json',JSON.stringify({observedAt:new Date().toISOString(),status:'VERIFIED',identities,approvalManifestHash:promotion.manifestHash,awsWrites:0},null,2)+'\n',{flag:'wx'});
const start=Math.min(...ui.cases.map(c=>Date.parse(c.submittedAt)))-30000;
const end=Math.max(...ui.cases.map(c=>Date.parse(c.terminalObservedAt)))+30000;
assert.ok(Number.isFinite(start)&&Number.isFinite(end));
const events=[];let token,complete=false;
for(let page=0;page<10;page++){
  const args=['logs','filter-log-events','--log-group-name','/capiro/dev/api','--start-time',String(start),'--end-time',String(end),'--filter-pattern','"1117e250-4007-47a7-9158-1dcfcf5dc435"','--limit','10000','--no-paginate'];
  if(token)args.push('--next-token',token);
  const result=aws(args);
  for(const e of result.events??[]){
    let v;try{v=JSON.parse(e.message.slice(e.message.indexOf('{'),e.message.lastIndexOf('}')+1));}catch{continue;}
    if(v.event!=='meri.telemetry')continue;
    events.push({at:new Date(e.timestamp).toISOString(),name:v.name,boundary:v.boundary,traceId:v.traceId,requestId:v.requestId,serverTurnId:v.serverTurnId,runId:v.runId,tools:v.invokedTools??[],outcome:v.outcome,durationMs:v.durationMs,requestedModel:v.requestedModel,effectiveModel:v.effectiveModel,rawEventSha256:createHash('sha256').update(e.message).digest('hex')});
  }
  if(!result.nextToken||result.nextToken===token){complete=true;break;}token=result.nextToken;
}
assert.ok(complete,'Telemetry pagination incomplete');
const groups=Map.groupBy(events,e=>e.runId);assert.equal(groups.size,4,'Unexpected browser run count');
const ordered=[...groups].sort((a,b)=>a[1][0].at.localeCompare(b[1][0].at));
const joined=ordered.map(([runId,items],index)=>{
  const received=items.filter(e=>e.name==='meri.api.request.received');const final=items.filter(e=>e.name==='meri.api.request.finalized');
  assert.equal(received.length,1);assert.equal(final.length,1);
  for(const key of ['traceId','requestId','serverTurnId'])assert.equal(new Set(items.map(e=>e[key])).size,1);
  assert.ok(Math.abs(Date.parse(final[0].at)-Date.parse(received[0].at)-final[0].durationMs)<=1);
  const invoked=items.filter(e=>e.name==='meri.tool.step.finalized');
  assert.deepEqual(invoked.flatMap(e=>e.tools),ui.cases[index].tools);assert.equal(invoked.length,ui.cases[index].toolCount);
  return{caseId:ui.cases[index].id,runId,traceId:received[0].traceId,requestId:received[0].requestId,serverTurnId:received[0].serverTurnId,receivedAt:received[0].at,finalizedAt:final[0].at,serverRequestDurationMs:final[0].durationMs,requestOutcome:final[0].outcome,tools:invoked.map(e=>({name:e.tools[0],outcome:e.outcome,durationMs:e.durationMs})),ownerTools:items.filter(e=>e.name==='meri.api.tool.finalized').map(e=>({name:e.tools[0],outcome:e.outcome,durationMs:e.durationMs}))};
});
writeFileSync(root+'/no-tools-final-telemetry.json',JSON.stringify({observedAt:new Date().toISOString(),complete,window:{start:new Date(start).toISOString(),end:new Date(end).toISOString()},events,joined,associationLimit:'Browser case labels correlate by serial order and matching tool names/counts; exact server run/trace/request/turn IDs join server spans only.',timingLimit:'Browser observations are upper bounds; server request spans exclude browser rendering. Neither is first-token latency or p95.',rawContentsPersisted:false,awsWrites:0},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({serviceReadback:'VERIFIED',telemetryComplete:complete,telemetryEvents:events.length,joined,awsWrites:0},null,2));
