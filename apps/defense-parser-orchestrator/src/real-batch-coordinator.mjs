import {
  Session5RefusalError,
  buildParserOptionsHash,
  canonicalJson,
  routePage,
  sha256Hex,
} from './session5.mjs';
import {
  assertSha,
  buildLiveBatchIdentity,
  buildLivePageCacheKey,
  buildLivePageIdentity,
} from './real-batch-config.mjs';
import {
  buildProviderManifest,
  normalizeProviderOutputJsonLines,
  verifyNormalizedPageArtifact,
} from './real-batch-provider.mjs';
import {
  computeMaximumReservedCostUsd,
  deterministicTransformJobName,
  reconcileTransformFacts,
} from './real-batch-cost.mjs';

const LIVE_JOB_STATES = new Set([
  'PLANNED',
  'RESERVED',
  'MANIFEST_WRITTEN',
  'SUBMITTED',
  'RUNNING',
  'PROVIDER_COMPLETED',
  'ARTIFACT_VERIFIED',
  'COMPLETION_PENDING',
]);

function realJobTransition(job, nextStatus, at, patch = {}) {
  const allowed = {
    PLANNED: ['RESERVED', 'FAILED'],
    RESERVED: ['MANIFEST_WRITTEN', 'FAILED'],
    MANIFEST_WRITTEN: ['SUBMITTED', 'FAILED'],
    SUBMITTED: ['RUNNING', 'PROVIDER_COMPLETED', 'FAILED'],
    RUNNING: ['PROVIDER_COMPLETED', 'FAILED'],
    PROVIDER_COMPLETED: ['ARTIFACT_VERIFIED', 'FAILED'],
    ARTIFACT_VERIFIED: ['COMPLETION_PENDING'],
    COMPLETION_PENDING: ['RESUME_PUBLISHED', 'DLQ'],
    FAILED: ['DLQ', 'RETRY_PLANNED'],
    DLQ: ['RETRY_PLANNED'],
    RETRY_PLANNED: ['RESERVED', 'FAILED'],
    RESUME_PUBLISHED: [],
  }[job.status] ?? [];
  if (!allowed.includes(nextStatus)) {
    throw new Session5RefusalError(
      'INVALID_JOB_TRANSITION',
      `Invalid real Batch transition ${job.status} -> ${nextStatus}`,
    );
  }
  return Object.freeze({
    ...job,
    ...patch,
    status: nextStatus,
    updatedAt: at,
    history: [...(job.history ?? []), { from: job.status, to: nextStatus, at }],
  });
}

function groupRealPages(input) {
  const byMethod = new Map();
  for (const page of input.pages) {
    const key = canonicalJson({ parserMethod: page.parserMethod });
    const list = byMethod.get(key) ?? [];
    list.push(page);
    byMethod.set(key, list);
  }
  const batches = [];
  for (const list of byMethod.values()) {
    list.sort((a, b) => a.pageNumber - b.pageNumber);
    for (let i = 0; i < list.length; i += input.maxPagesPerJob) {
      const pages = list.slice(i, i + input.maxPagesPerJob);
      const batch = {
        sourceDocumentId: input.sourceDocumentId,
        sourceSha256: input.sourceSha256,
        parserMethod: pages[0].parserMethod,
        modelName: input.modelName,
        modelVersion: input.modelVersion,
        parserOptionsHash: input.parserOptionsHash,
        pages,
      };
      batches.push(
        Object.freeze({ ...batch, batchId: buildLiveBatchIdentity(batch) }),
      );
    }
  }
  return batches.sort((a, b) => a.batchId.localeCompare(b.batchId));
}

export class RealNvidiaBatchCoordinator {
  constructor(ports, config, clock = () => new Date().toISOString()) {
    this.ports = ports;
    this.config = config;
    this.clock = clock;
  }

