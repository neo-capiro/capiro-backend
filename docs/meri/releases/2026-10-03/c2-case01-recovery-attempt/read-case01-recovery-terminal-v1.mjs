import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {withAuth,ctx} from '../meri-fresh-20261003/auth-preflight.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003';
const prior=root+'/case01-native-recovery-v1-bd35c0f4-1604-4371-b7e9-a1338369e53f';
const output=root+'/case01-recovery-terminal-readback-v1';
const hash=b=>createHash('sha256').update(b).digest('hex');
const execution=JSON.parse(readFileSync(prior+'/execution.json','utf8'));
assert.equal(execution.outcome.status,'CAPTURE_UNCERTAIN');assert.equal(execution.outcome.synthesisSubmissionCount,1);assert.equal(execution.sessionRevoked,true);
assert.equal(execution.conversationId,'f493355c-ee97-44a1-a0b0-e05e7b104b59');
const journalPath='C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl', before=readFileSync(journalPath);
mkdirSync(output);
const result={kind:'case01-recovery-terminal-owned-api-readback',status:'RUNNING',startedAt:new Date().toISOString(),
  captureRunId:execution.captureRunId,conversationId:execution.conversationId,tenantId:ctx.tenantId,userId:ctx.userId,
  priorExecutionSha256:hash(readFileSync(prior+'/execution.json')),applicationWrites:0,modelSubmissions:0,
  sessionRevoked:false,reads:[]};
const save=(name,v)=>{const fd=openSync(output+'/'+name,'wx',0o600);try{writeFileSync(fd,JSON.stringify(v,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}};
try{
  await withAuth(async({bearer})=>{
    const paths=['/api/me','/api/clio/conversations/'+execution.conversationId,'/api/clio/conversations/'+execution.conversationId+'/messages'];
    for(const [index,path] of paths.entries()){
      const r=await fetch('https://os.capiro.ai'+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),
        headers:{Authorization:'Bearer '+bearer,'User-Agent':'Capiro-Meri-Authorized-QA/1.0','x-capiro-tenant':ctx.tenantSlug}});
      const bytes=Buffer.from(await r.arrayBuffer()); assert.ok(bytes.length<2*1024*1024);
      const value=JSON.parse(bytes.toString('utf8'));assert.equal(bytes.includes(Buffer.from(bearer)),false);
      const observation={path,status:r.status,apiReleaseSha:r.headers.get('x-capiro-release-sha'),bodySha256:hash(bytes),bytes:bytes.length,observedAt:new Date().toISOString()};
      result.reads.push(observation); save('response-'+index+'.json',{observation,value});
      assert.equal(r.status,200); assert.equal(observation.apiReleaseSha,'5b086a6b47ffce5aa1b93bfe38f9c7b96e297642');
      if(index===0) assert.ok(value.tenant?.id===ctx.tenantId&&value.user?.id===ctx.userId&&value.role==='standard_user');
      if(index===1){assert.equal(value.id,execution.conversationId);assert.equal(value.userId,ctx.userId);assert.equal(value.tenantId,ctx.tenantId);result.conversation=value;}
      if(index===2){assert.equal(Array.isArray(value),true);result.messages=value;}
    }
  });
  result.sessionRevoked=true;result.status='READBACK_CAPTURED';
}catch(error){result.status='READBACK_FAILED';result.errorClass=error?.name??'Error';result.messageSha256=hash(String(error?.message??''));process.exitCode=1;}
finally{
  result.observedAt=new Date().toISOString();result.journalUnchanged=readFileSync(journalPath).equals(before);
  save('result.json',result);
  console.log(JSON.stringify({status:result.status,sessionRevoked:result.sessionRevoked,journalUnchanged:result.journalUnchanged,
    messageCount:result.messages?.length,metadataKeys:Object.keys(result.conversation?.metadata??{}),
    providerBudget:result.conversation?.metadata?.serverCaptureProviderBudget??null}));
}
