set -euo pipefail
# The native ARM64 test workspace uses the canonical Dockerfile's dependency/build order.
# No host credentials or database/provider secrets enter either test container.
docker run --rm -e CI=1 -e NODE_OPTIONS=--max-old-space-size=6144 \
  -v "${CODEBUILD_SRC_DIR}:/workspace" -w /workspace \
  "capiro-orchestrator-test-base:${EXPECTED_SHA}" bash -lc '
    set -euo pipefail
    pnpm install --frozen-lockfile --filter=@capiro/meriv2-orchestrator... --filter=@capiro/auth... --filter=@capiro/meriv2-core... --filter=@capiro/shared... --filter=@capiro/strategy-verifier...
    pnpm --filter @capiro/shared build
    pnpm --filter @capiro/auth build
    pnpm --filter @capiro/meriv2-core build
    pnpm --filter @capiro/strategy-verifier build
    mkdir -p apps/meriv2-orchestrator/prisma
    cp apps/api/prisma/schema.prisma apps/meriv2-orchestrator/prisma/schema.prisma
    pnpm --filter @capiro/meriv2-orchestrator exec prisma generate
    pnpm --filter @capiro/meriv2-orchestrator build
  '
# Extend the existing offline source qualification container; no external transport.
docker run --rm --network none -e CI=1 -e NODE_OPTIONS=--max-old-space-size=6144 \
  -v "${CODEBUILD_SRC_DIR}:/workspace" -w /workspace/packages/meriv2-core \
  "capiro-orchestrator-test-base:${EXPECTED_SHA}" bash -lc '
    set -euo pipefail
    node node_modules/jest/bin/jest.js src/context/case12-setup-binding.spec.ts src/context/semantic-clock.spec.ts src/context/memory-capture-source.spec.ts src/context/capture-evidence-receipt.spec.ts src/context/governed-evidence-auth.spec.ts --runInBand --json --outputFile=/workspace/core-case20-jest-results.json
  '
python3 - <<'C2CORETESTS'
import json
result=json.load(open('core-case20-jest-results.json'))
assert result['success'] is True and result['numFailedTests']==0 and result['numFailedTestSuites']==0 and result['numPendingTests']==0
passed=[a['fullName'] for r in result['testResults'] for a in r['assertionResults'] if a['status']=='passed']
for required in ['Case20 accepts the current-tenant public full source only through its matching controlled HTTP proof', 'Case20 preserves the prompt-time bound and the independent API join requirement']:
    assert any(required in name for name in passed), required
for fault in ['case','tenant','client','source-client','missing-attempt','duplicate-attempt','call','tool','request','trace','turn','run','http','error','version','source','logical-source','source-read','full-read','passage','content','response','verify','invocation','partial','missing-clock']:
    assert any('Case20 public-source proof rejects '+fault+' drift' in name for name in passed), fault
print('CORE_CASE20_SOURCE_PROOF_NATIVE_TESTS_PASS')
for required in ['response proof refuses same-policy callId replay','response proof refuses same-policy nonce replay','response proof refuses same-policy inputSha256 replay','request transport authenticates policy, exact input and bounded call identity']:
    assert any(required in name for name in passed), required
assert result['numPassedTests'] == 191 and result['numPassedTestSuites'] == 5
print('CORE_CANONICAL_MEMORY_SOURCE_NATIVE_TESTS_PASS')
for required in ['copies exact fields and compares independently of object insertion order','Case12 fixed scoring clock retains actual current observation and exact run verification binding','native setup shape is mandatory even with Case12 semantic clock','requires actual setup provenance instead of inventing reset or seed receipts','search_memory complete clock joins use Case12 distinct provider boundary','proposal read is not inherited as Case12 approved-memory capability']:
    assert any(required in name for name in passed),required
print('CORE_CASE12_FIVE_SUITE_191_TESTS_PASS')
C2CORETESTS

# Test dependencies are already installed in the workspace; no package download is possible here.
docker run --rm --network none -e CI=1 -e NODE_OPTIONS=--max-old-space-size=6144 \
  -v "${CODEBUILD_SRC_DIR}:/workspace" -w /workspace/apps/meriv2-orchestrator \
  "capiro-orchestrator-test-base:${EXPECTED_SHA}" bash -lc '
    set -euo pipefail
    node node_modules/typescript/bin/tsc --noEmit
    node node_modules/jest/bin/jest.js --runInBand --detectOpenHandles --forceExit --json --outputFile=/workspace/orchestrator-jest-results.json
  '
