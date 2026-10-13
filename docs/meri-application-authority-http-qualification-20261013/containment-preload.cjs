'use strict';
// Install before Nest/SDK/client imports. Test-process instrumentation only.
const fs=require('node:fs');const net=require('node:net');const http=require('node:http');
const https=require('node:https');const dns=require('node:dns');const child=require('node:child_process');
const audit={externalRefusals:0,protectedReadRefusals:0,childRefusals:0,allowedLoopbackConnections:0,allowedLoopbackListeners:0,literalLoopbackLookups:0};
const allowedPorts=new Set([5432]);
const refuse=message=>{audit.externalRefusals++;throw new Error(message);};
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) child[name]=()=>{audit.childRefusals++;throw new Error('Child process refused in HTTP fixture');};
for(const api of [https]) for(const name of ['request','get']) api[name]=()=>refuse('HTTPS refused in HTTP fixture');
for(const name of ['resolve','resolve4','resolve6','resolveAny','reverse']) dns[name]=()=>refuse('DNS refused in HTTP fixture');
for(const name of ['resolve','resolve4','resolve6','resolveAny','reverse']) if(dns.promises[name]) dns.promises[name]=async()=>refuse('DNS refused in HTTP fixture');
dns.lookup=(hostname,options,callback)=>{
  if(hostname!=='127.0.0.1') return refuse('DNS outside exact loopback refused');
  const cb=typeof options==='function'?options:callback;
  if(typeof cb!=='function') throw new TypeError('Lookup callback required');
  audit.literalLoopbackLookups++;
  process.nextTick(()=>options?.all?cb(null,[{address:'127.0.0.1',family:4}]):cb(null,'127.0.0.1',4));
};
dns.promises.lookup=async(hostname,options)=>{
  if(hostname!=='127.0.0.1') return refuse('DNS outside exact loopback refused');
  audit.literalLoopbackLookups++;return options?.all?[{address:'127.0.0.1',family:4}]:{address:'127.0.0.1',family:4};
};
function checkProtected(file) {
  const text=String(file);
  if(/(?:^|\/)engagement\.service\.(?:ts|js)$/.test(text) || /(?:^|\/)\.env(?:\.[^/]*)?$/.test(text)) {
    audit.protectedReadRefusals++;throw new Error('Protected reporting/environment body read refused');
  }
}
for(const name of ['readFileSync','readFile','openSync','open']) {
  const old=fs[name];fs[name]=function(file,...args){checkProtected(file);return old.call(this,file,...args);};
}
const oldRead=fs.promises.readFile.bind(fs.promises);fs.promises.readFile=async(file,...args)=>{checkProtected(file);return oldRead(file,...args);};
const oldOpen=fs.promises.open.bind(fs.promises);fs.promises.open=async(file,...args)=>{checkProtected(file);return oldOpen(file,...args);};
const oldStream=fs.createReadStream;fs.createReadStream=function(file,...args){checkProtected(file);return oldStream.call(this,file,...args);};
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
  const a=Array.isArray(args[0])?args[0]:args;
  const first=a[0];
  const options=first && typeof first==='object'?first:{port:first,host:typeof a[1]==='string'?a[1]:'localhost'};
  if(options.path || !['127.0.0.1','localhost'].includes(options.host??'localhost') || !allowedPorts.has(Number(options.port))) return refuse('Unapproved socket refused in HTTP fixture');
  audit.allowedLoopbackConnections++;return connect.apply(this,args);
};
const listen=net.Server.prototype.listen;
net.Server.prototype.listen=function(...args){
  const o=typeof args[0]==='object'?args[0]:{port:args[0],host:typeof args[1]==='string'?args[1]:undefined};
  if(o.host!=='127.0.0.1' || Number(o.port)!==0) return refuse('Only an owned ephemeral loopback listener is allowed');
  audit.allowedLoopbackListeners++;
  this.once('listening',()=>{const a=this.address();if(a && typeof a==='object') allowedPorts.add(a.port);});
  return listen.apply(this,args);
};
const originalFetch=globalThis.fetch;
globalThis.fetch=(url,options)=>{
  const u=new URL(url);
  if(u.protocol!=='http:' || u.hostname!=='127.0.0.1' || !allowedPorts.has(Number(u.port))) return refuse('Fetch outside owned loopback refused');
  return originalFetch(url,{...options,redirect:'error'});
};
const oldHttp=http.request;http.request=function(url,...args){
  const o=typeof url==='string' || url instanceof URL ? new URL(url) : url;
  if(!['127.0.0.1','localhost'].includes(o.hostname??o.host) || !allowedPorts.has(Number(o.port))) return refuse('HTTP outside owned loopback refused');
  return oldHttp.call(this,url,...args);
};
module.exports={audit};
