'use strict';
// Run only the actual published CLI's existing inert fixture; no app/default graph.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const ts=require('/workspace/capirov2/node_modules/typescript');
const root=path.resolve(__dirname,'../../..');
const base='apps/api/scripts/lib/';
const allow=new Set(['pe-phase-9-rehearsal-catalog.ts','pe-phase-9-backend-scope.ts','pe-phase-9-rehearsal.ts','pe-phase-9-runner.ts','pe-phase-9-evidence.ts','pe-phase-9-runner.test-support.ts']);
const cache=new Map(),bindings=[];
function load(name){
 if(!allow.has(name))throw Error('Unapproved finite source owner '+name);
 if(cache.has(name))return cache.get(name).exports;
 const file=path.join(root,base,name),source=fs.readFileSync(file,'utf8'),mod={exports:{}};
 cache.set(name,mod);bindings.push(base+name);
 const output=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const req=operand=>{
  if(['node:assert','node:crypto','node:path','node:fs','node:vm'].includes(operand))return require(operand);
  if(operand==='typescript')return ts;
  if(/^\.\/pe-phase-9-[a-z.-]+\.js$/.test(operand))return load(operand.slice(2,-3)+'.ts');
  throw Error('Unapproved source dependency '+operand);
 };
 const fn=vm.runInThisContext('(function(require,module,exports,__filename,__dirname){'+output+'\n})',{filename:file});
 fn(req,mod,mod.exports,file,path.dirname(file));return mod.exports;
}
const support=load('pe-phase-9-runner.test-support.ts'),catalog=load('pe-phase-9-rehearsal-catalog.ts');
const rows=[];
function pass(name,fn){fn();rows.push(name);}
for(const args of [[],['--run'],['--full']])pass('retained full '+JSON.stringify(args),()=>{
 const r=support.exerciseCli(args);assert.equal(r.error,undefined);assert.equal(r.exitCode,undefined);assert(r.logs.includes('PE_PHASE_9_OK'));assert(!r.logs.includes('PE_PHASE_9_BACKEND_OK'));
 const e=JSON.parse(r.writes.get('/fixture/docs/verification/program-elements-trust/phase-9/phase-9-rehearsal-summary.json'));
 assert.equal(e.kind,'integrated_release_rehearsal');assert.equal(e.scope,undefined);assert.deepEqual(e.outcomes.map(x=>x.stepId),catalog.pePhase9StepIds());
});
pass('backend run fake journal distinct scope',()=>{
 const r=support.exerciseCli(['--backend-only','--run']);assert.equal(r.error,undefined);assert.equal(r.exitCode,undefined);assert(r.logs.includes('PE_PHASE_9_BACKEND_OK'));assert(!r.logs.includes('PE_PHASE_9_OK'));
 assert(r.commands.every(x=>!/apps\/web|onboard-web|@capiro\/web/.test(x.command+' '+x.cwd)));
 const e=JSON.parse(r.writes.get('/fixture/docs/verification/program-elements-trust/phase-9-backend/phase-9-rehearsal-summary.json'));
 assert.equal(e.fullReleaseQualified,false);assert.equal(e.scope,'backend');assert.deepEqual(e.outcomes.map(x=>x.stepId),catalog.pePhase9StepIds('backend'));
});
for(const mode of ['--dry-run','--catalog-only','--integrity-only','--extended-proofs-only'])pass('readonly fake '+mode,()=>{
 const r=support.exerciseCli(['--backend-only',mode]);assert.equal(r.error,undefined);assert.equal(r.exitCode,undefined);assert.equal(r.commands.length,0);assert.equal(r.writes.size,0);assert(r.spawns.every(x=>x.command==='git'));assert(!r.logs.includes('PE_PHASE_9_BACKEND_OK'));
});
for(const args of [['--backend-only','--full'],['--backend-only=true'],['--unknown'],['--base-sha'],['--evidence-dir=']])pass('malformed before fake ports '+JSON.stringify(args),()=>{
 const r=support.exerciseCli(args);assert(r.error);assert.equal(r.commands.length,0);assert.equal(r.spawns.length,0);assert.equal(r.writes.size,0);
});
pass('required environment-skip blocks backend',()=>{
 const r=support.exerciseCli(['--backend-only','--skip-disposable-pg']);assert.equal(r.exitCode,1);assert(r.errors.includes('PE_PHASE_9_BACKEND_FAIL'));assert(!r.logs.includes('PE_PHASE_9_BACKEND_OK'));
});
pass('exact public aliases',()=>{
 assert.equal(support.API_PACKAGE.scripts['verify:pe-phase-9'],'tsx scripts/verify-pe-phase-9.ts --run');
 assert.equal(support.API_PACKAGE.scripts['verify:pe-phase-9:backend'],'tsx scripts/verify-pe-phase-9.ts --backend-only --run');
 assert.equal(support.API_PACKAGE.scripts['verify:pe-phase-9:backend:dry-run'],'tsx scripts/verify-pe-phase-9.ts --backend-only --dry-run');
});
console.log(JSON.stringify({passed:rows.length,rows,actualCLIReadWithFakePorts:true,loadedPureOwners:bindings,actualInstallDatabaseShellDockerOrAppPerformed:false},null,2));
