import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NvidiaBatchCoordinator,
  Session5RefusalError,
  buildInputManifest,
  buildPageCacheKey,
  buildParserOptionsHash,
  createTestPorts,
  evaluateBenchmark,
  loadSession5Config,
  routePage,
  sha256Hex,
} from '../src/session5.mjs';

const SOURCE_SHA = 'a'.repeat(64);
const MODEL_VERSION = 'nv-nemotron-parse-1.2.0';
const OPTIONS_HASH = buildParserOptionsHash({ table: true, ocr: false });

function config(overrides = {}) {
  return {
    enabled: true,
    routingMode: 'benchmark',
    benchmarkAccepted: false,
    maxConcurrentGpuJobs: 1,
    maxPagesPerJob: 8,
    monthlyGpuBudgetUsd: 100,
    projectedGpuSecondsPerPage: 2,
    projectedUsdPerGpuSecond: 0.01,
    modelName: 'nemotron-parse',
    modelVersion: MODEL_VERSION,
    transformModelName: 'capiro-nemotron-parse-benchmark',
    transformRoleArn: 'arn:aws:iam::111111111111:role/capiro-nvidia-benchmark',
    inputBucket: 'capiro-test-input',
    outputBucket: 'capiro-test-output',
    inputPrefix: 'input',
    outputPrefix: 'output',
    completionQueueUrl: 'https://sqs.test/completion.fifo',
    dlqUrl: 'https://sqs.test/dlq.fifo',
    instanceType: 'ml.g5.xlarge',
    region: 'us-east-1',
    ...overrides,
  };
}

function complexPage(pageNumber = 1) {
  return {
    pageNumber,
    expectedTableCount: 1,
    nativeTableCount: 0,
    nativeTableExtractionFailed: true,
    deterministicPassed: false,
    escalationApproved: true,
    critical: true,
  };
}

function request(pages = [complexPage(1)]) {
  return {
    sourceDocumentId: 'source-fy27-r2a',
    sourceSha256: SOURCE_SHA,
    source: { bucket: 'raw', key: 'fy27/r2a.pdf', versionId: 'v1' },
    modelName: 'nemotron-parse',
    modelVersion: MODEL_VERSION,
    parserOptionsHash: OPTIONS_HASH,
    pages,
  };
}

test('configuration defaults to disabled benchmark mode and refuses preferred routing without evidence', () => {
  const loaded = loadSession5Config({});
  assert.equal(loaded.enabled, false);
  assert.equal(loaded.routingMode, 'benchmark');
  assert.equal(loaded.maxConcurrentGpuJobs, 1);
  assert.throws(
    () => loadSession5Config({ NVIDIA_ROUTING_MODE: 'preferred' }),
    (error) => error instanceof Session5RefusalError && error.code === 'BENCHMARK_REQUIRED',
  );
});

test('cache key binds source, page, method, model version, options and contract', () => {
  const first = buildPageCacheKey({
    sourceSha256: SOURCE_SHA,
    pageNumber: 7,
    parserMethod: 'nemotron_parse',
    modelName: 'nemotron-parse',
    modelVersion: MODEL_VERSION,
    parserOptionsHash: OPTIONS_HASH,
  });
  const same = buildPageCacheKey({
    sourceSha256: SOURCE_SHA,
    pageNumber: 7,
    parserMethod: 'nemotron_parse',
    modelName: 'nemotron-parse',
    modelVersion: MODEL_VERSION,
    parserOptionsHash: OPTIONS_HASH,
  });
  const changed = buildPageCacheKey({
    sourceSha256: SOURCE_SHA,
    pageNumber: 8,
    parserMethod: 'nemotron_parse',
    modelName: 'nemotron-parse',
    modelVersion: MODEL_VERSION,
    parserOptionsHash: OPTIONS_HASH,
  });
  assert.equal(first, same);
  assert.notEqual(first, changed);
  assert.match(first, /^nvp1_[0-9a-f]{64}$/);
});

