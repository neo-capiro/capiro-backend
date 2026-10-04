// Codex LOCAL DRAFT. No approval, provider, projection, repair, budget or journal write.
// The source-owned canonical verifier takes row locks; do not mark its transaction READ ONLY.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const SOURCE='c0f393f863bf73bd4e65e7a94e17c073e7be021e';
const FIXTURE='dee4e90e-8e91-4782-9488-10b8e52a2146',CANDIDATE='6f4545a1-dcd5-5eba-8606-db2043b238ac';
const TENANT='f2d6cf8f-057c-479a-8110-62fe5086d43f',CLIENT='41f9ec63-3963-479f-b747-59a3767ef44b';
const PRIYA='fb218bf5-2674-4ced-bca3-7a5d0c01592f',PAT='b1f758fc-17bd-40f8-bef2-fa2d2380300f';
const HASH=/^[a-f0-9]{64}$/u,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const sha=v=>createHash('sha256').update(v).digest('hex');
const stable=x=>Array.isArray(x)?x.map(stable):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
export const stableHash=x=>sha(JSON.stringify(stable(x)));
const keys=(v,wanted)=>assert.deepEqual(Object.keys(v).sort(),[...wanted].sort());
const iso=v=>{const s=v instanceof Date?v.toISOString():v;assert.equal(typeof s,'string');assert.ok(Number.isFinite(Date.parse(s)));return new Date(s).toISOString();};
export function expectedProjection(){
 const title=`meri-foundation-20260928:${FIXTURE}:MEM-PROPOSAL-14`,value='Synthetic Aster candidate for approval';
 const sections=[{key:'memory',heading:'Memory',owner:'human',body:value}],text=title+' Memory: '+value;
 return{title,value,sections,text,projectionTextSha256:sha(text)};
}
export function validateTerminalInput(input,now=Date.now()){
 keys(input,['kind','version','sourceSha','captureRunId','approvalEvidenceSha256','approvedOwner','windowStartedAt','deadlineAt']);
 assert.equal(input.kind,'case14-projection-terminal-read-input');assert.equal(input.version,1);assert.equal(input.sourceSha,SOURCE);
 assert.match(input.captureRunId,UUID);assert.match(input.approvalEvidenceSha256,HASH);
 const start=Date.parse(input.windowStartedAt),deadline=Date.parse(input.deadlineAt);
 assert.ok(Number.isFinite(start)&&Number.isFinite(deadline)&&start<=now&&now<deadline&&deadline-start<=900000);
 const o=input.approvedOwner;const{currentVerifySha256,...body}=o;
 keys(o,['kind','schemaVersion','caseId','fixtureNamespace','fixtureVersion','fixtureInstanceId','manifestContentSha256','recipeSha256','seedPlanSha256','setupReceiptSha256','tenantId','clientId','proposerUserId','reviewerUserId','reviewerRole','logicalSourceId','candidateId','candidateRowVersion','revision','ownershipMarkerSha256','payloadSha256','text','state','item','decision','currentVerifySha256']);
 assert.equal(currentVerifySha256,stableHash(body));assert.equal(o.kind,'meri-case14-current-memory-owner');
 assert.equal(o.schemaVersion,1);assert.equal(o.caseId,'14');assert.equal(o.state,'approved');
 assert.equal(o.fixtureNamespace,'meri-foundation-20260928');assert.equal(o.fixtureInstanceId,FIXTURE);
 assert.equal(o.fixtureVersion,'meri-live-v1-2026-09-26.1');assert.equal(o.candidateId,CANDIDATE);
 assert.equal(o.tenantId,TENANT);assert.equal(o.clientId,CLIENT);assert.equal(o.proposerUserId,PAT);
 assert.equal(o.reviewerUserId,PRIYA);assert.equal(o.reviewerRole,'user_admin');assert.equal(o.logicalSourceId,'MEM-PROPOSAL-14');
 assert.equal(o.revision,1);assert.equal(o.text,expectedProjection().value);
 assert.equal(o.setupReceiptSha256,'c2c80bdef51e6b8b22d13c809e77e76c61eb680fa10aca88372f258d53a155f8');
 assert.equal(o.recipeSha256,'1668649c84550f701faea8e30617da11c944c84caeb99965afa311acd017e593');
 assert.equal(o.manifestContentSha256,'5deda70f94698a8f8ed82d40fa804d16ae2e39a091012af0d70203a0e1b5fc14');
 assert.equal(o.seedPlanSha256,'42ed4d5a6466c9834a9d578092b98f07039808cf424a6a77095aca22202c21f2');
 assert.equal(o.ownershipMarkerSha256,'48b95413d7b876a412e3c5352ac4e3fecfea5eb8b260e2cd327736829ee1faab');
 assert.equal(o.payloadSha256,'1b2333f97623789682efa51f479a8a0a452a2c4d1181b121437c51f4f0be499e');
 assert.match(o.candidateRowVersion,/^[0-9]{1,10}$/u);assert.match(o.item.rowVersion,/^[0-9]{1,10}$/u);
 keys(o.item,['id','clioMemoryId','rowVersion','sourceVersion','contentSha256','status','governedStatus']);
 keys(o.decision,['transitionAuditId','actorUserId','decision']);
 assert.match(o.item.id,UUID);assert.match(o.item.clioMemoryId,UUID);assert.match(o.item.contentSha256,HASH);
 assert.equal(o.item.sourceVersion,'candidate:'+CANDIDATE);assert.equal(o.item.status,'active');assert.equal(o.item.governedStatus,'active');
 assert.equal(o.decision.actorUserId,PRIYA);assert.equal(o.decision.decision,'approved');assert.match(o.decision.transitionAuditId,UUID);
 return input;
}

