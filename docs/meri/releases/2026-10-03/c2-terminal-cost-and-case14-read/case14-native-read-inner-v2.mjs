import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const ctx=Object.freeze({tenantId:'f2d6cf8f-057c-479a-8110-62fe5086d43f',tenantSlug:'meri-foundation-20260928-t1',userId:'fb218bf5-2674-4ced-bca3-7a5d0c01592f',clerkUserId:'user_3Jw2G2jbyyDlrrg6zCNd4gYUDfH',role:'user_admin'});
const clientId='41f9ec63-3963-479f-b747-59a3767ef44b',proposer='b1f758fc-17bd-40f8-bef2-fa2d2380300f';
const SOURCE='4f0253874357c272fda1ae2a5271ee4af645f0bc';
const hash=b=>createHash('sha256').update(b).digest('hex');
const codes=new Set(['CASE14_CURRENT_CANONICAL_OWNER_REQUIRED','CASE14_REVIEWER_CURRENT_AUTHORITY_REQUIRED','PENDING_MEMORY_EXISTING_OPERATION_REQUIRES_RECONCILIATION']);
const safeError=e=>({errorClass:e?.name==='AssertionError'?'AssertionError':'Error',code:codes.has(e?.message)?e.message:'CANONICAL_OWNER_READ_FAILED'});
export async function inspectCase14(prisma,authorization,ports){
  assert.equal(process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE,'meri-foundation-20260928');
  let result,rolledBack=false;
  const rollback=Object.freeze({kind:'case14-read-rollback'});
  try {
    await ports.runScoped(ctx.tenantId,()=>prisma.withTenantUser(ctx.tenantId,ctx.userId,async tx=>{
      assert.equal(ports.reviewEnabled(),true);
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout='10s'");
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout='3s'");
      const members=await tx.$queryRawUnsafe(`SELECT tm.role,u.clerk_user_id AS "clerkUserId" FROM tenant_memberships tm JOIN users u ON u.id=tm.user_id WHERE tm.tenant_id=$1::uuid AND tm.user_id=$2::uuid AND tm.status='active'`,ctx.tenantId,ctx.userId);
      assert.equal(members.length,1);assert.equal(members[0].role,ctx.role);assert.equal(members[0].clerkUserId,ctx.clerkUserId);
      const rows=await tx.$queryRawUnsafe(`SELECT slug,COALESCE((settings_jsonb #> '{meriFoundationFixture,pendingMemorySetups}') ? '14',false) AS present,settings_jsonb #>> '{meriFoundationFixture,pendingMemorySetups,14,status}' AS status FROM tenants WHERE id=$1::uuid AND slug=$2`,ctx.tenantId,ctx.tenantSlug);
      assert.equal(rows.length,1);assert.equal(rows[0].slug,ctx.tenantSlug);assert.equal(typeof rows[0].present,'boolean');
      const op=rows[0];
      result={kind:'case14-native-canonical-owner-read',caseId:'14',sourceSha:SOURCE,tenantId:ctx.tenantId,reviewerUserId:ctx.userId,clientId,operationPresent:op.present,operationStatus:['SETUP_COMPLETE','CLAIMED'].includes(op.status)?op.status:op.present?'OTHER':null,status:'BLOCKED',observedAt:new Date().toISOString(),providerCalls:0,businessWrites:0,acceptanceAuthority:false};
      try {
        const owner=await ports.readOwner(tx,ctx,authorization);
        if(!op.present){assert.equal(owner,null);result.status='CANONICAL_OWNER_ABSENT';}
        else if(owner){
          assert.equal(op.status,'SETUP_COMPLETE');assert.equal(owner.caseId,'14');assert.equal(owner.tenantId,ctx.tenantId);assert.equal(owner.clientId,clientId);assert.equal(owner.reviewerUserId,ctx.userId);assert.equal(owner.proposerUserId,proposer);assert.ok(['pending','approved'].includes(owner.state));
          const allowed=['kind','schemaVersion','caseId','fixtureNamespace','fixtureVersion','fixtureInstanceId','manifestContentSha256','recipeSha256','seedPlanSha256','setupReceiptSha256','tenantId','clientId','proposerUserId','reviewerUserId','reviewerRole','logicalSourceId','candidateId','candidateRowVersion','revision','ownershipMarkerSha256','payloadSha256','state','approvalBasis','currentVerifySha256'];
          result.owner=Object.fromEntries(allowed.filter(k=>Object.hasOwn(owner,k)).map(k=>[k,owner[k]]));
          if(owner.item)result.owner.item=Object.fromEntries(['id','clioMemoryId','rowVersion','sourceVersion','contentSha256','status','governedStatus'].map(k=>[k,owner.item[k]]));
          if(owner.decision)result.owner.decision=Object.fromEntries(['transitionAuditId','actorUserId','decision'].map(k=>[k,owner.decision[k]]));
          result.status=owner.state==='pending'?'CANONICAL_OWNER_PENDING':'CANONICAL_OWNER_APPROVED';
        }else result.status=op.status==='SETUP_COMPLETE'?'CANONICAL_OWNER_INVALID_OR_UNRESOLVED':'CANONICAL_OPERATION_REQUIRES_RECONCILIATION';
      }catch(e){result.status='CANONICAL_OWNER_INVALID_OR_UNRESOLVED';Object.assign(result,safeError(e));}
      throw rollback;
    },{timeoutMs:30000}));
    throw new Error('ROLLBACK_SENTINEL_NOT_OBSERVED');
  }catch(e){if(e!==rollback)throw e;rolledBack=true;}
  assert.ok(rolledBack&&result);return {...result,transactionRolledBack:true};
}
if(process.env.MERI_CASE14_NATIVE_READ_ONCE==='1'){
  const require=createRequire(import.meta.url);let prisma;
  const emit=v=>new Promise((resolve,reject)=>process.stdout.write('C2_CASE14_NATIVE_READ '+JSON.stringify(v)+'\n',e=>e?reject(e):resolve()));
  try{
    assert.equal(process.env.RELEASE_SHA,SOURCE);
    process.env.DATABASE_URL=execFileSync(process.execPath,['./scripts/lib/pe-compose-database-url.js'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    const {PrismaService}=require('./dist/prisma/prisma.service.js');
    const {MemoryAuthorizationService}=require('./dist/memory/memory-authorization.service.js');
    const {runWithMemoryGovernanceTenant}=require('./dist/memory/memory-governance-tenant-scope.js');
    const {readCase14FixtureEvidenceInTx}=require('./dist/memory/case14-fixture-evidence.js');
    const {memoryReviewSurfaceEnabled}=require('./dist/memory/memory-review-switch.js');
    prisma=new PrismaService();await prisma.$connect();
    const result=await inspectCase14(prisma,new MemoryAuthorizationService(prisma),{runScoped:runWithMemoryGovernanceTenant,readOwner:readCase14FixtureEvidenceInTx,reviewEnabled:memoryReviewSurfaceEnabled});
    const bytes=Buffer.from(JSON.stringify(result)+'\n');assert.ok(bytes.length<16384);
    const encoded=bytes.toString('base64'),count=Math.ceil(encoded.length/6000),meta={sha256:hash(bytes),bytes:bytes.length,chunks:count};
    await emit({phase:'BEGIN',...meta});for(let i=0;i<count;i++)await emit({phase:'CHUNK',index:i,data:encoded.slice(i*6000,(i+1)*6000)});await emit({phase:'END',...meta});
  }catch(e){await emit({phase:'FAILURE',...safeError(e)});process.exitCode=1;}finally{await prisma?.$disconnect();}
}
