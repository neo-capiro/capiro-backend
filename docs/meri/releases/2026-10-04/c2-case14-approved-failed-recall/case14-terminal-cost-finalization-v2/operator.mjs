// LEAD ONLY. Default check does not read the live journal; no JSON restore API.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {prepareCase14TerminalCostAuthority,inspectFixedPreparationStatus} from './authority.mjs';
import {dryRunCase14TerminalCost,reconcileCase14TerminalCost} from './bridge.mjs';
import {SCOPE} from './fixed.mjs';
import {hash} from './predicate.mjs';
const ROOT=fileURLToPath(new URL('.',import.meta.url));
const mode=process.argv[2]??'--check';
assert.equal(process.argv.length<=3,true,'NO_EXTRA_ARGUMENTS');
const save=(dir,name,value)=>{const fd=openSync(dir+'/'+name,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}};
if(mode==='--check')console.log(JSON.stringify(inspectFixedPreparationStatus()));
else if(mode==='--dry-run'){
 const result=dryRunCase14TerminalCost(prepareCase14TerminalCostAuthority());
 assert.equal(result.liveJournalRead,false);assert.equal(result.liveJournalMutated,false);console.log(JSON.stringify(result));
}else if(mode==='--append-once'){
 // No output intent and no live read can occur until fixed evidence/source/review qualify.
 const authority=prepareCase14TerminalCostAuthority();
 const journal='C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl';
 const before=readFileSync(journal);assert.equal(hash(before),SCOPE.journal25Sha256);assert.equal(before.length,SCOPE.journal25Bytes);assert.equal(before.toString('utf8').trim().split('\n').length,25);
 const output=ROOT+'executed-once';mkdirSync(output);
 save(output,'intent.json',{at:new Date().toISOString(),action:'RECONCILE_FAILED_CASE14_PROVIDER_COST_ONCE',journalBeforeSha256:SCOPE.journal25Sha256,captureRunId:SCOPE.captureRunId,captureAuthority:false,answerGrade:'NOT_EVALUATED'});
 try{
  const checkpoint=reconcileCase14TerminalCost(authority,{invocation:'RECONCILE_FAILED_CASE14_PROVIDER_COST_ONCE'});save(output,'aggregate-checkpoint.json',checkpoint);
  const after=readFileSync(journal);assert.equal(after.subarray(0,before.length).equals(before),true);assert.equal(after.toString('utf8').trim().split('\n').length,26);
  const s=checkpoint.snapshot;assert.equal(s.eventCount,26);assert.equal(s.activeRun,null);assert.equal(s.knownSettledCostMicros,15200909);assert.equal(s.conservativeApprovalCostMicros,1000000);assert.equal(s.committedCostMicros,16200909);assert.equal(s.remainingReservationMicros,13799091);
  const result={status:'COST_ONLY_RECONCILED',at:new Date().toISOString(),journalBeforeSha256:SCOPE.journal25Sha256,journalAfterSha256:hash(after),knownRecallCostMicros:1569851,conservativeApprovalCostMicros:1000000,approvalBilledActualMicros:null,remainingReservationMicros:13799091,captureAuthority:false,captureStatus:'CAPTURE_UNCERTAIN',answerGrade:'NOT_EVALUATED',automaticRetryAllowed:false,cloudCalls:0,providerCalls:0};save(output,'result.json',result);console.log(JSON.stringify(result));
 }catch(error){save(output,'failure.json',{status:'APPEND_OUTCOME_REQUIRES_READ_ONLY_RECONCILIATION',errorCode:error?.name??'ERROR',at:new Date().toISOString(),automaticRetryAllowed:false});throw error;}
}else throw Error('ONLY_CHECK_DRY_RUN_OR_APPEND_ONCE');
