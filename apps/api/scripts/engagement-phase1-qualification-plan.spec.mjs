import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { engagementPhase1Scope, engagementPhase1Marker, engagementPhase1QualificationPlan } from './engagement-phase1-qualification-plan.ts';

// Read immutable source metadata; never import or launch the runtime verifier.
const require=createRequire(import.meta.url),ts=require('typescript');
const base='5470c6df029c9553dd49e531229c3c91b26275ef';
const owner='apps/api/scripts/verify-engagement-phase1-runtime.ts';
const before=execFileSync('git',['show',`${base}:${owner}`],{encoding:'utf8'});
const current=readFileSync(new URL('./verify-engagement-phase1-runtime.ts',import.meta.url),'utf8');
const clean=x=>JSON.parse(JSON.stringify(x));
const ast=s=>ts.createSourceFile(owner,s,ts.ScriptTarget.Latest,true);
function declaration(s,name){const sf=ast(s);for(const node of sf.statements){if(ts.isVariableStatement(node)){const d=node.declarationList.declarations.find(d=>d.name.getText(sf)===name);if(d)return d.initializer.getText(sf);}if(ts.isFunctionDeclaration(node)&&node.name?.text===name)return node.getText(sf);}throw Error(name);}
const targets=vm.runInNewContext(declaration(before,'TEST_TARGETS'));
async function trace(source,scope='full',failAt=null){
  const events=[];const run=async(label,command,args,cwd='inert-root',env={})=>{events.push({kind:'command',label,command,args:clean(args),env:clean(env)});if(label===failAt)throw Error(`fake ${label}`);};
  const context={GIT:'git',REPO_ROOT:'inert-root',SCOPE:scope,TEST_TARGETS:targets,engagementPhase1QualificationPlan,engagementPhase1Marker,
    spawnSync:()=>({status:0,stdout:'a'.repeat(40)}),console:{log:()=>{}},run,assertFile:relativePath=>events.push({kind:'required-file',relativePath}),assertNoWebPreviewRouting:()=>events.push({kind:'web-preview-routing'}),writeSync:(fd,value)=>events.push({fd,value}),process:{exit:code=>events.push({exit:code})}};
  const js=ts.transpileModule(declaration(source,'main')+'\nglobalThis.main=main;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(js,context,{timeout:1000});let error=null;try{await context.main();}catch(e){error=e.message;}return{events,error};
}
test('full plans match the actual immutable current24-step oracle',async()=>{
  const old=await trace(before),now=await trace(current);assert.deepEqual(now,old);
  assert.equal(now.events.filter(x=>x.kind).length,24);assert.equal(now.events.at(-2).value,'\nENGAGEMENT_PHASE1_DB_FREE_COMPLETE\n');
});
test('current16target list and process/retry/heap/PNPM/scanner functions remain byte-exact',()=>{
  assert.equal(declaration(current,'TEST_TARGETS'),declaration(before,'TEST_TARGETS'));assert.equal(targets.length,16);assert.equal(targets[0],'scripts/lib/engagement-verifier-process.spec.ts');
  for(const name of ['resolvePnpm','run','assertFile','walk','assertNoWebPreviewRouting'])assert.equal(declaration(current,name),declaration(before,name));
});
test('backend and frontend preserve every original step at the partition boundary',async()=>{
  const full=(await trace(before)).events.filter(x=>x.kind);
  const backend=(await trace(current,'backend-only')).events.filter(x=>x.kind),frontend=(await trace(current,'frontend-only')).events.filter(x=>x.kind);
  const isWeb=x=>x.kind==='web-preview-routing'||['Web typecheck','Web regression suite'].includes(x.label);
  assert.deepEqual(backend,full.filter(x=>!isWeb(x)));assert.deepEqual(frontend,full.filter(isWeb));assert.equal(backend.length,21);assert.equal(frontend.length,3);
});
test('fake process failure stops the plan with the same current error/timing',async()=>{
  for(const label of ['Locked dependency install','API production typecheck','Web typecheck'])assert.deepEqual(await trace(current,'full',label),await trace(before,'full',label));
});
test('plan forwards a supplied current target list without a stale internal catalog',()=>{
  const list=['current-probe.spec.ts'];const p=engagementPhase1QualificationPlan('backend-only','git',list);assert.equal(p.find(x=>x.args?.includes('jest')).args.at(-1),list[0]);
});
for(const args of [['--run'],['--run','--backend-only'],['--frontend-only','--run']])test(`explicit valid grammar ${args.join(' ')}`,()=>assert.equal(engagementPhase1Scope(args),args.includes('--backend-only')?'backend-only':args.includes('--frontend-only')?'frontend-only':'full'));
for(const args of [[],['--backend-only'],['--run','--run'],['--run','--backend-only','--backend-only'],['--run','--backend-only','--frontend-only'],['--run','--help'],['--run','unknown'],['--run','--print-plan']])test(`refused grammar ${JSON.stringify(args)}`,()=>assert.throws(()=>engagementPhase1Scope(args)));
for(const scope of ['full','backend-only','frontend-only'])test(`distinct markers ${scope}`,()=>{assert.notEqual(engagementPhase1Marker(scope,'complete'),engagementPhase1Marker(scope,'failed'));if(scope==='full')assert.equal(engagementPhase1Marker(scope,'complete'),'ENGAGEMENT_PHASE1_DB_FREE_COMPLETE');});
test('unknown helper scope/result refused',()=>{assert.throws(()=>engagementPhase1QualificationPlan('typo','git',targets));assert.throws(()=>engagementPhase1Marker('typo','complete'));assert.throws(()=>engagementPhase1Marker('full','typo'));});
for(const args of [[],['--help'],['--run'],['--run','--backend-only'],['--frontend-only','--run'],['--backend-only'],['--help','--run'],['--run','--run'],['--run','--backend-only','--backend-only'],['--run','--backend-only','--frontend-only'],['--run','unknown']])test(`actual early Phase1 guard ${JSON.stringify(args)}`,()=>{
  const start=current.indexOf('const USAGE'),end=current.indexOf('\n\nconst API_DIR',start),source=current.slice(start,end);
  const js=ts.transpileModule(source+'\nglobalThis.scope=SCOPE;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  let exited=null;class Exit extends Error {constructor(code){super('fake exit');this.code=code;}}
  const context={engagementPhase1Scope,console:{log:()=>{},error:()=>{}},process:{argv:['node','fixture',...args],exit:code=>{throw new Exit(code);},get env(){throw Error('must not read environment before guard');}}};
  try{vm.runInNewContext(js,context,{timeout:1000});}catch(e){if(!(e instanceof Exit))throw e;exited=e.code;}
  const valid=args.includes('--run')&&args.filter(x=>x==='--run').length===1&&args.filter(x=>x!=='--run').length<=1&&args.every(x=>['--run','--backend-only','--frontend-only'].includes(x));
  assert.equal(exited,args.length===1&&args[0]==='--help'?0:valid?null:2);
});
