// Root-only fixed forward450 migration; no resolve/reset/seed or direct ledger DML.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {checkServerIdentity} from 'node:tls';
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

const NAME='20281005010000_memory_version_candidate_source_kinds';
const TENANT='f2d6cf8f-057c-479a-8110-62fe5086d43f';
const CHECKS=['memory_candidate_source_kind_chk','memory_candidate_version_payload_check'];
const CLAIMS=['case01ExecutionSetup','case01ExecutionSetupRecovery','case01ExecutionSetupContinuation','case01ExecutionSetupPostApproval'];
const HASH=/^[a-f0-9]{64}$/u,SHA=/^[a-f0-9]{40}$/u;
const canonical=v=>v instanceof Date?JSON.stringify(v.toISOString()):v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?`[${v.map(canonical).join(',')}]`:`{${Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')}}`;
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const stableHash=value=>hash(canonical(value));
const PREFIX='MERI_FORWARD450_RECEIPT ';
export function validateInput(value){
 assert.deepEqual(Object.keys(value).sort(),['afterCheckSha256','beforeCheckSha256','claimSha256','manifestSha256','migrationSha256','sourceSha','version']);
 assert.equal(value.version,1);assert.match(value.sourceSha,SHA);
 for(const name of ['manifestSha256','migrationSha256'])assert.match(value[name],HASH);
 for(const key of ['beforeCheckSha256','afterCheckSha256']){
  assert.deepEqual(Object.keys(value[key]).sort(),CHECKS);for(const name of CHECKS)assert.match(value[key][name],HASH);
 }
 assert.deepEqual(Object.keys(value.claimSha256).sort(),[...CLAIMS].sort());
 for(const name of CLAIMS)assert.match(value.claimSha256[name],HASH);
 return value;
}
export const LEDGER_SQL=`SELECT id,migration_name,checksum,started_at::text AS started_at,finished_at::text AS finished_at,rolled_back_at::text AS rolled_back_at,applied_steps_count
 FROM public._prisma_migrations ORDER BY migration_name,id`;
export const CHECK_SQL=`SELECT conname AS name,convalidated AS validated,pg_get_constraintdef(oid) AS definition
 FROM pg_constraint WHERE conrelid='public.memory_candidate'::regclass
 AND conname IN ('memory_candidate_source_kind_chk','memory_candidate_version_payload_check') ORDER BY conname`;
export const LOCK_SQL=`SELECT count(*)::int AS count FROM pg_locks
 WHERE pid<>pg_backend_pid() AND relation IN ('public.memory_candidate'::regclass,'public._prisma_migrations'::regclass)
 AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`;
