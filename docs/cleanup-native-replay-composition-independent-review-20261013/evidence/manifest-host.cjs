'use strict';
const fs=require('node:fs'),path=require('node:path'),url=require('node:url'),cp=require('node:child_process');
const deny=()=>{throw new Error('Independent accepted-source profile host refuses unapproved effect');};
const owners=Object.fromEntries(['node:net','node:http','node:https','node:tls','node:dgram','node:dns'].map(n=>[n,require(n)]));
for(const[n,keys]of[['node:net',['connect','createConnection','createServer']],['node:http',['request','get','createServer']],['node:https',['request','get','createServer']],['node:tls',['connect','createServer']],['node:dgram',['createSocket']]])for(const key of keys)owners[n][key]=deny;
owners['node:net'].Server.prototype.listen=deny;owners['node:net'].Socket.prototype.connect=deny;
for(const key of Object.keys(owners['node:dns']))if(/^(?:lookup|resolve|reverse)/.test(key)&&typeof owners['node:dns'][key]==='function')owners['node:dns'][key]=deny;
for(const key of Object.keys(owners['node:dns'].promises))if(key!=='Resolver'&&typeof owners['node:dns'].promises[key]==='function')owners['node:dns'].promises[key]=deny;
globalThis.fetch=deny;
const allowed=new Set(['b7aa1d6e6b341f833fa08b2add8f40d5fbee8480:package.json','b7aa1d6e6b341f833fa08b2add8f40d5fbee8480:apps/api/package.json','457e84e7d50f401985355cf22eedc480fd72ad8b:package.json','457e84e7d50f401985355cf22eedc480fd72ad8b:apps/api/package.json','e25b2c9ad93ae8d63ffb5332c41d7af1623d4400:apps/api/package.json']);
const run=cp.execFileSync;cp.execFileSync=function(command,args,options){if(command!=='git'||!Array.isArray(args)||args.length!==2||args[0]!=='show'||!allowed.has(args[1]))deny();return run.call(this,command,args,options);};
for(const n of ['spawn','spawnSync','exec','execSync','execFile','fork'])cp[n]=deny;
function forbidden(value){if(value instanceof URL)value=url.fileURLToPath(value);if(Buffer.isBuffer(value))value=value.toString();return typeof value==='string'&&/(?:^|\/)apps\/api\/src\/engagement\/engagement\.service\.ts$/.test(value);}
for(const n of ['readFileSync','readFile','openSync','open','createReadStream']){const old=fs[n];fs[n]=function(p,...args){if(forbidden(p))deny();return old.call(this,p,...args);};}
for(const n of ['readFile','open']){const old=fs.promises[n];fs.promises[n]=function(p,...args){if(forbidden(p))deny();return old.call(this,p,...args);};}
require('node:module').syncBuiltinESMExports();
