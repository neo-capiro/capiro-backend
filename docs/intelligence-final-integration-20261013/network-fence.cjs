const deny=()=>{throw new Error('SOURCE_ONLY_NETWORK_DENIED')};
const net=require('node:net');net.connect=deny;net.createConnection=deny;net.Socket.prototype.connect=deny;
for(const name of ['node:http','node:https']){const m=require(name);m.request=deny;m.get=deny;}
const dns=require('node:dns');for(const k of Object.keys(dns)){if(typeof dns[k]==='function')dns[k]=deny;}for(const k of Object.keys(dns.promises)){if(typeof dns.promises[k]==='function')dns.promises[k]=async()=>deny();}
