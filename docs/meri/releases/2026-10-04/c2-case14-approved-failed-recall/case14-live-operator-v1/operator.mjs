// Codex LOCAL DRAFT. Default entry is local-only readiness. Root owns --run-once.
// Approval, reservation, setup and capture WeakMap objects stay in this process.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,openSync,closeSync,fsyncSync,ftruncateSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {withAuth,ctx} from './auth-owner.mjs';
import {makeRecallConfig} from './config.mjs';
import {createWindowsArtifactStorage} from '../../../meri-c1-20261002/evals/meri/live-v1/windows-artifact-storage.mjs';
import {sha256Stable} from '../../../meri-c1-20261002/evals/meri/live-v1/artifact-collector.mjs';
import {readCase14ApprovalCostAuthority} from '../../../meri-c1-20261002/evals/meri/live-v1/case14-approval-cost-authority.mjs';
import {openCaptureSpendAggregate,bindCase14PostApprovalSetup} from '../../../meri-c1-20261002/evals/meri/live-v1/capture-spend-aggregate.mjs';
import {collectCase14ApprovalCapture,currentCase14ApprovalAuthority,createCase14RecallConversation,collectCase14RecallUi,currentCase14RecallUiAuthority} from '../../../meri-c1-20261002/evals/meri/live-v1/case14-approval-capture.mjs';
import {prepareCase14RecallCapture,executeCase14RecallCapture,currentCase14RecallAuthority} from '../../../meri-c1-20261002/evals/meri/live-v1/case01-live-capture.mjs';
import {readCase14PostApprovalTaskAuthority} from '../../../meri-c1-20261002/evals/meri/live-v1/case14-postapproval-task-authority.mjs';
import {gradeCase14CapturedOutcome} from '../../../meri-c1-20261002/evals/meri/live-v1/grade-case14-capture.mjs';
import {executeCase14PostApprovalSetup} from '../execute-case14-postapproval-outer-v1.mjs';

const ROOT='C:/dev/main/outputs/meri-c2-20261003/case14-live-operator-v1';
const PYTHON='C:/Users/neoma/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe';
const hash=b=>createHash('sha256').update(b).digest('hex');
const read=name=>JSON.parse(readFileSync(ROOT+'/'+name,'utf8'));
const save=(name,value)=>{const fd=openSync(ROOT+'/'+name,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}};
export function sourceCheck(){
 const p=read('prepared.json');assert.equal(p.kind,'case14-combined-owned-live-operator-preparation');assert.equal(p.status,'PREPARED_NOT_EXECUTED');
 for(const f of p.sourceFiles)assert.equal(hash(readFileSync(f.path)),f.sha256,'SOURCE_DRIFT '+f.path);
 for(const f of p.inputFiles)assert.equal(hash(readFileSync(f.path)),f.sha256,'INPUT_DRIFT '+f.path);
 assert.equal(p.config.reviewer.role,'user_admin');assert.deepEqual(p.config.reviewer,ctx);
 assert.equal(p.config.caseId,'14');assert.equal(p.config.limits.maxApprovalSubmissions,1);assert.equal(p.config.limits.maxSynthesisSubmissions,0);
 assert.equal(hash(readFileSync(p.journalPath)),p.journalPrefixSha256);
 assert.equal(readFileSync(p.journalPath,'utf8').trim().split('\n').length,24);
 return p;
}
function sourceOnlyCheck(prepared){for(const f of prepared.sourceFiles)assert.equal(hash(readFileSync(f.path)),f.sha256,'SOURCE_DRIFT '+f.path);for(const f of prepared.inputFiles)assert.equal(hash(readFileSync(f.path)),f.sha256,'INPUT_DRIFT '+f.path);}
export async function waitForVisualReview(){
 const lines=createInterface({input:process.stdin});
 let timer,poll;
 try{return await new Promise(resolve=>{
  const finish=value=>{clearTimeout(timer);clearInterval(poll);resolve(value);};
  timer=setTimeout(()=>finish(null),10*60*1000);
  lines.once('line',line=>finish(line));
  // Closed Windows stdin does not end the process or discard owned outcomes.
  // Root may instead write the exact saved-image review file; this is review
  // input only, never restored approval, setup or recall authority.
  poll=setInterval(()=>{if(existsSync(ROOT+'/visual-review-command.txt')){try{const command=readFileSync(ROOT+'/visual-review-command.txt','utf8').trim();if(command==='GRADE_SAVED_CASE14_VISUAL_REVIEW'&&read('visual-review.json').kind==='meri-case14-visual-review')finish(command);}catch{}}},1000);
 });}finally{clearTimeout(timer);clearInterval(poll);lines.close();}
}

