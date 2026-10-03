import {createHash} from 'node:crypto';
import {ctx,save,need,withAuth} from './auth-preflight.mjs';
import {clientId} from './oneoff.mjs';
import {nativeMeriCaptureHeaders} from 'file:///C:/dev/main/meri-closeout-c0-20261002/evals/meri/live-v1/lib/native-http.mjs';
await withAuth(async({refresh})=>{
  const r=await fetch('https://os.capiro.ai/api/memory/proposals?limit=50',{headers:nativeMeriCaptureHeaders(await refresh(),ctx.tenantSlug),redirect:'error',signal:AbortSignal.timeout(30000)});
  const body=await r.text(); const j=JSON.parse(body);
  need(r.status===200&&Array.isArray(j.candidates),'PROPOSAL_READ_FAILED_'+r.status);
  const candidates=j.candidates.filter(c=>c.clientId===clientId&&/SMS|text alert/i.test(JSON.stringify(c.proposal)));
  const result={fetchedAt:new Date().toISOString(),endpoint:'/api/memory/proposals?limit=50',status:r.status,apiSha:r.headers.get('x-capiro-release-sha'),actorUserId:ctx.userId,clientId,rawResponseSha256:createHash('sha256').update(body).digest('hex'),pageCandidateCount:j.candidates.length,hasNextPage:!!j.nextCursor,candidates};
  save('case02-pending-authority-readback.json',result);
  console.log(JSON.stringify({status:r.status,matches:candidates.map(c=>({id:c.id,status:c.status,restricted:c.restricted,proposal:c.proposal}))}));
});
save('pending-readback-cleanup.json',{at:new Date().toISOString(),sessionRevoked:true});
