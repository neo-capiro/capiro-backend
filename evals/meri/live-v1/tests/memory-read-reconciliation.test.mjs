import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {sha256Stable} from '../lib/stable.mjs';
import {inspectMemoryReadSpendTerminalReadback, prepareReviewedMemoryReadSpendReconciliation, currentReviewedCaptureSpendReconciliation} from '../capture-spend-reconciliation.mjs';
import {initializeCaptureSpendAggregate, openCaptureSpendAggregate, reviseCaptureSpendProtocol, reconcileCaptureSpendTerminal} from '../capture-spend-aggregate.mjs';
import {CASE01_TERMINAL_SCOPE as scope, CASE01_TERMINAL_EVIDENCE as evidence, inspectOriginalCase01TerminalEvidence} from '../case01-terminal-spend-authority.mjs';
const hash = x => createHash('sha256').update(x).digest('hex');
const python = 'C:/ProgramData/Hermes/tools/python-3.14.7+20260901-win32-x64/python.exe';
const parent = 'C:/dev/cap-meri-foundation-evidence/spend-memory-read-reconciliation-tests';
mkdirSync(parent, {recursive: true});
function fixture() {
  const now = Date.now(), e = {caseId:'01',captureRunId:randomUUID(),conversationId:randomUUID(),tenantId:'f2d6cf8f-057c-479a-8110-62fe5086d43f',userId:randomUUID(),clientId:randomUUID(),reservationId:randomUUID(),ceilingMicros:15000000,promptSha256:hash('UNIT prompt'),priorExecutionSha256:'a'.repeat(64),turnApiSourceSha:'b'.repeat(40),readbackApiSourceSha:'c'.repeat(40),rateEvidenceSha256:'d'.repeat(64)};
  const q = {kind:'synthetic_read_budget_only',version:1,caseId:e.caseId,captureRunId:e.captureRunId,aggregateReservationId:e.reservationId,tenantId:e.tenantId,actorUserId:e.userId,clientId:e.clientId,conversationId:e.conversationId,promptSha256:e.promptSha256,maxCostMicros:e.ceilingMicros,maxTokens:500000,maxAttempts:32,deadlineAt:new Date(now+60000).toISOString(),priceKind:'qualified_text_token_upper_bound',rateEvidenceSha256:e.rateEvidenceSha256,rates:[{kind:'openai_responses',provider:'openai',model:'UNIT',inputMicrosPerMillion:25000000,outputMicrosPerMillion:75000000}]};
  e.qualificationSha256=sha256Stable(q);
  const b={version:1,policySha256:'e'.repeat(64),admissionId:randomUUID(),turnId:randomUUID(),qualification:q,qualificationSha256:e.qualificationSha256};
  b.ledger={version:1,activation:'enforced',limits:{maxCostMicros:q.maxCostMicros,maxTokens:q.maxTokens,maxAttempts:q.maxAttempts,deadlineAt:q.deadlineAt},chargedAttempts:1,chargedTokens:15,chargedCostMicros:625,attempts:[{attemptId:randomUUID(),runId:b.admissionId,leaseEpoch:1,priceKnown:true,status:'settled',kind:'openai_responses',provider:'openai',model:'UNIT',reservedInputTokens:100,reservedOutputTokens:100,reservedCostMicros:10000,actualInputTokens:10,actualOutputTokens:5,actualCostMicros:625,settledAt:new Date(now-2000).toISOString()}]};
  const end={kind:'synthetic_read_budget_terminal',version:1,policySha256:b.policySha256,turnId:b.turnId,assistantMessageId:randomUUID(),allAttemptsSettled:true,captureAuthority:false,chargedCostMicros:625,ledgerSha256:sha256Stable(b.ledger),completedAt:new Date(now-1000).toISOString()};
  const conversation={id:e.conversationId,tenantId:e.tenantId,userId:e.userId,clientId:e.clientId,archivedAt:null,metadata:{syntheticReadBudgetQualification:q,syntheticReadProviderBudget:b,syntheticReadBudgetTerminal:end}};
  const messages=['user','assistant'].map(role=>({id:role==='user'?b.turnId:end.assistantMessageId,role,body:role==='user'?'UNIT prompt':'UNIT incorrect answer without citation',conversationId:e.conversationId,tenantId:e.tenantId,userId:e.userId,clientId:e.clientId}));
  for(const m of messages)m.bodySha256=hash(m.body);
  const r={kind:'meri-memory-read-terminal-owned-api-readback',status:'READBACK_CAPTURED',...Object.fromEntries(['captureRunId','conversationId','tenantId','userId','clientId','priorExecutionSha256','turnApiSourceSha','readbackApiSourceSha'].map(k=>[k,e[k]])),applicationWrites:0,modelSubmissions:0,sessionRevoked:true,observedAt:new Date(now).toISOString(),conversation,messages,messageCount:2,reads:['','/messages'].map(s=>({path:`/api/clio/conversations/${e.conversationId}${s}`,status:200,apiReleaseSha:e.readbackApiSourceSha,bodySha256:'f'.repeat(64)}))};
  return {e,r,q,b,end};
}
function authority(f) {
  const path=join(parent,randomUUID()+'.json'), raw=JSON.stringify(f.r);writeFileSync(path,raw,{flag:'wx'});
  return prepareReviewedMemoryReadSpendReconciliation({readbackPath:path,readbackSha256:hash(raw),expected:f.e,invocation:'PREPARE_ROOT_REVIEWED_MEMORY_READ_TERMINAL_SPEND'});
}
test('separate repair API readback settles genuine budget-only usage independent of answer PASS',()=>{
  const f=fixture(),p=inspectMemoryReadSpendTerminalReadback(f.r,f.e);
  assert.equal(p.disposition,'SETTLED');assert.equal(p.chargedCostMicros,625);assert.equal(p.answerGrade,'NOT_EVALUATED');assert.equal(p.captureAuthority,false);
  assert.notEqual(p.turnApiSourceSha,p.readbackApiSourceSha);assert.throws(()=>currentReviewedCaptureSpendReconciliation(p));
  assert.equal(currentReviewedCaptureSpendReconciliation(authority(f)).chargedCostMicros,625);
});
test('inflight, uncertain, missing terminal, scope, source, prompt, price, timing and qualification drift cannot release ceiling',()=>{
  const changes=[f=>f.b.ledger.attempts[0].status='reserved',f=>f.b.ledger.attempts[0].status='uncertain',f=>f.end.allAttemptsSettled=false,f=>delete f.r.conversation.metadata.syntheticReadBudgetTerminal,f=>f.e.reservationId=randomUUID(),f=>f.r.reads[1].apiReleaseSha=f.e.turnApiSourceSha,f=>f.r.turnApiSourceSha=f.e.readbackApiSourceSha,f=>f.r.conversation.userId=randomUUID(),f=>f.r.messages[1].clientId=randomUUID(),f=>f.r.messages[0].body='UNIT other',f=>f.b.ledger.chargedCostMicros=0,f=>f.b.ledger.attempts[0].actualCostMicros=0,f=>f.b.ledger.attempts[0].reservedCostMicros=0,f=>f.end.completedAt=new Date(Date.now()+100000).toISOString(),f=>f.b.ledger.attempts[0].settledAt=new Date(Date.now()+100000).toISOString(),f=>f.q.rates[0].outputMicrosPerMillion=1,f=>f.e.qualificationSha256='0'.repeat(64),f=>f.e.rateEvidenceSha256='0'.repeat(64),f=>f.r.sessionRevoked=false,f=>f.r.messageCount=1,f=>f.r.modelSubmissions=1,f=>f.e.caseId='14'];
  for(const mutate of changes){const f=fixture();mutate(f);assert.throws(()=>inspectMemoryReadSpendTerminalReadback(f.r,f.e));}
});
function native(prior,op,event){const r=spawnSync(python,['-I',fileURLToPath(new URL('../lib/windows-capture-spend.py',import.meta.url))],{input:JSON.stringify({root:prior.state.root,state:prior.state,op,event}),encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(r.status,0,r.stderr);return {kind:'meri-original-capture-spend-checkpoint',version:1,...JSON.parse(r.stdout)};}
function legacyThenV2(){
  let p=initializeCaptureSpendAggregate({root:join(parent,randomUUID()),pythonExecutable:python,inventory:{sliceId:randomUUID(),priorRuns:[],boundary:{kind:'original_file01_capture_slice',firstCaseId:'01',firstCaptureRunId:scope.captureRunId,inventorySha256:scope.inventorySha256}}});
  p=native(p,'reserve',{kind:'reserve',caseId:'01',captureRunId:scope.captureRunId,reservationId:scope.reservationId,ceilingMicros:3000000});
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/case01-terminal-reconciliation.unit.json',import.meta.url))),proof=inspectOriginalCase01TerminalEvidence(fixture);
  proof.reconciliationSha256=sha256Stable({kind:'original01-terminal-cost-unknown',proof,scope,evidence});
  p=native(p,'close_terminal_uncertain',{kind:'close_terminal_uncertain',caseId:'01',captureRunId:scope.captureRunId,reservationId:scope.reservationId,disposition:'TERMINAL_SETUP_REJECTION_COST_UNKNOWN',actualCostMicros:null,proof});
  const old={caseId:'01',captureRunId:randomUUID(),reservationId:randomUUID()};
  p=native(p,'reserve',{kind:'reserve',...old,ceilingMicros:3000000});
  p=native(p,'settle',{kind:'settle',...old,chargedCostMicros:1,ledgerSha256:'1'.repeat(64),envelopeSha256:'2'.repeat(64)});
  return reviseCaptureSpendProtocol(p,{pythonExecutable:python,invocation:'ACTIVATE_SHARED_SPEND_V2_SERVER_SETTLEMENT_ONCE',reviewSha256:'3'.repeat(64),deadlineAtMs:Date.now()+600000});
}
test('lost-process v2 reconciliation preserves all legacy bytes/holds, releases only authoritative unused new ceiling once',()=>{
  const f=fixture(),before=legacyThenV2(),owner=openCaptureSpendAggregate(before,{pythonExecutable:python});
  const reservation=owner.reserve({caseId:f.e.caseId,captureRunId:f.e.captureRunId,ceilingMicros:f.e.ceilingMicros});
  f.e.reservationId=reservation.reservationId;f.q.aggregateReservationId=reservation.reservationId;f.e.qualificationSha256=sha256Stable(f.q);f.b.qualificationSha256=f.e.qualificationSha256;
  const cp=owner.checkpoint(), files=['bundle-owner.json',...Array.from({length:6},(_,i)=>`spend-${String(i+1).padStart(6,'0')}.json`)].map(name=>[name,readFileSync(join(cp.state.root,name))]);
  const options={pythonExecutable:python,invocation:'RECONCILE_ACTIVE_TERMINAL_SPEND_ONCE',authority:authority(f)};
  const after=reconcileCaptureSpendTerminal(cp,options);
  assert.equal(after.snapshot.activeRun,null);assert.equal(after.snapshot.knownSettledCostMicros,626);assert.equal(after.snapshot.remainingReservationMicros,24000000-625);assert.equal(after.snapshot.terminalUnknownConservativeCostMicros,3000000);assert.equal(after.snapshot.releasedUnusedCeilingMicros,15000000-625);
  for(const [name,bytes]of files)assert.deepEqual(readFileSync(join(cp.state.root,name)),bytes);
  assert.throws(()=>reconcileCaptureSpendTerminal(cp,options));assert.throws(()=>reconcileCaptureSpendTerminal(after,options));
  assert.throws(()=>openCaptureSpendAggregate(after,{pythonExecutable:python}).reserve({caseId:f.e.caseId,captureRunId:f.e.captureRunId,ceilingMicros:1}));
});
test('reviewed bytes and explicit invocation required; JSON lookalike authority refuses',()=>{
  const f=fixture(),path=join(parent,randomUUID()+'.json');writeFileSync(path,JSON.stringify(f.r),{flag:'wx'});
  assert.throws(()=>prepareReviewedMemoryReadSpendReconciliation({readbackPath:path,readbackSha256:'0'.repeat(64),expected:f.e,invocation:'PREPARE_ROOT_REVIEWED_MEMORY_READ_TERMINAL_SPEND'}));
  assert.throws(()=>prepareReviewedMemoryReadSpendReconciliation({readbackPath:path,readbackSha256:hash(readFileSync(path)),expected:f.e,invocation:'automatic'}));
  assert.throws(()=>currentReviewedCaptureSpendReconciliation({kind:'reviewed_memory_read_terminal_spend_reconciliation',chargedCostMicros:0}));
});
