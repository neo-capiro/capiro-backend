// Diagnostic discovery only. Never creates a canonical inventory or capture authority.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const hash=value=>createHash('sha256').update(value).digest('hex');
const tenant='f2d6cf8f-057c-479a-8110-62fe5086d43f',actor='b1f758fc-17bd-40f8-bef2-fa2d2380300f';
const keyPattern='^meri-foundation-20260928:([0-9a-f-]{36}:)?APPROVED-MA510(-DISTRACTOR-[0-9]{4})?$';
process.env.DATABASE_URL=execFileSync(process.execPath,['./scripts/lib/pe-compose-database-url.js'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const {PrismaClient}=require('@prisma/client');
const prisma=new PrismaClient({log:[]});
try {
  assert.equal(process.env.RELEASE_SHA,'945179d44223882f9fe1da2fb4e41213bf5813c2');
  const proof=await prisma.$transaction(async tx=>{
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout='5s'");
    await tx.$executeRawUnsafe("SELECT set_config('app.current_tenant',$1,true)",tenant);
    await tx.$executeRawUnsafe("SELECT set_config('app.current_user',$1,true)",actor);
    const context=await tx.$queryRawUnsafe("SELECT current_setting('transaction_read_only') AS read_only,current_setting('app.current_tenant') AS tenant_id,current_setting('app.current_user') AS user_id,current_user AS database_role");
    assert.equal(context.length,1);assert.equal(context[0].read_only,'on');assert.equal(context[0].tenant_id,tenant);assert.equal(context[0].user_id,actor);
    const membership=await tx.$queryRawUnsafe("SELECT tm.role,t.slug FROM tenant_memberships tm JOIN tenants t ON t.id=tm.tenant_id WHERE tm.tenant_id=$1::uuid AND tm.user_id=$2::uuid AND tm.status='active'",tenant,actor);
    assert.equal(membership.length,1);assert.equal(membership[0].role,'standard_user');assert.equal(membership[0].slug,'meri-foundation-20260928-t1');
    const visibility=await tx.$queryRawUnsafe("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner,r.rolsuper,r.rolbypassrls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN pg_roles r WHERE n.nspname='public' AND c.relname IN ('memory_candidate','memory_items') AND r.rolname=current_user ORDER BY c.relname");
    assert.equal(visibility.length,2);
    const policies=await tx.$queryRawUnsafe("SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename IN ('memory_candidate','memory_items') ORDER BY tablename,policyname");
    const counts=await tx.$queryRawUnsafe(`SELECT count(*)::int AS matching_key_count,
      count(*) FILTER (WHERE payload_jsonb->>'source'='meri_synthetic_fixture')::int AS matching_synthetic_source_count,
      count(*) FILTER (WHERE payload_jsonb->>'key' ~ ':APPROVED-MA510$')::int AS root_count
      FROM memory_candidate WHERE tenant_id=$1::uuid AND payload_jsonb->>'key' ~ $2`,tenant,keyPattern);
    assert.equal(counts.length,1);assert.ok(counts[0].matching_key_count<=2000);
    const rows=await tx.$queryRawUnsafe(`SELECT mc.id::text,mc.client_id::text,mc.proposed_by::text,mc.status,mc.governed_status,
      mc.payload_jsonb->>'key' AS key,mc.payload_jsonb->>'source' AS source,mc.payload_jsonb->>'sourceExcerpt' AS excerpt,
      mc.committed_memory_id::text,mc.committed_memory_item_id::text,mc.xmin::text AS candidate_row_version,
      mi.id::text AS item_id,mi.status AS item_status,mi.client_id::text AS item_client_id,mi.source_version,
      mi.source_content_hash,mi.created_at::text AS item_created_at,mi.updated_at::text AS item_updated_at,mi.xmin::text AS item_row_version
      FROM memory_candidate mc LEFT JOIN memory_items mi ON mi.tenant_id=mc.tenant_id AND mi.id=mc.committed_memory_id
      WHERE mc.tenant_id=$1::uuid AND mc.payload_jsonb->>'key' ~ $2 ORDER BY mc.id LIMIT 2001`,tenant,keyPattern);
    assert.equal(rows.length,counts[0].matching_key_count);
    const observations=rows.map(({excerpt,...row})=>{
      let parsed;try{parsed=JSON.parse(excerpt);}catch{}
      return {...row,excerptSha256:typeof excerpt==='string'?hash(excerpt):null,
        marker:parsed?.ownership?.marker??null,markerSha256:parsed?.ownership?.markerSha256??null,
        sourceLogicalId:parsed?.payload?.sourceLogicalId??null,
        canonicalOwnershipVerified:false};
    });
    const hintCounts=await tx.$queryRawUnsafe(`SELECT count(*)::int AS synthetic_candidates,
      count(*) FILTER (WHERE coalesce(payload_jsonb->>'sourceExcerpt','') LIKE '%MA510%')::int AS ma510_excerpt_hints,
      count(*) FILTER (WHERE coalesce(payload_jsonb->>'value','') ILIKE '%autonomous maritime demo%')::int AS phrase_hints
      FROM memory_candidate WHERE tenant_id=$1::uuid AND payload_jsonb->>'source'='meri_synthetic_fixture'`,tenant);
    return {status:'VERIFIED_READ_ONLY_DIAGNOSTIC',tenantId:tenant,actorUserId:actor,context:context[0],visibility,policies,keyPattern,
      counts:counts[0],hintCounts:hintCounts[0],observations,queryCompleteForVisibleKeyPredicate:true,
      scope:'Exact T1 namespace candidate-key discovery under recorded database role, tenant settings and RLS policies; not a general corpus absence proof.',
      canonicalInventoryVerified:false,retrievalEligibilityVerified:false,fixtureReady:false,captureAuthority:false,liveAcceptance:'NOT_RUN'};
  },{timeout:30000,isolationLevel:'RepeatableRead'});
  const value={...proof,sourceSha:process.env.RELEASE_SHA,observedAt:new Date().toISOString(),providerCalls:0,businessWrites:0,acceptanceAuthority:false,readOnlyTransaction:true};
  const bytes=Buffer.from(JSON.stringify(value)+'\n'),encoded=bytes.toString('base64'),count=Math.ceil(encoded.length/6000),meta={sha256:hash(bytes),bytes:bytes.length,chunks:count};
  assert.ok(bytes.length<1024*1024);
  const emit=v=>new Promise((resolve,reject)=>process.stdout.write('C2_CASE12_DISCOVERY '+JSON.stringify(v)+'\n',e=>e?reject(e):resolve()));
  await emit({phase:'BEGIN',...meta});for(let i=0;i<count;i++)await emit({phase:'CHUNK',index:i,data:encoded.slice(i*6000,(i+1)*6000)});await emit({phase:'END',...meta});
} catch(error) {
  console.log('C2_CASE12_DISCOVERY '+JSON.stringify({phase:'FAILURE',status:'UNVERIFIED',errorClass:error?.name==='AssertionError'?'AssertionError':'DISCOVERY_READ_FAILED'}));
  process.exitCode=1;
} finally {await prisma.$disconnect();}
