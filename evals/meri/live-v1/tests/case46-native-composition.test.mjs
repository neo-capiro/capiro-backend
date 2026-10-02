// OFFLINE COMPOSITION ONLY: fake HTTPS/build/browser; real native storage/journal.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { case46Sample } from './case46-fixture.mjs';
import { CASE46_EXPECTED } from '../case46-artifact-evidence.mjs';
import { createWindowsArtifactStorage } from '../windows-artifact-storage.mjs';


const parent=process.env.MERI_WINDOWS_ARTIFACT_TEST_ROOT;
const python=process.env.MERI_WINDOWS_ARTIFACT_PYTHON;
const enabled=process.platform==='win32'&&Boolean(parent&&python);
const ORIGIN='https://os.capiro.ai';
let active;
mock.module('../case01-build-authority.mjs',{namedExports:{readCase01BuildAuthority:async()=>({observedAt:Date.now(),services:[],kind:'OFFLINE_FAKE'})}});
mock.module('node:https',{defaultExport:{request:(url,options,callback)=>{
  const req=new EventEmitter();req.write=body=>{req.body=JSON.parse(body);};req.setTimeout=()=>{};req.destroy=()=>{};
  req.end=()=>queueMicrotask(()=>{
    const x=active, path=url.pathname+url.search;let value;
    assert.equal(options.rejectUnauthorized,true);assert.equal(url.origin,ORIGIN);
    if(options.method==='POST'){
      assert.equal(path,`/api/clio/conversations/${x.f.scope.conversationId}/stream`);
      assert.deepEqual(req.body,{body:x.f.scope.prompt});x.sends++;
      if(x.failure==='ambiguous'){req.emit('error',new Error('OFFLINE_AMBIGUOUS'));return;}
      value=[{type:'turn_accepted'},{type:'tool_call',tool:'create_word'},
        {type:'pending_approval',tool:'create_word',proposalId:x.f.proposed.proposalId},
        {type:'text',text:x.f.assistant.body},{type:'done',messageId:x.f.assistant.id}]
        .map(e=>`data: ${JSON.stringify(e)}\n\n`).join('');
    }else value=JSON.stringify(x.read(path));
    const res=new EventEmitter();res.statusCode=200;res.headers={'x-capiro-release-sha':x.f.scope.apiSha};
    callback(res);res.emit('data',Buffer.from(value));res.emit('end');
  });return req;
}}});
// Fresh import graph after mocks avoids altering a production network seam.
const {prepareCase46LiveCapture,executeCase46LiveCapture,currentCase46CaptureAuthority}=await import('../case46-live-capture.mjs');
const {initializeCaptureSpendAggregate,openCaptureSpendAggregate}=await import('../capture-spend-aggregate.mjs');
const {gradeCase46CapturedOutcome}=await import('../grade-case46-capture.mjs');

