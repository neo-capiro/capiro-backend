import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {withCompiledFactory,repo,compiled,require,save,hash} from './compiled-factory-harness.mjs';

test('restored local510 uses freshly compiled native factory, default transactions and real signed source joins',async t=>{
 const check=async(name,fn)=>{let failure;await t.test(name,async()=>{try{await fn();}catch(error){failure=error;throw error;}});if(failure)throw failure;};
 const result=await withCompiledFactory(async h=>{
  const checks=[],stage=async(name,fn)=>{h.setPhase(name);const start=performance.now();const value=await h.run(fn);checks.push({name,durationMs:performance.now()-start});return value;};
  const {readCase12Setup}=await import(pathToFileURL(repo+'/evals/meri/live-v1/fixture-provisioning/case12-memory-setup.mjs').href);
  const deps={...h.factory.deps,readCase12CanonicalEligibilityInTx:compiled('retrieval/adapters/case12-memory-eligibility.read').readCase12CanonicalEligibilityInTx};
  let hydrated;
  await check('actual complete setup hydration uses unchanged default transaction limits',async()=>{
   hydrated=await stage('FULL_HYDRATION',()=>readCase12Setup(deps,h.recipe));
   await save('hydration.json',hydrated);assert.equal(hydrated.status,'CURRENT_HYDRATED');assert.equal(hydrated.reconciliationRequired,false);
  });
  const authority=compiled('meri/meri-case12-capture-authority'),install=compiled('meri/meri-case12-capture-install');
  const budgetInstall=compiled('meri/meri-capture-provider-budget-install'),budget=compiled('meri/meri-capture-provider-budget');
  const current=compiled('meri/meri-server-readonly-capture'),provider=compiled('meri/meri-capture-provider-budget-owner');
  const core=require('@capiro/meriv2-core'),clientId=h.recipe.clients.ASTER.physicalId;
  let completed,bindingPlan,bindingInstalled;
  await check('native current corpus plus complete510 ledger is read from current database',async()=>{
   completed=await h.tx('COMPLETED_CORPUS',tx=>authority.readMeriCase12CompletedCorpusInTx(h.factory.deps.prisma,tx,h.ctx,clientId));
   assert.equal(completed.proof.corpusQualified,true);assert.equal(completed.completion.completedRows,510);
   assert.equal(completed.completion.providerAttempts,1020);assert.equal(completed.completion.captureAuthority,false);
   await save('completed-corpus.json',completed);
  });
  const input={ctx:h.ctx,clientId,captureRunId:randomUUID()};
  await check('binding exact plan and stale CAS are native, then install exactly once',async()=>{
   bindingPlan=await h.tx('BINDING_PLAN',tx=>install.inspectCase12CaptureBindingInTx(h.factory.deps.prisma,tx,input));
   await assert.rejects(()=>h.tx('BINDING_WRONG_PLAN',tx=>install.installCase12CaptureBindingInTx(h.factory.deps.prisma,tx,{...input,expectedPlanSha256:'0'.repeat(64),confirmation:'INSTALL_CASE12_CAPTURE_BINDING_ONCE'})),/stale_plan/u);
   bindingInstalled=await h.tx('BINDING_INSTALL',tx=>install.installCase12CaptureBindingInTx(h.factory.deps.prisma,tx,{...input,expectedPlanSha256:bindingPlan.planSha256,confirmation:'INSTALL_CASE12_CAPTURE_BINDING_ONCE'}));
   await assert.rejects(()=>h.tx('BINDING_REPLAY',tx=>install.installCase12CaptureBindingInTx(h.factory.deps.prisma,tx,{...input,expectedPlanSha256:bindingPlan.planSha256,confirmation:'INSTALL_CASE12_CAPTURE_BINDING_ONCE'})),/existing_case12_binding/u);
   await save('binding-plan.json',bindingPlan);await save('binding-installed.json',bindingInstalled);
  });
  let qualification;
  await check('native provider qualification current source checks and stale CAS protect installation',async()=>{
   const plan=await stage('PROVIDER_PLAN',()=>budgetInstall.inspectCaptureProviderBudgetInstallation(deps,{ctx:h.ctx,clientId}));
   // Artificial local test price/model only. This is not reviewed market evidence
   // and cannot authorize a provider, live journal or aggregate reservation.
   const now=Date.now(),rates=[{kind:'openai_responses',provider:'openai',model:'local-test-model',inputMicrosPerMillion:1_000_000,outputMicrosPerMillion:2_000_000}];
   const rateEvidence={kind:'meri-capture-reviewed-provider-rates',version:1,priceKind:'qualified_text_token_upper_bound',observedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+3600000).toISOString(),maxTokens:1000,rates,sources:[{kind:'openai_responses',provider:'openai',model:'local-test-model',url:'https://local-test.invalid/artificial-rate-fixture',unitContract:'LOCAL TEST ONLY: no market pricing or live qualification'}]};
   qualification={version:1,caseId:'12',captureRunId:input.captureRunId,currentVerifySha256:plan.currentVerifySha256,rateEvidenceSha256:budget.captureBudgetHash(rateEvidence),rateEvidenceExpiresAt:rateEvidence.expiresAt,priceKind:rateEvidence.priceKind,maxAttempts:3,maxTokens:1000,maxCostMicros:1000,rates};
   const args={ctx:h.ctx,clientId,qualification,rateEvidence,expectedCurrentVerifySha256:plan.currentVerifySha256,expectedCaptureBindingSha256:plan.captureBindingSha256,expectedPriorQualificationSha256:plan.priorQualificationSha256,expectedTenantRowVersion:plan.tenantRowVersion};
   await assert.rejects(()=>stage('PROVIDER_STALE_CAS',()=>budgetInstall.installCaptureProviderBudgetQualification(deps,{...args,expectedTenantRowVersion:'0'})),/compare_and_swap_conflict/u);
   const installed=await stage('PROVIDER_INSTALL',()=>budgetInstall.installCaptureProviderBudgetQualification(deps,args));
   assert.equal(installed.status,'PROVIDER_QUALIFICATION_INSTALLED');await save('provider-qualification-local-only.json',{scope:'ARTIFICIAL_TEST_RATES_NO_LIVE_AUTHORITY',plan,rateEvidence,qualification,installed});
  });
  const conversationId=randomUUID(),turnId=randomUUID(),messageId=randomUUID();let policy,fixture;
  await check('ordinary current conversation authority issues policy and actual native semantic clock',async()=>{
   await h.tx('LOCAL_TRANSCRIPT_ROWS',async tx=>{
    await tx.$executeRawUnsafe('INSERT INTO clio_conversations(id,tenant_id,user_id,client_id,title) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5)',conversationId,h.ctx.tenantId,h.ctx.userId,clientId,'LOCAL TRANSCRIPT ONLY');
    await tx.$executeRawUnsafe('INSERT INTO clio_messages(id,tenant_id,user_id,client_id,conversation_id,role,body) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7)',turnId,h.ctx.tenantId,h.ctx.userId,clientId,conversationId,'user','LOCAL TRANSCRIPT ONLY; original Case12 prompt NOT RUN');
   });
   const issued=await stage('POLICY_ISSUANCE',()=>current.issueMeriServerReadonlyCapturePolicy({prisma:h.factory.deps.prisma,ctx:h.ctx,conversationId}));
   assert.equal(issued.caseId,'12');policy={...issued,turnId};
   policy.semanticClock=await stage('SEMANTIC_CLOCK',()=>compiled('meri/meri-capture-semantic-clock').qualifyMeriCaptureSemanticClock({prisma:h.factory.deps.prisma,ctx:h.ctx,policy}));
   assert.equal(policy.semanticClock.instant,'2026-09-26T16:00:00.000Z');
   fixture=await h.tx('CURRENT_CAPTURE_AUTHORITY',tx=>authority.assertMeriCase12BindingInTx(h.factory.deps.prisma,tx,h.ctx,policy));
   assert.equal(fixture.approvedPassageSha256,hash(fixture.approvedText));
   assert.equal(fixture.currentVerifySha256,completed.proof.currentVerifySha256);
   await assert.rejects(()=>h.tx('CHANGED_LEDGER_DENY',tx=>authority.assertMeriCase12BindingInTx(h.factory.deps.prisma,tx,h.ctx,{...policy,case12Setup:{...policy.case12Setup,setupLedgerSha256:'0'.repeat(64)}})),/current_setup_and_corpus_required/u);
   await assert.rejects(()=>h.tx('FOREIGN_ACTOR_DENY',tx=>authority.assertMeriCase12BindingInTx(h.factory.deps.prisma,tx,{...h.ctx,userId:randomUUID()},policy)),/current_setup_and_corpus_required/u);
   await save('policy-local-only.json',policy);await save('current-authority.json',fixture);
  });
  let settled;
  await check('native local ledger reserves and settles a transcript attempt without transport',async()=>{
   const args={prisma:h.factory.deps.prisma,ctx:h.ctx,policy};
   await stage('PROVIDER_ADMIT_LOCAL',()=>provider.captureProviderBudgetOwner({...args,operation:{kind:'admit'}}));
   const binding={logicalOperationId:'local-transcript',attemptId:'local-transcript-1',retryOfAttemptId:null,kind:'openai_responses',phase:'synthesis',provider:'openai',model:'local-test-model',maxInputTokens:10,maxOutputTokens:10};
   const reserved=await stage('PROVIDER_RESERVE_LOCAL',()=>provider.captureProviderBudgetOwner({...args,operation:{kind:'reserve',binding}}));assert.equal(reserved.dispatchAllowed,true);
   settled=await stage('PROVIDER_SETTLE_LOCAL',()=>provider.captureProviderBudgetOwner({...args,operation:{kind:'settle',input:{reservationId:reserved.reservationId,binding,outcome:{kind:'known',inputTokens:1,outputTokens:1}}}}));
   assert.equal(settled.state.ledger.chargedCostMicros,3);
   await save('provider-transcript-local-only.json',{scope:'SYNTHETIC_USAGE_NO_PROVIDER_CALL',reserved,settled});
  });
  let raw,initial,tools;
  await check('real persisted packet census performs two current-source checks in one default transaction',async()=>{
   const clockUse={instant:policy.semanticClock.instant,timeZone:policy.semanticClock.timeZone,eligibilityAt:new Date().toISOString(),scoring:'used'};
   initial={packetId:randomUUID(),persisted:true,clockUse:{...clockUse},clientId};tools=[{packetId:randomUUID(),persisted:true,clockUse:{...clockUse}}];
   await h.tx('LOCAL_PACKET_ROWS',async tx=>{for(const[index,p]of [initial,...tools].entries()){
    const ref={operationId:'meri.chat',subjectScope:'client',conversationId,...(index?{tool:'search_memory',capturePolicyId:policy.policyId,captureRequestId:policy.requestId,captureTurnId:policy.turnId}:{})};
    await tx.$executeRawUnsafe('INSERT INTO context_packet(id,tenant_id,effective_tenant_id,user_id,actor_user_id,client_id,surface,ref_jsonb,model_policy_jsonb,packet_version,trace_id) VALUES ($1::uuid,$2::uuid,$2::uuid,$3::uuid,$3::uuid,$4::uuid,$5,$6::jsonb,$7::jsonb,2,$8)',p.packetId,h.ctx.tenantId,h.ctx.userId,clientId,'chat',JSON.stringify(ref),JSON.stringify({contextCompilerClockUse:p.clockUse}),policy.traceId);
   }});
   raw=compiled('meri/meri-server-capture-evidence').buildApiOnlyMeriServerCaptureEvidence({policy,userMessageId:turnId,assistantMessageId:messageId,citations:[],usage:{inputTokens:1,outputTokens:1},secret:process.env.INTERNAL_SERVICE_SECRET}).receipt;
   const source=fixture.sources[0];raw.sources=[{sourceId:source.physicalId,toolCallId:'local-call',tenantId:core.observed(source.tenantId),clientId:core.observed(source.clientId),currentVersion:core.observed('content:'+hash(fixture.approvedText+'\0'+source.sourceVersion)),fullRead:core.observed(true),locator:core.observed('characters 0-'+fixture.approvedText.length),passageSha256:core.observed(fixture.approvedPassageSha256),byteSha256:core.observed(fixture.approvedPassageSha256)}];
   raw.toolCalls=[{callId:'local-call',name:'search_memory',attempt:1,status:'complete',readOnly:true,sourceIds:[source.physicalId]}];
   raw.usage.provider=core.observed('openai');raw.usage.model=core.observed('local-test-model');raw.releases.orchestrator.releaseRevision=core.observed('b'.repeat(40));
   raw.providerBudget={version:1,boundary:'case12_memory_turn',status:'SETTLED',admissionId:settled.state.admissionId,turnId,ledgerSha256:budget.captureBudgetHash(settled.state.ledger),qualificationSha256:settled.state.qualificationSha256,attempts:1,chargedTokens:2,chargedCostMicros:3,maxCostMicros:1000,unaccountedBoundaries:[]};
   raw.semanticClock={binding:policy.semanticClock,prompt:core.observed({instant:policy.semanticClock.instant,timeZone:policy.semanticClock.timeZone,date:'2026-09-26',renderedAt:Date.now(),groundingSha256:hash('local transcript clock')}),invocations:[{callId:'local-call',tool:'search_memory',outcome:'returned',httpAttempts:1,httpStatus:200,responseSha256:hash(fixture.approvedText),packets:tools}],apiJoin:'PENDING'};
   raw.completedAt=Date.now();
   const signed=core.signMeriCaptureEvidenceReceipt(core.completeMeriCaptureEvidenceReceipt(raw),process.env.INTERNAL_SERVICE_SECRET);
   const joined=await stage('CLOCK_PACKET_TWO_SOURCE_READS',()=>compiled('meri/meri-capture-clock-packets').readMeriCaptureClockPackets({prisma:h.factory.deps.prisma,ctx:h.ctx,policy,orchestrator:signed,initialPacket:initial,secret:process.env.INTERNAL_SERVICE_SECRET}));
   assert.ok(joined);assert.deepEqual(joined.tools,tools);raw.semanticClock.apiJoin='VERIFIED';raw.semanticClock.api=joined;
   await save('clock-packet-local-transcript.json',{scope:'LOCAL_PERSISTED_PACKET_TRANSCRIPT_NO_TOOL_OR_PROMPT_EXECUTION',joined});
  });
  await check('genuine HMAC receipt verifies exact current MA510 and rejects signed partial passage',async()=>{
   const receipt=core.completeMeriCaptureEvidenceReceipt(raw);assert.deepEqual(receipt.blockers,[]);
   const envelope=core.signMeriCaptureEvidenceReceipt(receipt,process.env.INTERNAL_SERVICE_SECRET);
   const metadata={serverReadonlyCapturePolicy:policy,serverCaptureEvidenceReceipt:envelope};
   await h.tx('PERSIST_LOCAL_RECEIPT',tx=>tx.$executeRawUnsafe('INSERT INTO clio_messages(id,tenant_id,user_id,client_id,conversation_id,role,body,metadata_jsonb) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8::jsonb)',messageId,h.ctx.tenantId,h.ctx.userId,clientId,conversationId,'assistant','LOCAL TRANSCRIPT; no original response or human grading',JSON.stringify(metadata)));
   const message=await h.tx('READ_LOCAL_RECEIPT',async tx=>(await tx.$queryRawUnsafe('SELECT id,role,body,metadata_jsonb AS metadata FROM clio_messages WHERE id=$1::uuid AND tenant_id=$2::uuid',messageId,h.ctx.tenantId))[0]);
   const args={prisma:h.factory.deps.prisma,ctx:h.ctx,conversationId,message};
   const readback=await stage('SIGNED_SOURCE_READBACK',()=>compiled('meri/meri-case12-capture-readback').readMeriCase12CaptureReadback(args));
   assert.equal(readback.status,'QUALIFIED');assert.equal(readback.humanAcceptance,'NOT_RUN');
   const partial=structuredClone(raw);partial.sources[0].fullRead=core.observed(false);
   const negative={...message,metadata:{...metadata,serverCaptureEvidenceReceipt:core.signMeriCaptureEvidenceReceipt(core.completeMeriCaptureEvidenceReceipt(partial),process.env.INTERNAL_SERVICE_SECRET)}};
   const blocked=await stage('SIGNED_PARTIAL_DENY',()=>compiled('meri/meri-case12-capture-readback').readMeriCase12CaptureReadback({...args,message:negative}));assert.equal(blocked.status,'BLOCKED');
   await save('signed-local-transcript.json',{scope:'LOCAL_SYNTHETIC_TRANSCRIPT_SIGNED_WITH_LOCAL_TEST_KEY',message,readback,partialReadback:blocked});
  });
  const final=await h.tx('PRISTINE_SETUP_SLOTS_PRESERVED',async tx=>(await tx.$queryRawUnsafe('SELECT settings_jsonb AS settings FROM tenants WHERE id=$1::uuid',h.ctx.tenantId))[0].settings);
  for(const slot of ['case12MemorySetup','case12SetupProviderBudget'])assert.deepEqual(final.meriFoundationFixture[slot],h.snapshot.tenant.settings.meriFoundationFixture[slot]);
  return{status:'PASS_COMPILED_NATIVE_RESTORED_LOCAL_COMPOSITION',checks,transactions:h.transactions,scope:'EXPLICIT_RESTORED_DATA_NEW_XMIN_NO_ORIGINAL_AUTHORITY',compiledFactory:true,defaultTimeoutMs:5000,setupClaimAndBudgetUnchanged:true,liveProviders:0,cloudCalls:0,journalChanges:0,originalPrompt:'NOT_RUN',humanAcceptance:'NOT_RUN',liveAcceptance:'NOT_RUN'};
 },'compiled-native-v1');
 await save('qualification.json',result);
});
