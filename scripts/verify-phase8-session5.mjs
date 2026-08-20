#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';
import {
  REQUIRED_BENCHMARK_STRATA,
  ROUTING_DECISIONS,
  sha256Hex,
} from '../apps/defense-parser-orchestrator/src/session5.mjs';
import { evaluateProviderDecision } from '../apps/defense-parser-orchestrator/src/provider-decision.mjs';

const root = resolve(process.cwd());
const flags = new Set(process.argv.slice(2));
const enforceLive = flags.has('--enforce-live-benchmark');
const enforceProviderDecision = flags.has('--enforce-provider-decision');

// Session 5 closes through exactly one path. Asserting both at once would let a
// negative decision borrow the positive path's credibility.
if (enforceLive && enforceProviderDecision) {
  console.error(
    '[phase8-session5] --enforce-live-benchmark and --enforce-provider-decision are mutually exclusive',
  );
  process.exit(2);
}

const PROVIDER_DECISION_PATH = [
  'docs',
  'defense-budget',
  'phase8-session5-provider-decision.json',
];
const LIVE_EVIDENCE_PATH = [
  'docs',
  'defense-budget',
  'phase8-session5-live-benchmark-evidence.json',
];
const PROVIDER_NOT_ADOPTED_STATUS = 'provider_not_adopted_operationally_blocked';
const failures = [];
const passes = [];
const p = (...x) => join(root, ...x);
const read = (...x) => {
  const target = p(...x);
  if (!existsSync(target)) {
    failures.push(`missing required file: ${relative(root, target)}`);
    return '';
  }
  return readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
};
const check = (ok, msg) => (ok ? passes : failures).push(msg);
function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir)) {
    const x = join(dir, e);
    if (statSync(x).isDirectory()) out.push(...walk(x));
    else out.push(x);
  }
  return out;
}

const legacy = read('apps', 'defense-parser-orchestrator', 'src', 'session5.mjs');
const real = [
  read('apps', 'defense-parser-orchestrator', 'src', 'real-batch.mjs'),
  read('apps', 'defense-parser-orchestrator', 'src', 'real-batch-config.mjs'),
  read('apps', 'defense-parser-orchestrator', 'src', 'real-batch-provider.mjs'),
  read('apps', 'defense-parser-orchestrator', 'src', 'real-batch-cost.mjs'),
  read('apps', 'defense-parser-orchestrator', 'src', 'real-batch-coordinator.mjs'),
].join('\n');
const awsReal = [
  read('apps', 'defense-parser-orchestrator', 'src', 'aws-real-runtime.mjs'),
  read('apps', 'defense-parser-orchestrator', 'src', 'aws-real-storage.mjs'),
  read('apps', 'defense-parser-orchestrator', 'src', 'aws-real-ledger.mjs'),
].join('\n');
const asyncRuntime = read(
  'apps',
  'defense-parser-orchestrator',
  'src',
  'real-async.mjs',
);
const cli = read('apps', 'defense-parser-orchestrator', 'src', 'cli.mjs');
const materializer = read(
  'apps',
  'defense-parser-orchestrator',
  'scripts',
  'materialize-live-inputs.mjs',
);
const dockerfile = read('apps', 'defense-parser-orchestrator', 'Dockerfile');
const readme = read('apps', 'defense-parser-orchestrator', 'README.md');
const contract = read(
  'packages',
  'defense-contracts',
  'src',
  'parser',
  'nvidia-batch.ts',
);
const realContract = read(
  'packages',
  'defense-contracts',
  'src',
  'parser',
  'nvidia-real-batch.ts',
);
const parserIndex = read(
  'packages',
  'defense-contracts',
  'src',
  'parser',
  'index.ts',
);
const infra = read(
  'infra',
  'cdk',
  'lib',
  'phase8-session5-nvidia-benchmark.ts',
);
const infraTest = read(
  'infra',
  'cdk',
  'test',
  'phase8-session5-nvidia-benchmark.spec.ts',
);
const tests =
  read('apps', 'defense-parser-orchestrator', 'test', 'real-batch.test.mjs') +
  read('apps', 'defense-parser-orchestrator', 'test', 'aws-real-runtime.test.mjs');
