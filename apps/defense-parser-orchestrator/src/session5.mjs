import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const SESSION5_SCHEMA_VERSION = 'phase8_session5_v1';
export const ROUTING_MODES = Object.freeze(['benchmark', 'fallback', 'preferred']);
export const ROUTING_DECISIONS = Object.freeze([
  'DETERMINISTIC_PRIMARY',
  'NVIDIA_PRIMARY',
  'NVIDIA_FALLBACK',
  'MANUAL_REVIEW',
]);
export const NVIDIA_METHODS = Object.freeze([
  'nemotron_parse',
  'nvidia_page_elements_table_structure',
  'nvidia_ocr',
]);
export const PAGE_CLASSES = Object.freeze([
  'clean_vector_text',
  'complex_table',
  'scanned_image',
  'mixed_visual_layout',
  'identity_banner',
  'unknown',
]);
export const REQUIRED_BENCHMARK_STRATA = Object.freeze([
  'r1_zero_native_tables',
  'r2_identity_banner',
  'r2a_project_cost_table',
  'scanned_image_only',
  'navy_ba6_duplicate_flattening',
  'p1_table',
  'o1_op5_table',
  'defense_wide_volume',
]);

export class Session5RefusalError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'Session5RefusalError';
    this.code = code;
    this.details = details;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value) {
  const bytes = typeof value === 'string' || Buffer.isBuffer(value)
    ? value
    : canonicalJson(value);
  return createHash('sha256').update(bytes).digest('hex');
}

export function assertSha256(value, fieldName) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Session5RefusalError(
      'INVALID_SHA256',
      `${fieldName} must be a lowercase 64-character SHA-256`,
    );
  }
  return value;
}

export function normalizePages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Session5RefusalError('PAGES_REQUIRED', 'At least one page is required');
  }
  const normalized = [...new Set(pages.map((page) => Number(page)))].sort((a, b) => a - b);
  if (normalized.some((page) => !Number.isInteger(page) || page < 1)) {
    throw new Session5RefusalError('INVALID_PAGE', 'Pages must be positive integers');
  }
  return normalized;
}

export function buildParserOptionsHash(options) {
  return sha256Hex(canonicalJson(options ?? {}));
}

export function buildPageCacheKey(input) {
  assertSha256(input.sourceSha256, 'sourceSha256');
  assertSha256(input.parserOptionsHash, 'parserOptionsHash');
  if (!NVIDIA_METHODS.includes(input.parserMethod)) {
    throw new Session5RefusalError('INVALID_NVIDIA_METHOD', `Unsupported method ${input.parserMethod}`);
  }
  if (!Number.isInteger(input.pageNumber) || input.pageNumber < 1) {
    throw new Session5RefusalError('INVALID_PAGE', 'pageNumber must be a positive integer');
  }
  return `nvp1_${sha256Hex({
    sourceSha256: input.sourceSha256,
    pageNumber: input.pageNumber,
    provider: 'nvidia',
    parserMethod: input.parserMethod,
    modelName: input.modelName,
    modelVersion: input.modelVersion,
    parserOptionsHash: input.parserOptionsHash,
    runtimeContractVersion: input.runtimeContractVersion ?? 'defense_budget_parser_result_v1',
  })}`;
}

export function buildBatchIdentity(input) {
  return `nvb1_${sha256Hex({
    sourceSha256: input.sourceSha256,
    pages: normalizePages(input.pages),
    parserMethod: input.parserMethod,
    modelName: input.modelName,
    modelVersion: input.modelVersion,
    parserOptionsHash: input.parserOptionsHash,
  })}`;
}

function parseBoolean(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Session5RefusalError('INVALID_CONFIG', `Expected true|false, received ${raw}`);
}

function parsePositiveInteger(raw, fallback, name) {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Session5RefusalError('INVALID_CONFIG', `${name} must be a positive integer`);
  }
  return value;
}

function parseNonNegativeNumber(raw, fallback, name) {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Session5RefusalError('INVALID_CONFIG', `${name} must be a non-negative number`);
  }
  return value;
}

export function loadSession5Config(env = process.env) {
  const config = {
    enabled: parseBoolean(env.NVIDIA_PARSING_ENABLED, false),
    routingMode: env.NVIDIA_ROUTING_MODE || 'benchmark',
    benchmarkAccepted: parseBoolean(env.NVIDIA_BENCHMARK_ACCEPTED, false),
    maxConcurrentGpuJobs: parsePositiveInteger(
      env.NVIDIA_MAX_CONCURRENT_GPU_JOBS,
      1,
      'NVIDIA_MAX_CONCURRENT_GPU_JOBS',
    ),
    maxPagesPerJob: parsePositiveInteger(
      env.NVIDIA_MAX_PAGES_PER_JOB,
      32,
      'NVIDIA_MAX_PAGES_PER_JOB',
    ),
    monthlyGpuBudgetUsd: parseNonNegativeNumber(
      env.NVIDIA_MONTHLY_GPU_BUDGET_USD,
      0,
      'NVIDIA_MONTHLY_GPU_BUDGET_USD',
    ),
    projectedGpuSecondsPerPage: parseNonNegativeNumber(
      env.NVIDIA_PROJECTED_GPU_SECONDS_PER_PAGE,
      0,
      'NVIDIA_PROJECTED_GPU_SECONDS_PER_PAGE',
    ),
    projectedUsdPerGpuSecond: parseNonNegativeNumber(
      env.NVIDIA_PROJECTED_USD_PER_GPU_SECOND,
      0,
      'NVIDIA_PROJECTED_USD_PER_GPU_SECOND',
    ),
    modelName: env.NVIDIA_MODEL_NAME || 'nemotron-parse',
    modelVersion: env.NVIDIA_MODEL_VERSION || 'UNPINNED',
    transformModelName: env.NVIDIA_SAGEMAKER_MODEL_NAME || '',
    transformRoleArn: env.NVIDIA_BATCH_TRANSFORM_ROLE_ARN || '',
    inputBucket: env.NVIDIA_INPUT_BUCKET || '',
    outputBucket: env.NVIDIA_OUTPUT_BUCKET || '',
    inputPrefix: env.NVIDIA_INPUT_PREFIX || 'phase8/nvidia/input',
    outputPrefix: env.NVIDIA_OUTPUT_PREFIX || 'phase8/nvidia/output',
    completionQueueUrl: env.NVIDIA_COMPLETION_QUEUE_URL || '',
    dlqUrl: env.NVIDIA_DLQ_URL || '',
    instanceType: env.NVIDIA_INSTANCE_TYPE || 'ml.g5.xlarge',
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1',
  };

  if (!ROUTING_MODES.includes(config.routingMode)) {
    throw new Session5RefusalError(
      'INVALID_CONFIG',
      `NVIDIA_ROUTING_MODE must be one of ${ROUTING_MODES.join(', ')}`,
    );
  }
  if (config.routingMode === 'preferred' && !config.benchmarkAccepted) {
    throw new Session5RefusalError(
      'BENCHMARK_REQUIRED',
      'NVIDIA preferred routing requires accepted source-grounded benchmark evidence',
    );
  }
  if (config.enabled) {
    const required = [
      ['NVIDIA_MODEL_VERSION', config.modelVersion !== 'UNPINNED'],
      ['NVIDIA_SAGEMAKER_MODEL_NAME', Boolean(config.transformModelName)],
      ['NVIDIA_BATCH_TRANSFORM_ROLE_ARN', Boolean(config.transformRoleArn)],
      ['NVIDIA_INPUT_BUCKET', Boolean(config.inputBucket)],
      ['NVIDIA_OUTPUT_BUCKET', Boolean(config.outputBucket)],
      ['NVIDIA_COMPLETION_QUEUE_URL', Boolean(config.completionQueueUrl)],
      ['NVIDIA_DLQ_URL', Boolean(config.dlqUrl)],
    ];
    const missing = required.filter(([, present]) => !present).map(([name]) => name);
    if (missing.length > 0) {
      throw new Session5RefusalError(
        'CONFIG_REQUIRED',
        `NVIDIA parsing is enabled but required configuration is missing: ${missing.join(', ')}`,
      );
    }
  }
  return Object.freeze(config);
}

