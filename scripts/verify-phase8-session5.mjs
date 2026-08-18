#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';
import {
  REQUIRED_BENCHMARK_STRATA,
  ROUTING_DECISIONS,
  sha256Hex,
} from '../apps/defense-parser-orchestrator/src/session5.mjs';

const root = resolve(process.cwd());
const args = new Set(process.argv.slice(2));
const enforceLive = args.has('--enforce-live-benchmark');
const failures = [];
const passes = [];

function path(...parts) {
  return join(root, ...parts);
}

function read(...parts) {
  const target = path(...parts);
  if (!existsSync(target)) {
    failures.push(`missing required file: ${relative(root, target)}`);
    return '';
  }
  return readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
}

function assert(condition, message) {
  if (condition) passes.push(message);
  else failures.push(message);
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory)) {
    const target = join(directory, entry);
    if (statSync(target).isDirectory()) files.push(...walk(target));
    else files.push(target);
  }
  return files;
}

const orchestrator = read('apps', 'defense-parser-orchestrator', 'src', 'session5.mjs');
const awsRuntime = read('apps', 'defense-parser-orchestrator', 'src', 'aws-runtime.mjs');
const cli = read('apps', 'defense-parser-orchestrator', 'src', 'cli.mjs');
const dockerfile = read('apps', 'defense-parser-orchestrator', 'Dockerfile');
const readme = read('apps', 'defense-parser-orchestrator', 'README.md');
const contract = read('packages', 'defense-contracts', 'src', 'parser', 'nvidia-batch.ts');
const parserIndex = read('packages', 'defense-contracts', 'src', 'parser', 'index.ts');
const infra = read('infra', 'cdk', 'lib', 'phase8-session5-nvidia-benchmark.ts');
const infraTest = read('infra', 'cdk', 'test', 'phase8-session5-nvidia-benchmark.test.ts');
const tests = read('apps', 'defense-parser-orchestrator', 'test', 'session5.test.mjs');
const manifestText = read('docs', 'defense-budget', 'phase8-session5-live-benchmark-manifest.json');
const manifest = manifestText ? JSON.parse(manifestText) : {};

assert(
  parserIndex.includes("export * from './nvidia-batch.js';"),
  'shared defense parser contract exports the NVIDIA batch contract',
);
assert(
  contract.includes('NvidiaProviderIdentityV1') &&
    contract.includes('NvidiaBatchRequestV1') &&
    contract.includes('NvidiaBatchResultV1'),
  'request/result/provider provenance is a shared versioned contract',
);

for (const field of [
  'sourceSha256',
  'pageNumber',
  'modelVersion',
  'parserOptionsHash',
  'runtimeContractVersion',
]) {
  assert(orchestrator.includes(field), `cache/provider identity binds ${field}`);
}
assert(
  orchestrator.includes('governed escalation approval') ||
    orchestrator.includes('UNGOVERNED_ESCALATION'),
  'NVIDIA planning refuses ungoverned page escalation',
);
assert(
  orchestrator.includes('CONCURRENCY_LIMIT') &&
    orchestrator.includes('BUDGET_LIMIT') &&
    orchestrator.includes('PAGE_LIMIT'),
  'concurrency, page-count, and hard budget guards are enforced before submission',
);
assert(
  orchestrator.includes('ARTIFACT_HASH_MISMATCH') &&
    orchestrator.includes('PROVIDER_IDENTITY_MISMATCH') &&
    orchestrator.includes('SOURCE_HASH_MISMATCH'),
  'provider artifacts must pass source, provider, and content-hash verification',
);
assert(
  orchestrator.includes('NvidiaBatchDlq') &&
    orchestrator.includes('nvidia_failed_no_silent_fabrication'),
  'failed pages are DLQed/reviewed without fabricated content',
);
for (const decision of ROUTING_DECISIONS) {
  assert(orchestrator.includes(decision), `routing decision ${decision} is implemented`);
}

