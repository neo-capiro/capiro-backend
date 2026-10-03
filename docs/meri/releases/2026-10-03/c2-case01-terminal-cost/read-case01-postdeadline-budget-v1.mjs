import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {withAuth,ctx} from '../meri-fresh-20261003/auth-preflight.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003';
const output=root+'/case01-postdeadline-budget-readback-v1';
const hash=b=>createHash('sha256').update(b).digest('hex');
const dbBytes=readFileSync(root+'/case01-receipt-diagnostic-v4/raw-prisma-readback.json');
assert.equal(hash(dbBytes),'8537890b349e1821c742be8442f746e607383e45e67913bf19e15c89744152ea');
const prior=JSON.parse(dbBytes),budget=prior.conversation.metadata.serverCaptureProviderBudget;
assert.equal(prior.conversationId,'f493355c-ee97-44a1-a0b0-e05e7b104b59');
assert.equal(budget.ledger.limits.deadlineAt,'2026-10-03T22:57:18.896Z');
assert.ok(Date.now()>Date.parse(budget.ledger.limits.deadlineAt));
const journalPath='C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl';
const before=readFileSync(journalPath);
assert.equal(hash(before),'7ac5a5d06782d325e0d30327586968aa60233681b7dec2ed98f50285ed6daa60');
mkdirSync(output);
const save=(name,v)=>{const fd=openSync(output+'/'+name,'wx',0o600);try{writeFileSync(fd,JSON.stringify(v,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}};
const result={kind:'case01-postdeadline-owned-provider-budget-readback',status:'RUNNING',startedAt:new Date().toISOString(),
  captureRunId:prior.captureRunId,conversationId:prior.conversationId,tenantId:ctx.tenantId,userId:ctx.userId,
  priorDiagnosticSha256:hash(dbBytes),applicationWrites:0,modelSubmissions:0,sessionRevoked:false,captureAuthority:false,reads:[]};
let callbackError;
try{
  await withAuth(async({bearer})=>{
    try{
      const paths=['/api/me','/api/clio/conversations/'+prior.conversationId];
      for(const [index,path] of paths.entries()){
        const r=await fetch('https://os.capiro.ai'+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),
          headers:{Authorization:'Bearer '+bearer,'User-Agent':'Capiro-Meri-Authorized-QA/1.0','x-capiro-tenant':ctx.tenantSlug}});
        const bytes=Buffer.from(await r.arrayBuffer());assert.ok(bytes.length<128*1024);assert.equal(bytes.includes(Buffer.from(bearer)),false);
        const value=JSON.parse(bytes.toString('utf8'));
        const observation={path,status:r.status,apiReleaseSha:r.headers.get('x-capiro-release-sha'),bodySha256:hash(bytes),bytes:bytes.length,observedAt:new Date().toISOString()};
        result.reads.push(observation);save('response-'+index+'.json',{observation,value});
        assert.equal(r.status,200);assert.equal(observation.apiReleaseSha,prior.sourceSha);
        if(index===0)assert.ok(value.tenant?.id===ctx.tenantId&&value.user?.id===ctx.userId&&value.role==='standard_user');
        else{
          assert.equal(value.id,prior.conversationId);assert.equal(value.userId,ctx.userId);assert.equal(value.tenantId,ctx.tenantId);assert.equal(value.clientId,prior.clientId);
          assert.ok(Date.parse(observation.observedAt)>Date.parse(budget.ledger.limits.deadlineAt));
          assert.ok(isDeepStrictEqual(value.metadata.serverCaptureProviderBudget,budget));
          assert.equal(budget.ledger.attempts.length,5);assert.ok(budget.ledger.attempts.every(a=>a.status==='settled'));
          assert.equal(budget.ledger.chargedCostMicros,2292602);
          result.conversation=value;result.providerBudgetUnchanged=true;result.afterProviderDeadline=true;
        }
      }
    }catch(error){callbackError=error;}
  });
  result.sessionRevoked=true;
  if(callbackError)throw callbackError;
  result.status='READBACK_CAPTURED';
}catch(error){result.status='READBACK_FAILED';result.errorClass=error?.name??'Error';result.messageSha256=hash(String(error?.message??''));process.exitCode=1;}
finally{
  result.finishedAt=new Date().toISOString();result.journalUnchanged=readFileSync(journalPath).equals(before);
  save('result.json',result);assert.ok(result.journalUnchanged);
  console.log(JSON.stringify({status:result.status,sessionRevoked:result.sessionRevoked,afterProviderDeadline:result.afterProviderDeadline??false,
    providerBudgetUnchanged:result.providerBudgetUnchanged??false,journalUnchanged:result.journalUnchanged,resultPath:output+'/result.json'}));
}