function harness(failure){
 const f=case46Sample();let approvals=0,downloads=0;const handlers=[],waiting=[],events=[];
 const request=(url,method)=>({url:()=>url,method:()=>method,postData:()=>'{}',isNavigationRequest:()=>false});
 const response=(url,method,status,value,headers={})=>({url:()=>url,request:()=>request(url,method),status:()=>status,
  allHeaders:async()=>({'x-capiro-release-sha':f.scope.apiSha,...headers}),json:async()=>value,body:async()=>Buffer.from(CASE46_EXPECTED.utf8Bytes)});
 const proposal=()=>({proposalId:f.proposed.proposalId,tool:'create_word',status:approvals?'succeeded':'proposed',attemptCount:approvals?2:0,
  approvedBy:approvals?f.scope.userId:null,preview:{client:{id:f.scope.clientId},leavesFirm:false,fields:{title:'Aster Synthetic Briefing'}},
  resultSummary:approvals?{ok:true,filename:CASE46_EXPECTED.filename,sha256:CASE46_EXPECTED.byteSha256,artifactId:f.after.effect.artifactId,operationId:f.after.effect.operationId}:null});
 const emit=res=>{for(const w of waiting.splice(0)){assert.equal(w.predicate(res),true);w.resolve(res);}};
 const dispatch=async req=>{
  let allowed=false;const next=async i=>i<0?allowed=true:handlers[i]({request:()=>req,abort:()=>{},continue:()=>{allowed=true;},fallback:()=>next(i-1)});
  await next(handlers.length-1);return allowed;
 };
 const locator=name=>({waitFor:async()=>{},count:async()=>1,screenshot:async()=>Buffer.from('OFFLINE_PNG_'+name),check:async()=>{},
  getByRole:(_role,options)=>locator(options?.name),click:async()=>{
   if(name==='Confirm & run'){
    const url=`${ORIGIN}/api/clio/action-proposals/${f.proposed.proposalId}/approve`;
    if(!await dispatch(request(url,'POST')))throw new Error('OFFLINE_BLOCKED');
    approvals++;emit(response(url,'POST',201,proposal()));
   }
   if(name==='Download .txt'){
    assert.equal(waiting.length,1);assert.equal(events.length,1);downloads++;
    const e=f.after.effect,headers={'content-disposition':`attachment; filename="${e.filename}"`,'content-type':'text/plain',
     'content-length':'28','x-capiro-artifact-byte-authority':'persisted_at_creation_v1','x-capiro-artifact-sha256':e.sha256,
     'x-capiro-artifact-id':e.artifactId,'x-capiro-artifact-operation-id':e.operationId,
     'x-capiro-artifact-creation-receipt':Buffer.from(JSON.stringify(e)).toString('base64url')};
    emit(response(`${ORIGIN}/api/clio/artifacts/${e.artifactId}/download`,'GET',200,null,headers));
    events.shift()({failure:async()=>null,createReadStream:async()=>Readable.from([Buffer.from(CASE46_EXPECTED.utf8Bytes)]),suggestedFilename:()=>e.filename});
   }
  }});
 const page={route:async(_p,h)=>handlers.push(h),unroute:async(_p,h)=>handlers.splice(handlers.indexOf(h),1),
  url:()=>`${ORIGIN}/meri/t/${f.scope.conversationId}`,evaluate:async()=>({sha:f.scope.webSha,surface:'vnext',user:f.scope.clerkUserId}),
  getByRole:(_r,o)=>locator(o?.name),locator,reload:async()=>{},
  waitForResponse:predicate=>new Promise(resolve=>waiting.push({predicate,resolve})),
  waitForEvent:()=>new Promise(resolve=>events.push(resolve))};
 const state={f,failure,sends:0,read:path=>path==='/api/me'?{user:{id:f.scope.userId,clerkUserId:f.scope.clerkUserId},tenant:{id:f.scope.tenantId,slug:f.scope.tenantSlug},role:f.scope.role}
  :path.includes('/action-proposals?')?[proposal()]
  :path.endsWith('/messages')?state.sends?[{role:'user',id:f.proposed.userMessageId,body:f.scope.prompt},f.assistant]:[]
  :{id:f.scope.conversationId,clientId:f.scope.clientId,metadata:{governedArtifactCapture:{bindingSha256:f.scope.bindingSha256}},captureAdmission:approvals?f.after:state.sends?f.proposed:f.before}};
 mkdirSync(parent,{recursive:true});const journal=join(parent,randomUUID()),runRoot=join(parent,randomUUID());
 const priorRun=randomUUID();
 const cp=initializeCaptureSpendAggregate({root:journal,pythonExecutable:python,inventory:{sliceId:randomUUID(),
  priorRuns:[{caseId:'01',captureRunId:priorRun,ceilingMicros:3000000,status:'conservative_prior_reservation',terminalReceiptSha256:'8'.repeat(64)}],
  boundary:{kind:'original_file01_capture_slice',firstCaseId:'01',firstCaptureRunId:priorRun,inventorySha256:'9'.repeat(64)}}});
 const owner=openCaptureSpendAggregate(cp,{pythonExecutable:python});
 const reservation=owner.reserve({caseId:'46',captureRunId:f.scope.captureRunId,ceilingMicros:3000000});
 return {state,page,owner,reservation,runRoot,storage:createWindowsArtifactStorage(runRoot,{pythonExecutable:python}),
  config:{schemaVersion:1,provenance:'LIVE_CAPTURE',target:{apiOrigin:ORIGIN,environment:'capiro-dev'},scope:f.scope,
   deadlineMs:600000,deployment:{apiSha:f.scope.apiSha,orchestratorSha:f.scope.orchestratorSha}},counts:()=>({approvals,downloads,sends:state.sends})};
}

