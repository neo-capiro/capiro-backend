import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {withInternalAuth,ctx} from './capiro-internal-auth-v1.mjs';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003/internal-sol-model-apply-v1',source='4b228386df0ddd2f34aea8f4bc1fcc1d1a8f985e';
let result;
await withInternalAuth(async({get,me,apiSourceSha})=>{
 assert.equal(apiSourceSha,source);
 const credentials=await get('/capiro-admin/tenants/'+ctx.tenantId+'/ai-credential');
 const audit=await get('/capiro-admin/audit-logs?action=ai_credential.model_override.update&limit=100');
 const td=aws(['ecs','describe-task-definition','--task-definition','capiro-dev-api:533']).taskDefinition,c=td.containerDefinitions.find(c=>c.name==='api');
 const env=c.environment.filter(e=>e.name==='INTERNAL_SERVICE_SECRET'),refs=c.secrets.filter(e=>e.name==='INTERNAL_SERVICE_SECRET');assert.equal(env.length+refs.length,1);
 const secret=env[0]?.value??aws(['secretsmanager','get-secret-value','--secret-id',refs[0].valueFrom]).SecretString;
 const r=await fetch('https://os.capiro.ai/api/internal/ai-credentials/resolve',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json','x-internal-service-secret':secret},body:JSON.stringify({tenantId:ctx.tenantId,provider:'openai'})});assert.equal(r.status,200);const raw=await r.json();
 result={at:new Date().toISOString(),kind:'READ_ONLY_MODEL_WRITE_RECONCILIATION',tenantId:ctx.tenantId,actorUserId:me.user.id,apiSourceSha,credentials:credentials.body,audit:audit.body,resolved:{resolved:raw.resolved,provider:raw.provider,model:raw.model,modelOverridden:raw.modelOverridden,usedTenantKey:raw.usedTenantKey},modelWrites:0,providerGenerations:0};
});
result.temporarySessionRevoked=true;writeFileSync(root+'/reconciliation-read-v1.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
