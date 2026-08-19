import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASYNC_RUNTIME_CONTRACT_VERSION,
  AsyncNvidiaCoordinator,
  SafeAwsCliSageMakerAsyncInferenceAdapter,
  buildAsyncEndpointIdentity,
  buildAsyncInferenceId,
  buildAsyncInvocation,
  computeMaximumEndpointReservationUsd,
  assertPinnedModelDataSourceRequiresAsync,
  loadRealAsyncConfig,
  validateAsyncExecutionConfig,
} from '../src/real-async.mjs';
import { canonicalJson, sha256Hex, Session5RefusalError } from '../src/session5.mjs';

const H = (c) => c.repeat(64);
const SOURCE = H('a');
const OPTIONS = H('b');
const IMAGE = H('c');
const PAYLOAD = H('d');
const RENDER = H('e');
const MODEL_ARN = 'arn:aws:sagemaker:us-east-1:865070037744:model-package/nvidia-nemotron-parse-6673990e627d314f8aceb69f5e816587';
const MODEL_VERSION = 'LLM NIM 1.14 and VLM NIM version 1.5.0';

function config(extra = {}) {
  return loadRealAsyncConfig({
    NVIDIA_PARSING_ENABLED: 'true',
    NVIDIA_ROUTING_MODE: 'benchmark',
    NVIDIA_BENCHMARK_ACCEPTED: 'false',
    NVIDIA_ASYNC_LIVE_RUN_AUTHORIZED: 'true',
    NVIDIA_MAX_CONCURRENT_GPU_JOBS: '1',
    NVIDIA_HARD_INCREMENTAL_CAP_USD: '150',
    NVIDIA_INITIAL_BENCHMARK_CAP_USD: '50',
    NVIDIA_MODEL_NAME: 'nemotron-parse',
    NVIDIA_MODEL_VERSION: MODEL_VERSION,
    NVIDIA_MODEL_PACKAGE_ARN: MODEL_ARN,
    NVIDIA_SAGEMAKER_MODEL_NAME: 'capiro-model',
    NVIDIA_ASYNC_EXECUTION_ROLE_ARN: 'arn:aws:iam::967807252336:role/session5',
    NVIDIA_INSTANCE_TYPE: 'ml.g5.xlarge',
    NVIDIA_INSTANCE_USD_PER_HOUR: '1',
    NVIDIA_MARKETPLACE_USD_PER_HOST_HOUR: '1',
    NVIDIA_MAX_ENDPOINT_LIFETIME_SECONDS: '1800',
    NVIDIA_INPUT_BUCKET: 'input',
    NVIDIA_OUTPUT_BUCKET: 'output',
    NVIDIA_INPUT_PREFIX: 'phase8/nvidia/async/input',
    NVIDIA_OUTPUT_PREFIX: 'phase8/nvidia/async/output',
    NVIDIA_ASYNC_FAILURE_PREFIX: 'phase8/nvidia/async/failure',
    NVIDIA_ASYNC_NORMALIZED_PREFIX: 'phase8/nvidia/async/normalized',
    NVIDIA_COMPLETION_QUEUE_URL: 'completion',
    NVIDIA_DLQ_URL: 'dlq',
    NVIDIA_RESERVATION_LEDGER_TABLE: 'ledger',
    ...extra,
  });
}

function page(pageNumber = 1) {
  const payload = { model: 'nvidia/nemotron-parse', messages: [{ role: 'user', content: [] }], tools: [{ type: 'function', function: { name: 'markdown_bbox' } }], temperature: 0 };
  return {
    pageNumber,
    pageClass: 'complex_table',
    sourceSha256: SOURCE,
    parserMethod: 'nemotron_parse',
    requestedParserMethod: 'table_structure',
    modelName: 'nemotron-parse',
    modelVersion: MODEL_VERSION,
    parserOptionsHash: OPTIONS,
    renderedImageSha256: IMAGE,
    providerPayloadSha256: sha256Hex(canonicalJson(payload)),
    renderingConfigSha256: RENDER,
    cacheKey: 'nvp2_' + H('f').slice(0, 64),
    providerPayload: payload,
  };
}

