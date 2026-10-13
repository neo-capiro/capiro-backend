'use strict';
const fs=require('node:fs'),path=require('node:path'),url=require('node:url'),cp=require('node:child_process');
const deny=()=>{throw new Error('Independent accepted-source profile host refuses unapproved effect');};
const owners=Object.fromEntries(['node:net','node:http','node:https','node:tls','node:dgram','node:dns'].map(n=>[n,require(n)]));
for(const[n,keys]of[['node:net',['connect','createConnection','createServer']],['node:http',['request','get','createServer']],['node:https',['request','get','createServer']],['node:tls',['connect','createServer']],['node:dgram',['createSocket']]])for(const key of keys)owners[n][key]=deny;
owners['node:net'].Server.prototype.listen=deny;owners['node:net'].Socket.prototype.connect=deny;
for(const key of Object.keys(owners['node:dns']))if(/^(?:lookup|resolve|reverse)/.test(key)&&typeof owners['node:dns'][key]==='function')owners['node:dns'][key]=deny;
for(const key of Object.keys(owners['node:dns'].promises))if(key!=='Resolver'&&typeof owners['node:dns'].promises[key]==='function')owners['node:dns'].promises[key]=deny;
globalThis.fetch=deny;
const git=cp.execFileSync;cp.execFileSync=function(command,args,options){
 const prefix='523ef9167f05a33efdbdfbbfc08d5fc2e2679012:';
 if(command!=='git'||!Array.isArray(args)||args.length!==2||args[0]!=='show'||!args[1].startsWith(prefix)||!['apps/web/Dockerfile','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','apps/onboard-api/Dockerfile'].includes(args[1].slice(prefix.length)))deny();
 return git.call(this,command,args,options);
};
const spawn=cp.spawnSync;cp.spawnSync=function(command,args,options){
 const shell=path.resolve('scripts/build-newsletter-release.sh');
 if(command==='/bin/sh'&&Array.isArray(args)&&args[0]===shell){
  const tail=args.slice(1);
  if(tail.length===0||(tail.length===1&&tail[0]==='--help')||(tail.length===3&&tail[0]==='--node-bin'&&tail[1]===process.execPath&&tail[2]==='--unknown')||(tail.length===27&&tail[0]==='--node-bin'&&tail[1]===process.execPath&&tail[2]==='--plan'))return spawn.call(this,command,args,options);
 }
 if(command===process.execPath&&Array.isArray(args)&&['frontend-standalone-artifact-contract.mjs','newsletter-artifact-packaging-plan.mjs'].some(name=>args[0]===path.resolve('scripts/lib/'+name)))return spawn.call(this,command,args,options);
 deny();
};
for(const n of ['spawn','exec','execSync','execFile','fork'])cp[n]=deny;
function forbidden(value){if(value instanceof URL)value=url.fileURLToPath(value);if(Buffer.isBuffer(value))value=value.toString();return typeof value==='string'&&/(?:^|\/)apps\/api\/src\/engagement\/engagement\.service\.ts$/.test(value);}
for(const n of ['readFileSync','readFile','openSync','open','createReadStream']){const old=fs[n];fs[n]=function(p,...args){if(forbidden(p))deny();return old.call(this,p,...args);};}
for(const n of ['readFile','open']){const old=fs.promises[n];fs.promises[n]=function(p,...args){if(forbidden(p))deny();return old.call(this,p,...args);};}
require('node:module').syncBuiltinESMExports();
