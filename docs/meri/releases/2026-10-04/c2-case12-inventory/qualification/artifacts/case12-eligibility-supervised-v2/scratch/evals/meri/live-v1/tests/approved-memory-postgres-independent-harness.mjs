import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { memoryFixtureSchemaSql } from './approved-memory-schema.mjs';
import { AUTHORIZED_TENANTS } from '../fixture-provisioning/contract.mjs';
import { buildFixtureManifest } from '../fixture-provisioning/manifest.mjs';
import { createApprovedMemoryFixtureRuntime } from '../fixture-provisioning/approved-memory-runtime.mjs';
export { TENANT,CLIENT,PROPOSER,REVIEWER,OTHER_CLIENT } from './approved-memory-postgres-harness.mjs';
import { TENANT,CLIENT,PROPOSER,REVIEWER,OTHER_CLIENT } from './approved-memory-postgres-harness.mjs';
const require=createRequire('C:/dev/main/meri-c1-20261002/apps/api/package.json');

/** Only the explicitly marked disposable cluster. Per-service commits are needed
 * so actual SQL now() follows actual approval effective_from; never alter clocks. */
export async function withOwnedApprovedMemory(configPath,work) {
  assert.ok(configPath&&isAbsolute(configPath),'Explicit absolute disposable config required');
  let config;try {config=JSON.parse(await readFile(configPath,'utf8'));}catch{throw new Error('Invalid disposable config');}
  assert.ok(config.host==='127.0.0.1'&&config.port===55433&&config.user==='meri_c1_owner'&&config.database==='postgres'&&
    config.scope==='owned local disposable test cluster; no AWS connection'&&isAbsolute(config.dataDirectory)&&typeof config.password==='string'&&config.password.length>0,'Disposable target mismatch');
  const {Client}=require('pg'), {PrismaClient}=require('@prisma/client');
  const probe=new Client({host:config.host,port:config.port,user:config.user,database:config.database,password:config.password,connectionTimeoutMillis:3000});
  try{await probe.connect();}catch{throw new Error('Could not connect to explicit disposable PostgreSQL target');}
  const schema=`meri_approved_${randomUUID().replaceAll('-','')}`,marker=`case12-owned-disposable:${randomUUID()}`;
  const beforeEnv=new Map();let prisma;
  try {
    const actual=(await probe.query(`SELECT current_user=$1 AS owner_matches,host(inet_server_addr()) AS address,
      inet_server_port() AS port,current_setting('data_directory') AS data_directory`,[config.user])).rows[0];
    assert.ok(actual.owner_matches&&actual.address===config.host&&actual.port===config.port&&
      actual.data_directory.replaceAll('\\','/')===config.dataDirectory.replaceAll('\\','/'),'Actual owned database identity mismatch');
    assert.equal((await probe.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount,0,'New random schema must not preexist');
    for(const [key,value] of Object.entries({MERI_SYNTHETIC_FIXTURE_NAMESPACE:'meri-foundation-20260928',MEMORY_GOVERNANCE_LIFECYCLE:'enforce',
      MEMORY_GOVERNANCE_ENFORCE:'enforce',MEMORY_GOVERNANCE_CENTER:'enforce',MEMORY_GOVERNANCE_TENANTS:'all',MEMORY_CLIENT_REVIEW:'true'})){
      beforeEnv.set(key,process.env[key]);process.env[key]=value;
    }
    require('ts-node').register({project:'C:/dev/main/meri-c1-20261002/apps/api/tsconfig.json',transpileOnly:true,experimentalResolver:true});
    const source=name=>require(`C:/dev/main/meri-c1-20261002/apps/api/src/${name}.ts`);
    const {MemoryCandidateService}=source('memory/memory-candidate.service'),{MemoryStoreService}=source('memory/memory-store.service');
    const {TenantContextStore}=source('tenant/tenant-context.store'),{clientMemoryAllowed}=source('memory/memory-wall.helpers');
    const url=new URL(`postgresql://${config.host}:${config.port}/${config.database}`);url.username=config.user;url.password=config.password;url.searchParams.set('schema',schema);
    prisma=new PrismaClient({datasources:{db:{url:url.href}},log:[]});
    await prisma.$transaction(async tx=>{
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await tx.$executeRawUnsafe(`COMMENT ON SCHEMA "${schema}" IS '${marker}'`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      for(const statement of memoryFixtureSchemaSql(schema).split(';').map(s=>s.trim()).filter(Boolean)) await tx.$executeRawUnsafe(statement);
      await tx.$executeRawUnsafe('INSERT INTO tenants VALUES ($1::uuid,$2),($3::uuid,$4)',TENANT,AUTHORIZED_TENANTS.T1.slug,AUTHORIZED_TENANTS.T2.id,AUTHORIZED_TENANTS.T2.slug);
      await tx.$executeRawUnsafe("INSERT INTO tenant_memberships VALUES ($1::uuid,$2::uuid,'active','standard_user'),($1::uuid,$3::uuid,'active','user_admin')",TENANT,PROPOSER,REVIEWER);
      await tx.$executeRawUnsafe('INSERT INTO clients(id,tenant_id) VALUES ($1::uuid,$2::uuid),($3::uuid,$2::uuid)',CLIENT,TENANT,OTHER_CLIENT);
    });
    const metrics={serviceTransactions:0,serviceQueries:0,inspectionTransactions:0,inspectionQueries:0};
    const scoped=(tenantId,userId,callback,options={})=>prisma.$transaction(async tx=>{
      const inspection=options.isolationLevel==='RepeatableRead';
      metrics[inspection?'inspectionTransactions':'serviceTransactions']++;
      const observedTx=new Proxy(tx,{get(target,key,receiver){
        const value=Reflect.get(target,key,receiver);
        return typeof value==='function'&&typeof key==='string'&&/\$(?:queryRaw|executeRaw)/u.test(key)
          ?(...args)=>{metrics[inspection?'inspectionQueries':'serviceQueries']++;return value.apply(target,args);}:value;
      }});
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await tx.$executeRawUnsafe("SELECT set_config('app.current_tenant',$1,true),set_config('app.current_user',$2,true)",tenantId,userId??'');
      return callback(observedTx);
    },{timeout:240000,maxWait:10000,...options});
    const facade={withTenantUser:scoped,withTenant:(tenantId,callback)=>scoped(tenantId,null,callback),withSystem:callback=>scoped('',null,callback)};
    const tenantContext=new TenantContextStore(),memoryStore=new MemoryStoreService(facade,tenantContext);
    const memoryCandidates=new MemoryCandidateService(facade,{}, {get:()=>undefined}),projectionCalls=[];
    memoryCandidates.dispatchProjectionFastPath=(...args)=>{projectionCalls.push(args.slice(0,2));};
    const manifest=await buildFixtureManifest({fixtureInstanceId:randomUUID(),actors:{PAT:{tenantId:'T1',userId:PROPOSER},PRIYA:{tenantId:'T1',userId:REVIEWER}},
      clients:{ASTER:{tenantId:'T1',physicalId:CLIENT},BLUEHAVEN:{tenantId:'T1',physicalId:OTHER_CLIENT},CEDAR:{tenantId:'T2',physicalId:'33333333-3333-4333-8333-333333333333'}}});
    const deps={manifest,memoryCandidates,memoryStore,tenantContext,prisma:facade,proposerForTenant:()=>PROPOSER,reviewerForTenant:()=>REVIEWER,clientMemoryAllowed};
    return await work({runtime:createApprovedMemoryFixtureRuntime(deps),manifest,deps,memoryStore,memoryCandidates,tenantContext,projectionCalls,metrics,
      withInspectionTransaction:callback=>scoped(TENANT,PROPOSER,callback,{isolationLevel:'RepeatableRead'})});
  } finally {
    await prisma?.$disconnect();
    for(const [key,value] of beforeEnv){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    try {
      const rows=(await probe.query(`SELECT n.nspname,n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned,
        obj_description(n.oid,'pg_namespace') AS marker FROM pg_namespace n WHERE n.nspname=$1`,[schema])).rows;
      if(rows.length){assert.equal(rows.length,1);assert.equal(rows[0].owned,true);assert.equal(rows[0].marker,marker);
        assert.match(schema,/^meri_approved_[a-f0-9]{32}$/u);await probe.query(`DROP SCHEMA "${schema}" CASCADE`);}
      assert.equal((await probe.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount,0,'Exact owned schema and all fixture data must be absent');
    }finally{await probe.end();}
  }
}