test('pinned ModelDataSource package is rejected by Batch and allowed only through async mode', () => {
  assert.equal(assertPinnedModelDataSourceRequiresAsync({ executionModel: 'sagemaker_async_inference', modelDataSource: true }).valid, true);
  assert.throws(() => assertPinnedModelDataSourceRequiresAsync({ executionModel: 'sagemaker_batch_transform', modelDataSource: true }), (e) => e.code === 'MODELDATASOURCE_BATCH_UNSUPPORTED');
});

test('exact package async config is bounded and never permits Batch execution', () => {
  const c = config();
  assert.equal(c.executionMode, 'sagemaker_async_inference');
  assert.equal(c.maxConcurrentGpuJobs, 1);
  assert.equal(c.maxEndpointLifetimeSeconds, 1800);
  assert.equal(validateAsyncExecutionConfig(c).valid, true);
  assert.throws(() => validateAsyncExecutionConfig({ ...c, executionMode: 'sagemaker_batch_transform' }), (e) => e.code === 'ASYNC_MODE_REQUIRED');
  assert.throws(() => validateAsyncExecutionConfig({ ...c, maxConcurrentGpuJobs: 2 }), (e) => e.code === 'UNAUTHORIZED_CONCURRENCY');
  assert.throws(() => validateAsyncExecutionConfig({ ...c, maxEndpointLifetimeSeconds: 0 }), (e) => e.code === 'ENDPOINT_LIFETIME_REQUIRED');
});

test('async config rejects under-reserving rates and submission rejects disabled parsing', async () => {
  assert.throws(
    () => config({ NVIDIA_MARKETPLACE_USD_PER_HOST_HOUR: '0.000001' }),
    (e) => e.code === 'RATE_FLOOR_REQUIRED',
  );
  const disabled = loadRealAsyncConfig({ ...configEnv(), NVIDIA_PARSING_ENABLED: 'false' });
  const coordinator = new AsyncNvidiaCoordinator({}, disabled);
  await assert.rejects(
    () => coordinator.submit({ corpusSha256: SOURCE, pages: Array.from({ length: 10 }, (_, i) => page(i + 1)) }),
    (e) => e.code === 'ASYNC_PARSING_DISABLED',
  );
});

test('endpoint and inference identities are deterministic and bounded', () => {
  const identity = buildAsyncEndpointIdentity({ corpusSha256: SOURCE, modelPackageArn: MODEL_ARN, modelVersion: MODEL_VERSION, runtimeContractVersion: ASYNC_RUNTIME_CONTRACT_VERSION });
  assert.match(identity.endpointName, /^capiro-s5-async-/);
  assert.match(identity.endpointConfigName, /^capiro-s5-async-cfg-/);
  assert.ok(identity.endpointName.length <= 63);
  assert.deepEqual(identity, buildAsyncEndpointIdentity({ corpusSha256: SOURCE, modelPackageArn: MODEL_ARN, modelVersion: MODEL_VERSION, runtimeContractVersion: ASYNC_RUNTIME_CONTRACT_VERSION }));
  const id = buildAsyncInferenceId({ endpointName: identity.endpointName, page: page(), attempt: 1 });
  assert.match(id, /^s5-/);
  assert.equal(id, buildAsyncInferenceId({ endpointName: identity.endpointName, page: page(), attempt: 1 }));
});

test('async invocation preserves exact provider payload and provenance sidecar separately', () => {
  const identity = buildAsyncEndpointIdentity({ corpusSha256: SOURCE, modelPackageArn: MODEL_ARN, modelVersion: MODEL_VERSION, runtimeContractVersion: ASYNC_RUNTIME_CONTRACT_VERSION });
  const invocation = buildAsyncInvocation({ endpointName: identity.endpointName, endpointConfigName: identity.endpointConfigName, page: page(), attempt: 1, inputLocation: 's3://input/phase8/nvidia/async/input/request.json' });
  assert.equal(invocation.contentType, 'application/json');
  assert.equal(invocation.accept, 'application/json');
  assert.equal(invocation.inferenceId, buildAsyncInferenceId({ endpointName: identity.endpointName, page: page(), attempt: 1 }));
  assert.deepEqual(invocation.payload, page().providerPayload);
  assert.equal(invocation.provenance.sourceSha256, SOURCE);
  assert.equal(invocation.provenance.pageNumber, 1);
  assert.equal(invocation.executionModel, 'sagemaker_async_inference');
});

test('endpoint reservation is wall-clock bounded and remains above the initial cap when needed', () => {
  const c = config({ NVIDIA_MAX_ENDPOINT_LIFETIME_SECONDS: '1800' });
  assert.equal(computeMaximumEndpointReservationUsd(c), 1);
});

