import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {withAuth,ctx} from '../meri-fresh-20261003/auth-preflight.mjs';
import {nativeMeriCaptureHeaders} from '../../meri-c1-20261002/evals/meri/live-v1/lib/native-http.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003';
const candidate=JSON.parse(readFileSync(root+'/memory-lifecycle-release-packet.json','utf8')).services.find(s=>s.service==='api').candidate;
const sha=v=>createHash('sha256').update(v).digest('hex');
let receipt;
await withAuth(async({refresh})=>{
  const get=async path=>{
    const response=await fetch('https://os.capiro.ai'+path,{headers:nativeMeriCaptureHeaders(await refresh(),ctx.tenantSlug),redirect:'error',signal:AbortSignal.timeout(30000)});
    const bytes=await response.text();assert.equal(response.status,200);assert.equal(response.headers.get('x-capiro-release-sha'),candidate.sourceSha);
    return {body:JSON.parse(bytes),responseSha256:sha(bytes)};
  };
  const me=await get('/api/me');assert.equal(me.body.tenant?.id,ctx.tenantId);assert.equal(me.body.user?.id,ctx.userId);assert.equal(me.body.role,'standard_user');
  const whole=await get('/api/memory/proposals?limit=50');assert.ok(Array.isArray(whole.body.candidates));assert.ok(!whole.body.nextCursor);
  const target=whole.body.candidates.find(c=>c.id==='dc61a9a5-5130-5c67-a7e8-19906259c34f');
  assert.ok(target);assert.equal(target.status,'pending');assert.equal(target.clientId,'41f9ec63-3963-479f-b747-59a3767ef44b');assert.equal(target.restricted,false);
  const pages=[],ids=[];let cursor;
  for(let i=0;i<30;i++){
    const page=await get('/api/memory/proposals?limit=2'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
    assert.ok(Array.isArray(page.body.candidates));assert.ok(page.body.candidates.length<=2);
    ids.push(...page.body.candidates.map(c=>c.id));pages.push({candidateCount:page.body.candidates.length,responseSha256:page.responseSha256,hasMore:!!page.body.nextCursor});
    cursor=page.body.nextCursor;if(!cursor)break;
  }
  assert.ok(!cursor);assert.equal(new Set(ids).size,ids.length);assert.deepEqual(ids,whole.body.candidates.map(c=>c.id));
  receipt={status:'SERVED_ORDINARY_OWN_PROPOSAL_READ_AND_PAGING_PASS',at:new Date().toISOString(),sourceSha:candidate.sourceSha,
    tenantId:ctx.tenantId,actorUserId:ctx.userId,role:me.body.role,fullReadSha256:whole.responseSha256,candidateCount:ids.length,pages,
    retainedPendingSms:{id:target.id,status:target.status,clientId:target.clientId,restricted:target.restricted},
    candidateSummaries:whole.body.candidates.map(c=>({id:c.id,status:c.status,clientId:c.clientId??null,scope:c.scope??null,restricted:c.restricted})),
    providerCalls:0,businessWrites:0,ordinaryModelTurn:false,uiReloadVerified:false,originalAcceptance:'NOT_CLAIMED'};
});
receipt.ownedTransientSessionRevoked=true;receipt.credentialsSaved=false;
writeFileSync(root+'/served-pending-proposals-readback.json',JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:receipt.status,sourceSha:receipt.sourceSha,candidateCount:receipt.candidateCount,pages:receipt.pages.length,retainedPendingSms:true,providerCalls:0,ownedTransientSessionRevoked:true}));
