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