test('AWS async adapter never exposes CreateTransformJob and configures scale-to-zero at max one', async () => {
  const calls = [];
  const runner = { async invoke(service, command, input) { calls.push({ service, command, input }); if (command === 'describe-endpoint' || command === 'describe-endpoint-config') throw new Error('ValidationException: not found'); return command === 'create-endpoint' ? { EndpointArn: 'arn:endpoint' } : {}; } };
  const adapter = new SafeAwsCliSageMakerAsyncInferenceAdapter(runner);
  const c = config();
  const identity = buildAsyncEndpointIdentity({ corpusSha256: SOURCE, modelPackageArn: MODEL_ARN, modelVersion: MODEL_VERSION, runtimeContractVersion: ASYNC_RUNTIME_CONTRACT_VERSION });
  await adapter.ensureEndpoint({ ...identity, modelName: 'capiro-model', instanceType: c.instanceType, outputLocation: 's3://output/phase8/nvidia/async/output/', failureLocation: 's3://output/phase8/nvidia/async/failure/', executionRoleArn: 'arn:role', kmsKeyId: 'arn:kms' });
  await adapter.configureScaleToZero(identity.endpointName);
  assert.equal(calls.some((x) => x.command === 'create-transform-job'), false);
  assert.equal(calls.find((x) => x.command === 'register-scalable-target').input.MinCapacity, 0);
  assert.equal(calls.find((x) => x.command === 'register-scalable-target').input.MaxCapacity, 1);
});

test('async coordinator refuses live creation without explicit run authorization', async () => {
  const c = loadRealAsyncConfig({ ...configEnv(), NVIDIA_ASYNC_LIVE_RUN_AUTHORIZED: 'false' });
  const coordinator = new AsyncNvidiaCoordinator({}, c);
  await assert.rejects(() => coordinator.submit({ corpusSha256: SOURCE, pages: [page()] }), (e) => e.code === 'LIVE_RUN_AUTHORIZATION_REQUIRED');
});

test('async submit discovers and drains an orphaned endpoint before reserving new capacity', async () => {
  const c = loadRealAsyncConfig({ ...configEnv(), NVIDIA_ASYNC_LIVE_RUN_AUTHORIZED: 'true' });
  const identity = buildAsyncEndpointIdentity({ corpusSha256: SOURCE, modelPackageArn: MODEL_ARN, modelVersion: MODEL_VERSION, runtimeContractVersion: ASYNC_RUNTIME_CONTRACT_VERSION, modelName: c.sagemakerModelName, executionRoleArn: c.executionRoleArn, instanceType: c.instanceType, outputBucket: c.outputBucket, outputPrefix: c.outputPrefix, failureBucket: c.outputBucket, failurePrefix: c.failurePrefix, kmsKeyId: c.kmsKeyId });
  let reserved = false;
  const jobs = new Map();
  let endpointPresent = true;
  const coordinator = new AsyncNvidiaCoordinator({
    jobStore: { async get(id) { return jobs.get(id) ?? null; }, async put(job) { jobs.set(job.jobId, job); } },
    reservationLedger: { async reserve() { reserved = true; }, async snapshot() { return { activeJobs: 0, spentAndReservedUsd: 0 }; } },
    endpointClient: {
      async describeEndpoint(name) { return endpointPresent && name === identity.endpointName ? { EndpointStatus: 'InService', CreationTime: '2026-08-19T00:00:00Z' } : null; },
      async describeEndpointConfig() { return null; },
      async deleteEndpoint() { endpointPresent = false; },
      async deregisterScaleToZero() {},
      async listPersistentEndpoints() { return []; },
    },
  }, c);
  const draining = await coordinator.submit({ corpusSha256: SOURCE, pages: Array.from({ length: 10 }, (_, i) => page(i + 1)) });
  assert.equal(draining.status, 'ENDPOINT_DRAINING');
  const deleted = await coordinator.reconcile(identity.endpointName);
  assert.equal(deleted.status, 'ENDPOINT_DELETED');
  const result = await coordinator.reconcile(identity.endpointName);
  assert.equal(result.status, 'COMPLETE');
  assert.equal(reserved, false);
  assert.equal(jobs.get(identity.endpointName).status, 'COMPLETE');
});

