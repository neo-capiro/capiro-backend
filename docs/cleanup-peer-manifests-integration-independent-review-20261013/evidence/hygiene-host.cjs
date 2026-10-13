'use strict';
const fs=require('node:fs'),path=require('node:path'),url=require('node:url'),cp=require('node:child_process');
const deny=()=>{throw new Error('Independent accepted-source profile host refuses unapproved effect');};
const owners=Object.fromEntries(['node:net','node:http','node:https','node:tls','node:dgram','node:dns'].map(n=>[n,require(n)]));
for(const[n,keys]of[['node:net',['connect','createConnection','createServer']],['node:http',['request','get','createServer']],['node:https',['request','get','createServer']],['node:tls',['connect','createServer']],['node:dgram',['createSocket']]])for(const key of keys)owners[n][key]=deny;
owners['node:net'].Server.prototype.listen=deny;owners['node:net'].Socket.prototype.connect=deny;
for(const key of Object.keys(owners['node:dns']))if(/^(?:lookup|resolve|reverse)/.test(key)&&typeof owners['node:dns'][key]==='function')owners['node:dns'][key]=deny;
for(const key of Object.keys(owners['node:dns'].promises))if(key!=='Resolver'&&typeof owners['node:dns'].promises[key]==='function')owners['node:dns'].promises[key]=deny;
globalThis.fetch=deny;
function forbidden(value){if(value instanceof URL)value=url.fileURLToPath(value);if(Buffer.isBuffer(value))value=value.toString();return typeof value==='string'&&/(?:^|\/)apps\/api\/src\/engagement\/engagement\.service\.ts$/.test(value);}
for(const n of ['readFileSync','readFile','openSync','open','createReadStream']){const old=fs[n];fs[n]=function(p,...args){if(forbidden(p))deny();return old.call(this,p,...args);};}
for(const n of ['readFile','open']){const old=fs.promises[n];fs.promises[n]=function(p,...args){if(forbidden(p))deny();return old.call(this,p,...args);};}

const git=cp.execFileSync;cp.execFileSync=function(command,args,options){
 const rawRef='9db4e1cd5589a05e08fb88caa38a4ac44937def5:';
 const cwd=String(options?.cwd??'');
 const archive=command==='git'&&Array.isArray(args)&&args.length===2&&args[0]==='show'&&args[1].startsWith(rawRef)&&args[1].includes('/');
 const fixture=command==='git'&&Array.isArray(args)&&cwd.startsWith('/tmp/capiro-hygiene-git-')&&args[0]==='-c'&&args.includes('core.hooksPath=/dev/null')&&!args.some(a=>/^(?:fetch|push|pull|clone|remote|submodule)$/.test(a));
 if(!archive&&!fixture)deny();return git.call(this,command,args,options);
};
const spawn=cp.spawnSync;cp.spawnSync=function(command,args,options){
 const owner=Array.isArray(args)&&args[0]==='--no-addons'?args[1]:null;
 const fixture=typeof owner==='string'&&owner.startsWith('/tmp/capiro-hygiene-git-')&&owner.endsWith('/scripts/lib/reviewed-source-hygiene.mjs')&&String(options?.cwd??'').startsWith('/tmp/capiro-hygiene-git-');
 const own=owner===path.resolve('scripts/lib/reviewed-source-hygiene.mjs');
 if(command!==process.execPath||(!fixture&&!own))deny();
 return spawn.call(this,command,args,options);
};
for(const n of ['spawn','exec','execSync','execFile','fork'])cp[n]=deny;
require('node:module').syncBuiltinESMExports();