test('routing keeps clean vector pages deterministic and escalates only governed difficult pages', () => {
  assert.deepEqual(
    routePage({
      pageNumber: 1,
      deterministicPassed: true,
      embeddedTextRatio: 0.98,
      nativeTableCount: 1,
    }),
    {
      pageClass: 'clean_vector_text',
      decision: 'DETERMINISTIC_PRIMARY',
      parserMethod: null,
      reason: 'deterministic_parser_proven_sufficient',
    },
  );

  const table = routePage(complexPage(2));
  assert.equal(table.pageClass, 'complex_table');
  assert.equal(table.decision, 'NVIDIA_FALLBACK');
  assert.equal(table.parserMethod, 'nvidia_page_elements_table_structure');

  const unapproved = routePage({ ...complexPage(3), escalationApproved: false });
  assert.equal(unapproved.decision, 'MANUAL_REVIEW');
  assert.equal(unapproved.parserMethod, null);
});

test('failed or low-confidence NVIDIA output goes to review and never fabricates fallback content', () => {
  assert.equal(
    routePage({ ...complexPage(1), nvidiaAttempted: true, nvidiaSucceeded: false }).decision,
    'MANUAL_REVIEW',
  );
  assert.equal(
    routePage({
      ...complexPage(1),
      nvidiaAttempted: true,
      nvidiaSucceeded: true,
      nvidiaConfidence: 0.4,
    }).decision,
    'MANUAL_REVIEW',
  );
});

test('planning deduplicates immutable cached pages and emits deterministic JSONL', async () => {
  const { ports, state } = createTestPorts();
  const cachedKey = buildPageCacheKey({
    sourceSha256: SOURCE_SHA,
    pageNumber: 1,
    parserMethod: 'nvidia_page_elements_table_structure',
    modelName: 'nemotron-parse',
    modelVersion: MODEL_VERSION,
    parserOptionsHash: OPTIONS_HASH,
  });
  state.artifacts.set(cachedKey, { s3Uri: 's3://cache/page1.json' });
  const coordinator = new NvidiaBatchCoordinator(ports, config(), () => '2026-08-18T20:00:00.000Z');
  const plan = await coordinator.plan(request([complexPage(1), complexPage(2)]));
  assert.equal(plan.cached.length, 1);
  assert.equal(plan.batches.length, 1);
  assert.deepEqual(plan.batches[0].pages.map((page) => page.pageNumber), [2]);
  const manifest = buildInputManifest(plan.batches[0]);
  assert.equal(manifest.split('\n').filter(Boolean).length, 1);
  assert.equal(JSON.parse(manifest.trim()).cacheKey, plan.batches[0].pages[0].cacheKey);
});

test('submission enforces concurrency and hard monthly budget before starting GPU work', async () => {
  const { ports } = createTestPorts();
  const coordinator = new NvidiaBatchCoordinator(ports, config({ monthlyGpuBudgetUsd: 0 }));
  const plan = await coordinator.plan(request());
  await assert.rejects(
    () => coordinator.submit(plan),
    (error) => error instanceof Session5RefusalError && error.code === 'BUDGET_LIMIT',
  );

  const active = createTestPorts();
  active.state.jobs.set('existing', {
    jobId: 'existing',
    status: 'RUNNING',
    actualCostUsd: 0,
  });
  const limited = new NvidiaBatchCoordinator(active.ports, config());
  const secondPlan = await limited.plan(request());
  await assert.rejects(
    () => limited.submit(secondPlan),
    (error) => error instanceof Session5RefusalError && error.code === 'CONCURRENCY_LIMIT',
  );
});