test('async output location is matched exactly and unrelated objects do not count', async () => {
  const calls = [];
  const adapter = new SafeAwsCliSageMakerAsyncInferenceAdapter({
    async invoke(service, command, input) {
      calls.push({ service, command, input });
      return { Contents: [
        { Key: 'phase8/nvidia/async/output/s5-id.out' },
        { Key: 'phase8/nvidia/async/output/s5-id.out.bak' },
      ] };
    },
  });
  const output = await adapter.listAsyncOutput(
    { outputBucket: 'output', outputPrefix: 'phase8/nvidia/async/output' },
    's5-id',
  );
  assert.deepEqual(output, { bucket: 'output', key: 'phase8/nvidia/async/output/s5-id.out' });
  assert.equal(calls.length, 1);
});

 test('async output duplicate exact objects fail closed', async () => {
  const adapter = new SafeAwsCliSageMakerAsyncInferenceAdapter({
    async invoke() {
      return { Contents: [
        { Key: 'phase8/nvidia/async/output/s5-id.out' },
        { Key: 'phase8/nvidia/async/output/s5-id.out' },
      ] };
    },
  });
  await assert.rejects(
    () => adapter.listAsyncOutput({ outputBucket: 'output', outputPrefix: 'phase8/nvidia/async/output' }, 's5-id'),
    (e) => e.code === 'ASYNC_OUTPUT_DUPLICATE',
  );
});

test('async output location outside the configured inference key fails closed', async () => {
  const adapter = new SafeAwsCliSageMakerAsyncInferenceAdapter({ async invoke() { return { Contents: [] }; } });
  await assert.rejects(
    () => adapter.listAsyncOutput({ outputBucket: 'output', outputPrefix: 'phase8/nvidia/async/output' }, 's5-id', 's3://output/phase8/nvidia/async/output/other.out'),
    (e) => e.code === 'ASYNC_OUTPUT_LOCATION_MISMATCH',
  );
});

 test('existing endpoint config must match model and async mode before reuse', async () => {
  const adapter = new SafeAwsCliSageMakerAsyncInferenceAdapter({
    async invoke(service, command) {
      if (command === 'describe-endpoint') throw new Error('ValidationException: not found');
      if (command === 'describe-endpoint-config') return { ProductionVariants: [{ ModelName: 'wrong', InstanceType: 'ml.g5.xlarge' }] };
      throw new Error('unexpected mutation');
    },
  });
  const identity = buildAsyncEndpointIdentity({ corpusSha256: SOURCE, modelPackageArn: MODEL_ARN, modelVersion: MODEL_VERSION, runtimeContractVersion: ASYNC_RUNTIME_CONTRACT_VERSION });
  await assert.rejects(
    () => adapter.ensureEndpoint({ ...identity, modelName: 'capiro-model', instanceType: 'ml.g5.xlarge', outputLocation: 's3://output/out/' }),
    (e) => e.code === 'ENDPOINT_CONFIG_IDENTITY_MISMATCH',
  );
});

 test('endpoint create failure enters teardown rather than leaving a reserved endpoint state', async () => {
  const c = loadRealAsyncConfig({ ...configEnv(), NVIDIA_ASYNC_LIVE_RUN_AUTHORIZED: 'true' });
  const ledger = { async reserve() {}, async settle() {}, async release() {}, async snapshot() { return { activeJobs: 0, spentAndReservedUsd: 0 }; } };
  const jobs = new Map();
  const endpointClient = {
    async describeEndpoint() { return null; },
    async ensureEndpoint() { throw new Error('create failed'); },
    async deregisterScaleToZero() {},
    async describeEndpointConfig() { return null; },
    async listPersistentEndpoints() { return []; },
  };
  const coordinator = new AsyncNvidiaCoordinator({ jobStore: { async get(id) { return jobs.get(id) ?? null; }, async put(job) { jobs.set(job.jobId, job); } }, reservationLedger: ledger, endpointClient }, c);
  const endpoint = buildAsyncEndpointIdentity({ corpusSha256: SOURCE, modelPackageArn: MODEL_ARN, modelVersion: MODEL_VERSION, runtimeContractVersion: ASYNC_RUNTIME_CONTRACT_VERSION });
  jobs.set(endpoint.endpointName, { jobId: endpoint.endpointName, status: 'CAPACITY_RESERVED', endpoint, reservationId: 'r', createdAt: '2026-08-19T00:00:00Z', updatedAt: '2026-08-19T00:00:00Z', history: [] });
  const result = await coordinator.reconcile(endpoint.endpointName);
  assert.equal(result.status, 'ENDPOINT_DELETED');
});

