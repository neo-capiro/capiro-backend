import {
  Session5RefusalError,
  canonicalJson,
  sha256Hex,
} from './session5.mjs';

export const REAL_BATCH_INPUT_CONTENT_TYPE = 'application/json';
export const REAL_BATCH_OUTPUT_ACCEPT = 'application/json';
export const REAL_BATCH_SPLIT_TYPE = 'Line';
export const REAL_BATCH_ASSEMBLE_WITH = 'Line';
export const SESSION5_AUTHORIZED_HARD_CAP_USD = 150;
export const SESSION5_AUTHORIZED_INITIAL_CAP_USD = 50;
export const SESSION5_RESERVATION_RATE_FLOOR_USD_PER_HOUR = 5;
export const REAL_BATCH_RUNTIME_CONTRACT_VERSION = 'nvidia_real_batch_v2';

function parseBoolean(raw, fallback, name) {
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Session5RefusalError('INVALID_CONFIG', `${name} must be true or false`);
}

function parsePositiveInteger(raw, fallback, name) {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Session5RefusalError('INVALID_CONFIG', `${name} must be a positive integer`);
  }
  return value;
}

function parsePositiveNumber(raw, fallback, name) {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Session5RefusalError('INVALID_CONFIG', `${name} must be a positive number`);
  }
  return value;
}

