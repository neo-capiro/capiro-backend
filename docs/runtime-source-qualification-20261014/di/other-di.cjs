'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path'),Module=require('node:module');
const src='/dev/shm/capiro-pinned-parser-install-20261014/runnable-build/source';
const owner=process.argv[2];const app=src+'/'+owner;
const req=Module.createRequire(app+'/dist/source-probe.cjs');
const blocked=[];const never=(kind)=>(...args)=>{blocked.push({kind});throw new Error('SOURCE_PROBE_IO_BLOCKED:'+kind);};
for(const name of ['node:http','node:https']){const m=require(name);m.request=never(name+'.request');m.get=never(name+'.get');}
require('node:net').Socket.prototype.connect=never('net.connect');
require('node:tls').connect=never('tls.connect');
const dns=require('node:dns');for(const n of ['lookup','resolve','resolve4','resolve6'])dns[n]=never('dns.'+n);
for(const n of ['lookup','resolve','resolve4','resolve6'])if(dns.promises?.[n])dns.promises[n]=never('dns.promises.'+n);
global.fetch=never('fetch');
const cp=require('node:child_process');for(const n of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[n]=never('child_process.'+n);
global.setInterval=never('setInterval');
const read=fs.readFileSync;
fs.readFileSync=function(p,...args){if(typeof p==='string'&&p.split(path.sep).includes('.aws')){blocked.push({kind:'credential-file',path:p});throw new Error('SOURCE_PROBE_IO_BLOCKED:credential-file');}return read.call(this,p,...args);};
function blob(buf){return crypto.createHash('sha1').update(Buffer.from('blob '+buf.length+'\0')).update(buf).digest('hex');}

const owners={'apps/api-strategy':'e97fded5a9eb26ba38493943898c4087ed16ce27','apps/workspace':'f8510b072d593778a789b5ecc41330eece22f7ab','apps/intel-api':'a89f3724e7622e17842db3b7b5054afb48f7690a'};
if(!owners[owner]||blob(fs.readFileSync(app+'/src/app.module.ts'))!==owners[owner])throw new Error('AppModule source fingerprint mismatch');
const {PrismaService}=req('./prisma/prisma.service.js');
const lifecycle=new Set(['then','onModuleInit','onModuleDestroy','onApplicationBootstrap','beforeApplicationShutdown','onApplicationShutdown','toJSON']);
function strictDb(parts=[]){const fn=function(){blocked.push({kind:'Prisma',method:parts.join('.')});throw new Error('SOURCE_PROBE_DB_CALL_BLOCKED:'+parts.join('.'));};return new Proxy(fn,{get(t,k){if(lifecycle.has(k)||typeof k==='symbol')return undefined;if(k==='constructor')return Object;return strictDb(parts.concat(String(k)));}});}
const db=new Proxy(Object.create(null),{get(t,k){if(lifecycle.has(k)||typeof k==='symbol')return undefined;if(k==='constructor')return Object;return strictDb([String(k)]);}});
(async()=>{const start=Date.now();let timer,moduleRef;let result;
try{const {Test}=req('@nestjs/testing');const {AppModule}=req('./app.module.js');
moduleRef=await Promise.race([Test.createTestingModule({imports:[AppModule]}).overrideProvider(PrismaService).useValue(db).compile(),new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('DI compile did not settle in 45000ms')),45000))]);
if(!moduleRef)throw new Error('module not defined');await moduleRef.close();result={status:'pass',ms:Date.now()-start};
}catch(e){result={status:'fail',ms:Date.now()-start,error:{name:e?.name,message:e?.message,stack:e?.stack?.split('\n').slice(0,16)}};
}finally{clearTimeout(timer);}
console.log(JSON.stringify({node:process.version,owner,sourceHead:'dd02f3ba0b4ab77e3725e83e4b9af27aecdc8eca',appModuleGitBlob:owners[owner],prismaPort:'strict mock; any call fails',moduleInit:'not requested',blockedIO:blocked,result}));
process.exit(result.status==='pass'&&blocked.length===0?0:1);
})().catch(e=>{console.error(e.stack);process.exit(1);});
