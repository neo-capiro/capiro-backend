// Fixed shared-database read-only type diagnosis. Never approval, provider, or mutation.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {checkServerIdentity} from 'node:tls';
import {sha256Stable} from '/app/evals/meri/live-v1/artifact-collector.mjs';
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
// BEGIN FIXED CURRENT APPROVAL READBACK (executed verbatim on owned PG).
const CANDIDATE_SQL=`SELECT id::text,status,governed_status,xmin::text AS row_version,committed_memory_id::text AS clio_id,committed_memory_item_id::text AS item_id,decided_by::text AS decided_by,approved_by_user_id::text AS approved_by FROM memory_candidate WHERE tenant_id=$1::uuid AND id=$2::uuid AND proposed_by=$3::uuid`;
const CLIO_SQL=`SELECT id::text,xmin::text AS row_version,updated_at AS source_version,embedding IS NOT NULL AS legacy_embedding_present,key,value,metadata_jsonb FROM clio_memory WHERE tenant_id=$1::uuid AND id=$2::uuid`;
const ITEM_SQL=`SELECT id::text,xmin::text AS row_version,status,governed_status,approved_by_user_id::text AS approved_by,title,sections_jsonb,source_version,source_content_hash FROM memory_items WHERE tenant_id=$1::uuid AND id=$2::uuid`;
const OUTBOX_SQL=`SELECT id::text,memory_item_id::text AS item_id,clio_memory_id::text AS clio_id,operation,status,attempts,idempotency_key,expected_source_version,expected_content_hash,last_error,completed_at,superseded_at,lease_owner IS NOT NULL AS lease_present FROM memory_cleanup_outbox WHERE tenant_id=$1::uuid AND clio_memory_id=$2::uuid ORDER BY created_at,id LIMIT 11`;
const EMBEDDING_SQL=`SELECT id::text,source_id,model,content_hash,embedding IS NOT NULL AS embedding_present FROM context_embeddings WHERE tenant_id=$1::uuid AND source_type='memory_item' AND source_id=$2 ORDER BY id LIMIT 11`;
const AUDIT_SQL=`SELECT id::text,from_status,to_status,actor_user_id::text AS actor_id,memory_item_id::text AS item_id FROM memory_transition_audit WHERE tenant_id=$1::uuid AND memory_candidate_id=$2::uuid ORDER BY occurred_at,id LIMIT 11`;
const SYSTEM_JOB_SQL=`SELECT id::text FROM memory_cleanup_outbox WHERE tenant_id=$1::uuid AND clio_memory_id=$2::uuid AND operation='index_memory_item' AND status IN ('pending','failed') AND expected_source_version IS NOT NULL AND expected_content_hash IS NOT NULL ORDER BY expected_source_version DESC,created_at DESC LIMIT 1`;
const textHash=value=>createHash('sha256').update(value).digest('hex');
const maybeHash=value=>value===null?null:textHash(value);
const date=value=>value===null?null:new Date(value).toISOString();
function projectionText(title,sections){return [title,(Array.isArray(sections)?sections:[]).filter(s=>s.owner==='human'&&s.body?.trim()).map(s=>`${s.heading}: ${s.body}`).join('\n')].filter(Boolean).join('\n').replace(/\s+/g,' ').trim().slice(0,8000);}
async function currentApprovalReadback(client,tenantId,candidateId,proposerId){
 const candidateRows=(await client.query(CANDIDATE_SQL,[tenantId,candidateId,proposerId])).rows;
 assert.equal(candidateRows.length,1);const candidate=candidateRows[0];
 const clioRows=(await client.query(CLIO_SQL,[tenantId,candidate.clio_id])).rows;
 const itemRows=(await client.query(ITEM_SQL,[tenantId,candidate.item_id])).rows;
 assert.ok(clioRows.length<=1&&itemRows.length<=1);
 const clio=clioRows.map(({key,value,metadata_jsonb,source_version,...safe})=>({...safe,source_version:date(source_version),content_sha256:sha256Stable({key,value,metadata:metadata_jsonb})}));
 const items=itemRows.map(({title,sections_jsonb,source_version,source_content_hash,...safe})=>({...safe,source_version_sha256:maybeHash(source_version),source_content_hash_sha256:maybeHash(source_content_hash),projection_content_sha256:textHash(projectionText(title,sections_jsonb))}));
 const jobs=(await client.query(OUTBOX_SQL,[tenantId,candidate.clio_id])).rows;
 const vectors=(await client.query(EMBEDDING_SQL,[tenantId,candidate.item_id])).rows;
 const audits=(await client.query(AUDIT_SQL,[tenantId,candidateId])).rows;
 assert.ok(jobs.length<=10&&vectors.length<=10&&audits.length<=10);
 const outbox=jobs.map(({idempotency_key,last_error,expected_source_version,completed_at,superseded_at,...safe})=>({...safe,expected_source_version:date(expected_source_version),completed_at:date(completed_at),superseded_at:date(superseded_at),idempotency_key_sha256:textHash(idempotency_key),idempotency_matches:`index_memory_item:${candidate.clio_id}:${date(expected_source_version)}:${safe.expected_content_hash}`===idempotency_key,error_present:last_error!==null,error_sha256:maybeHash(last_error)}));
 const embeddings=vectors.map(({model,...safe})=>({...safe,model_sha256:textHash(model),model_is_titan_v2:model==='amazon.titan-embed-text-v2:0',matches_item_content:items.length===1&&safe.content_hash===items[0].projection_content_sha256}));
 return {candidate,clio,items,outbox,embeddings,audits};
}
// END FIXED CURRENT APPROVAL READBACK