export function loadRealBatchConfig(env = process.env) {
  const hardIncrementalCapUsd = parsePositiveNumber(
    env.NVIDIA_HARD_INCREMENTAL_CAP_USD ?? env.NVIDIA_MONTHLY_GPU_BUDGET_USD,
    SESSION5_AUTHORIZED_HARD_CAP_USD,
    'NVIDIA_HARD_INCREMENTAL_CAP_USD',
  );
  const initialBenchmarkCapUsd = parsePositiveNumber(
    env.NVIDIA_INITIAL_BENCHMARK_CAP_USD,
    SESSION5_AUTHORIZED_INITIAL_CAP_USD,
    'NVIDIA_INITIAL_BENCHMARK_CAP_USD',
  );
  if (hardIncrementalCapUsd > SESSION5_AUTHORIZED_HARD_CAP_USD) {
    throw new Session5RefusalError(
      'UNAUTHORIZED_SPEND_CAP',
      `Session 5 hard cap cannot exceed USD ${SESSION5_AUTHORIZED_HARD_CAP_USD}`,
    );
  }
  if (initialBenchmarkCapUsd > SESSION5_AUTHORIZED_INITIAL_CAP_USD) {
    throw new Session5RefusalError(
      'UNAUTHORIZED_INITIAL_CAP',
      `Initial benchmark cap cannot exceed USD ${SESSION5_AUTHORIZED_INITIAL_CAP_USD}`,
    );
  }
  if (initialBenchmarkCapUsd > hardIncrementalCapUsd) {
    throw new Session5RefusalError(
      'INVALID_CONFIG',
      'Initial benchmark cap cannot exceed the hard incremental cap',
    );
  }

  const enabled = parseBoolean(
    env.NVIDIA_PARSING_ENABLED,
    false,
    'NVIDIA_PARSING_ENABLED',
  );
  const extendedBudgetAuthorized = parseBoolean(
    env.NVIDIA_EXTENDED_BUDGET_AUTHORIZED,
    false,
    'NVIDIA_EXTENDED_BUDGET_AUTHORIZED',
  );

  const config = {
    enabled,
    routingMode: env.NVIDIA_ROUTING_MODE || 'benchmark',
    benchmarkAccepted: parseBoolean(
      env.NVIDIA_BENCHMARK_ACCEPTED,
      false,
      'NVIDIA_BENCHMARK_ACCEPTED',
    ),
    extendedBudgetAuthorized,
    initialBenchmarkCapUsd,
    hardIncrementalCapUsd,
    effectiveSpendCapUsd: extendedBudgetAuthorized
      ? hardIncrementalCapUsd
      : initialBenchmarkCapUsd,
    maxConcurrentGpuJobs: parsePositiveInteger(
      env.NVIDIA_MAX_CONCURRENT_GPU_JOBS,
      1,
      'NVIDIA_MAX_CONCURRENT_GPU_JOBS',
    ),
    maxPagesPerJob: parsePositiveInteger(
      env.NVIDIA_MAX_PAGES_PER_JOB,
      8,
      'NVIDIA_MAX_PAGES_PER_JOB',
    ),
    maxPaidAttempts: parsePositiveInteger(
      env.NVIDIA_MAX_PAID_ATTEMPTS,
      2,
      'NVIDIA_MAX_PAID_ATTEMPTS',
    ),
    maxJobSeconds: parsePositiveInteger(
      env.NVIDIA_MAX_JOB_SECONDS,
      1800,
      'NVIDIA_MAX_JOB_SECONDS',
    ),
    completionPublishMaxAttempts: parsePositiveInteger(
      env.NVIDIA_COMPLETION_PUBLISH_MAX_ATTEMPTS,
      5,
      'NVIDIA_COMPLETION_PUBLISH_MAX_ATTEMPTS',
    ),
    marketplaceUsdPerHostHour: parsePositiveNumber(
      env.NVIDIA_MARKETPLACE_USD_PER_HOST_HOUR,
      1,
      'NVIDIA_MARKETPLACE_USD_PER_HOST_HOUR',
    ),
    instanceUsdPerHour: enabled
      ? parsePositiveNumber(
          env.NVIDIA_INSTANCE_USD_PER_HOUR,
          Number.NaN,
          'NVIDIA_INSTANCE_USD_PER_HOUR',
        )
      : env.NVIDIA_INSTANCE_USD_PER_HOUR
        ? parsePositiveNumber(
            env.NVIDIA_INSTANCE_USD_PER_HOUR,
            1,
            'NVIDIA_INSTANCE_USD_PER_HOUR',
          )
        : 1,
    modelName: env.NVIDIA_MODEL_NAME || 'nemotron-parse',
    modelVersion: env.NVIDIA_MODEL_VERSION || 'UNPINNED',
    transformModelName: env.NVIDIA_SAGEMAKER_MODEL_NAME || '',
    inputBucket: env.NVIDIA_INPUT_BUCKET || '',
    outputBucket: env.NVIDIA_OUTPUT_BUCKET || '',
    inputPrefix: env.NVIDIA_INPUT_PREFIX || 'phase8/nvidia/input',
    outputPrefix: env.NVIDIA_OUTPUT_PREFIX || 'phase8/nvidia/output',
    completionQueueUrl: env.NVIDIA_COMPLETION_QUEUE_URL || '',
    dlqUrl: env.NVIDIA_DLQ_URL || '',
    ledgerTableName: env.NVIDIA_RESERVATION_LEDGER_TABLE || '',
    instanceType: env.NVIDIA_INSTANCE_TYPE || 'ml.g5.xlarge',
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1',
  };

  if (config.routingMode !== 'benchmark' && config.benchmarkAccepted !== true) {
    throw new Session5RefusalError(
      'BENCHMARK_REQUIRED',
      'Session 5 live execution remains benchmark-only until source-grounded acceptance',
    );
  }
  if (config.maxConcurrentGpuJobs !== 1) {
    throw new Session5RefusalError(
      'UNAUTHORIZED_CONCURRENCY',
      'Session 5 authorization permits exactly one concurrent GPU job',
    );
  }
  if (config.instanceType !== 'ml.g5.xlarge') {
    throw new Session5RefusalError(
      'UNAUTHORIZED_INSTANCE_TYPE',
      'Session 5 live authorization is pinned to ml.g5.xlarge',
    );
  }
  if (config.marketplaceUsdPerHostHour < 1) {
    throw new Session5RefusalError(
      'INVALID_MARKETPLACE_RATE',
      'Nemotron Parse Marketplace reservation rate cannot be configured below USD 1/host-hour',
    );
  }

  if (enabled) {
    const required = [
      ['NVIDIA_MODEL_VERSION', config.modelVersion !== 'UNPINNED'],
      ['NVIDIA_SAGEMAKER_MODEL_NAME', Boolean(config.transformModelName)],
      ['NVIDIA_INPUT_BUCKET', Boolean(config.inputBucket)],
      ['NVIDIA_OUTPUT_BUCKET', Boolean(config.outputBucket)],
      ['NVIDIA_COMPLETION_QUEUE_URL', Boolean(config.completionQueueUrl)],
      ['NVIDIA_DLQ_URL', Boolean(config.dlqUrl)],
      ['NVIDIA_RESERVATION_LEDGER_TABLE', Boolean(config.ledgerTableName)],
      ['NVIDIA_INSTANCE_USD_PER_HOUR', Number.isFinite(config.instanceUsdPerHour)],
    ];
    const missing = required.filter(([, ok]) => !ok).map(([name]) => name);
    if (missing.length > 0) {
      throw new Session5RefusalError(
        'CONFIG_REQUIRED',
        `Real Batch execution is missing required configuration: ${missing.join(', ')}`,
      );
    }
  }

  return Object.freeze(config);
}

