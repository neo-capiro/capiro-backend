const assert=require('node:assert/strict');
const rows=[
 ['HTTP',()=>require('node:http').request('http://invalid.invalid')],
 ['HTTPS',()=>require('node:https').get('https://invalid.invalid')],
 ['TCP',()=>require('node:net').connect(443,'invalid.invalid')],
 ['listen',()=>new (require('node:net').Server)().listen(0)],
 ['DNS',()=>require('node:dns').lookup('invalid.invalid',()=>{})],
 ['child',()=>require('node:child_process').spawn('/bin/false')],
 ['fetch',()=>globalThis.fetch('https://invalid.invalid')],
 ['protected source',()=>require('node:fs').readFileSync('/workspace/capirov2/apps/api/src/engagement/engagement.service.ts')],
];
for(const[name,fn]of rows)assert.throws(fn,/Independent inert header review refuses external effect/,name);
console.log(JSON.stringify({passed:rows.length,names:rows.map(r=>r[0]),realEffectsPerformed:false}));