test('OFFLINE native composition initializes storage, sends once, approves once, downloads twice and joins saved current authority', {skip:!enabled},async()=>{
 const h=harness();active=h.state;
 const cap=await prepareCase46LiveCapture({config:h.config,page:h.page,runRoot:h.runRoot,artifactStorage:h.storage,
  spendReservation:h.reservation,env:{MERI_LIVE_BEARER_TOKEN:'OFFLINE_TEST_TOKEN_NEVER_VALID'}});
 const out=await executeCase46LiveCapture(cap);
 assert.equal(out.status,'CAPTURE_COMPLETE',JSON.stringify(out));assert.deepEqual(h.counts(),{approvals:1,downloads:2,sends:1});
 assert.equal(currentCase46CaptureAuthority(out).evidence.inputs.after.effect.byteLength,28);
 assert.equal(h.owner.checkpoint().snapshot.activeRun,null);
 assert.equal(h.owner.checkpoint().snapshot.reservedCeilingsMicros,6000000);
 assert.equal(h.owner.checkpoint().snapshot.knownSettledCostMicros,h.state.f.after.providerUsage.costMicros);
 assert.equal(gradeCase46CapturedOutcome(out).status,'NOT_RUN');
 const {evidence,joins}=currentCase46CaptureAuthority(out);
 const human={schemaVersion:1,kind:'meri-case46-human-adjudication',caseId:'46',captureRunId:out.captureRunId,turnId:joins.turnId,
  answerSha256:evidence.inputs.after.assistant.bodySha256,evidenceSha256:out.evidence.sha256,reviewedAt:new Date().toISOString(),
  reviewer:'OFFLINE TEST',reference:'OFFLINE TEST',rationale:'OFFLINE TEST ONLY',approvalAndReceiptVisible:true,downloadAndReloadVisible:true,
  screenshotSha256s:[evidence.approvalScreenshot.sha256,...evidence.inputs.ui.rounds.map(r=>r.screenshot.sha256)],
  scores:{factual_support:2,evidence_coverage_citation_validity:2,client_relevance:2,directness_clarity:2,actionable_judgment:2}};
 assert.equal(gradeCase46CapturedOutcome(out,{humanAdjudication:human}).status,'PASS');
 assert.equal(gradeCase46CapturedOutcome(out,{humanAdjudication:{...human,evidenceSha256:'0'.repeat(64)}}).status,'BLOCKED');
 await assert.rejects(executeCase46LiveCapture(cap));
 // Saved artifact replacement invalidates authority; no automatic second turn.
 writeFileSync(join(h.runRoot,'case46-initial.txt'),'wrong');
 assert.throws(()=>currentCase46CaptureAuthority(out));assert.equal(h.counts().sends,1);
});

test('OFFLINE ambiguous stream preserves active reservation and forbids a second send or case', {skip:!enabled},async()=>{
 const h=harness('ambiguous');active=h.state;
 const cap=await prepareCase46LiveCapture({config:h.config,page:h.page,runRoot:h.runRoot,artifactStorage:h.storage,
  spendReservation:h.reservation,env:{MERI_LIVE_BEARER_TOKEN:'OFFLINE_TEST_TOKEN_NEVER_VALID'}});
 const out=await executeCase46LiveCapture(cap);assert.equal(out.status,'CAPTURE_UNCERTAIN');
 assert.deepEqual(h.counts(),{approvals:0,downloads:0,sends:1});assert.match(h.owner.checkpoint().snapshot.activeRun,/^46:/u);
 assert.throws(()=>h.owner.reserve({caseId:'46',captureRunId:randomUUID(),ceilingMicros:3000000}));
 await assert.rejects(executeCase46LiveCapture(cap));
});
