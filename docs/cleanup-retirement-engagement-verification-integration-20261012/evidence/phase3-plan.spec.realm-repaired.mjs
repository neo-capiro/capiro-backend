import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import {
  engagementPhase3Scope, engagementPhase3QualificationPlan, engagementPhase3CompletionMarker,
  engagementPhase3FailureMarker, engagementPhase3Phase1Policy, engagementPhase3Phase1CompletionState,
  executeEngagementPhase3Plan,
} from './engagement-phase3-qualification-plan.mjs';

const base='5470c6df029c9553dd49e531229c3c91b26275ef',owner='scripts/verify-engagement-phase3-code.mjs';
const before=execFileSync('git',['show',`${base}:${owner}`],{encoding:'utf8'});
const current=readFileSync(new URL('./verify-engagement-phase3-code.mjs',import.meta.url),'utf8');
const slice=(s,a,b)=>s.slice(s.indexOf(a),s.indexOf(b,s.indexOf(a)));
const array=(s,name)=>slice(s,`const ${name} = [;`.replace('[;','['),'\n];')+'\n];';
const oldArray=array(before,'steps'),newArray=array(current,'fullSteps');
const context={PHASE3_SCOPE_END:'synthetic-head',PHASE3_WHITESPACE_BASE:'synthetic-base',scopedOptions:{env:{ENGAGEMENT_PHASE3_SCOPE_END:'synthetic-head'}}};
const full=JSON.parse(JSON.stringify(vm.runInNewContext(oldArray+'\nsteps;',context,{timeout:1000}))); 
const browserLabels=['Phase 3 web preview-header containment','Phase 3 focused web contracts','Phase 3 browser harness syntax','Phase 3 interaction harness syntax','Phase 3 scenario catalog syntax','Phase 3 bearer refresh syntax','Phase 3 browser+replay wrapper syntax','Web production typecheck','Web production build','Web complete regression suite'];
test('actual full step array, whitespace resolver and scoped source context remain byte-exact',()=>{
  assert.equal(newArray.replace('const fullSteps','const steps'),oldArray);
  assert.equal(slice(current,'function resolveWhitespaceBase()','\nconst PHASE3_WHITESPACE_BASE'),slice(before,'function resolveWhitespaceBase()','\nconst PHASE3_WHITESPACE_BASE'));
  assert.equal(engagementPhase3QualificationPlan('full',full),full);assert.equal(full.length,26);
});
test('backend excludes exactly original direct Web steps and only browser control argv',()=>{
  const plan=engagementPhase3QualificationPlan('backend-only',full);
  assert(!plan.some(x=>browserLabels.includes(x[0])));
  assert.deepEqual(plan.find(x=>x[0]==='Phase 1 prerequisite')[2],['verify:engagement-phase-1:backend']);
  assert.deepEqual(plan.find(x=>x[0]==='Phase 2 prerequisite')[2],['verify:engagement-phase-2:backend']);
  for(const label of ['Phase 3 UI inventory','Phase 3 preview route generation drift','Phase 3 V3/prototype boundary','Phase 3 scope and findings','Phase 3 committed-range whitespace'])assert.deepEqual(plan.find(x=>x[0]===label),full.find(x=>x[0]===label));
  assert(!plan.find(x=>x[0]==='Phase 3 harness/scope/resilience negative controls')[2].some(x=>x.startsWith('apps/web/')));
});
test('frontend retains root scope/prototype controls and nested frontend aliases',()=>{
  const plan=engagementPhase3QualificationPlan('frontend-only',full);
  assert.deepEqual(plan.find(x=>x[0]==='Phase 1 prerequisite')[2],['verify:engagement-phase-1:frontend']);
  assert.deepEqual(plan.find(x=>x[0]==='Phase 2 prerequisite')[2],['verify:engagement-phase-2:frontend']);
  for(const label of browserLabels)assert(plan.some(x=>x[0]===label));
  assert(plan.some(x=>x[0]==='Phase 3 browser negative controls'));assert(plan.some(x=>x[0]==='Phase 3 V3/prototype boundary'));assert(plan.some(x=>x[0]==='Phase 3 scope and findings'));
});
test('fake executor preserves selected argv/options and failure stop order',()=>{
  for(const scope of ['full','backend-only','frontend-only']){const plan=engagementPhase3QualificationPlan(scope,full),trace=[];
    executeEngagementPhase3Plan(plan,{run:(...x)=>trace.push(x),runPhase1:(...x)=>trace.push(x)});assert.deepEqual(trace,plan.map(([l,c,a,o])=>[l,c,a,o]));
    const stopped=[];assert.throws(()=>executeEngagementPhase3Plan(plan,{run:(l)=>{stopped.push(l);throw Error('fake exit');},runPhase1:()=>{throw Error('fake exit');}}),/fake exit/);assert.equal(stopped.length,1);
  }
});
for(const args of [[],['--backend-only'],['--run','--run'],['--run','--backend-only','--backend-only'],['--run','--backend-only','--frontend-only'],['--run','--help'],['--run','unknown']])test(`strict Phase3 refusal ${JSON.stringify(args)}`,()=>assert.throws(()=>engagementPhase3Scope(args)));
test('strict full/scoped grammar accepts exactly declared explicit intent',()=>{assert.equal(engagementPhase3Scope(['--run']),'full');assert.equal(engagementPhase3Scope(['--run','--backend-only']),'backend-only');assert.equal(engagementPhase3Scope(['--frontend-only','--run']),'frontend-only');});
test('full Windows baseline deliberately keeps substring/COMPLETE precedence/nonzero-exit weakness',()=>{
  assert.equal(engagementPhase3Phase1CompletionState('prefix ENGAGEMENT_PHASE1_DB_FREE_COMPLETE suffix\nENGAGEMENT_PHASE1_DB_FREE_FAILED','full',7),'complete');
});
for(const scope of ['backend-only','frontend-only'])test(`new scoped Windows exact selected receipt ${scope}`,()=>{
  const p=engagementPhase3Phase1Policy(scope),other=engagementPhase3Phase1Policy(scope==='backend-only'?'frontend-only':'backend-only');
  assert.equal(engagementPhase3Phase1CompletionState(p.complete+'\r\n',scope,null),'complete');assert.equal(engagementPhase3Phase1CompletionState(p.complete,scope,0),'complete');
  for(const [out,exit]of [[p.complete,7],[p.complete+'\n'+p.failed,0],[other.complete,0],[p.complete+'\n'+other.complete,0],['prefix '+p.complete+' suffix',0],['ENGAGEMENT_PHASE1_DB_FREE_COMPLETE',0]])assert.equal(engagementPhase3Phase1CompletionState(out,scope,exit),'failed');
  assert.equal(engagementPhase3Phase1CompletionState('still running',scope,null),'pending');
});
test('phase3 scope markers do not claim full completion; full failure protocol remains unchanged',()=>{
  assert.equal(engagementPhase3CompletionMarker('full'),'ENGAGEMENT_PHASE3_DB_FREE_COMPLETE');assert.equal(engagementPhase3FailureMarker('full'),undefined);
  assert.notEqual(engagementPhase3CompletionMarker('backend-only'),engagementPhase3CompletionMarker('frontend-only'));
});
