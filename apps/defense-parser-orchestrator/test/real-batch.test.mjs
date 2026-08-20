import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RealNvidiaBatchCoordinator,
  buildLivePageCacheKey,
  buildLivePageIdentity,
  buildProviderManifest,
  deterministicTransformJobName,
  loadRealBatchConfig,
  normalizeProviderOutputJsonLines,
  validateLiveBenchmarkCorpus,
  verifyNormalizedPageArtifact,
} from '../src/real-batch.mjs';
import {
  canonicalJson,
  sha256Hex,
  Session5RefusalError,
} from '../src/session5.mjs';

const H = (ch) => ch.repeat(64);
const SOURCE = H('a');
const OPTIONS = H('b');
const IMAGE = H('c');
const PAYLOAD = H('d');
const RENDER = H('e');
const MODEL_VERSION = 'LLM-NIM-1.14_VLM-NIM-1.5.0';

function enabledEnv(extra = {}) {
  return {
    NVIDIA_PARSING_ENABLED: 'true',
    NVIDIA_ROUTING_MODE: 'benchmark',
    NVIDIA_BENCHMARK_ACCEPTED: 'false',
    NVIDIA_MAX_CONCURRENT_GPU_JOBS: '1',
    NVIDIA_HARD_INCREMENTAL_CAP_USD: '150',
    NVIDIA_INITIAL_BENCHMARK_CAP_USD: '50',
    NVIDIA_MODEL_NAME: 'nemotron-parse',
    NVIDIA_MODEL_VERSION: MODEL_VERSION,
    NVIDIA_SAGEMAKER_MODEL_NAME: 'capiro-s5-model',
    NVIDIA_INPUT_BUCKET: 'input',
    NVIDIA_OUTPUT_BUCKET: 'output',
    NVIDIA_COMPLETION_QUEUE_URL: 'https://sqs/completion.fifo',
    NVIDIA_DLQ_URL: 'https://sqs/dlq.fifo',
    NVIDIA_RESERVATION_LEDGER_TABLE: 'ledger',
    NVIDIA_INSTANCE_USD_PER_HOUR: '1.5',
    NVIDIA_MARKETPLACE_USD_PER_HOST_HOUR: '1',
    NVIDIA_MAX_JOB_SECONDS: '1800',
    ...extra,
  };
}

function page(n = 1) {
  const providerPayload = {
    model: 'nvidia/nemotron-parse',
    temperature: 0,
    tools: [
      { type: 'function', function: { name: 'markdown_bbox' } },
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,AA==' },
          },
        ],
      },
    ],
  };
  return {
    pageNumber: n,
    nativeTableExtractionFailed: true,
    escalationApproved: true,
    critical: true,
    renderedImage: { sha256: IMAGE },
    providerPayload,
    providerPayloadSha256: sha256Hex(canonicalJson(providerPayload)),
    renderingConfigSha256: RENDER,
  };
}

function request() {
  return {
    sourceDocumentId: 'doc-1',
    sourceSha256: SOURCE,
    parserOptionsHash: OPTIONS,
    modelName: 'nemotron-parse',
    modelVersion: MODEL_VERSION,
    pages: [page(1)],
  };
}

function providerLine(text = 'hello') {
  return JSON.stringify({
    choices: [
      {
        message: {
          tool_calls: [
            {
              function: {
                name: 'markdown_bbox',
                arguments: JSON.stringify([
                  {
                    text,
                    type: 'text',
                    bbox: {
                      xmin: 0.1,
                      ymin: 0.2,
                      xmax: 0.9,
                      ymax: 0.8,
                    },
                  },
                ]),
              },
            },
          ],
        },
      },
    ],
  });
}

