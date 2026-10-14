'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path'),Module=require('node:module');
const src='/dev/shm/capiro-pinned-parser-install-20261014/runnable-build/source';
const app=src+'/apps/api';
const spec='/dev/shm/capiro-runtime-candidate-20261014/worktree/apps/api/src/app.module.spec.ts';
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
fs.readFileSync=function(p,...args){if(typeof p==='string'&&(/\/.aws\//.test(p)||/\/(credentials|config)$/i.test(p)&&p.includes('.aws')))return never('credential-file')();return read.call(this,p,...args);};
function blob(buf){return crypto.createHash('sha1').update(Buffer.from('blob '+buf.length+'\0')).update(buf).digest('hex');}
const text=fs.readFileSync(spec,'utf8');if(blob(Buffer.from(text))!=='d3e711cedd98c9f6ac751c96f49769ceca55f30a')throw new Error('spec fingerprint mismatch');
if(blob(fs.readFileSync(app+'/src/app.module.ts'))!=='6b867553bed4ffd1376279414ce4fa892bb896e7')throw new Error('AppModule source mismatch');
const {PrismaService}=req('./prisma/prisma.service.js');
const lifecycle=new Set(['then','onModuleInit','onModuleDestroy','onApplicationBootstrap','beforeApplicationShutdown','onApplicationShutdown','toJSON']);
function strictDb(parts=[]){const fn=function(){blocked.push({kind:'Prisma',method:parts.join('.')});throw new Error('SOURCE_PROBE_DB_CALL_BLOCKED:'+parts.join('.'));};return new Proxy(fn,{get(t,k){if(lifecycle.has(k)||typeof k==='symbol')return undefined;if(k==='constructor')return Object;return strictDb(parts.concat(String(k)));}});}
const prisma=Object.create(null);
const db=new Proxy(prisma,{get(t,k){if(lifecycle.has(k)||typeof k==='symbol')return undefined;if(k==='constructor')return Object;return strictDb([String(k)]);}});
const {Test}=req('@nestjs/testing');const original=Test.createTestingModule;
Test.createTestingModule=function(...args){return original.apply(this,args).overrideProvider(PrismaService).useValue(db);};
const ts=req('typescript'),tests=[];global.describe=(name,fn)=>fn();global.it=(name,fn,timeout)=>tests.push({name,fn,timeout});global.expect=v=>({toBeDefined(){if(v===undefined)throw new Error('expected defined');}});
const transpiled=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
const m={exports:{}};new Function('require','module','exports','__filename','__dirname',transpiled)(req,m,m.exports,app+'/dist/app.module.spec.js',app+'/dist');
(async()=>{const results=[];for(const t of tests){const start=Date.now();let timer;try{await Promise.race([t.fn(),new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('DI compile did not settle in 45000ms')),45000))]);results.push({name:t.name,status:'pass',ms:Date.now()-start});}catch(e){results.push({name:t.name,status:'fail',ms:Date.now()-start,error:{name:e?.name,message:e?.message,stack:e?.stack?.split('\n').slice(0,14)}});}finally{clearTimeout(timer);}}
const result={node:process.version,specGitBlob:'d3e711cedd98c9f6ac751c96f49769ceca55f30a',sourceHead:'dd02f3ba0b4ab77e3725e83e4b9af27aecdc8eca',originalPublishedSpec:true,prismaPort:'strict mock; any call fails',moduleInit:'not requested',blockedIO:blocked,results};
console.log(JSON.stringify(result));process.exit(results.every(x=>x.status==='pass')&&blocked.length===0?0:1);})().catch(e=>{console.error(e.stack);process.exit(1);});