const defenseConfigValidation = read(
  'apps',
  'defense-api',
  'src',
  'config',
  'defense-config.validation.ts',
);
const runtimeManifest = read(
  'apps',
  'defense-api',
  'src',
  'runtime',
  'phase1-7-runtime.manifest.ts',
);
const manifestText = read(
  'docs',
  'defense-budget',
  'phase8-session5-live-benchmark-manifest.json',
);
const manifest = manifestText ? JSON.parse(manifestText) : {};

check(
  asyncRuntime.includes("ASYNC_EXECUTION_MODEL = 'sagemaker_async_inference'") &&
    asyncRuntime.includes('invoke-endpoint-async') &&
    !asyncRuntime.includes('create-transform-job') &&
    !asyncRuntime.includes('CreateTransformJob'),
  'async runtime is explicit and has no Batch Transform submission path',
);
check(
  asyncRuntime.includes('maxEndpointLifetimeSeconds') &&
    asyncRuntime.includes('computeMaximumEndpointReservationUsd') &&
    asyncRuntime.includes('ENDPOINT_DRAINING') &&
    asyncRuntime.includes('ENDPOINT_DELETED'),
  'async runtime has bounded lifetime, wall-clock reservation, and teardown states',
);
check(
  asyncRuntime.includes('configureScaleToZero') &&
    asyncRuntime.includes('MinCapacity: 0') &&
    asyncRuntime.includes('MaxCapacity: 1'),
  'async runtime configures max-one scale-to-zero capacity',
);
check(
  asyncRuntime.includes('LIVE_RUN_AUTHORIZATION_REQUIRED'),
  'async runtime refuses endpoint creation without explicit live authorization',
);

check(
  parserIndex.includes("export * from './nvidia-batch.js';"),
  'v1 NVIDIA parser contract remains exported',
);
check(
  parserIndex.includes("export * from './nvidia-real-batch.js';"),
  'v2 real-Batch contract is exported',
);
check(
  contract.includes('NvidiaProviderIdentityV1'),
  'provider-neutral v1 contract remains intact',
);
check(
  realContract.includes('NvidiaLivePageIdentityV2') &&
    realContract.includes('NvidiaSpendReservationV1'),
  'v2 contract includes live cache identity and atomic spend reservation',
);

for (const field of [
  'sourceSha256',
  'pageNumber',
  'modelVersion',
  'parserOptionsHash',
  'renderedImageSha256',
  'providerPayloadSha256',
  'renderingConfigSha256',
  'runtimeContractVersion',
]) {
  check(real.includes(field), `v2 cache identity binds ${field}`);
}
check(
  real.includes("REAL_BATCH_INPUT_CONTENT_TYPE = 'application/json'") &&
    real.includes("REAL_BATCH_OUTPUT_ACCEPT = 'application/json'"),
  'real Batch provider MIME is application/json',
);
check(
  !awsReal.includes('application/jsonlines'),
  'real AWS Batch path never advertises unsupported application/jsonlines MIME',
);
check(
  awsReal.includes('SplitType: REAL_BATCH_SPLIT_TYPE') &&
    awsReal.includes('AssembleWith: REAL_BATCH_ASSEMBLE_WITH'),
  'Batch Transform splits/assembles provider records line-by-line',
);
check(
  real.includes('nvidia_batch_input_sidecar_v2') &&
    real.includes('nvidia_normalized_page_artifact_v2'),
  'provider-native JSONL is normalized through hashed internal sidecars',
);
check(
  real.includes('MARKDOWN_BBOX_REQUIRED') &&
    real.includes('providerRawResponseSha256'),
  'Nemotron markdown_bbox output and raw provider bytes are verified',
);

