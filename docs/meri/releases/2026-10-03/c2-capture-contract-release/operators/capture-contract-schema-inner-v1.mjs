// Read-only migration ledger/index proof in the current immutable served API image. No writes.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?`[${v.map(canonical).join(',')}]`:`{${Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')}}`;
const hash=v=>createHash('sha256').update(v).digest('hex');
process.env.DATABASE_URL=execFileSync(process.execPath,['./scripts/lib/pe-compose-database-url.js'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const {PrismaClient}=require('@prisma/client');
const prisma=new PrismaClient({log:[]});
try {
  const proof=await prisma.$transaction(async tx=>{
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout='5s'");
    const rows=await tx.$queryRawUnsafe('SELECT id,migration_name,checksum,started_at::text AS started_at,finished_at::text AS finished_at,rolled_back_at::text AS rolled_back_at,applied_steps_count FROM public._prisma_migrations ORDER BY migration_name,id');
    const name='20281007010000_mail_messages_owned_connection_active';
    assert.equal(rows.length,609);assert.equal(rows.filter(r=>r.finished_at!==null&&r.rolled_back_at===null).length,509);
    assert.equal(rows.filter(r=>r.rolled_back_at!==null).length,100);assert.equal(rows.filter(r=>r.finished_at===null&&r.rolled_back_at===null).length,0);
    const priorSha256=hash(canonical(rows.filter(r=>r.migration_name!==name)));
    assert.equal(priorSha256,'9a82cbc9dcecc3b049c312ad4e39ec5a96eb33c6e5af033a3339d1e292c06e90');
    const added=rows.filter(r=>r.migration_name===name);assert.equal(added.length,1);
    assert.equal(added[0].checksum,'ef10ab58b4eef6825652690a098ab160a374fb30c4cc0af9f15793edb7237242');
    assert.ok(added[0].finished_at);assert.equal(added[0].rolled_back_at,null);assert.equal(added[0].applied_steps_count,1);
    const indices=await tx.$queryRawUnsafe("SELECT c.relname AS name,i.indisvalid AND i.indisready AS ready,pg_get_indexdef(c.oid) AS definition FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid WHERE c.oid IN ('public.mail_messages_tenant_connection_active_idx'::regclass,'public.mail_threads_tenant_connection_id_cover_idx'::regclass) ORDER BY c.relname");
    assert.equal(indices.length,2);for(const index of indices) assert.equal(index.ready,true);
    assert.equal(hash(indices[0].definition),'23d2b35e8097cea6c5620ce2c9c1cab68467e9de09dba5e3337f6fca0a170688');
    assert.equal(hash(indices[1].definition),'7097d64ec1650dfa8e004e89a1e2f6f267cb7924e869993bb44fb235e9716c9e');
    const retired=await tx.$queryRawUnsafe("SELECT to_regclass('public.meri_agent_runs') IS NULL AND to_regclass('public.legiwatch_saved_view') IS NULL AS absent");assert.equal(retired[0].absent,true);
    return {status:'VERIFIED_READ_ONLY',ledgerRows:rows.length,activeFinished:509,rolledBack:100,prior608Sha256:priorSha256,newMigration:name,newMigrationSha256:added[0].checksum,retirementTablesAbsent:true,indices:indices.map(i=>({name:i.name,ready:i.ready,definitionSha256:hash(i.definition)})),migrationExecution:false};
  });
  console.log('C2_CAPTURE_CONTRACT_SCHEMA '+JSON.stringify(proof));
} catch(error) {
  console.log('C2_CAPTURE_CONTRACT_SCHEMA '+JSON.stringify({status:'UNVERIFIED',errorClass:error?.name==='AssertionError'?'AssertionError':'SCHEMA_READ_FAILED'}));
  process.exitCode=1;
} finally { await prisma.$disconnect(); }
