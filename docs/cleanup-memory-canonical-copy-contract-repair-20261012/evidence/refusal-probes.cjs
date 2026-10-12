require('./strict-web-read-refusal.cjs');
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const root=path.resolve(__dirname,'../../..');
const probes=[
 ['protected unselected source',()=>fs.readFileSync(path.join(root,'apps/api/src/engagement/engagement.service.ts'),'utf8')],
 ['Web source',()=>fs.readFileSync(path.join(root,'apps/web/src/components/MemoryFileEditor.tsx'),'utf8')],
 ['network socket',()=>require('node:net').connect({host:'invalid.test',port:1})],
 ['DNS lookup',()=>require('node:dns').lookup('invalid.test',()=>{})],
 ['fetch',()=>fetch('https://invalid.test')],
 ['child process',()=>require('node:child_process').spawn('must-not-run')],
];
for(const [name,run]of probes)assert.throws(run,/refused/,name);
console.log(JSON.stringify({probes:probes.map(([name])=>({name,refusedBeforeAction:true})),count:probes.length,actualProtectedOrWebBytesRead:false,actualNetworkOrChildCreated:false},null,2));