check(
  cli.includes('AsyncNvidiaCoordinator') &&
    cli.includes('createAwsRealAsyncPorts') &&
    cli.includes("command === 'async-submit'"),
  'live CLI uses the async coordinator and async port factory',
);
check(
  cli.includes("command === 'async-reconcile'") &&
    cli.includes("command === 'async-watch'") &&
    cli.includes("command === 'async-drain'") &&
    cli.includes("command === 'async-zero-idle'"),
  'CLI provides async reconciliation, watchdog, drain, and zero-idle drivers',
);
check(
  cli.includes('caller provider facts are not accepted'),
  'event signals cannot inject provider status/cost/output facts',
);
check(
  real.includes('describeTransformJob') && real.includes('reconcileTransformFacts'),
  'terminal status and cost are reconciled from SageMaker facts',
);
check(
  real.includes('TIMEOUT_STOP_REQUESTED') && real.includes('stopTransformJob'),
  'timeout watchdog requests provider stop and awaits terminal reconciliation',
);
check(
  real.includes('COMPLETION_PENDING') &&
    real.includes('completionPublishAttempts'),
  'verified work persists a retryable completion-outbox state',
);
check(
  real.includes('dlqPublishPending'),
  'DLQ publication failure is persisted for reconciliation',
);

check(
  real.includes('SESSION5_AUTHORIZED_INITIAL_CAP_USD = 50') &&
    real.includes('SESSION5_AUTHORIZED_HARD_CAP_USD = 150'),
  'approved USD 50 initial / USD 150 hard caps are code-bound',
);
check(
  real.includes('extendedBudgetAuthorized') &&
    real.includes('effectiveSpendCapUsd'),
  'hard-cap extension requires explicit authorization',
);
check(
  awsReal.includes("'dynamodb', 'transact-write-items'") &&
    awsReal.includes('activeJobs < :max') &&
    awsReal.includes('spentAndReservedUsd'),
  'DynamoDB transaction atomically reserves concurrency and spend',
);
check(
  real.includes('NvidiaActiveGpuJobs') &&
    real.includes('NvidiaMonthlySpendUsd'),
  'runtime emits the exact metrics consumed by alarms',
);
check(
  real.includes('deterministicTransformJobName') &&
    !awsReal.includes('Date.now()'),
  'real provider submission is idempotent by deterministic attempt identity',
);

check(
  materializer.includes("model: 'nvidia/nemotron-parse'") &&
    materializer.includes("name: 'markdown_bbox'") &&
    materializer.includes('temperature: 0.0'),
  'materializer uses the pinned Nemotron Parse VLM request surface',
);
check(
  materializer.includes('renderingConfigSha256') &&
    materializer.includes('providerPayloadSha256') &&
    materializer.includes('renderedImage'),
  'materializer persists rendering, image, and provider-payload hashes',
);
check(
  real.includes('LIVE_CORPUS_NOT_ACCEPTABLE') &&
    real.includes("gold.reviewStatus !== 'accepted'") &&
    real.includes('gold.incomplete') &&
    real.includes('gold.conflicted'),
  'live acceptance refuses incomplete/conflicted/unreviewed gold',
);

