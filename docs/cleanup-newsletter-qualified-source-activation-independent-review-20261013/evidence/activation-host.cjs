'use strict';
const fs=require('node:fs'),path=require('node:path'),url=require('node:url'),cp=require('node:child_process');
const deny=()=>{throw new Error('Independent accepted-source profile host refuses unapproved effect');};
const owners=Object.fromEntries(['node:net','node:http','node:https','node:tls','node:dgram','node:dns'].map(n=>[n,require(n)]));
for(const[n,keys]of[['node:net',['connect','createConnection','createServer']],['node:http',['request','get','createServer']],['node:https',['request','get','createServer']],['node:tls',['connect','createServer']],['node:dgram',['createSocket']]])for(const key of keys)owners[n][key]=deny;
owners['node:net'].Server.prototype.listen=deny;owners['node:net'].Socket.prototype.connect=deny;
for(const key of Object.keys(owners['node:dns']))if(/^(?:lookup|resolve|reverse)/.test(key)&&typeof owners['node:dns'][key]==='function')owners['node:dns'][key]=deny;
for(const key of Object.keys(owners['node:dns'].promises))if(key!=='Resolver'&&typeof owners['node:dns'].promises[key]==='function')owners['node:dns'].promises[key]=deny;
globalThis.fetch=deny;
const allowed=new Set(["fbd490ad3a072fd3a294a80952b43e4e04d1583f2c972cd0536f971b3308a20d", "0a0456091dd379afe76be3492c4f04c9ba0d5fa34d60f582ae3e454df2c45990", "d9164bbf5cd9dcff57c91fc4dc583019ef863a8dd9c7a9a0c13583bc29e38426", "a9a54e196f0776fce7a2f0e54ac281c6efcd1a1ccf1a8fa8e60b977e9a7dcc03", "e503a998f211e10eb18b9222969b3b399d291a93ae4ad41f65e2b69c564376f2", "cc153065ba054e11df2d4fb4b77c7366a1229356dba7dddd201c28c05546c3d1", "90d96598f2ea615eec46a965fe0548b9237b73d794c874b2b0c0f7152fda95e9", "ca69b7ca93889d992c94a6e1946ad67b4b5eb6c52ad63009acb41b48156473ca", "893b2df4252e802ec5f0ae1a5bc9ca67a345474838e733add013cab995d62383", "6f82e4f40f29df89e42fbe68ef97294ea3a4a2fc4342d296b48cf5b53c01d799", "6b8d8b19787761150591e1f656ecee1a484480c02b22d6b529a780ab809c6c86", "5d332d717d6f819d17079ea5016edf70b3b22444bfbafeabeed8c8dae0f461a3", "ad011fc8c6d509070232bf19eeee763b84cbda6cc3f6abea0913789456961fef", "bd887883f56e5182f4044931508fb8fb80e32bf4a00b2f63bc4156128026c8cc"]);
const spawn=cp.spawnSync;cp.spawnSync=function(command,args,options){if(command!==process.execPath||!Array.isArray(args)||args.length!==3||args[0]!=='--input-type=module'||args[1]!=='--eval'||typeof args[2]!=='string'||!allowed.has(require('node:crypto').createHash('sha256').update(args[2]).digest('hex')))deny();return spawn.call(this,command,args,options);};
for(const n of ['spawn','exec','execSync','execFile','execFileSync','fork'])cp[n]=deny;
function forbidden(value){if(value instanceof URL)value=url.fileURLToPath(value);if(Buffer.isBuffer(value))value=value.toString();return typeof value==='string'&&/(?:^|\/)apps\/api\/src\/engagement\/engagement\.service\.ts$/.test(value);}
for(const n of ['readFileSync','readFile','openSync','open','createReadStream']){const old=fs[n];fs[n]=function(p,...args){if(forbidden(p))deny();return old.call(this,p,...args);};}
for(const n of ['readFile','open']){const old=fs.promises[n];fs.promises[n]=function(p,...args){if(forbidden(p))deny();return old.call(this,p,...args);};}
require('node:module').syncBuiltinESMExports();
