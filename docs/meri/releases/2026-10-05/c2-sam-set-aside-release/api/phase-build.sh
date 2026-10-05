set -euo pipefail
image="967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api:${EXPECTED_SHA}"
docker build --platform linux/arm64 \
  --label "org.opencontainers.image.revision=$EXPECTED_SHA" \
  --label 'org.opencontainers.image.source=https://github.com/neo-capiro/capirov2' \
  -f apps/api/Dockerfile -t "$image" .
test "$(docker image inspect "$image" --format '{{.Architecture}}')" = arm64
test "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$EXPECTED_SHA"
test "$(docker run --rm --network none --entrypoint node "$image" -p 'process.version')" = v22.23.3
docker run --rm --network none --entrypoint node "$image" -e \
  "const assert=require('node:assert/strict'); const p=require('@prisma/client'); assert.equal(typeof p.PrismaClient,'function'); const sanitize=require('sanitize-html'); assert.equal(sanitize('<strong>safe</strong><script>unsafe</script>'),'<strong>safe</strong>'); require('./dist/meri/meri-tools.service.js'); require('./dist/memory/memory-candidate.service.js'); console.log('OFFLINE_RUNTIME_IMPORT_PASS')"
docker run --rm --network none --entrypoint node "$image" --input-type=module -e \
  "import assert from 'node:assert/strict'; import {createCase01SetupDependencies} from '/app/apps/api/scripts/meri-case01-setup-dependencies.mjs'; import {inspectCase01ExecutionSetup,inspectCase01FirstApprovalRecovery,executeCase01FirstApprovalRecovery,inspectCase01FirstApprovalContinuation,executeCase01FirstApprovalContinuation,inspectCase01PostApprovalResume,executeCase01PostApprovalResume,inspectCase01PostSeedResume,executeCase01PostSeedResume} from '/app/evals/meri/live-v1/fixture-provisioning/case01-execution-setup.mjs'; import {readCase14MemoryOwnerInTx,installCase14RecallBindingInTx} from '/app/evals/meri/live-v1/fixture-provisioning/case14-memory-owner.mjs'; import {executePendingMemorySetup} from '/app/evals/meri/live-v1/fixture-provisioning/memory-pending-execution.mjs'; import {executeControlledReadSetup} from '/app/evals/meri/live-v1/fixture-provisioning/controlled-read-owner.mjs'; import {randomUUID} from 'node:crypto'; import {createRequire} from 'node:module'; import {createHydratedCase01MemoryOwner} from '/app/evals/meri/live-v1/fixture-provisioning/case01-memory-owner.mjs'; import {buildFixtureManifest} from '/app/evals/meri/live-v1/fixture-provisioning/manifest.mjs'; const require=createRequire(import.meta.url); assert.equal(typeof createCase01SetupDependencies,'function'); assert.equal(typeof executePendingMemorySetup,'function'); assert.equal(typeof executeControlledReadSetup,'function'); assert.equal(typeof inspectCase01ExecutionSetup,'function'); assert.equal(typeof inspectCase01FirstApprovalRecovery,'function'); assert.equal(typeof executeCase01FirstApprovalRecovery,'function'); assert.equal(typeof readCase14MemoryOwnerInTx,'function'); assert.equal(typeof installCase14RecallBindingInTx,'function'); assert.equal(typeof createHydratedCase01MemoryOwner,'function'); const manifest=await buildFixtureManifest({fixtureInstanceId:randomUUID()}); assert.match(manifest.contentSha256,/^[a-f0-9]{64}$/); require('./dist/meri/meri-case01-capture-authority.js'); require('./dist/meri/meri-capture-provider-budget-install.js'); require('./dist/meri/meri-case14-capture-authority.js'); assert.equal(typeof inspectCase01FirstApprovalContinuation,'function'); assert.equal(typeof executeCase01FirstApprovalContinuation,'function'); console.log('OFFLINE_CASE01_CONTINUATION_IMPORT_PASS'); assert.equal(typeof inspectCase01PostApprovalResume,'function'); assert.equal(typeof executeCase01PostApprovalResume,'function'); console.log('OFFLINE_CASE01_POSTAPPROVAL_IMPORT_PASS'); assert.equal(typeof inspectCase01PostSeedResume,'function'); assert.equal(typeof executeCase01PostSeedResume,'function'); console.log('OFFLINE_CASE01_POSTSEED_IMPORT_PASS'); console.log('OFFLINE_CASE01_FIXTURE_PACKAGE_IMPORT_PASS')"
docker run --rm --network none --entrypoint node "$image" -e \
  'const fs=require("node:fs"),c=require("node:crypto"),p=require("node:path"); const root="./prisma/migrations"; const files=fs.readdirSync(root).filter(n=>fs.existsSync(p.join(root,n,"migration.sql"))).sort(); if(files.length!==452)throw new Error("MIGRATION_COUNT"); console.log(JSON.stringify(files.map(n=>({name:n,sha256:c.createHash("sha256").update(fs.readFileSync(p.join(root,n,"migration.sql"))).digest("hex")}))));' > image-migration-hashes.json