export function classifyPage(profile) {
  if (profile.scanned === true || Number(profile.imageCoverageRatio ?? 0) >= 0.9) {
    return 'scanned_image';
  }
  if (profile.identityBanner === true) return 'identity_banner';
  if (profile.complexLayout === true) return 'mixed_visual_layout';
  const nativeTableCount = Number(profile.nativeTableCount ?? 0);
  const expectedTableCount = Number(profile.expectedTableCount ?? 0);
  if (
    profile.nativeTableExtractionFailed === true ||
    profile.tableShapeUnstable === true ||
    (expectedTableCount > 0 && nativeTableCount === 0)
  ) {
    return 'complex_table';
  }
  if (
    profile.deterministicPassed === true &&
    Number(profile.embeddedTextRatio ?? 0) >= 0.75 &&
    profile.tableShapeUnstable !== true
  ) {
    return 'clean_vector_text';
  }
  return 'unknown';
}

export function routePage(profile, policy = {}) {
  const pageClass = classifyPage(profile);
  const benchmarkDecision = policy.pageClassDecisions?.[pageClass];
  if (benchmarkDecision && !ROUTING_DECISIONS.includes(benchmarkDecision)) {
    throw new Session5RefusalError(
      'INVALID_BENCHMARK_POLICY',
      `Unsupported benchmark decision ${benchmarkDecision} for ${pageClass}`,
    );
  }

  if (profile.nvidiaAttempted === true && profile.nvidiaSucceeded !== true) {
    return {
      pageClass,
      decision: 'MANUAL_REVIEW',
      parserMethod: null,
      reason: 'nvidia_failed_no_silent_fabrication',
    };
  }
  if (
    profile.nvidiaAttempted === true &&
    profile.critical === true &&
    Number(profile.nvidiaConfidence ?? 0) < Number(policy.criticalConfidenceFloor ?? 0.9)
  ) {
    return {
      pageClass,
      decision: 'MANUAL_REVIEW',
      parserMethod: null,
      reason: 'critical_page_below_governed_confidence_floor',
    };
  }

  if (benchmarkDecision === 'NVIDIA_PRIMARY' && policy.benchmarkAccepted === true) {
    return {
      pageClass,
      decision: 'NVIDIA_PRIMARY',
      parserMethod: methodForPageClass(pageClass),
      reason: 'accepted_page_class_benchmark',
    };
  }

  if (pageClass === 'clean_vector_text') {
    return {
      pageClass,
      decision: 'DETERMINISTIC_PRIMARY',
      parserMethod: null,
      reason: 'deterministic_parser_proven_sufficient',
    };
  }

  if (profile.escalationApproved !== true) {
    return {
      pageClass,
      decision: profile.critical === true ? 'MANUAL_REVIEW' : 'DETERMINISTIC_PRIMARY',
      parserMethod: null,
      reason: 'governed_escalation_not_approved',
    };
  }

  if (['complex_table', 'scanned_image', 'mixed_visual_layout', 'identity_banner'].includes(pageClass)) {
    return {
      pageClass,
      decision: 'NVIDIA_FALLBACK',
      parserMethod: methodForPageClass(pageClass),
      reason: `governed_escalation_${pageClass}`,
    };
  }

  return {
    pageClass,
    decision: profile.critical === true ? 'MANUAL_REVIEW' : 'DETERMINISTIC_PRIMARY',
    parserMethod: null,
    reason: profile.critical === true ? 'unknown_critical_page' : 'no_nvidia_route_proven',
  };
}

function methodForPageClass(pageClass) {
  if (pageClass === 'complex_table') return 'nvidia_page_elements_table_structure';
  if (pageClass === 'scanned_image') return 'nvidia_ocr';
  return 'nemotron_parse';
}

export function buildInputManifest(batch) {
  const records = batch.pages.map((page) => page.providerPayload ?? ({
    schemaVersion: 'nvidia_batch_page_v1',
    batchId: batch.batchId,
    sourceDocumentId: batch.sourceDocumentId,
    sourceSha256: batch.sourceSha256,
    pageNumber: page.pageNumber,
    pageClass: page.pageClass,
    parserMethod: batch.parserMethod,
    modelName: batch.modelName,
    modelVersion: batch.modelVersion,
    parserOptionsHash: batch.parserOptionsHash,
    cacheKey: page.cacheKey,
    source: batch.source,
  }));
  return `${records.map((record) => canonicalJson(record)).join('\n')}\n`;
}

