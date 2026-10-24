/** Actual Prisma/management transactions in a guarded task-owned PG16 fixture.
 * Reuses the existing current-authority fixture's canonical Prisma leaf export;
 * only the new forward migration supplies management columns/receipt guards. */
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Prisma } from '@prisma/client';
import ts from 'typescript';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { manageConversation, readManagementRequest, readManagedConversationMetadata } from './service.js';
import { listManagedConversations } from './list.js';
import { MANAGEMENT_VERSION, TRASH_MS } from './contract.js';

const socket='/tmp/meri-management-pg-20261024/socket',database='core_management_fixture';
const supplied=process.env.MF09_CORE_PG_SOCKET!==undefined||process.env.MF09_CORE_PG_DATABASE!==undefined;
if(supplied&&(process.platform==='win32'||process.env.MF09_CORE_PG_SOCKET!==socket||process.env.MF09_CORE_PG_DATABASE!==database))throw Error('MF09_CORE_PG_TARGET_REFUSED');
const suite=supplied?describe:describe.skip;
const cli='/tools/.pnpm/prisma@5.22.0/node_modules/prisma/build/index.js';
const schema='mf09';
const tenantId=randomUUID(),actorId=randomUUID(),membershipId=randomUUID(),clientId=randomUUID(),grantId=randomUUID();
const ctx={tenantId,userId:actorId,role:'standard_user'} as TenantContext;
const migration=()=>readFileSync(resolve(__dirname,'../../../prisma/migrations/20281024020000_meri_conversation_management/migration.sql'),'utf8');
/** Execute each unchanged owner's actual query predicate against PG. This is
 * deliberately not a full legacy list/message HTTP or projection assay. */
