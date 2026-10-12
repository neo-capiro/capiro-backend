const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const ts=require('typescript');
const ROOT=process.cwd(),OUT=path.join(ROOT,'docs/cleanup-migration-cli-independent-review-20261012/evidence');
const original=fs.readFileSync(path.join(ROOT,'scripts/cleanup-script-smoke/pe-core-verifier-cli-contracts.test.mjs'),'utf8');
const ast=ts.createSourceFile('contracts.mjs',original,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);assert.equal(ast.parseDiagnostics.length,0);
let program=original;for(const node of [...ast.statements].reverse())if(ts.isImportDeclaration(node))program=program.slice(0,node.pos)+program.slice(node.end);
program=program.replaceAll('import.meta.url','reviewModuleUrl');program+='\nglobalThis.review={invoke,probe,cases,tests:reviewTests};';
const tests=[],trace=[],results=[];let changeResult=x=>x;
function passedSpawn(exe,args,opts){
 trace.push({exe,args,options:opts});const file=path.basename(args[args.indexOf('--import')+4]??'');
 const cli=args.find(x=>/\/scripts\/(lint-pe-scripts|verify-pe-migration-guards|verify-pe-phase-e-exact-sha)\.ts$/.test(x));assert(cli,'exact CLI operand');const name=path.basename(cli),cliArgs=args.slice(args.indexOf(cli)+1),usage=name==='lint-pe-scripts.ts'?'Usage: tsx scripts/lint-pe-scripts.ts [--help]\n':name==='verify-pe-migration-guards.ts'?'Usage: tsx scripts/verify-pe-migration-guards.ts [--validate-generate] [--help]\n':'Usage: tsx scripts/verify-pe-phase-e-exact-sha.ts [--help]\n';
 const preload=decodeURIComponent(args[4].slice('data:text/javascript,'.length));const override=preload.includes('const overriddenSource =');let response;
 if(cliArgs.includes('--unknown'))response={status:2,stdout:'',stderr:'Unknown argument(s): --unknown\n'+usage};
 else if(cliArgs.includes('--help'))response={status:0,stdout:usage,stderr:''};
 else if(override)response={status:1,stdout:'',stderr:(name==='lint-pe-scripts.ts'?usage+'PE_LINT_SCRIPTS_FAILED: ':'PE_MIGRATION_GUARDS_FAILED: ')+'scripts/entrypoint.sh: raw LF-normalized source differs from the approved manual recovery envelope\n'};
 else response={status:0,stdout:name==='lint-pe-scripts.ts'?'PE_LINT_SCRIPTS_OK\n':name==='verify-pe-migration-guards.ts'?'PE_MIGRATION_GUARDS_OK\n':JSON.stringify({ok:true,loadersChecked:13,loaders:review.cases[2].loadersExpected})+'\n',stderr:usage};
 return changeResult({...response,error:undefined,signal:null,stderr:response.stderr+'RESOURCE_PROBE:0:0:0\n'}, {name,cliArgs,override,preload});
}
const context={assert,spawnSync:passedSpawn,readFileSync:(file,encoding)=>fs.readFileSync(file,encoding),path,fileURLToPath:require('node:url').fileURLToPath,test:(name,fn)=>tests.push({name,fn}),deriveContract:()=>({noArgs:{documented:true,exit:0},help:{exit:0},evidence:'inert predeclared metadata only; actual deriver exercised by guarded real CLI suite'}),MISSING_DATABASE_URL_SMOKE_CONTEXT:{},reviewTests:tests,reviewModuleUrl:require('node:url').pathToFileURL(path.join(ROOT,'scripts/cleanup-script-smoke/pe-core-verifier-cli-contracts.test.mjs')).href,process:{env:{DATABASE_URL:'inert-sentinel',NODE_OPTIONS:'inert-option',OTHER:'retained'},execPath:'/inert/node'}};
vm.createContext(context);vm.runInContext(program,context,{timeout:1000});const review=context.review;
function control(name,run){run();results.push({name,pass:true});}
control('all five actual assertion callbacks accept exact legitimate fake traces',()=>{assert.equal(tests.length,5);for(const test of tests)test.fn();});
control('timeout/env/argv exact across every captured child boundary',()=>{for(const call of trace){assert.equal(call.options.timeout,15000);assert.equal(call.options.env.TSX_DISABLE_CACHE,'1');assert(!('DATABASE_URL'in call.options.env));assert(!('NODE_OPTIONS'in call.options.env));assert.equal(call.options.env.OTHER,'retained');assert.deepEqual(Array.from(call.args.slice(0,4)),['--import','tsx','--import',call.args[3]]);assert(call.args[3].startsWith('data:text/javascript,'));}});
for(const [name,patch]of [
 ['spawn error',x=>({...x,error:new Error('inert spawn error')})],['termination signal',x=>({...x,signal:'SIGTERM'})],['wrong exit',x=>({...x,status:7})],['missing probe',x=>({...x,stderr:x.stderr.replace('RESOURCE_PROBE:0:0:0\n','')})],['write counter',x=>({...x,stderr:x.stderr.replace('0:0:0','1:0:0')})],['network counter',x=>({...x,stderr:x.stderr.replace('0:0:0','0:1:0')})],['child counter',x=>({...x,stderr:x.stderr.replace('0:0:0','0:0:1')})]
])control('invoke rejects '+name,()=>{changeResult=patch;assert.throws(()=>review.invoke('lint-pe-scripts.ts',[],0));changeResult=x=>x;});
for(const [name,patch]of [
 ['empty healthy stdout',x=>({...x,stdout:''})],['wrong healthy marker',x=>({...x,stdout:'PE_MIGRATION_GUARDS_OK\n'})],['extra healthy stdout',x=>({...x,stdout:x.stdout+'extra\n'})],['extra stderr failure',x=>({...x,stderr:'PE_LINT_SCRIPTS_FAILED: hidden\n'+x.stderr})],['forged zero plus actual nonzero probe',x=>({...x,stderr:x.stderr+'RESOURCE_PROBE:1:0:0\n'})]
])control('healthy callback rejects '+name,()=>{changeResult=patch;assert.throws(()=>tests[0].fn());changeResult=x=>x;});
for(const [name,patch]of [
 ['wrong healthy exit for refused source',(x,s)=>s.override?({...x,status:0,stdout:'PE_LINT_SCRIPTS_OK\n'}):x],['success stdout at failure exit',(x,s)=>s.override?({...x,stdout:'PE_MIGRATION_GUARDS_OK\n'}):x],['wrong failure reason',(x,s)=>s.override?({...x,stderr:x.stderr.replace('raw LF-normalized source differs from the approved manual recovery envelope','unrelated failure')}):x],['success marker in stderr',(x,s)=>s.override?({...x,stderr:x.stderr+'PE_MIGRATION_GUARDS_OK\n'}):x],['duplicate probe marker',(x,s)=>s.override?({...x,stderr:x.stderr+'RESOURCE_PROBE:0:0:0\n'}):x],['uncaught stack',(x,s)=>s.override?({...x,stderr:x.stderr+'\n    at inert-frame'}):x]
])control('new refusal callback rejects '+name,()=>{changeResult=patch;assert.throws(()=>tests[4].fn());changeResult=x=>x;});
const importedCalls=[];
function makeProbe(preload){
 let exit;const calls={reads:[],syncs:0};const dummyRead=(...args)=>{calls.reads.push(args);return 'original read';};
 const fakeFs={readFileSync:dummyRead,promises:{}};const fakeNet={Socket:function(){}},fakeHttp={},fakeHttps={},fakeChildren={};
 const probeContext={fs:fakeFs,net:fakeNet,http:fakeHttp,https:fakeHttps,childProcess:fakeChildren,syncBuiltinESMExports:()=>calls.syncs++,Buffer,process:{on:(event,callback)=>{assert.equal(event,'exit');exit=callback;},stderr:{write:value=>{calls.stderr=value;}}}};
 let pure=preload;const pa=ts.createSourceFile('probe.mjs',pure,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);assert.equal(pa.parseDiagnostics.length,0);for(const n of[...pa.statements].reverse())if(ts.isImportDeclaration(n))pure=pure.slice(0,n.pos)+pure.slice(n.end);
 vm.createContext(probeContext);vm.runInContext(pure,probeContext,{timeout:1000});return {fs:fakeFs,net:fakeNet,http:fakeHttp,https:fakeHttps,children:fakeChildren,context:probeContext,calls,exit:()=>exit()};
}
for(const value of ['node ./unsafe --run', '"; globalThis.mutantExecuted=true; //', '` ${globalThis.mutantExecuted=true} ; process.exit(0);', 'first\nsecond\u2028third'])control('override is inert data '+JSON.stringify(value),()=>{
 const before=trace.length;review.invoke('lint-pe-scripts.ts',[],1,{path:'scripts/entrypoint.sh',source:value});const call=trace[before],preload=decodeURIComponent(call.args[3].slice('data:text/javascript,'.length)),fake=makeProbe(preload);
 assert.equal(fake.fs.readFileSync('/root/apps/api/scripts/entrypoint.sh','utf8'),value);assert.equal(fake.fs.readFileSync('C:\\root\\apps\\api\\scripts\\entrypoint.sh','utf8'),value);assert.equal(fake.fs.readFileSync('/root/apps/api/scripts/entrypoint.sh').toString(),value);assert.equal(fake.fs.readFileSync('/root/elsewhere/file.txt','utf8'),'original read');assert.equal(fake.calls.reads.length,1);assert.equal(fake.context.mutantExecuted,undefined);assert.equal(fake.calls.syncs,2);fake.exit();assert.equal(fake.calls.stderr,'RESOURCE_PROBE:0:0:0\n');
});
for(const [name,call,expected]of [['writes',x=>x.fs.writeFileSync('/inert','ignored'),'1:0:0'],['network',x=>new x.net.Socket().connect('inert'),'0:1:0'],['child',x=>x.children.execFileSync('/inert',[]),'0:0:1']])control('actual preload continues refusal of '+name+' with override',()=>{
 const before=trace.length;review.invoke('lint-pe-scripts.ts',[],1,{path:'scripts/entrypoint.sh',source:'inert text'});const fake=makeProbe(decodeURIComponent(trace[before].args[3].slice('data:text/javascript,'.length)));assert.throws(()=>call(fake));fake.exit();assert.equal(fake.calls.stderr,'RESOURCE_PROBE:'+expected+'\n');
});
const output={source:'577bddc91784eb27f68f19f2feea8e93fe5e2829',tree:'36010242e323610ccb26d2394a90a708c962680e',results,actualFiveTestNames:tests.map(x=>x.name),capturedChildBoundaries:trace.length,mutantBodiesExecuted:false,actualSpawnCalls:0,actualWrites:0,actualNetwork:0,nativeAcceptance:false};fs.writeFileSync(path.join(OUT,'inert-cli-review.json'),JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify({controls:results.length,passed:results.length,testNames:output.actualFiveTestNames,mutantBodiesExecuted:false,actualSpawnCalls:0},null,2));