export function assertSha(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Session5RefusalError(
      'INVALID_SHA256',
      `${name} must be a lowercase SHA-256`,
    );
  }
  return value;
}

function assertPositivePage(pageNumber) {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new Session5RefusalError(
      'INVALID_PAGE',
      'pageNumber must be a positive integer',
    );
  }
}

function actualLiveParserMethod(input) {
  // The only subscribed/approved live provider in Session 5 is Nemotron Parse.
  // Legacy routing vocabulary may express a desired table/OCR lane, but that
  // must never be mislabeled as a provider that was not actually invoked.
  if (input.modelName === 'nemotron-parse') return 'nemotron_parse';
  return input.parserMethod;
}

export function buildLivePageIdentity(input) {
  assertSha(input.sourceSha256, 'sourceSha256');
  assertSha(input.parserOptionsHash, 'parserOptionsHash');
  assertSha(input.renderedImageSha256, 'renderedImageSha256');
  assertSha(input.providerPayloadSha256, 'providerPayloadSha256');
  assertSha(input.renderingConfigSha256, 'renderingConfigSha256');
  assertPositivePage(input.pageNumber);
  for (const field of ['parserMethod', 'modelName', 'modelVersion']) {
    if (typeof input[field] !== 'string' || input[field].length === 0) {
      throw new Session5RefusalError(
        'CACHE_IDENTITY_REQUIRED',
        `${field} is required`,
      );
    }
  }
  const requestedParserMethod = input.requestedParserMethod ?? input.parserMethod;
  const parserMethod = actualLiveParserMethod({ ...input, parserMethod: requestedParserMethod });
  return Object.freeze({
    sourceSha256: input.sourceSha256,
    pageNumber: input.pageNumber,
    provider: 'nvidia',
    requestedParserMethod,
    parserMethod,
    modelName: input.modelName,
    modelVersion: input.modelVersion,
    parserOptionsHash: input.parserOptionsHash,
    renderedImageSha256: input.renderedImageSha256,
    providerPayloadSha256: input.providerPayloadSha256,
    renderingConfigSha256: input.renderingConfigSha256,
    runtimeContractVersion:
      input.runtimeContractVersion ?? REAL_BATCH_RUNTIME_CONTRACT_VERSION,
  });
}

export function buildLivePageCacheKey(input) {
  return `nvp2_${sha256Hex(buildLivePageIdentity(input))}`;
}

export function buildLiveBatchIdentity(input) {
  if (!Array.isArray(input.pages) || input.pages.length === 0) {
    throw new Session5RefusalError(
      'PAGES_REQUIRED',
      'A live batch requires pages',
    );
  }
  const identities = input.pages
    .map((page) => buildLivePageIdentity(page))
    .sort((a, b) => a.pageNumber - b.pageNumber);
  return `nvb2_${sha256Hex({
    sourceDocumentId: input.sourceDocumentId,
    sourceSha256: input.sourceSha256,
    parserMethod: input.parserMethod,
    modelName: input.modelName,
    modelVersion: input.modelVersion,
    parserOptionsHash: input.parserOptionsHash,
    identities,
  })}`;
}

export function computeProviderPayloadSha256(payload) {
  return sha256Hex(canonicalJson(payload));
}
