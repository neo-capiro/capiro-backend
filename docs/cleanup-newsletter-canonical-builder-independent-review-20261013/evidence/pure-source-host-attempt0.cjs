"use strict";
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const allowedPaths=new Set(['package.json','.github/workflows/ci-pr.yml','pnpm-workspace.yaml']);
const forbidden=p=>/\/apps\/(?:web|onboard-web)\//.test(p)||p.endsWith('/apps/api/src/engagement/engagement.service.ts');
for(const name of ['readFileSync','readFile']){const old=fs[name];fs[name]=function(file,...args){if(forbidden(path.resolve(String(file))))throw new Error('Excluded filesystem source read refused');return old.call(this,file,...args);};}
const oldRead=fs.promises.readFile;fs.promises.readFile=function(file,...args){if(forbidden(path.resolve(String(file))))throw new Error('Excluded filesystem source read refused');return oldRead.call(this,file,...args);};
const oldGit=cp.execFileSync;cp.execFileSync=function(command,args,options){const prefix='5470c6df029c9553dd49e531229c3c91b26275ef:';if(command!=='git'||!Array.isArray(args)||args.length!==2||args[0]!=='show'||!args[1].startsWith(prefix)||!allowedPaths.has(args[1].slice(prefix.length)))throw new Error('Unapproved subprocess/source input refused');return oldGit.call(this,command,args,options);};
const refuse=()=>{throw new Error('Real external/child/native port refused by independent source host');};
for(const name of ['spawn','spawnSync','exec','execSync','execFile','fork'])cp[name]=refuse;
for(const [name,methods]of[['node:net',['connect','createConnection','createServer']],['node:tls',['connect','createServer']],['node:http',['request','get','createServer']],['node:https',['request','get','createServer']],['node:dgram',['createSocket']]])for(const method of methods)require(name)[method]=refuse;
const dns=require('node:dns');for(const name of Object.keys(dns))if(typeof dns[name]==='function')dns[name]=refuse;for(const name of Object.keys(dns.promises))if(typeof dns.promises[name]==='function')dns.promises[name]=refuse;
globalThis.fetch=refuse;require('node:module').syncBuiltinESMExports();