  async plan(request) {
    assertSha(request.sourceSha256, 'sourceSha256');
    const parserOptionsHash =
      request.parserOptionsHash ?? buildParserOptionsHash(request.parserOptions);
    assertSha(parserOptionsHash, 'parserOptionsHash');
    const modelName = request.modelName ?? this.config.modelName;
    const modelVersion = request.modelVersion ?? this.config.modelVersion;
    if (!modelVersion || modelVersion === 'UNPINNED') {
      throw new Session5RefusalError(
        'MODEL_VERSION_REQUIRED',
        'A pinned modelVersion is required',
      );
    }

    const selected = [];
    const cached = [];
    const decisions = [];
    for (const rawPage of request.pages ?? []) {
      const pageNumber = Number(rawPage.pageNumber);
      const route = routePage(rawPage, {
        benchmarkAccepted: this.config.benchmarkAccepted,
        pageClassDecisions: request.pageClassDecisions,
        criticalConfidenceFloor: request.criticalConfidenceFloor,
      });
      decisions.push({ pageNumber, ...route });
      if (
        !route.parserMethod ||
        !['NVIDIA_PRIMARY', 'NVIDIA_FALLBACK'].includes(route.decision)
      ) {
        continue;
      }
      if (rawPage.escalationApproved !== true) {
        throw new Session5RefusalError(
          'UNGOVERNED_ESCALATION',
          `Page ${pageNumber} lacks governed escalation approval`,
        );
      }

      const renderedImageSha256 = rawPage.renderedImage?.sha256;
      const providerPayloadSha256 =
        rawPage.providerPayloadSha256 ??
        sha256Hex(canonicalJson(rawPage.providerPayload));
      const renderingConfigSha256 = rawPage.renderingConfigSha256;
      const identity = buildLivePageIdentity({
        sourceSha256: request.sourceSha256,
        pageNumber,
        parserMethod: route.parserMethod,
        modelName,
        modelVersion,
        parserOptionsHash,
        renderedImageSha256,
        providerPayloadSha256,
        renderingConfigSha256,
      });
      const cacheKey = buildLivePageCacheKey(identity);
      const page = Object.freeze({
        ...identity,
        pageClass: route.pageClass,
        cacheKey,
        escalationReason: route.reason,
        providerPayload: rawPage.providerPayload,
      });
      const existing = await this.ports.artifactStore.getCachedArtifact(cacheKey);
      if (existing) {
        cached.push({
          ...page,
          artifact: verifyNormalizedPageArtifact(existing, page),
        });
      } else {
        selected.push(page);
      }
    }

    const batches = groupRealPages({
      sourceDocumentId: request.sourceDocumentId,
      sourceSha256: request.sourceSha256,
      modelName,
      modelVersion,
      parserOptionsHash,
      pages: selected,
      maxPagesPerJob: this.config.maxPagesPerJob,
    });
    return Object.freeze({
      schemaVersion: 'phase8_session5_real_batch_plan_v2',
      planId: `nvrp_${sha256Hex({
        sourceDocumentId: request.sourceDocumentId,
        sourceSha256: request.sourceSha256,
        modelName,
        modelVersion,
        parserOptionsHash,
        decisions,
        batchIds: batches.map((batch) => batch.batchId),
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
    if (!this.config.enabled) {
      throw new Session5RefusalError(
        'NVIDIA_DISABLED',
        'NVIDIA parsing is disabled',
      );
    }
    const results = [];
    for (const batch of plan.batches) {
      await this.ports.artifactStore.putBatchDefinition(batch);
      const existing = await this.ports.jobStore.get(batch.batchId);
      if (existing && LIVE_JOB_STATES.has(existing.status)) {
        results.push(await this.reconcileJob(existing.jobId));
        continue;
      }
      if (
        existing &&
        ['RESUME_PUBLISHED', 'DLQ', 'FAILED'].includes(existing.status)
      ) {
        throw new Session5RefusalError(
          'EXPLICIT_RETRY_REQUIRED',
          `Job ${batch.batchId} is terminal; use retry instead of resubmitting`,
        );
      }
      const now = this.clock();
      const job = {
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
        pages: batch.pages.map((page) => page.pageNumber),
        createdAt: now,
        updatedAt: now,
        history: [],
      };
      await this.ports.jobStore.put(job);
      results.push(await this.#advancePreSubmission(job, batch));
    }
    return results;
  }

  async retry(jobId) {
    const current = await this.#requireJob(jobId);
    if (
      !['FAILED', 'DLQ'].includes(current.status) ||
      current.dlqPublishPending === true
    ) {
      throw new Session5RefusalError(
        'RETRY_STATE_REFUSAL',
        `Cannot retry from ${current.status}${
          current.dlqPublishPending ? ' while DLQ publication is pending' : ''
        }`,
      );
    }
    const nextAttempt = Number(current.attempt ?? 1) + 1;
    if (nextAttempt > this.config.maxPaidAttempts) {
      throw new Session5RefusalError(
        'RETRY_LIMIT',
        'Paid attempt limit has been reached',
      );
    }
    const batch = await this.ports.artifactStore.getBatchDefinition(current.batchId);
    if (!batch) {
      throw new Session5RefusalError(
        'BATCH_DEFINITION_MISSING',
        'Cannot retry without immutable batch definition',
      );
    }
    const job = realJobTransition(current, 'RETRY_PLANNED', this.clock(), {
      attempt: nextAttempt,
      dlqPublishPending: false,
      lastDlqPublishError: null,
    });
    await this.ports.jobStore.put(job);
    return this.#advancePreSubmission(job, batch);
  }

  async #advancePreSubmission(initialJob, batch) {
    let job = initialJob;

    if (['PLANNED', 'RETRY_PLANNED'].includes(job.status)) {
      const reservedCostUsd = computeMaximumReservedCostUsd(this.config, 1);
      const reservationId = `${job.jobId}#attempt-${job.attempt}`;
      await this.ports.reservationLedger.reserve({
        reservationId,
        jobId: job.jobId,
        attempt: job.attempt,
        reservedCostUsd,
        effectiveCapUsd: this.config.effectiveSpendCapUsd,
        hardCapUsd: this.config.hardIncrementalCapUsd,
        maxConcurrent: this.config.maxConcurrentGpuJobs,
        at: this.clock(),
      });
      job = realJobTransition(job, 'RESERVED', this.clock(), {
        reservationId,
        reservedCostUsd,
        spendCapUsd: this.config.effectiveSpendCapUsd,
      });
      await this.ports.jobStore.put(job);
      await this.#emitLedgerMetrics();
    }

    if (job.status === 'RESERVED') {
      const manifest = buildProviderManifest(batch);
      const stored = await this.ports.artifactStore.putManifestBundle({
        batch,
        body: manifest.body,
        bodySha256: manifest.bodySha256,
        sidecar: manifest.sidecar,
      });
      job = realJobTransition(job, 'MANIFEST_WRITTEN', this.clock(), {
        manifest: stored,
        manifestSha256: manifest.bodySha256,
        sidecarSha256: manifest.sidecar.contentSha256,
      });
      await this.ports.jobStore.put(job);
    }

    if (job.status !== 'MANIFEST_WRITTEN') return job;

    const transformJobName = deterministicTransformJobName(
      job.batchId,
      job.attempt,
    );
    try {
      const providerRun = await this.ports.batchClient.ensureTransformJob({
        transformJobName,
        batch,
        manifest: job.manifest,
        config: this.config,
      });
      job = realJobTransition(job, 'SUBMITTED', this.clock(), {
        providerRun,
        submittedAt: providerRun.submittedAt ?? this.clock(),
        submissionUncertain: false,
      });
      await this.ports.jobStore.put(job);
      await this.ports.metrics.put('NvidiaBatchSubmitted', 1, {
        parserMethod: batch.parserMethod,
        modelVersion: batch.modelVersion,
      });
      return job;
    } catch (error) {
      const confirmedAbsent =
        await this.ports.batchClient.confirmTransformJobAbsent(transformJobName);
      if (!confirmedAbsent) {
        const uncertain = Object.freeze({
          ...job,
          submissionUncertain: true,
          lastSubmissionError: String(error?.message ?? error),
          updatedAt: this.clock(),
        });
        await this.ports.jobStore.put(uncertain);
        return uncertain;
      }

      await this.ports.reservationLedger.release({
        reservationId: job.reservationId,
        reason: 'submission_confirmed_absent',
        at: this.clock(),
      });
      await this.#emitLedgerMetrics();
      const failed = realJobTransition(job, 'FAILED', this.clock(), {
        failureCode: 'SUBMISSION_FAILED',
        failureMessage: String(error?.message ?? error),
      });
      await this.ports.jobStore.put(failed);
      return this.#publishDlq(failed, 'submission_failed');
    }
  }

  async reconcileJob(jobId) {
    let job = await this.#requireJob(jobId);

    if (job.dlqPublishPending === true) {
      return this.#publishDlq(job, job.dlqReason ?? 'dlq_publish_retry');
    }

    if (
      ['PLANNED', 'RETRY_PLANNED', 'RESERVED', 'MANIFEST_WRITTEN'].includes(
        job.status,
      )
    ) {
      const batch = await this.ports.artifactStore.getBatchDefinition(job.batchId);
      if (!batch) {
        throw new Session5RefusalError(
          'BATCH_DEFINITION_MISSING',
          `Cannot recover ${job.status} job without immutable batch definition`,
        );
      }
      return this.#advancePreSubmission(job, batch);
    }

    if (job.status === 'COMPLETION_PENDING') {
      return this.#publishCompletion(job);
    }
    if (job.status === 'ARTIFACT_VERIFIED') {
      job = realJobTransition(job, 'COMPLETION_PENDING', this.clock(), {
        completionPublishAttempts: Number(job.completionPublishAttempts ?? 0),
      });
      await this.ports.jobStore.put(job);
      return this.#publishCompletion(job);
    }
    if (!['SUBMITTED', 'RUNNING'].includes(job.status)) return job;

    const description = await this.ports.batchClient.describeTransformJob(
      job.providerRun.transformJobName,
    );
    const facts = reconcileTransformFacts(
      description,
      this.config,
      this.clock(),
    );

    if (facts.status === 'InProgress' || facts.status === 'Stopping') {
      if (
        facts.elapsedSeconds > this.config.maxJobSeconds &&
        facts.status === 'InProgress' &&
        !job.stopRequestedAt
      ) {
        await this.ports.batchClient.stopTransformJob(
          job.providerRun.transformJobName,
        );
        const stopping = Object.freeze({
          ...job,
          stopRequestedAt: this.clock(),
          failureCode: 'TIMEOUT_STOP_REQUESTED',
          failureMessage: `Transform job exceeded ${this.config.maxJobSeconds} seconds; stop requested`,
          providerStatus: 'Stopping',
          updatedAt: this.clock(),
        });
        await this.ports.jobStore.put(stopping);
        return stopping;
      }
      if (job.status === 'SUBMITTED') {
        job = realJobTransition(job, 'RUNNING', this.clock(), {
          providerStatus: facts.status,
          startedAt: facts.startedAt,
        });
        await this.ports.jobStore.put(job);
      }
      return job;
    }

    await this.ports.reservationLedger.settle({
      reservationId: job.reservationId,
      reconciledCostUsd: facts.reconciledCostUsd,
      at: this.clock(),
    });
    await this.#emitLedgerMetrics();

    if (facts.status === 'Failed' || facts.status === 'Stopped') {
      const failed = realJobTransition(job, 'FAILED', this.clock(), {
        providerStatus: facts.status,
        failureCode:
          facts.status === 'Stopped' ? 'PROVIDER_STOPPED' : 'PROVIDER_FAILED',
        failureMessage:
          facts.failureReason ?? 'SageMaker Batch Transform failed',
        reconciledCostUsd: facts.reconciledCostUsd,
        gpuSeconds: facts.gpuSeconds,
        completedAt: facts.completedAt,
      });
      await this.ports.jobStore.put(failed);
      return this.#publishDlq(failed, 'provider_failed');
    }

    job = realJobTransition(job, 'PROVIDER_COMPLETED', this.clock(), {
      providerStatus: facts.status,
      reconciledCostUsd: facts.reconciledCostUsd,
      gpuSeconds: facts.gpuSeconds,
      completedAt: facts.completedAt,
    });
    await this.ports.jobStore.put(job);

    try {
      const output = await this.ports.batchClient.resolveOutputObject(
        job.providerRun,
      );
      const rawOutputText =
        await this.ports.artifactStore.readRawProviderOutput(output);
      const sidecar =
        await this.ports.artifactStore.readManifestSidecar(job.manifest);
      const normalized = normalizeProviderOutputJsonLines({
        rawOutputText,
        sidecar,
        providerRunIdentity: {
          executionModel: 'sagemaker_batch_transform',
          transformJobName: job.providerRun.transformJobName,
          transformJobArn: description.TransformJobArn,
          startedAt: facts.startedAt,
          completedAt: facts.completedAt,
          instanceType: description.TransformResources?.InstanceType,
          instanceCount: description.TransformResources?.InstanceCount ?? 1,
        },
      });
      const expectedByPage = new Map(
        sidecar.records.map((record) => [record.pageNumber, record]),
      );
      for (const page of normalized.pages) {
        const expected = expectedByPage.get(page.pageNumber);
        if (!expected) {
          throw new Session5RefusalError(
            'UNREQUESTED_PAGE',
            `Normalized provider output contains unrequested page ${page.pageNumber}`,
          );
        }
        verifyNormalizedPageArtifact(page, {
          sourceSha256: sidecar.sourceSha256,
          pageNumber: expected.pageNumber,
          parserMethod: sidecar.parserMethod,
          modelName: sidecar.modelName,
          modelVersion: sidecar.modelVersion,
          parserOptionsHash: sidecar.parserOptionsHash,
          renderedImageSha256: expected.renderedImageSha256,
          providerPayloadSha256: expected.providerPayloadSha256,
          renderingConfigSha256: expected.renderingConfigSha256,
        });
        await this.ports.artifactStore.putVerifiedArtifact({
          cacheKey: page.cacheKey,
          artifact: page,
          contentSha256: page.contentSha256,
        });
      }
      job = realJobTransition(job, 'ARTIFACT_VERIFIED', this.clock(), {
        providerArtifactSha256: normalized.contentSha256,
        providerRawOutputSha256: normalized.rawProviderOutputSha256,
        providerRunIdentity: normalized.providerRunIdentity,
      });
      await this.ports.jobStore.put(job);
      job = realJobTransition(job, 'COMPLETION_PENDING', this.clock(), {
        completionPublishAttempts: 0,
      });
      await this.ports.jobStore.put(job);
      return this.#publishCompletion(job);
    } catch (error) {
      const failed = realJobTransition(job, 'FAILED', this.clock(), {
        failureCode: error?.code ?? 'ARTIFACT_VERIFICATION_FAILED',
        failureMessage: String(error?.message ?? error),
      });
      await this.ports.jobStore.put(failed);
      return this.#publishDlq(failed, 'artifact_verification_failed');
    }
  }

  async reconcileAll() {
    const jobs = await this.ports.jobStore.listReconcileCandidates();
    const results = [];
    for (const job of jobs) {
      results.push(await this.reconcileJob(job.jobId));
    }
    return results;
  }

  async #publishCompletion(job) {
    const attempts = Number(job.completionPublishAttempts ?? 0) + 1;
    try {
      await this.ports.completionQueue.publish({
        schemaVersion: 'nvidia_parser_completion_v2',
        jobId: job.jobId,
        sourceDocumentId: job.sourceDocumentId,
        sourceSha256: job.sourceSha256,
        pages: job.pages,
        providerArtifactSha256: job.providerArtifactSha256,
        providerRawOutputSha256: job.providerRawOutputSha256,
        reconciledCostUsd: job.reconciledCostUsd,
      });
      const completed = realJobTransition(
        job,
        'RESUME_PUBLISHED',
        this.clock(),
        {
          completionPublishAttempts: attempts,
          completionPublishedAt: this.clock(),
          lastCompletionPublishError: null,
        },
      );
      await this.ports.jobStore.put(completed);
      await this.ports.metrics.put('NvidiaBatchCompleted', 1, {
        parserMethod: job.parserMethod,
        modelVersion: job.modelVersion,
      });
      return completed;
    } catch (error) {
      const pending = Object.freeze({
        ...job,
        completionPublishAttempts: attempts,
        lastCompletionPublishError: String(error?.message ?? error),
        updatedAt: this.clock(),
      });
      await this.ports.jobStore.put(pending);
      if (attempts >= this.config.completionPublishMaxAttempts) {
        return this.#publishDlq(pending, 'completion_publish_exhausted');
      }
      return pending;
    }
  }

