import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {withAuth,ctx} from '../meri-fresh-20261003/auth-preflight.mjs';
import {sha256Stable} from '../../meri-c1-20261002/evals/meri/live-v1/lib/stable.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003';
const priorRoot=root+'/case20-native-recovery-v3-f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b';
const output=root+'/case20-postdeadline-budget-readback-v2';
const hash=b=>createHash('sha256').update(b).digest('hex');
const execution=JSON.parse(readFileSync(priorRoot+'/execution.json'));
assert.equal(execution.caseId,'20');assert.equal(execution.captureRunId,'f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b');
assert.equal(execution.conversationId,'db0e01ac-60a1-4e3c-b8ba-66748d087a2e');
assert.equal(execution.sessionRevoked,true);assert.equal(execution.outcome.status,'CAPTURE_UNCERTAIN');
assert.equal(execution.outcome.synthesisSubmissionCount,1);assert.ok(execution.completedAt);
const observation=JSON.parse(readFileSync(priorRoot+'/artifacts/saved-messages-observation.json'));
const priorMessages=JSON.parse(observation.text),priorAssistant=priorMessages.find(x=>x.role==='assistant');
const receipt=priorAssistant.metadata.serverCaptureEvidenceReceipt.receipt;
assert.equal(receipt.status,'BLOCKED');assert.equal(receipt.providerBudget.status,'SETTLED');
assert.equal(receipt.providerBudget.chargedCostMicros,1497175);assert.equal(receipt.providerBudget.attempts,2);
const journalPath='C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl',before=readFileSync(journalPath);
assert.equal(hash(before),'d6213af1fd8330e9e97a688d903a3c1852b5f40265a66eafb6aa2bf1cfa2060b');
const priorReadPath='C:/dev/main/outputs/meri-c2-20261003/case20-terminal-budget-readback-v1/response-1.json';
assert.equal(hash(readFileSync(priorReadPath)),'52f249a2564b469d179442a843162cfbed3399633e45c9dad198a70c685e26c3');
const earlierBudget=JSON.parse(readFileSync(priorReadPath)).value.metadata.serverCaptureProviderBudget;
assert.ok(Date.now()>Date.parse(earlierBudget.ledger.limits.deadlineAt));
mkdirSync(output);
const save=(name,value)=>{const fd=openSync(output+'/'+name,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}};
const result={kind:'case20-postdeadline-owned-provider-budget-readback',status:'RUNNING',startedAt:new Date().toISOString(),
 captureRunId:execution.captureRunId,conversationId:execution.conversationId,tenantId:ctx.tenantId,userId:ctx.userId,
 priorExecutionSha256:hash(readFileSync(priorRoot+'/execution.json')),priorMessagesObservationSha256:hash(readFileSync(priorRoot+'/artifacts/saved-messages-observation.json')),
 applicationWrites:0,modelSubmissions:0,journalMutations:0,sessionRevoked:false,captureAuthority:false,
 messagesReadAfterDeadline:false,priorMessagesEvidence:'RETAINED_PRE_DEADLINE_OBSERVATION_ONLY',reads:[]};
let callbackError;
try{
 await withAuth(async({bearer})=>{try{
  // Message readback authority expires at this deadline; preserve the prior observation only.
  const paths=['/api/me','/api/clio/conversations/'+execution.conversationId];
  for(const [index,path]of paths.entries()){
   const response=await fetch('https://os.capiro.ai'+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+bearer,'User-Agent':'Capiro-Meri-Authorized-QA/1.0','x-capiro-tenant':ctx.tenantSlug}});
   const bytes=Buffer.from(await response.arrayBuffer());assert.ok(bytes.length<256*1024);assert.equal(bytes.includes(Buffer.from(bearer)),false);
   const value=JSON.parse(bytes.toString('utf8')),observed={path,status:response.status,apiReleaseSha:response.headers.get('x-capiro-release-sha'),bodySha256:hash(bytes),bytes:bytes.length,observedAt:new Date().toISOString()};
   result.reads.push(observed);save('response-'+index+'.json',{observation:observed,value});
   assert.equal(response.status,200);assert.equal(observed.apiReleaseSha,execution.sourceSha);
   if(index===0)assert.ok(value.tenant?.id===ctx.tenantId&&value.user?.id===ctx.userId&&value.role==='standard_user');
   if(index===1){
    assert.equal(value.id,execution.conversationId);assert.equal(value.userId,ctx.userId);assert.equal(value.tenantId,ctx.tenantId);assert.equal(value.clientId,receipt.clientId);
    const budget=value.metadata.serverCaptureProviderBudget;
    assert.equal(budget.admissionId,receipt.providerBudget.admissionId);assert.equal(budget.turnId,receipt.turnId);
    assert.equal(budget.qualificationSha256,receipt.providerBudget.qualificationSha256);
    assert.equal(sha256Stable(budget),receipt.providerBudget.ledgerSha256);
    assert.deepEqual(budget,earlierBudget);
    assert.equal(budget.ledger.attempts.length,2);assert.ok(budget.ledger.attempts.every(a=>a.status==='settled'));
    assert.equal(budget.ledger.chargedCostMicros,1497175);
    result.providerBudget=budget;result.providerLedgerMatchesSignedReceipt=true;
    result.afterProviderDeadline=Date.parse(observed.observedAt)>Date.parse(budget.ledger.limits.deadlineAt);
    assert.equal(result.afterProviderDeadline,true);
   }
  }
 }catch(e){callbackError=e;}});
 result.sessionRevoked=true;if(callbackError)throw callbackError;result.status='READBACK_CAPTURED';
}catch(e){result.status='READBACK_FAILED';result.errorClass=e.name;result.messageSha256=hash(String(e.message));process.exitCode=1;}
finally{result.finishedAt=new Date().toISOString();result.journalUnchanged=readFileSync(journalPath).equals(before);save('result.json',result);assert.ok(result.journalUnchanged);console.log(JSON.stringify({status:result.status,sessionRevoked:result.sessionRevoked,journalUnchanged:result.journalUnchanged,afterProviderDeadline:result.afterProviderDeadline??null,providerLedgerMatchesSignedReceipt:result.providerLedgerMatchesSignedReceipt??false,resultPath:output+'/result.json'}));}