export function groupCompatiblePages(input) {
  const maxPagesPerJob = Number(input.maxPagesPerJob ?? 32);
  if (!Number.isInteger(maxPagesPerJob) || maxPagesPerJob < 1) {
    throw new Session5RefusalError('INVALID_BATCH_SIZE', 'maxPagesPerJob must be positive');
  }
  const groups = new Map();
  for (const page of input.pages) {
    const key = canonicalJson({
      parserMethod: page.parserMethod,
      modelName: input.modelName,
      modelVersion: input.modelVersion,
      parserOptionsHash: input.parserOptionsHash,
    });
    const group = groups.get(key) ?? [];
    group.push(page);
    groups.set(key, group);
  }

  const batches = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.pageNumber - b.pageNumber);
    for (let index = 0; index < group.length; index += maxPagesPerJob) {
      const pages = group.slice(index, index + maxPagesPerJob);
      const parserMethod = pages[0].parserMethod;
      const pageNumbers = pages.map((page) => page.pageNumber);
      const batchId = buildBatchIdentity({
        sourceSha256: input.sourceSha256,
        pages: pageNumbers,
        parserMethod,
        modelName: input.modelName,
        modelVersion: input.modelVersion,
        parserOptionsHash: input.parserOptionsHash,
      });
      batches.push({
        schemaVersion: 'nvidia_batch_manifest_v1',
        batchId,
        sourceDocumentId: input.sourceDocumentId,
        sourceSha256: input.sourceSha256,
        source: input.source,
        parserMethod,
        modelName: input.modelName,
        modelVersion: input.modelVersion,
        parserOptionsHash: input.parserOptionsHash,
        pages,
      });
    }
  }
  return batches.sort((a, b) => a.batchId.localeCompare(b.batchId));
}

export function estimateBatchCostUsd(batch, config) {
  return (
    batch.pages.length *
    Number(config.projectedGpuSecondsPerPage) *
    Number(config.projectedUsdPerGpuSecond)
  );
}

export function assertSubmissionAllowed(input) {
  const { config, activeJobs, monthSpendUsd, projectedCostUsd, pageCount } = input;
  if (!config.enabled) {
    throw new Session5RefusalError('NVIDIA_DISABLED', 'NVIDIA parsing is disabled');
  }
  if (activeJobs >= config.maxConcurrentGpuJobs) {
    throw new Session5RefusalError(
      'CONCURRENCY_LIMIT',
      `Active NVIDIA jobs ${activeJobs} meet configured limit ${config.maxConcurrentGpuJobs}`,
    );
  }
  if (pageCount > config.maxPagesPerJob) {
    throw new Session5RefusalError(
      'PAGE_LIMIT',
      `Batch has ${pageCount} pages; maximum is ${config.maxPagesPerJob}`,
    );
  }
  if (
    config.monthlyGpuBudgetUsd <= 0 ||
    monthSpendUsd + projectedCostUsd > config.monthlyGpuBudgetUsd
  ) {
    throw new Session5RefusalError(
      'BUDGET_LIMIT',
      'Projected NVIDIA spend exceeds the configured hard monthly application budget',
      { monthSpendUsd, projectedCostUsd, monthlyGpuBudgetUsd: config.monthlyGpuBudgetUsd },
    );
  }
}

const JOB_TRANSITIONS = Object.freeze({
  PLANNED: ['MANIFEST_WRITTEN', 'FAILED'],
  MANIFEST_WRITTEN: ['SUBMITTED', 'FAILED'],
  SUBMITTED: ['RUNNING', 'SUCCEEDED', 'FAILED'],
  RUNNING: ['SUCCEEDED', 'FAILED'],
  SUCCEEDED: ['ARTIFACT_VERIFIED', 'DLQ'],
  ARTIFACT_VERIFIED: ['RESUME_PUBLISHED'],
  RESUME_PUBLISHED: [],
  FAILED: ['DLQ'],
  DLQ: [],
});

export function transitionJob(job, nextStatus, at, patch = {}) {
  const allowed = JOB_TRANSITIONS[job.status] ?? [];
  if (!allowed.includes(nextStatus)) {
    throw new Session5RefusalError(
      'INVALID_JOB_TRANSITION',
      `Invalid NVIDIA job transition ${job.status} -> ${nextStatus}`,
    );
  }
  return Object.freeze({
    ...job,
    ...patch,
    status: nextStatus,
    updatedAt: at,
    history: [...job.history, { from: job.status, to: nextStatus, at }],
  });
}

export class NvidiaBatchCoordinator {
  constructor(ports, config, clock = () => new Date().toISOString()) {
    this.ports = ports;
    this.config = config;
    this.clock = clock;
  }