python3 - <<'PY'
import json
result=json.load(open('orchestrator-jest-results.json'))
assert result['success'] is True and result['numFailedTests']==0 and result['numFailedTestSuites']==0
assert result['numPassedTests'] >= 1582 and result['numPendingTests'] == 2 and result['numPassedTestSuites'] == 130
passed=[a['fullName'] for r in result['testResults'] for a in r['assertionResults'] if a['status']=='passed']
for case in ['01-empty','01-complete','01-partial','14-complete','tenant','actor','client','missing-client','compiler','approved','disabled','http-failure']:
  required='observes the actual own-proposal response as a bounded no-clock-consumer read: '+case
  assert any(required in name for name in passed), required
for required in ['Case20 capture begins before actual prompt rendering without moving the runtime budget timer'] + ['Case20 '+tool+' preserves exact source completion and refuses projection-truncated completion' for tool in ['search_program_elements','get_program_element','get_pe_budget_timeline']]:
  assert any(required in name for name in passed), required
print('ORCHESTRATOR_CASE20_SOURCE_PROOF_NATIVE_TESTS_PASS')
for case in ['01','14']:
  assert any('canonical memory owner joins actual Case'+case+' HTTP bytes without exposing proof to model' in name for name in passed),case
print('ORCHESTRATOR_CANONICAL_MEMORY_SOURCE_LOOPBACK_PASS')
assert any('canonical memory owner joins actual Case12 HTTP bytes without exposing proof to model' in name for name in passed)
print('ORCHESTRATOR_CASE12_CONTROLLED_HTTP_MEMORY_LOOPBACK_PASS')
pending=sorted(a['fullName'] for r in result['testResults'] for a in r['assertionResults'] if a['status']=='pending')
assert pending == ['MeriV2 scoping parity (SC0.7) cross-tenant + row-set parity (live, gated) cross-tenant token (tenant-A JWT, tenant-B clientId) → 403', 'MeriV2 scoping parity (SC0.7) cross-tenant + row-set parity (live, gated) returns exactly the rows current Meri returns for each fixed (user, tenant)']
print('ORCHESTRATOR_SOURCE_PENDING_TESTS='+json.dumps(pending))
print('ORCHESTRATOR_EXACT_EXISTING_LIVE_SKIPS_PASS')
print('ORCHESTRATOR_CAPTURE_CONTRACT_LOOPBACK_TESTS_PASS')
for required in ['real governed-context MAC binds exact original turn into separate trusted scope', 'routes a missing approved preference to the separate own-pending governance read', 'discovers the canonical own-proposal read without inventing approval authority', 'exposes own proposal reads only in full chat', 'renders the qualified semantic clock and records actual date-block bytes outside policy', 'native dispatch requires the fixed clock only for original qualified readonly fixtures', 'refused unwrapped execution poisons the clock census', 'refused missing-call-id execution poisons the clock census', 'refused wrong-tool execution poisons the clock census', 'retains actual 01 HTTP clock evidence before truncation', 'retains actual 20 HTTP clock evidence before truncation', 'native Responses capture=readonly sets default tier only for capture before byte reservation','native Responses capture=artifact sets default tier only for capture before byte reservation','native Responses capture=none sets default tier only for capture before byte reservation',  'capture refuses unsupported priced units before reservation or fetch', 'capture refuses unqualified endpoint', 'capture allows inline text, function and reasoning replay; binds normalized final body', 'ordinary budgeted fetch preserves custom endpoint, premium tier and multimodal body', 'capture core schema reserves prepared output8192 and final bytes once per retry', 'capture core json reserves prepared output8192 and final bytes once per retry', 'native Responses refuses image input before either reservation or fetch', 'capture core fallback reserves each actual prepared provider wire without duplicate outer reservations', 'capture core unpriced configured provider fails before dispatch and does not silently choose fallback', 'capture core refuses an unbudgeted completion before provider dispatch', 'ordinary core budget keeps prior request shape and accounting behavior', 'capture Typesafe JEV remains unqualified by OpenAI rates, with no provider fetch']:
  assert any(required in name for name in passed), required