check(
  infra.includes('aws_dynamodb as dynamodb') && infra.includes('ReservationLedger'),
  'CDK provides an atomic DynamoDB reservation ledger',
);
check(
  infra.includes('CompletionQueue') &&
    infra.includes('completionQueue.grantSendMessages'),
  'CDK provides and authorizes a dedicated completion queue',
);
check(
  infra.includes('enableNetworkIsolation: true'),
  'Marketplace SageMaker model has network isolation enabled',
);
check(
  infra.includes("'sagemaker:CreateEndpoint'") &&
    infra.includes("'sagemaker:InvokeEndpointAsync'") &&
    !infra.includes("'sagemaker:CreateTransformJob'"),
  'orchestrator IAM permits isolated Async Inference and no Batch Transform',
);
check(
  infraTest.includes("resourceCountIs('AWS::SQS::Queue', 3)") &&
    infraTest.includes("resourceCountIs('AWS::DynamoDB::Table', 1)"),
  'synth tests pin completion queue and atomic ledger topology',
);
check(
  infraTest.includes("resourceCountIs('AWS::SageMaker::Endpoint', 0)") &&
    infraTest.includes("resourceCountIs('AWS::SageMaker::EndpointConfig', 0)") &&
    infraTest.includes('Async Inference'),
  'synth tests pin orchestrator-owned ephemeral endpoint lifecycle',
);

for (const decision of ROUTING_DECISIONS) {
  check(
    legacy.includes(decision),
    `routing decision ${decision} remains implemented`,
  );
}
check(
  tests.includes('atomic reservation') &&
    tests.includes('provider JSONL') &&
    tests.includes('completion publication failure'),
  'P0 regression tests cover atomic spend, real output normalization, and completion recovery',
);