  async plan(request) {
    assertSha256(request.sourceSha256, 'sourceSha256');
    const parserOptionsHash = request.parserOptionsHash ?? buildParserOptionsHash(request.parserOptions);
    assertSha256(parserOptionsHash, 'parserOptionsHash');
    const modelName = request.modelName ?? this.config.modelName;
    const modelVersion = request.modelVersion ?? this.config.modelVersion;
    if (!modelVersion || modelVersion === 'UNPINNED') {
      throw new Session5RefusalError('MODEL_VERSION_REQUIRED', 'NVIDIA modelVersion must be pinned');
    }

    const selected = [];
    const cached = [];
    const decisions = [];
    for (const rawPage of request.pages) {
      const pageNumber = Number(rawPage.pageNumber);
      const route = routePage(rawPage, {
        benchmarkAccepted: this.config.benchmarkAccepted,
        pageClassDecisions: request.pageClassDecisions,
        criticalConfidenceFloor: request.criticalConfidenceFloor,
      });
      decisions.push({ pageNumber, ...route });
      if (!route.parserMethod || !['NVIDIA_PRIMARY', 'NVIDIA_FALLBACK'].includes(route.decision)) {
        continue;
      }
      if (rawPage.escalationApproved !== true) {
        throw new Session5RefusalError(
          'UNGOVERNED_ESCALATION',
          `Page ${pageNumber} was selected for NVIDIA without governed escalation approval`,
        );
      }
      const cacheKey = buildPageCacheKey({
        sourceSha256: request.sourceSha256,
        pageNumber,
        parserMethod: route.parserMethod,
        modelName,
        modelVersion,
        parserOptionsHash,
      });
      const existing = await this.ports.artifactStore.head(cacheKey);
      const page = {
        pageNumber,
        pageClass: route.pageClass,
        parserMethod: route.parserMethod,
        cacheKey,
        escalationReason: route.reason,
        providerPayload: rawPage.providerPayload,
      };
      if (existing) cached.push({ ...page, artifact: existing });
      else selected.push(page);
    }

    const batches = groupCompatiblePages({
      sourceDocumentId: request.sourceDocumentId,
      sourceSha256: request.sourceSha256,
      source: request.source,
      pages: selected,
      modelName,
      modelVersion,
      parserOptionsHash,
      maxPagesPerJob: this.config.maxPagesPerJob,
    });
    return Object.freeze({
      schemaVersion: SESSION5_SCHEMA_VERSION,
      planId: `nvp_${sha256Hex({
        sourceDocumentId: request.sourceDocumentId,
        sourceSha256: request.sourceSha256,
        modelName,
        modelVersion,
        parserOptionsHash,
        decisions,
      })}`,
      sourceDocumentId: request.sourceDocumentId,
      sourceSha256: request.sourceSha256,
      modelName,
      modelVersion,
      parserOptionsHash,
      decisions,
      cached,
      batches,
      createdAt: this.clock(),
    });
  }

  async submit(plan) {
    const submitted = [];
    for (const batch of plan.batches) {
      const activeJobs = await this.ports.jobStore.countActive();
      const monthSpendUsd = await this.ports.jobStore.monthSpendUsd(this.clock());
      const projectedCostUsd = estimateBatchCostUsd(batch, this.config);
      assertSubmissionAllowed({
        config: this.config,
        activeJobs,
        monthSpendUsd,
        projectedCostUsd,
        pageCount: batch.pages.length,
      });

      const now = this.clock();
      let job = {
        schemaVersion: SESSION5_SCHEMA_VERSION,
        jobId: batch.batchId,
        batchId: batch.batchId,
        status: 'PLANNED',
        sourceDocumentId: batch.sourceDocumentId,
        sourceSha256: batch.sourceSha256,
        parserMethod: batch.parserMethod,
        modelName: batch.modelName,
        modelVersion: batch.modelVersion,
        parserOptionsHash: batch.parserOptionsHash,
        pages: batch.pages.map((page) => page.pageNumber),
        projectedCostUsd,
        createdAt: now,
        updatedAt: now,
        history: [],
      };
      await this.ports.jobStore.put(job);

      const manifestBody = buildInputManifest(batch);
      const manifestSha256 = sha256Hex(manifestBody);
      const manifest = await this.ports.artifactStore.putManifest({
        batchId: batch.batchId,
        body: manifestBody,
        sha256: manifestSha256,
      });
      job = transitionJob(job, 'MANIFEST_WRITTEN', this.clock(), {
        manifest,
        manifestSha256,
      });
      await this.ports.jobStore.put(job);

      try {
        const providerRun = await this.ports.batchClient.createTransformJob({
          batch,
          manifest,
          config: this.config,
        });
        job = transitionJob(job, 'SUBMITTED', this.clock(), {
          providerRun,
          submittedAt: this.clock(),
        });
        await this.ports.jobStore.put(job);
        await this.ports.metrics.put('NvidiaBatchSubmitted', 1, {
          parserMethod: batch.parserMethod,
          modelVersion: batch.modelVersion,
        });
        submitted.push(job);
      } catch (error) {
        job = transitionJob(job, 'FAILED', this.clock(), {
          failureCode: 'SUBMISSION_FAILED',
          failureMessage: String(error?.message ?? error),
        });
        await this.ports.jobStore.put(job);
        await this.#sendToDlq(job, 'submission_failed');
      }
    }
    return submitted;
  }

  async handleProviderEvent(event) {
    const job = await this.ports.jobStore.get(event.jobId);
    if (!job) {
      throw new Session5RefusalError('JOB_NOT_FOUND', `NVIDIA job ${event.jobId} not found`);
    }
    if (event.status === 'InProgress' && job.status === 'SUBMITTED') {
      const running = transitionJob(job, 'RUNNING', this.clock(), {
        providerStatus: event.status,
      });
      await this.ports.jobStore.put(running);
      return running;
    }
    if (event.status === 'Failed' || event.status === 'Stopped') {
      let failed = job;
      if (['SUBMITTED', 'RUNNING'].includes(job.status)) {
        failed = transitionJob(job, 'FAILED', this.clock(), {
          providerStatus: event.status,
          failureCode: event.failureCode ?? 'PROVIDER_FAILED',
          failureMessage: event.failureMessage ?? 'NVIDIA provider job failed',
        });
        await this.ports.jobStore.put(failed);
      }
      return this.#sendToDlq(failed, 'provider_failed');
    }
    if (event.status !== 'Completed') {
      throw new Session5RefusalError('UNKNOWN_PROVIDER_STATUS', `Unsupported status ${event.status}`);
    }

    let succeeded = job;
    if (['SUBMITTED', 'RUNNING'].includes(job.status)) {
      succeeded = transitionJob(job, 'SUCCEEDED', this.clock(), {
        providerStatus: event.status,
        completedAt: event.completedAt ?? this.clock(),
        actualCostUsd: Number(event.actualCostUsd ?? 0),
        gpuSeconds: Number(event.gpuSeconds ?? 0),
      });
      await this.ports.jobStore.put(succeeded);
    }

    try {
      const artifact = await this.ports.artifactStore.readProviderOutput(event.output);
      const verified = verifyProviderArtifact(artifact, succeeded);
      for (const page of verified.pages) {
        const expectedPage = succeeded.pages.includes(page.pageNumber);
        if (!expectedPage) {
          throw new Session5RefusalError(
            'UNREQUESTED_PAGE',
            `Provider output contains unrequested page ${page.pageNumber}`,
          );
        }
        const cacheKey = buildPageCacheKey({
          sourceSha256: succeeded.sourceSha256,
          pageNumber: page.pageNumber,
          parserMethod: succeeded.parserMethod,
          modelName: succeeded.modelName,
          modelVersion: succeeded.modelVersion,
          parserOptionsHash: succeeded.parserOptionsHash,
        });
        await this.ports.artifactStore.putVerifiedArtifact({
          cacheKey,
          artifact: page,
          contentSha256: sha256Hex(page),
        });
      }
      let completed = transitionJob(succeeded, 'ARTIFACT_VERIFIED', this.clock(), {
        providerArtifactSha256: verified.contentSha256,
        providerRunIdentity: verified.providerRunIdentity,
      });
      await this.ports.jobStore.put(completed);
      await this.ports.completionQueue.publish({
        schemaVersion: 'nvidia_parser_completion_v1',
        jobId: completed.jobId,
        sourceDocumentId: completed.sourceDocumentId,
        sourceSha256: completed.sourceSha256,
        pages: completed.pages,
        providerArtifactSha256: completed.providerArtifactSha256,
      });
      completed = transitionJob(completed, 'RESUME_PUBLISHED', this.clock());
      await this.ports.jobStore.put(completed);
      await this.ports.metrics.put('NvidiaBatchCompleted', 1, {
        parserMethod: completed.parserMethod,
        modelVersion: completed.modelVersion,
      });
      return completed;
    } catch (error) {
      return this.#sendToDlq(succeeded, 'artifact_verification_failed', error);
    }
  }

