import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { prepareCase01FailedReceiptCostAuthority } from '../../meri-c1-20261002/evals/meri/live-v1/case01-failed-receipt-cost-authority.mjs';
import { reconcileCase01FailedReceiptCost } from '../../meri-c1-20261002/evals/meri/live-v1/capture-spend-aggregate.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003',repo='C:/dev/main/meri-c1-20261002';
const output=root+'/case01-terminal-cost-executed-v1';
const hash=b=>createHash('sha256').update(b).digest('hex');
const checkpointBytes=readFileSync(root+'/case01-terminal-cost-qualification-v2/checkpoint.json');
const qualification=JSON.parse(checkpointBytes),review=JSON.parse(readFileSync(root+'/case01-terminal-cost-independent-review-v1.json'));
assert.equal(qualification.status,'PASS');assert.equal(review.status,'PASS');assert.equal(review.qualificationSha256,hash(checkpointBytes));
assert.equal(review.action,'COST_ONLY_FIXED_FAILED_CASE01');
for(const source of qualification.sources)assert.equal(hash(readFileSync(repo+'/'+source.path)),source.sha256);
const journal='C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl',before=readFileSync(journal);
assert.equal(hash(before),'7ac5a5d06782d325e0d30327586968aa60233681b7dec2ed98f50285ed6daa60');
mkdirSync(output);
const save=(name,value)=>{const fd=openSync(output+'/'+name,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}};
save('intent.json',{at:new Date().toISOString(),action:'RECONCILE_FAILED_CASE01_PROVIDER_COST_ONCE',
  qualificationSha256:hash(checkpointBytes),reviewSha256:hash(readFileSync(root+'/case01-terminal-cost-independent-review-v1.json')),
  journalBeforeSha256:hash(before),operatorSha256:hash(readFileSync(new URL(import.meta.url))),
  captureAuthority:false,answerGrade:'NOT_EVALUATED',captureStatus:'CAPTURE_UNCERTAIN',modelSubmissions:0});
try{
  const authority=prepareCase01FailedReceiptCostAuthority();
  const checkpoint=reconcileCase01FailedReceiptCost(authority,{
    pythonExecutable:'C:/Users/neoma/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe',
    invocation:'RECONCILE_FAILED_CASE01_PROVIDER_COST_ONCE'});
  save('aggregate-checkpoint.json',checkpoint);
  const after=readFileSync(journal);assert.ok(after.subarray(0,before.length).equals(before));
  assert.equal(after.toString().trim().split('\n').length,22);
  assert.equal(checkpoint.snapshot.eventCount,22);assert.equal(checkpoint.snapshot.activeRun,null);
  assert.equal(checkpoint.snapshot.knownSettledCostMicros,12133883);assert.equal(checkpoint.snapshot.remainingReservationMicros,17866117);
  const result={status:'TERMINAL_COST_RECONCILED',at:new Date().toISOString(),journalBeforeSha256:hash(before),journalAfterSha256:hash(after),
    chargedThisRunMicros:2292602,knownFreshCostMicros:12133883,remainingFreshBudgetMicros:17866117,
    originalPrefixPreserved:true,captureAuthority:false,answerGrade:'NOT_EVALUATED',captureStatus:'CAPTURE_UNCERTAIN',
    originalFailure:'meri_capture_receipt_readback_mismatch',cloudCalls:0,modelSubmissions:0,automaticRetryAllowed:false};
  save('result.json',result);console.log(JSON.stringify(result));
}catch(error){
  save('failure.json',{at:new Date().toISOString(),status:'RECONCILE_CURRENT_BYTES_BEFORE_ANY_RETRY',errorClass:error?.name??'Error',
    currentJournalSha256:hash(readFileSync(journal))});throw error;
}
