// One current-image regression of the original six pending proposals. No seed or model turn.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {aws} from '../meri-fresh-20261003/auth-preflight.mjs';
import {collectCase17LiveCapture,currentCase17CaptureAuthority} from '../../meri-c1-20261002/evals/meri/live-v1/case17-live-capture.mjs';
import {gradeCase17CapturedOutcome} from '../../meri-c1-20261002/evals/meri/live-v1/grade-case17-capture.mjs';
import {createWindowsArtifactStorage} from '../../meri-c1-20261002/evals/meri/live-v1/windows-artifact-storage.mjs';
const repo='C:/dev/main/meri-c1-20261002',root='C:/dev/main/outputs/meri-c2-20261003';
const read=name=>JSON.parse(readFileSync(root+'/'+name,'utf8'));
const sha=value=>createHash('sha256').update(value).digest('hex');
const input=read('case17-regression-v2-prepared.json'),config=input.config;
const preparedSha256=sha(readFileSync(root+'/case17-regression-v2-prepared.json'));
const save=(name,value)=>{const fd=openSync(root+'/'+name,'wx');try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}};
function sourceCheck(){
 assert.equal(sha(readFileSync(root+'/case17-regression-v2-prepared.json')),preparedSha256);
 for(const f of input.sourceFiles)assert.equal(sha(readFileSync(repo+'/'+f.path)),f.sha256);
 assert.equal(input.status,'ORIGINAL_CASE17_LOCATOR_RECOVERED_NO_NEW_FIXTURE');
 assert.equal(config.recipe.fixtureInstanceId,'63c7bb50-1971-49df-96b9-c6c94c562078');
 assert.equal(config.recipe.ctx.userId,'fb218bf5-2674-4ced-bca3-7a5d0c01592f');
 assert.equal(config.recipe.ctx.role,'user_admin');assert.equal(config.limits.maxSynthesisSubmissions,0);
 assert.equal(config.limits.maxApplicationWrites,0);
}
assert.ok(process.argv.length===3&&['--check-readiness','--capture-once'].includes(process.argv[2]));
sourceCheck();
if(process.argv[2]==='--check-readiness') {
 console.log(JSON.stringify({status:'LOCAL_CASE17_REGRESSION_READY',sourceFiles:input.sourceFiles.length,providerCalls:0,networkCalls:0}));
} else {
 assert.ok(!existsSync(root+'/case17-regression-v2-result.json')&&!existsSync(root+'/case17-regression-v2-artifacts'));
 const summary={status:'STARTED',at:new Date().toISOString(),caseId:'17',captureRunId:config.captureRunId,
   apiSha:config.deployment.apiSha,webSha:config.deployment.webSha,operatorSourceSha:input.sourceSha,preparedSha256,
   sessionCreated:false,sessionRevoked:false,applicationWrites:0,synthesisSubmissionCount:0,providerCalls:0,
   originalPromptSubmission:'NOT_RUN',humanRubric:'NOT_RUN',fullOriginalRow17Acceptance:false,fullFile01Acceptance:false};
 const persist=()=>writeFileSync(root+'/case17-regression-v2-result.json',JSON.stringify(summary,null,2)+'\n');
 save('case17-regression-v2-result.json',summary);
 let sessionId,ticket,clerk,outcome;
 const previousProfile=process.env.AWS_PROFILE;
 const revoke=async()=>{
   if(sessionId){let state=await clerk('GET','/sessions/'+sessionId);if(!['ended','revoked'].includes(state.status)){await clerk('POST','/sessions/'+sessionId+'/revoke');state=await clerk('GET','/sessions/'+sessionId);}
     assert.ok(['ended','revoked'].includes(state.status));summary.sessionRevoked=true;persist();}
   else if(ticket?.id){await clerk('POST','/sign_in_tokens/'+ticket.id+'/revoke');summary.unusedTicketRevoked=true;persist();}
 };
 try {
   process.env.AWS_PROFILE='capiro-dev';
   const secret=aws(['secretsmanager','get-secret-value','--secret-id','arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/clerk/secret-key-FT67tM']).SecretString;
   assert.match(secret,/^sk_/);
   clerk=async(method,path,body)=>{
     const response=await fetch('https://api.clerk.com/v1'+path,{method,headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},
       body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(30000)});
     if(!response.ok)throw new Error('CASE17_CLERK_OPERATION_FAILED');return response.json();
   };
   const user=await clerk('GET','/users/'+config.recipe.clerkUserId),m=await clerk('GET','/users/'+config.recipe.clerkUserId+'/organization_memberships?limit=100');
   assert.equal(user.public_metadata?.fixtureNamespace,config.recipe.fixtureNamespace);assert.match(user.first_name+' '+user.last_name,/synthetic/iu);
   assert.equal(m.total_count,1);assert.equal(m.data.length,1);assert.equal(m.data[0].role,'org:admin');
   assert.equal(m.data[0].organization.id,config.clerkOrganizationId);assert.equal(m.data[0].organization.slug,config.recipe.ctx.tenantSlug);
   assert.equal(m.data[0].organization.public_metadata?.fixtureNamespace,config.recipe.fixtureNamespace);
   const storage=createWindowsArtifactStorage(root+'/case17-regression-v2-artifacts',{pythonExecutable:'C:/Users/neoma/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe'});
   storage.init(Buffer.from(JSON.stringify({kind:'meri-case17-artifact-owner',caseId:'17',captureRunId:config.captureRunId,preparedSha256})),Buffer.from(config.captureRunId));
   let tickets=0;
   outcome=await collectCase17LiveCapture({config,artifactStorage:storage,
     createSignInTicket:async id=>{sourceCheck();assert.equal(id,config.recipe.clerkUserId);assert.equal(++tickets,1);
       ticket=await clerk('POST','/sign_in_tokens',{user_id:id,expires_in_seconds:120});return ticket.token;},
     onSessionCreated:async id=>{assert.ok(!sessionId&&typeof id==='string');sessionId=id;
       // Local crash-reconciliation locator only; this file is never committed or printed.
       save('case17-v2-owned-session.private.json',{sessionId,clerkUserId:config.recipe.clerkUserId,captureRunId:config.captureRunId});
       summary.sessionCreated=true;persist();}});
   summary.outcome=outcome;summary.grading=gradeCase17CapturedOutcome(outcome);summary.status='CAPTURED_VISUAL_REVIEW_PENDING';persist();
   await revoke();sourceCheck();
   const actual=currentCase17CaptureAuthority(outcome);
   save('case17-regression-v2-visual-review-request.json',{caseId:'17',captureRunId:config.captureRunId,evidenceSha256:actual.descriptor.sha256,completedAt:actual.evidence.completedAt,
     screenshots:actual.evidence.rounds.flatMap(round=>round.cards.map(card=>({phase:round.phase,logicalSourceId:card.logicalSourceId,...card.screenshot}))),humanRubric:'NOT_RUN'});
   console.log(JSON.stringify({status:summary.status,deterministicStatus:summary.grading.deterministicStatus,sessionRevoked:summary.sessionRevoked,providerCalls:0}));
   const lines=createInterface({input:process.stdin});
   const command=await new Promise(resolve=>{const timeout=setTimeout(()=>resolve(null),10*60*1000);lines.once('line',line=>{clearTimeout(timeout);resolve(line);});lines.once('close',()=>{clearTimeout(timeout);resolve(null);});});lines.close();
   if(command!==null){assert.equal(command,'GRADE_SAVED_CASE17_VISUAL_REVIEW');summary.grading=gradeCase17CapturedOutcome(outcome,{visualReview:read('case17-regression-v2-visual-review.json')});
     summary.status=summary.grading.status==='PASS'?'UI_SLICE_PASS':summary.grading.status;summary.visualReviewer='Codex root saved-image inspection; not human rubric';persist();assert.equal(summary.grading.status,'PASS');}
 } catch(error) {
   summary.status='BLOCKED';summary.failureCode=/^CASE17_[A-Z_]+$/u.test(error?.message??'')?error.message:error.name;persist();process.exitCode=1;
 } finally {
   try{await revoke();}catch{summary.status='BLOCKED';summary.failureCode='OWNED_AUTH_CLEANUP_FAILED';process.exitCode=1;}
   if(previousProfile===undefined)delete process.env.AWS_PROFILE;else process.env.AWS_PROFILE=previousProfile;
   summary.completedAt=new Date().toISOString();persist();console.log(JSON.stringify({status:summary.status,sessionRevoked:summary.sessionRevoked,failureCode:summary.failureCode,providerCalls:0,fullOriginalRow17Acceptance:false}));
 }
}