// Raw snapshot contains exact bounded source rows, never vectors or tenant settings.
// Identity/content drift rejects immediately. Incomplete asynchronous branches return WAIT.
export function validateProjectionSnapshot(input,raw,now=Date.now()){
 validateTerminalInput(input,now);assert.deepEqual(raw.canonicalOwner,input.approvedOwner);
 const o=input.approvedOwner,e=expectedProjection();
 assert.equal(raw.clio.length,1);assert.equal(raw.items.length,1);assert.ok(raw.embeddings.length<=1);assert.ok(raw.jobs.length<=1);
 const c=raw.clio[0],item=raw.items[0];
 assert.equal(c.id,o.item.clioMemoryId);assert.equal(c.tenantId,TENANT);assert.equal(c.clientId,CLIENT);assert.equal(c.ownerUserId,null);
 assert.equal(c.scope,'client');assert.equal(c.key,e.title);assert.equal(c.value,e.value);assert.equal(c.source,'meri_synthetic_fixture');
 assert.ok(Date.parse(iso(c.createdAt))>=Date.parse(input.windowStartedAt));assert.ok(Date.parse(iso(c.updatedAt))>=Date.parse(iso(c.createdAt)));assert.ok(Date.parse(iso(c.updatedAt))<=now);
 assert.equal(item.id,o.item.id);assert.equal(item.tenantId,TENANT);assert.equal(item.clientId,CLIENT);assert.equal(item.ownerUserId,null);
 assert.equal(item.status,'active');assert.equal(item.governedStatus,'active');assert.equal(item.sourceVersion,o.item.sourceVersion);
 assert.equal(item.sourceContentHash,o.item.contentSha256);assert.equal(item.rowVersion,o.item.rowVersion);
 assert.equal(item.slug,'clio:'+c.id);assert.equal(item.title,e.title);assert.deepEqual(item.sections,e.sections);
 const reasons=[];
 if(c.hasLegacyEmbedding!==true) { assert.equal(c.hasLegacyEmbedding,false);assert.equal(c.legacyDimensions,null);reasons.push('LEGACY_OPENAI_VECTOR_PENDING'); }
 else assert.equal(c.legacyDimensions,1536);
 if(!raw.embeddings.length)reasons.push('INSTITUTIONAL_VECTOR_PENDING');
 else {
  const v=raw.embeddings[0];assert.equal(v.tenantId,TENANT);assert.equal(v.clientId,CLIENT);assert.equal(v.ownerUserId,null);
  assert.equal(v.sourceType,'memory_item');assert.equal(v.sourceId,item.id);assert.equal(v.model,'amazon.titan-embed-text-v2:0');
  assert.equal(v.contentHash,e.projectionTextSha256);assert.equal(v.contentText,e.text);assert.equal(v.hasEmbedding,true);assert.equal(v.dimensions,1024);
  assert.ok(Date.parse(iso(v.createdAt))>=Date.parse(input.windowStartedAt));assert.ok(Date.parse(iso(v.updatedAt))>=Date.parse(iso(v.createdAt)));assert.ok(Date.parse(iso(v.updatedAt))<=now);
 }
 if(!raw.jobs.length)reasons.push('EXACT_OUTBOX_JOB_PENDING');
 else {
  const job=raw.jobs[0];assert.match(job.id,UUID);assert.equal(job.tenantId,TENANT);assert.equal(job.clioMemoryId,c.id);assert.equal(job.memoryItemId,item.id);
  assert.equal(job.operation,'index_memory_item');assert.equal(job.expectedContentHash,e.projectionTextSha256);
  assert.equal(iso(job.expectedSourceVersion),iso(c.updatedAt));
  assert.equal(job.idempotencyKey,`index_memory_item:${c.id}:${iso(c.updatedAt)}:${e.projectionTextSha256}`);
  assert.equal(job.attempts,0,'BACKGROUND_ATTEMPT_OUTSIDE_FAST_PATH_BOUND');
  assert.ok(Date.parse(iso(job.createdAt))>=Date.parse(input.windowStartedAt));assert.ok(Date.parse(iso(job.createdAt))<=now);
  assert.equal(job.leaseOwner,null);assert.equal(job.leaseExpiresAt,null);
  if(job.status==='pending'){assert.equal(job.completedAt,null);assert.equal(job.lastError,null);reasons.push('EXACT_OUTBOX_PENDING');}
  else {
   assert.equal(job.status,'completed');assert.equal(job.lastError,null);assert.ok(job.completedAt);
   assert.ok(Date.parse(iso(job.completedAt))>=Date.parse(iso(job.createdAt)));assert.ok(Date.parse(iso(job.completedAt))<=now);
  }
 }
 if(reasons.length)return{status:'WAIT',reasons};
 const v=raw.embeddings[0],job=raw.jobs[0];const{contentText,...vectorMetadata}=v;
 return{kind:'case14-exact-projection-terminal-proof',status:'BOTH_APPROVAL_PROJECTION_BRANCHES_PERSISTED',sourceSha:SOURCE,
  captureRunId:input.captureRunId,approvalEvidenceSha256:input.approvalEvidenceSha256,canonicalOwner:raw.canonicalOwner,
  windowStartedAt:input.windowStartedAt,deadlineAt:input.deadlineAt,observedAt:new Date(now).toISOString(),
  clio:{id:c.id,tenantId:c.tenantId,clientId:c.clientId,ownerUserId:c.ownerUserId,scope:c.scope,source:c.source,
   keySha256:sha(c.key),valueSha256:sha(c.value),createdAt:iso(c.createdAt),updatedAt:iso(c.updatedAt),hasLegacyEmbedding:true,legacyDimensions:1536},
  item:{id:item.id,tenantId:item.tenantId,clientId:item.clientId,ownerUserId:item.ownerUserId,rowVersion:item.rowVersion,
   status:item.status,governedStatus:item.governedStatus,sourceVersion:item.sourceVersion,sourceContentHash:item.sourceContentHash,
   slug:item.slug,titleSha256:sha(item.title),sectionsSha256:stableHash(item.sections)},
  embedding:{...vectorMetadata,contentTextSha256:sha(contentText),createdAt:iso(v.createdAt),updatedAt:iso(v.updatedAt)},
  outbox:{...job,expectedSourceVersion:iso(job.expectedSourceVersion),createdAt:iso(job.createdAt),completedAt:iso(job.completedAt)},
  matchingInstitutionalVectorRows:1,matchingLegacyVectorRows:1,exactOutboxRows:1,otherOutboxRows:0,
  providerUsageMeasured:false,approvalBilledActualMicros:null,projectionDispatchesByThisHelper:0,
  providerCalls:0,databaseWrites:0,reviewDecisions:0,acceptanceAuthority:false};
}