function memoryPorts() {
  const jobs = new Map();
  const defs = new Map();
  const caches = new Map();
  const manifests = new Map();
  const completions = [];
  const dlq = [];
  const metrics = [];
  const ledger = {
    activeJobs: 0,
    spentAndReservedUsd: 0,
    settledSpendUsd: 0,
    reservations: new Map(),
  };
  const descriptions = new Map();
  const ensureCalls = [];
  const stops = [];
  const activeProvider = [];
  const endpoints = [];
  let completionFailures = 0;
  let dlqFailures = 0;
  return {
    state: {
      jobs,
      defs,
      caches,
      manifests,
      completions,
      dlq,
      metrics,
      ledger,
      descriptions,
      ensureCalls,
      stops,
      activeProvider,
      endpoints,
      setCompletionFailures(n) {
        completionFailures = n;
      },
      setDlqFailures(n) {
        dlqFailures = n;
      },
    },
    ports: {
      artifactStore: {
        async putBatchDefinition(b) {
          const old = defs.get(b.batchId);
          if (old && canonicalJson(old) !== canonicalJson(b)) {
            throw new Error('conflict');
          }
          defs.set(b.batchId, b);
          return b;
        },
        async getBatchDefinition(id) {
          return defs.get(id) ?? null;
        },
        async getCachedArtifact(k) {
          return caches.get(k) ?? null;
        },
        async putManifestBundle({ batch, body, bodySha256, sidecar }) {
          const m = {
            bucket: 'in',
            key: `${batch.batchId}.jsonl`,
            s3Uri: `s3://in/${batch.batchId}.jsonl`,
            body,
            bodySha256,
            sidecar,
          };
          manifests.set(batch.batchId, m);
          return m;
        },
        async readManifestSidecar(m) {
          return m.sidecar;
        },
        async readRawProviderOutput() {
          return providerLine();
        },
        async putVerifiedArtifact(v) {
          caches.set(v.cacheKey, v.artifact);
          return v;
        },
      },
      jobStore: {
        async put(j) {
          jobs.set(j.jobId, j);
          return j;
        },
        async get(id) {
          return jobs.get(id) ?? null;
        },
        async listReconcileCandidates() {
          return [...jobs.values()].filter(
            (j) =>
              !['RESUME_PUBLISHED', 'DLQ'].includes(j.status) ||
              j.dlqPublishPending,
          );
        },
      },
      reservationLedger: {
        async reserve(i) {
          if (ledger.reservations.has(i.reservationId)) {
            return { idempotent: true };
          }
          if (
            ledger.activeJobs >= i.maxConcurrent ||
            ledger.spentAndReservedUsd + i.reservedCostUsd > i.effectiveCapUsd
          ) {
            throw new Session5RefusalError(
              'RESERVATION_REFUSED',
              'cap',
            );
          }
          ledger.reservations.set(i.reservationId, {
            ...i,
            status: 'ACTIVE',
          });
          ledger.activeJobs += 1;
          ledger.spentAndReservedUsd += i.reservedCostUsd;
          return { idempotent: false };
        },
        async settle(i) {
          const r = ledger.reservations.get(i.reservationId);
          if (r.status === 'SETTLED') return { idempotent: true };
          ledger.activeJobs -= 1;
          ledger.spentAndReservedUsd +=
            i.reconciledCostUsd - r.reservedCostUsd;
          ledger.settledSpendUsd += i.reconciledCostUsd;
          r.status = 'SETTLED';
          return { idempotent: false };
        },
        async release(i) {
          const r = ledger.reservations.get(i.reservationId);
          if (!r || r.status === 'RELEASED') return { idempotent: true };
          ledger.activeJobs -= 1;
          ledger.spentAndReservedUsd -= r.reservedCostUsd;
          r.status = 'RELEASED';
          return { idempotent: false };
        },
        async snapshot() {
          return {
            activeJobs: ledger.activeJobs,
            spentAndReservedUsd: ledger.spentAndReservedUsd,
            settledSpendUsd: ledger.settledSpendUsd,
          };
        },
      },
      batchClient: {
        async ensureTransformJob({ transformJobName, manifest }) {
          ensureCalls.push(transformJobName);
          descriptions.set(transformJobName, {
            TransformJobName: transformJobName,
            TransformJobArn: `arn:${transformJobName}`,
            TransformJobStatus: 'InProgress',
            CreationTime: '2026-08-19T00:00:00Z',
            TransformStartTime: '2026-08-19T00:00:00Z',
            TransformResources: {
              InstanceCount: 1,
              InstanceType: 'ml.g5.xlarge',
            },
          });
          return {
            transformJobName,
            manifestKey: manifest.key,
            outputBucket: 'out',
            outputPrefix: 'raw',
            submittedAt: '2026-08-19T00:00:00Z',
          };
        },
        async confirmTransformJobAbsent() {
          return false;
        },
        async describeTransformJob(n) {
          return descriptions.get(n);
        },
        async stopTransformJob(n) {
          stops.push(n);
        },
        async resolveOutputObject() {
          return { bucket: 'out', key: 'result.out' };
        },
        async listActiveTransformJobs() {
          return [...activeProvider];
        },
        async listPersistentEndpoints() {
          return [...endpoints];
        },
      },
      completionQueue: {
        async publish(m) {
          if (completionFailures-- > 0) throw new Error('completion down');
          completions.push(m);
        },
      },
      dlq: {
        async publish(m) {
          if (dlqFailures-- > 0) throw new Error('dlq down');
          dlq.push(m);
        },
      },
      metrics: {
        async put(name, value, dimensions) {
          metrics.push({ name, value, dimensions });
        },
      },
    },
  };
}