  async zeroIdleProof() {
    const activeJobs = await this.ports.jobStore.countActive();
    const persistentEndpoints = await this.ports.batchClient.listPersistentEndpoints();
    return Object.freeze({
      activeJobs,
      persistentEndpoints,
      zeroIdleGpu: activeJobs === 0 && persistentEndpoints.length === 0,
      checkedAt: this.clock(),
    });
  }

  async #sendToDlq(job, reason, error = undefined) {
    const current = await this.ports.jobStore.get(job.jobId) ?? job;
    let failed = current;
    if (current.status === 'SUCCEEDED') {
      failed = transitionJob(current, 'DLQ', this.clock(), {
        failureCode: 'ARTIFACT_VERIFICATION_FAILED',
        failureMessage: String(error?.message ?? error ?? reason),
      });
    } else if (current.status === 'FAILED') {
      failed = transitionJob(current, 'DLQ', this.clock());
    } else if (current.status !== 'DLQ') {
      throw new Session5RefusalError(
        'DLQ_STATE_REFUSAL',
        `Cannot DLQ job ${current.jobId} from ${current.status}`,
      );
    }
    await this.ports.jobStore.put(failed);
    await this.ports.dlq.publish({
      schemaVersion: 'nvidia_parser_dlq_v1',
      jobId: failed.jobId,
      sourceDocumentId: failed.sourceDocumentId,
      sourceSha256: failed.sourceSha256,
      pages: failed.pages,
      reason,
      failureCode: failed.failureCode,
      failureMessage: failed.failureMessage,
    });
    await this.ports.metrics.put('NvidiaBatchDlq', 1, {
      parserMethod: failed.parserMethod,
      reason,
    });
    return failed;
  }
}

export function verifyProviderArtifact(artifact, job) {
  if (!isPlainObject(artifact)) {
    throw new Session5RefusalError('INVALID_ARTIFACT', 'Provider artifact must be an object');
  }
  if (artifact.sourceSha256 !== job.sourceSha256) {
    throw new Session5RefusalError('SOURCE_HASH_MISMATCH', 'Provider artifact source SHA mismatch');
  }
  if (
    artifact.modelName !== job.modelName ||
    artifact.modelVersion !== job.modelVersion ||
    artifact.parserOptionsHash !== job.parserOptionsHash ||
    artifact.parserMethod !== job.parserMethod
  ) {
    throw new Session5RefusalError(
      'PROVIDER_IDENTITY_MISMATCH',
      'Provider artifact does not match pinned model/method/options identity',
    );
  }
  if (!Array.isArray(artifact.pages) || artifact.pages.length === 0) {
    throw new Session5RefusalError('EMPTY_ARTIFACT', 'Provider artifact contains no pages');
  }
  const withoutHash = { ...artifact };
  delete withoutHash.contentSha256;
  const expected = sha256Hex(withoutHash);
  if (artifact.contentSha256 !== expected) {
    throw new Session5RefusalError('ARTIFACT_HASH_MISMATCH', 'Provider artifact hash verification failed');
  }
  return artifact;
}

export class AwsCliRunner {
  constructor(options = {}) {
    this.binary = options.binary ?? 'aws';
    this.region = options.region ?? process.env.AWS_REGION ?? 'us-east-1';
    this.exec = options.exec ?? execFileAsync;
  }