export async function pollProjection(input,read,emit,clock={now:()=>Date.now(),sleep:ms=>new Promise(r=>setTimeout(r,ms))}){
 validateTerminalInput(input,clock.now());const stop=Math.min(clock.now()+60000,Date.parse(input.deadlineAt));let attempts=0;
 while(attempts<12&&clock.now()<stop){
  // Never issue a transaction with a deadline beyond this local polling window.
  const remainingBeforeRead=stop-clock.now();if(remainingBeforeRead<100)break;
  attempts++;const raw=await read(input,{timeoutMs:Math.min(7000,remainingBeforeRead),stopAt:stop});
  if(clock.now()>=stop)throw new Error('CASE14_PROJECTION_NOT_TERMINAL_WITHIN_BOUND');
  const result=validateProjectionSnapshot(input,raw,clock.now());
  if(result.status!=='WAIT'){await emit({phase:'TERMINAL',attempts,proof:result});return result;}
  await emit({phase:'PENDING',attempt:attempts,reasons:result.reasons,providerCalls:0,databaseWrites:0});
  const remaining=stop-clock.now();if(attempts<12&&remaining>0)await clock.sleep(Math.min(5000,remaining));
 }
 throw new Error('CASE14_PROJECTION_NOT_TERMINAL_WITHIN_BOUND');
}

