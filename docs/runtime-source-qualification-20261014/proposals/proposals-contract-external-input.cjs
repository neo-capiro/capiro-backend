'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path').posix,vm=require('node:vm'),fs=require('node:fs');
const ts=require('/workspace/capiro-frontend/node_modules/typescript'),zod=require('/workspace/capiro-frontend/node_modules/zod');
const payload=JSON.parse(fs.readFileSync(0,'utf8'));
globalThis.fetch=()=>{throw Error('No live HTTP admitted by this fixture');};
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const sources=new Map(payload.sources.map(s=>[s.key,s]));
const sourceFingerprints=[];
for(const s of sources.values()){
 const bytes=Buffer.from(s.text);
 assert.equal(crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob '+bytes.length+'\0'),bytes])).digest('hex'),s.gitBlob);
 sourceFingerprints.push({repository:s.repository,key:s.key,path:s.path,gitBlob:s.gitBlob,bytes:bytes.length,sha256:sha(bytes)});
}
function ast(key){const s=sources.get(key);return ts.createSourceFile(s.path,s.text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);}
function decl(key,names){
 const sf=ast(key),out=[];
 for(const name of names){
  const node=sf.statements.find(n=>(n.name?.text===name)||(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(sf)===name)));
  assert(node,'missing declaration '+key+':'+name);out.push(node.getText(sf));
 }
 return out.join('\n');
}
function compile(text,name){const r=ts.transpileModule(text,{fileName:name,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,experimentalDecorators:true,emitDecoratorMetadata:false,esModuleInterop:true},reportDiagnostics:true});assert.equal(r.diagnostics.filter(d=>d.category===ts.DiagnosticCategory.Error).length,0);return r.outputText;}
const frontFiles=new Map(payload.sources.filter(s=>s.repository==='frontend').map(s=>[s.path,s])),frontCache=new Map();
function frontend(name){
 if(frontCache.has(name))return frontCache.get(name).exports;
 const source=frontFiles.get(name);assert(source,'unselected frontend import '+name);const m={exports:{}};frontCache.set(name,m);
 const req=key=>{if(key==='zod')return zod;assert(key.startsWith('.'));const p=path.normalize(path.join(path.dirname(name),key)).replace(/\.js$/,'');return frontend(p.endsWith('.ts')?p:p+'.ts');};
 vm.runInThisContext('(function(require,module,exports){'+compile(source.text,name)+'\n})',{filename:name})(req,m,m.exports);return m.exports;
}
const {strategiesAgentOperations}=frontend('apps/web/src/shared/capiro/operations/strategies-agents.ts');
const response=strategiesAgentOperations['strategies.proposals'].response;
function enumValues(text){return text.slice(text.indexOf('{')+1,text.lastIndexOf('}')).split('\n').map(x=>x.split('//')[0].trim()).filter(x=>/^[A-Za-z]\w*$/.test(x));}
const statuses=enumValues(payload.schema.enums.SpChangeSetStatus),risks=enumValues(payload.schema.enums.SpChangeSetRisk);
const fields=payload.schema.model.split('\n').slice(1).map(l=>l.split('//')[0].trim()).map(l=>l.match(/^(\w+)\s+(\w+)(\?)?/)).filter(Boolean).map(m=>({name:m[1],type:m[2],nullable:!!m[3]}));
const ids={tenant:'10000000-0000-4000-8000-000000000001',strategy:'10000000-0000-4000-8000-000000000002',version:'10000000-0000-4000-8000-000000000003',row:'10000000-0000-4000-8000-000000000004',node:'10000000-0000-4000-8000-000000000005',dep:'10000000-0000-4000-8000-000000000006'};
function modelRow(overrides={}){
 const row={};
 for(const f of fields){
  if(f.nullable){row[f.name]=null;continue;}
  if(f.type==='String')row[f.name]=f.name==='summary'?'Synthetic proposal':ids.row;
  else if(f.type==='DateTime')row[f.name]=new Date('2026-10-14T00:00:00.000Z');
  else if(f.type==='Json')row[f.name]=[];
  else if(f.type==='SpChangeSetStatus')row[f.name]=statuses[0];
  else if(f.type==='SpChangeSetRisk')row[f.name]=risks[0];
  else throw Error('unhandled pinned model field '+f.name+':'+f.type);
 }
 return{...row,tenantId:ids.tenant,strategyId:ids.strategy,strategyVersionId:ids.version,...overrides};
}
const wire=x=>JSON.parse(JSON.stringify(x));
const issues=r=>r.success?[]:r.error.issues.map(i=>({path:i.path,code:i.code,expected:i.expected??null}));
function parseRow(row){return response.safeParse(wire([row]));}
function cached(name){
 const direct='/workspace/capirov2/apps/api-strategy/node_modules/'+name;
 if(fs.existsSync(path.join(direct,'package.json')))return direct;
 const root='/workspace/capirov2/node_modules/.pnpm',prefix=name.replace('/','+')+'@';
 const matches=fs.readdirSync(root).filter(p=>p.startsWith(prefix)).sort();
 assert.equal(matches.length,1,'ambiguous/missing cached dependency '+name);
 const value=root+'/'+matches[0]+'/node_modules/'+name;
 assert(fs.existsSync(value+'/package.json'));return value;
}
const cvRoot=cached('class-validator'),cv=require(cvRoot);
const dtoSource=decl('dto',['CHANGE_SET_RISKS','CreateChangeSetDto']);
const cvNames=['IsUUID','IsOptional','IsString','MaxLength','IsArray','ArrayMaxSize','IsIn'];
const cvSetup='const {'+cvNames.join(',')+'}=cv;';
const Dto=vm.runInThisContext('(function(cv){const exports={};'+cvSetup+compile(dtoSource,'selected-exact-dto.ts')+';return exports.CreateChangeSetDto;})')(cv);
const sf=ast('service'),serviceClass=sf.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='ChangeSetsService');
const methodNames=['constructor','headOf','create','list'];
const selected=methodNames.map(name=>{const n=serviceClass.members.find(n=>name==='constructor'?ts.isConstructorDeclaration(n):n.name?.getText(sf)===name);assert(n,name);return n.getText(sf);}).join('\n');
const statusEnum=Object.fromEntries(statuses.map(s=>[s,s]));
const Service=vm.runInThisContext('(function(SpChangeSetStatus,BadRequestException){'+compile('class SelectedOwnerMethods{'+selected+'}','selected-exact-owner.ts')+';return SelectedOwnerMethods;})')(statusEnum,class extends Error{});
const pure=decl('verify',['ISO_RE','validIso'])+'\n'+decl('health',['isCommittedStrategyStep','utcDay','strategyStepDueDate','isStrategyStepOverdue'])+'\n'+decl('checks',['CATEGORY_SORT_RANK','addDaysIso','diffDaysIso','effectiveEnd','checkOverdue','checkDependencySlippage']);
const {checkOverdue,checkDependencySlippage}=vm.runInThisContext('(function(){const exports={};'+compile(pure,'selected-exact-watch-functions.ts')+';return {checkOverdue,checkDependencySlippage};})')();
const cases=[];
async function test(name,classification,run){
 try{const observation=await run();cases.push({name,classification,pass:true,...observation});}
 catch(e){cases.push({name,classification,pass:false,error:{name:e.name,message:e.message}});}
}
async function storeAndRead(ops){
 const dto=Object.assign(new Dto(),{strategyId:ids.strategy,summary:'Synthetic DTO-admitted proposal',ops,risk:'low'});
 const dtoErrors=cv.validateSync(dto,{whitelist:true,forbidNonWhitelisted:true,forbidUnknownValues:false});
 assert.equal(dtoErrors.length,0,'normal DTO rejected synthetic input');
 let saved,createSeen=0,listSeen=0;
 const tx={spStrategy:{findFirst:async()=>({id:ids.strategy})},spVersion:{findFirst:async()=>({id:ids.version}),updateMany:async()=>({count:1})},spChangeSet:{create:async({data})=>{createSeen++;assert.deepEqual(data.ops,ops);saved=modelRow(data);return saved;},findMany:async(args)=>{listSeen++;assert.deepEqual(args.where,{});assert.equal(args.take,100);return[saved];}}};
 const scoped=async(tenant,fn)=>{assert.equal(tenant,ids.tenant);return fn(tx);};
 const service=new Service({withTenant:scoped,withTenantUser:async(tenant,user,fn)=>scoped(tenant,fn)},{logActivity:async()=>{}},{},{});
 await service.create(ids.tenant,null,dto);const listed=await service.list(ids.tenant);assert.equal(createSeen,1);assert.equal(listSeen,1);assert.equal(Array.isArray(listed),true);assert.deepEqual(listed[0].ops,ops);
 return{dtoAccepted:true,opsPersistedUnchanged:true,listIsArray:true,parsed:response.safeParse(wire(listed))};
}
(async()=>{
 await test('Prisma model Date objects serialize to string JSON with nullable fields','canonical-model',async()=>{const row=modelRow();assert(row.createdAt instanceof Date);const w=wire(row);assert.equal(typeof w.createdAt,'string');const p=parseRow(row);assert(p.success);return{accepted:true};});
 for(const status of statuses)for(const risk of risks)await test('pinned enum '+status+'/'+risk,'canonical-model',async()=>{assert(parseRow(modelRow({status,risk})).success);return{accepted:true};});
 for(const [field,value] of [['approvedAt',new Date('2026-10-14T01:00:00Z')],['appliedAt',new Date('2026-10-14T02:00:00Z')],['appliedVersionId',ids.version]])await test('model nullable field populated '+field,'canonical-model',async()=>{assert(parseRow(modelRow({[field]:value})).success);return{accepted:true};});
 const legal=[
  {op:'add',kind:'action',subject:'deliverable',title:'Synthetic action',startsOn:'2026-10-15',endsOn:null,note:null,status:null,ownerUserId:null,openEnded:false,dependsOn:[ids.dep],sources:[{section:'facts'},{section:'facts',ref:'fact:synthetic'}]},
  {op:'update',nodeId:ids.node,title:'Synthetic update',note:null,ownerUserId:null,dependsOn:[],sources:[]},
  {op:'remove',nodeId:ids.node},
  {op:'retime',nodeId:ids.node,startsOn:'2026-10-15',endsOn:'2026-10-16'},
  {op:'retime',nodeId:ids.node,startsOn:'2026-10-15'},
  {op:'update',nodeId:ids.node,status:'active',note:'Synthetic note',ownerUserId:'synthetic-owner',endsOn:null}
 ];
 for(let i=0;i<legal.length;i++)await test('legal PlanEdit syntax '+i,'declared-planedit',async()=>{const p=await storeAndRead([legal[i]]);assert(p.parsed.success);return{accepted:true,dtoAccepted:p.dtoAccepted,ownerPersistedUnchanged:p.opsPersistedUnchanged};});
 const node={id:ids.node,kind:'action',subject:'deliverable',title:'Synthetic node',startsOn:'2026-10-01',endsOn:'2026-10-03',status:'draft',ownerUserId:null,dependsOnIds:[]};
 const generated=[
  ['actual overdue retime',checkOverdue([node],'2026-10-14')],
  ['actual dependency range retime',checkDependencySlippage([{...node,id:ids.dep,startsOn:'2026-10-15',endsOn:'2026-10-20'},{...node,startsOn:'2026-10-16',endsOn:'2026-10-17',dependsOnIds:[ids.dep]}],'2026-10-14')],
  ['actual dependency point retime',checkDependencySlippage([{...node,id:ids.dep,startsOn:'2026-10-15',endsOn:'2026-10-20'},{...node,startsOn:'2026-10-16',endsOn:null,dependsOnIds:[ids.dep]}],'2026-10-14')]
 ];
 for(const [name,findings]of generated)await test(name,'actual-watcher-emitter',async()=>{assert(findings.length>0);const ops=findings.flatMap(f=>f.proposedOps||[]);assert(ops.length>0);const p=await storeAndRead(ops);assert(p.parsed.success);return{accepted:true,emittedOps:ops.length};});
 const openJson=[['null operation',[null]],['scalar operation',['synthetic']],['unknown discriminator',[{op:'move'}]],['null title',[{op:'update',nodeId:ids.node,title:null}]],['null startsOn',[{op:'retime',nodeId:ids.node,startsOn:null}]],['numeric nodeId',[{op:'remove',nodeId:42}]],['null source ref',[{op:'update',nodeId:ids.node,sources:[{section:'facts',ref:null}]}]]];
 for(const [name,ops]of openJson)await test('DTO-admitted opaque ops '+name,'specified-admission-read-gap-live-field-unknown',async()=>{const p=await storeAndRead(ops);assert.equal(p.parsed.success,false);return{dtoAccepted:true,ownerPersistedUnchanged:true,listIsArray:true,frontendAccepted:false,issues:issues(p.parsed)};});
 const hypothetical=[
  ['ops JSON null',modelRow({ops:null})],
  ['summary null',modelRow({summary:null})],
  ['status alternate enum',modelRow({status:'pending'})],
  ['risk alternate enum',modelRow({risk:'LOW'})],
  ['missing nullable approvedAt',(()=>{const r=modelRow();delete r.approvedAt;return r;})()],
  ['invalid id',modelRow({id:'synthetic-nonuuid'})]
 ];
 for(const [name,row]of hypothetical)await test('hypothetical noncanonical row '+name,'hypothetical-not-known-live',async()=>{const p=parseRow(row);assert.equal(p.success,false);return{frontendAccepted:false,issues:issues(p)};});
 await test('hypothetical object envelope rejected','hypothetical-not-canonical-list',async()=>{const p=response.safeParse({items:wire([modelRow()])});assert.equal(p.success,false);return{frontendAccepted:false,issues:issues(p)};});
 const report={frontendRef:payload.frontendRef,backendRef:payload.backendRef,backendTree:payload.backendTree,oldMain:payload.oldMain,node:process.version,typescript:ts.version,zod:require('/workspace/capiro-frontend/node_modules/zod/package.json').version,classValidator:require(cvRoot+'/package.json').version,scope:'Selected actual canonical owner create/list/headOf methods and DTO decorators; actual pure Watcher emitter/helper declarations; exact frontend response schema with real Zod; synthetic in-memory transactions/JSON serialization only. Not full DI/HTTP/guards/provider/native/database acceptance. No customer/live payload fetched; no auth/source/ref change.',sourceFingerprints,pinnedSchema:{gitBlob:payload.schema.gitBlob,bytes:payload.schema.bytes,sha256:payload.schema.sha256,statuses,risks},methodSelection:methodNames,watcherSelection:['checkOverdue','checkDependencySlippage'],cases,passed:cases.filter(c=>c.pass).length,failed:cases.filter(c=>!c.pass).length,skipped:0,conclusion:'Pinned model serialization, enums, declared PlanEdit syntax and actual Watcher emissions are compatible. Normal CreateChangeSetDto admission intentionally lacks deep ops validation, canonical create/list preserve that JSON, and the frontend read parser rejects those demonstrated opaque invalid ops. The actual live failing issue path remains unknown; no attribution or parser relaxation follows.'};
 console.log(JSON.stringify(report,null,2));if(report.failed)process.exitCode=1;
})().catch(e=>{console.error(e.stack);process.exitCode=1;});