const defenseApiFiles = walk(p('apps', 'defense-api', 'src'));
const forbidden = defenseApiFiles.filter((file) => {
  const source = readFileSync(file, 'utf8');
  return (
    source.includes('defense-parser-orchestrator') ||
    source.includes('RealNvidiaBatchCoordinator')
  );
});
check(
  forbidden.length === 0,
  `public defense-api has no live parser-orchestrator import (${forbidden
    .map((f) => relative(root, f))
    .join(', ')})`,
);
check(
  !/EXPOSE\s+\d+/.test(dockerfile) &&
    !/createServer\(|\.listen\(/.test(real + awsReal + cli),
  'real orchestrator has no public listener',
);
check(
  !/Prisma|postgres|DATABASE_URL/.test(real + awsReal + cli),
  'real orchestrator has no database credential/dependency',
);
check(
  !/CUDA|nvidia\/cuda/i.test(dockerfile),
  'orchestrator image contains no GPU runtime',
);
check(
  readme.includes('not') && readme.includes('public `defense-api`'),
  'ownership boundary remains documented',
);

const strata = new Set(
  Array.isArray(manifest.requiredStrata)
    ? manifest.requiredStrata.map((x) => x.id)
    : [],
);
for (const s of REQUIRED_BENCHMARK_STRATA) {
  check(strata.has(s), `live manifest includes ${s}`);
}
check(
  manifest.executionModel === 'sagemaker_async_inference' &&
    manifest.persistentEndpointAllowed === false &&
    manifest.productionDefaultChangeAllowed === false,
  'manifest pins Async Inference and production defaults unchanged',
);
check(
  manifest.spendControls?.hardTotalIncrementalCapUsd === 150 &&
    manifest.spendControls?.initialBenchmarkTargetCapUsd === 50 &&
    manifest.spendControls?.maxConcurrentGpuJobs === 1,
  'manifest pins approved spend/concurrency authorization',
);

// --- No active production NVIDIA route -------------------------------------
// These hold regardless of which closeout path Session 5 takes.
check(
  legacy.includes("let decision = 'DETERMINISTIC_PRIMARY'") ||
    legacy.includes("decision: 'DETERMINISTIC_PRIMARY'"),
  'deterministic parsing remains the default routing decision',
);
check(
  legacy.includes("benchmarkDecision === 'NVIDIA_PRIMARY' && policy.benchmarkAccepted === true"),
  'NVIDIA can never be preferred unless benchmark acceptance is explicitly true',
);
check(
  manifest.nvidiaBenchmarkAccepted === false,
  'manifest keeps NVIDIA benchmark acceptance false, so no NVIDIA route can be preferred',
);
check(
  defenseConfigValidation.includes('/^NVIDIA_/') &&
    defenseConfigValidation.includes('/^DEFENSE_PARSER_MODEL_/'),
  'defense-api serve task forbids NVIDIA and parser-model credentials',
);
check(
  runtimeManifest.includes('forbiddenInHttpTask') &&
    runtimeManifest.includes('NVIDIA or GPU runtime'),
  'public HTTP service has no GPU runtime responsibility',
);
check(
  !/aws_events|events\.Rule|Schedule\.(cron|rate)/.test(infra),
  'benchmark control plane has no schedule that could auto-create GPU capacity',
);
check(
  infra.includes('persistentEndpointCount') ||
    infra.includes('PersistentEndpointCount'),
  'CDK publishes an explicit zero persistent-endpoint contract',
);

if (enforceLive) {
  const evidencePath =
    process.env.PHASE8_SESSION5_LIVE_BENCHMARK_EVIDENCE ||
    p('docs', 'defense-budget', 'phase8-session5-live-benchmark-evidence.json');
  check(
    existsSync(evidencePath),
    `live NVIDIA evidence exists at ${evidencePath}`,
  );
  if (existsSync(evidencePath)) {
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    const result = evidence.benchmarkResult;
    check(
      evidence.schemaVersion === 'phase8_session5_live_benchmark_evidence_v2',
      'live evidence schema is versioned',
    );
    check(
      result?.liveBenchmarkAccepted === true,
      'source-grounded live benchmark is accepted',
    );
    check(
      Array.isArray(result?.missingStrata) && result.missingStrata.length === 0,
      'live benchmark covers every required stratum',
    );
    check(
      result?.nvidiaObservationCount > 0,
      'live benchmark contains real NVIDIA observations',
    );
    check(
      Array.isArray(result?.acceptedPageClasses) &&
        result.acceptedPageClasses.length > 0,
      'at least one page class safely benefits from NVIDIA',
    );
    const withoutHash = { ...result };
    delete withoutHash.contentSha256;
    check(
      result?.contentSha256 === sha256Hex(withoutHash),
      'live benchmark result content hash is valid',
    );
    check(
      evidence.zeroIdleProof?.activeJobs === 0 &&
        Array.isArray(evidence.zeroIdleProof?.providerActiveJobs) &&
        evidence.zeroIdleProof.providerActiveJobs.length === 0 &&
        Array.isArray(evidence.zeroIdleProof?.persistentEndpoints) &&
        evidence.zeroIdleProof.persistentEndpoints.length === 0 &&
        evidence.zeroIdleProof.zeroIdleGpu === true,
      'live evidence proves ledger + provider zero-idle state',
    );
    check(
      evidence.productionDefaultChanged === false,
      'live evidence confirms no production default route changed',
    );
  }
} else if (enforceProviderDecision) {
  // --- Closeout path B: PROVIDER_NOT_ADOPTED -------------------------------
  // A negative decision is only acceptable when nothing was produced, nothing
  // was scored, nothing is running, and production routing is untouched.
  const decisionPath =
    process.env.PHASE8_SESSION5_PROVIDER_DECISION || p(...PROVIDER_DECISION_PATH);
  check(
    existsSync(decisionPath),
    `provider-decision evidence exists at ${decisionPath}`,
  );
  if (existsSync(decisionPath)) {
    let decision = null;
    try {
      decision = JSON.parse(readFileSync(decisionPath, 'utf8'));
    } catch {
      check(false, 'provider-decision evidence is valid JSON');
    }
    if (decision) {
      const verdict = evaluateProviderDecision(decision);
      for (const failure of verdict.failures) {
        check(false, `provider decision: ${failure}`);
      }
      check(
        verdict.acceptable,
        'provider decision satisfies every negative-closeout requirement',
      );
      check(
        decision.acceptanceAmendment ===
          'docs/defense-budget/PHASE-8-SESSION-5-ACCEPTANCE-AMENDMENT.md' &&
          existsSync(p('docs', 'defense-budget', 'PHASE-8-SESSION-5-ACCEPTANCE-AMENDMENT.md')),
        'provider decision cites an existing Session 5 acceptance amendment',
      );
    }
  }
  // The negative path may not be used to paper over provider output that
  // exists but was never evaluated, nor to sit beside fabricated evidence.
  check(
    !existsSync(p(...LIVE_EVIDENCE_PATH)),
    'no live-benchmark evidence file exists alongside the negative decision',
  );
  check(
    manifest.status === PROVIDER_NOT_ADOPTED_STATUS &&
      manifest.providerDecision?.decision === 'NVIDIA_NOT_ADOPTED' &&
      manifest.providerDecision?.status === 'OPERATIONALLY_BLOCKED' &&
      manifest.providerDecision?.accuracyBenchmarkCompleted === false &&
      manifest.providerDecision?.nvidiaRoutingEnabled === false,
    'manifest records the negative provider decision',
  );
  check(
    manifest.providerDecision?.evidencePath === PROVIDER_DECISION_PATH.join('/'),
    'manifest points at the separate provider-decision artifact',
  );
} else if (manifest.status === PROVIDER_NOT_ADOPTED_STATUS) {
  // Ordinary (unflagged) verification once Session 5 closed negatively.
  check(
    existsSync(p(...PROVIDER_DECISION_PATH)),
    'provider-decision evidence is present for the negative closeout',
  );
  check(
    !existsSync(p(...LIVE_EVIDENCE_PATH)),
    'live benchmark evidence remains absent after the negative decision',
  );
  check(
    manifest.providerDecision?.decision === 'NVIDIA_NOT_ADOPTED' &&
      manifest.providerDecision?.accuracyBenchmarkCompleted === false,
    'manifest keeps the negative decision without claiming a benchmark',
  );
  check(
    manifest.executionModel === 'sagemaker_async_inference',
    'manifest still records the exact evaluated execution model',
  );
} else if (
  manifest.status === 'corpus_ready_awaiting_live_run_authorization' ||
  manifest.status === 'async_runtime_ready_awaiting_live_run_authorization'
) {
  check(
    manifest.corpusReview?.liveCorpusReady === true &&
      manifest.corpusReview?.acceptedStrataCount === REQUIRED_BENCHMARK_STRATA.length &&
      manifest.corpusReview?.blockedStrataCount === 0,
    'ordinary verification confirms source-grounded corpus is ready while live execution remains unauthorized',
  );
  check(
    !existsSync(p('docs', 'defense-budget', 'phase8-session5-live-benchmark-evidence.json')),
    'live benchmark evidence is absent before live-run authorization',
  );
  check(
    manifest.executionModel === 'sagemaker_async_inference',
    'async runtime manifest remains live-run gated',
  );
} else {
  check(
    ['p0_runtime_implemented_re_review_required', 'p0_runtime_accepted_live_corpus_blocked'].includes(manifest.status) &&
      Array.isArray(manifest.blockedBy) &&
      manifest.blockedBy.length > 0,
    'ordinary verification remains blocked pending source-grounded corpus completion',
  );
}

for (const pass of passes) {
  console.log(`[phase8-session5] PASS: ${pass}`);
}
if (failures.length) {
  console.error(`\n[phase8-session5] FAILED (${failures.length})`);
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
let verdict = '[phase8-session5] SESSION5_P0_RUNTIME_PASS';
if (enforceLive) {
  verdict = '[phase8-session5] SESSION5_LIVE_BENCHMARK_PASS';
} else if (enforceProviderDecision) {
  verdict = '[phase8-session5] SESSION5_COMPLETE_NVIDIA_NOT_ADOPTED';
} else if (manifest.status === PROVIDER_NOT_ADOPTED_STATUS) {
  verdict = '[phase8-session5] SESSION5_P0_RUNTIME_PASS_NVIDIA_NOT_ADOPTED';
}
console.log(verdict);