test('reconcile promotes an externally-created InService endpoint before submitting work', async () => {
 const c = config();
 const endpoint = buildAsyncEndpointIdentity({ corpusSha256: SOURCE, modelPackageArn: MODEL_ARN, modelVersion: MODEL_VERSION, runtimeContractVersion: ASYNC_RUNTIME_CONTRACT_VERSION, modelName: c.sagemakerModelName, executionRoleArn: c.executionRoleArn, instanceType: c.instanceType, outputBucket: c.outputBucket, outputPrefix: c.outputPrefix, failureBucket: c.outputBucket, failurePrefix: c.failurePrefix, kmsKeyId: c.kmsKeyId });
 const jobs = new Map([[endpoint.endpointName, { jobId: endpoint.endpointName, status: 'CAPACITY_RESERVED', endpoint, reservationId: 'r', corpusSha256: SOURCE, pages: [], attempt: 1, createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z', history: [] }]]);
 let ensured = false;
 const coordinator = new AsyncNvidiaCoordinator({
   jobStore: { async get(id) { return jobs.get(id) ?? null; }, async put(job) { jobs.set(job.jobId, job); } },
   reservationLedger: { async settle() {}, async release() {}, async snapshot() { return { activeJobs: 1, spentAndReservedUsd: 1 }; } },
   endpointClient: { async describeEndpoint() { return { EndpointStatus: 'InService', CreationTime: '2026-08-19T00:00:00.000Z' }; }, async ensureEndpoint() { ensured = true; }, async configureScaleToZero() {}, async listPersistentEndpoints() { return []; } },
 }, c);
 const result = await coordinator.reconcile(endpoint.endpointName);
 assert.equal(ensured, false);
 assert.equal(result.status, 'REQUESTS_RECONCILING');
});

test('reservation is released when the first durable job write fails', async () => {
 const c = config(); let reserved = 0; let released = 0;
 const coordinator = new AsyncNvidiaCoordinator({
   jobStore: { async get() { return null; }, async put() { throw new Error('state store unavailable'); } },
   reservationLedger: { async reserve() { reserved += 1; }, async release() { released += 1; } },
   endpointClient: { async describeEndpoint() { return null; }, async describeEndpointConfig() { return null; } },
 }, c);
 await assert.rejects(() => coordinator.submit({ corpusSha256: SOURCE, pages: Array.from({ length: 10 }, (_, i) => page(i + 1)) }), /state store unavailable/);
 assert.equal(reserved, 1); assert.equal(released, 1);
});

function configEnv() {
  return {
    NVIDIA_PARSING_ENABLED: 'true', NVIDIA_ROUTING_MODE: 'benchmark', NVIDIA_BENCHMARK_ACCEPTED: 'false',
    NVIDIA_MAX_CONCURRENT_GPU_JOBS: '1', NVIDIA_HARD_INCREMENTAL_CAP_USD: '150', NVIDIA_INITIAL_BENCHMARK_CAP_USD: '50',
    NVIDIA_MODEL_NAME: 'nemotron-parse', NVIDIA_MODEL_VERSION: MODEL_VERSION, NVIDIA_MODEL_PACKAGE_ARN: MODEL_ARN,
    NVIDIA_SAGEMAKER_MODEL_NAME: 'capiro-model', NVIDIA_ASYNC_EXECUTION_ROLE_ARN: 'arn:aws:iam::967807252336:role/session5',
    NVIDIA_INSTANCE_TYPE: 'ml.g5.xlarge', NVIDIA_INSTANCE_USD_PER_HOUR: '1', NVIDIA_MARKETPLACE_USD_PER_HOST_HOUR: '1',
    NVIDIA_MAX_ENDPOINT_LIFETIME_SECONDS: '1800', NVIDIA_INPUT_BUCKET: 'input', NVIDIA_OUTPUT_BUCKET: 'output',
    NVIDIA_COMPLETION_QUEUE_URL: 'completion', NVIDIA_DLQ_URL: 'dlq', NVIDIA_RESERVATION_LEDGER_TABLE: 'ledger',
  };
}

void Session5RefusalError;
