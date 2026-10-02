// Fixed root-operated case46. Preparation is local-only; --execute requires sealed fresh readiness.
import {readFileSync,writeFileSync,existsSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BASE,REPO,need,read,sha,loadCase46Ready} from './case46-operator-gates.mjs';
import {openCaptureSpendAggregate} from 'file:///C:/dev/cap-meri-mail-deadline/evals/meri/live-v1/capture-spend-aggregate.mjs';
import {prepareCase46LiveCapture,executeCase46LiveCapture,currentCase46CaptureAuthority} from 'file:///C:/dev/cap-meri-mail-deadline/evals/meri/live-v1/case46-live-capture.mjs';
import {gradeCase46CapturedOutcome} from 'file:///C:/dev/cap-meri-mail-deadline/evals/meri/live-v1/grade-case46-capture.mjs';
import {createWindowsArtifactStorage} from 'file:///C:/dev/cap-meri-mail-deadline/evals/meri/live-v1/windows-artifact-storage.mjs';

const ORIGIN='https://os.capiro.ai',NS='meri-foundation-20260928';
const PYTHON='C:/ProgramData/Hermes/tools/python-3.14.7+20260901-win32-x64/python.exe';
const output=join(BASE,'case46-live-execution.json'),req=createRequire(REPO+'/apps/api/package.json');
let clerk,browser,createdSessionId,summary,owner;
const persist=()=>writeFileSync(output,JSON.stringify(summary,null,2)+'\n');
const durableNew=(name,value)=>{const p=join(BASE,name);writeFileSync(p,JSON.stringify(value,null,2)+'\n',{flag:'wx'});const fd=openSync(p,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}};
function secret(){
 const values=readFileSync('C:/ProgramData/Hermes/.env','utf8').split(/\r?\n/u).filter(l=>/^CLERK_SECRET_KEY\s*=/u.test(l))
  .map(l=>l.slice(l.indexOf('=')+1).trim().replace(/^['"]|['"]$/gu,''));
 need(values.length===1&&values[0],'CLERK_SECRET_UNAVAILABLE');return values[0];
}
async function revoke(){
 if(!createdSessionId||!clerk)return;
 let current=await clerk.sessions.getSession(createdSessionId);
 if(!['ended','revoked'].includes(current.status)){await clerk.sessions.revokeSession(createdSessionId);current=await clerk.sessions.getSession(createdSessionId);}
 need(['ended','revoked'].includes(current.status),'SESSION_CLEANUP_FAILED');summary.sessionRevoked=true;persist();
}
async function web(page,scope){
 const actual=await page.evaluate(()=>{
  const c=window.__CAPIRO_CONFIG__;let host='invalid';
  const m=/^pk_(?:live|test)_([A-Za-z0-9_-]+)$/.exec(c?.clerkPublishableKey||'');
  if(m){try{host=atob(m[1].replace(/-/g,'+').replace(/_/g,'/')).replace(/\$$/,'');}catch{}}
  return {sha:c?.releaseSha,surface:c?.webSurface,host};
 });
 need(actual.sha===scope.webSha&&actual.surface==='vnext'&&actual.host==='clerk.app.capiro.ai','WEB_RELEASE_MISMATCH');
}
async function main(){
 need(process.argv.length===3&&['--check-readiness','--execute-original-case46-once'].includes(process.argv[2]),'EXACT_COMMAND_REQUIRED');
 const prepared=loadCase46Ready(),{config,ready}=prepared,s=config.scope;
 owner=openCaptureSpendAggregate(prepared.checkpoint,{pythonExecutable:PYTHON});
 if(process.argv[2]==='--check-readiness'){console.log(JSON.stringify({status:'LOCAL_INPUTS_READY',caseId:'46',networkCalls:0,fullFile01Acceptance:false}));return;}
 const runRoot=join(BASE,'case46-live-artifacts');
 need(!existsSync(output)&&!existsSync(runRoot),'NEW_OPERATION_PATHS_REQUIRED');
 const manifest=read('C:/dev/cap-meri-foundation-evidence/private/meri-foundation-20260928.manifest.json');
 const actor=manifest.ids?.users?.pat,tenant=manifest.ids?.tenants?.t1;
 need(manifest.namespace===NS&&manifest.target==='capiro-dev'&&manifest.status==='ready'&&actor?.userId===s.userId&&
  actor.clerkUserId===s.clerkUserId&&tenant?.tenantId===s.tenantId,'SYNTHETIC_BINDING_MISMATCH');
 const unchanged=()=>need(loadCase46Ready().readySha256===prepared.readySha256,'READINESS_CHANGED');
 summary={version:1,caseId:'46',status:'NOT_RUN',apiSha:s.apiSha,orchestratorSha:s.orchestratorSha,webSha:s.webSha,
  driverSha:ready.driverSha,operatorHead:prepared.operatorHead,readySha256:prepared.readySha256,
  scriptSha256:sha(readFileSync(fileURLToPath(import.meta.url))),captureRunId:s.captureRunId,conversationId:s.conversationId,
  startedAt:new Date().toISOString(),maximumNewTurns:1,maximumApprovals:1,sessionCreated:false,sessionRevoked:false,fullFile01Acceptance:false};
 durableNew('case46-execution.lock',{captureRunId:s.captureRunId,conversationId:s.conversationId,readySha256:prepared.readySha256});persist();
 const spendReservation=owner.reserve({caseId:'46',captureRunId:s.captureRunId,ceilingMicros:s.qualification.maxCostMicros});
 durableNew('case46-reserved-checkpoint.json',owner.checkpoint());
 const {createClerkClient}=req('@clerk/backend'),{chromium}=req('C:/dev/node_modules/playwright');
 clerk=createClerkClient({secretKey:secret()});
 need((await clerk.instance.get()).id===manifest.targetBinding.clerkInstanceId,'CLERK_INSTANCE_MISMATCH');
 const user=await clerk.users.getUser(actor.clerkUserId),org=await clerk.organizations.getOrganization({organizationId:tenant.clerkOrgId});
 const memberships=await clerk.users.getOrganizationMembershipList({userId:actor.clerkUserId,limit:100});
 const email=manifest.handles.users.pat;
 need(user.publicMetadata?.fixtureNamespace===NS&&/synthetic/iu.test([user.firstName,user.lastName].join(' '))&&
  email.includes(NS)&&email.endsWith('@example.com')&&user.emailAddresses.some(e=>e.emailAddress===email),'SYNTHETIC_USER_MISMATCH');
 need(org.slug===s.tenantSlug&&org.publicMetadata?.fixtureNamespace===NS,'SYNTHETIC_ORG_MISMATCH');
 need(memberships.totalCount===1&&memberships.data.length===1&&memberships.data[0].organization?.id===tenant.clerkOrgId&&memberships.data[0].role==='org:member','ORDINARY_ACTOR_REQUIRED');
 unchanged();browser=await chromium.launch({headless:true});
 const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();page.setDefaultTimeout(30000);
 let unexpected=false;
 // This fallback blocks every application write before the native collector adds its exact single-proposal guard.
 await context.route('**/*',async route=>{
  const r=route.request(),url=new URL(r.url());
  if(r.isNavigationRequest()&&r.frame()===page.mainFrame()&&url.origin!==ORIGIN){unexpected=true;return route.abort();}
  if(['GET','HEAD','OPTIONS'].includes(r.method())||url.origin==='https://clerk.app.capiro.ai')return route.continue();
  unexpected=true;return route.abort();
 });
 await page.goto(ORIGIN+'/meri',{waitUntil:'domcontentloaded',timeout:45000});
 await page.waitForFunction(()=>window.Clerk?.loaded,null,{timeout:45000});await web(page,s);need(!unexpected,'UNEXPECTED_BROWSER_REQUEST');unchanged();
 const ticket=await clerk.signInTokens.createSignInToken({userId:actor.clerkUserId,expiresInSeconds:120});
 const signed=await page.evaluate(async token=>{const a=await window.Clerk.client.signIn.create({strategy:'ticket',ticket:token});return {complete:a.status==='complete',sessionId:a.createdSessionId};},ticket.token);
 createdSessionId=signed.sessionId;summary.sessionCreated=typeof createdSessionId==='string'&&!!createdSessionId;persist();
 need(signed.complete&&summary.sessionCreated,'SYNTHETIC_AUTH_FAILED');
 await page.evaluate(async input=>window.Clerk.setActive(input),{session:createdSessionId,organization:tenant.clerkOrgId});
 await page.goto(`${ORIGIN}/meri/t/${s.conversationId}`,{waitUntil:'domcontentloaded',timeout:45000});
 await page.waitForFunction(({userId,orgId})=>window.Clerk?.loaded&&window.Clerk.user?.id===userId&&window.Clerk.organization?.id===orgId,{userId:actor.clerkUserId,orgId:tenant.clerkOrgId});
 await web(page,s);need(!unexpected,'UNEXPECTED_BROWSER_REQUEST');unchanged();
 const bearer=await page.evaluate(()=>window.Clerk.session.getToken({template:'capiro'}));need(typeof bearer==='string'&&bearer.length>0,'BEARER_UNAVAILABLE');
 const storage=createWindowsArtifactStorage(runRoot,{pythonExecutable:PYTHON});
 const capability=await prepareCase46LiveCapture({config,page,runRoot,artifactStorage:storage,spendReservation,env:{MERI_LIVE_BEARER_TOKEN:bearer}});
 unchanged();summary.nativeExecutionInvoked=true;persist();
 const outcome=await executeCase46LiveCapture(capability);summary.outcome=outcome;persist();
 durableNew('case46-final-checkpoint.json',owner.checkpoint());
 need(outcome.status==='CAPTURE_COMPLETE'&&outcome.synthesisSubmissionCount===1&&outcome.approvalRequests===1&&!unexpected,'CASE46_CAPTURE_NOT_COMPLETE');
 summary.grading=gradeCase46CapturedOutcome(outcome);summary.status='CAPTURED_AWAITING_HUMAN_ADJUDICATION';persist();
 await browser.close();browser=undefined;await revoke();
 const {evidence,joins}=currentCase46CaptureAuthority(outcome);
 durableNew('case46-human-adjudication-request.json',{schemaVersion:1,kind:'meri-case46-human-adjudication-request',caseId:'46',
  captureRunId:s.captureRunId,turnId:joins.turnId,answerSha256:evidence.inputs.after.assistant.bodySha256,evidenceSha256:outcome.evidence.sha256,
  completedAt:evidence.completedAt,evidence:outcome.evidence,screenshots:[evidence.approvalScreenshot,...evidence.inputs.ui.rounds.map(r=>r.screenshot)],
  screenshotSha256s:[evidence.approvalScreenshot.sha256,...evidence.inputs.ui.rounds.map(r=>r.screenshot.sha256)],humanRubric:'NOT_RUN'});
 console.log(JSON.stringify({caseId:'46',status:summary.status,sessionRevoked:summary.sessionRevoked,evidenceSha256:outcome.evidence.sha256}));
 const lines=createInterface({input:process.stdin});
 const command=await new Promise(resolve=>{const timer=setTimeout(()=>resolve(null),20*60*1000);lines.once('line',line=>{clearTimeout(timer);resolve(line);});lines.once('close',()=>{clearTimeout(timer);resolve(null);});});lines.close();
 if(command===null){summary.status='CAPTURED_HUMAN_REVIEW_PENDING';summary.turnResubmissionAllowed=false;summary.opaqueOutcomeAvailableAfterExit=false;persist();return;}
 need(command==='GRADE_SAVED_CASE46_HUMAN_ADJUDICATION','REVIEW_COMMAND_REQUIRED');
 summary.grading=gradeCase46CapturedOutcome(outcome,{humanAdjudication:read(join(BASE,'case46-human-adjudication.json'))});
 summary.status=summary.grading.status==='PASS'?'CASE46_PASS':summary.grading.status;persist();need(summary.status==='CASE46_PASS','CASE46_HUMAN_NOT_PASS');
}
try{await main();}catch(error){if(summary){summary.status='BLOCKED';summary.failureCode=error.safeCode||'CASE46_OPERATOR_REFUSED';}
 else console.error(JSON.stringify({status:'BLOCKED',code:error.safeCode||'CASE46_OPERATOR_REFUSED'}));process.exitCode=1;
}finally{
 if(browser)await browser.close().catch(()=>{});
 try{await revoke();}catch{if(summary){summary.status='BLOCKED';summary.failureCode='SESSION_CLEANUP_FAILED';}process.exitCode=1;}
 if(summary){summary.completedAt=new Date().toISOString();if(owner)summary.aggregateSnapshot=owner.checkpoint().snapshot;persist();
  console.log(JSON.stringify({status:summary.status,caseId:'46',turnsSent:summary.outcome?.synthesisSubmissionCount??(summary.nativeExecutionInvoked?null:0),
   approvalSubmissions:summary.outcome?.approvalRequests??null,sessionRevoked:summary.sessionRevoked,fullFile01Acceptance:false}));
  if(!['CASE46_PASS','CAPTURED_HUMAN_REVIEW_PENDING'].includes(summary.status))process.exitCode=1;
 }
}