assert(
  orchestrator.includes("routingMode: env.NVIDIA_ROUTING_MODE || 'benchmark'") &&
    orchestrator.includes('preferred routing requires accepted source-grounded benchmark evidence'),
  'default route remains benchmark and preferred mode is benchmark-gated',
);
assert(
  orchestrator.includes('maxConcurrentGpuJobs') &&
    orchestrator.includes('monthlyGpuBudgetUsd') &&
    orchestrator.includes('maxPagesPerJob'),
  'operator cost/concurrency settings are represented in runtime configuration',
);

assert(
  awsRuntime.includes('AwsCliS3JobStore') &&
    awsRuntime.includes('/events/') &&
    awsRuntime.includes('/latest/'),
  'asynchronous job state is stored as append-only S3 events plus a materialized latest state',
);
assert(
  orchestrator.includes("'sagemaker', 'create-transform-job'") &&
    !orchestrator.includes("'sagemaker', 'create-endpoint'"),
  'runtime adapter can create Batch Transform jobs and cannot create endpoints',
);
assert(
  cli.includes('zero-idle') && cli.includes('handle-event') && cli.includes('benchmark'),
  'command runtime supports completion events, live benchmark, and zero-idle proof',
);

assert(
  dockerfile.includes('public.ecr.aws/aws-cli/aws-cli') &&
    dockerfile.includes('USER 1001:1001') &&
    !/CUDA|nvidia\/cuda/i.test(dockerfile),
  'orchestrator image uses task-role AWS CLI, runs non-root, and contains no GPU runtime',
);
assert(
  !/EXPOSE\s+\d+/.test(dockerfile) &&
    !/createServer\(|\.listen\(/.test(orchestrator + cli + awsRuntime),
  'orchestrator has no public HTTP listener',
);
assert(
  !/Prisma|postgres|DATABASE_URL/.test(orchestrator + cli + awsRuntime),
  'orchestrator has no database dependency or credential',
);

assert(
  infra.includes('sagemaker.CfnModel') &&
    !infra.includes('CfnEndpoint(') &&
    !infra.includes('CfnEndpointConfig'),
  'CDK creates a model for Batch Transform and no persistent endpoint resource',
);
assert(
  infra.includes("'sagemaker:CreateTransformJob'") &&
    !infra.includes("'sagemaker:CreateEndpoint'") &&
    !infra.includes("'sagemaker:UpdateEndpoint'"),
  'orchestrator IAM is limited to Batch Transform and endpoint observation',
);
assert(
  infra.includes('DeadLetterQueue') &&
    infra.includes('ApplicationSpendStop') &&
    infra.includes('ActiveJobsAboveConfiguredLimit'),
  'DLQ, spend-stop, and active-job alarms are declared',
);
assert(
  infraTest.includes("resourceCountIs('AWS::SageMaker::Endpoint', 0)") &&
    infraTest.includes("resourceCountIs('AWS::SageMaker::EndpointConfig', 0)"),
  'synth tests pin zero persistent SageMaker endpoint resources',
);

const defenseApiFiles = walk(path('apps', 'defense-api', 'src'));
const forbiddenImports = defenseApiFiles.filter((file) => {
  const source = readFileSync(file, 'utf8');
  return source.includes('defense-parser-orchestrator') ||
    source.includes('AwsCliSageMakerBatchTransformAdapter') ||
    source.includes('NvidiaBatchCoordinator');
});
assert(
  forbiddenImports.length === 0,
  `public defense-api has no parser-orchestrator import (${forbiddenImports.map((file) => relative(root, file)).join(', ')})`,
);

const deterministicParserFiles = walk(
  path('apps', 'defense-budget-parser', 'src'),
).filter((file) => file.endsWith('.py'));
const deterministicAwsImports = deterministicParserFiles.filter((file) => {
  const source = readFileSync(file, 'utf8');
  return /^\s*(?:from|import)\s+(?:boto3|botocore|sagemaker)/m.test(source);
});
assert(
  deterministicAwsImports.length === 0,
  'deterministic Python parser remains AWS-free',
);
assert(
  readme.includes('not') && readme.includes('public `defense-api`'),
  'orchestrator ownership boundary is documented',
);

const manifestStrata = new Set(
  Array.isArray(manifest.requiredStrata)
    ? manifest.requiredStrata.map((entry) => entry.id)
    : [],
);
for (const stratum of REQUIRED_BENCHMARK_STRATA) {
  assert(manifestStrata.has(stratum), `live benchmark manifest includes ${stratum}`);
}
assert(
  manifest.executionModel === 'sagemaker_batch_transform' &&
    manifest.persistentEndpointAllowed === false &&
    manifest.productionDefaultChangeAllowed === false,
  'live manifest freezes Batch Transform, no endpoint, and no production default change',
);
assert(
  Array.isArray(manifest.providersToCompare) &&
    manifest.providersToCompare.includes('deterministic_current') &&
    manifest.providersToCompare.includes('nemotron_parse') &&
    manifest.providersToCompare.includes('nvidia_page_elements_table_structure') &&
    manifest.providersToCompare.includes('nvidia_ocr_when_applicable'),
  'live manifest compares current and all applicable NVIDIA routes',
);
assert(
  tests.includes('wrong identity or money safety regresses') &&
    tests.includes('zero-idle proof') &&
    tests.includes('hard monthly budget'),
  'regressions pin safety, zero-idle, and application budget behavior',
);

if (enforceLive) {
  const evidencePath = process.env.PHASE8_SESSION5_LIVE_BENCHMARK_EVIDENCE ||
    path('docs', 'defense-budget', 'phase8-session5-live-benchmark-evidence.json');
  assert(existsSync(evidencePath), `live NVIDIA evidence exists at ${evidencePath}`);
  if (existsSync(evidencePath)) {
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    const result = evidence.benchmarkResult;
    assert(
      evidence.schemaVersion === 'phase8_session5_live_benchmark_evidence_v1',
      'live evidence schema is versioned',
    );
    assert(result?.liveBenchmarkAccepted === true, 'source-grounded live benchmark is accepted');
    assert(
      Array.isArray(result?.missingStrata) && result.missingStrata.length === 0,
      'live benchmark covers every required stratum',
    );
    assert(result?.nvidiaObservationCount > 0, 'live benchmark contains real NVIDIA observations');
    assert(
      Array.isArray(result?.acceptedPageClasses) && result.acceptedPageClasses.length > 0,
      'at least one page class materially benefits from a safe NVIDIA route',
    );
    const withoutHash = { ...result };
    delete withoutHash.contentSha256;
    assert(
      result?.contentSha256 === sha256Hex(withoutHash),
      'live benchmark result content hash is valid',
    );
    assert(
      evidence.zeroIdleProof?.activeJobs === 0 &&
        Array.isArray(evidence.zeroIdleProof?.persistentEndpoints) &&
        evidence.zeroIdleProof.persistentEndpoints.length === 0 &&
        evidence.zeroIdleProof.zeroIdleGpu === true,
      'live evidence proves zero active jobs and zero persistent endpoints after drain',
    );
    assert(
      evidence.productionDefaultChanged === false,
      'Session 5 live evidence confirms no production default route changed',
    );
  }
} else {
  assert(
    manifest.status === 'provider_ready_live_run_required' &&
      Array.isArray(manifest.blockedBy) && manifest.blockedBy.length > 0,
    'ordinary verification remains honest that live provider evidence is not bundled',
  );
}

for (const pass of passes) console.log(`[phase8-session5] PASS: ${pass}`);
if (failures.length > 0) {
  console.error(`\n[phase8-session5] FAILED (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(
  enforceLive
    ? '[phase8-session5] SESSION5_LIVE_BENCHMARK_PASS'
    : '[phase8-session5] SESSION5_PROVIDER_READY_PASS',
);
