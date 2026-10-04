import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {withOwnedApprovedMemory} from '../case12-actual-factory-owner-local-v1/owned-harness.mjs';
const repo='C:/dev/main/meri-c1-20261002',runLabel=process.env.CASE12_LOCAL_QUALIFICATION_RUN??'run-v1';
assert.match(runLabel,/^run-v[1-9][0-9]*$/u);
const out='C:/dev/main/outputs/meri-c2-20261003/case12-compiled-native-composition-local-v1/runs/'+runLabel;
const require=createRequire(repo+'/apps/api/package.json');
const snapshotPath='C:/dev/main/outputs/meri-c2-20261003/case12-actual-factory-owner-local-v1/full510-disposable-state.private.json';
const sha=b=>createHash('sha256').update(b).digest('hex');

/** Test fixture copy only. Preserves canonical contents and the saved historical
 * claim/ledger, but observes new PostgreSQL xmin values. No prior native authority
 * or original setup execution identity is restored by this helper. */
export async function withRestoredLocalCorpus(work,label='v2'){
 assert.match(label,/^[a-z0-9-]{1,60}$/u);
 await mkdir(out,{recursive:true});
 const bytes=await readFile(snapshotPath),snapshot=JSON.parse(bytes);
 assert.equal(snapshot.kind,'case12-owned-disposable-state-snapshot');
 assert.equal(snapshot.scope,'LOCAL_ONLY_NO_AUTHORITY_NO_LIVE_IDENTITIES');
 const recipe=snapshot.recipe,ctx={...recipe.ctx,clerkUserId:recipe.clerkUserId};
 assert.equal(ctx.tenantId,'f2d6cf8f-057c-479a-8110-62fe5086d43f');
 assert.equal(snapshot.tenant.id,ctx.tenantId);
 const beforeFetch=globalThis.fetch;let forbiddenCalls=0;
 globalThis.fetch=async()=>{forbiddenCalls++;throw Error('LOCAL_READ_PROBE_NETWORK_FORBIDDEN');};
 try{return await withOwnedApprovedMemory('C:/dev/main/outputs/meri-c2-20261003/case12-pgvector-local-v1/config.private.json',async h=>{
  const tableOrder=['clio_memory','memory_candidate','memory_items','memory_cleanup_outbox','context_embeddings'];
  const restored=[];
  // Explicit test-data construction only, outside measured/default read scopes.
  // jsonb_populate_record uses each exact reduced-schema table type; identifiers
  // are this fixed source allowlist, never supplied snapshot values.
  await h.deps.prisma.withTenantUser(ctx.tenantId,ctx.userId,async tx=>{
   for(const table of tableOrder){
    const rows=snapshot.rows[table];assert.equal(rows.length,510);assert.ok(rows.every(r=>r.tenant_id===ctx.tenantId));
    await tx.$executeRawUnsafe(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,JSON.stringify(rows));
    const[actual]=await tx.$queryRawUnsafe(`SELECT count(*)::int AS count FROM ${table} WHERE tenant_id=$1::uuid`,ctx.tenantId);assert.equal(actual.count,rows.length);restored.push({table,rows:actual.count,sourceRowsSha256:sha(Buffer.from(JSON.stringify(rows)))});
   }
   await tx.$executeRawUnsafe('UPDATE tenants SET settings_jsonb=$1::jsonb WHERE id=$2::uuid',JSON.stringify(snapshot.tenant.settings),ctx.tenantId);
  });
  const {PrismaService}=require(repo+'/apps/api/dist/prisma/prisma.service.js');
  const prisma=new PrismaService({datasources:{db:{url:h.privateLocalDatabaseUrl}}});
  const native=prisma.withTenantUser.bind(prisma),transactions=[];
  const read=async(name,fn)=>{const start=performance.now();let queries=0;
   try{return await native(ctx.tenantId,ctx.userId,async tx=>{await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${h.ownedSchema}",public`);return fn(new Proxy(tx,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return(...args)=>{if(['$queryRaw','$queryRawUnsafe','$executeRaw','$executeRawUnsafe'].includes(key))queries++;return value.apply(target,args);};}}));});}
   finally{transactions.push({name,durationMs:performance.now()-start,queries,timeoutOverride:null});}
  };
  try{
   const versions=await read('reobserve-restored-versions',tx=>tx.$queryRawUnsafe('SELECT c.id::text AS candidate_id,c.xmin::text AS candidate_version,m.id::text AS item_id,m.xmin::text AS item_version FROM memory_candidate c JOIN memory_items m ON m.id=c.committed_memory_item_id AND m.tenant_id=c.tenant_id WHERE c.tenant_id=$1::uuid ORDER BY c.id',ctx.tenantId));assert.equal(versions.length,510);
   const result=await work({prisma,read,ctx,recipe,snapshot,versions,transactions,privateLocalDatabaseUrl:h.privateLocalDatabaseUrl,ownedSchema:h.ownedSchema});
   assert.equal(forbiddenCalls,0);
   const receipt={kind:'case12-restored-local-read-probe',scope:'TEST_DATA_COPY_ONLY_NOT_ORIGINAL_NATIVE_AUTHORITY',snapshot:{path:snapshotPath,sha256:sha(bytes),bytes:bytes.length},restored,postgresRowVersions:'REOBSERVED_NEW_XMIN',storedClaimAndLedger:'ORIGINAL_JSON_UNCHANGED',defaultReadTimeoutMs:5000,testDataConstructionTimeoutMs:240000,namespaceShim:true,providerCalls:0,cloudCalls:0,transactions,captureAuthority:false,liveAcceptance:'NOT_RUN'};
   await writeFile(out+'/restoration-readback-'+label+'.json',JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});return result;
  }finally{await prisma.$disconnect();}
 });}finally{globalThis.fetch=beforeFetch;}
}
