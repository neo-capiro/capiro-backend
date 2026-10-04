import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {withAuth,ctx} from './case14-live-operator-v1/auth-owner.mjs';
import {nativeMeriCaptureHeaders} from '../../meri-c1-20261002/evals/meri/live-v1/lib/native-http.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003/case14-terminal-read-v1';
const base='C:/dev/main/outputs/meri-c2-20261003/case14-live-operator-v1';
const hash=b=>createHash('sha256').update(b).digest('hex');
const run=JSON.parse(readFileSync(base+'/result.json')),config=JSON.parse(readFileSync(base+'/recall-config.json'));
assert.equal(run.captureRunId,'5f4312a2-6aa9-4ec8-820d-5717a88402df');assert.equal(run.recallOutcome.reason,'CASE01_SOURCE_TOOL_JOIN_MISMATCH');
const journalPath='C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl',journal=readFileSync(journalPath);
mkdirSync(root);const save=(name,v)=>writeFileSync(root+'/'+name,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
let revoked=false;
await withAuth(async({bearer})=>{
 const get=async(name,path)=>{
  const r=await fetch('https://os.capiro.ai'+path,{method:'GET',headers:nativeMeriCaptureHeaders(bearer,ctx.tenantSlug),redirect:'error',signal:AbortSignal.timeout(30000)});
  const bytes=await r.text();assert.equal(r.status,200);assert.ok(!bytes.includes(bearer));assert.ok(!/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u.test(bytes));
  const value=JSON.parse(bytes),observation={path,status:r.status,apiReleaseSha:r.headers.get('x-capiro-api-release-sha')??r.headers.get('x-api-release-sha'),observedAt:new Date().toISOString(),bodySha256:hash(bytes),bodyBytes:Buffer.byteLength(bytes)};
  save(name,{observation,value});return value;
 };
 const me=await get('me.json','/api/me');assert.equal(me.user.id,ctx.userId);assert.equal(me.tenant.id,ctx.tenantId);assert.equal(me.role,'user_admin');
 const conv=await get('conversation.json','/api/clio/conversations/'+config.conversationId);assert.equal(conv.id,config.conversationId);assert.equal(conv.userId,ctx.userId);
 const messages=await get('messages.json','/api/clio/conversations/'+config.conversationId+'/messages');assert.equal(messages.length,2);
 const assistant=messages.find(x=>x.role==='assistant');assert.equal(assistant.id,'e7eeb23e-cd9e-497e-88d3-5265c827221d');
 const citation=assistant.metadata.citations[0];const query=new URLSearchParams(Object.entries(citation.source).filter(([,v])=>v!=null).map(([k,v])=>[k,String(v)]));
 await get('source.json','/api/clio/sources?'+query);
 save('summary.json',{at:new Date().toISOString(),captureRunId:config.captureRunId,conversationId:config.conversationId,kind:'case14-existing-terminal-diagnostic-read',applicationWrites:0,providerCalls:0,newTurns:0,captureAuthority:false,acceptanceStatus:'NOT_RUN',budget:assistant.metadata.serverCaptureEvidenceReceipt.receipt.providerBudget,blockers:assistant.metadata.serverCaptureEvidenceReceipt.receipt.blockers});
},{onSessionCreated:async id=>save('session.private.json',{sessionId:id}),onSessionRevoked:async id=>{revoked=true;save('session-cleanup.json',{sessionSha256:hash(id),status:'revoked',at:new Date().toISOString()});}});
assert.equal(revoked,true);assert.ok(readFileSync(journalPath).equals(journal));save('journal-preserved.json',{sha256:hash(journal),unchanged:true});console.log(JSON.stringify({status:'EXISTING_TERMINAL_READ_COMPLETE',sessionRevoked:true,applicationWrites:0,providerCalls:0,journalMutations:0}));
