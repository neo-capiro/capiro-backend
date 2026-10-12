'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const vm=require('node:vm');
const {verifyArtifacts,validateArtifactInventory}=require('./native-prisma-owner-harness.cjs');
const {ROOT}=require('./canonical-native-loader.cjs');
const manifestPath=path.join(__dirname,'ENGINE-CLIENT-IDENTITIES.json');
const actual=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
function inertFixture(){
 const manifest=structuredClone(actual);const files=new Map();
 for(const client of manifest.clients){
  for(const artifact of client.artifacts){const b=Buffer.from('inert:'+artifact.path);files.set(artifact.path,b);artifact.bytes=b.length;artifact.sha256=createHash('sha256').update(b).digest('hex');}
  files.set(path.join(ROOT,client.schemaSource),files.get(path.join(client.path,'schema.prisma')));
 }
 const reads=[];
 const read=(name,encoding)=>{reads.push(name);if(name===manifestPath)return JSON.stringify(manifest);const b=files.get(name);assert(b,`Unexpected read:${name}`);return encoding?b.toString(encoding):b;};
 return{manifest,files,reads,read};
}
test('complete ten-artifact inventory accepts and recomputes schema equality',()=>{
 const f=inertFixture();f.manifest.clients[0].schemaByteEquality=false;
 const result=verifyArtifacts(f.read);assert(result.clients.every(c=>c.schemaByteEquality));assert.equal(f.reads.length,13);
});
test('client and artifact ordering does not change finite set completeness',()=>{
 const f=inertFixture();f.manifest.clients.reverse();for(const c of f.manifest.clients)c.artifacts.reverse();assert.equal(verifyArtifacts(f.read).clients.length,2);
});
const faults=[
 ['all clients omitted',m=>{m.clients=[];}],
 ['Core client omitted',m=>{m.clients.splice(0,1);}],
 ['Workspace client omitted',m=>{m.clients.splice(1,1);}],
 ['all artifact inventories omitted',m=>{for(const c of m.clients)c.artifacts=[];}],
 ['Core artifacts omitted',m=>{m.clients[0].artifacts=[];}],
 ['Workspace artifacts omitted',m=>{m.clients[1].artifacts=[];}],
 ['one artifact omitted',m=>{m.clients[0].artifacts.pop();}],
 ['duplicated client root',m=>{m.clients[1]=structuredClone(m.clients[0]);}],
 ['extra client root',m=>{m.clients.push(structuredClone(m.clients[0]));}],
 ['outside client root',m=>{m.clients[1].path='/tmp/outside-client';}],
 ['wrong schema source',m=>{m.clients[1].schemaSource='apps/api/prisma/schema.prisma';}],
 ['outside schema source',m=>{m.clients[0].schemaSource='../../outside.prisma';}],
 ['wrong version',m=>{m.clients[0].version='5.23.0';}],
 ['duplicate artifact',m=>{m.clients[0].artifacts[4]=structuredClone(m.clients[0].artifacts[0]);}],
 ['extra artifact',m=>{m.clients[0].artifacts.push(structuredClone(m.clients[0].artifacts[0]));}],
 ['outside artifact path',m=>{m.clients[0].artifacts[4].path='/tmp/outside.node';}],
 ['traversal artifact path',m=>{m.clients[0].artifacts[4].path=m.clients[0].path+'/../outside.node';}],
 ['wrong artifact filename',m=>{m.clients[0].artifacts[4].path=m.clients[0].path+'/query-engine.node';}],
 ['missing client array',m=>{delete m.clients;}],
 ['missing artifact array',m=>{delete m.clients[0].artifacts;}],
 ['invalid byte count',m=>{m.clients[0].artifacts[0].bytes=0;}],
 ['invalid hash',m=>{m.clients[0].artifacts[0].sha256='not-a-hash';}],
 ['wrong source head',m=>{m.productSourceHead='0'.repeat(40);}],
];
for(const [name,mutate]of faults)test(`inventory refuses ${name} before artifact/source reads`,()=>{
 const f=inertFixture();mutate(f.manifest);assert.throws(()=>verifyArtifacts(f.read));assert.deepEqual(f.reads,[manifestPath]);
});
test('malformed second inventory refuses before first client files are read',()=>{const f=inertFixture();f.manifest.clients[1].artifacts[4].path='/tmp/outside.node';assert.throws(()=>verifyArtifacts(f.read));assert.deepEqual(f.reads,[manifestPath]);});
test('cached schema versus bound source mismatch refuses despite claimed equality true',()=>{const f=inertFixture();f.files.set(path.join(ROOT,f.manifest.clients[0].schemaSource),Buffer.from('different source'));assert.throws(()=>verifyArtifacts(f.read),/current bound source/);});
test('actual artifact content hash mismatch refuses',()=>{const f=inertFixture();f.files.set(f.manifest.clients[0].artifacts[1].path,Buffer.from('different artifact'));assert.throws(()=>verifyArtifacts(f.read));});
test('inventory validator itself has no file input dependency',()=>{assert.equal(validateArtifactInventory(structuredClone(actual)).clients.length,2);});
test('guarded CLI plan refuses incomplete inventory before bound-source reads or driver work',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'native-prisma-owner-harness.cjs'),'utf8');
 let sourceReads=0,artifactReads=0,driverCalls=0;const moduleValue={exports:{}};
 const fakeFs={readFileSync(name){if(name===manifestPath)return JSON.stringify({...actual,clients:[]});artifactReads++;throw new Error('Unexpected artifact/source read');}};
 vm.runInNewContext(source,{module:moduleValue,exports:moduleValue.exports,__dirname,URL,Buffer,process:{argv:[],env:{}},require(name){
  if(name==='node:fs')return fakeFs;if(name==='node:path')return path;if(name==='node:assert/strict')return assert;if(name==='node:crypto')return require(name);
  if(name.includes('native-contract-harness'))return{TARGET:{},validateTarget(){throw new Error('No native target');}};
  if(name==='./canonical-native-loader.cjs')return{ROOT,CORE_CLIENT:actual.clients[0].path,verifyBindings(){sourceReads++;throw new Error('Unexpected bound-source read');},apiRequire(){driverCalls++;throw new Error('No driver');},loadCanonical(){throw new Error('No owner');}};
  if(name==='./fixture-assembly.cjs')return{assembleFixture(){throw new Error('No fixture');}};
  throw new Error('Unexpected import');
 }});
 await assert.rejects(()=>moduleValue.exports.main(['--plan']));
 assert.deepEqual({sourceReads,artifactReads,driverCalls},{sourceReads:0,artifactReads:0,driverCalls:0});
});