print('ORCHESTRATOR_SOURCE_TEST_COUNTS='+json.dumps({k:result[k] for k in ['numTotalTests','numPassedTests','numFailedTests','numPendingTests','numTotalTestSuites','numPassedTestSuites','numFailedTestSuites','numPendingTestSuites']}))
assert any('case46 export capture is write-only; an inexact export is blocked with exact reasons and corrected once' in name for name in passed)
print('ORCHESTRATOR_CASE46_EXPORT_WRITE_ONLY_PASS')
assert any('a governed capture export keeps its exact text, including the final newline' in name for name in passed)
print('ORCHESTRATOR_CASE46_EXPORT_EXACT_TEXT_PASS')
assert any('an oversized timeline keeps the whole funding summary and the current cycle first' in name for name in passed)
print('ORCHESTRATOR_PE_TIMELINE_SUMMARY_PASS')
print('Skipped live tests are NOT RUN; this is offline source qualification only.')
PY
test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"
test -z "$(git status --porcelain --untracked-files=no)"
image="967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/meriv2-orchestrator:${EXPECTED_SHA}"
docker build --no-cache --platform linux/arm64 \
  --label "org.opencontainers.image.revision=$EXPECTED_SHA" \
  --label 'org.opencontainers.image.source=https://github.com/neo-capiro/capirov2' \
  -f apps/meriv2-orchestrator/Dockerfile -t "$image" .