  async invoke(service, operation, input) {
    const directory = await mkdtemp(join(tmpdir(), 'capiro-nvidia-'));
    try {
      const inputPath = join(directory, 'input.json');
      await writeFile(inputPath, JSON.stringify(input), 'utf8');
      const { stdout } = await this.exec(
        this.binary,
        [
          service,
          operation,
          '--region',
          this.region,
          '--cli-input-json',
          `file://${inputPath}`,
          '--output',
          'json',
        ],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      return stdout.trim() ? JSON.parse(stdout) : {};
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export class AwsCliSageMakerBatchTransformAdapter {
  constructor(runner) {
    this.runner = runner;
  }

  async createTransformJob({ batch, manifest, config }) {
    const transformJobName = `${batch.batchId.slice(0, 52)}-${Date.now()}`.slice(0, 63);
    const outputUri = `s3://${config.outputBucket}/${config.outputPrefix}/${batch.batchId}/`;
    await this.runner.invoke('sagemaker', 'create-transform-job', {
      TransformJobName: transformJobName,
      ModelName: config.transformModelName,
      BatchStrategy: 'SingleRecord',
      MaxConcurrentTransforms: 1,
      TransformInput: {
        DataSource: {
          S3DataSource: {
            S3DataType: 'S3Prefix',
            S3Uri: manifest.s3Uri,
          },
        },
        ContentType: 'application/jsonlines',
        SplitType: 'Line',
      },
      TransformOutput: {
        S3OutputPath: outputUri,
        Accept: 'application/jsonlines',
        AssembleWith: 'Line',
      },
      TransformResources: {
        InstanceType: config.instanceType,
        InstanceCount: 1,
      },
      Tags: [
        { Key: 'CapiroPhase', Value: 'phase8-session5' },
        { Key: 'CapiroBatchId', Value: batch.batchId },
        { Key: 'CapiroZeroIdle', Value: 'true' },
      ],
    });
    return { transformJobName, outputUri, executionModel: 'sagemaker_batch_transform' };
  }

  async describeTransformJob(transformJobName) {
    return this.runner.invoke('sagemaker', 'describe-transform-job', {
      TransformJobName: transformJobName,
    });
  }

  async listPersistentEndpoints() {
    // Session 5 never creates or depends on a real-time endpoint. Querying is a
    // proof hook only; the adapter intentionally has no create-endpoint method.
    const response = await this.runner.invoke('sagemaker', 'list-endpoints', {
      NameContains: 'capiro-defense-nvidia',
      MaxResults: 100,
    });
    return response.Endpoints ?? [];
  }
}

export class AwsCliS3ArtifactStore {
  constructor(runner, config) {
    this.runner = runner;
    this.config = config;
  }

  async head(cacheKey) {
    try {
      const key = `${this.config.outputPrefix}/artifacts/${cacheKey}.json`;
      const response = await this.runner.invoke('s3api', 'head-object', {
        Bucket: this.config.outputBucket,
        Key: key,
      });
      return { s3Uri: `s3://${this.config.outputBucket}/${key}`, eTag: response.ETag };
    } catch (error) {
      const message = String(error?.stderr ?? error?.message ?? error);
      if (/404|Not Found|NoSuchKey/i.test(message)) return null;
      throw error;
    }
  }

  async putManifest({ batchId, body, sha256 }) {
    const directory = await mkdtemp(join(tmpdir(), 'capiro-nvidia-manifest-'));
    try {
      const bodyPath = join(directory, `${batchId}.jsonl`);
      await writeFile(bodyPath, body, 'utf8');
      const key = `${this.config.inputPrefix}/${batchId}/${sha256}.jsonl`;
      await this.runner.invoke('s3api', 'put-object', {
        Bucket: this.config.inputBucket,
        Key: key,
        Body: bodyPath,
        ContentType: 'application/jsonlines',
        Metadata: { sha256, immutable: 'true', session: 'phase8-session5' },
      });
      return { s3Uri: `s3://${this.config.inputBucket}/${key}`, sha256, key };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async readProviderOutput(output) {
    if (output.body) return typeof output.body === 'string' ? JSON.parse(output.body) : output.body;
    const directory = await mkdtemp(join(tmpdir(), 'capiro-nvidia-output-'));
    try {
      const path = join(directory, 'output.json');
      await this.runner.invoke('s3api', 'get-object', {
        Bucket: output.bucket,
        Key: output.key,
        ResponseContentType: 'application/json',
        // AWS CLI treats this positional output path specially, so production
        // composition may use an SDK adapter. Tests use the body path above.
      });
      return JSON.parse(await readFile(path, 'utf8'));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async putVerifiedArtifact({ cacheKey, artifact, contentSha256 }) {
    const directory = await mkdtemp(join(tmpdir(), 'capiro-nvidia-artifact-'));
    try {
      const path = join(directory, `${cacheKey}.json`);
      await writeFile(path, canonicalJson(artifact), 'utf8');
      const key = `${this.config.outputPrefix}/artifacts/${cacheKey}.json`;
      await this.runner.invoke('s3api', 'put-object', {
        Bucket: this.config.outputBucket,
        Key: key,
        Body: path,
        ContentType: 'application/json',
        Metadata: { sha256: contentSha256, immutable: 'true', cachekey: cacheKey },
      });
      return { s3Uri: `s3://${this.config.outputBucket}/${key}`, contentSha256 };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export class AwsCliSqsPublisher {
  constructor(runner, queueUrl) {
    this.runner = runner;
    this.queueUrl = queueUrl;
  }

  async publish(message) {
    return this.runner.invoke('sqs', 'send-message', {
      QueueUrl: this.queueUrl,
      MessageBody: canonicalJson(message),
      MessageDeduplicationId: sha256Hex(message),
      MessageGroupId: 'phase8-session5',
    });
  }
}

export class AwsCliCloudWatchMetrics {
  constructor(runner, namespace = 'Capiro/DefenseParser') {
    this.runner = runner;
    this.namespace = namespace;
  }

  async put(metricName, value, dimensions = {}) {
    return this.runner.invoke('cloudwatch', 'put-metric-data', {
      Namespace: this.namespace,
      MetricData: [
        {
          MetricName: metricName,
          Value: value,
          Unit: 'Count',
          Dimensions: Object.entries(dimensions).map(([Name, Value]) => ({ Name, Value: String(Value) })),
        },
      ],
    });
  }
}

function setMetrics(expected, actual) {
  const expectedSet = new Set(expected ?? []);
  const actualSet = new Set(actual ?? []);
  let truePositive = 0;
  for (const value of actualSet) if (expectedSet.has(value)) truePositive += 1;
  const precision = actualSet.size === 0 ? (expectedSet.size === 0 ? 1 : 0) : truePositive / actualSet.size;
  const recall = expectedSet.size === 0 ? 1 : truePositive / expectedSet.size;
  return { precision, recall, falsePositive: actualSet.size - truePositive, missed: expectedSet.size - truePositive };
}

function moneyKey(value) {
  return canonicalJson({
    value: String(value.value),
    unit: value.unit,
    fy: value.fy,
    evidencePage: value.evidencePage,
  });
}

export function scoreObservation(entry, observation) {
  if (!observation || observation.status !== 'succeeded') {
    return {
      status: observation?.status ?? 'not_run',
      peIdentity: { precision: 0, recall: 0, falsePositive: 0, missed: entry.gold.peIdentities?.length ?? 0 },
      projectIdentity: { precision: 0, recall: 0, falsePositive: 0, missed: entry.gold.projectIdentities?.length ?? 0 },
      lineIdentity: { precision: 0, recall: 0, falsePositive: 0, missed: entry.gold.lineIdentities?.length ?? 0 },
      exactMoney: { precision: 0, recall: 0, falsePositive: 0, missed: entry.gold.money?.length ?? 0 },
      tableCell: { precision: 0, recall: 0, falsePositive: 0, missed: entry.gold.tableCells?.length ?? 0 },
      phase2BlockingOmissions: Number(observation?.phase2BlockingOmissions ?? 1),
      falseIdentityCount: Number(observation?.falseIdentityCount ?? 0),
      evidenceBindingRegressions: Number(observation?.evidenceBindingRegressions ?? 0),
      durationMillis: Number(observation?.durationMillis ?? 0),
      gpuSeconds: Number(observation?.gpuSeconds ?? 0),
      costUsd: Number(observation?.costUsd ?? 0),
      errorCount: 1,
    };
  }
  return {
    status: 'succeeded',
    peIdentity: setMetrics(entry.gold.peIdentities, observation.peIdentities),
    projectIdentity: setMetrics(entry.gold.projectIdentities, observation.projectIdentities),
    lineIdentity: setMetrics(entry.gold.lineIdentities, observation.lineIdentities),
    exactMoney: setMetrics(
      (entry.gold.money ?? []).map(moneyKey),
      (observation.money ?? []).map(moneyKey),
    ),
    tableCell: setMetrics(entry.gold.tableCells, observation.tableCells),
    phase2BlockingOmissions: Number(observation.phase2BlockingOmissions ?? 0),
    falseIdentityCount: Number(observation.falseIdentityCount ?? 0),
    evidenceBindingRegressions: Number(observation.evidenceBindingRegressions ?? 0),
    durationMillis: Number(observation.durationMillis ?? 0),
    gpuSeconds: Number(observation.gpuSeconds ?? 0),
    costUsd: Number(observation.costUsd ?? 0),
    errorCount: 0,
  };
}

function average(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function aggregateScores(scored) {
  const succeeded = scored.filter((score) => score.status === 'succeeded');
  return {
    pages: scored.length,
    succeededPages: succeeded.length,
    successRate: scored.length === 0 ? 0 : succeeded.length / scored.length,
    peIdentityPrecision: average(scored.map((score) => score.peIdentity.precision)),
    peIdentityRecall: average(scored.map((score) => score.peIdentity.recall)),
    projectIdentityPrecision: average(scored.map((score) => score.projectIdentity.precision)),
    projectIdentityRecall: average(scored.map((score) => score.projectIdentity.recall)),
    lineIdentityPrecision: average(scored.map((score) => score.lineIdentity.precision)),
    lineIdentityRecall: average(scored.map((score) => score.lineIdentity.recall)),
    exactMoneyPrecision: average(scored.map((score) => score.exactMoney.precision)),
    exactMoneyRecall: average(scored.map((score) => score.exactMoney.recall)),
    tableCellPrecision: average(scored.map((score) => score.tableCell.precision)),
    tableCellRecall: average(scored.map((score) => score.tableCell.recall)),
    phase2BlockingOmissions: scored.reduce((sum, score) => sum + score.phase2BlockingOmissions, 0),
    falseIdentityCount: scored.reduce((sum, score) => sum + score.falseIdentityCount, 0),
    evidenceBindingRegressions: scored.reduce(
      (sum, score) => sum + score.evidenceBindingRegressions,
      0,
    ),
    totalDurationMillis: scored.reduce((sum, score) => sum + score.durationMillis, 0),
    gpuSeconds: scored.reduce((sum, score) => sum + score.gpuSeconds, 0),
    totalCostUsd: scored.reduce((sum, score) => sum + score.costUsd, 0),
    errorRate: scored.length === 0
      ? 0
      : scored.reduce((sum, score) => sum + score.errorCount, 0) / scored.length,
  };
}

function hasSafetyRegression(candidate) {
  return (
    candidate.exactMoneyPrecision < 1 ||
    candidate.falseIdentityCount > 0 ||
    candidate.evidenceBindingRegressions > 0 ||
    candidate.phase2BlockingOmissions > 0
  );
}

function materiallyBetter(candidate, baseline, threshold) {
  const recovery = Math.max(
    candidate.successRate - baseline.successRate,
    candidate.exactMoneyRecall - baseline.exactMoneyRecall,
    candidate.tableCellRecall - baseline.tableCellRecall,
    candidate.peIdentityRecall - baseline.peIdentityRecall,
    candidate.projectIdentityRecall - baseline.projectIdentityRecall,
    candidate.lineIdentityRecall - baseline.lineIdentityRecall,
  );
  return recovery >= threshold;
}

export function evaluateBenchmark(input, options = {}) {
  if (input.schemaVersion !== 'phase8_session5_benchmark_corpus_v1') {
    throw new Session5RefusalError('INVALID_BENCHMARK', 'Unsupported benchmark corpus schema');
  }
  const strata = new Set(input.entries.map((entry) => entry.stratum));
  const missingStrata = REQUIRED_BENCHMARK_STRATA.filter((stratum) => !strata.has(stratum));
  const providers = new Map(input.providers.map((provider) => [provider.id, provider]));
  const baselineId = input.baselineProviderId;
  if (!providers.has(baselineId)) {
    throw new Session5RefusalError('BASELINE_REQUIRED', `Baseline provider ${baselineId} is absent`);
  }
  const threshold = Number(options.materialImprovementThreshold ?? 0.05);
  const maxCostPerThousandPages = Number(options.maxCostPerThousandPages ?? Infinity);
  const byPageClass = {};

  for (const pageClass of PAGE_CLASSES) {
    const entries = input.entries.filter((entry) => entry.pageClass === pageClass);
    if (entries.length === 0) continue;
    const providerScores = {};
    for (const provider of input.providers) {
      providerScores[provider.id] = aggregateScores(
        entries.map((entry) => scoreObservation(entry, entry.observations?.[provider.id])),
      );
    }
    const baseline = providerScores[baselineId];
    const nvidiaProviders = input.providers.filter((provider) => provider.kind === 'nvidia');
    const acceptedCandidates = [];
    for (const provider of nvidiaProviders) {
      const score = providerScores[provider.id];
      const pinned = Boolean(provider.modelName && provider.modelVersion && provider.parserOptionsHash);
      const costPerThousandPages = score.succeededPages === 0
        ? Infinity
        : (score.totalCostUsd / score.succeededPages) * 1000;
      const safe = !hasSafetyRegression(score);
      const improved = materiallyBetter(score, baseline, threshold);
      const costAccepted = costPerThousandPages <= maxCostPerThousandPages;
      if (pinned && safe && improved && costAccepted) {
        acceptedCandidates.push({ provider, score, costPerThousandPages });
      }
    }
    acceptedCandidates.sort((a, b) => {
      const aRecovery = a.score.exactMoneyRecall + a.score.tableCellRecall + a.score.successRate;
      const bRecovery = b.score.exactMoneyRecall + b.score.tableCellRecall + b.score.successRate;
      return bRecovery - aRecovery || a.costPerThousandPages - b.costPerThousandPages;
    });
    const winner = acceptedCandidates[0];
    let decision = 'DETERMINISTIC_PRIMARY';
    let selectedProviderId = baselineId;
    let reason = 'nvidia_not_better_or_not_safe';
    if (winner) {
      decision = baseline.successRate < 0.5 ? 'NVIDIA_PRIMARY' : 'NVIDIA_FALLBACK';
      selectedProviderId = winner.provider.id;
      reason = 'source_grounded_page_class_acceptance';
    } else if (baseline.successRate < 1 && nvidiaProviders.every((provider) => {
      const score = providerScores[provider.id];
      return score.succeededPages === 0 || hasSafetyRegression(score);
    })) {
      decision = 'MANUAL_REVIEW';
      selectedProviderId = null;
      reason = 'no_safe_provider_for_unresolved_page_class';
    }
    byPageClass[pageClass] = {
      entries: entries.length,
      decision,
      selectedProviderId,
      reason,
      providerScores,
    };
  }

  const nvidiaObservationCount = input.entries.reduce(
    (count, entry) =>
      count + input.providers.filter(
        (provider) => provider.kind === 'nvidia' && entry.observations?.[provider.id]?.status === 'succeeded',
      ).length,
    0,
  );
  const acceptedPageClasses = Object.entries(byPageClass)
    .filter(([, result]) => ['NVIDIA_PRIMARY', 'NVIDIA_FALLBACK'].includes(result.decision))
    .map(([pageClass]) => pageClass);
  const liveBenchmarkAccepted =
    missingStrata.length === 0 &&
    nvidiaObservationCount > 0 &&
    acceptedPageClasses.length > 0;
  const output = {
    schemaVersion: 'phase8_session5_benchmark_result_v1',
    runId: input.runId,
    corpusSha256: sha256Hex(input),
    baselineProviderId: baselineId,
    missingStrata,
    nvidiaObservationCount,
    acceptedPageClasses,
    liveBenchmarkAccepted,
    pageClassDecisions: Object.fromEntries(
      Object.entries(byPageClass).map(([pageClass, result]) => [pageClass, result.decision]),
    ),
    byPageClass,
  };
  return Object.freeze({ ...output, contentSha256: sha256Hex(output) });
}

export function createInMemoryPorts() {
  const artifacts = new Map();
  const manifests = new Map();
  const jobs = new Map();
  const completionMessages = [];
  const dlqMessages = [];
  const metrics = [];
  const providerOutputs = new Map();
  const transformJobs = [];
  return {
    state: {
      artifacts,
      manifests,
      jobs,
      completionMessages,
      dlqMessages,
      metrics,
      providerOutputs,
      transformJobs,
      persistentEndpoints: [],
    },
    ports: {
      artifactStore: {
        async head(key) { return artifacts.get(key) ?? null; },
        async putManifest(value) {
          const result = {
            s3Uri: `s3://test-input/${value.batchId}/${value.sha256}.jsonl`,
            sha256: value.sha256,
          };
          manifests.set(value.batchId, { ...value, ...result });
          return result;
        },
        async readProviderOutput(output) {
          return output.body ?? providerOutputs.get(output.key);
        },
        async putVerifiedArtifact(value) {
          artifacts.set(value.cacheKey, value);
          return value;
        },
      },
      batchClient: {
        async createTransformJob(request) {
          const result = {
            transformJobName: `job-${request.batch.batchId}`,
            outputUri: `s3://test-output/${request.batch.batchId}/`,
            executionModel: 'sagemaker_batch_transform',
          };
          transformJobs.push({ request, result });
          return result;
        },
        async listPersistentEndpoints() {
          return [...thisState.persistentEndpoints];
        },
      },
      jobStore: {
        async put(job) { jobs.set(job.jobId, job); return job; },
        async get(jobId) { return jobs.get(jobId) ?? null; },
        async countActive() {
          return [...jobs.values()].filter((job) =>
            ['PLANNED', 'MANIFEST_WRITTEN', 'SUBMITTED', 'RUNNING'].includes(job.status),
          ).length;
        },
        async monthSpendUsd() {
          return [...jobs.values()].reduce(
            (sum, job) => sum + Number(job.actualCostUsd ?? 0),
            0,
          );
        },
      },
      completionQueue: {
        async publish(message) { completionMessages.push(message); return message; },
      },
      dlq: {
        async publish(message) { dlqMessages.push(message); return message; },
      },
      metrics: {
        async put(name, value, dimensions) {
          metrics.push({ name, value, dimensions });
        },
      },
    },
  };

  // Kept after return through function hoisting closure; assigned below.
  function stateReference() {}
}

// createInMemoryPorts uses this helper-free form to avoid exposing mutable state
// through production classes. Patch listPersistentEndpoints after construction.
const originalCreateInMemoryPorts = createInMemoryPorts;
export function createTestPorts() {
  const result = originalCreateInMemoryPorts();
  result.ports.batchClient.listPersistentEndpoints = async () => [
    ...result.state.persistentEndpoints,
  ];
  return result;
}