// Native entry for the byte-pinned postapproval adapter. Importing never invokes it.
export async function runNativeProjection(input,emit){
 let prisma;
 try{
  assert.equal(process.env.RELEASE_SHA,SOURCE);assert.equal(process.env.GIT_SHA,SOURCE);
  assert.equal(process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE,'meri-foundation-20260928');
  validateTerminalInput(input);
  const env={};for(const key of ['PATH','DB_HOST','DB_PORT','DB_USER','DB_PASSWORD','DB_NAME','PGSSLMODE'])if(process.env[key]!==undefined)env[key]=process.env[key];
  const composed=spawnSync(process.execPath,['/app/apps/api/scripts/lib/pe-compose-database-url.js'],{env,encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:15000,maxBuffer:65536});
  assert.equal(composed.status,0);assert.match(composed.stdout,/^postgresql:\/\//u);process.env.DATABASE_URL=composed.stdout.trim();
  const require=createRequire('/app/apps/api/package.json');
  const{PrismaService}=require('/app/apps/api/dist/prisma/prisma.service.js');
  const{MemoryAuthorizationService}=require('/app/apps/api/dist/memory/memory-authorization.service.js');
  const{runWithMemoryGovernanceTenant}=require('/app/apps/api/dist/memory/memory-governance-tenant-scope.js');
  const{readCase14FixtureEvidenceInTx}=require('/app/apps/api/dist/memory/case14-fixture-evidence.js');
  prisma=new PrismaService();const authorization=new MemoryAuthorizationService(prisma);await prisma.$connect();
  const ctx={tenantId:TENANT,tenantSlug:'meri-foundation-20260928-t1',userId:PRIYA,clerkUserId:'user_3Jw2G2jbyyDlrrg6zCNd4gYUDfH',role:'user_admin'};
  const read=async(_input,{timeoutMs})=>runWithMemoryGovernanceTenant(TENANT,()=>prisma.withTenantUser(TENANT,PRIYA,async tx=>{
   assert.ok(Number.isInteger(timeoutMs)&&timeoutMs>=100&&timeoutMs<=7000);
   await tx.$executeRawUnsafe(`SET LOCAL statement_timeout='${Math.min(4000,timeoutMs)}ms'`);await tx.$executeRawUnsafe(`SET LOCAL lock_timeout='${Math.min(2000,timeoutMs)}ms'`);
   const canonicalOwner=await readCase14FixtureEvidenceInTx(tx,ctx,authorization,CANDIDATE);
   assert.deepEqual(canonicalOwner,input.approvedOwner);
   const clio=await tx.$queryRawUnsafe(`SELECT id::text,tenant_id::text AS "tenantId",client_id::text AS "clientId",owner_user_id::text AS "ownerUserId",scope,key,value,source,created_at AS "createdAt",updated_at AS "updatedAt",embedding IS NOT NULL AS "hasLegacyEmbedding",CASE WHEN embedding IS NULL THEN NULL ELSE vector_dims(embedding) END AS "legacyDimensions" FROM clio_memory WHERE tenant_id=$1::uuid AND id=$2::uuid LIMIT 2`,TENANT,canonicalOwner.item.clioMemoryId);
   const items=await tx.$queryRawUnsafe(`SELECT id::text,tenant_id::text AS "tenantId",client_id::text AS "clientId",owner_user_id::text AS "ownerUserId",status,governed_status AS "governedStatus",source_version AS "sourceVersion",source_content_hash AS "sourceContentHash",xmin::text AS "rowVersion",slug,title,sections_jsonb AS sections FROM memory_items WHERE tenant_id=$1::uuid AND id=$2::uuid LIMIT 2`,TENANT,canonicalOwner.item.id);
   const embeddings=await tx.$queryRawUnsafe(`SELECT tenant_id::text AS "tenantId",client_id::text AS "clientId",owner_user_id::text AS "ownerUserId",source_type AS "sourceType",source_id AS "sourceId",model,content_hash AS "contentHash",content_text AS "contentText",embedding IS NOT NULL AS "hasEmbedding",vector_dims(embedding) AS dimensions,created_at AS "createdAt",updated_at AS "updatedAt" FROM context_embeddings WHERE tenant_id=$1::uuid AND source_type='memory_item' AND source_id=$2 LIMIT 3`,TENANT,canonicalOwner.item.id);
   const jobs=await tx.$queryRawUnsafe(`SELECT id::text,tenant_id::text AS "tenantId",memory_item_id::text AS "memoryItemId",clio_memory_id::text AS "clioMemoryId",operation,idempotency_key AS "idempotencyKey",status,attempts,created_at AS "createdAt",completed_at AS "completedAt",last_error AS "lastError",expected_source_version AS "expectedSourceVersion",expected_content_hash AS "expectedContentHash",lease_owner::text AS "leaseOwner",lease_expires_at AS "leaseExpiresAt" FROM memory_cleanup_outbox WHERE tenant_id=$1::uuid AND (memory_item_id=$2::uuid OR clio_memory_id=$3::uuid) LIMIT 3`,TENANT,canonicalOwner.item.id,canonicalOwner.item.clioMemoryId);
   return{canonicalOwner,clio,items,embeddings,jobs};
  },{timeoutMs}));
  // Bounded receipts carry actual narrow row proofs, not tenant settings or vector values.
  await emit({phase:'BEGIN',sourceSha:SOURCE,inputContentSha256:stableHash(input),captureRunId:input.captureRunId,approvalEvidenceSha256:input.approvalEvidenceSha256});
  const proof=await pollProjection(input,read,emit);
  await emit({phase:'END',proofSha256:stableHash(proof),providerCalls:0,databaseWrites:0,acceptanceAuthority:false});
  return proof;
 }catch{await emit({phase:'FAILURE',code:'CASE14_PROJECTION_TERMINAL_READ_FAILED',providerCalls:0,databaseWrites:0,automaticRetryAllowed:false,acceptanceAuthority:false});throw new Error('CASE14_PROJECTION_TERMINAL_READ_FAILED');}
 finally{await prisma?.$disconnect();}
}
async function main(){
 const emit=v=>new Promise((resolve,reject)=>process.stdout.write('C2_CASE14_PROJECTION_READ '+JSON.stringify(v)+'\n',e=>e?reject(e):resolve()));
 try{
  const bytes=Buffer.from(process.env.C2_CASE14_PROJECTION_INPUT_B64??'','base64');assert.ok(bytes.length>0&&bytes.length<32768);
  assert.match(process.env.C2_CASE14_PROJECTION_INPUT_SHA256??'',HASH);assert.equal(sha(bytes),process.env.C2_CASE14_PROJECTION_INPUT_SHA256);
  await runNativeProjection(JSON.parse(bytes),emit);
 }catch{process.exitCode=1;}
}
if(process.argv[1]?import.meta.url===pathToFileURL(resolve(process.argv[1])).href:/\/\[eval\d+\]$/u.test(import.meta.url))await main();
