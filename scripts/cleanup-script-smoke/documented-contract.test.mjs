import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deriveContract, MISSING_DATABASE_URL_SMOKE_CONTEXT as context} from './contract.mjs';
import {classifyRun} from './run-smoke.mjs';

const source = '/**\n * @cleanup-smoke noArgsExit=1 helpExit=0\n */\nasync function main(){throw Error("Usage: configure the dedicated role URLs");}void main().catch(()=>{process.exitCode=1;});';
const derive = (text) => deriveContract(text, 'fixture.ts', context);
test('explicit source documentation states exits without claiming execution or printed usage', () => {
  const c=derive(source);
  assert.equal(c.noArgs.exit,1);assert.equal(c.noArgs.documented,true);
  assert.equal(c.noArgs.usagePrinted,false);assert.equal(c.noArgs.usageRequired,true);
  assert.equal(c.help.exit,0);
  assert.equal(deriveContract(source,'fixture.ts').noArgs.documented,false);
});
test('duplicates, malformed values and out-of-range exits cannot document a contract', () => {
  for(const declaration of ['noArgsExit=-1','noArgsExit=256','noArgsExit=01','noArgsExit=true','noArgsExit=1 extra=2','noArgsExit=1 helpExit=256']) {
    assert.equal(derive(source.replace('noArgsExit=1 helpExit=0',declaration)).noArgs.documented,false,declaration);
  }
  assert.equal(derive(source.replace('@cleanup-smoke noArgsExit=1 helpExit=0','@cleanup-smoke noArgsExit=1\n * @cleanup-smoke noArgsExit=1')).noArgs.documented,false);
});
test('a string or a late comment cannot declare a source contract', () => {
  assert.equal(derive('const text="@cleanup-smoke noArgsExit=0";').noArgs.documented,false);
  assert.equal(derive('const value=1;\n/** @cleanup-smoke noArgsExit=0 */').noArgs.documented,false);
});
test('a script shebang preserves leading source documentation', () => {
  assert.equal(derive('#!/usr/bin/env node\n'+source).noArgs.exit,1);
});
test('explicit documentation cannot override a conflicting source-derived exit', () => {
  const code='/** @cleanup-smoke noArgsExit=1 */\nif(process.argv.length<=2){console.log("Usage: fixture");process.exit(2);}';
  assert.equal(derive(code).noArgs.documented,false);
});
test('explicit documentation never bypasses actual usage, exit, network, write or termination checks', () => {
  const contract=derive(source);
  const run=(exit,out='Usage: fixture')=>({exit,out,err:'',auditOk:true,entrypointExecuted:true,attempts:{network:[],write:[]},timedOut:false});
  const classify=(noArgs=run(1),help=run(0),unknown=run(1))=>classifyRun({kind:'entrypoint',rel:'fixture.ts'},noArgs,help,unknown,contract);
  assert.equal(classify().status,'ok');
  for(const [change,status] of [
    [{out:''},'noargs-contract'],[{exit:0},'noargs-contract'],
    [{attempts:{network:[{}],write:[]}},'attempt-audit-network'],
    [{attempts:{network:[],write:[{}]}},'attempt-audit-write'],
    [{timedOut:true},'timeout'],[{entrypointExecuted:false},'entrypoint-not-executed'],
    [{auditOk:false},'attempt-audit-unavailable'],[{containerResidual:true},'container-residual'],
  ]) assert.equal(classify({...run(1),...change}).status,status);
  assert.equal(classify(run(1),run(1)).status,'help-contract');
});