test('authorization defaults enforce USD 50 initial cap and never permit more than USD 150', () => {
  const c = loadRealBatchConfig(enabledEnv());
  assert.equal(c.effectiveSpendCapUsd, 50);
  assert.equal(c.hardIncrementalCapUsd, 150);
  assert.equal(c.maxConcurrentGpuJobs, 1);
  const extended = loadRealBatchConfig(
    enabledEnv({ NVIDIA_EXTENDED_BUDGET_AUTHORIZED: 'true' }),
  );
  assert.equal(extended.effectiveSpendCapUsd, 150);
  assert.throws(
    () =>
      loadRealBatchConfig(
        enabledEnv({ NVIDIA_HARD_INCREMENTAL_CAP_USD: '151' }),
      ),
    (e) => e.code === 'UNAUTHORIZED_SPEND_CAP',
  );
  assert.throws(
    () =>
      loadRealBatchConfig(
        enabledEnv({ NVIDIA_MAX_CONCURRENT_GPU_JOBS: '2' }),
      ),
    (e) => e.code === 'UNAUTHORIZED_CONCURRENCY',
  );
});

test('v2 cache identity binds rendered image, provider payload, rendering config and pinned parser identity', () => {
  const base = {
    sourceSha256: SOURCE,
    pageNumber: 1,
    parserMethod: 'nemotron_parse',
    modelName: 'nemotron-parse',
    modelVersion: MODEL_VERSION,
    parserOptionsHash: OPTIONS,
    renderedImageSha256: IMAGE,
    providerPayloadSha256: PAYLOAD,
    renderingConfigSha256: RENDER,
  };
  const a = buildLivePageCacheKey(base);
  assert.notEqual(
    a,
    buildLivePageCacheKey({ ...base, renderedImageSha256: H('f') }),
  );
  assert.notEqual(
    a,
    buildLivePageCacheKey({ ...base, providerPayloadSha256: H('1') }),
  );
  assert.notEqual(
    a,
    buildLivePageCacheKey({ ...base, renderingConfigSha256: H('2') }),
  );
});

test('real provider JSONL is normalized with internal sidecar provenance rather than requiring invented provider fields', () => {
  const providerPayload = { model: 'nvidia/nemotron-parse' };
  const payloadHash = sha256Hex(canonicalJson(providerPayload));
  const identity = buildLivePageIdentity({
    sourceSha256: SOURCE,
    pageNumber: 1,
    parserMethod: 'nemotron_parse',
    modelName: 'nemotron-parse',
    modelVersion: MODEL_VERSION,
    parserOptionsHash: OPTIONS,
    renderedImageSha256: IMAGE,
    providerPayloadSha256: payloadHash,
    renderingConfigSha256: RENDER,
  });
  const batch = {
    batchId: 'batch',
    sourceDocumentId: 'doc',
    sourceSha256: SOURCE,
    parserMethod: 'nemotron_parse',
    modelName: 'nemotron-parse',
    modelVersion: MODEL_VERSION,
    parserOptionsHash: OPTIONS,
    pages: [
      {
        ...identity,
        pageClass: 'identity_banner',
        cacheKey: buildLivePageCacheKey(identity),
        providerPayload,
        escalationReason: 'test',
      },
    ],
  };
  const manifest = buildProviderManifest(batch);
  const out = normalizeProviderOutputJsonLines({
    rawOutputText: `${providerLine('PE text')}\n`,
    sidecar: manifest.sidecar,
    providerRunIdentity: { transformJobName: 'job' },
  });
  assert.equal(out.pages.length, 1);
  assert.equal(out.pages[0].sourceSha256, SOURCE);
  assert.equal(out.pages[0].text, 'PE text');
  assert.equal(verifyNormalizedPageArtifact(out.pages[0], identity), out.pages[0]);
});

