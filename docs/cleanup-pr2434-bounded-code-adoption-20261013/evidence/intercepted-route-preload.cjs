'use strict';
// Evidence-only host: cached esbuild service is the sole permitted child.
const cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const events=[];
const deny=(kind)=>()=>{events.push({denied:kind});throw new Error('INTERCEPTED_ROUTE_CHECK_REFUSED:'+kind);};
const esbuild='/workspace/capirov2/node_modules/.pnpm/@esbuild+linux-x64@0.21.5/node_modules/@esbuild/linux-x64/bin/esbuild';
const spawn=cp.spawn;
cp.spawn=function(command,args,options){
 if(command!==esbuild||JSON.stringify(args)!==JSON.stringify(['--service=0.21.5','--ping']))return deny('child:'+String(command))();
 events.push({localTool:command,args});return spawn.call(this,command,args,options);
};
for(const name of ['spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[name]=deny('child:'+name);
const net=require('node:net');net.connect=deny('TCP');net.createConnection=deny('TCP');net.Socket.prototype.connect=deny('socket');net.Server.prototype.listen=deny('listen');
const tls=require('node:tls');tls.connect=deny('TLS');
for(const name of ['node:http','node:https'])for(const method of ['request','get'])require(name)[method]=deny(name+':'+method);
require('node:dgram').createSocket=deny('datagram');
const dns=require('node:dns');for(const name of Object.keys(dns))if(typeof dns[name]==='function')dns[name]=deny('DNS');for(const name of Object.keys(dns.promises))if(typeof dns.promises[name]==='function')dns.promises[name]=deny('DNS');
globalThis.fetch=deny('fetch');
const forbidden=file=>path.resolve(String(file)).replaceAll('\\','/').endsWith('/apps/api/src/engagement/engagement.service.ts');
for(const name of ['readFileSync','readFile']){const read=fs[name];fs[name]=function(file,...args){if(forbidden(file))return deny('protected-source')();return read.call(this,file,...args);};}
const read=fs.promises.readFile;fs.promises.readFile=function(file,...args){if(forbidden(file))return deny('protected-source')();return read.call(this,file,...args);};
require('node:module').syncBuiltinESMExports();
process.on('exit',()=>{if(process.env.ROUTE_CHECK_EVENT_PATH)fs.writeFileSync(process.env.ROUTE_CHECK_EVENT_PATH,JSON.stringify({pid:process.pid,events},null,2)+'\n');});
