const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict'),crypto=require('node:crypto'),ts=require('/workspace/capirov2/node_modules/typescript');
const pin='5470c6df029c9553dd49e531229c3c91b26275ef',file='apps/api/scripts/verify-engagement-phase1-runtime.ts',out='docs/cleanup-retirement-verification-independent-review-20261012/evidence/';
const source=cp.execFileSync('git',['show',`${pin}:${file}`],{encoding:'utf8'}),sf=ts.createSourceFile('source.ts',source,ts.ScriptTarget.Latest,true);
const main=sf.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='main');assert(main);
let targets;function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(sf)==='TEST_TARGETS')targets=n.initializer.getText(sf);ts.forEachChild(n,visit);}visit(sf);assert(targets);
const selected='const TEST_TARGETS = '+targets+';\n'+main.getText(sf);
const js=ts.transpileModule(selected,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const statements=[],ports=[],exit=new Error('synthetic completed plan');
const fakeRun=async(label,command,args,cwd='/repo',env={})=>{statements.push({kind:'run',label,command,args,cwd,env});};
const fakeSpawn=(command,args,options)=>{ports.push({port:'fakeGitHead',command,args,options});return{status:0,stdout:pin,stderr:''};};
const fakeProcess={exit:code=>{ports.push({port:'fakeExit',code});throw exit;},platform:'linux',env:{},execPath:'/node'};
const mainFn=new Function('run','assertFile','assertNoWebPreviewRouting','spawnSync','process','writeSync','console','REPO_ROOT','GIT',js+'\nreturn main;')(
 fakeRun,path=>statements.push({kind:'assertFile',path}),()=>statements.push({kind:'assertNoWebPreviewRouting'}),fakeSpawn,fakeProcess,
 (fd,bytes)=>ports.push({port:'fakeWrite',fd,bytes}),{log:(...args)=>ports.push({port:'fakeLog',args})},'/repo','git');
(async()=>{try{await mainFn();assert.fail('main must reach synthetic exit');}catch(error){assert.equal(error,exit);}assert.equal(statements.length,24);assert.equal(statements.filter(s=>s.kind==='run').length,19);assert.equal(statements.filter(s=>s.kind==='assertFile').length,4);assert.equal(statements.filter(s=>s.kind==='assertNoWebPreviewRouting').length,1);assert(ports.some(p=>p.port==='fakeWrite'&&p.bytes==='\nENGAGEMENT_PHASE1_DB_FREE_COMPLETE\n'));assert.equal(ports.at(-1).code,0);
 const result={source:pin,file,originalMainSha256:crypto.createHash('sha256').update(main.getText(sf)).digest('hex'),statements,ports,actualSpawnInstallBuildNativeAppSqlProviderCalls:0,applicationGraphImported:false,scope:'Trusted immutable main fragment with all child/assertion/stdout/exit ports synthetic; qualification commands are recorded only',candidateAcceptance:false};
 fs.writeFileSync(out+'full-phase1-before-golden.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({source:pin,orderedPlanSteps:statements.length,runCommands:19,assertions:5,actualCommandsExecuted:0}));
})().catch(error=>{console.error(error);process.exitCode=1;});
