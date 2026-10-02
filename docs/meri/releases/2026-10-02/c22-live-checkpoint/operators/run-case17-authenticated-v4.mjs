// One approved synthetic, no-turn UI capture. No credentials or session IDs are saved.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {collectCase17LiveCapture,currentCase17CaptureAuthority} from 'file:///C:/dev/cap-meri-outcomes-validation/evals/meri/live-v1/case17-live-capture.mjs';
import {gradeCase17CapturedOutcome} from 'file:///C:/dev/cap-meri-outcomes-validation/evals/meri/live-v1/grade-case17-capture.mjs';
import {createWindowsArtifactStorage} from 'file:///C:/dev/cap-meri-outcomes-validation/evals/meri/live-v1/windows-artifact-storage.mjs';
import {BASE,loadRelease,assertSameRelease,readPriorCase17} from './live-operator-gates.mjs';
const root=BASE;
const driverName='run-case17-authenticated-v4.mjs';
const repo='C:/dev/cap-meri-outcomes-validation';
let release,source;
const read=file=>JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/u,''));
const hash=b=>createHash('sha256').update(b).digest('hex');
const require=createRequire(repo+'/apps/api/package.json');
const namespace='meri-foundation-20260928';
let clerk,createdSessionId,summary,outcome;
const persist=()=>writeFileSync(root+'/case17-live-execution-v4.json',JSON.stringify(summary,null,2)+'\n');
const need=(value,code)=>{if(!value){const error=new Error(code);error.safeCode=code;throw error;}};
function secret(){
 const rows=readFileSync('C:/ProgramData/Hermes/.env','utf8').split(/\r?\n/u).filter(l=>/^CLERK_SECRET_KEY\s*=/u.test(l));
 need(rows.length===1,'CLERK_CONFIGURATION');return rows[0].slice(rows[0].indexOf('=')+1).trim().replace(/^['"]|['"]$/gu,'');
}
async function revokeOwned(){
 if(!createdSessionId||!clerk)return;
 let state=await clerk.sessions.getSession(createdSessionId);
 if(!['ended','revoked'].includes(state.status)){
   await clerk.sessions.revokeSession(createdSessionId);
   state=await clerk.sessions.getSession(createdSessionId);
 }
 need(['ended','revoked'].includes(state.status),'OWNED_AUTH_CLEANUP_FAILED');
 summary.sessionRevoked=true;persist();
}
async function main(){
 need(process.argv.length===3&&['--capture-case17-once','--check-readiness'].includes(process.argv[2]),'EXACT_COMMAND_REQUIRED');
 release=loadRelease(driverName);source=release.sourceSha;
 const recipe=readPriorCase17();
 if(process.argv[2]==='--check-readiness'){console.log(JSON.stringify({status:'LOCAL_INPUTS_READY',caseId:'17',sourceSha:source,networkCalls:0}));return;}
 need(!existsSync(root+'/case17-live-execution-v4.json')&&!existsSync(root+'/case17-artifacts-v4'),'NEW_OPERATION_PATHS_REQUIRED');
 const manifest=read('C:/dev/cap-meri-foundation-evidence/private/meri-foundation-20260928.manifest.json');
 need(manifest.namespace===namespace&&manifest.target==='capiro-dev'&&manifest.status==='ready','PRIVATE_MANIFEST_SCOPE');
 const actor=manifest.ids.users.priya,tenant=manifest.ids.tenants.t1;
 need(recipe.ctx.userId===actor.userId&&recipe.clerkUserId===actor.clerkUserId&&recipe.ctx.tenantId===tenant.tenantId&&recipe.ctx.role==='user_admin','EXISTING_ACTOR_SCOPE');
 const builds={api:release.builds.api,'web-vnext':release.builds['web-vnext']};
 const config={schemaVersion:1,caseId:'17',target:'https://os.capiro.ai',captureRunId:randomUUID(),recipe,clerkOrganizationId:tenant.clerkOrgId,
  deployment:{apiSha:source,webSha:release.webSourceSha,builds},limits:{concurrency:1,maxSynthesisSubmissions:0,maxApplicationWrites:0}};
 const {createClerkClient}=require('@clerk/backend');clerk=createClerkClient({secretKey:secret()});
 need((await clerk.instance.get()).id===manifest.targetBinding.clerkInstanceId,'CLERK_INSTANCE');
 const user=await clerk.users.getUser(actor.clerkUserId),org=await clerk.organizations.getOrganization({organizationId:tenant.clerkOrgId});
 const memberships=await clerk.users.getOrganizationMembershipList({userId:actor.clerkUserId,limit:100});
 const email=manifest.handles.users.priya;
 need(user.publicMetadata?.fixtureNamespace===namespace&&/synthetic/iu.test([user.firstName,user.lastName].join(' '))&&email.includes(namespace)&&email.endsWith('@example.com')&&user.emailAddresses.some(row=>row.emailAddress===email),'SYNTHETIC_USER');
 need(org.slug===namespace+'-t1'&&org.publicMetadata?.fixtureNamespace===namespace,'SYNTHETIC_ORGANIZATION');
 need(memberships.totalCount===1&&memberships.data.length===1&&memberships.data[0].organization?.id===tenant.clerkOrgId&&memberships.data[0].role==='org:admin','EXISTING_REVIEWER_MEMBERSHIP');
 assertSameRelease(release,loadRelease(driverName));
 writeFileSync(root+'/case17-live-execution-v4.lock',JSON.stringify({caseId:'17',captureRunId:config.captureRunId,sourceSha:source}),{flag:'wx'});
 summary={caseId:'17',sourceSha:source,webSourceSha:release.webSourceSha,operatorHead:release.operatorHead,pinsSha256:release.pinsSha256,captureRunId:config.captureRunId,status:'STARTED',sessionCreated:false,sessionRevoked:false,synthesisSubmissionCount:0,applicationWrites:0,originalPromptSubmission:'NOT_RUN',humanRubric:'NOT_RUN',acceptanceScope:'NO_TURN_PENDING_MEMORY_UI_SLICE',fullOriginalRow17Acceptance:false,fullFile01Acceptance:false};persist();
 const storage=createWindowsArtifactStorage(root+'/case17-artifacts-v4',{pythonExecutable:'C:/ProgramData/Hermes/tools/python-3.14.7+20260901-win32-x64/python.exe'});
 storage.init(Buffer.from(JSON.stringify({kind:'meri-case17-artifact-owner',caseId:'17',captureRunId:config.captureRunId,sourceSha:source})),Buffer.from(config.captureRunId));
 let tickets=0;
 outcome=await collectCase17LiveCapture({config,artifactStorage:storage,
  createSignInTicket:async id=>{assertSameRelease(release,loadRelease(driverName));need(id===actor.clerkUserId&&++tickets===1,'ONE_OWNED_TICKET_ONLY');return (await clerk.signInTokens.createSignInToken({userId:id,expiresInSeconds:120})).token;},
  onSessionCreated:async id=>{need(!createdSessionId&&typeof id==='string','ONE_OWNED_AUTH_ONLY');createdSessionId=id;summary.sessionCreated=true;persist();}});
 summary.outcome=outcome;summary.grading=gradeCase17CapturedOutcome(outcome);summary.status='CAPTURE_AND_DETERMINISTIC_PASS';persist();
 await revokeOwned();
 const actual=currentCase17CaptureAuthority(outcome);
 const reviewRequest={caseId:'17',captureRunId:config.captureRunId,evidenceSha256:actual.descriptor.sha256,completedAt:actual.evidence.completedAt,
  screenshots:actual.evidence.rounds.flatMap(round=>round.cards.map(card=>({phase:round.phase,logicalSourceId:card.logicalSourceId,...card.screenshot}))),humanRubric:'NOT_RUN'};
 writeFileSync(root+'/case17-saved-visual-review-request-v4.json',JSON.stringify(reviewRequest,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({originalPromptSubmission:'NOT_RUN',fullOriginalRow17Acceptance:false,status:'CAPTURED_AWAITING_SAVED_VISUAL_REVIEW',caseId:'17',deterministicStatus:summary.grading.deterministicStatus,sessionRevoked:summary.sessionRevoked,evidenceSha256:actual.descriptor.sha256}));
 const lines=createInterface({input:process.stdin});
 const command=await new Promise(resolve=>{const timer=setTimeout(()=>resolve(null),20*60*1000);lines.once('line',line=>{clearTimeout(timer);resolve(line);});lines.once('close',()=>{clearTimeout(timer);resolve(null);});});lines.close();
 if(command===null){summary.status='CAPTURED_VISUAL_REVIEW_PENDING';summary.visualReview='NOT_RUN';summary.opaqueOutcomeAvailableAfterExit=false;summary.repeatCaptureAuthorized=false;persist();return;}
 need(command==='GRADE_SAVED_CASE17_VISUAL_REVIEW','REVIEW_COMMAND_REQUIRED');
 const visualReview=read(root+'/case17-saved-visual-review-v4.json');
 summary.grading=gradeCase17CapturedOutcome(outcome,{visualReview});summary.visualReviewer=visualReview.reviewer;summary.humanRubric='NOT_RUN';summary.status=summary.grading.status==='PASS'?'UI_SLICE_PASS':summary.grading.status;persist();
 need(summary.grading.status==='PASS','SAVED_VISUAL_REVIEW_NOT_PASS');
}
try{await main();}catch(error){
 if(summary){summary.status='BLOCKED';summary.failureCode=error.safeCode||(/^CASE17_[A-Z_]+$/u.test(error?.message??'')?error.message:error.name);persist();}
 else console.log(JSON.stringify({status:'BLOCKED',code:error.safeCode||error.name}));process.exitCode=1;
}finally{
 try{await revokeOwned();}catch{if(summary){summary.status='BLOCKED';summary.failureCode='OWNED_AUTH_CLEANUP_FAILED';}process.exitCode=1;}
 if(summary){summary.completedAt=new Date().toISOString();persist();console.log(JSON.stringify({caseId:'17',status:summary.status,deterministicStatus:summary.grading?.deterministicStatus,sessionRevoked:summary.sessionRevoked,failureCode:summary.failureCode,originalPromptSubmission:'NOT_RUN',fullOriginalRow17Acceptance:false,fullFile01Acceptance:false}));}
}
