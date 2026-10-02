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

// BEGIN FIXED MEMBERSHIP EXPLAIN (executed verbatim on owned PG in tests).
const MEMBERSHIP_SQL = "SELECT user_id::text AS id FROM tenant_memberships WHERE tenant_id=$1::uuid AND user_id=$2::uuid AND status='active' AND role=$3::text FOR SHARE";
async function explainMembership(client, tenantId, reviewerId) {
  const roles = await client.query("SELECT role::text AS role,status::text AS status FROM tenant_memberships WHERE tenant_id=$1::uuid AND user_id=$2::uuid", [tenantId,reviewerId]);
  assert.deepEqual(roles.rows,[{role:'user_admin',status:'active'}]);
  const values=[tenantId,reviewerId,roles.rows[0].role];
  // Explicit parameter ::text preserves Prisma's wire text type. EXPLAIN has
  // no ANALYZE: PostgreSQL only plans the query and never acquires row locks.
  await client.query('SAVEPOINT membership_type_probe');
  let original;
  try {
    await client.query('EXPLAIN (FORMAT JSON) '+MEMBERSHIP_SQL,values);
    original={planned:true,sqlState:null};
  } catch(error) {
    original={planned:false,sqlState:error?.code==='42883'?'42883':null};
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT membership_type_probe');
    await client.query('RELEASE SAVEPOINT membership_type_probe');
  }
  const corrected=MEMBERSHIP_SQL.replace('AND role=$3::text','AND role::text=$3::text');
  const fixed=await client.query('EXPLAIN (FORMAT JSON) '+corrected,values);
  assert.ok(fixed.rows.length>0);
  assert.deepEqual(original,{planned:false,sqlState:'42883'});
  return {parameterType:'text',method:'EXPLAIN_WITHOUT_ANALYZE',original,fixed:{planned:true},
    originalSqlSha256:createHash('sha256').update(MEMBERSHIP_SQL).digest('hex'),
    fixedSqlSha256:createHash('sha256').update(corrected).digest('hex')};
}
// END FIXED MEMBERSHIP EXPLAIN