test('verified completion persists per-page cache artifacts and resumes Phase 2 exactly once', async () => {
  const { ports, state } = createTestPorts();
  const clockValues = [
    '2026-08-18T20:00:00.000Z',
    '2026-08-18T20:00:01.000Z',
    '2026-08-18T20:00:02.000Z',
    '2026-08-18T20:00:03.000Z',
    '2026-08-18T20:00:04.000Z',
    '2026-08-18T20:00:05.000Z',
    '2026-08-18T20:00:06.000Z',
    '2026-08-18T20:00:07.000Z',
    '2026-08-18T20:00:08.000Z',
    '2026-08-18T20:00:09.000Z',
  ];
  const coordinator = new NvidiaBatchCoordinator(
    ports,
    config(),
    () => clockValues.shift() ?? '2026-08-18T20:00:10.000Z',
  );
  const plan = await coordinator.plan(request());
  const [job] = await coordinator.submit(plan);
  assert.equal(job.status, 'SUBMITTED');

  const artifactWithoutHash = {
    schemaVersion: 'nvidia_parser_artifact_v1',
    sourceSha256: SOURCE_SHA,
    parserMethod: job.parserMethod,
    modelName: job.modelName,
    modelVersion: job.modelVersion,
    parserOptionsHash: job.parserOptionsHash,
    providerRunIdentity: 'sagemaker:transform:test-job',
    pages: [
      {
        pageNumber: 1,
        text: 'R-2A project table',
        markdown: '| Project | FY27 |',
        blocks: [],
        tables: [],
        confidence: '0.99',
        evidencePrecision: 'cell_bbox',
        warnings: [],
      },
    ],
  };
  const artifact = { ...artifactWithoutHash, contentSha256: sha256Hex(artifactWithoutHash) };
  const completed = await coordinator.handleProviderEvent({
    jobId: job.jobId,
    status: 'Completed',
    body: artifact,
    output: { body: artifact },
    actualCostUsd: 0.25,
    gpuSeconds: 20,
  });
  assert.equal(completed.status, 'RESUME_PUBLISHED');
  assert.equal(state.artifacts.size, 1);
  assert.equal(state.completionMessages.length, 1);
  assert.equal(state.dlqMessages.length, 0);
});

test('artifact identity or hash mismatch is DLQed without publishing completion', async () => {
  const { ports, state } = createTestPorts();
  const coordinator = new NvidiaBatchCoordinator(ports, config());
  const [job] = await coordinator.submit(await coordinator.plan(request()));
  const result = await coordinator.handleProviderEvent({
    jobId: job.jobId,
    status: 'Completed',
    output: {
      body: {
        sourceSha256: SOURCE_SHA,
        parserMethod: job.parserMethod,
        modelName: job.modelName,
        modelVersion: 'wrong-version',
        parserOptionsHash: job.parserOptionsHash,
        providerRunIdentity: 'bad',
        pages: [{ pageNumber: 1 }],
        contentSha256: 'b'.repeat(64),
      },
    },
  });
  assert.equal(result.status, 'DLQ');
  assert.equal(state.completionMessages.length, 0);
  assert.equal(state.dlqMessages.length, 1);
});

test('zero-idle proof requires no active jobs and no persistent NVIDIA endpoint', async () => {
  const idle = createTestPorts();
  const coordinator = new NvidiaBatchCoordinator(idle.ports, config());
  assert.equal((await coordinator.zeroIdleProof()).zeroIdleGpu, true);
  idle.state.persistentEndpoints.push({ EndpointName: 'forbidden' });
  assert.equal((await coordinator.zeroIdleProof()).zeroIdleGpu, false);
});

