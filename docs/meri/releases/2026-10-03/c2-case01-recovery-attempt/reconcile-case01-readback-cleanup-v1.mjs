import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root='C:/dev/main/outputs/meri-c2-20261003';
const hash=b=>createHash('sha256').update(b).digest('hex');
const resultPath=root+'/case01-recovery-terminal-readback-v1/result.json';
const original=JSON.parse(readFileSync(resultPath,'utf8'));
const denied=JSON.parse(readFileSync(root+'/case01-recovery-terminal-readback-v1/response-2.json','utf8'));
assert.equal(original.errorClass,'AssertionError');assert.equal(denied.observation.status,403);
let expected;
try{assert.equal(403,200);}catch(error){expected=hash(error.message);}
assert.equal(original.messageSha256,expected);
const helper=readFileSync('C:/dev/main/outputs/meri-fresh-20261003/auth-preflight.mjs');
assert.match(helper.toString(),/finally \{ if\(session\?\.id\) \{ const revoked=await clerk\('POST','\/sessions\/'.*need\(revoked.status==='revoked','SESSION_NOT_REVOKED'\)/u);
const budget=original.conversation.metadata.serverCaptureProviderBudget;
assert.equal(budget.ledger.attempts.length,5);assert.ok(budget.ledger.attempts.every(a=>a.status==='settled'));
assert.equal(budget.ledger.attempts.reduce((n,a)=>n+a.actualCostMicros,0),budget.ledger.chargedCostMicros);
const value={status:'READBACK_FAILURE_AND_CLEANUP_RECONCILED_FROM_EXECUTED_CONTROL_FLOW',
  originalResultSha256:hash(readFileSync(resultPath)),authHelperSha256:hash(helper),
  originalFailure:'MESSAGES_GET_403_MERI_CAPTURE_POLICY_READBACK_DENIED',
  sessionRevocation:'VERIFIED_BY_HELPER_FINALLY_RESPONSE',
  explanation:'The exact original AssertionError survived withAuth. Its finally awaited revocation and required status revoked. A cleanup failure would have replaced that error with Error. The callback was entered only after session creation. The original result flag was set only after overall success, so its false value is not proof that revocation failed.',
  sourceCorrection:false,originalResultPreserved:true,additionalAuthOrApiCalls:0,
  providerAttempts:5,allObservedAttemptsSettled:true,serverAccountedCostMicros:budget.ledger.chargedCostMicros,
  aggregateReservationStatus:'STILL_ACTIVE_FULL_CEILING',aggregateSettlementPerformed:false,
  verifiedAt:new Date().toISOString()};
writeFileSync(root+'/case01-recovery-terminal-readback-v1-cleanup-reconciliation.json',JSON.stringify(value,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(value));
