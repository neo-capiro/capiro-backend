import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { withOwnedApprovedMemory, TENANT, CLIENT, PROPOSER } from './approved-memory-postgres-independent-harness.mjs';
import { createCase12MemoryEligibilityOwner } from '../fixture-provisioning/case12-memory-eligibility-owner.mjs';

const require = createRequire('C:/dev/main/meri-c1-20261002/apps/api/package.json');
const config = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;
assert.ok(config, 'Explicit owned PostgreSQL config required; never silently skip');
const ctx = { tenantId: TENANT, userId: PROPOSER, role: 'standard_user' };
const proposalSource = name => require(fileURLToPath(new URL(`../../../../apps/api/src/${name}.ts`, import.meta.url)));
const originalSource = name => require(`C:/dev/main/meri-c1-20261002/apps/api/src/${name}.ts`);
const facts = {kind:'case12-owned-postgresql-current-eligibility-qualification',providerCalls:0,cloudCalls:0,
  semanticClockQualified:false,fullApplicationSchemaQualified:false,productionRlsQualified:false,
  semanticVectorBranchRun:false,originalModelPromptRun:false,humanRubricRun:false,captureAuthority:false,
  liveAcceptance:'NOT_RUN',checks:[]};

test('actual canonical approval commits, then inventory and shared eligibility in an owned repeatable-read snapshot', async t => {
  await withOwnedApprovedMemory(config, async ({runtime,withInspectionTransaction,manifest,deps,memoryStore,projectionCalls,metrics}) => {
    const { assertSyntheticApprovedMemoryInTx } = originalSource('memory/synthetic-approved-memory.helpers');
    const { readCase12CanonicalEligibilityInTx } = proposalSource('retrieval/adapters/case12-memory-eligibility.read');
    const { InstitutionalKnowledgeRetrievalAdapter: ProposedAdapter } = proposalSource('retrieval/adapters/institutional-knowledge-retrieval.adapter');
    const { InstitutionalKnowledgeRetrievalAdapter: OriginalAdapter } = proposalSource('retrieval/adapters/institutional-knowledge-retrieval.original-baseline');
    const { SemanticDataCatalogService } = originalSource('retrieval/data-catalog/semantic-data-catalog.service');
    const creationStarted=performance.now();
    const receipt = await runtime.createDataset();
    facts.creationDurationMs=performance.now()-creationStarted;
    return withInspectionTransaction(async tx=>{
    const target=receipt.bindings.find(row=>row.logicalId==='MA510');
    const ids=receipt.bindings.map(row=>row.physicalId);
    const input={clientId:CLIENT,targetItemId:target.physicalId,inventoryItemIds:ids};
    const read=()=>readCase12CanonicalEligibilityInTx(tx,ctx,input);
    const owner=reader=>createCase12MemoryEligibilityOwner({manifest,seedInventory:receipt,
      proposerForTenant:deps.proposerForTenant,assertSyntheticApprovedMemoryInTx,
      memoryAuthorization:memoryStore.authz,readCase12CanonicalEligibilityInTx:reader});
    const inspect=reader=>owner(reader).inspectInTx(tx,ctx,{caseId:'12',clientId:CLIENT});
    const provider={name:'deliberately-unused-local-test-provider',model:'unused',dimensions:1024,
      embed:async()=>{ facts.providerCalls++;throw new Error('PROVIDER_MUST_NOT_RUN'); }};
    const graph={query:async()=>{throw new Error('GRAPH_MUST_NOT_RUN');}};
    // Both real adapters receive the same already-scoped inspection transaction,
    // including negative local mutations; graph/provider ports cannot execute.
    const inspectionPort={withTenantUser:async(tenantId,userId,fn)=>{
      assert.equal(tenantId,TENANT);assert.equal(userId,PROPOSER);return fn(tx);
    }};
    const proposed=new ProposedAdapter(graph,inspectionPort,provider);
    const original=new OriginalAdapter(graph,inspectionPort,provider);
    const dataset=new SemanticDataCatalogService().get('institutional_knowledge');
    const request={queryClass:'lookup',requestedDomains:['institutional_knowledge'],
      caller:{tenantId:TENANT,userId:PROPOSER,clientIds:[CLIENT],authorizedClientIds:[CLIENT]},
      query:'What did we approve about Aster’s autonomous maritime demo?',pageSize:50};
    const pair=async()=>{
      const before=await original.retrieve(dataset,request), after=await proposed.retrieve(dataset,request);
      assert.notEqual(after.sourceStatus,'error',JSON.stringify(after));
      assert.deepEqual(after,before,'proposed extraction preserves actual current adapter output');
      return after;
    };
    const check=async(name,fn)=>{let passed=false;await t.test(name,async()=>{await fn();passed=true;});facts.checks.push({name,passed});if(!passed)throw new Error('LOCAL_QUALIFICATION_FAILED: '+name);};
    let savepoint=0;
    const mutation=async(sql,values,fn)=>{
      const name=`eligibility_negative_${++savepoint}`;
      await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
      try {await tx.$executeRawUnsafe(sql,...values);await fn();}
      finally {await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);}
    };
    await check('native services create 510 approved owners with actual durable outbox and inert projection sink',async()=>{
      assert.equal(receipt.bindings.length,510);assert.equal(receipt.liveAcceptance,'NOT_RUN');
      assert.equal(projectionCalls.length,510);
      const counts=(await tx.$queryRawUnsafe(`SELECT
        (SELECT count(*)::int FROM memory_candidate WHERE status='approved') AS candidates,
        (SELECT count(*)::int FROM memory_cleanup_outbox WHERE operation='index_memory_item') AS outbox,
        (SELECT count(*)::int FROM memory_transition_audit WHERE to_status='active') AS approvals`))[0];
      assert.deepEqual(counts,{candidates:510,outbox:510,approvals:510});facts.canonicalCounts=counts;
    });
    await check('actual canonical inventory guards and current SQL/postfilter qualify target plus 509 newer eligible rows',async()=>{
      const started=performance.now(),queryBefore=metrics.inspectionQueries;
      const result=await inspect(readCase12CanonicalEligibilityInTx);
      facts.nativeOwnerInspectionDurationMs=performance.now()-started;
      facts.nativeOwnerInspectionQueryCount=metrics.inspectionQueries-queryBefore;
      assert.equal(result.inventoryVerified,true);assert.equal(result.olderThan500CurrentEligibleRowsVerified,true);
      assert.equal(result.newerCurrentEligibleRecordCount,509);assert.equal(result.currentEligibility.observations.length,510);
      assert.equal(result.fixtureReady,false);assert.equal(result.captureAuthority,false);assert.equal(result.liveAcceptance,'NOT_RUN');
      facts.currentOwner={fixtureInstanceId:result.fixtureInstanceId,manifestContentSha256:result.manifestContentSha256,
        seedInventorySha256:result.seedInventorySha256,newerCurrentEligibleRecordCount:509,
        targetId:target.physicalId,sourceVersion:result.observations.find(r=>r.logicalId==='MA510').sourceVersion,
        observation:result.currentEligibility.observation};
    });
    await check('actual source and proposed adapters return MA510 full passage before safety cap without embedding calls',async()=>{
      const result=await pair();const row=result.records.find(r=>r.recordId===target.physicalId);
      assert.ok(row);assert.match(JSON.stringify(row),/autonomous maritime demo/);
      assert.equal(row.provenance.sourceVersion,`candidate:${target.candidateId}`);
      assert.equal(result.truncated,true);assert.equal(result.stopReason,'governed_memory_safety_cap_reached');
      assert.equal(facts.providerCalls,0);facts.lookup={returned:result.returned,recordsEvaluated:result.recordsEvaluated,
        truncated:result.truncated,sourceStatus:result.sourceStatus,stopReason:result.stopReason,targetRecord:row};
    });
    for(const [label,set] of [
      ['future effective time',"effective_from=now()+interval '1 day'"],
      ['expired record',"expires_at=now()-interval '1 day'"],
      ['elapsed valid-until',"valid_until=now()-interval '1 day'"],
      ['restricted sensitivity',"sensitivity='restricted'"],
      ['missing approval',"approved_by_user_id=NULL,approved_at=NULL"],
      ['blank source provenance',"source_type='unknown',source_id='',source_ref=NULL"],
      ['revoked governance',"governed_status='revoked'"],
      ['legacy inactive status',"status='revoked'"],
      ['foreign client',"client_id='22222222-2222-4222-8222-222222222222'::uuid"],
    ]) await check(`actual SQL/postfilter and both adapters exclude target with ${label}`,()=>mutation(
      `UPDATE memory_items SET ${set} WHERE id=$1::uuid`,[target.physicalId],async()=>{
        assert.equal((await read()).observations.some(r=>r.physicalId===target.physicalId),false);
        assert.equal((await pair()).records.some(r=>r.recordId===target.physicalId),false);
      }));
    await check('existing retrieval only requires approvedBy when four-eyes is disabled; native owner still rejects changed approval timestamp',()=>mutation(
      'UPDATE memory_items SET approved_at=NULL WHERE id=$1::uuid',[target.physicalId],async()=>{
        assert.equal((await read()).observations.some(r=>r.physicalId===target.physicalId),true);
        assert.equal((await pair()).records.some(r=>r.recordId===target.physicalId),true);
        await assert.rejects(()=>inspect(readCase12CanonicalEligibilityInTx));
      }));
    await check('500 eligible newer rows count, then 499 fail the threshold from actual current predicate',async()=>{
      const distractors=receipt.bindings.filter(r=>r.logicalId!=='MA510').map(r=>r.physicalId);
      await mutation("UPDATE memory_items SET effective_from=now()+interval '1 day' WHERE id=ANY($1::uuid[])",[distractors.slice(0,9)],async()=>{
        assert.equal((await read()).observations.filter(r=>r.newerThanTarget).length,500);
      });
      await mutation("UPDATE memory_items SET effective_from=now()+interval '1 day' WHERE id=ANY($1::uuid[])",[distractors.slice(0,10)],async()=>{
        assert.equal((await read()).observations.filter(r=>r.newerThanTarget).length,499);
      });
    });
    await check('age comparison is database precise: tied timestamps do not count; one microsecond newer does',async()=>{
      const id=receipt.bindings[1].physicalId;
      for(const [interval,expected] of [['0 microseconds',false],['1 microsecond',true]])
        await mutation(`UPDATE memory_items SET created_at=(SELECT created_at FROM memory_items WHERE id=$1::uuid)+interval '${interval}',
          updated_at=(SELECT updated_at FROM memory_items WHERE id=$1::uuid)+interval '${interval}' WHERE id=$2::uuid`,[target.physicalId,id],async()=>{
            assert.equal((await read()).observations.find(r=>r.physicalId===id).newerThanTarget,expected);
          });
    });
    await check('actual current ethical wall denies the ungranted actor',()=>mutation('UPDATE clients SET memory_wall=true WHERE id=$1::uuid',[CLIENT],async()=>{
      await assert.rejects(read,/CASE12_ELIGIBILITY_CLIENT_WALL_DENIED/);
      const result=await pair();assert.equal(result.records.length,0);assert.equal(result.sourceStatus,'unauthorized');
    }));
    for(const [label,alter,expected] of [
      ['foreign reader scope',r=>{r.tenantId='11111111-1111-4111-8111-111111111111';},/SCOPE_MISMATCH/],
      ['changed current version',r=>{r.observations[0].sourceVersion='forged';},/JOIN_MISMATCH/],
      ['duplicate row',r=>{r.observations.push(r.observations[0]);},/JOIN_MISMATCH/],
      ['missing observed snapshot',r=>{r.observation=null;},/OBSERVATION_MISSING/],
      ['missing target',r=>{r.observations=r.observations.filter(x=>x.physicalId!==target.physicalId);},/500_CURRENT_ELIGIBLE/],
      ['only 499 newer eligible rows',r=>{r.observations=r.observations.filter(x=>!x.newerThanTarget).concat(r.observations.filter(x=>x.newerThanTarget).slice(0,499));},/500_CURRENT_ELIGIBLE/],
    ]) await check(`composed owner rejects ${label}`,async()=>{
      await assert.rejects(()=>inspect(async(...args)=>{const r=await readCase12CanonicalEligibilityInTx(...args);alter(r);return r;}),expected);
    });
    await check('malformed and foreign ordinary identities are rejected before qualification',async()=>{
      await assert.rejects(()=>readCase12CanonicalEligibilityInTx(tx,{...ctx,role:'user_admin'},input),/INPUT_INVALID/);
      await assert.rejects(()=>readCase12CanonicalEligibilityInTx(tx,ctx,{...input,inventoryItemIds:[target.physicalId]}),/INPUT_INVALID/);
      await assert.rejects(()=>readCase12CanonicalEligibilityInTx(tx,ctx,{...input,inventoryItemIds:null}),/INPUT_INVALID/);
      await assert.rejects(()=>owner(readCase12CanonicalEligibilityInTx).inspectInTx(tx,{...ctx,userId:'66666666-6666-4666-8666-666666666666'},{caseId:'12',clientId:CLIENT}),/CASE12_ORDINARY_ACTOR_SCOPE_MISMATCH/);
    });
    assert.equal(facts.providerCalls,0);
    facts.transactionMetrics=metrics;
    });
  });
  facts.ownedSchemaDroppedAndAbsent=true;
  facts.status='PASS_LOCAL_SCOPE_ONLY';
  await writeFile(new URL('../../../../../postgres-qualification-final.json',import.meta.url),JSON.stringify(facts,null,2)+'\n');
});