const require=createRequire('/app/apps/api/package.json');
const {Client}=require('pg');
const SOURCE='42780caa75fcabe4f83e619ad81c0f36fdda8fad';
const TENANT='f2d6cf8f-057c-479a-8110-62fe5086d43f';
const CANDIDATE='557b5b98-f591-50ce-83ea-2ca44d44567a';
const RUN='c6ffa5ad-dd9f-4912-bc31-a03231a9b903';
const PREFIX='MERI_CASE01_PROJECTION_RECEIPT ';
const CLAIMS={originalClaimSha256:'5fdd382ee4332c3723f801d060c1462b9f4082e5a86fd945c7900fbba25be588',recoveryClaimSha256:'2d51c9ef4f90dbc9bd5e2a98c30c1e70dde09386fb5e6857b0ebb4f2c08d0bc9'};
CLAIMS.continuationClaimSha256='28138f575b12c2d05a7f6ae5acc3496af9479eb4a4e29c0feab7a000dc2ef824';
let client,systemClient,stage='INPUT';
try{
 const {recipe}=JSON.parse(process.env.MERI_CASE01_PROJECTION_INPUT);
 assert.equal(sha256Stable(recipe),'29cc20de9afb70ec31e009afd0b7c3226482f1372b05d2ccec7e86a835ec0142');
 assert.equal(recipe.captureRunId,RUN);assert.equal(recipe.ctx.tenantId,TENANT);
 assert.equal(recipe.fixtureNamespace,'meri-foundation-20260928');
 assert.equal(recipe.reviewerUserId,'fb218bf5-2674-4ced-bca3-7a5d0c01592f');
 assert.equal(process.env.GIT_SHA,SOURCE);assert.equal(process.env.RELEASE_SHA,SOURCE);
 const connectionString=execFileSync(process.execPath,['/app/apps/api/scripts/lib/pe-compose-database-url.js'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
 const options={...rdsTlsOptions(connectionString),application_name:'meri-case01-projection-readonly',connectionTimeoutMillis:15000,query_timeout:15000};
 client=new Client(options);stage='CONNECT';await client.connect();
 assert.equal(client.connection.stream.encrypted,true);assert.equal(client.connection.stream.authorized,true);
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 await client.query("SET LOCAL statement_timeout='10s'");await client.query("SET LOCAL idle_in_transaction_session_timeout='30s'");
 await client.query("SELECT set_config('app.current_tenant',$1,true),set_config('app.current_user',$2,true)",[TENANT,recipe.reviewerUserId]);
 assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');
 stage='OWNED_STATE';
 const owners=await client.query("SELECT slug,settings_jsonb#>'{meriFoundationFixture}' AS fixture FROM tenants WHERE id=$1::uuid",[TENANT]);
 assert.equal(owners.rows.length,1);const {slug,fixture}=owners.rows[0];
 assert.equal(slug,recipe.ctx.tenantSlug);assert.equal(fixture.fixtureNamespace,recipe.fixtureNamespace);
 assert.equal(sha256Stable(fixture.case01ExecutionSetup),CLAIMS.originalClaimSha256);
 assert.equal(sha256Stable(fixture.case01ExecutionSetupRecovery),CLAIMS.recoveryClaimSha256);
 assert.equal(sha256Stable(fixture.case01ExecutionSetupContinuation),CLAIMS.continuationClaimSha256);
 for(const name of ['case01ExecutionSetup','case01ExecutionSetupRecovery','case01ExecutionSetupContinuation'])assert.equal(fixture[name].status,'STARTED');
 stage='CURRENT_APPROVAL';const state=await currentApprovalReadback(client,TENANT,CANDIDATE,recipe.ctx.userId);
 stage='ROLE_POLICY';
 const roles=await client.query("SELECT rolname,rolsuper AS superuser,rolbypassrls AS bypass_rls FROM pg_roles WHERE rolname=current_user");assert.equal(roles.rows.length,1);
 const role={name_sha256:textHash(roles.rows[0].rolname),superuser:roles.rows[0].superuser,bypass_rls:roles.rows[0].bypass_rls};
 const tables=(await client.query("SELECT c.relname AS name,c.relrowsecurity AS rls,c.relforcerowsecurity AS forced,pg_get_userbyid(c.relowner)=current_user AS current_user_owns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('memory_cleanup_outbox','clio_memory','memory_items','context_embeddings') ORDER BY c.relname")).rows;
 const policies=(await client.query("SELECT c.relname AS table_name,p.polname,pg_get_expr(p.polqual,p.polrelid) AS predicate FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('memory_cleanup_outbox','clio_memory','memory_items','context_embeddings') ORDER BY c.relname,p.polname")).rows.map(p=>({table_name:p.table_name,name_sha256:textHash(p.polname),predicate_sha256:textHash(p.predicate??''),mentions_tenant:/(app.current_tenant|current_tenant_id)/u.test(p.predicate??''),mentions_bypass:/(app.bypass_rls|rls_bypass)/u.test(p.predicate??'')}));
 const tenantPending=(await client.query(SYSTEM_JOB_SQL,[TENANT,state.candidate.clio_id])).rows;
 await client.query('ROLLBACK');
 // Exact withSystem GUC on a fresh connection; no tenant/user is fabricated.
 stage='SYSTEM_VISIBILITY';systemClient=new Client(options);await systemClient.connect();
 assert.equal(systemClient.connection.stream.authorized,true);
 await systemClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 await systemClient.query("SET LOCAL statement_timeout='10s'");
 await systemClient.query("SELECT set_config('app.bypass_rls','on',true)");
 assert.equal((await systemClient.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');
 const scope=(await systemClient.query("SELECT current_setting('app.current_tenant',true) AS tenant")).rows[0].tenant;
 async function safeRead(sql,params){
  await systemClient.query('SAVEPOINT visibility_probe');
  try{return {status:'READ',sqlState:null,ids:(await systemClient.query(sql,params)).rows.map(r=>r.id)};}
  catch(error){return {status:'QUERY_FAILED',sqlState:['42501','22P02','42703','42P01'].includes(error?.code)?error.code:null,ids:[]};}
  finally{await systemClient.query('ROLLBACK TO SAVEPOINT visibility_probe');await systemClient.query('RELEASE SAVEPOINT visibility_probe');}
 }
 const systemRead={outbox:await safeRead(SYSTEM_JOB_SQL,[TENANT,state.candidate.clio_id]),
  clio:await safeRead('SELECT id::text FROM clio_memory WHERE tenant_id=$1::uuid AND id=$2::uuid LIMIT 1',[TENANT,state.candidate.clio_id]),
  items:await safeRead('SELECT id::text FROM memory_items WHERE tenant_id=$1::uuid AND id=$2::uuid LIMIT 1',[TENANT,state.candidate.item_id]),
  embeddings:await safeRead("SELECT id::text FROM context_embeddings WHERE tenant_id=$1::uuid AND source_type='memory_item' AND source_id=$2 ORDER BY id LIMIT 11",[TENANT,state.candidate.item_id])};
 assert.ok(systemRead.embeddings.ids.length<=10);
 await systemClient.query('ROLLBACK');
 console.log(PREFIX+JSON.stringify({kind:'meri-case01-projection-readback',schemaVersion:1,status:'READBACK_COMPLETE',readOnly:true,mutations:0,liveAcceptance:'NOT_RUN',sourceSha:SOURCE,captureRunId:RUN,transport:{tlsVerified:true,caBundleSha256:RDS_CA_SHA256},claims:CLAIMS,locatorPresent:Boolean(fixture.case01MemoryOwner),bindingPresent:Boolean(fixture.captureEvidence),state,role,tables,policies,visibility:{tenantPendingJobIds:tenantPending.map(r=>r.id),systemTenantSetting:scope===null?'MISSING':scope===''?'EMPTY':'PRESET',systemRead}}));
}catch(error){
 if(client)await client.query('ROLLBACK').catch(()=>{});
 if(systemClient)await systemClient.query('ROLLBACK').catch(()=>{});
 const code=['42883','42501','22P02','42703','42P01','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID','ETIMEDOUT','ECONNREFUSED','ERR_ASSERTION'].includes(error?.code)?error.code:'READBACK_REFUSED';
 console.log(PREFIX+JSON.stringify({kind:'meri-case01-projection-readback',schemaVersion:1,status:'READBACK_FAILED',readOnly:true,mutations:0,liveAcceptance:'NOT_RUN',stage,code}));process.exitCode=1;
}finally{await client?.end().catch(()=>{});await systemClient?.end().catch(()=>{});}
