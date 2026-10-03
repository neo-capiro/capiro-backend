import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { root, ctx, save, need, withAuth } from './auth-preflight.mjs';
import { clientId, runOperation } from './oneoff.mjs';
import { prepareMemoryReadCase, executeMemoryReadCase } from 'file:///C:/dev/main/meri-closeout-c0-20261002/evals/meri/live-v1/memory-read-protocol.mjs';
import { createMemoryReadHttp, createMemoryReadRecorder } from 'file:///C:/dev/main/meri-closeout-c0-20261002/evals/meri/live-v1/memory-read-http.mjs';
import { createMemoryReadServerBudgetReader, currentMemoryReadUsageAuthority } from 'file:///C:/dev/main/meri-closeout-c0-20261002/evals/meri/live-v1/memory-read-budget-authority.mjs';
import { nativeMeriCaptureHeaders } from 'file:///C:/dev/main/meri-closeout-c0-20261002/evals/meri/live-v1/lib/native-http.mjs';
import { sha256Stable } from 'file:///C:/dev/main/meri-closeout-c0-20261002/evals/meri/live-v1/lib/stable.mjs';
const read=name=>JSON.parse(readFileSync(root+'/'+name,'utf8'));
const caseId=process.argv[2]; need(['01','02','03','04','05'].includes(caseId),'EXACT_MEMORY_CASE_REQUIRED');
const label='case'+caseId;
const authorizationPath=root+'/run-authorization.json';
if(!existsSync(authorizationPath))save('run-authorization.json',{kind:'fresh_independent_benchmark',authorization:['run the becnh mark again','start your own'],createdAt:new Date().toISOString(),maxCostMicros:30000000,perCaseMaxCostMicros:15000000,concurrency:1,historyDisposition:'Previous evidence and unresolved costs retained separately; no prior run retried or reset.',semanticClock:'2026-09-26T16:00:00.000Z',semanticClockInjected:false,originalAcceptance:'NOT_CLAIMED'});
const journalPath=root+'/fresh-spend.jsonl';
const past=existsSync(journalPath)?readFileSync(journalPath,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
const intents=past.filter(e=>e.event==='reserved');
let used=0;
for(const i of intents){const settled=past.find(e=>e.event==='settled'&&e.reservationId===i.reservationId);need(settled,'PRIOR_FRESH_ATTEMPT_REQUIRES_RECONCILIATION');used+=settled.usage.chargedCostMicros;}
const cap=Math.min(15000000,30000000-used);need(cap>0,'FRESH_BUDGET_EXHAUSTED');
const reservation={reservationId:randomUUID(),ceilingMicros:cap};
const captureRunId=randomUUID();
save(label+'-operator-lock.json',{caseId,captureRunId,reservation,at:new Date().toISOString()});
const event=value=>appendFileSync(journalPath,JSON.stringify({at:new Date().toISOString(),caseId,captureRunId,reservationId:reservation.reservationId,...value})+'\n',{encoding:'utf8',flush:true});
const binding=read('oneoff-binding.json');
const rateEvidence=JSON.parse(readFileSync('C:/dev/main/meri-closeout-c0-20261002/docs/meri/releases/2026-10-02/original75-budget-recovery/reviewed-rates-long-context.json','utf8'));
const summary={caseId,captureRunId,startedAt:new Date().toISOString(),status:'PREPARING',providerSubmissionAttempted:false};
try {
  await withAuth(async({refresh})=>{
    const post=await fetch('https://os.capiro.ai/api/clio/conversations',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{...nativeMeriCaptureHeaders(await refresh(),ctx.tenantSlug),'content-type':'application/json'},body:JSON.stringify({clientId,title:'Fresh Meri benchmark 2026-10-03 / '+label})});
    const conv=await post.json();need(post.ok&&/^[a-f0-9-]{36}$/i.test(conv.id)&&conv.clientId===clientId,'CONVERSATION_CREATE_FAILED_'+post.status);
    summary.conversationId=conv.id;save(label+'-conversation.json',{id:conv.id,clientId:conv.clientId,releaseSha:post.headers.get('x-capiro-release-sha')});
    const config={caseId,captureRunId,conversationId:conv.id,actorUserId:ctx.userId,clerkUserId:ctx.clerkUserId,clientId,apiSha:'6be5a560d5addaa1844f0687898c34a249089f76',orchestratorSha:'7c04ca368fbccc84d33c720ce7a20b9201bf6e99',webSha:'78ad5805679a3045b1fc10fb19beafa7f76e4e64',maxCostMicros:cap,timeoutMs:900000};
    const plan=prepareMemoryReadCase(config);save(label+'-config.json',config);
    const qualification={version:1,kind:'synthetic_read_budget_only',caseId,captureRunId,aggregateReservationId:reservation.reservationId,tenantId:ctx.tenantId,actorUserId:ctx.userId,conversationId:conv.id,clientId,promptSha256:plan.promptSha256,deadlineAt:new Date(Date.now()+29*60*1000).toISOString(),rateEvidenceSha256:sha256Stable(rateEvidence),rateEvidenceExpiresAt:rateEvidence.expiresAt,priceKind:'qualified_text_token_upper_bound',maxAttempts:32,maxTokens:500000,maxCostMicros:cap,rates:rateEvidence.rates};
    event({event:'reserved',ceilingMicros:cap,conversationId:conv.id,qualificationSha256:sha256Stable(qualification)});
    const installed=await runOperation(binding,'install',{target:'capiro-dev',fixtureNamespace:'meri-foundation-20260928',confirmation:'INSTALL_ONE_OWNED_SYNTHETIC_READ_BUDGET',ctx,qualification,rateEvidence},label+'-budget');
    save(label+'-budget-receipt.json',installed);
    const reader=createMemoryReadServerBudgetReader({plan,reservation,bearer:refresh});
    const record=await createMemoryReadRecorder(root+'/'+label+'-capture');
    let corpusCount=0;
    const readCurrentFixture=async()=>{
      corpusCount++;
      return runOperation(binding,'read-corpus',{target:'capiro-dev',fixtureNamespace:'meri-foundation-20260928',confirmation:'READ_CURRENT_OWNED_MEMORY_CORPUS',ctx,clientId},label+'-corpus-'+corpusCount);
    };
    const spend={
      async beforeSubmit(b){need(b.captureRunId===captureRunId&&b.conversationId===conv.id&&b.maxCostMicros===cap,'RESERVATION_BINDING_MISMATCH');await reader.before();event({event:'submission_intent',conversationId:conv.id});summary.providerSubmissionAttempted=true;console.log(JSON.stringify({stage:label,status:'SUBMITTING_ONE_LIVE_PROMPT',capUsd:cap/1000000}));return reservation;},
      async afterAttempt(r,observation){need(r===reservation,'RESERVATION_MISMATCH');event({event:'capture_observed',observation});try{const authority=await reader.terminal();const usage=currentMemoryReadUsageAuthority(authority);event({event:'settled',usage});save(label+'-usage.json',usage);summary.chargedCostMicros=usage.chargedCostMicros;}catch(e){event({event:'uncertain',retainedCeilingMicros:cap,reason:e.message});throw e;}}
    };
    const result=await executeMemoryReadCase(config,{transport:createMemoryReadHttp({bearer:refresh,conversationId:conv.id,timeoutMs:900000}),readCurrentFixture,spend,record});
    summary.status=result.status;summary.observation=result;save(label+'-observation.json',result);
  });summary.sessionRevoked=true;
}catch(e){summary.status='BLOCKED';summary.code=e.message;process.exitCode=1;}
finally{summary.finishedAt=new Date().toISOString();save(label+'-summary.json',summary);console.log(JSON.stringify(summary));}
