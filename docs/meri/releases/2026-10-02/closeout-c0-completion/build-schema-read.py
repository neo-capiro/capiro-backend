import pathlib
repo=pathlib.Path('C:/dev/main/meri-closeout-c0-20261002')
root=pathlib.Path('C:/dev/main/outputs/meri-c0-completion-20261002')
source=(repo/'docs/meri/releases/2026-10-02/live-quality-and-migration-reconciliation/memory-kind-repair/forward450-diagnostic.mjs').read_text(encoding='utf-8')
tls=source.split('// BEGIN FIXED RDS TLS OPTIONS')[1].split('// END FIXED RDS TLS OPTIONS')[0]
tls=tls[tls.index('\n')+1:]
script='''import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkServerIdentity } from 'node:tls';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
'''+tls+'''
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const emit=v=>console.log('MERI_C0_SCHEMA_RECEIPT '+JSON.stringify(v));
const require=createRequire('/app/apps/api/package.json');
const { Client }=require('pg');
let client,stage='CONNECT';
try {
  assert.equal(process.env.RELEASE_SHA,'6be5a560d5addaa1844f0687898c34a249089f76');
  const url=execFileSync(process.execPath,['/app/apps/api/scripts/lib/pe-compose-database-url.js'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
  client=new Client({...rdsTlsOptions(url),application_name:'meri-c0-schema-readonly',connectionTimeoutMillis:15000,query_timeout:10000});
  await client.connect();
  assert.equal(client.connection.stream.authorized,true);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='5s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout='20s'");
  assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');
  stage='CATALOG';
  const ledger=(await client.query('SELECT migration_name,checksum,started_at::text,finished_at::text,rolled_back_at::text,applied_steps_count FROM public._prisma_migrations ORDER BY migration_name,id')).rows;
  const base='/app/apps/api/prisma/migrations';
  const manifest=readdirSync(base).filter(n=>existsSync(base+'/'+n+'/migration.sql')).sort().map(name=>({name,sha256:hash(readFileSync(base+'/'+name+'/migration.sql','utf8'))}));
  const active=ledger.filter(r=>r.finished_at&&!r.rolled_back_at);
  const missing=[],checksumDifferences=[],ambiguous=[];
  for(const m of manifest) {
    const rows=active.filter(r=>r.migration_name===m.name);
    if(rows.length===0) missing.push(m.name);
    else if(rows.length!==1) ambiguous.push(m.name);
    else if(rows[0].checksum!==m.sha256) checksumDifferences.push({name:m.name,source:m.sha256,applied:rows[0].checksum});
  }
  const constraints=(await client.query("SELECT conname,convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.memory_candidate'::regclass AND conname IN ('memory_candidate_source_kind_chk','memory_candidate_version_payload_check') ORDER BY conname")).rows;
  const tables=(await client.query("SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('memory_candidate','memory_items','clio_conversations','clio_messages') ORDER BY table_name,ordinal_position")).rows;
  const objects=(await client.query("SELECT to_regclass('public.memory_candidate')::text AS memory_candidate,to_regclass('public.memory_items')::text AS memory_items,to_regclass('public.clio_conversations')::text AS clio_conversations,to_regclass('public.clio_messages')::text AS clio_messages")).rows[0];
  assert.ok(Object.values(objects).every(Boolean));assert.equal(new Set(tables.map(r=>r.table_name)).size,4);
  stage='SYNTHETIC_CLAIMS';
  await client.query("SELECT set_config('app.current_tenant',$1,true)",['f2d6cf8f-057c-479a-8110-62fe5086d43f']);
  const rows=(await client.query("SELECT settings_jsonb#>'{meriFoundationFixture}' AS fixture FROM tenants WHERE id=$1::uuid AND slug='meri-foundation-20260928-t1'",['f2d6cf8f-057c-479a-8110-62fe5086d43f'])).rows;
  assert.equal(rows.length,1);const fixture=rows[0].fixture;assert.equal(fixture.fixtureNamespace,'meri-foundation-20260928');
  const claims=Object.fromEntries(['case01ExecutionSetup','case01ExecutionSetupRecovery','case01ExecutionSetupContinuation','case01ExecutionSetupPostApproval'].map(name=>[name,{present:fixture[name]!=null,status:fixture[name]?.status??null,sha256:hash(fixture[name]??null)}]));
  await client.query('ROLLBACK');
  emit({status:'READBACK_COMPLETE',observedAt:new Date().toISOString(),readOnly:true,tlsVerified:true,mutations:0,providerCalls:0,sourceSha:process.env.RELEASE_SHA,packagedMigrationCount:manifest.length,packagedManifestSha256:hash(manifest),packagedManifest:manifest,ledgerSha256:hash(ledger),ledger,missingSourceMigrations:missing,ambiguousSourceMigrations:ambiguous,historicalChecksumDifferences:checksumDifferences,unfinished:ledger.filter(r=>!r.finished_at&&!r.rolled_back_at).map(r=>r.migration_name),constraints,objects,columns:tables,syntheticFixtureClaims:claims});
} catch(e) {emit({status:'BLOCKED',stage,code:['42501','57014','42P01','ERR_ASSERTION'].includes(e.code)?e.code:'READONLY_REFUSED',mutations:0,providerCalls:0});process.exitCode=1;}
finally {await client?.end().catch(()=>{});}
'''
(root/'schema-read.mjs').write_text(script,encoding='utf-8',newline='\n')
print('Prepared fixed SELECT-only schema and exact synthetic-claim readback; TLS block reused verbatim.')
