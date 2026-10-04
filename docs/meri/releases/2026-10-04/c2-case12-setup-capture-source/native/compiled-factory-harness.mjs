import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {withRestoredLocalCorpus} from './restore-local-corpus.mjs';
export const repo='C:/dev/main/meri-c1-20261002';
export const out='C:/dev/main/outputs/meri-c2-20261003/case12-compiled-native-composition-local-v1';
export const runLabel=process.env.CASE12_LOCAL_QUALIFICATION_RUN??'run-v1';
assert.match(runLabel,/^run-v[1-9][0-9]*$/u);
export const evidenceDir=out+'/runs/'+runLabel;
export const require=createRequire(repo+'/apps/api/package.json');
export const hash=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
export const save=async(name,value)=>{await mkdir(evidenceDir,{recursive:true});return writeFile(evidenceDir+'/'+name,JSON.stringify(value,null,2)+'\n',{flag:'wx'});};
export const compiled=name=>require(repo+'/apps/api/dist/'+name+'.js');
export async function verifyBuildPins(){
 const pins=JSON.parse(await readFile(out+'/build-pins.json','utf8'));
 assert.equal(pins.status,'ROOT_REVIEWED_SOURCE_AND_FRESH_BUILD');
 const all=[...pins.sourceFiles,...pins.compiledFiles];assert.ok(all.length>=15);
 for(const p of all){assert.ok(p.path.startsWith(repo+'/'));assert.equal(hash(await readFile(p.path)),p.sha256,'Reviewed runtime drift: '+p.path);}
 for(const name of ['memory/case12-synthetic-approved-memory-set.read','memory/memory-authorization.service','meri/meri-case12-capture-authority','meri/meri-case12-setup-completion.read','meri/meri-case12-capture-install','meri/meri-capture-provider-budget-install','meri/meri-case12-capture-readback','meri/meri-capture-clock-packets','meri/meri-case12-native-setup-admission'])assert.ok(pins.compiledFiles.some(p=>p.path===repo+'/apps/api/dist/'+name+'.js'),'Missing final compiled pin '+name);
 assert.ok(pins.compiledFiles.some(p=>p.path.includes('/packages/meriv2-core/dist/')),'Core runtime must be pinned before loading');
 return pins;
}
/** Actual zero-argument native Nest factory, with an explicitly owned local schema.
 * Schema selection is the only transaction shim; native default timeouts remain. */
