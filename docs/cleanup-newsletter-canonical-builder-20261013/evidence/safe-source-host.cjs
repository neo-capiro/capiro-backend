'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const forbidden=p=>typeof p==='string'&&p.replaceAll('\\','/').endsWith('/apps/api/src/engagement/engagement.service.ts');
for(const name of ['readFileSync','readFile']){const old=fs[name];fs[name]=function(file,...args){if(forbidden(path.resolve(String(file))))throw new Error('Protected reporting source read refused');return old.call(this,file,...args);};}
const oldRead=fs.promises.readFile;
fs.promises.readFile=function(file,...args){if(forbidden(path.resolve(String(file))))throw new Error('Protected reporting source read refused');return oldRead.call(this,file,...args);};
const allowed=cp.execFileSync;
const shellSpawn=cp.spawnSync;
cp.execFileSync=function(command,args,options){
 if(command!=='git'||!Array.isArray(args)||args.length!==2||args[0]!=='show'||!/^[a-f0-9]{40}:[A-Za-z0-9._/-]+$/.test(args[1])||args[1].endsWith(':apps/api/src/engagement/engagement.service.ts'))throw new Error('Only pinned read-only Git source inputs permitted');
 return allowed.call(this,command,args,options);
};
const refuse=()=>{throw new Error('Real external/child/native port refused by independent source host');};
for(const name of ['spawn','spawnSync','exec','execSync','execFile','fork'])cp[name]=refuse;
for(const [name,methods]of[['node:net',['connect','createConnection','createServer']],['node:tls',['connect','createServer']],['node:http',['request','get','createServer']],['node:https',['request','get','createServer']],['node:dgram',['createSocket']]])for(const method of methods)require(name)[method]=refuse;
const dns=require('node:dns');for(const name of Object.keys(dns))if(typeof dns[name]==='function')dns[name]=refuse;for(const name of Object.keys(dns.promises))if(typeof dns.promises[name]==='function')dns.promises[name]=refuse;
globalThis.fetch=refuse;
require('node:module').syncBuiltinESMExports();

// Exact harmless canonical-operator controls only; no default --run or other child.
cp.spawnSync=function(command,args,options){
 const entry='/workspace/cleanup-newsletter-canonical-builder-20261013/scripts/build-newsletter-release.sh';
 const suffix=Array.isArray(args)?args.slice(1):[];
 const simple=suffix.length===0||(suffix.length===1&&suffix[0]==='--help');
 const guarded=suffix[0]==='--node-bin'&&suffix[1]===process.execPath&&
   ((suffix.length===3&&suffix[2]==='--unknown')||(suffix.length===27&&suffix[2]==='--plan'));
 if(command!=='/bin/sh'||!Array.isArray(args)||args[0]!==entry||(!simple&&!guarded))return refuse();
 return shellSpawn.call(this,command,args,options);
};
require('node:module').syncBuiltinESMExports();
