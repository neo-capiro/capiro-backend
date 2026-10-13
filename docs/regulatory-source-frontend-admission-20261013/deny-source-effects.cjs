"use strict";
// Source/mocked qualification only. Installed before Jest or application imports.
const fs=require('node:fs'),net=require('node:net'),dns=require('node:dns'),child=require('node:child_process');
const refuse=()=>{throw new Error('SOURCE_QUALIFICATION_EFFECT_REFUSED');};
net.Socket.prototype.connect=refuse;net.Server.prototype.listen=refuse;
for(const name of ['lookup','resolve','resolve4','resolve6','resolveAny','reverse']){dns[name]=refuse;if(dns.promises[name])dns.promises[name]=refuse;}
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])child[name]=refuse;
for(const scheme of ['node:http','node:https'])for(const name of ['request','get'])require(scheme)[name]=refuse;
globalThis.fetch=refuse;
function check(file){if(/(?:^|\/)engagement\.service\.(?:ts|js)$/.test(String(file)) || /(?:^|\/)\.env(?:\.[^/]*)?$/.test(String(file)))refuse();}
for(const name of ['readFileSync','readFile','openSync','open']){const original=fs[name];fs[name]=function(file,...args){check(file);return original.call(this,file,...args);};}
const originalRead=fs.promises.readFile.bind(fs.promises);fs.promises.readFile=async(file,...args)=>{check(file);return originalRead(file,...args);};
