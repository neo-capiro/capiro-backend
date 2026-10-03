// Observe the packaged preview; do not change queries, guards or transaction behavior.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readSyntheticReadOperatorInput,reconcileSyntheticMemoryCorpus} from './scripts/meri-synthetic-read-budget.mjs';
import {createCase01SetupDependencies} from './scripts/meri-case01-setup-dependencies.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const observations=[];
const safeError=e=>({name:/^[A-Za-z]{1,70}$/.test(e?.name??'')?e.name:null,
  code:/^(P[0-9]{4}|CASE01_[A-Z_]+)$/.test(e?.code??'')?e.code:null,
  message:['Approved synthetic memory guard does not match','Synthetic correction readback guard does not match','Synthetic immutable correction evidence does not match','Synthetic correction retirement version does not match','Synthetic correction retirement evidence does not match','Synthetic immutable correction guard does not match'].includes(e?.message)||/^(CASE01_[A-Z_]+|meri_synthetic_read_budget_[a-z_]+)$/.test(e?.message??'')?e.message:'UNCLASSIFIED_NO_RAW_MESSAGE',
  databaseCode:/^[0-9A-Z]{5}$/.test(e?.meta?.code??'')?e.meta.code:null,
  frames:String(e?.stack??'').split('\n').filter(s=>/^\s+at /.test(s)&&s.includes('/app/')).slice(0,9)});
let factory;
try {
  process.env.DATABASE_URL=execFileSync(process.execPath,['./scripts/lib/pe-compose-database-url.js'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const {input}=await readSyntheticReadOperatorInput(['preview-corpus-metadata','--input-env','MERI_SYNTHETIC_READ_BUDGET_INPUT','--out','/dev/shm/unused-diagnostic.json']);
  factory=await createCase01SetupDependencies();
  const original=factory.deps.prisma;
  const prisma=new Proxy(original,{get(target,key,receiver){
    if(key!=='withTenantUser') return Reflect.get(target,key,receiver);
    return (tenant,user,work)=>target.withTenantUser(tenant,user,tx=>work(new Proxy(tx,{get(db,method){
      if(!['$queryRawUnsafe','$queryRaw','$executeRawUnsafe','$executeRaw'].includes(method)) return Reflect.get(db,method);
      return async(first,...values)=>{
        const sql=typeof first==='string'?first:Array.isArray(first)?first.join('?'):'UNCLASSIFIED';
        const info={method,querySha256:hash(sql),queryKind:sql.trim().split(/\s+/).slice(0,5).join(' ')};
        try {
          const result=await db[method](first,...values);
          if(Array.isArray(result)) info.rowCount=result.length;
          if(result?.length===0 && sql.includes('SELECT a.id::text AS "transitionAuditId",o.id::text AS "cleanupIntentId"') && sql.includes('syntheticFixtureRevokedAtEpoch')) {
            const tenantId=values.at(-2),itemId=values.at(-1);
            info.retirement={tenantId,itemId,
              expected:{syntheticCandidate:values[0],markerSha256:values[1],candidateRowVersion:values[2],itemRowVersion:values[3]},
              item:await db.$queryRawUnsafe('SELECT status,governed_status,revoked_by::text,revoked_at::text,extract(epoch from revoked_at)::text AS revoked_epoch FROM memory_items WHERE tenant_id=$1::uuid AND id=$2::uuid',tenantId,itemId),
              audit:await db.$queryRawUnsafe("SELECT id::text,actor_user_id::text,from_status,to_status,reason_code,metadata_jsonb FROM memory_transition_audit WHERE tenant_id=$1::uuid AND memory_item_id=$2::uuid AND from_status='active' AND to_status='revoked'",tenantId,itemId),
              outbox:await db.$queryRawUnsafe('SELECT id::text,operation,status,idempotency_key,clio_memory_id::text,attempts,created_at::text,completed_at::text FROM memory_cleanup_outbox WHERE tenant_id=$1::uuid AND memory_item_id=$2::uuid ORDER BY id',tenantId,itemId),
              embeddingCount:await db.$queryRawUnsafe("SELECT count(*)::int AS count FROM context_embeddings WHERE source_type='memory_item' AND source_id=$1",itemId)};
          }
          if(sql.startsWith('SELECT id::text,xmin::text AS version,to_jsonb(m)')) info.memoryRows=result.map(r=>({id:r.id,xmin:r.version,status:r.body.status,governedStatus:r.body.governed_status,legalHold:r.body.legal_hold,instructionsAllowed:r.body.instructions_allowed,retentionSqlNull:r.retention_sql_null,retentionJsonNull:r.body.retention_policy_jsonb===null}));
          if(sql.startsWith('SELECT to_jsonb(a) AS body,xmin::text AS version FROM memory_transition_audit')) info.audits=result.map(r=>({id:r.body.id,memoryItemId:r.body.memory_item_id,candidateId:r.body.memory_candidate_id,from:r.body.from_status,to:r.body.to_status,reason:r.body.reason_code,syntheticCandidate:r.body.metadata_jsonb?.syntheticFixtureCandidateId}));
          observations.push(info);return result;
        } catch(error) {observations.push({...info,error:safeError(error)});throw error;}
      };
    }})));
  }});
  const proof=await reconcileSyntheticMemoryCorpus({...factory,deps:{...factory.deps,prisma}},input,'preview');
  console.log('C2_METADATA_PREVIEW_DIAGNOSTIC '+JSON.stringify({status:'PREVIEW_COMPLETE',proof,observations}));
} catch(error) {
  console.log('C2_METADATA_PREVIEW_DIAGNOSTIC '+JSON.stringify({status:'PREVIEW_FAILED',error:safeError(error),observations}));
  process.exitCode=1;
} finally {if(factory) await factory.close();}
