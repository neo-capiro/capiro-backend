const fs=require('node:fs'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict'),path=require('node:path');
const root='docs/cleanup-retirement-engagement-verification-integration-20261012';
const source='e35d37ec080bbfbc5fccc0affe543af5b31fc1e2',base='5470c6df029c9553dd49e531229c3c91b26275ef',donor='8ac4c42cc49876ec19808369c0683956e0f2f474';
const git=(...a)=>cp.execFileSync('git',a,{encoding:'utf8',maxBuffer:8000000}).trim(),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const paths=git('diff','--name-only',base,source,'--','.',':!docs').split('\n');assert.equal(paths.length,8);
const sourceEntries=paths.map(p=>{const bytes=fs.readFileSync(p),blob=git('rev-parse',source+':'+p);assert.equal(git('hash-object',p),blob);return{path:p,blob,bytes:bytes.length,sha256:sha(bytes)};});
assert.equal(git('diff','--name-only',source,'HEAD','--','.',':!docs'),'');
fs.writeFileSync(root+'/SOURCE-MANIFEST.final.json',JSON.stringify({base,baseTree:git('rev-parse',base+'^{tree}'),donor,source,sourceTree:git('rev-parse',source+'^{tree}'),changedSourceCount:8,sourceEntries},null,2)+'\n');
const commands=[
 {argv:['node','--check','scripts/engagement-phase3-qualification-plan.mjs'],log:'13-final-phase3-helper-syntax.log'},
 {argv:['node','--check','scripts/verify-engagement-phase3-code.mjs'],log:'14-final-phase3-wrapper-syntax.log'},
 {argv:['bash','-n','scripts/verify-engagement-phase2-code.sh'],log:'15-final-phase2-shell-syntax.log'},
 {argv:['git','diff','--check',base,source,'--','.',':!docs'],log:'16-final-source-whitespace.log'},
];
for(const c of commands){const r=cp.spawnSync(c.argv[0],c.argv.slice(1),{encoding:'utf8',timeout:5000});fs.writeFileSync(root+'/evidence/'+c.log,(r.stdout??'')+(r.stderr??''));assert.equal(r.status,0);c.exitCode=r.status;}
fs.writeFileSync(root+'/COMMANDS.json',JSON.stringify({source,sourceTree:git('rev-parse',source+'^{tree}'),sourceOnly:true,retainedInitialFreezerFailure:{program:'freeze-packet.cjs',exitCode:1,rawCheck:'09-frozen-source-whitespace.log'},
 controls:[{log:'01-pure-plan-controls.log',exit:1},{log:'02-pure-plan-controls-repaired.log',exit:1},{log:'04-pure-plan-controls-final.log',exit:0,tests:78},{log:'05-pure-plan-early-guard-controls.log',exit:0,tests:100},{log:'10-whitespace-repaired-pure-controls.log',exit:0,tests:100},{log:'11-scoped-mixed-receipt-repaired-controls.log',exit:0,tests:105}],
 focusedTypes:{originalTypedHead:'ec7261b0689bef2bcec1be3beb9af7754c12dc30',unchangedTypedFiles:['apps/api/scripts/verify-engagement-phase1-runtime.ts','apps/api/scripts/engagement-phase1-qualification-plan.ts','apps/api/scripts/lib/engagement-verifier-process.ts'],argv:'node /workspace/capirov2/node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module Node16 --moduleResolution Node16 --types node --typeRoots /workspace/capirov2/apps/api/node_modules/@types apps/api/scripts/verify-engagement-phase1-runtime.ts apps/api/scripts/engagement-phase1-qualification-plan.ts',executorSession:83248,exitCode:0,log:'03-focused-verifier-source-types.log'},syntax:commands,
 actualVerifierRun:false,applicationBuildOrSuite:false,packageManagerOrInstall:false,nativeDatabaseProviderAWSOrCredentials:false,fullWindowsWeaknessRetained:true,nativeWindowsAcceptance:false},null,2)+'\n');
function list(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{const p=path.join(dir,e.name);assert(!e.isSymbolicLink());return e.isDirectory()?list(p):[p];});}
const packet=list(root).filter(p=>p!==root+'/SHA256-INDEX.json').sort().map(p=>{const b=fs.readFileSync(p);return{path:p,bytes:b.length,sha256:sha(b)};});
fs.writeFileSync(root+'/SHA256-INDEX.json',JSON.stringify({source,sourceTree:git('rev-parse',source+'^{tree}'),packet,sourceEntries},null,2)+'\n');
console.log(JSON.stringify({result:'PASS source and packet freeze',sourceFiles:sourceEntries.length,packetFiles:packet.length}));
