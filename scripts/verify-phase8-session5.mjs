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

const root = resolve(process.cwd());
const enforceLive = new Set(process.argv.slice(2)).has('--enforce-live-benchmark');
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
const manifestText = read(
  'docs',
  'defense-budget',
  'phase8-session5-live-benchmark-manifest.json',
);
const manifest = manifestText ? JSON.parse(manifestText) : {};

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
  cli.includes('RealNvidiaBatchCoordinator') &&
    cli.includes('createAwsRealBatchPorts'),
  'live CLI uses the real-Batch coordinator, not the simulation coordinator',
);
check(
  cli.includes("command === 'reconcile'") && cli.includes("command === 'retry'"),
  'CLI provides reconciliation and bounded retry drivers',
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
  infra.includes("'sagemaker:CreateTransformJob'") &&
    !infra.includes("'sagemaker:CreateEndpoint'"),
  'orchestrator IAM permits Batch Transform but no endpoint mutation',
);
check(
  infraTest.includes("resourceCountIs('AWS::SQS::Queue', 3)") &&
    infraTest.includes("resourceCountIs('AWS::DynamoDB::Table', 1)"),
  'synth tests pin completion queue and atomic ledger topology',
);
check(
  infraTest.includes("resourceCountIs('AWS::SageMaker::Endpoint', 0)") &&
    infraTest.includes("resourceCountIs('AWS::SageMaker::EndpointConfig', 0)"),
  'synth tests pin zero persistent SageMaker endpoints',
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
  manifest.executionModel === 'sagemaker_batch_transform' &&
    manifest.persistentEndpointAllowed === false &&
    manifest.productionDefaultChangeAllowed === false,
  'manifest keeps Batch Transform dark and production defaults unchanged',
);
check(
  manifest.spendControls?.hardTotalIncrementalCapUsd === 150 &&
    manifest.spendControls?.initialBenchmarkTargetCapUsd === 50 &&
    manifest.spendControls?.maxConcurrentGpuJobs === 1,
  'manifest pins approved spend/concurrency authorization',
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
      evidence.schemaVersion === 'phase8_session5_live_benchmark_evidence_v1',
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
} else {
  check(
    manifest.status === 'p0_runtime_implemented_re_review_required' &&
      Array.isArray(manifest.blockedBy) &&
      manifest.blockedBy.length > 0,
    'ordinary verification remains blocked pending re-review and source-grounded corpus completion',
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
console.log(
  enforceLive
    ? '[phase8-session5] SESSION5_LIVE_BENCHMARK_PASS'
    : '[phase8-session5] SESSION5_P0_RUNTIME_PASS',
);
