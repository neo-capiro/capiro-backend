'use strict';
const fs=require('node:fs'),path=require('node:path'),url=require('node:url'),cp=require('node:child_process');
const refuse=()=>{throw new Error('Independent builder source host refuses unapproved effect');};
const all=Object.fromEntries(['node:net','node:tls','node:http','node:https','node:dgram','node:dns'].map(n=>[n,require(n)]));
for(const[n,methods]of[['node:net',['connect','createConnection','createServer']],['node:tls',['connect','createServer']],['node:http',['request','get','createServer']],['node:https',['request','get','createServer']],['node:dgram',['createSocket']]])for(const m of methods)all[n][m]=refuse;
all['node:net'].Server.prototype.listen=refuse;all['node:net'].Socket.prototype.connect=refuse;
for(const n of Object.keys(all['node:dns']))if(/^(?:lookup|resolve|reverse)/.test(n)&&typeof all['node:dns'][n]==='function')all['node:dns'][n]=refuse;
for(const n of Object.keys(all['node:dns'].promises))if(n!=='Resolver'&&typeof all['node:dns'].promises[n]==='function')all['node:dns'].promises[n]=refuse;
globalThis.fetch=refuse;
const allowed=new Set(['apps/web/Dockerfile','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','apps/onboard-api/Dockerfile']);
const oldGit=cp.execFileSync;cp.execFileSync=function(command,args,options){
 const prefix='523ef9167f05a33efdbdfbbfc08d5fc2e2679012:';
 if(command!=='git'||!Array.isArray(args)||args.length!==2||args[0]!=='show'||!args[1].startsWith(prefix)||!allowed.has(args[1].slice(prefix.length)))refuse();
 return oldGit.call(this,command,args,options);
};
const oldSpawn=cp.spawnSync;cp.spawnSync=function(command,args,options){
 const shell=path.resolve('scripts/build-newsletter-release.sh');
 if(command!=='/bin/sh'||!Array.isArray(args)||args[0]!==shell)refuse();
 const tail=args.slice(1);
 if(!(tail.length===0||(tail.length===1&&tail[0]==='--help')||(tail.length===3&&tail[0]==='--node-bin'&&tail[1]===process.execPath&&tail[2]==='--unknown')||(tail.length===27&&tail[0]==='--node-bin'&&tail[1]===process.execPath&&tail[2]==='--plan')))refuse();
 return oldSpawn.call(this,command,args,options);
};
for(const n of ['spawn','exec','execSync','execFile','fork'])cp[n]=refuse;
const forbidden=value=>{
 if(value instanceof URL)value=url.fileURLToPath(value);
 if(Buffer.isBuffer(value))value=value.toString();
 return typeof value==='string'&&/(?:^|\/)apps\/api\/src\/engagement\/engagement\.service\.ts$/.test(value);
};
for(const n of ['readFileSync','readFile','openSync','open','createReadStream']){const old=fs[n];fs[n]=function(file,...args){if(forbidden(file))refuse();return old.call(this,file,...args);};}
for(const n of ['readFile','open']){const old=fs.promises[n];fs.promises[n]=function(file,...args){if(forbidden(file))refuse();return old.call(this,file,...args);};}
require('node:module').syncBuiltinESMExports();
