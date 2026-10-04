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
const {qualifyMeriCaptureSemanticClock} = require('./dist/meri/meri-capture-semantic-clock.js');
const {readMeriCaptureClockPackets} = require('./dist/meri/meri-capture-clock-packets.js');
const {validateMeriCapturePolicyPair} = require('./dist/meri/meri-capture-policy-readback.js');
const {buildApiOnlyMeriServerCaptureEvidence} = require('./dist/meri/meri-server-capture-evidence.js');
(async () => {
  assert.equal(clock.instant,'2026-09-26T16:00:00.000Z');assert.equal(clock.timeZone,'America/New_York');
  assert.deepEqual(core.validateMeriFixtureSemanticClock(clock,policy),clock);
  assert.throws(()=>core.validateMeriFixtureSemanticClock({...clock,timeZone:'UTC'},policy),/semantic_clock/);
  assert.throws(()=>core.validateMeriFixtureSemanticClock(clock,{...policy,syntheticReadBudget:{}}),/semantic_clock/);
  let loads=0;
  const compiler=new core.ContextCompiler({loadSteeringRows:async()=>{loads++;return [];}});
  const request={tenantId:ctx.tenantId,userId:ctx.userId,clientId:policy.clientId,surface:'chat',layers:[]};
  for(const version of [1,2]) {
    const before=Date.now();
    const packet=await compiler.compile({...request,contractVersion:version,now:new Date(clock.instant),semanticClock:clock});
    assert.equal(packet.version,version);assert.equal(packet.persisted,false);
    assert.equal(packet.clockUse.instant,clock.instant);assert.equal(packet.clockUse.timeZone,clock.timeZone);
    assert.equal(packet.clockUse.scoring,version===1?'not_run':'used');
    assert.ok(Date.parse(packet.clockUse.eligibilityAt)>=before && Date.parse(packet.clockUse.eligibilityAt)<=Date.now());
    const ordinary=await compiler.compile({...request,contractVersion:version});
    assert.equal(ordinary.clockUse,undefined);assert.equal(ordinary.persisted,false);
  }
  const beforeMismatch=loads;
  await assert.rejects(compiler.compile({...request,now:new Date('2020-01-01Z'),semanticClock:clock}),/request_mismatch/);
  assert.equal(loads,beforeMismatch);
  let databaseCalls=0;
  const prisma={withTenantUser:async()=>{databaseCalls++;throw new Error('Offline probe must not access DB');}};
  assert.equal(await qualifyMeriCaptureSemanticClock({prisma,ctx,policy:null}),undefined);
  const {semanticClock:ignored,...withoutClock}=policy;
  assert.equal(await qualifyMeriCaptureSemanticClock({prisma,ctx,policy:{...withoutClock,syntheticReadBudget:{}}}),undefined);
  const makeReceipt=p=>buildApiOnlyMeriServerCaptureEvidence({policy:p,userMessageId:p.turnId,assistantMessageId:randomUUID(),citations:[],usage:null,secret});
  process.env.INTERNAL_SERVICE_SECRET=secret;
  const incomplete=makeReceipt(policy);
  assert.equal(incomplete.receipt.status,'BLOCKED');
  assert.ok(incomplete.receipt.blockers.includes('semantic_clock_api_tool_join_pending'));
  assert.ok(incomplete.receipt.blockers.includes('semantic_clock_invocations_unproved'));
  assert.deepEqual(validateMeriCapturePolicyPair(policy,incomplete),policy);
  const {finalizeMeriServerCaptureEvidence}=require('./dist/meri/meri-server-readonly-capture.js');
  const finalized=finalizeMeriServerCaptureEvidence({policy,orchestrator:incomplete,
    userMessageId:policy.turnId,assistantMessageId:randomUUID(),clockPackets:null,secret});
  const persistedShape=JSON.parse(JSON.stringify(finalized));
  assert.equal(Object.hasOwn(finalized.receipt.semanticClock,'api'),false);
  assert.equal(finalized.receipt.semanticClock.apiJoin,'PENDING');
  assert.equal(finalized.receipt.status,'BLOCKED');
  assert.deepEqual(core.verifyMeriCaptureEvidenceReceipt(persistedShape,policy,secret),finalized.receipt);
  const budget={version:1,boundary:'case01_memory_turn',status:'SETTLED',admissionId:randomUUID(),
    ledgerSha256:'c'.repeat(64),qualificationSha256:'d'.repeat(64),turnId:policy.turnId,
    attempts:0,chargedTokens:0,chargedCostMicros:0,maxCostMicros:15000000,unaccountedBoundaries:[]};
  assert.equal(core.meriCaptureReceiptBlockers({...finalized.receipt,providerBudget:budget}).includes('provider_budget_malformed'),false);
  assert.equal(core.meriCaptureReceiptBlockers({...finalized.receipt,providerBudget:{...budget,maxCostMicros:15000001}}).includes('provider_budget_malformed'),true);
  const {readOwnPendingMemoryProposals}=require('./dist/meri/meri-memory-proposal-read.js');
  let proposalOwnerCalls=0;
  const proposalOwner={listOwnProposals:async(actor,filter)=>{
    proposalOwnerCalls++;assert.deepEqual(actor,ctx);assert.equal(filter.clientId,policy.clientId);
    return {enabled:true,nextCursor:null,candidates:[]};
  }};
  const proposal=await readOwnPendingMemoryProposals(ctx,{clientId:policy.clientId},proposalOwner,policy);
  assert.equal(proposal.claimsAreApprovedFacts,false);assert.equal(proposal.coverage.complete,true);
  assert.deepEqual(proposal.scope,{tenantId:ctx.tenantId,userId:ctx.userId,clientId:policy.clientId});
  await assert.rejects(readOwnPendingMemoryProposals(ctx,{},proposalOwner,policy),/capture_scope_mismatch/);
  assert.equal(proposalOwnerCalls,1);
  console.log('OFFLINE_PACKAGED_CAPTURE_RECEIPT_CONTRACT_PASS');
  console.log('Synthetic owner collaborator only; no actual DB, provider, human acceptance or admitted budget is claimed.');
  assert.throws(()=>validateMeriCapturePolicyPair({...policy,clockReady:true},incomplete),/readback_denied/);
  assert.throws(()=>validateMeriCapturePolicyPair({...policy,semanticClock:{...clock,instant:'2020-01-01T00:00:00.000Z'}},incomplete),/readback_denied/);
  assert.equal(await readMeriCaptureClockPackets({prisma,ctx,policy,orchestrator:incomplete,initialPacket:null,secret}),null);
  const ordinary={...withoutClock,caseId:null,captureRunId:null,fixtureVersion:null,physicalMapSha256:null,resetReceiptId:null,seedReceiptId:null};
  const ordinaryReceipt=makeReceipt(ordinary);
  assert.equal(ordinaryReceipt.receipt.semanticClock,undefined);
  assert.deepEqual(validateMeriCapturePolicyPair(ordinary,ordinaryReceipt),ordinary);
  assert.equal(databaseCalls,0);
  console.log('OFFLINE_PACKAGED_SEMANTIC_CLOCK_API_CORE_PASS');
  console.log('Compiler store is in-memory; no database persistence or live capture qualification is claimed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
