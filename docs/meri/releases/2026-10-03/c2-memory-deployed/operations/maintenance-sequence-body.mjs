// Appended to the already qualified read-only schema wrapper inside the exact image.
if(!process.exitCode) {
  const {readFileSync,existsSync}=await import('node:fs');
  const {main}=await import('./scripts/meri-synthetic-read-budget.mjs');
  const approved=JSON.parse(process.env.MERI_C2_APPROVED_MAINTENANCE);
  assert.equal(approved.packetSha256,'98b400994ce4af4b7b0b01cd1d907b7d708172a3bce9608ffa158998af31ffcb');
  assert.equal(approved.sourceSha,'f00e5dfb4fd3e47ac6aa4aca741023cc02f6314f');
  assert.equal(process.env.RELEASE_SHA,approved.sourceSha);
  const commands={
    'preview-corpus-projections':'PREVIEW_EXACT_OWNED_MEMORY_PROJECTIONS',
    'execute-corpus-projections':'CLEAN_EXACT_OWNED_MEMORY_PROJECTIONS',
    'preview-corpus-metadata':'PREVIEW_EXACT_OWNED_MEMORY_METADATA',
    'execute-corpus-metadata':'RECONCILE_EXACT_OWNED_MEMORY_METADATA',
    'read-corpus':'READ_CURRENT_OWNED_MEMORY_CORPUS',
  };
  const steps=[];
  const run=async(command,expectedPlanSha256)=>{
    assert.ok(Date.parse(approved.expiresAt)>Date.now(),'Approved packet expired');
    const input={...approved.input,confirmation:commands[command],...(expectedPlanSha256?{expectedPlanSha256}:{})};
    process.env.MERI_SYNTHETIC_READ_BUDGET_INPUT=JSON.stringify(input);
    const path='/dev/shm/c2-'+command+'.json';
    let entries;
    try {
      await main([command,'--input-env','MERI_SYNTHETIC_READ_BUDGET_INPUT','--out',path]);
    } finally {
      // Preserve the packaged owner's attempted/unconfirmed records before the
      // ephemeral task filesystem disappears. These files contain only this
      // scoped synthetic operator's allowlisted receipt/error objects.
      const raw=existsSync(path)?readFileSync(path,'utf8'):'';
      try {entries=raw.trim()?raw.trim().split('\n').map(JSON.parse):[];}
      catch {console.log('C2_MAINTENANCE_OWNER_OUTPUT '+JSON.stringify({command,status:'UNPARSEABLE_RETAIN_UNKNOWN',sha256:hash(raw)}));throw new Error('Owner output could not be parsed; no retry');}
      console.log('C2_MAINTENANCE_OWNER_OUTPUT '+JSON.stringify({command,status:entries.length?'CAPTURED':'NOT_CREATED',entries}));
    }
    assert.ok(!process.exitCode,'Packaged owner did not confirm success');
    const receipt=entries.at(-1);
    if(command.startsWith('execute-')){assert.equal(entries.length,2);assert.equal(entries[0].status,'EXECUTION_ATTEMPTED');assert.equal(entries[0].expectedPlanSha256,expectedPlanSha256);assert.ok(receipt.auditId);}
    else assert.equal(entries.length,1);
    assert.equal(receipt.captureAuthority,false);assert.equal(receipt.liveAcceptance,'NOT_RUN');
    steps.push({command,status:receipt.status,planSha256:receipt.planSha256??null,auditId:receipt.auditId??null});
    console.log('C2_MAINTENANCE_STEP '+JSON.stringify(steps.at(-1)));
    return receipt;
  };
  try {
    const p=await run('preview-corpus-projections');
    assert.equal(p.status,'PROJECTION_CLEANUP_PREVIEW_ROLLED_BACK');assert.equal(p.auditId,null);assert.equal(p.proofIsTentative,true);
    assert.equal(p.plan.tenantId,approved.input.ctx.tenantId);assert.equal(p.plan.actorUserId,approved.input.ctx.userId);assert.equal(p.plan.clientId,approved.input.clientId);
    assert.equal(p.plan.previousFixtureInstanceId,'84a3a6a1-ddc8-4810-b120-9a5df0cf1ed9');assert.equal(p.plan.currentFixtureInstanceId,'f6164496-9dac-4771-980f-2f362081942e');
    assert.deepEqual(p.plan.jobs.map(({id,itemId,operation})=>({id,itemId,operation})),approved.originalCleanupJobs);
    assert.equal(p.plan.projectionCount,6);assert.equal(p.conditionalVerification.proof.fixtureReady,true);
    const cleaned=await run('execute-corpus-projections',p.planSha256);
    assert.equal(cleaned.status,'PROJECTIONS_CLEANED');assert.equal(cleaned.planSha256,p.planSha256);
    assert.equal(cleaned.effects.length,6);assert.equal(cleaned.effects.reduce((sum,e)=>sum+e.embeddingsDeleted,0),6);
    assert.ok(cleaned.effects.every(e=>e.status==='completed'&&e.clioDeleted===0&&!e.vanished));
    const m=await run('preview-corpus-metadata');
    assert.equal(m.status,'METADATA_RECONCILIATION_PREVIEW_ROLLED_BACK');assert.equal(m.auditId,null);assert.equal(m.proofIsTentative,true);
    assert.equal(m.plan.tenantId,approved.input.ctx.tenantId);assert.equal(m.plan.actorUserId,approved.input.ctx.userId);assert.equal(m.plan.clientId,approved.input.clientId);
    assert.equal(m.plan.previousFixtureInstanceId,p.plan.previousFixtureInstanceId);assert.equal(m.plan.currentFixtureInstanceId,p.plan.currentFixtureInstanceId);
    assert.deepEqual(m.plan.changes.map(({id,fromGovernedStatus,toGovernedStatus,normalizeRetentionNull})=>({id,fromGovernedStatus,toGovernedStatus,normalizeRetentionNull})),[
      {id:'4cc6ec9e-7f1b-4776-b29d-1b52cc12d41f',fromGovernedStatus:'active',toGovernedStatus:'active',normalizeRetentionNull:true},
      {id:'5e9d3ad4-b37d-4997-be47-55b00528c085',fromGovernedStatus:'active',toGovernedStatus:'superseded',normalizeRetentionNull:true},
      {id:'b4b2379f-d4ac-42f2-afa8-7dd56e220464',fromGovernedStatus:'active',toGovernedStatus:'superseded',normalizeRetentionNull:true},
    ]);
    assert.equal(m.proof.fixtureReady,true);
    const reconciled=await run('execute-corpus-metadata',m.planSha256);
    assert.equal(reconciled.status,'METADATA_RECONCILED');assert.equal(reconciled.planSha256,m.planSha256);assert.equal(reconciled.proofIsTentative,false);
    const current=await run('read-corpus');assert.equal(current.status,'MEMORY_CORPUS_READ');assert.equal(current.fixtureReady,true);assert.deepEqual(current.missing,[]);
    // Verify the two new maintenance receipts from committed state, without
    // replaying their effects or reading arbitrary audit content.
    const auditDb=new PrismaClient({log:[]});
    let auditReadback;
    try {
      auditReadback=await auditDb.$transaction(async tx=>{
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout='5s'");
        await tx.$executeRawUnsafe("SELECT set_config('app.current_tenant',$1,true)",approved.input.ctx.tenantId);
        await tx.$executeRawUnsafe("SELECT set_config('app.current_user',$1,true)",approved.input.ctx.userId);
        const rows=await tx.$queryRawUnsafe(`SELECT id::text,action,actor_user_id::text AS actor,"before_jsonb"->>'planSha256' AS plan_sha256 FROM audit_logs
          WHERE tenant_id=$1::uuid AND entity_type='case01_memory_corpus' AND entity_id=$2
          AND action IN ('synthetic_memory_projections_cleaned','synthetic_memory_metadata_reconciled') ORDER BY action`,approved.input.ctx.tenantId,p.plan.currentFixtureInstanceId);
        assert.equal(rows.length,2);
        for(const [id,action,plan] of [[cleaned.auditId,'synthetic_memory_projections_cleaned',p.planSha256],[reconciled.auditId,'synthetic_memory_metadata_reconciled',m.planSha256]]) {
          assert.equal(rows.filter(r=>r.id===id&&r.action===action&&r.actor===approved.input.ctx.userId&&r.plan_sha256===plan).length,1);
        }
        const jobs=await tx.$queryRawUnsafe(`SELECT id::text,status,attempts,lease_owner IS NULL AND lease_expires_at IS NULL AS lease_clear FROM memory_cleanup_outbox WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[]) ORDER BY id`,approved.input.ctx.tenantId,approved.originalCleanupJobs.map(j=>j.id));
        assert.equal(jobs.length,6);assert.ok(jobs.every(j=>j.status==='completed'&&j.attempts===1&&j.lease_clear));
        return {auditRows:rows,completedOriginalJobs:jobs};
      });
    } finally {await auditDb.$disconnect();}
    console.log('C2_MAINTENANCE_SEQUENCE_RECEIPT '+JSON.stringify({status:'COMMITTED_MAINTENANCE_AND_CURRENT_CORPUS_VERIFIED',packetSha256:approved.packetSha256,
      sourceSha:approved.sourceSha,steps,auditReadback,currentVerifySha256:current.currentVerifySha256,
      fixtureReady:true,captureAuthority:false,providerAuthority:false,providerCalls:0,liveAcceptance:'NOT_RUN'}));
  } catch(error) {
    console.log('C2_MAINTENANCE_SEQUENCE_RECEIPT '+JSON.stringify({status:'STOPPED_REQUIRES_RECONCILIATION',packetSha256:approved.packetSha256,steps,errorClass:error?.name??'Error',noAutomaticRetry:true,captureAuthority:false,providerAuthority:false}));
    process.exitCode=1;
  }
}
