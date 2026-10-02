// Fixed failed-case01 readback. No model, mutation, reset, approval or provider call.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {checkServerIdentity} from 'node:tls';
import {buildFixtureManifest} from '/app/evals/meri/live-v1/fixture-provisioning/manifest.mjs';
import {lifecycleSeedMemoryDefinitions,selectedApprovedMemoryDefinitions} from '/app/evals/meri/live-v1/fixture-provisioning/approved-memory-runtime.mjs';
import {sha256Stable} from '/app/evals/meri/live-v1/artifact-collector.mjs';
import {expectedMemoryCandidatePayload} from '/app/evals/meri/live-v1/fixture-provisioning/memory-candidate-owner.mjs';
import {stableJson} from '/app/evals/meri/live-v1/lib/stable.mjs';
// BEGIN FIXED RDS TLS OPTIONS (exercised verbatim by owned-loopback tests).
const RDS_CA_SHA256='b1711d12bae51838581281e23b6cb97b1074016873b4dafc80ed14002462dd77';
const RDS_CA_PEM=Buffer.from('LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUQvekNDQXVlZ0F3SUJBZ0lSQVBWU01mRml0bU01UGhtYmFPRm9HZlV3RFFZSktvWklodmNOQVFFTEJRQXcKZ1pjeEN6QUpCZ05WQkFZVEFsVlRNU0l3SUFZRFZRUUtEQmxCYldGNmIyNGdWMlZpSUZObGNuWnBZMlZ6TENCSgpibU11TVJNd0VRWURWUVFMREFwQmJXRjZiMjRnVWtSVE1Rc3dDUVlEVlFRSURBSlhRVEV3TUM0R0ExVUVBd3duClFXMWhlbTl1SUZKRVV5QjFjeTFsWVhOMExURWdVbTl2ZENCRFFTQlNVMEV5TURRNElFY3hNUkF3RGdZRFZRUUgKREFkVFpXRjBkR3hsTUNBWERUSXhNRFV5TlRJeU16UTFOMW9ZRHpJd05qRXdOVEkxTWpNek5EVTNXakNCbHpFTApNQWtHQTFVRUJoTUNWVk14SWpBZ0JnTlZCQW9NR1VGdFlYcHZiaUJYWldJZ1UyVnlkbWxqWlhNc0lFbHVZeTR4CkV6QVJCZ05WQkFzTUNrRnRZWHB2YmlCU1JGTXhDekFKQmdOVkJBZ01BbGRCTVRBd0xnWURWUVFERENkQmJXRjYKYjI0Z1VrUlRJSFZ6TFdWaGMzUXRNU0JTYjI5MElFTkJJRkpUUVRJd05EZ2dSekV4RURBT0JnTlZCQWNNQjFObApZWFIwYkdVd2dnRWlNQTBHQ1NxR1NJYjNEUUVCQVFVQUE0SUJEd0F3Z2dFS0FvSUJBUUR1OUg3VEJlR29Eek1yCmR4TjZIOENPbnRKWDRJUjZkYnlobmo1cU1ENHhsL0lXdnA1MGx0MFZwbU1kK3oyUE5aeng4UmF6ZUdDNUluaVYKNW5yTGcwQUtXUlEyQS9sR0dYYlVyR1hDU2UwOWJyTVFDeFdCU0lZZTFXWloxaVUxSUovNkJwNEQyWUVIcFhyVwpiUGtPcTV4M1lQY3NvaXRnbTFYaDh5Z3o2dmI3UHN2SnZQYnZSTW5rRGc1SXFFVGhhcFBqbUtiOFpKV3lFRkVFClFScmtDSVJ1ZUIxRXFRdEp3MGZ2UDRQS0RsQ0pBS0JFcy95MDQ5Rm9PcVlwVDNwUnkwV0txUGhXdmUraFNjTWQKNm9icThreFRGeTFJSEFDakhjNTFuckdJSTVCdDc2L01wVFdobkpJSnJDbnExL1VjM1FzOElWZWIrc0xhRkM4SwpESTY5U3c2YkFnTUJBQUdqUWpCQU1BOEdBMVVkRXdFQi93UUZNQU1CQWY4d0hRWURWUjBPQkJZRUZFN1BDb3B0Cmx5T2d0WFgwWTFsT2JCVXh1S2FDTUE0R0ExVWREd0VCL3dRRUF3SUJoakFOQmdrcWhraUc5dzBCQVFzRkFBT0MKQVFFQUZqK2JYOGdMbU1OZWZyNWpSSmZIanJMM2l1WkNqZjdZRVpnbjg5cFM0ejg0MDhtamo5ejZRNUQxSDd5UwpqTkVUVlY4UWFKaXAxcXloaDVnUnpSYUFyZ0dBWXZpMi9yMHpQc3krVGdmN3YxS0dMNUxoOE5UOGlDRUdHWHdGCmczSXIrTmwzZSs5WFVwMGV5eXpCSWpIdGpMQm02eXk4ckdrOXA2T3RGRFFuS0Y1T3h3YkFnaXA0MkNENzVyL3EKcDQyMW1hRUREdnZSRlI0RCs5OUpaeGdBWURCR3FSUmNlVW9lMTZxRHpiTXZsejBBOXBhQ1pGY2x4ZWZ0QXh2NgpRbFI1ckl0TXovWGR6cEJKVXBZaGR6TTBnQ3pBemRRdVZPNXRqSnhtWGhrU01jRFArOFErVXY2RkE5azJWcFVWCkUvTzVqZ3BxVUpKMkhjLzVyczlWa0FQWGVBPT0KLS0tLS1FTkQgQ0VSVElGSUNBVEUtLS0tLQotLS0tLUJFR0lOIENFUlRJRklDQVRFLS0tLS0KTUlJRi9qQ0NBK2FnQXdJQkFnSVFhUkhhRXFxYWNYTjIwZTh6Wkp0bUREQU5CZ2txaGtpRzl3MEJBUXdGQURDQgpsekVMTUFrR0ExVUVCaE1DVlZNeElqQWdCZ05WQkFvTUdVRnRZWHB2YmlCWFpXSWdVMlZ5ZG1salpYTXNJRWx1Cll5NHhFekFSQmdOVkJBc01Da0Z0WVhwdmJpQlNSRk14Q3pBSkJnTlZCQWdNQWxkQk1UQXdMZ1lEVlFRRERDZEIKYldGNmIyNGdVa1JUSUhWekxXVmhjM1F0TVNCU2IyOTBJRU5CSUZKVFFUUXdPVFlnUnpFeEVEQU9CZ05WQkFjTQpCMU5sWVhSMGJHVXdJQmNOTWpFd05USTFNakl6T0RNMVdoZ1BNakV5TVRBMU1qVXlNek00TXpWYU1JR1hNUXN3CkNRWURWUVFHRXdKVlV6RWlNQ0FHQTFVRUNnd1pRVzFoZW05dUlGZGxZaUJUWlhKMmFXTmxjeXdnU1c1akxqRVQKTUJFR0ExVUVDd3dLUVcxaGVtOXVJRkpFVXpFTE1Ba0dBMVVFQ0F3Q1YwRXhNREF1QmdOVkJBTU1KMEZ0WVhwdgpiaUJTUkZNZ2RYTXRaV0Z6ZEMweElGSnZiM1FnUTBFZ1VsTkJOREE1TmlCSE1URVFNQTRHQTFVRUJ3d0hVMlZoCmRIUnNaVENDQWlJd0RRWUpLb1pJaHZjTkFRRUJCUUFEZ2dJUEFEQ0NBZ29DZ2dJQkFJbmZCQ2FIdXZqNlJiNWMKTDVXbW4xanYyUEh0RUdNSG0rN1o4ZFlvc2R3b3VHOFZHMkErQkNZQ1pmaWo5bElHc3pyVFhrWTRPN3ZuWGdydQpKVU5keGgwUTNNODNwNFgrYmcrZ09EVXMzamYrWjNPZXE3blRPay8yVVl2UUxjeFA0RkVYSUx4REluYlFGY0l4CnllbjFFU0hnZ0dyakVvZGduNm5iS1FOUmZJaGpoVytUS1lhZXdmc1ZXSDdFRjJwZmorY2piSjZuampnWjAvTTkKVlppZkpGQmdhdDZYVVRPZjNqd0h3a0NCaDdUNnJEcGd5MTlBNjFsYUltSkNRaGRUbkhLdnpUcHhjeGlMUmg2OQpaT2J5cFI3VzA0T0FVbUZTODhWN0lvdGxQbUNMOHhmN2t3eEcrZ1FmdngzMStBOUlETXNpVHFKMUNjNGZZRUtnCmJMK1ZvKzJJaTRXMmVzQ1RHVlltSG03M2Ryem5mZUt3TCtrbUlDL0JxK0RyWit2ZVRxS0ZZd1NrcEhSeUpDRWUKVTRaeW02UE9xUS80TEJTS3dEVWhXTEpJbHE5OWJqS1graE5USnlrQitMYmN4MFNjT1A0SUFaUW94bUR4R1d4TgpTK2xRaitDeDJwd1UzUy83K094bFJuZFpBWC9GS2drN3hTTWtnODhIeWtVWmFaL296SWlxSnFTbkdwZ1hDdEVECm9RNE9KdzVvekFyKy93dWRPYXdhTXdVV1FsNWFzRDhmdXkvaGw1UzFudjlYeEljODQyUUpPdEpGeGh5ZU1JWHQKTFZFQ1Z3L2RQZWtoTWpTM1pvM3d3UmdZYm5LRzdZWFhUNVdNeEpFbkh1OCtjWXBNaVJDbHpxMkJFUDYvTXRJMgpBWlFRVUZ1MnlGalJHTDJPWkE2SVlqeG5YWWlSQWdNQkFBR2pRakJBTUE4R0ExVWRFd0VCL3dRRk1BTUJBZjh3CkhRWURWUjBPQkJZRUZBRENjUUNQWDJIbWtxUWNtdUhmaVEyampxbnJNQTRHQTFVZER3RUIvd1FFQXdJQmhqQU4KQmdrcWhraUc5dzBCQVF3RkFBT0NBZ0VBU1hrR1EyZVVtdWRJS1BlT0lGN1JCcnlDb1BtTU9zcVAwKzFxeEY4bApwR2t3bXJnTkRHcG1kOXMwQXJmSVZCVGMxam1wZ0Izb2lSVzljNm4yT213QktMNFVQdVE4TzNLd1NQMGlEMnNaCktNWG9NRXlwaENFelcxSTJHUnZZRHVnTDNaOU1Xcm5Ia29hb0gybDhZeVRZdnN6VHZkZ3hCUHBNMng0cFNrcCsKNzZkNC9lUnBKNW1WdVE5M25DK1lHMHdYQ3hTcTYzaFg0a3laZ1B4Z0NkQUErcWdGZktJR3lOcVVJcVdnZXlUUApuNU9nS2Fib1lrMjE0MVJmMmhHTUQzL2hzR20wcnJKaDdnM0MwWmlyUHdzM2VlSmZ1bHZBT0l5MklaenFIVVNZCmprRnpyYXo2TEVIM0lsQXJUM2pVUHZXS3F2aDJsSldubnA1NmFxeEJSN3FISDV2b0Q0OVVwSldZMUswQmpHblMKT0hjdXJwcDBZdC9CSXM0VlplV2RDWndJN0phU2VEY1BNYU1EQnZORDNJYTVGZ2EwdGhnWVFURzZkRStONWZnRgp6K2hSYXVqWE8ybmIwTG1kZFZ5dkU4cHJZbFdSTXVZRnYrQ284aGNNZEowbEVabGZWTnUwamJtOS9HbXdBWitsCjl1bWVZTzl5ei91QzdlZEM4WEpCZ2xNQUtVbVZLOXdOdE9ja1VXQWNDZm5QV1lMYllhL1BxdFhCWWN4cnNvNWoKaWFTL0E3aUVXNTF1dGVIQkdyVmlDeTFhZkdHK2hpVVd3Rmxlc2xpK1JxNGROc3RYM2g2aDJiYVdBQmFBeEVWSgp5MVJuVFFTejZtUk9UMVZtWlNnU1ZPMzdyZ0l5WTBIZjA4NzJvZ2NUUytGZnZYZ0J4Q3hzTldFYmlRL1hYdmE0CjBXcz0KLS0tLS1FTkQgQ0VSVElGSUNBVEUtLS0tLQotLS0tLUJFR0lOIENFUlRJRklDQVRFLS0tLS0KTUlJQ3JqQ0NBalNnQXdJQkFnSVJBUEFsRWs4VkpQbUV6VlJSYVd2VGgyQXdDZ1lJS29aSXpqMEVBd013Z1pZeApDekFKQmdOVkJBWVRBbFZUTVNJd0lBWURWUVFLREJsQmJXRjZiMjRnVjJWaUlGTmxjblpwWTJWekxDQkpibU11Ck1STXdFUVlEVlFRTERBcEJiV0Y2YjI0Z1VrUlRNUXN3Q1FZRFZRUUlEQUpYUVRFdk1DMEdBMVVFQXd3bVFXMWgKZW05dUlGSkVVeUIxY3kxbFlYTjBMVEVnVW05dmRDQkRRU0JGUTBNek9EUWdSekV4RURBT0JnTlZCQWNNQjFObApZWFIwYkdVd0lCY05NakV3TlRJMU1qSTBNVFUxV2hnUE1qRXlNVEExTWpVeU16UXhOVFZhTUlHV01Rc3dDUVlEClZRUUdFd0pWVXpFaU1DQUdBMVVFQ2d3WlFXMWhlbTl1SUZkbFlpQlRaWEoyYVdObGN5d2dTVzVqTGpFVE1CRUcKQTFVRUN3d0tRVzFoZW05dUlGSkVVekVMTUFrR0ExVUVDQXdDVjBFeEx6QXRCZ05WQkFNTUprRnRZWHB2YmlCUwpSRk1nZFhNdFpXRnpkQzB4SUZKdmIzUWdRMEVnUlVORE16ZzBJRWN4TVJBd0RnWURWUVFIREFkVFpXRjBkR3hsCk1IWXdFQVlIS29aSXpqMENBUVlGSzRFRUFDSURZZ0FFeDV4anJ1cDhJSTRIT0p3MTVOVG5TM0g1eU1yUUdsYmoKRURBNU1NR25FOURtSHA1ZEFDSXhtUFhQTWUvOTluTzd3TmRsN0c3MU9ZUENnRXZXbTBGaGR2VlVlVGIzTFZuVgpCbmFYdDMyRWs3L294R2sxVCtEZjAzQytXMHZtdUord28wSXdRREFQQmdOVkhSTUJBZjhFQlRBREFRSC9NQjBHCkExVWREZ1FXQkJUR1htcUJXTi8xdGtTZWE0cE53MG9IcmprMlVEQU9CZ05WSFE4QkFmOEVCQU1DQVlZd0NnWUkKS29aSXpqMEVBd01EYUFBd1pRSXhBSXFxWldDU3JJa1o3enN2L0Z5Z3RBdXNXNnl2bEw5MzVZQVdZUFZYVTMwbQpqa01GTE0rL1JKOUdNdm5POGpIZkNnSXdCK3dobGtjSXR6RTlDUlE2Q3NNby9kNWNFSERVdS9RVzZqU0loOUJSCk9HaDlwVFlQVmtVYkJpS1BBN2xWVmhyZQotLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tCg==','base64').toString('utf8');
function rdsTlsOptions(connectionString){
  assert.equal(createHash('sha256').update(RDS_CA_PEM).digest('hex'),RDS_CA_SHA256);
  const databaseUrl=new URL(connectionString);
  assert.equal(databaseUrl.protocol,'postgresql:');
  assert.match(databaseUrl.hostname,/^[a-z0-9.-]+\.us-east-1\.rds\.amazonaws\.com$/u);
  assert.equal(databaseUrl.searchParams.get('sslmode'),'require');
  assert.equal(databaseUrl.searchParams.getAll('sslmode').length,1);
  for(const name of databaseUrl.searchParams.keys())assert.ok(['schema','sslmode','connection_limit'].includes(name));
  // pg-connection-string sslmode would replace the explicit ssl object.
  databaseUrl.searchParams.delete('sslmode');
  return {connectionString:databaseUrl.toString(),ssl:{ca:RDS_CA_PEM,rejectUnauthorized:true,
    servername:databaseUrl.hostname,
    checkServerIdentity:(_hostname,certificate)=>checkServerIdentity(databaseUrl.hostname,certificate)}};
}
// END FIXED RDS TLS OPTIONS
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
  stage='GOVERNANCE_CONFIGURATION';
  assert.equal(process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE,namespace);
  for(const key of ['MEMORY_GOVERNANCE_LIFECYCLE','MEMORY_GOVERNANCE_CENTER','MEMORY_GOVERNANCE_ENFORCE','MEMORY_CLIENT_REVIEW'])assert.equal(process.env[key],'enforce');
  const governanceCohort=(process.env.MEMORY_GOVERNANCE_TENANTS??'').split(',');
  assert.ok(governanceCohort.length>0&&governanceCohort.every(id=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)));
  assert.equal(new Set(governanceCohort).size,governanceCohort.length);
  assert.ok(governanceCohort.includes(tenant)&&governanceCohort.includes('52e91176-08f0-4d89-9633-bc212f5bdbbf'));
  const definitions=[];let firstDefinition;
  for(const [generation,fixtureInstanceId] of [['previous',recipe.previousFixtureInstanceId],['current',recipe.currentFixtureInstanceId]]){
    const manifest=await buildFixtureManifest({fixtureInstanceId,clients:recipe.clients,actors:recipe.actors,uploaderActors:{T1:'PAT'}});
    for(const entry of [...lifecycleSeedMemoryDefinitions(manifest,['MA1-v1','MA3']),...selectedApprovedMemoryDefinitions(manifest,['MB1'])]){definitions.push({generation,logicalId:entry.logicalId,id:entry.candidate.physicalId});if(generation==='previous'&&entry.logicalId==='MA1-v1')firstDefinition=entry.candidate;}
    definitions.push({generation,logicalId:'MA2',id:manifest.records.find(r=>r.logicalId==='MA2').physicalId});
  }
  // Capture the existing image's URL composer output only in memory; never log it.
  const connectionString=execFileSync(process.execPath,['/app/apps/api/scripts/lib/pe-compose-database-url.js'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
  client=new Client({...rdsTlsOptions(connectionString),application_name:'meri-case01-readonly-reconcile',connectionTimeoutMillis:15000,query_timeout:15000});
  stage='CONNECT';await client.connect();
  assert.equal(client.connection.stream.encrypted,true);assert.equal(client.connection.stream.authorized,true);
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

  stage='CANDIDATE_GUARD';
  assert.equal(firstDefinition.physicalId,'557b5b98-f591-50ce-83ea-2ca44d44567a');
  const actualRows=await client.query('SELECT mc.*,xmin::text AS row_version FROM memory_candidate mc WHERE tenant_id=$1::uuid AND id=$2::uuid',[tenant,firstDefinition.physicalId]);
  assert.equal(actualRows.rows.length,1);const actual=actualRows.rows[0];
  assert.equal(actual.row_version,'113340385');
  const excerpt=stableJson({ownership:firstDefinition.ownership,payload:firstDefinition.payload});
  const expectedPayload=expectedMemoryCandidatePayload(firstDefinition,recipe.ctx.userId,excerpt);
  const expectedProvenance={tool:'save_memory',tenantId:tenant,userId:recipe.ctx.userId,sourceConversationId:null,sourceMessageId:null,sourceExcerpt:excerpt};
  const {validateSyntheticCandidateFixtureIdentity}=require('/app/apps/api/dist/memory/synthetic-candidate-withdrawal.helpers.js');
  const identity=validateSyntheticCandidateFixtureIdentity(tenant,recipe.ctx.userId,firstDefinition.physicalId,{expectedRowVersion:actual.row_version,expectedPayload});
  // These are the exact scalar predicates in the deployed synthetic pending
  // guard. Actual payload/provenance remain in process; only hashes and static
  // predicate names may appear in the result.
  const expectedFields={id:firstDefinition.physicalId,tenant_id:tenant,proposed_by:recipe.ctx.userId,
    status:'pending',governed_status:'suggested',source_kind:'model_extraction',source_type:'meri_synthetic_fixture',
    source_id:identity.markerSha256,scope:identity.scope,client_id:identity.clientId,
    legal_hold:false,instructions_allowed:false,memory_class:'legacy_unclassified',memory_authority:'legacy_unclassified',
    approved_at:null,approved_by_user_id:null,second_approved_at:null,second_approved_by_user_id:null,
    decided_at:null,decided_by:null,committed_memory_id:null,committed_memory_item_id:null,
    revision_root_id:null,predecessor_candidate_id:null,superseded_by_id:null,revision_number:1,
    duplicate_of_id:null,contradicts_id:null,duplicate_memory_item_id:null,contradicts_memory_item_id:null,
    conflict_status:'none',conflict_group_id:null,confidence:null,memory_scope:'firm',sensitivity:'normal',
    source_ref:null,source_excerpt:null,source_content_hash:null,source_version:null,asserted_by_user_id:null,
    as_of:null,effective_from:null,valid_until:null,expires_at:null,review_cadence_days:null,review_due_at:null,
    controlling_item_id:null,retention_policy_jsonb:null,origin_surface:null,origin_trace_id:null,
    origin_context_packet_id:null,origin_model:null,origin_prompt_version:null};
  const mismatchFields=Object.keys(expectedFields).filter(key=>actual[key]!==expectedFields[key]);
  const expectedPayloadSha256=sha256Stable(expectedPayload),actualPayloadSha256=sha256Stable(actual.payload_jsonb);
  const expectedProvenanceSha256=sha256Stable(expectedProvenance),actualProvenanceSha256=sha256Stable(actual.provenance_jsonb);
  if(actualPayloadSha256!==expectedPayloadSha256)mismatchFields.push('payload_jsonb');
  if(actualProvenanceSha256!==expectedProvenanceSha256)mismatchFields.push('provenance_jsonb');
  const guardAudit={kind:'deployed_pending_candidate_predicate_comparison',candidateId:firstDefinition.physicalId,rowVersion:actual.row_version,
    identityValidated:true,predicateCount:Object.keys(expectedFields).length+2,mismatchFields:mismatchFields.sort(),
    expectedPayloadSha256,actualPayloadSha256,expectedProvenanceSha256,actualProvenanceSha256,
    predicateMatch:mismatchFields.length===0,canonicalGuardExecuted:false};
  stage='CURRENT_AUTHORIZATION';
  // Only the deployed authorization owner's SELECT methods are exposed. The
  // database transaction independently enforces READ ONLY; locks, DML, GUC
  // capability writes and multiple statements are refused by this facade.
  const readSql=async(sql,values)=>{
    assert.equal(typeof sql,'string');assert.match(sql.trim(),/^SELECT\b/iu);
    assert.ok(!/;|\b(?:INSERT|UPDATE|DELETE|MERGE|CALL|COPY|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|FOR\s+(?:SHARE|UPDATE)|set_config|pg_sleep)\b/iu.test(sql));
    return (await client.query(sql,values)).rows;
  };
  const readTx={
    $queryRawUnsafe:(sql,...values)=>readSql(sql,values),
    $queryRaw:(query,...values)=>{
      if(Array.isArray(query)&&Array.isArray(query.raw))return readSql(query.map((part,i)=>part+(i<values.length?'$'+(i+1):'')).join(''),values);
      assert.equal(typeof query?.text,'string');assert.ok(Array.isArray(query.values));return readSql(query.text,query.values);
    },
  };
  const {MemoryAuthorizationService}=require('/app/apps/api/dist/memory/memory-authorization.service.js');
  const authorizationOwner=new MemoryAuthorizationService(Object.freeze({}));
  const reviewer=actors.rows.find(a=>a.id===recipe.reviewerUserId);
  assert.equal(reviewer?.status,'active');assert.equal(reviewer.role,'user_admin');
  const {runWithMemoryGovernanceTenant,memoryGovernanceSelectedForCurrentTenant}=require('/app/apps/api/dist/memory/memory-governance-tenant-scope.js');
  const decision=await runWithMemoryGovernanceTenant(tenant,async()=>{
    assert.equal(memoryGovernanceSelectedForCurrentTenant(),true);
    const subject=await authorizationOwner.loadCandidateInTx(readTx,tenant,firstDefinition.physicalId);assert.ok(subject);
    return authorizationOwner.evaluateInTx(readTx,{tenantId:tenant,userId:reviewer.id,role:reviewer.role},subject,'approve',{emitDenialMetrics:false});
  });
  const reasons=['revoked_or_terminal','legal_hold','not_owner','ethical_wall','wrong_client_scope','archived_client','missing_grant','admin_required','self_review','unsupported_operation'];
  const bases=['owner','tenant_read','explicit_grant','admin'];
  assert.equal(typeof decision.allowed,'boolean');
  if(decision.allowed)assert.ok(bases.includes(decision.basis));else assert.ok(reasons.includes(decision.reason));
  const currentPolicyDecision={owner:'MemoryAuthorizationService.evaluateInTx',operation:'approve',allowed:decision.allowed,
    ...(decision.allowed?{basis:decision.basis}:{reason:decision.reason}),emitDenialMetrics:false,capabilityIssued:false,governanceTenantBound:true};


  stage='OUTBOX_CATALOG';
  const columnRows=await client.query(`SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,
    NOT a.attnotnull AS nullable,pg_get_expr(d.adbin,d.adrelid) AS default_sql
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relname='memory_cleanup_outbox' AND a.attnum>0 AND NOT a.attisdropped
      AND a.attname=ANY($1::text[]) ORDER BY a.attname`,[['expected_source_version','expected_content_hash']]);
  assert.ok(columnRows.rows.length<=2);
  const outboxProjectionColumns=['expected_source_version','expected_content_hash'].map(name=>{
    const found=columnRows.rows.filter(column=>column.name===name);assert.ok(found.length<=1);
    if(!found.length)return {name,exists:false};
    const column=found[0],knownTypes=['timestamp with time zone','character varying(64)','text'];
    assert.equal(typeof column.type,'string');assert.equal(typeof column.nullable,'boolean');
    assert.ok(column.default_sql===null||typeof column.default_sql==='string');
    return {name,exists:true,type:knownTypes.includes(column.type)?column.type:'UNRECOGNIZED',
      ...(knownTypes.includes(column.type)?{}:{typeSha256:hash(column.type)}),nullable:column.nullable,
      defaultPresent:column.default_sql!==null,defaultSql:column.default_sql===null?null:'REDACTED',
      defaultSha256:column.default_sql===null?null:hash(column.default_sql)};
  });

  await client.query('ROLLBACK');
  const result={kind:'meri-case01-readonly-reconciliation',schemaVersion:1,status:'READBACK_COMPLETE',transport:{tlsVerified:true,caBundleSha256:RDS_CA_SHA256},captureRunId:recipe.captureRunId,readOnly:true,mutations:0,claim:{status:row.operation.status,recipeSha256:row.operation.recipeSha256,locatorPresent:row.locator_present,bindingPresent:row.binding_present},guardAudit,currentPolicyDecision,outboxProjectionColumns,actors:actors.rows,grants:grants.rows,walls:walls.rows,expectedCandidates:definitions,candidates:candidates.rows,items:items.rows,outbox:outbox.rows.map(({last_error,...entry})=>({...entry,hasError:!!last_error,errorSha256:last_error?hash(last_error):null,recognizedErrorCode:['memory_embedding_missing','memory_projection_stale','memory_projection_failed'].includes(last_error)?last_error:null})),embeddings:embeddings.rows,liveAcceptance:'NOT_RUN'};
  process.stdout.write('MERI_CASE01_RECONCILE_RECEIPT '+JSON.stringify(result)+'\n');
}catch(error){
  if(client)await client.query('ROLLBACK').catch(()=>{});
  process.stdout.write('MERI_CASE01_RECONCILE_RECEIPT '+JSON.stringify({kind:'meri-case01-readonly-reconciliation',schemaVersion:1,status:'READBACK_FAILED',stage,code:/^[A-Z0-9_]{2,60}$/.test(error?.code??'')?error.code:'SAFE_READ_FAILED',readOnly:true,mutations:0,liveAcceptance:'NOT_RUN'})+'\n');
  process.exitCode=1;
}finally{if(client)await client.end().catch(()=>{});}
