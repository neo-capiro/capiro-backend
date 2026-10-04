import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
const operatorPath=fileURLToPath(new URL('./run-case20-terminal-cost-once.mjs',import.meta.url));
const source=fs.readFileSync(operatorPath,'utf8');
const hash=b=>createHash('sha256').update(b).digest('hex');
const live='C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl',liveBefore=fs.readFileSync(live);
const fixture='C:/dev/main/meri-c1-20261002/evals/meri/live-v1/tests/fixtures/';
const wire=fs.readFileSync(fixture+'case20-terminal-cost-journal23.unit.jsonl');
const proof=JSON.parse(fs.readFileSync(fixture+'case20-terminal-cost-proof.unit.json'));

function scenario({input=source,corruptPrefix=false,fail=false}={}){
  const folder=fs.mkdtempSync(root+'operator-dry-').replaceAll('\\','/');
  const journal=folder+'/fresh-spend.jsonl';fs.writeFileSync(journal,wire);
  const qualification=fs.readFileSync(root+'checkpoint.json');
  fs.writeFileSync(folder+'/checkpoint.json',qualification);
  // Test-only review fixture is local to the disposable directory, never live.
  fs.writeFileSync(folder+'/independent-review.json',JSON.stringify({status:'PASS',action:'COST_ONLY_FIXED_FAILED_CASE20',qualificationSha256:hash(qualification)}));
  const body=input.replace(/^import .*;\r?\n/gm,'')
    .replace("const root='C:/dev/main/outputs/meri-c2-20261003/cost-supervised-v1';",`const root=${JSON.stringify(folder)};`)
    .replace("const journal='C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl'",`const journal=${JSON.stringify(journal)}`)
    .replace('new URL(import.meta.url)','operatorPath');
  assert.notEqual(body,input);
  const invoke=new Function('assert','readFileSync','mkdirSync','openSync','writeFileSync','fsyncSync','closeSync','createHash','prepareCase20TerminalCostAuthority','reconcileCase20TerminalCost','console','operatorPath',body);
  let calls=0;const capability={};
  const reconcile=(actual,options)=>{
    calls++;assert.equal(actual,capability);assert.equal(options.invocation,'RECONCILE_FAILED_CASE20_PROVIDER_COST_ONCE');
    if(fail)throw Error('TEST_ONLY_NATIVE_FAILURE');
    const addition=Buffer.from(JSON.stringify({nativeCaptureVersion:1,sequence:24,atMs:Date.now(),event:'terminal_cost_reconciled',caseId:proof.caseId,captureRunId:proof.captureRunId,reservationId:proof.reservationId,proof})+'\n');
    const prefix=Buffer.from(wire);if(corruptPrefix)prefix[0]=32;
    fs.writeFileSync(journal,Buffer.concat([prefix,addition]));
    return {kind:'meri-fresh-capture-spend-checkpoint',version:1,snapshot:{eventCount:24,activeRun:null,knownSettledCostMicros:13631058,remainingReservationMicros:16368942}};
  };
  const run=()=>invoke(assert,fs.readFileSync,fs.mkdirSync,fs.openSync,fs.writeFileSync,fs.fsyncSync,fs.closeSync,createHash,()=>capability,reconcile,{log:()=>{}},operatorPath);
  return {folder,journal,run,calls:()=>calls};
}
test.after(()=>assert.deepEqual(fs.readFileSync(live),liveBefore,'real journal changed'));
test('actual source has one backslash escape, not literal backslash-n output',()=>{
  const slash=String.fromCharCode(92);
  assert.ok(source.includes("split('"+slash+"n')"));
  assert.ok(!source.includes("split('"+slash+slash+"n')"));
  assert.ok(source.includes("JSON.stringify(value,null,2)+'"+slash+"n'"));
});
test('successful operator preserves23 prefix and writes three valid newline-terminated JSON files',()=>{
  const s=scenario();s.run();assert.equal(s.calls(),1);
  const after=fs.readFileSync(s.journal);
  assert.deepEqual(after.subarray(0,wire.length),wire);
  assert.equal(after.toString().trim().split('\n').length,24);
  for(const name of ['intent.json','aggregate-checkpoint.json','result.json']){
    const b=fs.readFileSync(s.folder+'/executed-once/'+name);
    assert.equal(b.at(-1),10);assert.doesNotThrow(()=>JSON.parse(b));
  }
  const result=JSON.parse(fs.readFileSync(s.folder+'/executed-once/result.json'));
  assert.equal(result.status,'TERMINAL_COST_RECONCILED');assert.equal(result.originalPrefixPreserved,true);
  assert.equal(result.captureStatus,'CAPTURE_UNCERTAIN');assert.equal(result.captureAuthority,false);
  assert.throws(s.run);assert.equal(s.calls(),1);
});
test('native failure writes parseable failure evidence without appending',()=>{
  const s=scenario({fail:true});assert.throws(s.run,/TEST_ONLY_NATIVE_FAILURE/);
  assert.deepEqual(fs.readFileSync(s.journal),wire);
  const b=fs.readFileSync(s.folder+'/executed-once/failure.json');assert.equal(b.at(-1),10);
  assert.equal(JSON.parse(b).status,'RECONCILE_CURRENT_BYTES_BEFORE_ANY_RETRY');
  assert.throws(s.run);assert.equal(s.calls(),1);
});
test('changed prefix cannot produce a successful result',()=>{
  const s=scenario({corruptPrefix:true});assert.throws(s.run);
  assert.equal(fs.existsSync(s.folder+'/executed-once/result.json'),false);
  assert.equal(JSON.parse(fs.readFileSync(s.folder+'/executed-once/failure.json')).status,'RECONCILE_CURRENT_BYTES_BEFORE_ANY_RETRY');
});
test('regression test detects an intentionally doubled split escape',()=>{
  const slash=String.fromCharCode(92);
  const bad=source.replace("split('"+slash+"n')","split('"+slash+slash+"n')");
  assert.notEqual(bad,source);const s=scenario({input:bad});assert.throws(s.run);
  assert.equal(fs.existsSync(s.folder+'/executed-once/result.json'),false);
});
