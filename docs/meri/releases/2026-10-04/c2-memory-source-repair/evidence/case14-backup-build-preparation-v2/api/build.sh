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