  async #publishDlq(job, reason) {
    try {
      await this.ports.dlq.publish({
        schemaVersion: 'nvidia_parser_dlq_v2',
        jobId: job.jobId,
        sourceDocumentId: job.sourceDocumentId,
        sourceSha256: job.sourceSha256,
        pages: job.pages,
        reason,
        failureCode: job.failureCode,
        failureMessage: job.failureMessage,
        attempt: job.attempt,
      });
    } catch (error) {
      const pending = Object.freeze({
        ...job,
        dlqPublishPending: true,
        dlqReason: reason,
        lastDlqPublishError: String(error?.message ?? error),
        updatedAt: this.clock(),
      });
      await this.ports.jobStore.put(pending);
      return pending;
    }
    const dlqJob = ['FAILED', 'COMPLETION_PENDING'].includes(job.status)
      ? realJobTransition(job, 'DLQ', this.clock(), {
          dlqPublishedAt: this.clock(),
        })
      : job;
    await this.ports.jobStore.put(dlqJob);
    await this.ports.metrics.put('NvidiaBatchDlq', 1, {
      parserMethod: job.parserMethod,
      reason,
    });
    return dlqJob;
  }

  async #emitLedgerMetrics() {
    const snapshot = await this.ports.reservationLedger.snapshot();
    await this.ports.metrics.put(
      'NvidiaActiveGpuJobs',
      snapshot.activeJobs,
      {},
    );
    await this.ports.metrics.put(
      'NvidiaMonthlySpendUsd',
      snapshot.spentAndReservedUsd,
      {},
    );
  }

  async #requireJob(jobId) {
    const job = await this.ports.jobStore.get(jobId);
    if (!job) {
      throw new Session5RefusalError(
        'JOB_NOT_FOUND',
        `NVIDIA job ${jobId} not found`,
      );
    }
    return job;
  }

  async zeroIdleProof() {
    const ledger = await this.ports.reservationLedger.snapshot();
    const providerActiveJobs =
      await this.ports.batchClient.listActiveTransformJobs();
    const persistentEndpoints =
      await this.ports.batchClient.listPersistentEndpoints();
    return Object.freeze({
      activeJobs: ledger.activeJobs,
      providerActiveJobs,
      spentAndReservedUsd: ledger.spentAndReservedUsd,
      persistentEndpoints,
      zeroIdleGpu:
        ledger.activeJobs === 0 &&
        providerActiveJobs.length === 0 &&
        persistentEndpoints.length === 0,
      checkedAt: this.clock(),
    });
  }
}
