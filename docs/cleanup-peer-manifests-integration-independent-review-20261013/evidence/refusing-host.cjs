'use strict';
const fs=require('node:fs'),path=require('node:path'),url=require('node:url'),cp=require('node:child_process');
const deny=()=>{throw new Error('Independent peer review refuses unapproved effect');};
const owners=Object.fromEntries(['node:net','node:http','node:https','node:tls','node:dgram','node:dns'].map(n=>[n,require(n)]));
for(const[n,keys]of[['node:net',['connect','createConnection','createServer']],['node:http',['request','get','createServer']],['node:https',['request','get','createServer']],['node:tls',['connect','createServer']],['node:dgram',['createSocket']]])for(const key of keys)owners[n][key]=deny;
owners['node:net'].Server.prototype.listen=deny;owners['node:net'].Socket.prototype.connect=deny;
for(const key of Object.keys(owners['node:dns']))if(/^(?:lookup|resolve|reverse)/.test(key)&&typeof owners['node:dns'][key]==='function')owners['node:dns'][key]=deny;
for(const key of Object.keys(owners['node:dns'].promises))if(key!=='Resolver'&&typeof owners['node:dns'].promises[key]==='function')owners['node:dns'].promises[key]=deny;
globalThis.fetch=deny;
const pins={
 '523ef9167f05a33efdbdfbbfc08d5fc2e2679012':['apps/web/Dockerfile','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','apps/onboard-api/Dockerfile'],
 '5470c6df029c9553dd49e531229c3c91b26275ef':['package.json','.github/workflows/ci-pr.yml','pnpm-workspace.yaml'],
 'c8c109f7d796d5a50ae57ff6cb214d576c757847':['scripts/validate-knowledge-plane-phase26.mjs','package.json'],
 'b7aa1d6e6b341f833fa08b2add8f40d5fbee8480':['package.json','apps/api/package.json'],
 '457e84e7d50f401985355cf22eedc480fd72ad8b':['package.json','apps/api/package.json'],
};
const original=cp.execFileSync;cp.execFileSync=function(command,args,options){
 if(command!=='git'||!Array.isArray(args)||args.length!==2||args[0]!=='show')deny();
 const split=args[1].indexOf(':'),ref=args[1].slice(0,split),file=args[1].slice(split+1);
 if(!pins[ref]?.includes(file))deny();return original.call(this,command,args,options);
};
for(const n of ['spawn','spawnSync','exec','execSync','execFile','fork'])cp[n]=deny;
function forbidden(value){if(value instanceof URL)value=url.fileURLToPath(value);if(Buffer.isBuffer(value))value=value.toString();return typeof value==='string'&&/(?:^|\/)apps\/api\/src\/engagement\/engagement\.service\.ts$/.test(value);}
for(const n of ['readFileSync','readFile','openSync','open','createReadStream']){const old=fs[n];fs[n]=function(p,...args){if(forbidden(p))deny();return old.call(this,p,...args);};}
for(const n of ['readFile','open']){const old=fs.promises[n];fs.promises[n]=function(p,...args){if(forbidden(p))deny();return old.call(this,p,...args);};}
require('node:module').syncBuiltinESMExports();
