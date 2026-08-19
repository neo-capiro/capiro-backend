import {
  REQUIRED_BENCHMARK_STRATA,
  Session5RefusalError,
  sha256Hex,
} from './session5.mjs';
import {
  SESSION5_RESERVATION_RATE_FLOOR_USD_PER_HOUR,
  assertSha,
} from './real-batch-config.mjs';

export function computeMaximumReservedCostUsd(config, instanceCount = 1) {
  const configuredRate = Number(config.marketplaceUsdPerHostHour) + Number(config.instanceUsdPerHour);
  if (!Number.isFinite(configuredRate) || configuredRate <= 0) {
    throw new Session5RefusalError('INVALID_RATE', 'Combined GPU hourly rate must be positive');
  }
  // Reservation uses a deliberately conservative floor so a stale/low pricing
  // input cannot make the atomic authorization ledger under-reserve paid work.
  const reservationRate = Math.max(
    configuredRate,
    SESSION5_RESERVATION_RATE_FLOOR_USD_PER_HOUR,
  );
  return Number(((config.maxJobSeconds / 3600) * reservationRate * instanceCount).toFixed(6));
}

function toEpochMillis(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function reconcileTransformFacts(description, config, nowIso = new Date().toISOString()) {
  const status = description?.TransformJobStatus;
  if (!['InProgress', 'Stopping', 'Completed', 'Failed', 'Stopped'].includes(status)) {
    throw new Session5RefusalError(
      'UNKNOWN_PROVIDER_STATUS',
      `Unsupported SageMaker TransformJobStatus ${status}`,
    );
  }
  // Use CreationTime for conservative spend/watchdog reconciliation. GPU billing
  // cannot start before provider job creation; using the earlier provider fact
  // avoids under-reserving startup/provisioning time. TransformStartTime is
  // retained separately as executionStartedAt for telemetry.
  const billingStart = toEpochMillis(
    description.CreationTime ?? description.TransformStartTime,
  );
  const executionStart = toEpochMillis(description.TransformStartTime);
  const end = toEpochMillis(description.TransformEndTime);
  const now = Date.parse(nowIso);
  const elapsedSeconds = billingStart === null
    ? 0
    : Math.max(0, ((end ?? now) - billingStart) / 1000);
  const instanceCount = Number(description.TransformResources?.InstanceCount ?? 1);
  const rate = Number(config.marketplaceUsdPerHostHour) + Number(config.instanceUsdPerHour);
  const reconciledCostUsd = Number(((elapsedSeconds / 3600) * rate * instanceCount).toFixed(6));
  return Object.freeze({
    status,
    elapsedSeconds,
    reconciledCostUsd,
    gpuSeconds: elapsedSeconds * instanceCount,
    startedAt: billingStart === null ? null : new Date(billingStart).toISOString(),
    executionStartedAt: executionStart === null ? null : new Date(executionStart).toISOString(),
    completedAt: end === null ? null : new Date(end).toISOString(),
    failureReason: description.FailureReason ?? null,
  });
}

export function deterministicTransformJobName(batchId, attempt = 1) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 99) {
    throw new Session5RefusalError('INVALID_ATTEMPT', 'Attempt must be between 1 and 99');
  }
  return `capiro-s5-${sha256Hex(batchId).slice(0, 43)}-a${String(attempt).padStart(2, '0')}`;
}

export function validateLiveBenchmarkCorpus(corpus) {
  if (!corpus || corpus.schemaVersion !== 'phase8_session5_benchmark_corpus_v1') {
    throw new Session5RefusalError('INVALID_BENCHMARK', 'Unsupported benchmark corpus schema');
  }
  const acceptedByStratum = new Map();
  for (const stratum of REQUIRED_BENCHMARK_STRATA) acceptedByStratum.set(stratum, 0);
  const problems = [];
  for (const entry of corpus.entries ?? []) {
    const gold = entry.gold ?? {};
    if (gold.reviewStatus !== 'accepted') {
      problems.push(`${entry.id}: gold.reviewStatus must be accepted`);
      continue;
    }
    if (gold.incomplete === true || gold.conflicted === true) {
      problems.push(`${entry.id}: gold is incomplete or conflicted`);
      continue;
    }
    try {
      assertSha(gold.sourceEvidenceSha256, `${entry.id}.gold.sourceEvidenceSha256`);
    } catch (error) {
      problems.push(`${entry.id}: ${error.message}`);
      continue;
    }
    if (acceptedByStratum.has(entry.stratum)) {
      acceptedByStratum.set(entry.stratum, acceptedByStratum.get(entry.stratum) + 1);
    }
  }
  for (const [stratum, count] of acceptedByStratum) {
    if (count === 0) problems.push(`${stratum}: no accepted source-grounded gold entry`);
  }
  if (problems.length > 0) {
    throw new Session5RefusalError(
      'LIVE_CORPUS_NOT_ACCEPTABLE',
      'The FY27 corpus cannot close a live safety benchmark yet',
      { problems },
    );
  }
  return Object.freeze({
    acceptedEntries: corpus.entries.length,
    strata: Object.fromEntries(acceptedByStratum),
  });
}
