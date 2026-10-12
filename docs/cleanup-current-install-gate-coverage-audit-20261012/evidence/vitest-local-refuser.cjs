const fs=require('node:fs');const path=require('node:path');const {syncBuiltinESMExports}=require('node:module');
const root='/tmp/capiro-vitest-v8-toolchain-277-20261012';const log=path.join(root,'operation-receipts.jsonl');
const record=x=>fs.appendFileSync(log,JSON.stringify({pid:process.pid,...x})+'\n');
const refuse=operation=>(..._args)=>{record({operation,allowed:false});throw Error('Refused outbound/unbounded operation: '+operation);};
for(const [mod,names] of [['node:http',['get','request']],['node:https',['get','request']],['node:net',['connect','createConnection']],['node:tls',['connect']],['node:dgram',['createSocket']],['node:dns',['lookup','resolve','resolve4','resolve6','reverse']]])for(const k of names)require(mod)[k]=refuse(mod+'.'+k);
require('node:net').Socket.prototype.connect=refuse('net.Socket.connect');require('node:net').Server.prototype.listen=refuse('net.Server.listen');globalThis.fetch=refuse('global.fetch');
const cp=require('node:child_process');for(const k of ['exec','execFile','execFileSync','execSync','spawn','spawnSync','fork']){
 const original=cp[k];cp[k]=function(command,...rest){
  let allowed=false;
  if(k==='execSync')allowed=['cat /proc/cpuinfo | grep "physical id" | sort |uniq | wc -l','cat /proc/cpuinfo | grep "core id" | sort | uniq | wc -l'].includes(command);
  if(k==='spawn')allowed=command==='/workspace/capirov2/node_modules/.pnpm/@esbuild+linux-x64@0.21.5/node_modules/@esbuild/linux-x64/bin/esbuild';
  if(k==='fork')allowed=command==='/workspace/capirov2/node_modules/.pnpm/tinypool@1.1.1/node_modules/tinypool/dist/entry/process.js';
  record({operation:'child_process.'+k,command,allowed});if(!allowed)throw Error('Refused child process '+k+': '+command);
  return original.call(this,command,...rest);
 };
}
syncBuiltinESMExports();
record({operation:'refuser-installed',allowed:true,fixtureRoot:root});