const require=createRequire('/app/apps/api/package.json');
const {Client}=require('pg');
const SOURCE='c22d059e4fc8fd73f93e6928f7db3a1a4338f7f8';
const TENANT='f2d6cf8f-057c-479a-8110-62fe5086d43f';
const CANDIDATE='557b5b98-f591-50ce-83ea-2ca44d44567a';
const RUN='c6ffa5ad-dd9f-4912-bc31-a03231a9b903';
const PREFIX='MERI_CASE01_ENUM_RECEIPT ';
let client,stage='INPUT';
try {
  const input=JSON.parse(process.env.MERI_CASE01_ENUM_INPUT);
  const recipe=input.recipe;
  assert.equal(sha256Stable(recipe),'29cc20de9afb70ec31e009afd0b7c3226482f1372b05d2ccec7e86a835ec0142');
  assert.equal(recipe.captureRunId,RUN);assert.equal(recipe.ctx.tenantId,TENANT);
  assert.equal(recipe.fixtureNamespace,'meri-foundation-20260928');
  assert.equal(recipe.reviewerUserId,'fb218bf5-2674-4ced-bca3-7a5d0c01592f');
  assert.equal(process.env.GIT_SHA,SOURCE);assert.equal(process.env.RELEASE_SHA,SOURCE);
  const connectionString=execFileSync(process.execPath,['/app/apps/api/scripts/lib/pe-compose-database-url.js'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
  client=new Client({...rdsTlsOptions(connectionString),application_name:'meri-case01-enum-readonly',connectionTimeoutMillis:15000,query_timeout:15000});
  stage='CONNECT';await client.connect();
  assert.equal(client.connection.stream.encrypted,true);assert.equal(client.connection.stream.authorized,true);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='10s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout='30s'");
  await client.query("SELECT set_config('app.current_tenant',$1,true),set_config('app.current_user',$2,true)",[TENANT,recipe.reviewerUserId]);
  assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');
  stage='OWNED_STATE';
  const owners=await client.query("SELECT slug,settings_jsonb#>'{meriFoundationFixture}' AS fixture FROM tenants WHERE id=$1::uuid",[TENANT]);
  assert.equal(owners.rows.length,1);const {slug,fixture}=owners.rows[0];
  assert.equal(slug,recipe.ctx.tenantSlug);assert.equal(fixture.fixtureNamespace,recipe.fixtureNamespace);
  assert.equal(sha256Stable(fixture.case01ExecutionSetup),'5fdd382ee4332c3723f801d060c1462b9f4082e5a86fd945c7900fbba25be588');
  assert.equal(sha256Stable(fixture.case01ExecutionSetupRecovery),'2d51c9ef4f90dbc9bd5e2a98c30c1e70dde09386fb5e6857b0ebb4f2c08d0bc9');
  assert.equal(fixture.case01ExecutionSetup.status,'STARTED');assert.equal(fixture.case01ExecutionSetupRecovery.status,'STARTED');
  assert.equal(Boolean(fixture.case01MemoryOwner),false);assert.equal(Boolean(fixture.captureEvidence),false);
  const candidates=await client.query("SELECT id::text,status,governed_status,xmin::text AS row_version,committed_memory_id IS NULL AS no_projection,committed_memory_item_id IS NULL AS no_item FROM memory_candidate WHERE tenant_id=$1::uuid AND id=$2::uuid AND proposed_by=$3::uuid",[TENANT,CANDIDATE,recipe.ctx.userId]);
  assert.equal(candidates.rows.length,1);const candidate=candidates.rows[0];
  assert.deepEqual(candidate,{id:CANDIDATE,status:'pending',governed_status:'suggested',row_version:'113340385',no_projection:true,no_item:true});
  stage='COLUMN_TYPE';
  const columns=await client.query("SELECT t.typname AS name,t.typtype AS kind,format_type(a.atttypid,a.atttypmod) AS formatted,ARRAY(SELECT e.enumlabel::text FROM pg_enum e WHERE e.enumtypid=t.oid ORDER BY e.enumsortorder) AS labels FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid WHERE a.attrelid='public.tenant_memberships'::regclass AND a.attname='role' AND a.attnum>0 AND NOT a.attisdropped");
  assert.equal(columns.rows.length,1);const roleColumn=columns.rows[0];
  assert.deepEqual(roleColumn,{name:'tenant_role',kind:'e',formatted:'tenant_role',labels:['capiro_admin','user_admin','standard_user','client_portal_user']});
  stage='EXPLAIN';const comparison=await explainMembership(client,TENANT,recipe.reviewerUserId);
  await client.query('ROLLBACK');
  console.log(PREFIX+JSON.stringify({kind:'meri-case01-membership-enum-readback',schemaVersion:1,status:'READBACK_COMPLETE',readOnly:true,mutations:0,liveAcceptance:'NOT_RUN',
    sourceSha:SOURCE,captureRunId:RUN,transport:{tlsVerified:true,caBundleSha256:RDS_CA_SHA256},roleColumn,comparison,
    ownedState:{originalClaimSha256:sha256Stable(fixture.case01ExecutionSetup),recoveryClaimSha256:sha256Stable(fixture.case01ExecutionSetupRecovery),candidate,locatorPresent:false,bindingPresent:false}}));
} catch(error) {
  if(client)await client.query('ROLLBACK').catch(()=>{});
  const code=['42883','42501','42703','42P01','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID','ETIMEDOUT','ECONNREFUSED','ERR_ASSERTION'].includes(error?.code)?error.code:'READBACK_REFUSED';
  console.log(PREFIX+JSON.stringify({kind:'meri-case01-membership-enum-readback',schemaVersion:1,status:'READBACK_FAILED',readOnly:true,mutations:0,liveAcceptance:'NOT_RUN',stage,code}));
  process.exitCode=1;
} finally { await client?.end().catch(()=>{}); }
