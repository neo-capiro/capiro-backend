/** Explicitly synthetic, rollback-only proof of the observed contract. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from 'pg';
import { awardKey, canonicalJson, payloadHash, mapObservedSamAction, observedTransactionInput, SAM_OBSERVED_ACTION_CONTRACT } from '../lib/sam-contract-action.js';
import { qualifiedMember, populationManifestHash, type ObservedAction } from '../lib/sam-action-projection.js';
import { buildAcquisitionIdentity } from '../../src/program-element/acquisition-continuity/acquisition-identity.js';
const ROOT='C:/dev/defproc-release1-backend';
const OUT='C:/dev/defproc-release1-evidence';
const DIRECTORY='C:/ProgramData/Hermes/profiles/kanbanqa/cache/scratch/pg16-fixture/data';
const MIGRATION=`${ROOT}/apps/api/prisma/migrations/20281105010000_defproc_observed_actions/migration.sql`;
const MAPPER=`${ROOT}/apps/api/scripts/lib/sam-contract-action.ts`;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const clock=(day:number)=>`2026-11-${String(day).padStart(2,'0')}T00:00:00.000000Z`;
const uid='CONT_AWD_OBSR1_9700_-NONE-_-NONE-', key=awardKey(uid)!;
const record=(mod:string,money:string,label:string|null)=>({contractId:{piid:'OBSR1',subtier:{code:'9700'},modificationNumber:mod,transactionNumber:'1'},
 coreData:{awardOrIDV:'AWARD',awardOrIDVType:{code:'B'},federalOrganization:{fundingInformation:{fundingDepartment:{code:'1200',name:'SYNTHETIC FUNDING'}},contractingInformation:{contractingDepartment:{code:'9700',name:'SYNTHETIC CONTRACTING'}}}},
 awardDetails:{dollars:{actionObligation:money},dates:{dateSigned:'2025-10-03'},transactionData:{lastModifiedDate:label}}});
async function snapshot(c:Client){
 const tables:Record<string,unknown>={};
 for(const table of ['public.acquisition_award_transaction_revision','public.acquisition_record_revision','public.federal_award','public.defproc_producer_qualification_v2','public.defproc_producer_qualification_member_v2','defproc_v2_private.target_binding']){
  tables[table]=(await c.query(`SELECT count(*)::text n,md5(coalesce(string_agg(to_jsonb(t)::text,chr(10) ORDER BY to_jsonb(t)::text COLLATE "C"),'')) hash FROM ${table} t`)).rows[0];
 }
 const functions=(await c.query(`SELECT p.oid::regprocedure::text signature,p.proowner::regrole::text owner,p.proacl::text acl,pg_get_functiondef(p.oid) definition
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind='f' AND (n.nspname='defproc_v2_private' OR (n.nspname='public' AND p.proname LIKE 'defproc_%')) ORDER BY p.oid`)).rows;
 const constraints=(await c.query(`SELECT conname,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='public.defproc_producer_qualification_v2'::regclass ORDER BY conname`)).rows;
 return {tables,functions,constraints};
}
async function append(c:Client, records:ReturnType<typeof record>[], seen:string){
 await c.query('SET CONSTRAINTS ALL DEFERRED');
 const run={contract:SAM_OBSERVED_ACTION_CONTRACT,producerCommit:'e'.repeat(40),imageDigest:`sha256:${'e'.repeat(64)}`,runId:`synthetic-observed-${randomUUID()}`,targetId:'fixture-target-1'};
 const ids:string[]=[]; let completedAt=seen;
 for(const source of records){
  const original=canonicalJson(source);
  const mapped=mapObservedSamAction(source,[{piid:'OBSR1',awardUniqueId:uid,identityKey:key}]);assert(mapped.ok);
  const input=observedTransactionInput(source,mapped.value,run,seen);assert.equal(canonicalJson(source),original);
  assert.equal(input.raw.sourcePayload,source);assert(!('sourceRevisionOrder' in input.raw.acquisitionProvenance));
  const identity=buildAcquisitionIdentity({source:'sam_gov',recordKind:'modification',transactionId:input.sourceTransactionId});assert(identity.ok);
  const id=randomUUID();ids.push(id);
  const previous=(await c.query('SELECT id,revision,recorded_at FROM public.acquisition_award_transaction_revision WHERE transaction_identity_key=$1 ORDER BY revision DESC LIMIT 1',[identity.identity.key])).rows[0];
  const recordedAt=new Date(Math.max(Date.parse(seen),previous ? new Date(previous.recorded_at).getTime()+1 : 0)).toISOString();
  completedAt=recordedAt;
  await c.query(`INSERT INTO public.acquisition_award_transaction_revision
   (id,transaction_identity_key,award_identity_key,source_system,source_transaction_id,piid,modification_number,action_date,
    signed_obligation_delta,signed_outlay_delta,source_observed_at,recorded_at,source_url,content_hash,raw_jsonb,supersedes_id,revision)
   VALUES ($1,$2,$3,'sam_gov',$4,$5,$6,$7,$8,NULL,$9,$15,$10,$11,$12::jsonb,$13,$14)`,
   [id,identity.identity.key,key,input.sourceTransactionId,input.piid,input.modificationNumber,input.actionDate,input.signedObligationDelta,seen,input.sourceUrl,payloadHash(input),JSON.stringify(input.raw),previous?.id??null,(previous?.revision??0)+1,recordedAt]);
 }
 const rows=(await c.query<{row:ObservedAction}>('SELECT defproc_v2_private.row_object(t) row FROM public.acquisition_award_transaction_revision t WHERE id=ANY($1::uuid[])',[ids])).rows;
 const members=rows.map(({row})=>{
  const member=qualifiedMember(row);const raw=row.raw as {sourcePayload:unknown};
  assert.equal(member.sourcePayloadHash,payloadHash(raw.sourcePayload));assert.equal(member.rowContentHash,payloadHash(row));
  return {...member,reviewedCanonical:canonicalJson(row),payloadCanonical:canonicalJson(raw.sourcePayload)};
 });
 await c.query('SELECT defproc_v2_private.seal_population($1::jsonb,$2::jsonb)',[JSON.stringify({contract_id:run.contract,producer_commit:run.producerCommit,image_digest:run.imageDigest,run_id:run.runId,target_id:run.targetId,
 completed_at:completedAt,approved_at:completedAt,revoked_at:null,award_identity_keys:[key],member_count:members.length,manifest_sha256:populationManifestHash(members),evidence_sha256:payloadHash({syntheticOnly:true,ids}),scope_description:'Synthetic observed contract proof; not publisher or serving acceptance'}),JSON.stringify(members)]);
 await c.query('SET CONSTRAINTS ALL IMMEDIATE');
}
async function read(c:Client,at:string,details=true){
 await c.query('SET LOCAL ROLE capiro_app');
 try{return (await c.query('SELECT public.defproc_observed_money_flow_v1($1,$2,$3) result',[[key],new Date(Date.parse(at)+1000).toISOString().replace('Z','000Z'),details])).rows[0].result;}
 finally{await c.query('RESET ROLE').catch(()=>{});}
}
async function main(){
 assert.equal(process.env.DEFPROC_LOCAL_OBSERVED_TEST,'1','explicit local observed opt-in required');assert(!process.env.DATABASE_URL&&!process.env.PGPASSWORD);
 const mapperHash=hash(readFileSync(MAPPER,'utf8'));
 const c=new Client({host:'127.0.0.1',port:5558,user:'capiro_master',database:'capiro_fixture',ssl:false,connectionTimeoutMillis:5000,statement_timeout:30000});
 await c.connect();
 try{
  const id=(await c.query("SELECT current_setting('data_directory') directory,current_database() db,host(inet_server_addr()) address,inet_server_port() port,current_user role")).rows[0];
  assert.equal(id.directory.replaceAll('\\','/'),DIRECTORY);assert.equal(id.db,'capiro_fixture');assert.equal(id.address,'127.0.0.1');assert.equal(id.port,5558);assert.equal(id.role,'capiro_master');
  assert.equal((await c.query("SELECT target_id FROM defproc_v2_private.target_binding")).rows[0]?.target_id,'fixture-target-1');
  const before=await snapshot(c),checks:string[]=[];
  const migration=readFileSync(MIGRATION,'utf8');assert.equal((migration.match(/^BEGIN;$/gm)||[]).length,1);assert.equal((migration.match(/^COMMIT;$/gm)||[]).length,1);
  await c.query('BEGIN');
  try{
   await c.query(migration.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,''));
   const catalog={generated_internal_id:uid,'Award ID':'OBSR1','Recipient Name':'SYNTHETIC OBSERVED VENDOR','Recipient UEI':'Z'.repeat(12),'Awarding Agency':'SYNTHETIC AGENCY','Awarding Sub Agency':'SYNTHETIC SUBTIER'};
   await c.query(`INSERT INTO public.federal_award(id,award_unique_id,piid,contractor_name,recipient_uei,amount,action_date,raw_jsonb) VALUES($1,$2,'OBSR1',$3,$4,0,'2025-10-03','{}')`,[randomUUID(),uid,catalog['Recipient Name'],catalog['Recipient UEI']]);
   await c.query(`INSERT INTO public.acquisition_record_revision(id,identity_key,source_system,source_record_id,record_kind,content_hash,source_observed_at,recorded_at,raw_jsonb)
    VALUES($1,$2,'usaspending',$3,'award',$4,'2025-01-01','2025-01-02',$5::jsonb)`,[randomUUID(),key,uid,payloadHash(catalog),JSON.stringify(catalog)]);
   await append(c,[record('P1','100.00','2099-12-31 23:59:59'),record('P2','20.00',' 2026-08-13 15:30:52 '),record('P3','0.00',null)],clock(1));
   const first=await read(c,clock(1));assert.equal(first.totals.obligationUsd,'120.00');assert.equal(first.totals.actions,'3');
   assert.equal(first.actionDetails.find((r:{modificationNumber:string})=>r.modificationNumber==='P2').sourceRevisionLabel,' 2026-08-13 15:30:52 ');
   assert.equal(first.actionDetails.find((r:{modificationNumber:string})=>r.modificationNumber==='P3').sourceRevisionLabel,null);
   checks.push('verbatim naive/whitespace/null labels; identity/numeric validation and real canonical seal');
   await append(c,[record('P1','-1.50','1999-01-01 00:00:00')],clock(2));
   const second=await read(c,clock(2));assert.equal(second.totals.obligationUsd,'18.50');assert.equal(second.totals.actions,'3');
   assert.equal(second.actionDetails.find((r:{modificationNumber:string})=>r.modificationNumber==='P1').sourceRevisionLabel,'1999-01-01 00:00:00');
   assert.deepEqual(await read(c,clock(1)),first);checks.push('later observation wins despite reverse publisher label; historical knownAt preserved');
   await append(c,[record('P1','-1.50','1999-01-01 00:00:00')],clock(3));
   const third=await read(c,clock(3));assert.deepEqual(third.totals,second.totals);
   assert.equal(third.contract,'defproc-observed-money-flow/v1');assert.equal(third.revisionBasis,'latest_observed');assert.equal(third.sourceThrough,null);
   for(const detail of third.actionDetails)assert(!('sourceRevisionOrder' in detail));
   for(const group of third.groups)assert(!('latestSourceRevision' in group));
   const {actionDetails,...summary}=third;assert.deepEqual(await read(c,clock(3),false),summary);
   writeFileSync(`${OUT}/observed-native-payload.json`,JSON.stringify(third,null,2));
   if(process.env.DEFPROC_EXPORT_OBSERVED_FIXTURE==='1') writeFileSync('C:/dev/defproc-release1-frontend/apps/web/tests/fixtures/procurement-observed-native.json',JSON.stringify(third,null,2));
   checks.push('repeated observation conserves totals; summary/detail agree; no publisher-clock fields; native payload exported');
   const old=(await c.query('SELECT public.defproc_money_flow_scope_v2($1,$2,NULL) result',[[key],clock(3)])).rows[0].result;
   assert.equal(old.totals,null);checks.push('old publisher-qualified reader does not reinterpret observed-contract rows');
   await append(c,[record('P1','7.00','opaque-a'),record('P1','8.00','opaque-b')],clock(4));
   const fork=await read(c,clock(4));assert.equal(fork.totals.obligationUsd,'20.00');assert.equal(fork.totals.actions,'2');
   assert(fork.coverage.observation_fork);assert(!fork.actionDetails.some((r:{modificationNumber:string})=>r.modificationNumber==='P1'));
   assert.deepEqual(await read(c,clock(3)),third);checks.push('same-observation different content withheld; prior snapshot remains identical');
   const rights=(await c.query("SELECT has_function_privilege('capiro_app','public.defproc_observed_money_flow_v1(text[],text,boolean)','EXECUTE') app,has_function_privilege('capiro_defense_job','public.defproc_observed_money_flow_v1(text[],text,boolean)','EXECUTE') job,has_schema_privilege('capiro_app','defproc_v2_private','USAGE') helpers")).rows[0];
   assert.deepEqual(rights,{app:true,job:false,helpers:false});checks.push('only closed app projection exposed, private helpers inaccessible');
  }finally{await c.query('ROLLBACK');}
  assert.deepEqual(await snapshot(c),before);checks.push('all prior rows/functions/owners/ACL/header constraints preserved after rollback');
  assert.equal(hash(readFileSync(MAPPER,'utf8')),mapperHash,'mapper changed during proof');
  writeFileSync(`${OUT}/observed-native-result.json`,JSON.stringify({status:'PASS_SYNTHETIC_LOCAL_ONLY',checks,sourceHash:hash(readFileSync(__filename,'utf8')),mapperHash,migrationHash:hash(migration),rollbackVerified:true},null,2));
  console.log(JSON.stringify({status:'PASS_SYNTHETIC_LOCAL_ONLY',checks:checks.length}));
 }finally{await c.end();}
}
main().catch(e=>{console.error(e);process.exitCode=1});
