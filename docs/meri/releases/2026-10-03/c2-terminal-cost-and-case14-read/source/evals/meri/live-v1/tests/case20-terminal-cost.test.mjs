import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CASE20_TERMINAL_COST_PINS as pins } from '../case20-terminal-cost-pins.mjs';
import { inspectCase20TerminalCost as inspect, consumeCase20TerminalCostAuthority as consume } from '../case20-terminal-cost-authority.mjs';
import { reconcileCase20TerminalCost as reconcile } from '../capture-spend-aggregate.mjs';
import { sha256Stable } from '../lib/stable.mjs';

const input=JSON.parse(readFileSync(new URL('./fixtures/case20-terminal-cost.unit.json',import.meta.url)));
test('retained blocked receipt qualifies only 1497175 micros and no answer authority',()=>{
  const proof=inspect(structuredClone(input));
  assert.equal(sha256Stable(proof),'305283f0048a7f7ae82dc322f8353a2499cc444cc2e60537736375d0e5eed3a0');
  assert.equal(proof.chargedCostMicros,1497175);assert.equal(proof.providerTokens,59737);
  assert.equal(proof.captureStatus,'CAPTURE_UNCERTAIN');assert.equal(proof.answerGrade,'NOT_EVALUATED');assert.equal(proof.captureAuthority,false);
  assert.equal('envelopeSha256' in proof,false);
});
const changes={
  'extra submission':x=>x.execution.outcome.synthesisSubmissionCount++,
  'session not revoked':x=>x.readback.sessionRevoked=false,
  'wrong actor':x=>x.me.value.user.id=x.me.value.tenant.id,
  'wrong role':x=>x.me.value.role='firm_admin',
  'wrong tenant':x=>x.conversation.value.tenantId=x.conversation.value.userId,
  'wrong client':x=>x.conversation.value.clientId=null,
  'source drift':x=>x.readback.reads[1].apiReleaseSha='0'.repeat(40),
  'receipt made pass':x=>x.captured.envelope.receipt.status='PASS',
  'receipt signature drift':x=>x.captured.envelope.signature='0'.repeat(64),
  'raw token redaction':x=>x.captured.envelope.receipt.providerBudget.chargedTokens='[REDACTED]',
  'raw receipt cost drift':x=>x.captured.envelope.receipt.providerBudget.chargedCostMicros=0,
  'extra provider attempt':x=>x.readback.providerBudget.ledger.attempts.push(x.readback.providerBudget.ledger.attempts[0]),
  'pending provider attempt':x=>x.readback.providerBudget.ledger.attempts[0].status='reserved',
  'rate drift':x=>x.readback.providerBudget.qualification.rates[0].inputMicrosPerMillion=0,
  'attempt identity drift':x=>x.readback.providerBudget.ledger.attempts[0].attemptId='different',
  'early read':x=>x.readback.reads[1].observedAt=x.readback.providerBudget.ledger.limits.deadlineAt,
  'late settlement':x=>x.readback.providerBudget.ledger.attempts[0].settledAt=x.readback.finishedAt,
  'journal drift':x=>x.checkpoint.state.files['fresh-spend.jsonl'].sha256='0'.repeat(64),
  'wrong sequence':x=>x.checkpoint.snapshot.eventCount=24,
  'wrong reservation':x=>x.execution.restoredReservation.reservationId=x.execution.captureRunId,
  'claim drift':x=>x.recoveryClaim.noAutomaticRetry=false,
  'broader budget':x=>x.authorization.maxCostMicros=60000000,
  'scope drift':x=>x.scope.config.scope.clients.ASTER.physicalId=null,
  'read adds write':x=>x.readback.applicationWrites=1,
};
for(const [name,change] of Object.entries(changes))test(name+' cannot release the ceiling',()=>{
  const value=structuredClone(input);change(value);assert.throws(()=>inspect(value),/COST_REJECTED/);
});
test('every semantic evidence file is required',()=>{
  for(const [name,pin] of Object.entries(pins))if(pin.semanticSha256){const value=structuredClone(input);delete value[name];assert.throws(()=>inspect(value));}
});
test('forged authority and wrong invocation cannot reach native owner',()=>{
  const fake={kind:'case20-terminal-provider-cost'};
  assert.throws(()=>consume(fake));
  assert.throws(()=>reconcile(fake,{pythonExecutable:'wrong',invocation:'RECONCILE_FAILED_CASE20_PROVIDER_COST_ONCE'}));
  assert.throws(()=>reconcile(fake,{pythonExecutable:'wrong',invocation:'wrong'}));
});
test('isolated exact pins enforce bytes, one-use authority, and consume-time revalidation',async()=>{
  const root=mkdtempSync(join(tmpdir(),'meri-case20-cost-'));
  const copiedPins={};
  // This integration test requires the retained local evidence, but uses the
  // archived23 fixture for the journal and writes only disposable copies.
  for(const [name,pin]of Object.entries(pins)){
    const bytes=name==='journal'?readFileSync(new URL('./fixtures/case20-terminal-cost-journal23.unit.jsonl',import.meta.url)):readFileSync(pin.path);
    copiedPins[name]={...pin,path:join(root,name+'.fixture')};writeFileSync(copiedPins[name].path,bytes);
  }
  const sourceUrl=new URL('../case20-terminal-cost-authority.mjs',import.meta.url);
  const pinPath=join(root,'pins.mjs');writeFileSync(pinPath,'export const CASE20_TERMINAL_COST_PINS = '+JSON.stringify(copiedPins)+';');
  let source=readFileSync(sourceUrl,'utf8').replace(/from '(\.\/[^']+)'/gu,(_all,ref)=>`from '${new URL(ref,sourceUrl).href}'`);
  source=source.replace(new URL('../case20-terminal-cost-pins.mjs',import.meta.url).href,pathToFileURL(pinPath).href);
  const modulePath=join(root,'authority.mjs');writeFileSync(modulePath,source);
  const m=await import(pathToFileURL(modulePath));
  const authority=m.prepareCase20TerminalCostAuthority();m.consumeCase20TerminalCostAuthority(authority);
  assert.throws(()=>m.consumeCase20TerminalCostAuthority(authority));
  const pending=m.prepareCase20TerminalCostAuthority();
  writeFileSync(copiedPins.recoveryClaim.path,'{}\n');
  assert.throws(()=>m.consumeCase20TerminalCostAuthority(pending));assert.throws(()=>m.prepareCase20TerminalCostAuthority());
});