function benchmarkCorpus({ includeNvidia = true, unsafeNvidia = false } = {}) {
  const entries = [
    ['r1_zero_native_tables', 'complex_table'],
    ['r2_identity_banner', 'identity_banner'],
    ['r2a_project_cost_table', 'complex_table'],
    ['scanned_image_only', 'scanned_image'],
    ['navy_ba6_duplicate_flattening', 'complex_table'],
    ['p1_table', 'complex_table'],
    ['o1_op5_table', 'complex_table'],
    ['defense_wide_volume', 'mixed_visual_layout'],
  ].map(([stratum, pageClass], index) => ({
    id: `entry-${index + 1}`,
    stratum,
    pageClass,
    sourceSha256: String(index + 1).padStart(64, '0'),
    pageNumber: index + 1,
    gold: {
      peIdentities: ['0600000A'],
      projectIdentities: ['P001'],
      lineIdentities: ['LINE-1'],
      money: [{ value: '10', unit: 'millions', fy: 2027, evidencePage: index + 1 }],
      tableCells: ['Project', 'FY27', '10'],
    },
    observations: {
      deterministic: {
        status: pageClass === 'scanned_image' ? 'failed' : 'succeeded',
        peIdentities: ['0600000A'],
        projectIdentities: pageClass === 'complex_table' ? [] : ['P001'],
        lineIdentities: ['LINE-1'],
        money: pageClass === 'complex_table'
          ? []
          : [{ value: '10', unit: 'millions', fy: 2027, evidencePage: index + 1 }],
        tableCells: pageClass === 'complex_table' ? ['Project'] : ['Project', 'FY27', '10'],
        phase2BlockingOmissions: pageClass === 'complex_table' ? 1 : 0,
        falseIdentityCount: 0,
        evidenceBindingRegressions: 0,
        durationMillis: 100,
        costUsd: 0,
      },
      ...(includeNvidia
        ? {
            nemotron: {
              status: 'succeeded',
              peIdentities: unsafeNvidia ? ['WRONG'] : ['0600000A'],
              projectIdentities: ['P001'],
              lineIdentities: ['LINE-1'],
              money: [{ value: '10', unit: 'millions', fy: 2027, evidencePage: index + 1 }],
              tableCells: ['Project', 'FY27', '10'],
              phase2BlockingOmissions: 0,
              falseIdentityCount: unsafeNvidia ? 1 : 0,
              evidenceBindingRegressions: 0,
              durationMillis: 500,
              gpuSeconds: 5,
              costUsd: 0.01,
            },
          }
        : {}),
    },
  }));
  return {
    schemaVersion: 'phase8_session5_benchmark_corpus_v1',
    runId: 'validation-corpus',
    baselineProviderId: 'deterministic',
    providers: [
      { id: 'deterministic', kind: 'deterministic', modelName: 'pdfplumber', modelVersion: 'pinned' },
      {
        id: 'nemotron',
        kind: 'nvidia',
        modelName: 'nemotron-parse',
        modelVersion: MODEL_VERSION,
        parserOptionsHash: OPTIONS_HASH,
      },
    ],
    entries,
  };
}

test('benchmark makes page-class decisions, never a global provider switch', () => {
  const result = evaluateBenchmark(benchmarkCorpus(), {
    materialImprovementThreshold: 0.05,
    maxCostPerThousandPages: 100,
  });
  assert.equal(result.missingStrata.length, 0);
  assert.equal(result.liveBenchmarkAccepted, true);
  assert.ok(result.acceptedPageClasses.includes('complex_table'));
  assert.ok(Object.keys(result.pageClassDecisions).length > 1);
  assert.notEqual(result.pageClassDecisions.clean_vector_text, 'NVIDIA_PRIMARY');
});

test('benchmark refuses NVIDIA preference when wrong identity or money safety regresses', () => {
  const result = evaluateBenchmark(benchmarkCorpus({ unsafeNvidia: true }), {
    maxCostPerThousandPages: 100,
  });
  assert.equal(result.liveBenchmarkAccepted, false);
  assert.equal(result.acceptedPageClasses.length, 0);
  for (const decision of Object.values(result.pageClassDecisions)) {
    assert.notEqual(decision, 'NVIDIA_PRIMARY');
    assert.notEqual(decision, 'NVIDIA_FALLBACK');
  }
});

test('provider-ready corpus without live NVIDIA observations keeps live acceptance closed', () => {
  const result = evaluateBenchmark(benchmarkCorpus({ includeNvidia: false }));
  assert.equal(result.nvidiaObservationCount, 0);
  assert.equal(result.liveBenchmarkAccepted, false);
});