export async function runOnce(){
 const prepared=sourceCheck(),config=prepared.config;
 assert.ok(!existsSync(ROOT+'/result.json')&&!existsSync(ROOT+'/artifacts-ui')&&!existsSync(ROOT+'/artifacts-recall'));
 const summary={kind:'case14-combined-owned-live-operator-result',status:'STARTED',startedAt:new Date().toISOString(),captureRunId:config.captureRunId,
  preparedSha256:hash(readFileSync(ROOT+'/prepared.json')),approvalSubmissions:'NOT_RUN',recallSubmissions:'NOT_RUN',
  approvalBilledActualMicros:null,conservativeApprovalCeilingMicros:1000000,recallCeilingMicros:14000000,combinedHoldMicros:15000000,
  originalPromptSubmission:'NOT_RUN',humanRubric:'NOT_RUN',fullOriginalRow14Acceptance:false,fullFile01Acceptance:false,automaticRetryAllowed:false,
  apiSessionCreated:false,apiSessionRevoked:false,browserSessionsCreated:0,browserSessionsCleaned:0};
 save('result.json',summary);
 const persist=()=>{const fd=openSync(ROOT+'/result.json','r+');try{const b=Buffer.from(JSON.stringify(summary,null,2)+'\n');writeFileSync(fd,b);ftruncateSync(fd,b.length);fsyncSync(fd);}finally{closeSync(fd);}};
 const phase=name=>{summary.phase=name;summary.phaseAt=new Date().toISOString();if(!name.startsWith('CLEANUP_'))summary.lastWorkPhase=name;persist();};
 let aggregate,reservation,approvalOutcome,recallOutcome,recallUiOutcome;
 const previousProfile=process.env.AWS_PROFILE;
 try{
  process.env.AWS_PROFILE='capiro-dev';
  phase('OPEN_PINNED_AGGREGATE');
  aggregate=openCaptureSpendAggregate(JSON.parse(readFileSync(prepared.aggregateCheckpointPath,'utf8')),{pythonExecutable:PYTHON});
  save('aggregate-before.json',aggregate.checkpoint());
  const uiStorage=createWindowsArtifactStorage(ROOT+'/artifacts-ui',{pythonExecutable:PYTHON});
  uiStorage.init(Buffer.from(JSON.stringify({kind:'case14-approval-ui-owned-artifacts',caseId:'14',captureRunId:config.captureRunId,preparedSha256:summary.preparedSha256})),Buffer.from(config.captureRunId));
  // The recall collector, not this operator, initializes its own fresh owner.
  const recallStorage=createWindowsArtifactStorage(ROOT+'/artifacts-recall',{pythonExecutable:PYTHON});
  phase('OPEN_OWNED_API_AUTH_SESSION');
  await withAuth(async auth=>{
   assert.equal(auth.orgId,config.clerkOrganizationId);
   const browserSessions=[],browserTickets=[];let ticketCount=0;
   const cleanupBrowserSessions=async()=>{
    let errors=0;
    for(const row of browserSessions){if(row.cleaned)continue;try{let s=await auth.clerk('GET','/sessions/'+row.id);if(!['revoked','ended'].includes(s.status)){await auth.clerk('POST','/sessions/'+row.id+'/revoke');s=await auth.clerk('GET','/sessions/'+row.id);}assert.ok(['revoked','ended'].includes(s.status));row.cleaned=true;summary.browserSessionsCleaned++;save('browser-cleanup-'+row.index+'.json',{phase:row.phase,status:s.status,at:new Date().toISOString(),sessionIdSha256:hash(row.id)});}catch{errors++;}}
    for(const row of browserTickets.filter(x=>!x.consumed&&!x.revoked)){try{await auth.clerk('POST','/sign_in_tokens/'+row.id+'/revoke');row.revoked=true;}catch{errors++;}}
    persist();assert.equal(errors,0,'OWNED_BROWSER_AUTH_CLEANUP_FAILED');
   };
   const callbacks=phase=>({createSignInTicket:async id=>{
    sourceOnlyCheck(prepared);assert.equal(id,config.reviewer.clerkUserId);assert.ok(++ticketCount<=2);
    const ticket=await auth.clerk('POST','/sign_in_tokens',{user_id:id,expires_in_seconds:120});browserTickets.push({phase,id:ticket.id,consumed:false});
    save('browser-ticket-'+ticketCount+'.private.json',{phase,ticketId:ticket.id,captureRunId:config.captureRunId});return ticket.token;
   },onSessionCreated:async id=>{
    assert.ok(typeof id==='string'&&!browserSessions.some(x=>x.id===id));const ticket=browserTickets.find(x=>x.phase===phase&&!x.consumed);assert.ok(ticket);ticket.consumed=true;
    const row={phase,id,index:browserSessions.length+1,cleaned:false};browserSessions.push(row);summary.browserSessionsCreated++;
    save('browser-session-'+row.index+'.private.json',{phase,sessionId:id,clerkUserId:config.reviewer.clerkUserId,captureRunId:config.captureRunId});persist();
   }});
   try{
    sourceOnlyCheck(prepared);
    phase('READ_NATIVE_APPROVAL_COST_CENSUS');
    const costAuthority=await readCase14ApprovalCostAuthority(config,uiStorage);
    phase('RESERVE_COMBINED_CASE14_HOLD');
    reservation=aggregate.reserveCase14Approval({captureRunId:config.captureRunId,costAuthority});
    save('aggregate-held.json',aggregate.checkpoint());summary.status='COMBINED_HOLD_RESERVED';persist();
    summary.approvalSubmissions='MAY_HAVE_SUBMITTED_CHECK_OWNED_ARTIFACTS';phase('COLLECT_ORDINARY_UI_APPROVAL');
    approvalOutcome=await collectCase14ApprovalCapture({config,artifactStorage:uiStorage,spendReservation:reservation,...callbacks('approval')});
    summary.approvalOutcome=approvalOutcome;summary.approvalSubmissions=1;summary.status='APPROVAL_CAPTURED';persist();
    currentCase14ApprovalAuthority(approvalOutcome);await cleanupBrowserSessions();sourceOnlyCheck(prepared);
    phase('DISPATCH_OWNED_NATIVE_POSTAPPROVAL_SETUP');
    const dispatched=await executeCase14PostApprovalSetup(approvalOutcome,reservation);
    save('postapproval-dispatch-result.json',dispatched);sourceOnlyCheck(prepared);
    phase('READ_NATIVE_TASK_DEFINITION_AND_LOG_AUTHORITY');
    const setupAuthority=await readCase14PostApprovalTaskAuthority({spendReservation:reservation,approvalOutcome,taskArn:dispatched.taskArn});
    phase('BIND_OWNED_NATIVE_SETUP_AUTHORITY');
    const setup=bindCase14PostApprovalSetup(reservation,approvalOutcome,setupAuthority);
    save('native-setup-authority-proof.json',setup);summary.status='NATIVE_SETUP_BOUND';persist();
    assert.ok(Date.now()+60000<reservation.deadlineAtMs,'INSUFFICIENT_COMBINED_WINDOW_FOR_RECALL');
    phase('CREATE_ONE_ORDINARY_RECALL_CONVERSATION');
    const conversationBearer=await auth.refresh();
    const conversation=await createCase14RecallConversation({approvalOutcome,config,artifactStorage:uiStorage,env:{MERI_LIVE_BEARER_TOKEN:conversationBearer}});
    save('conversation.json',conversation);
    const recallConfig=makeRecallConfig(config,setup,conversation,prepared.contract);
    save('recall-config.json',recallConfig);sourceOnlyCheck(prepared);
    const recallBearer=await auth.refresh();
    phase('PREPARE_SINGLE_AUTHENTICATED_RECALL');
    const recallSession=await prepareCase14RecallCapture({config:recallConfig,runRoot:recallStorage.root,artifactStorage:recallStorage,spendReservation:reservation,env:{MERI_LIVE_BEARER_TOKEN:recallBearer}});
    summary.recallSubmissions='MAY_HAVE_SUBMITTED_CHECK_OWNED_ARTIFACTS';phase('EXECUTE_SINGLE_RECALL');
    recallOutcome=await executeCase14RecallCapture(recallSession);
    summary.recallOutcome=recallOutcome;summary.recallSubmissions=recallOutcome.synthesisSubmissionCount;summary.status=recallOutcome.status;persist();
    save('aggregate-after-recall.json',aggregate.checkpoint());
    assert.equal(recallOutcome.status,'CAPTURE_COMPLETE','RECALL_INCOMPLETE_NO_RETRY');
    currentCase14RecallAuthority(recallOutcome);
    // executeCase14RecallCapture has already settled the single reservation.
    phase('COLLECT_EXISTING_RECALL_UI');
    recallUiOutcome=await collectCase14RecallUi({recallOutcome,config,artifactStorage:uiStorage,...callbacks('recall-ui')});
    summary.recallUiOutcome=recallUiOutcome;summary.grading=gradeCase14CapturedOutcome({approvalOutcome,recallOutcome,recallUiOutcome});
    summary.status='CAPTURED_VISUAL_REVIEW_PENDING';persist();
   }finally{phase('CLEANUP_OWNED_BROWSER_SESSIONS');await cleanupBrowserSessions();}
  },{onSessionCreated:async id=>{summary.apiSessionCreated=true;save('api-owned-session.private.json',{sessionId:id,clerkUserId:config.reviewer.clerkUserId,captureRunId:config.captureRunId});persist();},
     onSessionRevoked:async id=>{summary.apiSessionRevoked=true;save('api-session-cleanup.json',{sessionIdSha256:hash(id),status:'revoked',at:new Date().toISOString()});persist();}});
  sourceOnlyCheck(prepared);
  assert.equal(summary.apiSessionRevoked,true);assert.equal(summary.browserSessionsCreated,2);assert.equal(summary.browserSessionsCleaned,2);
  const approval=currentCase14ApprovalAuthority(approvalOutcome),ui=currentCase14RecallUiAuthority(recallUiOutcome);
  save('visual-review-request.json',{kind:'case14-saved-visual-review-request',caseId:'14',captureRunId:config.captureRunId,evidenceSha256:summary.grading.evidenceSha256,
   completedAt:Math.max(approval.completedAt,ui.completedAt),screenshots:[...approval.screenshots,ui.screenshot].map(d=>({...d,path:uiStorage.root+'/'+d.ref})),
   requiredChecks:['approvalAndDurableReceiptVisibleInMeri','nextTurnRecallAndCitationVisible'],reviewer:'Codex root saved-image inspection, not human rubric',originalPromptSubmission:'NOT_RUN',humanRubric:'NOT_RUN',fullOriginalRow14Acceptance:false,fullFile01Acceptance:false});
  console.log(JSON.stringify({status:summary.status,captureRunId:config.captureRunId,visualReviewRequest:ROOT+'/visual-review-request.json',sessionsCleaned:true,humanRubric:'NOT_RUN'}));
  phase('WAIT_SAVED_VISUAL_REVIEW_ALL_SESSIONS_CLOSED');
  const command=await waitForVisualReview();
  if(command!==null){assert.equal(command,'GRADE_SAVED_CASE14_VISUAL_REVIEW');sourceOnlyCheck(prepared);const visualReview=read('visual-review.json');
   summary.grading=gradeCase14CapturedOutcome({approvalOutcome,recallOutcome,recallUiOutcome,visualReview});summary.status=summary.grading.status==='PASS'?'CASE14_APPROVAL_RECALL_SLICE_PASS':summary.grading.status;persist();}
 }catch(error){summary.status='BLOCKED_RECONCILE_BEFORE_RETRY';summary.failurePhase=summary.lastWorkPhase??summary.phase;summary.failureCode=/^(CASE14|CASE01|CAPTURE)_[A-Z_]+$/u.test(error?.message??'')?error.message:error?.name??'Error';summary.failureStackFrames=String(error?.stack??'').split('\n').slice(1).filter(x=>/^\s+at /u.test(x)).map(x=>x.match(/\(?((?:file:\/\/\/|C:[\\/])[^()]+:\d+:\d+)\)?$/u)?.[1]).filter(Boolean).slice(0,8);persist();process.exitCode=1;}
 finally{
  if(previousProfile===undefined)delete process.env.AWS_PROFILE;else process.env.AWS_PROFILE=previousProfile;
  summary.completedAt=new Date().toISOString();if(aggregate){try{save('aggregate-final.json',aggregate.checkpoint());}catch{summary.aggregateFinalCheckpointFailed=true;}}
  persist();console.log(JSON.stringify({status:summary.status,captureRunId:config.captureRunId,apiSessionRevoked:summary.apiSessionRevoked,browserSessionsCleaned:summary.browserSessionsCleaned,humanRubric:'NOT_RUN',fullFile01Acceptance:false,automaticRetryAllowed:false}));
 }
 return summary;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 assert.ok(process.argv.length<=3);const mode=process.argv[2]??'--check-readiness';
 if(mode==='--check-readiness'){const p=sourceCheck();console.log(JSON.stringify({status:'LOCAL_ONLY_READY_NOT_EXECUTED',captureRunId:p.config.captureRunId,sourceFiles:p.sourceFiles.length,providerCalls:0,cloudCalls:0,journalMutations:0}));}
 else{assert.equal(mode,'--run-once');await runOnce();}
}
