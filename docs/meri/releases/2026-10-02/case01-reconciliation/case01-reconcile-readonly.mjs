// Fixed failed-case01 readback. No model, mutation, reset, approval or provider call.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {buildFixtureManifest} from '/app/evals/meri/live-v1/fixture-provisioning/manifest.mjs';
import {lifecycleSeedMemoryDefinitions,selectedApprovedMemoryDefinitions} from '/app/evals/meri/live-v1/fixture-provisioning/approved-memory-runtime.mjs';
import {sha256Stable} from '/app/evals/meri/live-v1/artifact-collector.mjs';
const require=createRequire('/app/apps/api/package.json');
const {Client}=require('pg');
const namespace='meri-foundation-20260928',tenant='f2d6cf8f-057c-479a-8110-62fe5086d43f';
const hash=value=>createHash('sha256').update(value).digest('hex');
let client,stage='INPUT';
try{
  const input=JSON.parse(process.env.MERI_CASE01_RECONCILE_INPUT);
  const recipe=input.recipe;
  assert.equal(sha256Stable(recipe),'29cc20de9afb70ec31e009afd0b7c3226482f1372b05d2ccec7e86a835ec0142');
  assert.equal(recipe.captureRunId,'c6ffa5ad-dd9f-4912-bc31-a03231a9b903');
  assert.equal(recipe.ctx.tenantId,tenant);assert.equal(recipe.fixtureNamespace,namespace);
  const definitions=[];
  for(const [generation,fixtureInstanceId] of [['previous',recipe.previousFixtureInstanceId],['current',recipe.currentFixtureInstanceId]]){
    const manifest=await buildFixtureManifest({fixtureInstanceId,clients:recipe.clients,actors:recipe.actors,uploaderActors:{T1:'PAT'}});
    for(const entry of [...lifecycleSeedMemoryDefinitions(manifest,['MA1-v1','MA3']),...selectedApprovedMemoryDefinitions(manifest,['MB1'])])definitions.push({generation,logicalId:entry.logicalId,id:entry.candidate.physicalId});
    definitions.push({generation,logicalId:'MA2',id:manifest.records.find(r=>r.logicalId==='MA2').physicalId});
  }
  // Capture the existing image's URL composer output only in memory; never log it.
  const connectionString=execFileSync(process.execPath,['/app/apps/api/scripts/lib/pe-compose-database-url.js'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
  client=new Client({connectionString,application_name:'meri-case01-readonly-reconcile',connectionTimeoutMillis:15000,query_timeout:15000});
  stage='CONNECT';await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='10s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout='30s'");
  await client.query("SELECT set_config('app.current_tenant',$1,true),set_config('app.current_user',$2,true)",[tenant,recipe.ctx.userId]);
  const ro=await client.query('SHOW transaction_read_only');assert.equal(ro.rows[0].transaction_read_only,'on');
  stage='CLAIM';
  const owner=await client.query("SELECT slug,settings_jsonb#>>'{meriFoundationFixture,fixtureNamespace}' AS namespace,settings_jsonb#>'{meriFoundationFixture,case01ExecutionSetup}' AS operation,settings_jsonb#>'{meriFoundationFixture,case01MemoryOwner}' IS NOT NULL AS locator_present,settings_jsonb#>'{meriFoundationFixture,captureEvidence}' IS NOT NULL AS binding_present FROM tenants WHERE id=$1::uuid",[tenant]);
  assert.equal(owner.rows.length,1);const row=owner.rows[0];assert.equal(row.slug,namespace+'-t1');assert.equal(row.namespace,namespace);assert.equal(row.operation.captureRunId,recipe.captureRunId);assert.equal(row.operation.recipeSha256,sha256Stable(recipe));
  const actorIds=[recipe.ctx.userId,recipe.reviewerUserId];
  stage='ACTORS';
  const actors=await client.query("SELECT user_id::text AS id,role,status FROM tenant_memberships WHERE tenant_id=$1::uuid AND user_id=ANY($2::uuid[]) ORDER BY user_id",[tenant,actorIds]);
  const clients=[recipe.clients.ASTER.physicalId,recipe.clients.BLUEHAVEN.physicalId];
  const grants=await client.query("SELECT id::text,user_id::text,client_id::text,permissions,status,expires_at,expires_at>now() AS unexpired,reason IS NOT NULL AND btrim(reason)<>'' AS reason_present FROM memory_access_grant WHERE tenant_id=$1::uuid AND user_id=ANY($2::uuid[]) AND client_id=ANY($3::uuid[]) ORDER BY user_id,client_id,created_at LIMIT 32",[tenant,actorIds,clients]);
  const walls=await client.query('SELECT client_id::text,user_id::text FROM client_memory_access WHERE tenant_id=$1::uuid AND user_id=ANY($2::uuid[]) AND client_id=ANY($3::uuid[]) ORDER BY client_id,user_id',[tenant,actorIds,clients]);
  stage='CANDIDATES';
  const candidates=await client.query('SELECT id::text,proposed_by::text,client_id::text,status,governed_status,committed_memory_id::text,committed_memory_item_id::text,xmin::text AS row_version FROM memory_candidate WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[]) ORDER BY id',[tenant,definitions.map(d=>d.id)]);
  assert.ok(candidates.rows.every(c=>c.proposed_by===recipe.ctx.userId&&clients.includes(c.client_id)));
  const itemIds=candidates.rows.map(c=>c.committed_memory_item_id).filter(Boolean),clioIds=candidates.rows.map(c=>c.committed_memory_id).filter(Boolean);
  stage='ITEMS';
  const items=await client.query('SELECT id::text,status,governed_status,source_type,source_id,source_content_hash,source_version,xmin::text AS row_version FROM memory_items WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[]) ORDER BY id',[tenant,itemIds]);
  stage='OUTBOX';
  const outbox=await client.query('SELECT id::text,memory_item_id::text,clio_memory_id::text,operation,status,attempts,last_error FROM memory_cleanup_outbox WHERE tenant_id=$1::uuid AND (memory_item_id=ANY($2::uuid[]) OR clio_memory_id=ANY($3::uuid[])) ORDER BY id LIMIT 50',[tenant,itemIds,clioIds]);
  stage='EMBEDDINGS';
  const embeddings=await client.query('SELECT source_type,source_id,model,content_hash,count(*)::int AS row_count FROM context_embeddings WHERE tenant_id=$1::uuid AND source_id=ANY($2::text[]) GROUP BY source_type,source_id,model,content_hash ORDER BY source_type,source_id,model LIMIT 50',[tenant,[...itemIds,...clioIds]]);
  await client.query('ROLLBACK');
  const result={kind:'meri-case01-readonly-reconciliation',schemaVersion:1,status:'READBACK_COMPLETE',captureRunId:recipe.captureRunId,readOnly:true,mutations:0,claim:{status:row.operation.status,recipeSha256:row.operation.recipeSha256,locatorPresent:row.locator_present,bindingPresent:row.binding_present},actors:actors.rows,grants:grants.rows,walls:walls.rows,expectedCandidates:definitions,candidates:candidates.rows,items:items.rows,outbox:outbox.rows.map(({last_error,...entry})=>({...entry,hasError:!!last_error,errorSha256:last_error?hash(last_error):null,recognizedErrorCode:['memory_embedding_missing','memory_projection_stale','memory_projection_failed'].includes(last_error)?last_error:null})),embeddings:embeddings.rows,liveAcceptance:'NOT_RUN'};
  process.stdout.write('MERI_CASE01_RECONCILE_RECEIPT '+JSON.stringify(result)+'\n');
}catch(error){
  if(client)await client.query('ROLLBACK').catch(()=>{});
  process.stdout.write('MERI_CASE01_RECONCILE_RECEIPT '+JSON.stringify({kind:'meri-case01-readonly-reconciliation',schemaVersion:1,status:'READBACK_FAILED',stage,code:/^[A-Z0-9_]{2,60}$/.test(error?.code??'')?error.code:'SAFE_READ_FAILED',readOnly:true,mutations:0,liveAcceptance:'NOT_RUN'})+'\n');
  process.exitCode=1;
}finally{if(client)await client.end().catch(()=>{});}
