// LEAD ONLY. Requires independent PASS bound to the exact qualification packet.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { prepareCase20TerminalCostAuthority } from '../../../meri-c1-20261002/evals/meri/live-v1/case20-terminal-cost-authority.mjs';
import { reconcileCase20TerminalCost } from '../../../meri-c1-20261002/evals/meri/live-v1/capture-spend-aggregate.mjs';
const root='C:/dev/main/outputs/meri-c2-20261003/cost-supervised-v1';
const output=root+'/executed-once';
const hash=b=>createHash('sha256').update(b).digest('hex');
const qualificationBytes=readFileSync(root+'/checkpoint.json');
const qualification=JSON.parse(qualificationBytes),reviewBytes=readFileSync(root+'/independent-review.json'),review=JSON.parse(reviewBytes);
assert.equal(qualification.status,'PASS');assert.equal(review.status,'PASS');assert.equal(review.qualificationSha256,hash(qualificationBytes));
assert.equal(review.action,'COST_ONLY_FIXED_FAILED_CASE20');
for(const source of qualification.sources)assert.equal(hash(readFileSync(source.path)),source.sha256);
const journal='C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl',before=readFileSync(journal);
assert.equal(hash(before),'d6213af1fd8330e9e97a688d903a3c1852b5f40265a66eafb6aa2bf1cfa2060b');
// Exclusive output creation makes uncertain outcomes require reconciliation.
mkdirSync(output);
const save=(name,value)=>{const fd=openSync(output+'/'+name,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}};
save('intent.json',{at:new Date().toISOString(),action:'RECONCILE_FAILED_CASE20_PROVIDER_COST_ONCE',
  qualificationSha256:hash(qualificationBytes),reviewSha256:hash(reviewBytes),journalBeforeSha256:hash(before),
  operatorSha256:hash(readFileSync(new URL(import.meta.url))),captureAuthority:false,answerGrade:'NOT_EVALUATED',
  captureStatus:'CAPTURE_UNCERTAIN',modelSubmissions:0,automaticRetryAllowed:false});
try{
  const checkpoint=reconcileCase20TerminalCost(prepareCase20TerminalCostAuthority(),{
    pythonExecutable:'C:/Users/neoma/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe',
    invocation:'RECONCILE_FAILED_CASE20_PROVIDER_COST_ONCE'});
  save('aggregate-checkpoint.json',checkpoint);
  const after=readFileSync(journal);assert.ok(after.subarray(0,before.length).equals(before));
  assert.equal(after.toString().trim().split('\n').length,24);
  assert.equal(checkpoint.snapshot.eventCount,24);assert.equal(checkpoint.snapshot.activeRun,null);
  assert.equal(checkpoint.snapshot.knownSettledCostMicros,13631058);assert.equal(checkpoint.snapshot.remainingReservationMicros,16368942);
  const result={status:'TERMINAL_COST_RECONCILED',at:new Date().toISOString(),journalBeforeSha256:hash(before),journalAfterSha256:hash(after),
    chargedThisRunMicros:1497175,knownFreshCostMicros:13631058,remainingFreshBudgetMicros:16368942,
    originalPrefixPreserved:true,captureAuthority:false,answerGrade:'NOT_EVALUATED',captureStatus:'CAPTURE_UNCERTAIN',
    originalFailure:'CONTROLLED_READ_FULL_PASSAGE_UNPROVED',cloudCalls:0,modelSubmissions:0,automaticRetryAllowed:false};
  save('result.json',result);console.log(JSON.stringify(result));
}catch(error){
  save('failure.json',{at:new Date().toISOString(),status:'RECONCILE_CURRENT_BYTES_BEFORE_ANY_RETRY',
    errorClass:error?.name??'Error',currentJournalSha256:hash(readFileSync(journal))});throw error;
}