test('live acceptance refuses corpus with missing or unaccepted source-grounded gold', () => {
  assert.throws(
    () =>
      validateLiveBenchmarkCorpus({
        schemaVersion: 'phase8_session5_benchmark_corpus_v1',
        entries: [],
      }),
    (e) => e.code === 'LIVE_CORPUS_NOT_ACCEPTABLE',
  );
  const strata = [
    'r1_zero_native_tables',
    'r2_identity_banner',
    'r2a_project_cost_table',
    'scanned_image_only',
    'navy_ba6_duplicate_flattening',
    'p1_table',
    'o1_op5_table',
    'defense_wide_volume',
  ];
  const entries = strata.map((stratum, i) => ({
    id: `e${i}`,
    stratum,
    gold: {
      reviewStatus: 'accepted',
      sourceEvidenceSha256: H(String((i % 9) + 1)),
      incomplete: false,
      conflicted: false,
    },
  }));
  assert.equal(
    validateLiveBenchmarkCorpus({
      schemaVersion: 'phase8_session5_benchmark_corpus_v1',
      entries,
    }).acceptedEntries,
    8,
  );
  entries[3].gold.incomplete = true;
  assert.throws(
    () =>
      validateLiveBenchmarkCorpus({
        schemaVersion: 'phase8_session5_benchmark_corpus_v1',
        entries,
      }),
    (e) => e.code === 'LIVE_CORPUS_NOT_ACCEPTABLE',
  );
});

test('submit uses deterministic attempt identity, atomic reservation and recovers a pre-submission crash without double reservation', async () => {
  const x = memoryPorts();
  const config = loadRealBatchConfig(
    enabledEnv({ NVIDIA_MAX_JOB_SECONDS: '60', NVIDIA_INSTANCE_USD_PER_HOUR: '1' }),
  );
  const c = new RealNvidiaBatchCoordinator(
    x.ports,
    config,
    () => '2026-08-19T00:00:00Z',
  );
  const plan = await c.plan(request());
  const [job] = await c.submit(plan);
  assert.equal(job.status, 'SUBMITTED');
  assert.equal(x.state.ledger.activeJobs, 1);
  assert.equal(x.state.ensureCalls.length, 1);
  assert.equal(
    job.providerRun.transformJobName,
    deterministicTransformJobName(job.batchId, 1),
  );
  const [again] = await c.submit(plan);
  assert.equal(again.status, 'RUNNING');
  assert.equal(x.state.ledger.activeJobs, 1);
  assert.equal(x.state.ensureCalls.length, 1);
});

test('reconcile derives cost from SageMaker timestamps, settles reservation and publishes durable completion', async () => {
  const x = memoryPorts();
  const config = loadRealBatchConfig(
    enabledEnv({
      NVIDIA_MAX_JOB_SECONDS: '3600',
      NVIDIA_INSTANCE_USD_PER_HOUR: '1',
    }),
  );
  const c = new RealNvidiaBatchCoordinator(
    x.ports,
    config,
    () => '2026-08-19T00:10:00Z',
  );
  const [submitted] = await c.submit(await c.plan(request()));
  x.state.descriptions.set(submitted.providerRun.transformJobName, {
    TransformJobName: submitted.providerRun.transformJobName,
    TransformJobArn: 'arn:job',
    TransformJobStatus: 'Completed',
    CreationTime: '2026-08-19T00:00:00Z',
    TransformStartTime: '2026-08-19T00:00:00Z',
    TransformEndTime: '2026-08-19T00:10:00Z',
    TransformResources: { InstanceCount: 1, InstanceType: 'ml.g5.xlarge' },
  });
  const done = await c.reconcileJob(submitted.jobId);
  assert.equal(done.status, 'RESUME_PUBLISHED');
  assert.equal(x.state.ledger.activeJobs, 0);
  assert.equal(x.state.completions.length, 1);
  assert.equal(done.reconciledCostUsd, Number(((600 / 3600) * 2).toFixed(6)));
  assert.equal(
    x.state.metrics.some((m) => m.name === 'NvidiaActiveGpuJobs'),
    true,
  );
  assert.equal(
    x.state.metrics.some((m) => m.name === 'NvidiaMonthlySpendUsd'),
    true,
  );
});

