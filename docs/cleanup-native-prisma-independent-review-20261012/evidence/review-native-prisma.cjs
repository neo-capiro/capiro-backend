'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict'),crypto=require('node:crypto'),cp=require('node:child_process');
const ts=require('/workspace/capirov2/node_modules/typescript');
const root=path.resolve(__dirname,'../../..');
const packet='docs/cleanup-native-prisma-owner-qualification-20261012';
const pin='ec6b3ba9cdf1d0fe6b0912005f5aab35a70e9992',source='ee9499c5771038f6abf5972ab13d3c20ca65b0cf',product='277053c8196dc1be4789c42ea304b0de0553fe00';
const git=(...args)=>cp.execFileSync('git',args,{cwd:root,maxBuffer:16*1024*1024});
const blob=(file,head=pin)=>git('show',`${head}:${file}`);
const text=(file)=>blob(`${packet}/${file}`).toString();
const json=(file)=>JSON.parse(text(file));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const index=json('SHA256SUMS.json');
for(const row of index.entries){const b=blob(`${packet}/${row.path}`);assert.equal(b.length,row.bytes);assert.equal(sha(b),row.sha256);}
const bindings=json('source-bindings.json');assert.equal(bindings.entries.length,60);assert.equal(bindings.sourceHead,product);
for(const row of bindings.entries){assert(!row.path.endsWith('/engagement.service.ts'));const b=blob(row.path,product);assert.equal(b.length,row.bytes);assert.equal(sha(b),row.sha256);assert.equal(git('rev-parse',`${product}:${row.path}`).toString().trim(),row.gitBlob);assert.equal(git('rev-parse',`HEAD:${row.path}`).toString().trim(),row.gitBlob);}
const identities=json('ENGINE-CLIENT-IDENTITIES.json');assert.equal(identities.clients.length,2);
const cache='/tmp/capirov2-local-native-prerequisite-20261012';
const expectedClients=[`${cache}/core-client`,`${cache}/workspace-client`];
const artifactNames=['package.json','index.js','runtime/library.js','schema.prisma','libquery_engine-debian-openssl-3.0.x.so.node'];
const artifactRows=[];
for(let i=0;i<2;i++){
 const client=identities.clients[i];assert.equal(client.path,expectedClients[i]);assert.equal(client.version,'5.22.0');
 assert.equal(client.artifacts.length,5);assert.deepEqual(client.artifacts.map(r=>path.relative(client.path,r.path)),artifactNames);
 for(const r of client.artifacts){const b=fs.readFileSync(r.path);assert.equal(b.length,r.bytes);assert.equal(sha(b),r.sha256);artifactRows.push(r);}
 assert.deepEqual(fs.readFileSync(path.join(client.path,'schema.prisma')),blob(client.schemaSource,product));
 const generated=fs.readFileSync(path.join(client.path,'index.js'),'utf8');assert(generated.includes('"rootEnvPath": null'));assert(generated.includes('"clientVersion": "5.22.0"'));
}
assert.equal(artifactRows[4].sha256,'35860a5c0fb2f79e7b38c40747c4d212318d97e1910ca528b133c802716de0b8');assert.equal(artifactRows[4].sha256,artifactRows[9].sha256);
const old='docs/cleanup-native-contract-prerequisites-20261012',oldIndex=JSON.parse(blob(`${old}/SHA256SUMS-NATIVE-PG.json`,'3c28ed933722ce896d6ba421236219001bea9ae5'));
for(const row of oldIndex.entries)assert.deepEqual(blob(`${old}/${row.path}`),blob(`${old}/${row.path}`,'3c28ed933722ce896d6ba421236219001bea9ae5'));
const harnessFiles=['native-prisma-owner-harness.cjs','canonical-native-loader.cjs','fixture-assembly.cjs','parent-fixture.sql','source-bindings.json','ENGINE-CLIENT-IDENTITIES.json','PLAN.md'];
for(const f of harnessFiles)assert.deepEqual(blob(`${packet}/${f}`),blob(`${packet}/${f}`,source));
const harness=text('native-prisma-owner-harness.cjs');
const ast=ts.createSourceFile('harness.cjs',harness,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);assert.equal(ast.parseDiagnostics.length,0);
const declarations=new Map(),vars=new Map(),records=[];let expectSql;
function visit(n){if(ts.isFunctionDeclaration(n)&&n.name)declarations.set(n.name.text,n);if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name))vars.set(n.name.text,n);if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text==='record'){assert(ts.isStringLiteral(n.arguments[0]));records.push(n.arguments[0].text);}ts.forEachChild(n,visit);}
visit(ast);assert.equal(records.length,6);expectSql=declarations.get('expectSQL');
const native=json('evidence/native-prisma-attempt-0.json'),receipt=json('evidence/ACCEPTANCE-RECEIPT.json'),command=json('evidence/01-native-prisma-attempt-0.json');
assert.deepEqual(native.results.map(r=>r.name),records);assert(native.results.every(r=>r.status==='PASS'));assert.equal(native.passed,6);assert.equal(native.failed,0);
assert.deepEqual(receipt.results,native.results);assert.deepEqual(receipt.artifacts,identities);assert.equal(command.exitCode,0);assert.equal(command.sourceHead,source);
assert.deepEqual(text('evidence/01-native-prisma-attempt-0.stdout.log').trim().split('\n'),records.map(n=>`PASS ${n}`));assert.equal(text('evidence/01-native-prisma-attempt-0.stderr.log'),'');
assert.deepEqual(command.launcherEnvKeys,['PATH','LANG','TZ']);assert.deepEqual(command.childAddedControlledEnv,['PRISMA_QUERY_ENGINE_LIBRARY']);
for(const k of ['nativePrisma','corePrismaServiceActual'])assert.equal(native[k],true);
for(const k of ['workspacePrismaServiceBootstrap','fullMigrationReplay','productionHardening'])assert.equal(native[k],false);
const cleanup=json('evidence/AFTER-CLEANUP-TARGET.json');assert(cleanup.cleanupVerified);assert.equal(cleanup.publicTables,0);for(const k of ['ownedSchemaRemaining','ownedRolesRemaining','otherHarnessSessions'])assert.deepEqual(cleanup[k],[]);
for(const k of ['dataDirectory','listenAddresses','inetServerAddr','user','database','systemIdentifier'])assert.equal(cleanup.target[k],native.target[k]);
const cleanupAst=ts.createSourceFile('cleanup.cjs',text('evidence/after-cleanup-probe.cjs'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);const cleanupSql=[];
function collectSql(n){if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='query'){assert(ts.isStringLiteral(n.arguments[0])||ts.isNoSubstitutionTemplateLiteral(n.arguments[0]));cleanupSql.push(n.arguments[0].text);}ts.forEachChild(n,collectSql);}collectSql(cleanupAst);assert.equal(cleanupSql.length,5);assert(cleanupSql.every(s=>s.startsWith('SELECT ')));
const outcomes=[],passed=name=>outcomes.push({name,status:'PASS'});
const body=names=>names.map(n=>declarations.get(n).getText(ast)).join('\n');
const guardFactory=new Function('assert','TARGET','SCHEMA','APP','OWNER','targetSQL',`${body(['sameTarget','nativeGuard'])}; return nativeGuard;`);
const schema=native.schema,app='capiro_app',owner='capiro_native_prisma_owner_20261012';
const targetSql=vars.get('targetSQL').initializer.text;
const role={name:app,rolsuper:false,rolbypassrls:false,rolinherit:false,rolcanlogin:false,owner_member:false};
const guard=guardFactory(assert,native.target,schema,app,owner,targetSql);
async function guardCase(name,targetRow=native.target,schemaRow=schema,roleRow=role,refused=false){
 const events=[];const tx={
  $queryRawUnsafe:async sql=>{events.push({kind:'query',sql});return sql===targetSql?[targetRow]:sql.includes('current_schema')?[{schema:schemaRow}]:[roleRow];},
  $executeRawUnsafe:async sql=>{events.push({kind:'execute',sql});},
  $executeRaw:async(strings,...values)=>{events.push({kind:'tag',sql:strings.join('?'),values});},
 };
 if(refused)await assert.rejects(()=>guard(tx,'tenant-synthetic','actor-synthetic'));else await guard(tx,'tenant-synthetic','actor-synthetic');
 if(targetRow!==native.target)assert.equal(events.length,1);
 else if(schemaRow!==schema)assert.equal(events.length,2);
 else if(!refused){assert.equal(events[0].sql,targetSql);assert(events[1].sql.includes('current_schema'));assert.equal(events[2].sql,`SET LOCAL ROLE ${app}`);assert.deepEqual(events[4].values,['tenant-synthetic','actor-synthetic']);}
 passed(name);
}
const fakeFs={readFileSync:file=>fs.readFileSync(file),existsSync:()=>false};let imported=0,ownersLoaded=0,bindingsRead=0;
const exported={exports:{}};
vm.runInNewContext(harness,{module:exported,exports:exported.exports,__dirname:path.join(root,packet),URL,process:{argv:[],env:{}},console:{log(){},error(){}},require:n=>{
 if(n==='node:fs')return fakeFs;if(n==='node:path')return path;if(n==='node:assert/strict')return assert;if(n==='node:crypto')return crypto;
 if(n.includes('native-contract-harness'))return{TARGET:native.target,validateTarget(){throw new Error('Own native execution refused');}};
 if(n==='./canonical-native-loader.cjs')return{CORE_CLIENT:expectedClients[0],apiRequire(){imported++;throw new Error('Driver/client refused');},loadCanonical(){ownersLoaded++;throw new Error('Owners refused');},verifyBindings(){bindingsRead++;throw new Error('Native execution refused');}};
 if(n==='./fixture-assembly.cjs')return{assembleFixture(){throw new Error('SQL fixture refused');}};
 throw new Error('Unexpected import');
}},{filename:'frozen-native-prisma-owner-harness.cjs'});
const h=exported.exports;
async function main(){
 h.verifyArtifacts();passed('all10 fixed manifest artifacts accepted with no imports');
 const original=fakeFs.readFileSync;
 fakeFs.readFileSync=file=>file===artifactRows[4].path?Buffer.from('corrupt inert bytes'):original(file);
 assert.throws(()=>h.verifyArtifacts());passed('changed pinned native engine bytes refused');fakeFs.readFileSync=original;
 fakeFs.readFileSync=file=>file===artifactRows[1].path?Buffer.from('corrupt inert bytes'):original(file);
 assert.throws(()=>h.verifyArtifacts());passed('changed pinned Core generated client bytes refused');fakeFs.readFileSync=original;
 for(const [label,limit]of[['core',2],['workspace',1]]){const url=new URL(h.connectionUrl(label,limit));assert.equal(url.username,native.target.user);assert.equal(url.password,'');assert.equal(url.hostname,'localhost');assert.equal(url.searchParams.get('host'),native.target.socketDirectory);assert.equal(url.searchParams.get('schema'),schema);assert.equal(url.searchParams.get('connection_limit'),String(limit));assert.equal(url.searchParams.get('sslmode'),'disable');assert.equal(url.searchParams.get('socket_timeout'),'12');passed(`fixed passwordless socket URL/${label}`);}
 for(const args of[[],['--help'],['--unknown'],['--run'],['--run','--run'],['--plan','--run'],['--run','--verified-target','unused','--output','/tmp/foreign.json']]){await assert.rejects(()=>h.main(args));passed(`CLI preflight refusal: ${JSON.stringify(args)}`);}
 fakeFs.existsSync=()=>true;await assert.rejects(()=>h.main(['--run','--verified-target','unused','--output',path.join(root,packet,'evidence/existing.json')]));passed('existing evidence output refused');
 assert.equal(imported,0);assert.equal(ownersLoaded,0);assert.equal(bindingsRead,0);
 await guardCase('native guard canonical exact ordered target/schema/role/GUC checks');
 for(const key of['dataDirectory','listenAddresses','inetServerAddr','user','database','systemIdentifier'])await guardCase(`native target ${key} mismatch refuses before role/owner writes`,{...native.target,[key]:'foreign'},schema,role,true);
 await guardCase('native schema mismatch refuses before role/owner writes',native.target,'foreign',role,true);
 for(const key of['rolsuper','rolbypassrls','rolinherit','rolcanlogin','owner_member'])await guardCase(`synthetic role unsafe ${key} refused`,native.target,schema,{...role,[key]:true},true);
 const expectSQL=new Function('assert',`${expectSql.getText(ast)}; return expectSQL;`)(assert);
 for(const code of['42501','23514']){const exact={code:'P2010',meta:{code}};await expectSQL(async()=>{throw exact;},code);passed(`exact P2010/meta.${code} accepted`);for(const wrong of[{code:'P2010',meta:{code:'99999'}},{code,meta:{code}},{code:'P2010',meta:{}},new Error(code)]){await assert.rejects(()=>expectSQL(async()=>{throw wrong;},code));passed(`wrong P2010/SQLSTATE combination refused for${code}`);}}
 // Exact facade arrows preserve callback/transaction/options and per-call context.
 const scopedText=vars.get('scoped').initializer.getText(ast),facadeText=vars.get('facade').initializer.getText(ast);
 const trace=[];const fakeCore={withTenantUser:async(t,u,callback,o)=>{const tx={t,u};trace.push(['core',t,u,o]);return callback(tx);},$transaction:async(callback,o)=>{const tx={global:true};trace.push(['global',o]);return callback(tx);}};
 const fakeGuard=async(tx,t,u)=>trace.push(['guard',tx,t,u]);
 const facade=new Function('core','nativeGuard',`const scoped=${scopedText};return (${facadeText});`)(fakeCore,fakeGuard);
 const opts={timeoutMs:123};let observed;
 const result=await facade.withTenantUser('A','actorA',async tx=>{observed=tx;trace.push(['owner',tx]);return 7;},opts);assert.equal(result,7);assert.equal(trace[0][3],opts);assert.equal(trace[1][1],observed);assert.equal(trace[2][1],observed);passed('scoped facade forwards exact tx/options and guards before owner callback');
 const values=await Promise.all(['A','B'].map(t=>facade.withTenantUser(t,`actor${t}`,async tx=>`${tx.t}/${tx.u}`)));assert.deepEqual(values,['A/actorA','B/actorB']);passed('facade concurrent per-call actor contexts remain separate');
 const error=new Error('same callback failure');await assert.rejects(()=>facade.withTenantUser('A','actorA',async()=>{throw error;}),e=>e===error);passed('facade preserves callback failure identity');
 const globalOptions={isolationLevel:'RepeatableRead'};await facade.$transaction(async tx=>assert.equal(tx.global,true),globalOptions);assert(trace.some(r=>r[0]==='global'&&r[1]===globalOptions));passed('calendar facade forwards actual RepeatableRead options unchanged');
 const output={sourceHarness:source,sourceHarnessTree:git('rev-parse',`${source}^{tree}`).toString().trim(),evidenceHead:pin,evidenceTree:git('rev-parse',`${pin}^{tree}`).toString().trim(),productSource:product,evidenceHashesVerified:index.entries.length,sourceHashesVerified:bindings.entries.length,actualCachedArtifactsVerified:artifactRows.length,engineSha256:artifactRows[4].sha256,schemasByteExact:2,oldNativePG32BindingsExact:true,harnessSevenFilesEqualFrozen:true,nativeGroups:records,reportedNativePassed:6,reportedNativeExitCode:0,cleanupSelectCount:cleanupSql.length,cleanupStateZero:true,controls:outcomes,passed:outcomes.length,failed:0,reviewerDatabaseDriverLoaded:false,reviewerActualClientConstructed:false,reviewerSqlExecuted:false,expectedRealErrorObjectsSeparatelySerialized:false,guardOccursAfterCoreLocalContextGucs:true,manifestCompletenessReliesOnSealedExactInventory:true};
 fs.writeFileSync(path.join(__dirname,'SOURCE-ARTIFACT-RESULT-REVIEW.json'),JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify({passed:outcomes.length,evidenceHashes:index.entries.length,sourceHashes:bindings.entries.length,artifacts:artifactRows.length,nativeGroups:6,reviewerSql:false}));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
