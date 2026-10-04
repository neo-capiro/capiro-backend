import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {withCompiledFactory,compiled,require,save} from './compiled-factory-harness.mjs';

test('compiled ECS admission private handles share actual default DB transaction rollback (ECS doubles only)',async t=>{
 const check=async(name,fn)=>{let failure;await t.test(name,async()=>{try{await fn();}catch(error){failure=error;throw error;}});if(failure)throw failure;};
 const result=await withCompiledFactory(async h=>{
  const native=compiled('meri/meri-case12-native-setup-admission'),budget=compiled('meri/meri-case12-setup-budget');
  const ecs=require('@aws-sdk/client-ecs'),sendBefore=ecs.ECSClient.prototype.send,fetchBefore=globalThis.fetch;
  const saved=new Map(['ECS_CONTAINER_METADATA_URI_V4','MERI_CASE12_NATIVE_SETUP_INPUT','GIT_SHA'].map(k=>[k,process.env[k]]));
  const checks=[],reads=[];let active;
  const deny=()=>{throw Error('LOCAL_ECS_UNEXPECTED_TRANSPORT');};
  globalThis.fetch=async(url,opts)=>{
   assert.equal(url,'http://169.254.170.2/v4/local-owned-admission/task');assert.equal(opts.redirect,'error');assert.ok(active);
   reads.push({kind:'metadata',fixture:active.marker});return new Response(JSON.stringify(active.meta),{status:200});
  };
  ecs.ECSClient.prototype.send=async function(command){
   assert.ok(active);assert.equal(await this.config.region(),'us-east-1');assert.equal(await this.config.maxAttempts(),1);
   if(command instanceof ecs.DescribeTasksCommand){assert.deepEqual(command.input,{cluster:active.task.clusterArn,tasks:[active.task.taskArn],include:['TAGS']});reads.push({kind:'DescribeTasks',fixture:active.marker});return{tasks:[active.task],failures:[]};}
   if(command instanceof ecs.DescribeTaskDefinitionCommand){assert.deepEqual(command.input,{taskDefinition:active.definition.taskDefinitionArn,include:['TAGS']});reads.push({kind:'DescribeTaskDefinition',fixture:active.marker});return{taskDefinition:active.definition,tags:active.tags};}
   return deny();
  };
  const fixture=()=>{
   const now=Date.now(),base=h.snapshot.tenant.settings.meriFoundationFixture.case12SetupProviderBudget.plan;
   const plan=budget.validateCase12SetupBudgetPlan({...structuredClone(base),runId:randomUUID(),aggregateReservationId:randomUUID(),admittedAt:new Date(now-1000).toISOString(),deadlineAt:new Date(now+600000).toISOString(),ratesExpiresAt:new Date(now+3600000).toISOString()});
   const family='capiro-dev-meri-c2-case12-setup-local-test',definitionArn='arn:aws:ecs:us-east-1:967807252336:task-definition/'+family+':1',cluster='arn:aws:ecs:us-east-1:967807252336:cluster/capiro-dev';
   const definition={taskDefinitionArn:definitionArn,family,revision:1,status:'ACTIVE',containerDefinitions:[{name:'api',image:'967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:'+plan.imageSha256,command:['node','scripts/local-test-only-no-dispatch.mjs'],environment:[{name:'GIT_SHA',value:'b'.repeat(40)}]}]};
   const n={kind:'meri-case12-ecs-native-setup',version:1,taskDefinitionArn:definitionArn,taskDefinitionSha256:native.case12NativeTaskDefinitionHash(definition),containerName:'api',startedBy:'c12-'+randomUUID(),registrationMarker:randomUUID(),releaseGitRevision:'b'.repeat(40),setupRunId:plan.runId,reservationId:plan.aggregateReservationId,fixtureInstanceId:plan.fixtureInstanceId,setupPlanSha256:plan.setupPlanSha256,providerPlanSha256:budget.case12SetupHash(plan),preHoldCheckpointSha256:plan.aggregateCheckpointSha256,postHoldCheckpointSha256:'c'.repeat(64),costAuthoritySha256:'d'.repeat(64)};
   const raw=JSON.stringify({native:n}),tags=[{key:'meri-case12-setup-owner',value:n.registrationMarker}],taskArn=cluster.replace(':cluster/',':task/')+'/'+randomUUID().replaceAll('-','');
   const task={taskArn,clusterArn:cluster,taskDefinitionArn:definitionArn,startedBy:n.startedBy,launchType:'FARGATE',desiredStatus:'RUNNING',lastStatus:'RUNNING',group:'family:'+family,tags,containers:[{name:'api',imageDigest:'sha256:'+plan.imageSha256}],overrides:{containerOverrides:[{name:'api',environment:[{name:'MERI_CASE12_NATIVE_SETUP_INPUT',value:raw}]}]}};
   const meta={Cluster:cluster,TaskARN:taskArn,Family:family,Revision:'1',Containers:[{Name:'api',ImageID:'sha256:'+plan.imageSha256}]};
   process.env.ECS_CONTAINER_METADATA_URI_V4='http://169.254.170.2/v4/local-owned-admission';process.env.MERI_CASE12_NATIVE_SETUP_INPUT=raw;process.env.GIT_SHA=n.releaseGitRevision;
   active={plan,raw,definition,task,meta,tags,marker:n.registrationMarker};
   return{...active,bindings:{recipe:{fixtureInstanceId:plan.fixtureInstanceId,ctx:{tenantId:plan.tenantId,userId:plan.proposerUserId},reviewerUserId:plan.reviewerUserId},plan:{planSha256:plan.setupPlanSha256,recipeSha256:plan.recipeSha256,orderedDefinitionSha256:plan.orderedDefinitionSha256}}};
  };
  const current=()=>h.tx('READ_PRISTINE_SETTINGS',async tx=>(await tx.$queryRawUnsafe('SELECT settings_jsonb AS settings FROM tenants WHERE id=$1::uuid',h.ctx.tenantId))[0].settings);
  const before=await current();
  const clearOnlyInsideRollback=tx=>tx.$executeRawUnsafe("UPDATE tenants SET settings_jsonb=settings_jsonb #- '{meriFoundationFixture,case12MemorySetup}' #- '{meriFoundationFixture,case12SetupProviderBudget}' WHERE id=$1::uuid",h.ctx.tenantId);
  try{
   await check('untrusted JSON cannot replace authenticated private handle',async()=>{
    const f=fixture(),owner=await native.createCase12NativeSetupAdmission(f.raw,f.plan);let calls=0;
    await assert.rejects(()=>owner.consumeNativeSetupAdmissionInTx({$queryRawUnsafe:async()=>{calls++;return[];}},{},f.bindings),/denied/u);assert.equal(calls,0);
    checks.push('JSON substitute rejected before DB');
   });
   await check('valid native consume writes inside supplied tx, outer rollback undoes DB but not handle burn',async()=>{
    const f=fixture(),owner=await native.createCase12NativeSetupAdmission(f.raw,f.plan),rollback=Error('LOCAL_EXPECTED_ROLLBACK');
    await assert.rejects(()=>h.tx('NATIVE_CONSUME_OUTER_ROLLBACK',async tx=>{
     await clearOnlyInsideRollback(tx);assert.deepEqual(await owner.consumeNativeSetupAdmissionInTx(tx,owner.admission,f.bindings),f.plan);
     const[r]=await tx.$queryRawUnsafe("SELECT settings_jsonb #> '{meriFoundationFixture,case12NativeSetupAdmission}' AS admission FROM tenants WHERE id=$1::uuid",h.ctx.tenantId);
     assert.equal(r.admission.taskArn,f.task.taskArn);assert.equal(r.admission.captureAuthority,false);throw rollback;
    }),e=>e===rollback);assert.deepEqual(await current(),before);
    let calls=0;await assert.rejects(()=>owner.consumeNativeSetupAdmissionInTx({$queryRawUnsafe:async()=>{calls++;return[];}},owner.admission,f.bindings),/denied/u);assert.equal(calls,0);checks.push('native DB rollback with non-reusable consumed handle');
   });
   await check('lost native write readback aborts real tx and retains one-use failure',async()=>{
    const f=fixture(),owner=await native.createCase12NativeSetupAdmission(f.raw,f.plan);
    await assert.rejects(()=>h.tx('NATIVE_LOST_WRITE_READBACK',async tx=>{
     await clearOnlyInsideRollback(tx);
     const wrapped={$queryRawUnsafe:async(query,...args)=>{const result=await tx.$queryRawUnsafe(query,...args);return query.trimStart().startsWith('UPDATE tenants')?[]:result;}};
     return owner.consumeNativeSetupAdmissionInTx(wrapped,owner.admission,f.bindings);
    }),/denied/u);assert.deepEqual(await current(),before);checks.push('lost readback aborted actual local transaction');
   });
   await check('concurrent same handle allows one DB writer and cannot replay after rollback',async()=>{
    const f=fixture(),owner=await native.createCase12NativeSetupAdmission(f.raw,f.plan),rollback=Error('LOCAL_CONCURRENT_ROLLBACK');
    await assert.rejects(()=>h.tx('NATIVE_CONCURRENT_HANDLE',async tx=>{
     await clearOnlyInsideRollback(tx);const results=await Promise.allSettled([owner.consumeNativeSetupAdmissionInTx(tx,owner.admission,f.bindings),owner.consumeNativeSetupAdmissionInTx(tx,owner.admission,f.bindings)]);
     assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);throw rollback;
    }),e=>e===rollback);assert.deepEqual(await current(),before);checks.push('concurrent handle native transaction single consumption');
   });
   await check('existing actual completed setup rejects fresh admission without changing slots',async()=>{
    const f=fixture(),owner=await native.createCase12NativeSetupAdmission(f.raw,f.plan);
    await assert.rejects(()=>h.tx('EXISTING_NATIVE_SETUP_DENY',tx=>owner.consumeNativeSetupAdmissionInTx(tx,owner.admission,f.bindings)),/denied/u);assert.deepEqual(await current(),before);checks.push('completed fixture cannot receive fresh admission');
   });
   return{status:'PASS_COMPILED_NATIVE_ADMISSION_LOCAL_DB_ECS_DOUBLES',checks,controlledEcsReads:reads,transactions:h.transactions,awsNetworkCalls:0,liveProviderCalls:0,originalSnapshotSlotsPreserved:true,originalPrompt:'NOT_RUN',liveAcceptance:'NOT_RUN',nativeLiveAdmissionQualified:false};
  }finally{ecs.ECSClient.prototype.send=sendBefore;globalThis.fetch=fetchBefore;for(const[k,v]of saved){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
 },'native-admission-v1');
 await save('native-admission-rollback-qualification.json',result);
});
