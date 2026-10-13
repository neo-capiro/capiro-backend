'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');const https=require('node:https');const http=require('node:http');
const net=require('node:net');const dns=require('node:dns');const child=require('node:child_process');
const {audit}=require('./containment-preload.cjs');
const controls=[
  ['protected body read',()=>fs.readFileSync('/workspace/capirov2/apps/api/src/engagement/engagement.service.ts')],
  ['environment body read',()=>fs.readFileSync('/workspace/capirov2/.env')],
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
assert.equal(audit.protectedReadRefusals,2);assert.equal(audit.childRefusals,1);
assert.equal(audit.allowedLoopbackConnections,0);assert.equal(audit.allowedLoopbackListeners,0);
assert.equal(audit.externalRefusals,7);
console.log(JSON.stringify({total:controls.length,passed:controls.length,audit}));