function legacyWhere(file:string,owner:string,query:string,conversationId:string) {
 const text=readFileSync(resolve(__dirname,file),'utf8'),source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
 let body:ts.Node|undefined,expression:ts.Expression|undefined;
 function findOwner(node:ts.Node){
  if((ts.isMethodDeclaration(node)||ts.isFunctionDeclaration(node))&&node.name?.getText(source)===owner)body=node.body;
  else ts.forEachChild(node,findOwner);
 }
 findOwner(source);if(!body)throw Error('Missing canonical legacy owner');
 function findQuery(node:ts.Node){
  if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text===query){
   const argument=node.arguments[0];if(!argument||!ts.isObjectLiteralExpression(argument))throw Error('Unexpected legacy query');
   const where=argument.properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(source)==='where');
   if(where&&ts.isPropertyAssignment(where)){if(expression)throw Error('Ambiguous legacy query');expression=where.initializer;}
  }
  ts.forEachChild(node,findQuery);
 }
 findQuery(body);if(!expression)throw Error('Missing canonical legacy predicate');
 return new Function('ctx','conversationId',`return (${(expression as ts.Expression).getText(source)});`)(ctx,conversationId) as Prisma.ClioConversationWhereInput;
}
suite('MF09 actual PostgreSQL CAS, immutable receipt and current access',()=>{
 const admin=new Pool({host:socket,database,user:'postgres',max:3,connectionTimeoutMillis:3000,statement_timeout:6000});
 let prisma:PrismaService;
 async function waitForBlock(blocker: number, user: string) {
  for(let i=0;i<150;i++){
   const waiting=await admin.query('SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND $2::int=ANY(pg_blocking_pids(pid))',[user,blocker]);
   if(waiting.rowCount)return;
   await new Promise(r=>setTimeout(r,10));
  }
  throw Error('Expected database lock contention was not observed');
 }
 // Pause only at the existing receipt lookup, after the real decision/locks.
 // All transactions and queries still use the actual ordinary-role Prisma owner.
 function pauseAtReceipt() {
  let release!:()=>void,entered!:(pid:number)=>void;
  const gate=new Promise<void>(r=>{release=r;});
  const reached=new Promise<number>(r=>{entered=r;});
  const wrapped={withTenant:(tenant:string,work:(tx:Prisma.TransactionClient)=>Promise<unknown>)=>
   prisma.withTenant(tenant,tx=>work(new Proxy(tx,{get(target,key){
    if(key==='clioConversationManagementReceipt')return new Proxy(target.clioConversationManagementReceipt,{get(model,method){
     if(method==='findUnique')return async(...args:unknown[])=>{
      const identity=await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`;
      entered(identity[0]!.pid);await gate;
      return (model.findUnique as (...args:unknown[])=>unknown).apply(model,args);
     };
     return Reflect.get(model,method);
    }});
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
   }})))};
  return {prisma:wrapped as unknown as PrismaService,reached,release};
 }
 async function chat(client:string|null=null,title='Owned user title'){
  const conversationId=randomUUID();await prisma.withTenant(tenantId,async tx=>{
   await tx.clioConversation.create({data:{id:conversationId,tenantId,userId:actorId,clientId:client,title}});
   await tx.clioConversationBootstrapReceipt.create({data:{tenantId,actorUserId:actorId,requestId:randomUUID(),conversationId,scopeKind:client?'client':'general',clientId:client}});
  });return conversationId;
 }
 const request=(conversationId:string,operation:'rename'|'archive'|'trash'|'restore',revision='0',extra={})=>({version:MANAGEMENT_VERSION,requestId:randomUUID(),conversationId,expectedRevision:revision,operation,...(operation==='rename'?{title:'Renamed by user'}:{}),...extra});
 beforeAll(async()=>{
  const identity=(await admin.query("SELECT current_database() db,current_setting('server_version_num')::int version,current_setting('listen_addresses') listen")).rows[0];
  expect(identity.db).toBe(database);expect(identity.version).toBeGreaterThanOrEqual(160000);expect(identity.version).toBeLessThan(170000);expect(identity.listen).toBe('');
  expect((await admin.query("SELECT 1 FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')")).rowCount).toBe(0);
  await admin.query('ALTER ROLE capiro_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS');
  await admin.query('CREATE EXTENSION IF NOT EXISTS citext; CREATE SCHEMA mf09; GRANT USAGE ON SCHEMA mf09 TO capiro_app');
  const sql=execFileSync(process.execPath,[cli,'migrate','diff','--from-empty','--to-schema-datamodel','/evidence/core-baseline.prisma','--script'],{encoding:'utf8',maxBuffer:32*1024*1024});
  const tables=new Set(['tenants','users','tenant_memberships','clients','client_memory_access','clio_conversations','clio_conversation_bootstrap_receipts']);
  const enumNames=new Set(Prisma.dmmf.datamodel.models.filter(m=>tables.has(m.dbName??m.name)).flatMap(m=>m.fields.filter(f=>f.kind==='enum').map(f=>f.type)));
  const enums=new Set(Prisma.dmmf.datamodel.enums.filter(e=>enumNames.has(e.name)).map(e=>e.dbName??e.name));
  const statements=sql.split(/;\s*(?:\n|$)/).map(s=>s.trim()).filter(s=>{
   const table=s.match(/CREATE TABLE "([^"]+)"/);if(table)return tables.has(table[1]!);
   const enumeration=s.match(/CREATE TYPE "([^"]+)"/);if(enumeration)return enums.has(enumeration[1]!);
   const index=s.match(/CREATE (?:UNIQUE )?INDEX "[^"]+" ON "([^"]+)"/);if(index)return tables.has(index[1]!);
   const fk=s.match(/ALTER TABLE "([^"]+)" ADD CONSTRAINT[^;]+REFERENCES "([^"]+)"/);return Boolean(fk&&tables.has(fk[1]!)&&tables.has(fk[2]!));
  });expect(statements.filter(s=>/CREATE TABLE /.test(s))).toHaveLength(tables.size);
  const c=await admin.connect();try{await c.query('SET search_path TO mf09,public');for(const statement of statements)await c.query(statement);
   const initial=readFileSync(resolve(__dirname,'../../../prisma/migrations/20260501000000_init_identity_tenancy/migration.sql'),'utf8');
   for(const name of ['current_tenant_id','rls_bypass']){const match=initial.match(new RegExp('CREATE OR REPLACE FUNCTION '+name+'\\(\\)[\\s\\S]+?\\$\\$ LANGUAGE plpgsql STABLE;'));if(!match)throw Error('Missing canonical RLS helper');await c.query(match[0]);}
   await c.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA mf09 TO capiro_app');
   await c.query(migration());await c.query(migration());
  }finally{c.release();}
  const url=new URL(`postgresql://capiro_app@localhost/${database}`);url.searchParams.set('host',socket);url.searchParams.set('schema',schema);url.searchParams.set('connection_limit','4');
  prisma=new PrismaService({datasourceUrl:url.href});await prisma.$connect();
  await prisma.tenant.create({data:{id:tenantId,slug:'mf09-local',name:'Synthetic MF09',status:'active',clerkOrgId:'org_mf09_local'}});
  await prisma.user.create({data:{id:actorId,clerkUserId:'user_mf09_local',email:'mf09@example.invalid'}});
  await prisma.withTenant(tenantId,async tx=>{
   await tx.tenantMembership.create({data:{id:membershipId,tenantId,userId:actorId,role:'standard_user',status:'active'}});
   await tx.client.create({data:{id:clientId,tenantId,name:'Synthetic wall',memoryWall:true}});
   await tx.clientMemoryAccess.create({data:{id:grantId,tenantId,clientId,userId:actorId}});
  });
 },60000);
 afterAll(async()=>{await prisma?.$disconnect();await admin.end();});
 test('concurrent distinct commands at one revision commit exactly one title and receipt',async()=>{
  const id=await chat(),a=request(id,'rename'),b=request(id,'rename','0',{title:'Other user title'});
  const results=await Promise.allSettled([manageConversation(prisma,ctx,a),manageConversation(prisma,ctx,b)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect(await readManagedConversationMetadata(prisma,{tenantId,actorId},id)).toMatchObject({revision:'1'});
  expect((await admin.query('SELECT count(*)::int n FROM mf09.clio_conversation_management_receipts WHERE conversation_id=$1',[id])).rows[0].n).toBe(1);
 });
 test('same command replay and lost response readback preserve one exact immutable result',async()=>{
  const id=await chat(),q=request(id,'trash');const results=await Promise.all([manageConversation(prisma,ctx,q),manageConversation(prisma,ctx,q)]);
  expect(results[0]).toEqual(results[1]);const r=await readManagementRequest(prisma,ctx,q);expect(r).toEqual(results[0]);
  expect(Date.parse(r.current.restoreUntil!)-Date.parse(r.current.trashedAt!)).toBe(TRASH_MS);
  await expect(manageConversation(prisma,ctx,{...q,operation:'archive'})).rejects.toThrow('REQUEST_ID_CONFLICT');
  await expect(prisma.withTenant(tenantId,tx=>tx.clioConversationManagementReceipt.update({where:{tenantId_actorUserId_requestId:{tenantId,actorUserId:actorId,requestId:q.requestId}},data:{receipt:{forged:true}}}))).rejects.toThrow();
 });
 test('receipt insertion refusal rolls back metadata, and exact retry can then commit',async()=>{
  const id=await chat(),q=request(id,'rename');await admin.query('REVOKE INSERT ON mf09.clio_conversation_management_receipts FROM capiro_app');
  try{await expect(manageConversation(prisma,ctx,q)).rejects.toThrow();}finally{await admin.query('GRANT INSERT ON mf09.clio_conversation_management_receipts TO capiro_app');}
  expect(await readManagementRequest(prisma,ctx,q)).toMatchObject({receipt:null,current:{revision:'0',title:'Owned user title'}});
  expect((await manageConversation(prisma,ctx,q)).current.revision).toBe('1');
 });
 test('Restore records its exact Trash generation; old retry cannot release a later Trash',async()=>{
  const id=await chat(),trash=request(id,'trash');await manageConversation(prisma,ctx,trash);
  const restore=request(id,'restore','1'),r=await manageConversation(prisma,ctx,restore);expect(r.suppressionRequestId).toBe(trash.requestId);expect(r.releaseRetention).toBe(true);
  await manageConversation(prisma,ctx,request(id,'trash','2'));
  expect(await readManagementRequest(prisma,ctx,restore)).toMatchObject({releaseRetention:false,suppressionRequestId:null,current:{status:'trashed',revision:'3'}});
 });
 test('foreign owner, missing wall and revoked membership refuse without metadata effects',async()=>{
  const id=await chat(clientId),q=request(id,'rename');await expect(manageConversation(prisma,{...ctx,userId:randomUUID()},q)).rejects.toThrow();
  await admin.query('DELETE FROM mf09.client_memory_access WHERE id=$1',[grantId]);await expect(manageConversation(prisma,ctx,q)).rejects.toThrow('Chat not found');
  await admin.query('INSERT INTO mf09.client_memory_access(id,tenant_id,client_id,user_id) VALUES($1,$2,$3,$4)',[grantId,tenantId,clientId,actorId]);
  await admin.query("UPDATE mf09.tenant_memberships SET status='removed' WHERE id=$1",[membershipId]);
  try{await expect(manageConversation(prisma,ctx,q)).rejects.toThrow('Current conversation access unavailable');}finally{await admin.query("UPDATE mf09.tenant_memberships SET status='active' WHERE id=$1",[membershipId]);}
  expect((await readManagedConversationMetadata(prisma,{tenantId,actorId},id)).revision).toBe('0');
 });
 test('membership revocation already holding its row wins before command authority and effects',async()=>{
  const id=await chat(),q=request(id,'archive'),lock=await admin.connect();let pending:Promise<unknown>|undefined;
  try{await lock.query('BEGIN');const pid=(await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   await lock.query('SELECT id FROM mf09.tenant_memberships WHERE id=$1 FOR UPDATE',[membershipId]);
   pending=manageConversation(prisma,ctx,q);pending.catch(()=>{});await waitForBlock(pid,'capiro_app');
   await lock.query("UPDATE mf09.tenant_memberships SET status='removed' WHERE id=$1",[membershipId]);await lock.query('COMMIT');await expect(pending).rejects.toThrow('Current conversation access unavailable');
  }finally{await lock.query('ROLLBACK');lock.release();await pending?.catch(()=>{});await admin.query("UPDATE mf09.tenant_memberships SET status='active' WHERE id=$1",[membershipId]);}
  expect((await readManagedConversationMetadata(prisma,{tenantId,actorId},id)).revision).toBe('0');
 });
 test.each(['membership','tenant','client','wall','grant'] as const)('a %s revocation after the decision serializes after metadata and receipt commit',async kind=>{
  const id=await chat(clientId),q=request(id,'rename'),pause=pauseAtReceipt(),writer=await admin.connect();
  let command:Promise<unknown>|undefined,change:Promise<unknown>|undefined;
  try{
   command=manageConversation(pause.prisma,ctx,q);command.catch(()=>{});const pid=await pause.reached;
   await writer.query('BEGIN');
   change=(async()=>{
    if(kind==='membership')await writer.query("UPDATE mf09.tenant_memberships SET status='removed' WHERE id=$1",[membershipId]);
    else if(kind==='tenant')await writer.query("UPDATE mf09.tenants SET status='suspended' WHERE id=$1",[tenantId]);
    else if(kind==='client')await writer.query("UPDATE mf09.clients SET status='archived' WHERE id=$1",[clientId]);
    else {
     if(kind==='wall')await writer.query('SELECT id FROM mf09.clients WHERE id=$1 FOR UPDATE',[clientId]);
     await writer.query('DELETE FROM mf09.client_memory_access WHERE id=$1',[grantId]);
    }
    await writer.query('COMMIT');
   })();change.catch(()=>{});
   await waitForBlock(pid,'postgres');
   expect((await admin.query('SELECT metadata_revision::text revision FROM mf09.clio_conversations WHERE id=$1',[id])).rows[0].revision).toBe('0');
   pause.release();await command;await change;
   expect((await admin.query('SELECT count(*)::int n FROM mf09.clio_conversation_management_receipts WHERE conversation_id=$1',[id])).rows[0].n).toBe(1);
   await expect(readManagementRequest(prisma,ctx,q)).rejects.toThrow();
  }finally{
   pause.release();await command?.catch(()=>{});await change?.catch(()=>{});await writer.query('ROLLBACK');writer.release();
   await admin.query("UPDATE mf09.tenant_memberships SET status='active' WHERE id=$1",[membershipId]);
   await admin.query("UPDATE mf09.tenants SET status='active' WHERE id=$1",[tenantId]);
   await admin.query("UPDATE mf09.clients SET status='active' WHERE id=$1",[clientId]);
   await admin.query('INSERT INTO mf09.client_memory_access(id,tenant_id,client_id,user_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[grantId,tenantId,clientId,actorId]);
  }
 });
 test('exact replay holds current membership until the immutable receipt read finishes',async()=>{
  const id=await chat(),q=request(id,'archive'),saved=await manageConversation(prisma,ctx,q),pause=pauseAtReceipt();
  const writer=await admin.connect();let read:Promise<unknown>|undefined,change:Promise<unknown>|undefined;
  try{
   read=readManagementRequest(pause.prisma,ctx,q);read.catch(()=>{});const pid=await pause.reached;
   change=writer.query("UPDATE mf09.tenant_memberships SET status='removed' WHERE id=$1",[membershipId]);change.catch(()=>{});
   await waitForBlock(pid,'postgres');pause.release();expect(await read).toEqual(saved);await change;
   await expect(readManagementRequest(prisma,ctx,q)).rejects.toThrow('Current conversation access unavailable');
  }finally{pause.release();await read?.catch(()=>{});await change?.catch(()=>{});writer.release();await admin.query("UPDATE mf09.tenant_memberships SET status='active' WHERE id=$1",[membershipId]);}
 });
 test('a client owner, queued tenant writer and management command complete without a lock-order cycle',async()=>{
  const id=await chat(clientId),q=request(id,'archive'),owner=await admin.connect(),writer=await admin.connect();
  let command:Promise<unknown>|undefined,change:Promise<unknown>|undefined;
  try{
   await owner.query('BEGIN');await owner.query('SELECT id FROM mf09.clients WHERE id=$1 FOR UPDATE',[clientId]);
   const ownerPid=(await owner.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   command=manageConversation(prisma,ctx,q);command.catch(()=>{});await waitForBlock(ownerPid,'capiro_app');
   const writerPid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   let finished=false;
   change=writer.query("UPDATE mf09.tenants SET name=name WHERE id=$1 /* mf09-queued-tenant */",[tenantId]).then(result=>{finished=true;return result;});change.catch(()=>{});
   for(let i=0;i<150&&!finished;i++){
    if((await admin.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND query LIKE '%mf09-queued-tenant%' AND wait_event_type='Lock'",[writerPid])).rowCount)break;
    await new Promise(r=>setTimeout(r,10));
   }
   // Same actor lock shape/order as requireOwnerActor(..., lock=true).
   await owner.query(`SELECT tm.id FROM mf09.tenant_memberships tm JOIN mf09.users u ON u.id=tm.user_id
     JOIN mf09.tenants t ON t.id=tm.tenant_id WHERE tm.tenant_id=$1 AND tm.user_id=$2 FOR SHARE OF tm,u,t`,[tenantId,actorId]);
   await owner.query('COMMIT');await change;expect(await command).toMatchObject({current:{status:'archived',revision:'1'}});
  }finally{await owner.query('ROLLBACK');await command?.catch(()=>{});await change?.catch(()=>{});owner.release();writer.release();}
 });
 test('migration rejects empty or missing policy predicates and accepts the exact restored policy twice',async()=>{
  const c=await admin.connect();
  try{
   await c.query('SET search_path TO mf09,public');
   for(const clause of ['', 'USING (rls_bypass() OR tenant_id=current_tenant_id())', 'WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id())']){
    await c.query('DROP POLICY clio_management_receipts_isolation ON clio_conversation_management_receipts');
    await c.query('CREATE POLICY clio_management_receipts_isolation ON clio_conversation_management_receipts '+clause);
    await expect(c.query(migration())).rejects.toThrow('Conflicting management receipt policy');await c.query('ROLLBACK');
   }
  }finally{
   await c.query('ROLLBACK');
   await c.query('DROP POLICY clio_management_receipts_isolation ON mf09.clio_conversation_management_receipts');
   await c.query(`CREATE POLICY clio_management_receipts_isolation ON mf09.clio_conversation_management_receipts
     USING (mf09.rls_bypass() OR tenant_id=mf09.current_tenant_id()) WITH CHECK (mf09.rls_bypass() OR tenant_id=mf09.current_tenant_id())`);
   await c.query(migration());await c.query(migration());c.release();
  }
 });
 test('title-only search returns owned current metadata and excludes deliberate archive',async()=>{
  const id=await chat(null,'Unique manual needle'),q={version:MANAGEMENT_VERSION,status:'active',title:'manual needle',before:null};
  expect((await listManagedConversations(prisma,ctx,q)).conversations.map(r=>r.conversationId)).toEqual([id]);
  await manageConversation(prisma,ctx,request(id,'archive'));
  expect((await listManagedConversations(prisma,ctx,q)).conversations).toEqual([]);
  expect((await listManagedConversations(prisma,ctx,{...q,status:'archived'})).conversations.map(r=>r.conversationId)).toEqual([id]);
 });
 test.each([false,true])('Trash preserves legacy list/message/current inactive predicates; Restore reactivates (archived=%s)',async archived=>{
  const id=await chat(),listWhere=legacyWhere('../meri.service.ts','listConversations','findMany',id),
   activeWhere=legacyWhere('../../context/application-authority-resource.helpers.ts','loadOwnedActiveClioConversation','findFirst',id);
  const readLegacy=()=>prisma.withTenant(tenantId,async tx=>({
   listed:(await tx.clioConversation.findMany({where:listWhere,select:{id:true}})).some(row=>row.id===id),
   active:await tx.clioConversation.findFirst({where:activeWhere,select:{id:true}}),
  }));
  expect(await readLegacy()).toEqual({listed:true,active:{id}});
  let revision='0',archivedAt:string|null=null;
  if(archived){const r=await manageConversation(prisma,ctx,request(id,'archive'));revision='1';archivedAt=r.current.archivedAt;}
  const trashed=await manageConversation(prisma,ctx,request(id,'trash',revision));
  expect(trashed.current.archivedAt).toBe(archivedAt??trashed.current.trashedAt);
  expect(await readLegacy()).toEqual({listed:false,active:null});
  await manageConversation(prisma,ctx,request(id,'restore',trashed.current.revision));
  expect(await readLegacy()).toEqual({listed:true,active:{id}});
 });
});