test('completion publication failure remains reconcilable and never strands verified work', async () => {
  const x = memoryPorts();
  x.state.setCompletionFailures(1);
  const config = loadRealBatchConfig(
    enabledEnv({
      NVIDIA_MAX_JOB_SECONDS: '3600',
      NVIDIA_INSTANCE_USD_PER_HOUR: '1',
    }),
  );
  const c = new RealNvidiaBatchCoordinator(
    x.ports,
    config,
    () => '2026-08-19T00:10:00Z',
  );
  const [submitted] = await c.submit(await c.plan(request()));
  x.state.descriptions.set(submitted.providerRun.transformJobName, {
    TransformJobName: submitted.providerRun.transformJobName,
    TransformJobStatus: 'Completed',
    TransformStartTime: '2026-08-19T00:00:00Z',
    TransformEndTime: '2026-08-19T00:10:00Z',
    TransformResources: { InstanceCount: 1 },
  });
  const pending = await c.reconcileJob(submitted.jobId);
  assert.equal(pending.status, 'COMPLETION_PENDING');
  assert.equal(pending.completionPublishAttempts, 1);
  const done = await c.reconcileJob(submitted.jobId);
  assert.equal(done.status, 'RESUME_PUBLISHED');
  assert.equal(x.state.completions.length, 1);
});

test('DLQ publication failure is persisted and retried by reconciliation', async () => {
  const x = memoryPorts();
  x.state.setDlqFailures(1);
  const config = loadRealBatchConfig(
    enabledEnv({
      NVIDIA_MAX_JOB_SECONDS: '3600',
      NVIDIA_INSTANCE_USD_PER_HOUR: '1',
    }),
  );
  const c = new RealNvidiaBatchCoordinator(
    x.ports,
    config,
    () => '2026-08-19T00:10:00Z',
  );
  const [submitted] = await c.submit(await c.plan(request()));
  x.state.descriptions.set(submitted.providerRun.transformJobName, {
    TransformJobName: submitted.providerRun.transformJobName,
    TransformJobStatus: 'Failed',
    TransformStartTime: '2026-08-19T00:00:00Z',
    TransformEndTime: '2026-08-19T00:01:00Z',
    TransformResources: { InstanceCount: 1 },
    FailureReason: 'bad',
  });
  const pending = await c.reconcileJob(submitted.jobId);
  assert.equal(pending.dlqPublishPending, true);
  assert.equal(x.state.jobs.get(submitted.jobId).dlqPublishPending, true);
  const done = await c.reconcileJob(submitted.jobId);
  assert.equal(done.status, 'DLQ');
  assert.equal(x.state.dlq.length, 1);
});

test('zero-idle proof requires both atomic ledger and direct provider observations to be zero', async () => {
  const x = memoryPorts();
  const c = new RealNvidiaBatchCoordinator(
    x.ports,
    loadRealBatchConfig(enabledEnv({ NVIDIA_INSTANCE_USD_PER_HOUR: '1' })),
  );
  assert.equal((await c.zeroIdleProof()).zeroIdleGpu, true);
  x.state.activeProvider.push({ TransformJobName: 'external-drift' });
  assert.equal((await c.zeroIdleProof()).zeroIdleGpu, false);
});