export async function withCompiledFactory(work,label){
 await verifyBuildPins();
 return withRestoredLocalCorpus(async h=>{
  const saved=new Map(),transactions=[];let factory,phase='FACTORY_CREATE';
  const set={DATABASE_URL:h.privateLocalDatabaseUrl,MEMORY_GOVERNANCE_TENANTS:h.ctx.tenantId+',52e91176-08f0-4d89-9633-bc212f5bdbbf',AWS_EC2_METADATA_DISABLED:'true',INTERNAL_SERVICE_SECRET:'local-native-composition-transcript-key-not-a-live-secret',GIT_SHA:'a'.repeat(40)};
  for(const[k,v]of Object.entries(set)){saved.set(k,process.env[k]);process.env[k]=v;}
  try{
   const {createCase01SetupDependencies}=await import(pathToFileURL(repo+'/apps/api/scripts/meri-case01-setup-dependencies.mjs').href);
   factory=await createCase01SetupDependencies();
   assert.equal(typeof factory.deps.assertSyntheticApprovedMemorySetInTx,'function');
   assert.equal(typeof factory.deps.memoryAuthorization.readCase12ItemsWithDecisionsInTx,'function');
   for(const[name,index]of [['withTenant',1],['withTenantUser',2]]){
    const native=factory.deps.prisma[name].bind(factory.deps.prisma);
    factory.deps.prisma[name]=async(...args)=>{
     assert.equal(args[index+1]?.timeoutMs,undefined,'No transaction timeout override permitted');
     const callback=args[index],start=performance.now(),capturedPhase=phase;let queries=0;
     try{return await native(...args.map((arg,i)=>i===index?async tx=>{
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${h.ownedSchema}",public`);
      const proxy=new Proxy(tx,{get(target,key){const value=Reflect.get(target,key);if(typeof value==='function')return(...params)=>{if(['$queryRaw','$queryRawUnsafe','$executeRaw','$executeRawUnsafe'].includes(key))queries++;return value.apply(target,params);};if(value&&typeof value==='object')return new Proxy(value,{get(model,method){const fn=Reflect.get(model,method);return typeof fn==='function'? (...params)=>{queries++;return fn.apply(model,params);}:fn;}});return value;}});
      return callback(proxy);
     }:arg));}finally{transactions.push({phase:capturedPhase,method:name,durationMs:performance.now()-start,queries,timeoutOverride:null});}
    };
   }
   const run=fn=>factory.runWithTenant(h.ctx,fn);
   const tx=(name,fn)=>{phase=name;return run(()=>factory.deps.prisma.withTenantUser(h.ctx.tenantId,h.ctx.userId,fn));};
   await tx('LOCAL_SCHEMA_COMPLEMENT',async tx=>{
    // Only fields selected by actual native Prisma readers are added to the
    // reduced disposable schema. No claim of production migration/RLS parity.
    await tx.$executeRawUnsafe('ALTER TABLE tenant_memberships ADD COLUMN id uuid DEFAULT gen_random_uuid()');
    await tx.$executeRawUnsafe("CREATE TYPE membership_status AS ENUM ('invited','active','removed')");
    await tx.$executeRawUnsafe('ALTER TABLE tenant_memberships ALTER COLUMN status TYPE membership_status USING status::membership_status');
    await tx.$executeRawUnsafe('ALTER TABLE client_memory_access ADD COLUMN id uuid DEFAULT gen_random_uuid()');
    await tx.$executeRawUnsafe("ALTER TABLE clients ADD COLUMN name text DEFAULT 'Aster Synthetic Local'");
    await tx.$executeRawUnsafe('CREATE TABLE clio_conversations(id uuid PRIMARY KEY,tenant_id uuid,user_id uuid,client_id uuid,title text,status text DEFAULT \'active\',metadata_jsonb jsonb DEFAULT \'{}\',archived_at timestamptz,created_at timestamptz DEFAULT clock_timestamp(),updated_at timestamptz DEFAULT clock_timestamp())');
    await tx.$executeRawUnsafe('CREATE TABLE clio_messages(id uuid PRIMARY KEY,tenant_id uuid,user_id uuid,client_id uuid,conversation_id uuid,role text,body text,metadata_jsonb jsonb DEFAULT \'{}\',created_at timestamptz DEFAULT clock_timestamp())');
    await tx.$executeRawUnsafe("CREATE TABLE context_packet(id uuid PRIMARY KEY,tenant_id uuid,surface varchar(24),user_id uuid,client_id uuid,ref_jsonb jsonb DEFAULT '{}',model_policy_jsonb jsonb DEFAULT '{}',packet_version integer DEFAULT 2,trace_id varchar(160),effective_tenant_id uuid,actor_user_id uuid,created_at timestamptz DEFAULT clock_timestamp())");
   });
   const result=await work({...h,factory,run,tx,transactions,setPhase:p=>phase=p});
   await verifyBuildPins();return result;
  }catch(error){await save('failure-'+label+'.json',{phase,name:error.constructor?.name,code:error.code??null,message:/^(meri_|CASE12_|Assertion)/u.test(error.message??'')?error.message:null,stackFrames:String(error.stack??'').split('\n').slice(1,12),transactions,liveAcceptance:'NOT_RUN'});throw error;}
  finally{try{await factory?.close();}finally{for(const[k,v]of saved){if(v===undefined)delete process.env[k];else process.env[k]=v;}}}
 },label);
}
