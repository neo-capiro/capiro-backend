'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),cp=require('node:child_process');
const ts=require('/workspace/capirov2/node_modules/typescript');
const root=path.resolve(__dirname,'../../..'),packet='docs/cleanup-native-prisma-owner-qualification-20261012';
const source='51cc812e0c371c170562bd6bb7711e50764af7cf',evidence='f4ed98ad00c1c9d29178f87aa24ea498c92d8466',old='ec6b3ba9cdf1d0fe6b0912005f5aab35a70e9992';
const git=(...a)=>cp.execFileSync('git',a,{cwd:root,maxBuffer:16*1024*1024});
const blob=(h,f)=>git('show',`${h}:${f}`),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const json=(h,f)=>JSON.parse(blob(h,`${packet}/${f}`));
const input=JSON.parse(fs.readFileSync(path.join(__dirname,'same-four-replay.json')));
const before=JSON.parse(blob('b316890f617f7f3daf1a9bb86cf55d93ae295e47','docs/cleanup-native-prisma-independent-review-20261012/evidence/artifact-manifest-probe.json'));
assert.deepEqual(input.cases.map(x=>x.name),before.cases.map(x=>x.name));
assert.deepEqual(input.cases.map(x=>x.accepted),[true,false,false,false]);
assert.deepEqual(input.cases.map(x=>x.artifactReads),[12,0,0,0]);
assert(input.cases.every(x=>x.driverLoaded===false&&x.sqlExecuted===false));
// Verify the actual four input expressions are byte-identical to the original.
function corpus(text){const ast=ts.createSourceFile('probe.cjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);let expression;function visit(n){if(ts.isForOfStatement(n)){assert(!expression);expression=n.expression.getText(ast);}ts.forEachChild(n,visit);}visit(ast);return expression;}
const originalProgram=blob('b316890f617f7f3daf1a9bb86cf55d93ae295e47','docs/cleanup-native-prisma-independent-review-20261012/evidence/probe-artifact-manifest.cjs').toString();
const replayProgram=fs.readFileSync(path.join(__dirname,'same-four-replay.cjs'),'utf8');assert.equal(corpus(originalProgram),corpus(replayProgram));
let expectedProgram=originalProgram.replace('__dirname: p, URL, process:','__dirname: p, URL, Buffer, process:').replace('return { CORE_CLIENT: actual.clients[0].path,',"return { ROOT: path.resolve(__dirname, '../../..'), CORE_CLIENT: actual.clients[0].path,").replace("source: 'ee9499c5771038f6abf5972ab13d3c20ca65b0cf'",`source: '${source}'`).replace('Validator verifies declared entries but relies on complete immutable manifest; mutation cases are not the manifest used in sealed native execution.','Source-only replay of unchanged four inputs against complete inventory guard; no native replay.').replace("'artifact-manifest-probe.json'","'same-four-replay.json'");assert.equal(replayProgram,expectedProgram);
const sourcePaths=git('diff','--name-only',old,source).toString().trim().split('\n');
assert.deepEqual(sourcePaths,[`${packet}/ARTIFACT-GUARD-CORRECTION.md`,`${packet}/artifact-guard.spec.cjs`,`${packet}/native-prisma-owner-harness.cjs`]);
const later=git('diff','--name-only',source,evidence).toString().trim().split('\n');assert(later.every(f=>f.startsWith(packet+'/')&&!sourcePaths.includes(f)));
const index=json(evidence,'SHA256SUMS-ARTIFACT-GUARD.json');
for(const r of index.entries){const b=blob(evidence,`${packet}/${r.path}`);assert.equal(b.length,r.bytes);assert.equal(sha(b),r.sha256);}
function nativeCases(h){const text=blob(h,`${packet}/native-prisma-owner-harness.cjs`).toString();const ast=ts.createSourceFile('harness.cjs',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);const rows=[];function visit(n){if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text==='record')rows.push({name:n.arguments[0].text,callback:n.arguments[1].getText(ast)});ts.forEachChild(n,visit);}visit(ast);return rows;}
const current=nativeCases(source);assert.equal(current.length,6);assert.deepEqual(current,nativeCases(old));
const oldIndex=json(old,'SHA256SUMS.json');let retained=0;
for(const r of oldIndex.entries){const b=blob(old,`${packet}/${r.path}`);assert.equal(sha(b),r.sha256);if(r.path!=='native-prisma-owner-harness.cjs'){assert.deepEqual(b,blob(evidence,`${packet}/${r.path}`));retained++;}}
const oldPg='docs/cleanup-native-contract-prerequisites-20261012';const oldPgIndex=JSON.parse(blob('3c28ed933722ce896d6ba421236219001bea9ae5',`${oldPg}/SHA256SUMS-NATIVE-PG.json`));
for(const r of oldPgIndex.entries)assert.deepEqual(blob(evidence,`${oldPg}/${r.path}`),blob('3c28ed933722ce896d6ba421236219001bea9ae5',`${oldPg}/${r.path}`));
const scope=json(evidence,'evidence/ARTIFACT-GUARD-FINAL-RECEIPT.json');
const state={acceptedSource:source,sourceTree:git('rev-parse',`${source}^{tree}`).toString().trim(),authorEvidence:evidence,authorTree:git('rev-parse',`${evidence}^{tree}`).toString().trim(),sealedNativeSource:'ee9499c5771038f6abf5972ab13d3c20ca65b0cf',sealedNativeEvidence:old,independentSameFourPassed:4,unchangedInputCorpus:true,hostAdditionsOnly:['ROOT repository path','Buffer Node global'],accepted:[true,false,false,false],artifactAndSchemaReads:[12,0,0,0],sourcePaths,productionDelta:0,otherRuntimeDelta:0,sixNativeCaseBodiesByteExact:true,currentAuthorHashBindingsVerified:index.entries.length,originalNative18EntriesByteExact:retained,originalNative19BindingsVerified:oldIndex.entries.length,originalPg32EntriesExact:oldPgIndex.entries.length,sourceOwnerOrDriverExecuted:false,nativeSqlOrClientExecuted:false,nativeReplay:false,authorFinalReceiptHash:sha(blob(evidence,`${packet}/evidence/ARTIFACT-GUARD-FINAL-RECEIPT.json`)),sealedSixNativeResultCarriedSeparately:true};
assert.equal(retained,18);assert.equal(oldIndex.entries.length,19);assert.equal(oldPgIndex.entries.length,32);
fs.writeFileSync(path.join(__dirname,'ACCEPTANCE-AND-SOURCE.json'),JSON.stringify(state,null,2)+'\n');
console.log(JSON.stringify({sameFourPassed:4,reads:state.artifactAndSchemaReads,sourcePaths:sourcePaths.length,authorHashes:index.entries.length,nativeCaseBodiesExact:6,productionDelta:0,sqlExecuted:false}));
