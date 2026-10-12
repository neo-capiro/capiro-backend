'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {TARGET,validateTarget}=require('../cleanup-native-contract-prerequisites-20261012/native-contract-harness.cjs');
const {verifyBindings,loadCanonical,apiRequire,CORE_CLIENT}=require('./canonical-native-loader.cjs');
const {assembleFixture}=require('./fixture-assembly.cjs');
const ENGINE=CORE_CLIENT+'/libquery_engine-debian-openssl-3.0.x.so.node';
const WORKSPACE_CLIENT='/tmp/capirov2-local-native-prerequisite-20261012/workspace-client';
const SCHEMA='capiro_native_prisma_owners_pr2429_20261012';
const OWNER='capiro_native_prisma_owner_20261012';
const APP='capiro_app';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const I={tenant:id(101),otherTenant:id(102),user:id(103),otherUser:id(104),client:id(105),otherClient:id(106),objective:id(107),revision:id(108),draft:id(109),version:id(110),session:id(111),request:id(112),grant:id(113)};
const ctx={tenantId:I.tenant,userId:I.user,clerkUserId:'user_native_prisma_synthetic',tenantSlug:'native-synthetic',role:'standard_user'};
function verifyArtifacts(){
 const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'ENGINE-CLIENT-IDENTITIES.json'),'utf8'));
 for(const client of manifest.clients){
  assert.equal(client.version,'5.22.0');assert.equal(client.schemaByteEquality,true);
  for(const e of client.artifacts){const b=fs.readFileSync(e.path);assert.equal(b.length,e.bytes);assert.equal(createHash('sha256').update(b).digest('hex'),e.sha256);}
 }
 return manifest;
}
function connectionUrl(label,limit){
 const url=new URL(`postgresql://${TARGET.user}@localhost:${TARGET.port}/${TARGET.database}`);
 for(const [key,value] of Object.entries({host:TARGET.socketDirectory,schema:SCHEMA,connection_limit:String(limit),connect_timeout:'3',pool_timeout:'3',socket_timeout:'12',statement_cache_size:'0',sslmode:'disable',application_name:`capiro-native-prisma-${label}`}))url.searchParams.set(key,value);
 assert.equal(url.password,'');assert.equal(url.searchParams.get('host'),TARGET.socketDirectory);return url.toString();
}
function sameTarget(row){for(const key of ['dataDirectory','listenAddresses','inetServerAddr','user','database','systemIdentifier'])assert.equal(row[key],TARGET[key],`Native target mismatch:${key}`);}
const targetSQL=`SELECT current_setting('data_directory') AS "dataDirectory",current_setting('listen_addresses') AS "listenAddresses",inet_server_addr() AS "inetServerAddr",current_user AS "user",current_database() AS "database",system_identifier::text AS "systemIdentifier" FROM pg_control_system()`;
async function nativeGuard(tx,tenantId='',userId=''){
 // Existing maintenance identity is checked before role/GUC/owner mutations.
 sameTarget((await tx.$queryRawUnsafe(targetSQL))[0]);
 assert.equal((await tx.$queryRawUnsafe('SELECT current_schema() AS schema'))[0].schema,SCHEMA);
 await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP}`);
 await tx.$executeRaw`SELECT set_config('app.bypass_rls','off',true)`;
 await tx.$executeRaw`SELECT set_config('app.current_tenant',${tenantId},true),set_config('app.current_user',${userId},true)`;
 const [role]=await tx.$queryRawUnsafe(`SELECT current_user AS name,rolsuper,rolbypassrls,rolinherit,rolcanlogin,pg_has_role(current_user,'${OWNER}','MEMBER') AS owner_member FROM pg_roles WHERE rolname=current_user`);
 assert.deepEqual(role,{name:APP,rolsuper:false,rolbypassrls:false,rolinherit:false,rolcanlogin:false,owner_member:false});
}
async function executeNative(verified,output){
 validateTarget(verified);verifyBindings();const artifacts=verifyArtifacts();
 if(Object.keys(process.env).some(k=>/^PG|DATABASE_URL|SHADOW_DATABASE_URL|PRISMA_ACCELERATE|PRISMA_CLIENT_ENGINE_TYPE/.test(k)))throw new Error('Ambient database/provider configuration refused; use sanitized child environment');
 process.env.PRISMA_QUERY_ENGINE_LIBRARY=ENGINE; // Exact existing hashed library, never a downloader.
 const {Client}=apiRequire('pg');
 const admin=new Client({host:TARGET.socketDirectory,port:TARGET.port,user:TARGET.user,database:TARGET.database,password:'',ssl:false,connectionTimeoutMillis:3000,query_timeout:15000,application_name:'capiro-native-prisma-fixture'});
 let core,workspace,created=false,connected=false;const results=[];
 const errorRecord=e=>({name:e.name,message:e.message,code:e.code??null,meta:e.meta??null,stack:e.stack});
 async function record(name,fn){try{const details=await fn();results.push({name,status:'PASS',details:details??null});console.log(`PASS ${name}`);}catch(e){results.push({name,status:'FAIL',error:errorRecord(e)});console.error(`FAIL ${name}: ${e.code??''} ${e.message}`);throw e;}}
 async function expectSQL(action,sqlstate){await assert.rejects(action,e=>e.code==='P2010'&&e.meta?.code===sqlstate);}
 try{
  await admin.connect();connected=true;sameTarget((await admin.query(targetSQL)).rows[0]);
  const roleRows=(await admin.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])',[[APP,OWNER]])).rows;assert.equal(roleRows.length,0);
  assert.equal((await admin.query('SELECT nspname FROM pg_namespace WHERE nspname=$1',[SCHEMA])).rows.length,0);
  await admin.query(`CREATE ROLE ${OWNER} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; CREATE ROLE ${APP} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; CREATE SCHEMA ${SCHEMA} AUTHORIZATION ${OWNER}; GRANT USAGE ON SCHEMA ${SCHEMA} TO ${APP};`);created=true;
  await admin.query(`SET search_path=${SCHEMA},public; SET ROLE ${OWNER}`);
  for(const p of assembleFixture())await admin.query(p.sql);
  await admin.query('RESET ROLE');
  const owners=loadCanonical();
  const actualCore=apiRequire(CORE_CLIENT),actualWorkspace=apiRequire(WORKSPACE_CLIENT);
  assert.equal(actualCore.Prisma.prismaVersion.client,'5.22.0');assert.equal(actualWorkspace.Prisma.prismaVersion.client,'5.22.0');
  core=new owners.nativePrismaService({datasources:{db:{url:connectionUrl('core',2)}},log:[]});
  workspace=new actualWorkspace.PrismaClient({datasources:{db:{url:connectionUrl('workspace',1)}},log:[]});
  // Do not call either onModuleInit/app bootstrap or overwrite canonical methods.
  const scoped=(tenant,user,fn,options)=>core.withTenantUser(tenant,user,async tx=>{await nativeGuard(tx,tenant,user);return fn(tx);},options);
  const facade={withTenantUser:scoped,$transaction:(fn,options)=>core.$transaction(async tx=>{await nativeGuard(tx);return fn(tx);},options)};
  const snapshot={docTitle:'Native Prisma synthetic newsletter',config:{clientId:I.client,sections:['Update'],sectionContent:{Update:'<p>Saved native snapshot.</p>'}},documents:[{id:id(114),body:{blocks:[]}}]};
  const hash=value=>createHash('sha256').update(owners.workspace.canonicalWorkspaceSnapshot(value)).digest('hex');
  await admin.query('INSERT INTO tenants(id) VALUES($1),($2)',[I.tenant,I.otherTenant]);
  await admin.query('INSERT INTO users(id,clerk_user_id) VALUES($1,$2),($3,$4)',[I.user,ctx.clerkUserId,I.otherUser,'user_native_prisma_other']);
  await admin.query(`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES($1,$2,'standard_user','active'),($3,$4,'standard_user','active')`,[I.tenant,I.user,I.otherTenant,I.otherUser]);
  await admin.query(`INSERT INTO clients(id,tenant_id,name,memory_wall) VALUES($1,$2,'Native synthetic A',true),($3,$4,'Native synthetic B',false)`,[I.client,I.tenant,I.otherClient,I.otherTenant]);
  await admin.query('INSERT INTO client_memory_access(id,tenant_id,client_id,user_id) VALUES($1,$2,$3,$4)',[I.grant,I.tenant,I.client,I.user]);
  await admin.query(`INSERT INTO client_objectives(id,tenant_id,client_id,created_by_user_id,client_request_id,create_request_hash) VALUES($1,$2,$3,$4,gen_random_uuid(),repeat('a',64))`,[I.objective,I.tenant,I.client,I.user]);
  await admin.query(`INSERT INTO client_objective_revisions(id,tenant_id,client_id,objective_id,version,operation,actor_user_id,snapshot) VALUES($1,$2,$3,$4,1,'create',$5,'{}')`,[I.revision,I.tenant,I.client,I.objective,I.user]);
  await admin.query(`INSERT INTO ws_draft(id,tenant_id,owner_id,doc_title,config,updated_at) VALUES($1,$2,$3,'Native synthetic',$4::jsonb,now())`,[I.draft,I.tenant,ctx.clerkUserId,JSON.stringify(snapshot.config)]);
  await admin.query(`INSERT INTO ws_doc_version(id,tenant_id,draft_id,author_id,snapshot) VALUES($1,$2,$3,$4,$5::jsonb)`,[I.version,I.tenant,I.draft,ctx.clerkUserId,JSON.stringify(snapshot)]);
  const spec=owners.campaign.createBlankCampaignSpecV1();spec.sponsor={kind:'client',label:null,clientRefs:[{clientId:I.client}]};
  await admin.query('INSERT INTO outreach_sessions(id,tenant_id,created_by_user_id) VALUES($1,$2,$3)',[I.session,I.tenant,I.user]);
  await admin.query(`INSERT INTO outreach_state_versions(tenant_id,session_id,version,schema_version,spec_jsonb,spec_hash,created_by_user_id) VALUES($1,$2,1,$3,$4::jsonb,$5,$6)`,[I.tenant,I.session,spec.schemaVersion,JSON.stringify(spec),owners.campaign.hashCampaignSpecV1(spec),I.user]);
  const objectiveInput={clientId:I.client,objectiveId:I.objective,objectiveVersion:1};
  const wsInput={tenantId:I.tenant,userId:I.user,clerkUserId:ctx.clerkUserId,draftId:I.draft,versionId:I.version};
  const forbidden=new Proxy({},{get(){throw new Error('Provider/reference port refused');}});
  const engine=new owners.engine(facade,new owners.repository(),new owners.authorization(facade),forbidden,forbidden);
  const input={requestId:I.request,draftId:I.draft,versionId:I.version,snapshotHash:hash(snapshot),expectedStateVersion:1};
  await record('actual PrismaService withTenantUser, scoped ORM and strict role',async()=>scoped(I.tenant,I.user,async tx=>{
   const [guc]=await tx.$queryRaw`SELECT current_setting('app.current_tenant') AS tenant,current_setting('app.current_user') AS actor`;assert.deepEqual(guc,{tenant:I.tenant,actor:I.user});
   // Trusted test-only bypass differentiates the real query extension from RLS.
   await tx.$executeRaw`SELECT set_config('app.bypass_rls','on',true)`;
   assert.deepEqual(await tx.client.findMany({where:{tenantId:I.otherTenant},select:{id:true}}),[{id:I.client}]);
   assert.equal((await tx.$queryRaw`SELECT id FROM clients`).length,2);
   await tx.$executeRaw`SELECT set_config('app.bypass_rls','off',true)`;
   return{queryExtensionObserved:true,trustedBypassTransactionLocal:true};
  }));
  await record('native Prisma actual Objective helper and immutable revision privilege',async()=>{
   assert.equal((await scoped(I.tenant,I.user,tx=>owners.objective.requireClientObjectiveDestinationRevision(tx,ctx,objectiveInput))).objectiveRevisionId,I.revision);
   await expectSQL(()=>scoped(I.tenant,I.user,tx=>tx.$queryRaw`SELECT id FROM client_objective_revisions FOR SHARE`),'42501');
   await assert.rejects(()=>scoped(I.tenant,I.user,tx=>owners.objective.requireClientObjectiveDestinationRevision(tx,{...ctx,clerkUserId:'wrong_subject'},objectiveInput)),e=>e.code==='OBJECTIVE_DESTINATION_NOT_FOUND');
  });
  await record('native Core and Workspace clients execute exact saved revision owner',async()=>{
   const a=await scoped(I.tenant,I.user,tx=>owners.workspace.workspaceSavedOutreachRevisionWithinTx(tx,wsInput));
   const b=await workspace.$transaction(async tx=>{await nativeGuard(tx,I.tenant,I.user);const row=await tx.wsDocVersion.findUnique({where:{id:I.version},select:{id:true,draftId:true,snapshot:true}});assert.equal(row.draftId,I.draft);return owners.workspace.workspaceSavedOutreachRevisionWithinTx(tx,wsInput);});
   assert.equal(hash(a.snapshot),hash(snapshot));assert.equal(hash(b.snapshot),hash(snapshot));assert.equal(b.contentSkeleton.body,'Update\nSaved native snapshot.');
   await expectSQL(()=>scoped(I.tenant,I.user,tx=>tx.$executeRaw`UPDATE ws_doc_version SET label='changed' WHERE id=${I.version}::uuid`),'23514');
  });
  await record('actual native Prisma V3 engine/repository duplicate staging and durable receipt',async()=>{
   const [a,b]=await Promise.all([engine.stageSavedNewsletter(ctx,I.session,input),engine.stageSavedNewsletter(ctx,I.session,input)]);
   assert.equal(a.receiptId,b.receiptId);assert.equal([a,b].filter(x=>x.replayed).length,1);
   const counts=await scoped(I.tenant,I.user,async tx=>({versions:(await tx.$queryRaw`SELECT count(*)::int AS n FROM outreach_state_versions WHERE session_id=${I.session}::uuid`)[0].n,receipts:(await tx.$queryRaw`SELECT count(*)::int AS n FROM outreach_events WHERE command_batch_id=${I.request}::uuid`)[0].n}));
   assert.deepEqual(counts,{versions:2,receipts:1});return{receiptId:a.receiptId,stateVersion:a.stateVersion};
  });
  await record('native Prisma staging hash/id errors and committed revocation before replay',async()=>{
   await assert.rejects(()=>engine.stageSavedNewsletter(ctx,I.session,{...input,snapshotHash:'0'.repeat(64)}),e=>e.code==='OUTREACH_STATE_CONFLICT');
   await assert.rejects(()=>engine.stageSavedNewsletter(ctx,I.session,{...input,expectedStateVersion:2}),e=>e.code==='OUTREACH_COMMAND_ID_REUSE');
   await admin.query('DELETE FROM client_memory_access WHERE id=$1',[I.grant]);
   await assert.rejects(()=>engine.stageSavedNewsletter(ctx,I.session,input),e=>e.code==='OUTREACH_REFERENCE_UNAUTHORIZED');
   await assert.rejects(()=>scoped(I.tenant,I.user,tx=>owners.objective.requireClientObjectiveDestinationRevision(tx,ctx,objectiveInput)),e=>e.code==='OBJECTIVE_DESTINATION_NOT_FOUND');
  });
  await record('actual calendar native Prisma RepeatableRead and ORM SyncRun receipt',async()=>{
   const now=new Date();const evidence=owners.evidence.buildEffectiveDateEvidence({document_number:'2026-23456',type:'RULE',publication_date:'2026-10-01',effective_on:'2026-10-15',pdf_url:'https://www.govinfo.gov/content/pkg/FR-2026-10-01/pdf/2026-23456.pdf',correction_of:null,corrections:[]},now);
   await admin.query(`INSERT INTO federal_register_document(document_number,type,title,publication_date,effective_date,effective_date_evidence,effective_date_observed_at) VALUES('2026-23456','RULE','Native synthetic rule','2026-10-01','2026-10-15',$1::jsonb,$2)`,[JSON.stringify(evidence),now]);
   await admin.query(`INSERT INTO sync_run(source,started_at,finished_at,status,stats_jsonb) VALUES('sync-federal-register-effective-dates',$1,$1,'completed','{"synthetic":true}')`,[now]);
   const result=await new owners.calendar(facade).getEffectiveDateCalendar({dateFrom:'2026-10-01',dateTo:'2026-11-01'});
   assert.equal(result.data[0].date,'2026-10-15');assert.equal(result.coverage.latestRefresh.stats.synthetic,true);assert.equal(result.coverage.complete,false);
   await expectSQL(()=>scoped(I.tenant,I.user,tx=>tx.$executeRaw`UPDATE federal_register_document SET effective_date_evidence='{"schemaVersion":1,"dateKind":null,"documentNumber":"2026-23456"}'::jsonb`),'23514');
   return{dateKind:result.data[0].dateKind,complete:result.coverage.complete,latestRefreshSource:result.coverage.latestRefresh.source};
  });
 }catch(error){if(!results.some(r=>r.status==='FAIL'))results.push({name:'setup/fixture/native initialization',status:'FAIL',error:errorRecord(error)});}
 finally{
  const cleanupErrors=[];
  for(const client of [workspace,core])if(client)try{await client.$disconnect();}catch(e){cleanupErrors.push(errorRecord(e));}
  if(connected){if(created)try{await admin.query(`RESET ROLE; DROP SCHEMA ${SCHEMA} CASCADE; DROP ROLE ${APP}; DROP ROLE ${OWNER}`);}catch(e){cleanupErrors.push(errorRecord(e));}await admin.end();}
  if(cleanupErrors.length)results.push({name:'cleanup',status:'FAIL',errors:cleanupErrors});
 }
 const result={sourceProductHead:'277053c8196dc1be4789c42ea304b0de0553fe00',target:TARGET,schema:SCHEMA,nativePrisma:true,corePrismaServiceActual:true,workspacePrismaServiceBootstrap:false,fullMigrationReplay:false,productionHardening:false,engine:ENGINE,artifacts,results,passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length};
 fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');if(result.failed)process.exitCode=1;return result;
}
async function main(args){
 if(args.length===1&&args[0]==='--plan'){console.log(JSON.stringify({source:verifyBindings().sourceHead,artifacts:verifyArtifacts(),target:TARGET,coreUrl:connectionUrl('core',2),workspaceUrl:connectionUrl('workspace',1),databaseConnected:false,clientConstructed:false,nativeExecutionAuthorized:false},null,2));return;}
 if(args.length!==5||args[0]!=='--run'||args[1]!=='--verified-target'||args[3]!=='--output')throw new Error('Usage: --plan OR --run --verified-target <root receipt> --output <new owned receipt>');
 const output=path.resolve(args[4]);if(!output.startsWith(path.join(__dirname,'evidence')+path.sep)||fs.existsSync(output))throw new Error('Fresh owned output required');
 return executeNative(JSON.parse(fs.readFileSync(args[2],'utf8')),output);
}
module.exports={verifyArtifacts,connectionUrl,main};
if(require.main===module)main(process.argv.slice(2)).catch(e=>{console.error(e.stack);process.exitCode=1;});