export function checkLedger(rows,manifest){
 assert.equal(rows.length,manifest.length);assert.deepEqual(rows.map(r=>r.migration_name),manifest.map(m=>m.name));
 for(let i=0;i<rows.length;i++){
  assert.equal(rows[i].checksum,manifest[i].sha256);assert.ok(rows[i].finished_at);assert.equal(rows[i].rolled_back_at,null);
 }
 return stableHash(rows);
}
export function checkCatalog(rows,pins){
 assert.deepEqual(rows.map(r=>r.name),CHECKS);
 for(const row of rows){assert.equal(row.validated,true);assert.equal(hash(row.definition),pins[row.name]);}
 return Object.fromEntries(rows.map(r=>[r.name,hash(r.definition)]));
}
export async function readState(client,input,manifest,after){
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await client.query("SET LOCAL statement_timeout='5s'");await client.query("SET LOCAL idle_in_transaction_session_timeout='20s'");
  assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');
  const ledger=(await client.query(LEDGER_SQL)).rows;
  checkLedger(ledger,after?manifest:manifest.slice(0,-1));
  const checks=checkCatalog((await client.query(CHECK_SQL)).rows,after?input.afterCheckSha256:input.beforeCheckSha256);
  // Exact current tenant claim hashes only; no customer/business rows are selected.
  await client.query("SELECT set_config('app.current_tenant',$1,true)",[TENANT]);
  const claims=(await client.query("SELECT settings_jsonb#>'{meriFoundationFixture}' AS fixture FROM tenants WHERE id=$1::uuid AND slug='meri-foundation-20260928-t1'",[TENANT])).rows;
  assert.equal(claims.length,1);assert.equal(claims[0].fixture?.fixtureNamespace,'meri-foundation-20260928');
  for(const name of CLAIMS)assert.equal(stableHash(claims[0].fixture[name]),input.claimSha256[name]);
  if(!after){
   const roles=(await client.query("SELECT relname,pg_has_role(current_user,relowner,'USAGE') AS owner FROM pg_class WHERE oid IN ('public.memory_candidate'::regclass,'public._prisma_migrations'::regclass) ORDER BY relname")).rows;
   assert.equal(roles.length,2);assert.ok(roles.every(r=>r.owner===true));
   assert.equal((await client.query(LOCK_SQL)).rows[0].count,0);
  }
  return {ledger,checks,claimSha256:input.claimSha256};
 }finally{await client.query('ROLLBACK');}
}
export function packagedManifest(directory,input){
 const names=readdirSync(directory).filter(n=>existsSync(`${directory}/${n}/migration.sql`)).sort();
 assert.equal(names.length,450);assert.equal(names.at(-1),NAME);
 const manifest=names.map(name=>({name,sha256:hash(readFileSync(`${directory}/${name}/migration.sql`))}));
 assert.equal(hash(JSON.stringify(manifest)),input.manifestSha256);assert.equal(manifest.at(-1).sha256,input.migrationSha256);
 const sql=readFileSync(`${directory}/${NAME}/migration.sql`,'utf8');
 assert.match(sql,/\bBEGIN\s*;/u);assert.match(sql,/SET LOCAL lock_timeout/u);assert.match(sql,/SET LOCAL statement_timeout/u);assert.match(sql,/\bCOMMIT\s*;/u);
 return manifest;
}
export async function main(){
 let stage='INPUT',client,attempted=false;
 const emit=value=>console.log(PREFIX+JSON.stringify(value));
 try{
  const raw=process.env.MERI_FORWARD450_INPUT;assert.ok(typeof raw==='string'&&Buffer.byteLength(raw)<=6000);
  const input=validateInput(JSON.parse(raw));assert.equal(process.env.GIT_SHA,input.sourceSha);assert.equal(process.env.RELEASE_SHA,input.sourceSha);
  const manifest=packagedManifest('/app/apps/api/prisma/migrations',input);
  const require=createRequire('/app/apps/api/package.json'),{Client}=require('pg');
  const connectionString=execFileSync(process.execPath,['/app/apps/api/scripts/lib/pe-compose-database-url.js'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
  const options={...rdsTlsOptions(connectionString),application_name:'meri-forward450-preflight',connectionTimeoutMillis:15000,query_timeout:10000};
  stage='PREFLIGHT';client=new Client(options);await client.connect();
  assert.equal(client.connection.stream.encrypted,true);assert.equal(client.connection.stream.authorized,true);
  const before=await readState(client,input,manifest,false);await client.end();client=undefined;
  emit({version:1,kind:'meri-forward450',stage:'PREFLIGHT',status:'VERIFIED',sourceSha:input.sourceSha,appliedCount:449,
   oldLedgerSha256:stableHash(before.ledger),checks:before.checks,claimSha256:input.claimSha256,tlsVerified:true});
  // Exclusive task-local claim and durable host task intent prevent retries; Prisma owns normal ledger writes.
  writeFileSync('/dev/shm/meri-forward450-once','claimed\n',{flag:'wx',mode:0o600});
  const cert='/dev/shm/meri-forward450-rds-ca.pem';writeFileSync(cert,RDS_CA_PEM,{flag:'wx',mode:0o600});
  const url=new URL(connectionString);url.searchParams.set('sslmode','require');url.searchParams.set('sslaccept','strict');url.searchParams.set('sslcert',cert);
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!(/^(DATABASE_URL|DIRECT_URL|PG|PRISMA_MIGRATE|AWS|CLERK|OPENAI|OPENROUTER|ANTHROPIC)/iu.test(k))));
  Object.assign(env,{DATABASE_URL:url.toString(),PRISMA_HIDE_UPDATE_MESSAGE:'1',CHECKPOINT_DISABLE:'1'});
  stage='PRISMA_DEPLOY';emit({version:1,kind:'meri-forward450',stage,status:'INTENT',sourceSha:input.sourceSha,migrationSha256:input.migrationSha256});
  attempted=true;
  const run=spawnSync(process.execPath,[require.resolve('prisma'),'migrate','deploy','--schema','/app/apps/api/prisma/schema.prisma'],
   {cwd:'/app/apps/api',env,encoding:'utf8',timeout:180000,maxBuffer:2*1024*1024});
  // Never print Prisma stderr/stdout, URL, query or possible parameter values.
  const output=String(run.stdout??'')+String(run.stderr??'');
  assert.equal(run.status,0);assert.equal(run.error,undefined);
  assert.ok(output.includes('All migrations have been successfully applied.'));
  stage='POSTCHECK';client=new Client(options);await client.connect();
  assert.equal(client.connection.stream.authorized,true);
  const after=await readState(client,input,manifest,true);
  assert.equal(stableHash(after.ledger.slice(0,-1)),stableHash(before.ledger));
  emit({version:1,kind:'meri-forward450',stage:'COMPLETE',status:'VERIFIED',sourceSha:input.sourceSha,appliedCount:450,
   newMigration:NAME,migrationSha256:input.migrationSha256,manifestSha256:input.manifestSha256,
   oldLedgerSha256:stableHash(before.ledger),oldLedgerUnchanged:true,checks:after.checks,claimSha256:input.claimSha256,
   prismaExitCode:0,prismaOutputSha256:hash(output),fixtureClaimsUnchanged:true,tlsVerified:true});
  return 0;
 }catch(error){
  const code=['23514','42883','42501','55P03','57014','40P01','40001','42P01','42703','P3009','P3018','ETIMEDOUT','ERR_ASSERTION'].includes(error?.code)?error.code:'FORWARD450_REFUSED';
  emit({version:1,kind:'meri-forward450',stage,status:attempted?'RECONCILIATION_REQUIRED':'BLOCKED',code,prismaAttempted:attempted,retryAllowed:false});return 1;
 }finally{await client?.end().catch(()=>{});}
}
if(process.env.MERI_FORWARD450_INPUT!==undefined)process.exitCode=await main();
