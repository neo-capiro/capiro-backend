import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {withInternalAuth,ctx} from './capiro-internal-auth-v1.mjs';
import {releaseOperator} from '../../meri-c1-20261002/scripts/meri-release.mjs';
const out='C:/dev/main/outputs/meri-c2-20261003',dir=out+'/internal-sol-model-apply-v1',source='4b228386df0ddd2f34aea8f4bc1fcc1d1a8f985e';
const read=p=>JSON.parse(readFileSync(p)),sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(existsSync(dir),false,'PRIOR_ATTEMPT_RECONCILE_ONLY');
assert.equal(read(out+'/sol-live-probe-v1/execution/result.json').status,'LIVE_MODEL_AND_TOOL_CONTINUATION_PROBE_PASS');
const op=releaseOperator({aws});let apiTask;
for(const service of ['api','meriv2-orchestrator']){
 const receipt=read(out+'/sol-release-v1/'+service+'/receipt.json'),packet=read(out+'/sol-release-v1/'+service+'/packet.json');assert.equal(receipt.status,'ecs-healthy-manual-acceptance-required');
 const live=await op.snapshot(service);assert.equal(live.baseline.taskDefinitionArn,receipt.candidateTaskDefinition);assert.equal(live.baseline.taskHash,packet.candidateTaskSha256);assert.equal(live.task.containerDefinitions.find(c=>c.name===service).environment.find(e=>e.name==='RELEASE_SHA').value,source);if(service==='api')apiTask=live.task;
}
const budget=read(out+'/sol-probe-budget-root-v1/native-ack.json');assert.equal(sha(readFileSync('C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl')),budget.state.files['fresh-spend.jsonl'].sha256);
mkdirSync(dir);const save=(n,v)=>writeFileSync(dir+'/'+n,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
let mutationAttempted=false;
try{
 await withInternalAuth(async({get,me,apiSourceSha,bearer})=>{
  assert.equal(apiSourceSha,source);assert.equal(me.user.id,'48b8b988-2f7e-458a-999e-9e476ed70752');
  const path='/capiro-admin/tenants/'+ctx.tenantId+'/ai-credential';
  const before=await get(path);assert.equal(before.sourceSha,source);assert.ok(Array.isArray(before.body));
  const rows=before.body.filter(c=>c.provider==='openai');assert.equal(rows.length,1);const old=rows[0];
  assert.equal(old.status,'active');assert.equal(old.last4,'KfYA');assert.equal(old.modelOverride,null);assert.equal(old.updatedAt,'2026-06-12T04:18:18.563Z');assert.equal(old.lastValidatedAt,'2026-06-12T04:18:18.547Z');
  const body={provider:'openai',modelOverride:'gpt-6.1-sol',expectedModelOverride:old.modelOverride,expectedUpdatedAt:old.updatedAt};
  const intent={at:new Date().toISOString(),tenantId:ctx.tenantId,actorUserId:me.user.id,sourceSha:source,before:before.body,request:body,noAutomaticRetry:true};save('intent.json',intent);mutationAttempted=true;
  const response=await fetch('https://os.capiro.ai/api'+path+'/model',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+bearer,'x-capiro-tenant':ctx.tenantSlug,'Content-Type':'application/json','User-Agent':'Capiro-Meri-Authorized-QA/1.0'},body:JSON.stringify(body)});
  const responseBody=await response.json();
  save('response.json',{httpStatus:response.status,sourceSha:response.headers.get('x-capiro-release-sha'),maskedCredential:response.ok?responseBody:null});
  // Read back even if the response was non-2xx: audit and model writes use separate transactions.
  const after=await get(path);assert.equal(after.sourceSha,source);const changed=after.body.find(c=>c.provider==='openai');
  const audit=await get('/capiro-admin/audit-logs?action=ai_credential.model_override.update&entityType=tenant_ai_credential&actorUserId='+me.user.id+'&from='+encodeURIComponent(intent.at)+'&limit=100');
  const matches=audit.body.data.filter(r=>r.tenantId===ctx.tenantId&&r.entityId===ctx.tenantId+':openai'&&r.actorUserId===me.user.id);
  save('readback.json',{at:new Date().toISOString(),credentials:after.body,auditRows:matches});
  assert.ok(response.ok,'MODEL_WRITE_RESPONSE_REQUIRES_RECONCILIATION');assert.equal(response.headers.get('x-capiro-release-sha'),source);
  assert.equal(changed.modelOverride,'gpt-6.1-sol');assert.notEqual(changed.updatedAt,old.updatedAt);assert.equal(new Date(changed.updatedAt).toISOString(),changed.updatedAt);
  for(const k of ['provider','last4','lastValidatedAt','status'])assert.equal(changed[k],old[k]);
  assert.deepEqual(after.body.filter(c=>c.provider!=='openai'),before.body.filter(c=>c.provider!=='openai'));
  assert.equal(matches.length,1);assert.deepEqual(matches[0].before,{modelOverride:null,updatedAt:old.updatedAt});assert.deepEqual(matches[0].after,{tenantId:ctx.tenantId,provider:'openai',modelOverride:'gpt-6.1-sol',status:'active'});
  const c=apiTask.containerDefinitions.find(c=>c.name==='api'),env=c.environment?.filter(e=>e.name==='INTERNAL_SERVICE_SECRET')??[],refs=c.secrets?.filter(e=>e.name==='INTERNAL_SERVICE_SECRET')??[];assert.equal(env.length+refs.length,1);
  const internal=env[0]?.value??aws(['secretsmanager','get-secret-value','--secret-id',refs[0].valueFrom]).SecretString;
  const r=await fetch('https://os.capiro.ai/api/internal/ai-credentials/resolve',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json','x-internal-service-secret':internal},body:JSON.stringify({tenantId:ctx.tenantId,provider:'openai'})});
  assert.equal(r.status,200);assert.equal(r.headers.get('x-capiro-release-sha'),source);const resolved=await r.json();
  assert.equal(resolved.resolved,true);assert.equal(resolved.provider,'openai');assert.equal(resolved.usedTenantKey,true);assert.equal(resolved.modelOverridden,true);assert.equal(resolved.model,'gpt-6.1-sol');
  save('verified.json',{status:'INTERNAL_SOL_MODEL_NATIVE_WRITE_READBACK_AUDIT_RESOLUTION_PASS',at:new Date().toISOString(),tenantId:ctx.tenantId,tenantSlug:ctx.tenantSlug,actorUserId:me.user.id,apiSourceSha:source,model:resolved.model,modelOverridden:true,usedTenantKey:true,auditId:matches[0].id,maskedCredential:changed,otherProviderRowsUnchanged:true,keyLast4AndValidationTimeUnchanged:true,providerGenerations:0,globalDefaultsChanged:false,acceptanceAuthority:false});
 });
 save('session-cleanup.json',{at:new Date().toISOString(),temporarySessionRevoked:true});console.log(JSON.stringify({status:'INTERNAL_SOL_MODEL_NATIVE_WRITE_READBACK_AUDIT_RESOLUTION_PASS',tenant:ctx.tenantSlug,model:'gpt-6.1-sol'}));
}catch(error){save('reconciliation-required.json',{at:new Date().toISOString(),mutationAttempted,status:'DO_NOT_REPLAY_RECONCILE_NATIVE_STATE',errorName:error?.name??'Error'});console.error('Scoped model operation did not finish verification; inspect sanitized evidence and reconcile without replay.');process.exitCode=1;}
