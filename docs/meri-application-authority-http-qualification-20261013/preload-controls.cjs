'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');const https=require('node:https');const http=require('node:http');
const net=require('node:net');const dns=require('node:dns');const child=require('node:child_process');
const {audit}=require('./containment-preload.cjs');
const controls=[
  ['protected body read',()=>fs.readFileSync('/workspace/capirov2/apps/api/src/engagement/engagement.service.ts')],
  ['environment body read',()=>fs.readFileSync('/workspace/capirov2/.env')],
  ['protected body stream',()=>fs.createReadStream('/workspace/capirov2/apps/api/src/engagement/engagement.service.ts')],
  ['HTTPS request',()=>https.request('https://foreign.invalid')],
  ['HTTP foreign request',()=>http.request('http://foreign.invalid')],
  ['DNS lookup',()=>dns.lookup('foreign.invalid',()=>{})],
  ['foreign socket',()=>new net.Socket().connect({host:'foreign.invalid',port:443})],
  ['unapproved loopback port',()=>new net.Socket().connect({host:'127.0.0.1',port:12345})],
  ['external listener',()=>new net.Server().listen(0,'0.0.0.0')],
  ['fixed listener',()=>new net.Server().listen(3000,'127.0.0.1')],
  ['child process',()=>child.execFileSync('node',['--version'])],
];
for(const [name,operation] of controls){assert.throws(operation);console.log(`PASS ${name}`);}
assert.equal(audit.protectedReadRefusals,3);assert.equal(audit.childRefusals,1);
assert.equal(audit.allowedLoopbackConnections,0);assert.equal(audit.allowedLoopbackListeners,0);
assert.equal(audit.externalRefusals,7);
(async()=>{
  await assert.rejects(()=>fs.promises.open('/workspace/capirov2/apps/api/src/engagement/engagement.service.ts'));
  const callbackResult=await new Promise((resolve,reject)=>dns.lookup('127.0.0.1',(error,address,family)=>error?reject(error):resolve({address,family})));
  assert.deepEqual(callbackResult,{address:'127.0.0.1',family:4});
  assert.deepEqual(await dns.promises.lookup('127.0.0.1',{all:true}),[{address:'127.0.0.1',family:4}]);
  assert.equal(audit.protectedReadRefusals,4);assert.equal(audit.literalLoopbackLookups,2);
  console.log('PASS protected async open');console.log('PASS exact literal callback lookup');console.log('PASS exact literal promise lookup');
  console.log(JSON.stringify({total:controls.length+3,passed:controls.length+3,audit}));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