test('timeout watchdog requests stop but does not release spend reservation until provider reaches terminal Stopped', async () => {
  const x = memoryPorts();
  const config = loadRealBatchConfig(
    enabledEnv({ NVIDIA_MAX_JOB_SECONDS: '60', NVIDIA_INSTANCE_USD_PER_HOUR: '1' }),
  );
  const c = new RealNvidiaBatchCoordinator(
    x.ports,
    config,
    () => '2026-08-19T00:02:00Z',
  );
  const [submitted] = await c.submit(await c.plan(request()));
  x.state.descriptions.set(submitted.providerRun.transformJobName, {
    TransformJobName: submitted.providerRun.transformJobName,
    TransformJobStatus: 'InProgress',
    CreationTime: '2026-08-19T00:00:00Z',
    TransformStartTime: '2026-08-19T00:00:00Z',
    TransformResources: { InstanceCount: 1 },
  });
  const stopping = await c.reconcileJob(submitted.jobId);
  assert.equal(stopping.providerStatus, 'Stopping');
  assert.equal(x.state.stops.length, 1);
  assert.equal(
    x.state.ledger.activeJobs,
    1,
    'reservation must remain active while stop is not terminal',
  );
  x.state.descriptions.set(submitted.providerRun.transformJobName, {
    TransformJobName: submitted.providerRun.transformJobName,
    TransformJobStatus: 'Stopped',
    CreationTime: '2026-08-19T00:00:00Z',
    TransformStartTime: '2026-08-19T00:00:00Z',
    TransformEndTime: '2026-08-19T00:02:10Z',
    TransformResources: { InstanceCount: 1 },
  });
  const terminal = await c.reconcileJob(submitted.jobId);
  assert.equal(terminal.status, 'DLQ');
  assert.equal(x.state.ledger.activeJobs, 0);
});

test('reconciliation recovers a crash from PLANNED before reservation/submission', async () => {
  const x = memoryPorts();
  const config = loadRealBatchConfig(
    enabledEnv({ NVIDIA_MAX_JOB_SECONDS: '60', NVIDIA_INSTANCE_USD_PER_HOUR: '1' }),
  );
  const c = new RealNvidiaBatchCoordinator(
    x.ports,
    config,
    () => '2026-08-19T00:00:00Z',
  );
  const plan = await c.plan(request());
  const batch = plan.batches[0];
  await x.ports.artifactStore.putBatchDefinition(batch);
  await x.ports.jobStore.put({
    schemaVersion: 'phase8_session5_real_batch_job_v2',
    jobId: batch.batchId,
    batchId: batch.batchId,
    status: 'PLANNED',
    attempt: 1,
    sourceDocumentId: batch.sourceDocumentId,
    sourceSha256: batch.sourceSha256,
    parserMethod: batch.parserMethod,
    modelName: batch.modelName,
    modelVersion: batch.modelVersion,
    parserOptionsHash: batch.parserOptionsHash,
    pages: batch.pages.map((p) => p.pageNumber),
    createdAt: '2026-08-19T00:00:00Z',
    updatedAt: '2026-08-19T00:00:00Z',
    history: [],
  });
  const [recovered] = await c.submit(plan);
  assert.equal(recovered.status, 'SUBMITTED');
  assert.equal(x.state.ledger.activeJobs, 1);
  assert.equal(x.state.ensureCalls.length, 1);
});

test('provider manifest refuses oversized provider records before Batch submission', () => {
  const oversized = page();
  oversized.providerPayload = {
    ...oversized.providerPayload,
    oversized: 'x'.repeat(5_500_001),
  };
  oversized.providerPayloadSha256 = sha256Hex(canonicalJson(oversized.providerPayload));
  assert.throws(
    () => buildProviderManifest({
      batchId: 'b1',
      sourceDocumentId: 'doc-1',
      sourceSha256: SOURCE,
      parserMethod: 'nemotron_parse',
      modelName: 'nemotron-parse',
      modelVersion: MODEL_VERSION,
      parserOptionsHash: OPTIONS,
      pages: [oversized],
    }),
    (error) => error.code === 'PROVIDER_PAYLOAD_TOO_LARGE',
  );
});

test('manifest contract refusal releases the atomic reservation instead of stranding paid capacity', async () => {
  const x = memoryPorts();
  const config = loadRealBatchConfig(
    enabledEnv({ NVIDIA_INSTANCE_USD_PER_HOUR: '1' }),
  );
  const c = new RealNvidiaBatchCoordinator(x.ports, config, () => '2026-08-19T00:00:00Z');
  const plan = await c.plan(request());
  const brokenPlan = {
    ...plan,
    batches: plan.batches.map((batch) => ({
      ...batch,
      pages: batch.pages.map((page) => ({ ...page, providerPayload: null })),
    })),
  };
  const [failed] = await c.submit(brokenPlan);
  assert.equal(failed.status, 'DLQ');
  assert.equal(x.state.ledger.activeJobs, 0);
  assert.equal(x.state.ledger.spentAndReservedUsd, 0);
});