test "$(docker image inspect "$image" --format '{{.Architecture}}')" = arm64
test "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$EXPECTED_SHA"
test "$(docker run --rm --network none --entrypoint node "$image" -p 'process.version')" = v20.16.0
# Final image starts through its real entrypoint with synthetic local-only configuration.
# The container has no network interface except loopback; no shared DB/provider calls can succeed.
timeout 90s docker run --rm -i --network none --entrypoint node \
  -e DATABASE_URL=postgresql://offline:offline@127.0.0.1:1/offline \
  -e CLERK_SECRET_KEY=sk_test_meriv2_jest_dummy \
  -e MERIV2_BIND_HOST=127.0.0.1 -e MERIV2_PORT=4300 \
  -e MERIV2_LOG_LEVEL=warn "$image" - <<'NODE'
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const p = require('@prisma/client');
assert.equal(typeof p.PrismaClient, 'function');
require('./dist/app.module.js');
const child = spawn('/usr/bin/dumb-init', ['--', '/usr/local/bin/entrypoint.sh', 'serve'], { stdio: ['ignore', 'inherit', 'inherit'] });
let exited = false;
let spawnError;
child.once('error', error => { spawnError = error; });
const done = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
(async () => {
  try {
    let health;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (exited) throw new Error('Packaged entrypoint exited before health became ready');
      try {
        const response = await fetch('http://127.0.0.1:4300/meri-api/health', { signal: AbortSignal.timeout(1500) });
        if (response.ok) { health = await response.json(); break; }
      } catch (_) {}
      await delay(250);
    }
    assert.deepEqual(health, { ok: true, service: 'meriv2-orchestrator' });
    const get = await fetch('http://127.0.0.1:4300/meri-api/tools', { signal: AbortSignal.timeout(3000) });
    assert.equal(get.status, 401);
    const post = await fetch('http://127.0.0.1:4300/meri-api/tools/get_client_context/invoke', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { clientId: '11111111-1111-4111-8111-111111111111' } }),
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(post.status, 401);
    console.log('OFFLINE_PACKAGED_ENTRYPOINT_HEALTH_AUTH_PASS');
  } finally {
    child.kill('SIGTERM');
    await Promise.race([done, delay(5000)]);
    if (!exited) child.kill('SIGKILL');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
NODE
docker run --rm --network none --entrypoint node "$image" -e 'const a=require("node:assert/strict"),c=require("@capiro/meriv2-core"),plan=request=>c.planGovernmentAffairsEvidence({request,frame:c.resolveGovernmentAffairsOperatingFrame({request}),surface:"chat"});a.equal(plan("Read-only QA: list three things you can help me with besides email.").requestCategories.includes("negative_or_exhaustive"),false);a.equal(plan("If the mailbox search fails, say that it failed.").requestCategories.includes("bill_status"),false);a.equal(plan("Read-only: verify all awards.").requestCategories.includes("negative_or_exhaustive"),true);a.equal(plan("Should we contact Office Delta for Aster?").requestCategories.includes("budget_delta"),false);a.equal(plan("A failed search is unknown, not zero.").requestCategories.includes("bill_status"),false);a.equal(plan("What is the increase for 0602712F?").requestCategories.includes("budget_delta"),true);a.equal(plan("Compare House vs Senate positions on PE 0603851F.").requestCategories.includes("budget_delta"),false);console.log("OFFLINE_C1_CLASSIFICATION_REPAIRS_PASS")'
docker run --rm -i --network none --entrypoint node "$image" - <<'MAIL'
const assert = require("node:assert/strict");
const { ApiToolExecutorRepo } = require("./dist/meri/api-tool-executor.repo.js");
const { RequestCredentialsStore } = require("./dist/request/request-credentials.store.js");
const config = { MERIV2_API_BASE_URL: "https://offline.invalid", INTERNAL_SERVICE_SECRET: "synthetic-offline-secret" };
const repo = new ApiToolExecutorRepo({ get: key => config[key] });
let called = 0;
global.fetch = async (url, init) => {
  called++; assert.equal(url, "https://offline.invalid/api/clio/tools/list_emails");
  assert.equal(init.headers.authorization, "Bearer synthetic-offline-bearer");
  assert.equal(init.headers["x-internal-service-secret"], config.INTERNAL_SERVICE_SECRET);
  assert.deepEqual(JSON.parse(init.body), { limit: 1, folder: "all", offset: 0 });
  return new Response(JSON.stringify({ totalMatches: 0, returned: 0, hasMore: false, messages: [], searchedMailboxes: [{mailCoverage:{sourceStatus:"healthy"}}] }), {status:200});
};
RequestCredentialsStore.run({bearerToken:"synthetic-offline-bearer"}, () => repo.execute({}, "list_emails", Object.freeze({limit:1})))
  .then(result => { assert.equal(result.totalMatches,0); assert.equal(called,1); console.log("OFFLINE_PACKAGED_MAIL_DEFAULTS_PASS"); })
  .catch(error => { console.error(error); process.exitCode=1; });
MAIL
docker run --rm -i --network none --entrypoint node "$image" - <<'DIRECTIVE'
const assert = require("node:assert/strict");
const core = require("@capiro/meriv2-core");
const plan = request => core.planGovernmentAffairsEvidence({request, frame:core.resolveGovernmentAffairsOperatingFrame({request}), surface:"chat"});
const concise = "C1 final verification: In exactly three short bullets, describe how you can help with research, drafting, and task organization. Use no tools.";
assert.deepEqual(plan(concise).requestCategories, ["general_background"]);
assert.ok(plan("List all awards. Use no tools.").requestCategories.includes("negative_or_exhaustive"));
assert.ok(plan("Who is the current committee chair? Use no tools.").requestCategories.includes("current_role"));
const quoted = 'The manual says "For this procedure, use no tools. The installation ends here." Verify that instruction.';
assert.ok(plan(quoted).requestCategories.includes("negative_or_exhaustive"));
console.log("OFFLINE_PACKAGED_NO_TOOLS_DIRECTIVE_PASS");
DIRECTIVE
docker run --rm -i --network none --entrypoint node "$image" - <<'C2CLOCKORCH'
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
C2CLOCKORCH
docker run --rm -i --network none --entrypoint node "$image" - <<'C2WIREORCH'
const assert = require('node:assert/strict');
const {withTrustedCurrentTurnScope} = require('./dist/request/trusted-current-turn-scope.js');
const {captureProviderWireActive,prepareCaptureOpenAiBody,prepareCaptureProviderFetch} = require('./dist/meri/meri-capture-provider-wire.js');
const scope={tenantId:'synthetic-tenant',userId:'synthetic-user',conversationId:'synthetic-chat',selectedClientId:'synthetic-client',
  capturePolicy:{expectedCaptureWrites:['context_packet_and_evidence','conversation_user_message','conversation_assistant_message','provider_budget_ledger']}};
const body={model:'gpt-6-astra',store:false,max_output_tokens:8192,input:[{role:'user',content:'synthetic text'}],
  tools:[{type:'function',name:'search_memory',parameters:{type:'object'}}]};
const original=JSON.stringify(body);
assert.equal(captureProviderWireActive(),false);
assert.equal(prepareCaptureOpenAiBody(body),body);
const ordinary=['https://custom.invalid/v1/responses',{method:'POST',body:JSON.stringify({...body,service_tier:'priority',input:[{type:'input_image',image_url:'synthetic'}]})}];
assert.equal(prepareCaptureProviderFetch(ordinary),ordinary);
withTrustedCurrentTurnScope(scope,()=>{
  assert.equal(captureProviderWireActive(),true);
  const prepared=prepareCaptureOpenAiBody(body);
  assert.equal(prepared.service_tier,'default');assert.equal(JSON.stringify(body),original);
  assert.deepEqual(prepared.input,body.input);assert.equal(prepared.model,body.model);
  for(const change of [{service_tier:'auto'},{service_tier:'priority'},
    {input:[{role:'user',content:[{type:'input_image',image_url:'synthetic'}]}]},
    {input:[{role:'user',content:[{type:'input_audio',data:'synthetic'}]}]},
    {tools:[{type:'web_search'}]},{tool_choice:{type:'web_search'}},
    {previous_response_id:'external-response'},{input:[{type:'item_reference',id:'external-item'}]}]){
    assert.throws(()=>prepareCaptureOpenAiBody({...body,...change}),/meri_capture_provider_wire/);
  }
  const args=prepareCaptureProviderFetch(['https://api.openai.com/v1/responses',{method:'POST',body:original}]);
  assert.equal(args[1].redirect,'error');assert.equal(JSON.parse(args[1].body).service_tier,'default');
  for(const url of ['https://proxy.invalid/v1/responses','https://api.openai.com/v1/responses?region=other','https://api.openai.com/v1/chat/completions']){
    assert.throws(()=>prepareCaptureProviderFetch([url,{method:'POST',body:original}]),/meri_capture_provider_wire/);
  }
  const replay={...body,input:[...body.input,{type:'reasoning',id:'synthetic-reasoning',summary:[{type:'summary_text',text:'synthetic'}]},
    {type:'function_call',call_id:'synthetic-call',name:'search_memory',arguments:'{}'},
    {type:'function_call_output',call_id:'synthetic-call',output:'synthetic text'}]};
  assert.equal(prepareCaptureOpenAiBody(replay).service_tier,'default');
});
assert.equal(captureProviderWireActive(),false);
console.log('OFFLINE_PACKAGED_CAPTURE_PROVIDER_ORCHESTRATOR_GUARDS_PASS');
console.log('Actual packaged guard/ALS behavior only; no reservation, provider, database or live pricing qualification is claimed.');
C2WIREORCH


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

docker run --rm -i --network none --entrypoint node "$image" <<'CASE46RECOVERY'
const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
const {MERI_CASE46:f}=require('/app/packages/meriv2-core/dist/index.js');
const {withTrustedCurrentTurnScope:scope}=require('/app/apps/meriv2-orchestrator/dist/request/trusted-current-turn-scope.js');
const {prepareCaptureOpenAiBody:prepare}=require('/app/apps/meriv2-orchestrator/dist/meri/meri-capture-provider-wire.js');
const p={version:1,kind:'governed_artifact_acceptance_capture',caseId:'46',fixtureNamespace:f.namespace,tenantId:f.tenantId,tenantSlug:f.tenantSlug,actorUserId:f.actorUserId,clientId:f.clientId,conversationId:randomUUID(),captureRunId:randomUUID(),policyId:randomUUID(),requestId:'offline',traceId:'offline',turnId:randomUUID(),source:{owner:'engagement_attachment',logicalId:'ARTIFACT-BRIEF-1',physicalId:randomUUID(),rowVersion:'42',ownershipSha256:'a'.repeat(64),contentSha256:f.sha256,byteLength:28},currentVerifySha256:'b'.repeat(64),qualificationSha256:'c'.repeat(64),issuedAt:Date.now(),expiresAt:Date.now()+60000,allowedTool:'create_word',approval:'canonical_current_user_required',maximumProposals:1,maximumArtifactEffects:1,dynamicMcpAllowed:false,incidentalWriters:'suppressed',expectedWrites:['context_packet_and_evidence','conversation_user_message','conversation_assistant_message','provider_budget_ledger','canonical_action_proposal','approved_text_artifact']};
const body={model:'gpt-6-astra',store:false,max_output_tokens:8192,input:[{role:'user',content:'Export the brief'}]};
assert.equal(prepare(body).service_tier,undefined);
scope({tenantId:p.tenantId,userId:p.actorUserId,conversationId:p.conversationId,selectedClientId:p.clientId,governedArtifactPolicy:p},()=>{assert.equal(prepare(body).service_tier,'default');assert.throws(()=>prepare({...body,service_tier:'priority'}));assert.throws(()=>prepare({...body,tools:[{type:'web_search'}]}));});
console.log('OFFLINE_PACKAGED_CASE46_QUALIFIED_PROVIDER_WIRE_PASS');

CASE46RECOVERY
