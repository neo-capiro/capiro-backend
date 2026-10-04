const assert = require('node:assert/strict');
const {randomUUID,createHash} = require('node:crypto');
const core = require('@capiro/meriv2-core');
const {MERI_CAPABILITY_REGISTRY} = require('@capiro/shared');
const secret = 'synthetic-offline-clock-secret';
const now = Date.now();
const policy = {
  version:1,kind:'server_readonly_acceptance_capture',policyId:randomUUID(),requestId:randomUUID(),traceId:randomUUID(),
  turnId:randomUUID(),caseId:'01',captureRunId:randomUUID(),fixtureVersion:'meri-live-v1-2026-09-26.1',
  physicalMapSha256:'a'.repeat(64),resetReceiptId:'synthetic-reset',seedReceiptId:'synthetic-seed',
  fixtureNamespace:'meri-foundation-20260928',tenantId:randomUUID(),tenantSlug:'meri-foundation-20260928-t1',
  actorUserId:randomUUID(),conversationId:randomUUID(),clientId:randomUUID(),issuedAt:now-1000,expiresAt:now+60000,
  toolAuthority:'shared_static_registry_read_only',toolCatalogSha256:createHash('sha256').update(
    MERI_CAPABILITY_REGISTRY.filter(t=>t.readOnly).map(t=>t.name).sort().join('\n')).digest('hex'),
  dynamicMcpAllowed:false,incidentalWriters:'suppressed',
  expectedCaptureWrites:['context_packet_and_evidence','conversation_user_message','conversation_assistant_message','provider_budget_ledger'],
};
const clock = {version:1,kind:'qualified_original_fixture_semantic_clock',instant:core.MERI_FIXTURE_SEMANTIC_INSTANT,
  timeZone:core.MERI_FIXTURE_SEMANTIC_ZONE,caseId:policy.caseId,captureRunId:policy.captureRunId,
  currentVerifySha256:'b'.repeat(64),observedAt:policy.issuedAt};
policy.semanticClock=clock;
const ctx={tenantId:policy.tenantId,userId:policy.actorUserId,role:'standard_user'};
const {composeChatSystemPrompt,buildChatDateGrounding} = require('./dist/meri/chat/chat-prompt.js');
const {runWithGovernedMeriContext,currentMeriPromptClockUse} = require('./dist/meri/meri-governed-context.runtime.js');
const {withTrustedCurrentTurnScope} = require('./dist/request/trusted-current-turn-scope.js');
const {RequestCredentialsStore} = require('./dist/request/request-credentials.store.js');
const {ApiToolExecutorRepo} = require('./dist/meri/api-tool-executor.repo.js');
const {readCaptureClockInvocations,withControlledReadInvocation} = require('./dist/meri/controlled-read-observations.js');
const {buildSignedOrchestratorCaptureEvidence} = require('./dist/meri/meriv3/meriv3-capture-evidence.js');
(async () => {
  const governed={version:1,operationId:'meri.chat',prompt:'',semanticClock:clock,
    evidence:{tenantId:ctx.tenantId,userId:ctx.userId},serverReadonlyCapturePolicy:policy,
    contextPacket:{clockUse:{instant:clock.instant,timeZone:clock.timeZone,eligibilityAt:new Date().toISOString(),scoring:'used'}}};
  let renderedObservation;
  await runWithGovernedMeriContext(governed,async()=>{
    assert.equal(currentMeriPromptClockUse(),undefined);
    const prompt=composeChatSystemPrompt({timeZone:'Pacific/Honolulu'},ctx);
    const block=buildChatDateGrounding(clock.timeZone,new Date(clock.instant));
    assert.ok(prompt.dynamic.includes(block));assert.ok(!prompt.base.includes(clock.instant.slice(0,10)));
    renderedObservation=currentMeriPromptClockUse();
    assert.equal(renderedObservation.instant,clock.instant);assert.equal(renderedObservation.timeZone,clock.timeZone);
    assert.equal(renderedObservation.date,'2026-09-26');
    assert.equal(renderedObservation.groundingSha256,createHash('sha256').update(block).digest('hex'));
    assert.ok(renderedObservation.renderedAt>=now && renderedObservation.renderedAt<=Date.now());
  });
  assert.equal(currentMeriPromptClockUse(),undefined);
  const before=new Date();const ordinary=composeChatSystemPrompt({timeZone:'UTC',semanticClock:clock},ctx);const after=new Date();
  assert.ok([before,after].some(time=>ordinary.dynamic.includes(buildChatDateGrounding('UTC',time))));
  assert.equal(currentMeriPromptClockUse(),undefined);
  await assert.rejects(runWithGovernedMeriContext({...governed,contextPacket:{clockUse:{...governed.contextPacket.clockUse,timeZone:'UTC'}}},
    async()=>composeChatSystemPrompt({},ctx)),/semantic_clock/);
  let fetches=0;global.fetch=async()=>{fetches++;throw new Error('Offline probe must not fetch');};
  const repo=new ApiToolExecutorRepo({get:key=>({MERIV2_API_BASE_URL:'https://offline.invalid',INTERNAL_SERVICE_SECRET:secret})[key]});
  await withTrustedCurrentTurnScope({tenantId:ctx.tenantId,userId:ctx.userId,conversationId:policy.conversationId,
    selectedClientId:policy.clientId,capturePolicy:policy},()=>RequestCredentialsStore.run({bearerToken:'synthetic-bearer'},async()=>{
      await assert.rejects(repo.execute(ctx,'search_memory',{}),/invocation missing/);
      assert.equal(fetches,0);
      const invocations=readCaptureClockInvocations();
      assert.equal(invocations.length,1);assert.equal(invocations[0].callId,'');
      assert.equal(invocations[0].httpAttempts,0);assert.equal(invocations[0].outcome,'threw');
      assert.equal(invocations[0].httpStatus,null);assert.deepEqual(invocations[0].packets,[]);
      const signed=buildSignedOrchestratorCaptureEvidence({policy,startedAt:policy.issuedAt,completedAt:Date.now(),
        providerCallObserved:false,provider:'synthetic',model:null,usage:null,secret,execution:{
          toolCalls:[],sources:[],clockInvocations:invocations,promptClockUse:renderedObservation,
          estimatedCostUsd:{status:'UNKNOWN',value:null,reason:'not_run'}}});
      assert.equal(signed.receipt.status,'BLOCKED');
      assert.ok(signed.receipt.blockers.includes('semantic_clock_invocation_join_unproved'));
      assert.ok(signed.receipt.blockers.includes('semantic_clock_api_tool_join_pending'));
      assert.equal(core.verifyMeriCaptureEvidenceReceipt(signed,policy,secret).status,'BLOCKED');
    }));
  assert.equal(readCaptureClockInvocations(),undefined);
  assert.equal(await withControlledReadInvocation(undefined,async()=>17),17);
  console.log('OFFLINE_PACKAGED_SEMANTIC_CLOCK_ORCHESTRATOR_PASS');
  console.log('Actual packaged prompt/refusal behavior only; no provider, database join or live capture qualification is claimed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
