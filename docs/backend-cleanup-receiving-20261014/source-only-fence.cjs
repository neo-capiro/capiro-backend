const deny=()=>{throw new Error('SOURCE_ONLY_NETWORK_DENIED')};
const net=require('node:net');net.connect=deny;net.createConnection=deny;net.Socket.prototype.connect=deny;
for(const name of ['node:http','node:https']){const m=require(name);m.request=deny;m.get=deny;}
const dns=require('node:dns');for(const k of Object.keys(dns)){if(typeof dns[k]==='function')dns[k]=deny;}for(const k of Object.keys(dns.promises)){if(typeof dns.promises[k]==='function')dns.promises[k]=async()=>deny();}
globalThis.fetch=async()=>deny();
const fs=require('node:fs');const sensitive=/(?:^|[\\/])(?:[.]env(?:[.][^\\/]*)?|[.]aws|credentials|engagement[.]service[.](?:ts|js))(?:[\\/]|$)/;
for(const method of ['readFileSync','readFile','openSync','open']){const original=fs[method];fs[method]=function(file,...args){if(typeof file==='string'&&sensitive.test(file))throw new Error('SOURCE_ONLY_SENSITIVE_READ_DENIED');return original.call(this,file,...args);};}