python3 - <<'PY'
import json,pathlib,hashlib
observed=json.loads(pathlib.Path('image-migration-hashes.json').read_text())
expected=[{'name':p.parent.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(pathlib.Path('apps/api/prisma/migrations').glob('*/migration.sql'))]
assert observed==expected and len(observed)==452
print('EXACT_452_IMAGE_MIGRATION_HASHES_PASS')
assert expected[-2]=={'name':'20281006010000_mail_threads_owned_connection_covering','sha256':'de0d73ca70787ceeb1d133aa539f2d291e6589bebb386210c7d4f3c8a7477915'}
assert expected[-1]=={'name':'20281007010000_mail_messages_owned_connection_active','sha256':'ef10ab58b4eef6825652690a098ab160a374fb30c4cc0af9f15793edb7237242'}
print('MAIL_ACTIVE_OWNER_INDEX_MIGRATION_PACKAGE_PASS')
PY
docker run --rm -i --network none --entrypoint node "$image" - <<'C2MEMORY'
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {MemoryStoreService} = require('./dist/memory/memory-store.service.js');
const {defaultMemoryGovernanceFields} = require('./dist/memory/memory.types.js');
const {readOwnPendingMemoryProposals} = require('./dist/meri/meri-memory-proposal-read.js');
const {MERI_CAPABILITY_REGISTRY} = require('@capiro/shared');
(async () => {
  const tenantId=randomUUID(), userId=randomUUID(), clientId=randomUUID(), candidateId=randomUUID();
  assert.equal(MERI_CAPABILITY_REGISTRY.find(t=>t.name==='list_memory_proposals').readOnly,true);
  const ctx={tenantId,userId,role:'standard_user'};
  const pending=await readOwnPendingMemoryProposals(ctx,{clientId},{listOwnProposals:async (actor,filter)=>{
    assert.deepEqual(actor,ctx); assert.deepEqual(filter,{clientId,limit:5,status:'pending'});
    return {enabled:true,nextCursor:null,candidates:[{id:candidateId,status:'pending',scope:'client',clientId,
      sourceKind:'model_extraction',createdAt:'2026-09-26T16:00:00Z',restricted:false,
      proposal:{key:'Synthetic preference',value:'prefers SMS alerts'}}]};
  }});
  assert.equal(pending.claimsAreApprovedFacts,false); assert.equal(pending.candidates[0].approvedFact,false);
  assert.equal(pending.candidates[0].proposedText,'prefers SMS alerts');
  assert.equal(pending.candidates[0].memoryItemId,undefined);
  const item={...defaultMemoryGovernanceFields(),id:'',tenantId,clientId,ownerUserId:null,type:'note',visibility:'tenant',
    entityId:null,slug:'clio:'+randomUUID(),title:'Synthetic',aliases:[],tags:[],source:'manual',sourceRef:candidateId,
    provenance:'human',sections:[],schemaVersion:1,memoryClass:'client_steering',memoryAuthority:'analyst_verified',
    memoryScope:'client',governedStatus:'active',sourceVersion:'candidate:'+candidateId,assertedByUserId:userId,
    approvedByUserId:randomUUID(),approvedAt:'2026-09-26T16:00:00Z'};
  let existingId, restores=0;
  const tx={$queryRaw:async (sql,...values)=>[{id:existingId??values[0]}],$executeRaw:async (sql,...values)=>{
    if(sql.join('?').includes('UPDATE memory_items')){restores++;const index=sql.findIndex(s=>s.includes('retention_policy_jsonb ='));
      assert.equal(values[index],null);}
    return 1;
  }};
  const store=new MemoryStoreService({withSystem:fn=>fn(tx)},{});
  existingId=await store.upsertSystem(item); assert.equal(restores,1);
  assert.equal(await store.upsertSystem(item),existingId); assert.equal(restores,1);
  console.log('OFFLINE_PACKAGED_C2_MEMORY_PASS');
})().catch(error=>{console.error(error);process.exitCode=1;});
C2MEMORY
docker run --rm -i --network none --entrypoint node "$image" --input-type=module - <<'C2RECONCILIATION'
import assert from 'node:assert/strict';
import {reconcileCase01MemoryCorpusInTx} from '/app/evals/meri/live-v1/fixture-provisioning/case01-memory-owner.mjs';
import {reconcileCase01MetadataInTx} from '/app/evals/meri/live-v1/fixture-provisioning/case01-memory-reconciliation.mjs';
import {reconcileSyntheticMemoryCorpus,readSyntheticReadOperatorInput} from '/app/apps/api/scripts/meri-synthetic-read-budget.mjs';
for (const fn of [reconcileCase01MemoryCorpusInTx,reconcileCase01MetadataInTx,reconcileSyntheticMemoryCorpus]) assert.equal(typeof fn,'function');
process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE='meri-foundation-20260928';
process.env.DATABASE_URL='postgresql://invalid/NO_CONNECTION';
const base={target:'capiro-dev',fixtureNamespace:'meri-foundation-20260928',ctx:{role:'standard_user'},clientId:'11111111-1111-4111-8111-111111111111'};
for (const [command,confirmation] of [['preview-corpus-metadata','PREVIEW_EXACT_OWNED_MEMORY_METADATA'],['execute-corpus-metadata','RECONCILE_EXACT_OWNED_MEMORY_METADATA']]) {
  const input={...base,confirmation,...(command.startsWith('execute')?{expectedPlanSha256:'a'.repeat(64)}:{})};
  const args=[command,'--input-env','MERI_SYNTHETIC_READ_BUDGET_INPUT','--out','/tmp/not-written.json'];
  process.env.MERI_SYNTHETIC_READ_BUDGET_INPUT=JSON.stringify(input);
  assert.deepEqual((await readSyntheticReadOperatorInput(args)).input,input);
  process.env.MERI_SYNTHETIC_READ_BUDGET_INPUT=JSON.stringify({...input,fixtureReady:true});
  await assert.rejects(readSyntheticReadOperatorInput(args),/corpus_scope/);
}
console.log('OFFLINE_PACKAGED_C2_RECONCILIATION_PASS');
C2RECONCILIATION
docker run --rm -i --network none --entrypoint node "$image" --input-type=module - <<'C2TERMINAL'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {cleanupCase01MemoryProjectionsInTx} from '/app/evals/meri/live-v1/fixture-provisioning/case01-memory-owner.mjs';
import {cleanupCase01ProjectionsInTx} from '/app/evals/meri/live-v1/fixture-provisioning/case01-memory-projection-cleanup.mjs';
import {cleanupSyntheticMemoryProjections,readSyntheticReadOperatorInput} from '/app/apps/api/scripts/meri-synthetic-read-budget.mjs';
const require=createRequire(import.meta.url);
const {embedMemoryItem,memoryEmbeddingEligibilitySql}=require('./dist/memory/memory-embedding-lifecycle.js');
const {completeExactOwnedTerminalCleanupInTx,deleteTerminalMemoryProjectionsInTx}=require('./dist/memory/memory-terminal-cleanup.helpers.js');
for (const fn of [cleanupCase01MemoryProjectionsInTx,cleanupCase01ProjectionsInTx,cleanupSyntheticMemoryProjections,embedMemoryItem,completeExactOwnedTerminalCleanupInTx,deleteTerminalMemoryProjectionsInTx]) assert.equal(typeof fn,'function');
assert.match(memoryEmbeddingEligibilitySql(),/clock_timestamp/);
let preflights=0;
assert.equal(await embedMemoryItem({withSystem:async fn=>fn({$queryRawUnsafe:async()=>{preflights++;return [];}})},
  {tenantId:'11111111-1111-4111-8111-111111111111',sourceId:'22222222-2222-4222-8222-222222222222',text:'Synthetic',bypassRls:true,sourceContent:{title:'Synthetic',sections:[]}},
  {embed:async()=>{throw new Error('Ineligible source must not call provider');},dimensions:2,model:'local'}),'skipped');
assert.equal(preflights,1);
process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE='meri-foundation-20260928';
process.env.DATABASE_URL='postgresql://invalid/NO_CONNECTION';
const base={target:'capiro-dev',fixtureNamespace:'meri-foundation-20260928',ctx:{role:'standard_user'},clientId:'11111111-1111-4111-8111-111111111111'};
for(const [command,confirmation] of [['preview-corpus-projections','PREVIEW_EXACT_OWNED_MEMORY_PROJECTIONS'],['execute-corpus-projections','CLEAN_EXACT_OWNED_MEMORY_PROJECTIONS']]){
  const input={...base,confirmation,...(command.startsWith('execute')?{expectedPlanSha256:'a'.repeat(64)}:{})};
  const args=[command,'--input-env','MERI_SYNTHETIC_READ_BUDGET_INPUT','--out','/tmp/not-written.json'];
  process.env.MERI_SYNTHETIC_READ_BUDGET_INPUT=JSON.stringify(input);
  assert.deepEqual((await readSyntheticReadOperatorInput(args)).input,input);
  process.env.MERI_SYNTHETIC_READ_BUDGET_INPUT=JSON.stringify({...input,ids:['caller-selected']});
  await assert.rejects(readSyntheticReadOperatorInput(args),/corpus_scope/);
}
assert.ok(readFileSync('./scripts/entrypoint-dispatcher.inc','utf8').includes('refresh-memory-graph) shift; exec ./node_modules/.bin/tsx scripts/refresh-memory-graph.ts'));
console.log('OFFLINE_PACKAGED_C2_TERMINAL_LIFECYCLE_PASS');
C2TERMINAL
docker run --rm --network none --entrypoint ./node_modules/.bin/tsx "$image" -e \
  "import {embedMemoryItem} from './src/memory/memory-embedding-lifecycle.ts'; import {MemoryIngestService} from './src/memory/memory-ingest.service.ts'; if(typeof embedMemoryItem!=='function'||typeof MemoryIngestService!=='function')throw new Error('SOURCE_IMPORT'); console.log('OFFLINE_PACKAGED_C2_TS_SOURCE_IMPORT_PASS');"
docker run --rm -i --network none --entrypoint node "$image" - <<'C2CLOCKAPI'
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
  assert.equal(core.meriCaptureReceiptBlockers({...finalized.receipt,providerBudget:{...budget,maxCostMicros:15000001}}).includes('provider_budget_malformed'),false);
  assert.equal(core.meriCaptureReceiptBlockers({...finalized.receipt,providerBudget:{...budget,maxCostMicros:15000000,chargedCostMicros:15000001}}).includes('provider_budget_malformed'),false);
  assert.equal(core.meriCaptureReceiptBlockers({...finalized.receipt,providerBudget:{...budget,maxCostMicros:0}}).includes('provider_budget_malformed'),true);
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
C2CLOCKAPI
docker run --rm -i --network none --entrypoint node "$image" - <<'C2WIREAPI'
const assert = require('node:assert/strict');
const {TitanEmbeddingProvider} = require('./dist/embeddings/titan-embedding.provider.js');
const {NvidiaRerankingProvider} = require('./dist/reranking/nvidia-reranking.provider.js');
const {withCaptureApiProviderScope,captureApiProviderScopeActive} = require('./dist/meri/meri-capture-api-provider-scope.js');
(async()=>{
  let transportCalls=0,databaseCalls=0;
  const prisma={withTenantUser:async()=>{databaseCalls++;throw new Error('No database in packaged guard probe');}};
  const policy={expectedCaptureWrites:['context_packet_and_evidence','conversation_user_message','conversation_assistant_message','provider_budget_ledger']};
  const ctx={tenantId:'11111111-1111-4111-8111-111111111111',userId:'22222222-2222-4222-8222-222222222222',role:'standard_user'};
  const capture=fn=>withCaptureApiProviderScope(prisma,ctx,policy,fn);
  const titan=new TitanEmbeddingProvider({region:'eu-west-1',dimensions:2,invoker:async()=>{
    transportCalls++;return {body:Buffer.from(JSON.stringify({embedding:[1,0],inputTextTokenCount:2}))};
  }});
  assert.equal(captureApiProviderScopeActive(),false);
  await capture(async()=>{
    assert.equal(captureApiProviderScopeActive(),true);
    await assert.rejects(titan.embed('synthetic'),/meri_capture_provider_wire_unqualified_bedrock_region/);
  });
  assert.equal(transportCalls,0);assert.equal(databaseCalls,0);
  const reranker=new NvidiaRerankingProvider({endpointUrl:'https://offline.invalid/v1/ranking',model:'synthetic/unit',fetchImpl:async(url)=>{
    transportCalls++;assert.equal(url,'https://offline.invalid/v1/ranking');
    return new Response(JSON.stringify({rankings:[{index:0,logit:1}],usage:{prompt_tokens:1,total_tokens:1}}),{status:200});
  }});
  await assert.rejects(capture(()=>reranker.rerank({query:'synthetic',passages:['synthetic']})),/meri_capture_provider_wire_unqualified_nvidia_endpoint/);
  assert.equal(transportCalls,0);assert.equal(databaseCalls,0);
  assert.equal(captureApiProviderScopeActive(),false);
  assert.deepEqual(await titan.embed('synthetic'),[1,0]);
  await reranker.rerank({query:'synthetic',passages:['synthetic']});
  assert.equal(transportCalls,2);assert.equal(databaseCalls,0);
  console.log('OFFLINE_PACKAGED_CAPTURE_PROVIDER_API_GUARDS_PASS');
  console.log('Actual packaged scope and adapter guards with local transport stubs; no database, provider pricing or live capture qualification.');
})().catch(error=>{console.error(error);process.exitCode=1;});
C2WIREAPI


# Candidate image only; synthetic collaborators, no database/provider transport.
docker run --rm -i --network none --entrypoint node "$image" - <<'C2RECORDEDSOURCE'
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { GovernedMemoryCandidateService } = require('./dist/memory/governed-memory-candidate.service.js');
const { runWithMemoryGovernanceTenant } = require('./dist/memory/memory-governance-tenant-scope.js');
(async () => {
  for (const name of ['MEMORY_GOVERNANCE_LIFECYCLE', 'MEMORY_GOVERNANCE_ENFORCE', 'MEMORY_CLIENT_REVIEW']) process.env[name] = 'enforce';
  const tenantId = randomUUID(), userId = randomUUID(), clientId = randomUUID();
  // Configure only the isolated probe process. Production flags/source are unchanged.
  process.env.MEMORY_GOVERNANCE_TENANTS = tenantId;
  const ctx = { tenantId, userId, role: 'standard_user' };
  const ids = Array.from({ length: 6 }, () => randomUUID());
  let allowed = true, payloadReads = 0, badSource = false, tenantTransactions = 0;
  const tx = {
    memoryCandidate: {
      findMany: async args => {
        assert.equal(args.where.tenantId, tenantId); assert.equal(args.where.proposedBy, userId);
        return ids.map(id => ({ id, clientId, proposedBy: userId, sourceKind: 'model_extraction',
          scope: 'client', status: 'pending', createdAt: new Date('2026-09-26T16:00:00Z'), decidedAt: null }));
      },
      findFirst: async args => {
        payloadReads++;
        assert.equal(args.where.tenantId, tenantId); assert.equal(args.where.proposedBy, userId);
        assert.ok(ids.includes(args.where.id));
        assert.deepEqual(args.select, { payload: true, sourceType: true, sourceId: true });
        return { payload: { key: 'Synthetic', value: 'Synthetic proposal', sourceRef: 'https://private.invalid', sourceExcerpt: 'private excerpt' },
          sourceType: badSource ? 'unknown' : 'meri_synthetic_fixture', sourceId: String(ids.indexOf(args.where.id) + 1).repeat(64) };
      },
    },
    $queryRawUnsafe: async () => allowed ? [{ allowed: true }] : [],
    client: { findMany: async () => [{ id: clientId, name: 'Synthetic client' }] },
  };
  const service = Object.create(GovernedMemoryCandidateService.prototype);
  service.governedPrisma = { withTenantUser: async (tenant, actor, fn) => {
    tenantTransactions++;
    assert.equal(tenant, tenantId); assert.equal(actor, userId); return fn(tx);
  } };

  // Native gates stay fail-closed with no canonical request tenant scope.
  assert.deepEqual(await service.listOwnProposals(ctx, { limit: 50 }), { enabled: false, candidates: [], nextCursor: null });
  assert.equal(tenantTransactions, 0);
  assert.equal(payloadReads, 0);

  // An explicitly configured cohort does not authorize a different scoped tenant.
  const offCohortTenantId = randomUUID();
  assert.deepEqual(await runWithMemoryGovernanceTenant(offCohortTenantId,
    () => service.listOwnProposals(ctx, { limit: 50 })), { enabled: false, candidates: [], nextCursor: null });
  assert.equal(tenantTransactions, 0);
  assert.equal(payloadReads, 0);

  // Eligible success uses the API's canonical AsyncLocalStorage tenant scope.
  const page = await runWithMemoryGovernanceTenant(tenantId,
    () => service.listOwnProposals(ctx, { limit: 50 }));
  assert.equal(page.enabled, true); assert.equal(page.candidates.length, 6);
  assert.equal(new Set(page.candidates.map(c => c.recordedSource.sourceId)).size, 6);
  assert.ok(page.candidates.every(c => c.recordedSource.sourceType === 'meri_synthetic_fixture'));
  assert.equal(JSON.stringify(page).includes('private.invalid'), false);
  assert.equal(JSON.stringify(page).includes('private excerpt'), false);

  // The ethical wall denies payload/source access while preserving redacted status.
  allowed = false; const before = payloadReads;
  const restricted = await runWithMemoryGovernanceTenant(tenantId,
    () => service.listOwnProposals(ctx, { limit: 50 }));
  assert.equal(payloadReads, before);
  assert.ok(restricted.candidates.every(c => c.restricted && !c.recordedSource && c.proposal === null && c.clientName === null));

  // Unknown source kinds never produce recorded-source metadata.
  allowed = true; badSource = true;
  const unknownSource = await runWithMemoryGovernanceTenant(tenantId,
    () => service.listOwnProposals(ctx, { limit: 50 }));
  assert.ok(unknownSource.candidates.every(c => !c.recordedSource));
  console.log('OFFLINE_PACKAGED_C2_RECORDED_SOURCE_PRIVACY_PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
C2RECORDEDSOURCE

# Exact packaged controller success status; guards and exceptions remain ordinary Nest behavior.
docker run --rm -i --network none --entrypoint node "$image" - <<'C2TOOLHTTP'
require('reflect-metadata');
const assert=require('node:assert/strict');
const {MeriController}=require('./dist/meri/meri.controller.js');
const {HTTP_CODE_METADATA,GUARDS_METADATA}=require('@nestjs/common/constants');
assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA,MeriController.prototype.executeTool),200);
const guards=Reflect.getMetadata(GUARDS_METADATA,MeriController.prototype.executeTool);
assert.ok(Array.isArray(guards)&&guards.some(g=>g.name==='ToolServiceSecretGuard'));
console.log('OFFLINE_PACKAGED_C2_TOOL_HTTP_SUCCESS_PASS');
C2TOOLHTTP

# Verify the actual compiled API projection/signing/request-control seam.
docker run --rm -i --network none --entrypoint node "$image" - <<'C2MEMORYSOURCE'
// Synthetic compiled API seam only; run in the final image with --network none.
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const core = require('@capiro/meriv2-core');
const { MeriToolsService } = require('./dist/meri/meri-tools.service.js');
const { withMeriToolRequestControl } = require('./dist/meri/meri-tool-request-control.js');
const sha = value => createHash('sha256').update(value).digest('hex');
const secret = 'offline-c2-memory-source-proof-secret';
process.env.INTERNAL_SERVICE_SECRET = secret;
const tenantId = randomUUID(), userId = randomUUID(), clientId = randomUUID(), memoryItemId = randomUUID();
const ctx = {tenantId,userId};
const text = 'Approved Aster offline source.', sourceVersion = 'candidate:'+randomUUID();
const record = {domain:'institutional_knowledge',recordId:memoryItemId,
  provenance:{source:'memory_items',recordId:memoryItemId,canonicalTenantId:tenantId,sourceVersion},
  payload:{clientId,sourceKind:'governed_memory',memoryItemId,value:text,contentStatus:'available',title:'Approved source'}};
const source = {domain:'institutional_knowledge',sourceStatus:'healthy',hasMore:false,truncated:false,paginationComplete:true,coverageComplete:true,nextCursor:null};
const tool = Object.create(MeriToolsService.prototype);
tool.contextPlane = {searchToolData:async()=>({records:[record],coverage:{complete:true,paginationComplete:true,sources:[source]}})};
const input = {query:'approved source',clientId,memoryItemId};
function request(header) {
  const req = new EventEmitter();req.params={name:'search_memory'};req.body=input;
  req.headers=header?{[core.MERI_MEMORY_CAPTURE_REQUEST_HEADER]:header}:{};
  req.res=new EventEmitter();req.res.writableEnded=true;return req;
}
(async()=>{
  for(const caseId of ['01','14']) {
    const issuedAt=Date.now(),captureRunId=randomUUID();
    const policy={caseId,captureRunId,tenantId,actorUserId:userId,clientId,policyId:randomUUID(),requestId:randomUUID(),traceId:randomUUID(),turnId:randomUUID(),conversationId:randomUUID(),issuedAt,expiresAt:issuedAt+60000,physicalMapSha256:'a'.repeat(64),fixtureVersion:'meri-live-v1-2026-09-26.1',
      semanticClock:{version:1,kind:'qualified_original_fixture_semantic_clock',instant:'2026-09-26T16:00:00.000Z',timeZone:'America/New_York',caseId,captureRunId,currentVerifySha256:'b'.repeat(64),observedAt:issuedAt}};
    const binding={callId:'offline-'+caseId,nonce:randomUUID(),inputSha256:sha(JSON.stringify(input))};
    const header=core.encodeMeriMemoryCaptureRequest(policy,binding,secret);
    const result=await withMeriToolRequestControl(request(header),()=>tool.searchMemory(ctx,input),policy);
    const verified=core.verifyMeriMemoryCaptureSources(policy,result.records,result.memoryCaptureSources,secret,binding);
    assert.equal(verified.length,1);assert.equal(verified[0].tenantId,tenantId);assert.equal(verified[0].clientId,clientId);
    assert.equal(verified[0].fullRead,true);assert.equal(verified[0].passageSha256,sha(text));
    assert.throws(()=>core.verifyMeriMemoryCaptureSources(policy,result.records,result.memoryCaptureSources,secret,{...binding,nonce:randomUUID()}));
    assert.throws(()=>core.decodeMeriMemoryCaptureRequest(policy,header,{...input,query:'changed'},secret));
    const actualOwner=record.provenance.canonicalTenantId;record.provenance.canonicalTenantId=randomUUID();
    await assert.rejects(()=>withMeriToolRequestControl(request(header),()=>tool.searchMemory(ctx,input),policy));
    record.provenance.canonicalTenantId=actualOwner;
  }
  const ordinary=await tool.searchMemory(ctx,input);
  assert.equal(Object.hasOwn(ordinary,'memoryCaptureSources'),false);
  assert.equal(Object.hasOwn(ordinary.records[0].provenance,'canonicalTenantId'),false);
  console.log('OFFLINE_PACKAGED_C2_CANONICAL_MEMORY_SOURCE_PASS');
})().catch(error=>{console.error(error);process.exitCode=1;});

C2MEMORYSOURCE

# Case12 uses only packaged source/compiled pure functions. No native setup.
docker run --rm -i --network none --entrypoint node "$image" --input-type=module - <<'C2CASE12PACKAGE' | tee case12-packaged-probe.log
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {pathToFileURL, fileURLToPath} from 'node:url';
import path from 'node:path';
// In the built image cwd is /app/apps/api. A local mirror may run this same
// source from its apps/api cwd; no live setup or runtime authority is invoked.
const root=path.resolve(process.cwd(),'../..'),require=createRequire(pathToFileURL(path.join(process.cwd(),'package.json')));
const source=relative=>require(path.join(process.cwd(),'dist',relative+'.js'));
const fixture=relative=>import(pathToFileURL(path.join(root,'evals/meri/live-v1',relative)).href);
let networkAttempts=0;
const deny=()=>{networkAttempts++;throw Error('OFFLINE_CASE12_NETWORK_FORBIDDEN');};
globalThis.fetch=deny;
for(const name of ['node:http','node:https']){const mod=require(name);mod.request=deny;mod.get=deny;}
const net=require('node:net');net.connect=deny;net.createConnection=deny;net.Socket.prototype.connect=deny;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const [module,exports] of Object.entries({
 'meri/meri-case12-setup-budget':['validateCase12SetupBudgetPlan','case12SetupCost'],
 'meri/meri-case12-setup-budget-owner':['createCase12SetupBudgetOwner'],
 'meri/meri-case12-native-setup-admission':['createCase12NativeSetupAdmission'],
 'meri/meri-case12-capture-authority':['assertMeriCase12BindingInTx','readMeriCase12CompletedCorpusInTx'],
 'retrieval/adapters/case12-memory-eligibility.read':['readCase12CanonicalEligibilityInTx'],
 'memory/case12-setup-terminal.read':['inspectCase12SetupTerminalRowInTx'],
 'memory/case12-synthetic-approved-memory-set.read':['assertCase12SyntheticApprovedMemorySetInTx'],
})){const actual=source(module);for(const name of exports)assert.equal(typeof actual[name],'function',module+':'+name);}
const setup=await fixture('fixture-provisioning/case12-memory-setup.mjs');
const planner=await fixture('fixture-provisioning/case12-setup-budget-plan.mjs');
for(const [file,name] of [['case12-memory-current-owner.mjs','createCase12CurrentMemoryOwner'],['case12-memory-eligibility-owner.mjs','createCase12MemoryEligibilityOwner'],['case12-memory-inventory-owner.mjs','createCase12MemoryInventoryOwner']])assert.equal(typeof (await fixture('fixture-provisioning/'+file))[name],'function',name);
assert.equal(typeof setup.createCase12SetupCurrentScopeInspector,'function');
const helper=path.join(process.cwd(),'scripts/meri-case12-setup-native.mjs');assert.ok(readFileSync(helper).length>0);
assert.ok(readFileSync(path.join(process.cwd(),'scripts/entrypoint.sh'),'utf8').includes('exec node scripts/meri-case12-setup-native.mjs'));
console.log('OFFLINE_PACKAGED_CASE12_MODULES_PASS');

const assetsPath=path.join(root,'evals/meri/live-v1/source-binaries'),assetBytes=readFileSync(path.join(assetsPath,'asset-manifest.json')),assets=JSON.parse(assetBytes);
assert.equal(assets.assets.length,7);
assert.deepEqual(readdirSync(assetsPath).filter(name=>/\.(pdf|pptx|xlsx)$/u.test(name)).sort(),assets.assets.map(asset=>asset.filename).sort());
for(const asset of assets.assets){assert.match(asset.filename,/^[A-Za-z0-9_-]+\.(pdf|pptx|xlsx)$/);const bytes=readFileSync(path.join(assetsPath,asset.filename));assert.equal(bytes.length,asset.byteSize);assert.equal(sha(bytes),asset.byteSha256);}
console.log('CASE12_PACKAGED_ASSET_MANIFEST_SHA256='+sha(assetBytes));
console.log('OFFLINE_PACKAGED_CASE12_ASSET_MANIFEST_PASS');

process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE='meri-foundation-20260928';
const proposer='44444444-4444-4444-8444-444444444444',reviewer='66666666-6666-4666-8666-666666666666';
const recipe={schemaVersion:1,target:'capiro-dev',caseId:'12',fixtureNamespace:process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE,fixtureInstanceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ctx:{tenantId:'f2d6cf8f-057c-479a-8110-62fe5086d43f',tenantSlug:'meri-foundation-20260928-t1',userId:proposer,role:'standard_user'},clerkUserId:'user_offline_pat',reviewerUserId:reviewer,actors:{PAT:{tenantId:'T1',physicalId:proposer},PRIYA:{tenantId:'T1',physicalId:reviewer}},clients:{ASTER:{tenantId:'T1',physicalId:'11111111-1111-4111-8111-111111111111'},BLUEHAVEN:{tenantId:'T1',physicalId:'22222222-2222-4222-8222-222222222222'},CEDAR:{tenantId:'T2',physicalId:'33333333-3333-4333-8333-333333333333'}}};
const spec=await setup.resolveCase12SetupRecipe(recipe),budget=source('meri/meri-case12-setup-budget'),{canonicalProjectionSnapshot}=source('memory/strict-memory-projector.service');
assert.equal(spec.definitions.length,510);assert.equal(spec.definitions[0].logicalId,'MA510');assert.equal(spec.definitions[0].candidate.payload.facts.text,'autonomous maritime demo');assert.equal(spec.definitions[509].logicalId,'MA510-DISTRACTOR-0509');
// Deliberately synthetic plan for arithmetic/package qualification. It is never
// passed to inspect/execute/current owner/admission; no native readiness asserted.
const body={kind:'meri-case12-memory-setup-plan',schemaVersion:1,recipeSha256:budget.case12SetupHash(spec.input),manifestContentSha256:spec.manifest.contentSha256,orderedDefinitionSha256:budget.case12SetupHash(spec.definitions.map(d=>d.candidate)),exactCanonicalDefinitionCount:510,firstLogicalId:'MA510',tenantId:recipe.ctx.tenantId,tenantRowVersion:'0',priorSettingsSha256:'a'.repeat(64),fixtureNamespace:recipe.fixtureNamespace,fixtureInstanceId:recipe.fixtureInstanceId,actorScope:{proposerUserId:proposer,proposerRole:'standard_user',clerkUserId:recipe.clerkUserId,reviewerUserId:reviewer,reviewerRole:'user_admin',clientId:recipe.clients.ASTER.physicalId},fixtureReady:false,captureAuthority:false,liveAcceptance:'NOT_RUN'};
const setupPlan={...body,planSha256:budget.case12SetupHash(body)};
const envelope={runId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',aggregateReservationId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',sourceSha256:'d'.repeat(64),imageSha256:'e'.repeat(64),aggregateCheckpointSha256:'f'.repeat(64),rateEvidenceSha256:'1'.repeat(64),rates:{openai_embeddings:{inputPerM:0.02,outputPerM:0},bedrock_embeddings:{inputPerM:0.01,outputPerM:0}},admittedAt:'2026-10-04T00:00:00.000Z',deadlineAt:'2026-10-04T00:15:00.000Z',ratesExpiresAt:'2026-10-04T01:00:00.000Z'};
const planned=await planner.buildCase12SetupProviderPlan({recipe,setupPlan,envelope},{...budget,canonicalProjectionSnapshot});
assert.equal(typeof planner.deriveCase12SetupProviderRows,'function');
const derived=await planner.deriveCase12SetupProviderRows({recipe,setupPlan},{canonicalProjectionSnapshot});
assert.deepEqual(Object.keys(derived).sort(),['version','caseId','fixtureNamespace','fixtureInstanceId','tenantId','proposerUserId','reviewerUserId','clientId','setupPlanSha256','recipeSha256','orderedDefinitionSha256','rows'].sort());
for(const [key,value] of Object.entries(derived))assert.deepEqual(value,planned[key],key);
assert.equal(planned.rows.length,510);assert.equal(new Set(planned.rows.map(r=>r.candidateId)).size,510);assert.equal(planned.maxCostMicros,510*(budget.case12SetupCost(0.02,8192)+budget.case12SetupCost(0.01,8192)));
const {expectedMemoryCandidatePayload}=await fixture('fixture-provisioning/memory-candidate-owner.mjs'),{stableJson}=await fixture('lib/stable.mjs');
for(const [index,row] of planned.rows.entries()){
 const candidate=spec.definitions[index].candidate,payload=expectedMemoryCandidatePayload(candidate,proposer,stableJson({ownership:candidate.ownership,payload:candidate.payload}));
 const projection=canonicalProjectionSnapshot({id:candidate.physicalId,clientId:payload.clientId,ownerUserId:null,title:payload.key,sections:[{key:'memory',heading:'Memory',owner:'human',body:payload.value}]});
 const wires={openai_embeddings:JSON.stringify({model:'text-embedding-3-small',input:payload.key+': '+payload.value}),bedrock_embeddings:JSON.stringify({inputText:projection.text,dimensions:1024,normalize:true})};
 for(const [kind,wire] of Object.entries(wires)){assert.equal(row.requests[kind].bodySha256,sha(wire));assert.equal(row.requests[kind].inputBytes,Buffer.byteLength(wire));}
}
const changed=structuredClone(setupPlan);changed.orderedDefinitionSha256='0'.repeat(64);await assert.rejects(planner.buildCase12SetupProviderPlan({recipe,setupPlan:changed,envelope},{...budget,canonicalProjectionSnapshot}));
await assert.rejects(setup.resolveCase12SetupRecipe({...recipe,sourceText:'forbidden'}));
console.log('OFFLINE_PACKAGED_CASE12_RECIPE_510_BODY_PLANNER_PASS');
console.log('OFFLINE_PACKAGED_CASE12_PREHOLD_510_DERIVATION_PASS');

const core=require('@capiro/meriv2-core'),binding={setupRunId:envelope.runId,fixtureInstanceId:recipe.fixtureInstanceId,setupPlanSha256:setupPlan.planSha256,setupClaimSha256:'2'.repeat(64),setupLedgerSha256:'3'.repeat(64)};
assert.deepEqual(core.readMeriCase12SetupBinding(binding),binding);
const policy={caseId:'12',captureRunId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',resetReceiptId:null,seedReceiptId:null,case12Setup:binding};core.validateMeriCase12SetupPolicyBinding(policy);
for(const mutation of [{case12Setup:undefined},{resetReceiptId:'invented'},{seedReceiptId:'invented'},{captureRunId:binding.setupRunId},{caseId:'14'}])assert.throws(()=>core.validateMeriCase12SetupPolicyBinding({...policy,...mutation}));
for(const value of [{...binding,ready:true},{...binding,setupRunId:[binding.setupRunId]},{...binding,setupLedgerSha256:'wrong'}])assert.throws(()=>core.readMeriCase12SetupBinding(value));
console.log('OFFLINE_PACKAGED_CASE12_CORE_SETUP_BINDING_PASS');

// Each child reaches the actual packaged helper and fails before its factory is
// created. External network attempts are poisoned in addition to --network none.
const bootstrap=`import {createRequire,registerHooks} from 'node:module';const require=createRequire(import.meta.url);let factoryImports=0;registerHooks({resolve(specifier,context,nextResolve){if(specifier.endsWith('meri-case01-setup-dependencies.mjs')){factoryImports++;process.stderr.write('OFFLINE_CASE12_FACTORY_IMPORT_ATTEMPT\\n');throw Error('FACTORY_MUST_NOT_LOAD');}return nextResolve(specifier,context);}});const deny=()=>{process.stderr.write('OFFLINE_CASE12_NETWORK_ATTEMPT\\n');throw Error('OFFLINE_CASE12_NETWORK_FORBIDDEN');};globalThis.fetch=deny;for(const name of ['node:http','node:https']){const mod=require(name);mod.request=deny;mod.get=deny;}const net=require('node:net');net.connect=deny;net.createConnection=deny;net.Socket.prototype.connect=deny;process.argv=[process.execPath,${JSON.stringify(helper)},'execute'];await import(${JSON.stringify(pathToFileURL(helper).href)});process.stdout.write('OFFLINE_CASE12_FACTORY_IMPORT_ATTEMPTS='+factoryImports+'\\n');`;
for(const raw of ['{}','x'.repeat(7001),JSON.stringify({kind:'meri-case12-native-setup-input',version:1,recipe:{},providerEnvelope:{},native:{}}),JSON.stringify({kind:'meri-case12-native-setup-input',version:1,recipe,providerEnvelope:envelope,native:{},setupPlan})]){
 const child=spawnSync(process.execPath,['--input-type=module','-e',bootstrap],{encoding:'utf8',timeout:15000,maxBuffer:256*1024,env:{PATH:process.env.PATH,MERI_SYNTHETIC_FIXTURE_NAMESPACE:recipe.fixtureNamespace,MERI_CASE12_NATIVE_SETUP_INPUT:raw,NODE_ENV:'test'}});
 assert.equal(child.error,undefined);assert.equal(child.status,1);assert.equal(child.stdout,'OFFLINE_CASE12_FACTORY_IMPORT_ATTEMPTS=0\n');assert.ok(child.stderr.includes('CASE12_NATIVE_SETUP_FAILED_RECONCILIATION_REQUIRED'));assert.ok(!child.stderr.includes('OFFLINE_CASE12_NETWORK_ATTEMPT'));assert.ok(!child.stderr.includes('OFFLINE_CASE12_FACTORY_IMPORT_ATTEMPT'));
}
assert.equal(networkAttempts,0);
console.log('OFFLINE_PACKAGED_CASE12_NEGATIVE_HELPER_INGRESS_PASS');

C2CASE12PACKAGE
python3 - <<'CASE12ASSETMATCH'
import hashlib,pathlib
expected=hashlib.sha256(pathlib.Path('evals/meri/live-v1/source-binaries/asset-manifest.json').read_bytes()).hexdigest()
lines=pathlib.Path('case12-packaged-probe.log').read_text().splitlines()
assert lines.count('CASE12_PACKAGED_ASSET_MANIFEST_SHA256='+expected)==1
print('CASE12_IMAGE_ASSET_MANIFEST_MATCH_SOURCE_PASS')
CASE12ASSETMATCH

# Native admission must accept only the observed harmless ECS default.
docker run --rm -i --network none --entrypoint node "$image" - <<'CASE12_ECS_DEFAULT'
const assert=require('node:assert/strict');
const {assertCase12NativeTaskOverrides:check}=require('./dist/meri/meri-case12-native-setup-admission.js');
assert.equal(typeof check,'function');
const expected={containerOverrides:[{name:'api',environment:[{name:'MERI_CASE12_NATIVE_SETUP_INPUT',value:'offline-fixed-input'}]}]};
const actual={...structuredClone(expected),inferenceAcceleratorOverrides:[]};
const before=JSON.stringify(actual);
check(actual,expected);check(expected,expected);assert.equal(JSON.stringify(actual),before);
for(const value of [null,{},'',0,false,[{}],[{deviceName:'unauthorized',deviceType:'eia1.medium'}]])assert.throws(()=>check({...structuredClone(expected),inferenceAcceleratorOverrides:value},expected));
for(const key of ['taskRoleArn','executionRoleArn','cpu','memory','ephemeralStorage','unexpected'])assert.throws(()=>check({...structuredClone(actual),[key]:'unauthorized'},expected));
for(const mutation of [o=>o.containerOverrides[0].command=['node'],o=>o.containerOverrides[0].cpu=1,o=>o.containerOverrides[0].environment.push({name:'UNEXPECTED',value:'x'}),o=>o.containerOverrides[0].environment[0].value='wrong',o=>o.containerOverrides.push({name:'extra'})]){const bad=structuredClone(actual);mutation(bad);assert.throws(()=>check(bad,expected));}
console.log('OFFLINE_PACKAGED_CASE12_ACTUAL_ECS_DEFAULT_PARITY_PASS');
CASE12_ECS_DEFAULT

docker run --rm -i --network none --entrypoint node "$image" - <<'APPROVAL_RECALL'
const assert=require('node:assert/strict');
const {planMeriTurn}=require('./dist/meri/meri-context-plane.service.js');
const base={uiClientId:'33333333-3333-4333-8333-333333333333',uiClientName:'Aster Defense',authorizedClientNames:['Aster Defense','Bluehaven Robotics']};
for(const task of ['What did we approve about Aster’s autonomous maritime demo?',"What have we approved about Aster Defense's maritime demo?",'What was approved about Aster’s maritime demo?']){
 const p=planMeriTurn({...base,task});assert.equal(p.subjectScope,'client');assert.equal(p.targetHint,null);assert.equal(p.queryClass,'semantic_recall');assert.deepEqual(p.requestedDomains,['institutional_knowledge']);assert.equal(p.query,task);assert.equal(p.requireComplete,true);
}
for(const input of [
 {...base,task:'What did we approve about Bluehaven’s autonomous maritime demo?'},
 {...base,task:'What did we approve about Aster’s autonomous maritime demo?',authorizedClientNames:['Aster Defense','Aster Maritime']},
 {...base,task:'What did we approve about Aster’s autonomous maritime demo and Bluehaven’s demo?'},
 {...base,task:'Approve Aster’s autonomous maritime demo.'},
 {...base,task:'What did we approve about Aster’s autonomous maritime demo in the email?'},
 {...base,task:'Show me the document for Aster’s autonomous maritime demo.'},
])assert.notDeepEqual(planMeriTurn(input).requestedDomains,['institutional_knowledge']);
console.log('OFFLINE_PACKAGED_RETROSPECTIVE_APPROVAL_PLANNER_PASS');
APPROVAL_RECALL

docker run --rm -i --network none --entrypoint node "$image" <<'SOLPOLICY'
const assert = require('node:assert/strict');
const p = require('@capiro/shared/ai-model-policy');
const s = require('@capiro/shared');
assert.equal(p.OPENAI_TEXT_MODEL, 'gpt-6-astra');
assert.equal(p.isGpt6('gpt-6.1-sol'), true);
assert.equal(p.isGpt6('gpt-6.1-sol-2026-10-03'), false);
assert.equal(p.upgradeTextModel('gpt-6.1-sol'), 'gpt-6.1-sol');
const q=p.prepareOpenAiResponsesRequest({model:'gpt-6.1-sol',max_output_tokens:2048,reasoning:{effort:'none'},temperature:0.2,include:['reasoning.encrypted_content','message.output_text.logprobs']});
assert.equal(q.max_output_tokens,2048);assert.equal(q.reasoning.effort,'low');assert.equal(q.temperature,undefined);
assert.deepEqual(q.include,['reasoning.encrypted_content']);
assert.equal(s.computeAiCostUsd('gpt-6.1-sol',1000,1000),0.012);
assert.ok(Math.abs(s.computeAiCostUsd('gpt-6.1-sol',272001,1000)-1.103004)<1e-10);
assert.equal(p.prepareOpenAiResponsesRequest({model:'gpt-6-astra',max_output_tokens:2048}).max_output_tokens,8192);
console.log('OFFLINE_PACKAGED_SOL_POLICY_AND_PRICE_PASS');
SOLPOLICY

docker run --rm -i --network none --entrypoint node "$image" <<'CASE12REMEDIATION'
const assert = require('node:assert/strict');
const owner = require('./dist/meri/meri-case12-capture-remediation.js');
const {currentCaptureAuthorityRows} = require('./dist/meri/meri-server-readonly-capture.js');
const ctx={tenantId:'f2d6cf8f-057c-479a-8110-62fe5086d43f',tenantSlug:'meri-foundation-20260928-t1',
  userId:'b1f758fc-17bd-40f8-bef2-fa2d2380300f',clerkUserId:'user_3Jw2FvWZkYGKmxWGx13tNJxFD2A',role:'standard_user'};
const clientId='41f9ec63-3963-479f-b747-59a3767ef44b', conversationId='22222222-2222-4222-8222-222222222222';
const run='33333333-3333-4333-8333-333333333333',old='40dd8401-dcfe-46bd-b010-c30e7098297c';
process.env.GIT_SHA='a'.repeat(40);
const fixture={fixtureNamespace:'meri-foundation-20260928',captureEvidence:{caseId:'12',captureRunId:run,
  remediationConversationId:conversationId},case12CaptureRemediation:{kind:'meri-case12-one-time-capture-remediation',
  version:1,oldConversationId:old,newConversationId:conversationId,newCaptureRunId:run,actorUserId:ctx.userId,clientId}};
const tx={tenant:{findUnique:async()=>({id:ctx.tenantId,slug:ctx.tenantSlug,settings:{meriFoundationFixture:fixture}})},
  user:{findUnique:async()=>({id:ctx.userId,clerkUserId:ctx.clerkUserId,email:'pat.synthetic@example.com',firstName:'Pat',lastName:'Synthetic'})},
  tenantMembership:{findFirst:async()=>({id:'active'})},clioConversation:{findFirst:async()=>({clientId,metadata:{},
    client:{id:clientId,tenantId:ctx.tenantId,name:'Aster',memoryWall:true,memoryAccessGrants:[{id:'approved'}]}})}};
const prisma={withTenant:async(_,fn)=>fn(tx)};
(async()=>{
  assert.equal(typeof owner.inspectCase12FailedCaptureRemediationInTx,'function');
  assert.equal(typeof owner.installCase12FailedCaptureRemediationInTx,'function');
  let nativeReads=0;
  await assert.rejects(owner.inspectCase12FailedCaptureRemediationInTx({},{$queryRaw:()=>{nativeReads++;throw Error('unexpected');}},
    {ctx,clientId,oldConversationId:old,newConversationId:old,newCaptureRunId:run,
      expectedCurrentVerifySha256:'5ff329511d93d308aac9fc4ff335788040db8740994906c34a9cb76c15042e3d',
      expectedApiSourceSha:process.env.GIT_SHA}),/historical_identity_replayed/);
  assert.equal(nativeReads,0);
  assert.equal((await currentCaptureAuthorityRows(prisma,ctx,conversationId)).captureBinding.captureRunId,run);
  await assert.rejects(currentCaptureAuthorityRows(prisma,ctx,old));
  delete fixture.case12CaptureRemediation;
  await assert.rejects(currentCaptureAuthorityRows(prisma,ctx,conversationId));
  console.log('OFFLINE_CASE12_REMEDIATION_OWNER_AND_CONVERSATION_FENCE_PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});

CASE12REMEDIATION

docker run --rm -i --network none --entrypoint node "$image" <<'CONTEXTBOUND'
const assert=require('node:assert/strict');
const {MeriContextPlaneService}=require('/app/apps/api/dist/meri/meri-context-plane.service.js');
const {ContextPacketRolloutCompiler}=require('/app/packages/meriv2-core/dist/index.js');
(async()=>{
 const rows=Array.from({length:512},(_,i)=>({id:'memory-'+i,type:'client-compass',slug:'memory-'+i,title:'Approved memory '+i,clientId:'client-1',status:'active',sections:[{owner:'human',heading:'Context',body:'Relevant context. '.repeat(100)}]}));
 for(const mode of ['off','shadow']){
  const compiler=new ContextPacketRolloutCompiler({loadSteeringRows:async()=>rows,loadGovernedSteeringRows:async()=>rows,persistPacket:async()=>'packet-id'});
  const stop=Error('offline-stop');let captured;
  const tx={clioConversation:{findFirst:async()=>({clientId:'client-1'})},client:{findFirst:async()=>({name:'Acme'}),findMany:async()=>[{id:'client-1',name:'Acme'}]},integrationConnection:{findMany:async()=>[]}};
  const prisma={withTenant:async(_t,fn)=>fn(tx),withTenantUser:async(_t,_u,fn)=>fn(tx)};
  const service=new MeriContextPlaneService(prisma,{requestContext:async req=>{captured=await compiler.compile({...req.contextRequest,ethicalWallAllowed:true},mode);throw stop;}});
  await assert.rejects(service.resolveChat({tenantId:'tenant',userId:'actor'},{conversationId:'thread',task:'What did we approve about Acme?'}),e=>e===stop);
  assert.ok(captured.rendered.length>0&&captured.rendered.length<512);assert.ok(captured.rendered.reduce((n,x)=>n+x.body.length,0)<=48000);assert.ok(captured.exclusions.some(x=>x.reason==='over-budget'));
 }console.log('OFFLINE_PACKAGED_MERI_COMPATIBILITY_CONTEXT_BOUND_PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});

CONTEXTBOUND

docker run --rm -i --network none --entrypoint node "$image" <<'STEERINGWIRE'
const assert=require('node:assert/strict');
const {MeriContextPlaneService}=require('/app/apps/api/dist/meri/meri-context-plane.service.js');
const {ContextPacketRolloutCompiler}=require('/app/packages/meriv2-core/dist/index.js');
const {extractCitationsFromToolResult,formatCitationsForPrompt}=require('/app/packages/shared/dist/index.js');
(async()=>{
 const rows=Array.from({length:512},(_,i)=>({id:'845d5ac7-4fa1-4ad6-b862-'+String(i).padStart(12,'0'),type:'client-compass',slug:'memory-'+i,title:'Approved memory '+i,clientId:'client-1',status:'active',sections:[{owner:'human',heading:'Context',body:'x'.repeat(70)}]}));
 for(const mode of ['off','shadow']){
  const compiler=new ContextPacketRolloutCompiler({loadSteeringRows:async()=>rows,loadGovernedSteeringRows:async()=>rows,persistPacket:async()=>'packet-id'});
  const tx={clioConversation:{findFirst:async()=>({clientId:'client-1'})},client:{findFirst:async()=>({name:'Acme'}),findMany:async()=>[{id:'client-1',name:'Acme'}]},integrationConnection:{findMany:async()=>[]}};
  const prisma={withTenant:async(_t,fn)=>fn(tx),withTenantUser:async(_t,_u,fn)=>fn(tx)};
  const service=new MeriContextPlaneService(prisma,{requestContext:async req=>({kind:'governed_packet',packet:await compiler.compile({...req.contextRequest,ethicalWallAllowed:true},mode),context:{resolution:{status:'resolved',stopReason:'resolved',subjectScope:{kind:'client',clientIds:['client-1']}},retrieval:{records:[],coverage:{requestedDomains:[],searchedDomains:[],sources:[],recordsEvaluated:0,recordsReturned:0,paginationComplete:true,complete:true}}}})});
  const c=await service.resolveChat({tenantId:'tenant',userId:'actor'},{conversationId:'thread',task:'Export that briefing and give me the file.'});
  const citations=formatCitationsForPrompt(extractCitationsFromToolResult('context_plane',c.evidence,1,999));
  assert.ok(Buffer.byteLength(JSON.stringify({instructions:c.prompt+'\n'+citations}),'utf8')<12000);
  assert.equal(c.evidence.sourceRecordCount,512);assert.ok(c.evidence.projectedRecordCount>0&&c.evidence.projectedRecordCount<512);assert.equal(c.evidence.truncated,true);assert.ok(c.prompt.includes('omitted='));
 }console.log('OFFLINE_PACKAGED_MERI_SERIALIZED_STEERING_BOUND_PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});

STEERINGWIRE

docker run --rm -i --network none --entrypoint node "$image" <<'CASE46RECOVERY'
const assert=require('node:assert/strict');
const {MERI_CASE46:f}=require('/app/packages/meriv2-core/dist/index.js');
const r=require('/app/apps/api/dist/meri/meri-case46-remediation.js');
const {planCase46Setup}=require('/app/apps/api/dist/meri/meri-case46-setup-owner.js');
(async()=>{
 const ctx={tenantId:f.tenantId,userId:f.actorUserId,role:'standard_user'},run='1196830a-83b4-4530-bcd1-87840bf88b41',tx={$queryRaw:async()=>[]};
 const claim={version:1,caseId:'46',status:'COMPLETE',captureRunId:'e9ac5e1a-6562-49b6-b59b-139bd7ba8325'};
 await assert.rejects(r.assertCase46RemediationInTx(tx,ctx,{fixtureNamespace:f.namespace,case46ExecutionSetup:claim},{captureRunId:run,remediationProofSha256:r.CASE46_REMEDIATION_PROOF}),/not_eligible/);
 await assert.rejects(r.assertCase46RemediationInTx(tx,ctx,{fixtureNamespace:f.namespace,case46ExecutionSetup:claim},{captureRunId:run,remediationProofSha256:'a'.repeat(64)}),/not_eligible/);
 assert.equal(r.case46RetiredKey(5),'case46RetiredExecutionSetup5');assert.equal(r.CASE46_REMEDIATION_PROOFS.length,4);
 assert.equal(typeof planCase46Setup,'function');console.log('OFFLINE_PACKAGED_CASE46_RECONCILED_RECOVERY_GATES_PASS');console.log('OFFLINE_PACKAGED_CASE46_GENERIC_RECOVERY_PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});

CASE46RECOVERY

docker run --rm -i --network none --entrypoint node "$image" <<'SETASIDE'
const assert=require('node:assert/strict');
const s=require('/app/apps/api/dist/funding-opportunities/sam-set-aside.js');
assert.equal(s.samSetAsideDescription('SBA'),'Total Small Business Set-Aside (FAR 19.5)');assert.equal(s.samSetAsideDescription('NONE'),null);
console.log('OFFLINE_PACKAGED_SAM_SET_ASIDE_PASS');
SETASIDE

docker run --rm -i --network none --entrypoint node "$image" <<'LEDGERONLY'
const assert=require('node:assert/strict');
const b=require('/app/apps/api/dist/meri/meri-research-tool-budget.js');
const c46=require('/app/apps/api/dist/meri/meri-case46-provider-budget.js');
const cap=require('/app/apps/api/dist/meri/meri-capture-provider-budget.js');
const syn=require('/app/apps/api/dist/meri/meri-synthetic-read-budget.js');
const limits={maxAttempts:1,maxTokens:150,maxCostMicros:100,deadlineAt:new Date(Date.now()+600000).toISOString()};
const run={id:'admission',leaseEpoch:1};
const binding=attemptId=>({logicalOperationId:attemptId,attemptId,retryOfAttemptId:null,kind:'openai_responses',phase:'synthesis',provider:'openai',model:'gpt-6-astra',maxInputTokens:100,maxOutputTokens:100});
const price={inputPerM:1,outputPerM:2};
const ledger=b.admitResearchProviderBudget({},limits,'ledger_only');
assert.equal(ledger.budget.activation,'ledger_only');
const first=b.reserveResearchProviderAttempt({metadata:ledger.metadata,run,limits,binding:binding('a1'),price});
assert.equal(first.dispatchAllowed,true);assert.equal(first.budget.chargedCostMicros,300);assert.equal(first.budget.chargedTokens,200);
const second=b.reserveResearchProviderAttempt({metadata:first.metadata,run,limits,binding:binding('a2'),price});
assert.equal(second.dispatchAllowed,true);assert.equal(second.budget.chargedAttempts,2);assert.equal(second.budget.chargedCostMicros,600);
assert.equal(b.readResearchProviderBudget(second.metadata).activation,'ledger_only');
assert.throws(()=>b.admitResearchProviderBudget(second.metadata,limits,'enforced'),/activation_changed/);
const enforced=b.admitResearchProviderBudget({},limits);
assert.equal(enforced.budget.activation,'enforced');
assert.throws(()=>b.reserveResearchProviderAttempt({metadata:enforced.metadata,run,limits,binding:binding('a1'),price}),/tokens_exhausted/);
for (const fn of [c46.reserveCase46ProviderAttempt,c46.admitCase46ProviderBudget,cap.reserveCaptureProviderAttempt,cap.admitCaptureProviderBudget,syn.reserveSyntheticReadProviderAttempt]) assert.equal(typeof fn,'function');
console.log('OFFLINE_PACKAGED_CAPTURE_LEDGER_ONLY_PASS');
LEDGERONLY
