const fs=require('node:fs');const {syncBuiltinESMExports,Module}=require('node:module');
const originalRead=fs.readFileSync;
fs.readFileSync=function(p,...args){const s=String(p).replace(/\\/g,'/');if(/\/engagement\/engagement\.service\.ts$/.test(s))throw Error('Protected reporting-body read refused');return originalRead.call(this,p,...args);};
const originalLoad=Module._load;Module._load=function(name,...args){if(/^(@prisma\/client|@aws-sdk\/|aws-sdk$|pg$)/.test(String(name)))throw Error('Unrelated provider/native client module refused: '+name);return originalLoad.call(this,name,...args);};
const deny=name=>(..._args)=>{throw Error('Forbidden network/process operation '+name);};
for(const [m,keys] of [['node:child_process',['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']],['node:http',['get','request']],['node:https',['get','request']],['node:net',['connect','createConnection']],['node:tls',['connect']],['node:dgram',['createSocket']],['node:dns',['lookup','resolve','resolve4','resolve6','reverse']]])for(const k of keys)require(m)[k]=deny(m+'.'+k);
require('node:net').Socket.prototype.connect=deny('Socket.connect');require('node:net').Server.prototype.listen=deny('Server.listen');globalThis.fetch=deny('fetch');syncBuiltinESMExports();
