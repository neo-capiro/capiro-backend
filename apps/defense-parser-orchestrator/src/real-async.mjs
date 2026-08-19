import {
  Session5RefusalError,
  canonicalJson,
  sha256Hex,
} from './session5.mjs';
import {
  buildProviderManifest,
  normalizeProviderOutputJsonLines,
  verifyNormalizedPageArtifact,
} from './real-batch-provider.mjs';
import { assertSha } from './real-batch-config.mjs';

export const ASYNC_RUNTIME_CONTRACT_VERSION = 'nvidia_async_inference_v1';
export const ASYNC_EXECUTION_MODEL = 'sagemaker_async_inference';
export const ASYNC_INPUT_CONTENT_TYPE = 'application/json';
export const ASYNC_OUTPUT_ACCEPT = 'application/json';
const SESSION5_MIN_MARKETPLACE_RATE_USD = 1;
const SESSION5_MIN_INSTANCE_RATE_USD = 1;
export const SESSION5_MODEL_PACKAGE_ARN =
  'arn:aws:sagemaker:us-east-1:865070037744:model-package/nvidia-nemotron-parse-6673990e627d314f8aceb69f5e816587';
export const PINNED_MODEL_USES_MODEL_DATA_SOURCE = true;

export function assertPinnedModelDataSourceRequiresAsync({ executionModel, modelDataSource }) {
  if (modelDataSource === true && executionModel === 'sagemaker_batch_transform') {
    throw new Session5RefusalError(
      'MODELDATASOURCE_BATCH_UNSUPPORTED',
      'The pinned Marketplace package uses ModelDataSource and cannot be submitted to Batch Transform',
    );
  }
  if (executionModel !== ASYNC_EXECUTION_MODEL) {
    throw new Session5RefusalError(
      'ASYNC_MODE_REQUIRED',
      'The pinned ModelDataSource package must use SageMaker Async Inference',
    );
  }
  return { valid: true };
}
const MAX_NAME = 63;

function parseBoolean(raw, fallback, name) {
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Session5RefusalError('INVALID_CONFIG', `${name} must be true or false`);
}

function positiveNumber(raw, fallback, name) {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Session5RefusalError('INVALID_CONFIG', `${name} must be positive`);
  }
  return value;
}

function positiveInteger(raw, fallback, name) {
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Session5RefusalError('INVALID_CONFIG', `${name} must be a positive integer`);
  }
  return value;
}

export function loadRealAsyncConfig(env = process.env) {
  const hardCapUsd = positiveNumber(
    env.NVIDIA_HARD_INCREMENTAL_CAP_USD,
    150,
    'NVIDIA_HARD_INCREMENTAL_CAP_USD',
  );
  const initialCapUsd = positiveNumber(
    env.NVIDIA_INITIAL_BENCHMARK_CAP_USD,
    50,
    'NVIDIA_INITIAL_BENCHMARK_CAP_USD',
  );
  const extendedBudgetAuthorized = parseBoolean(
    env.NVIDIA_EXTENDED_BUDGET_AUTHORIZED,
    false,
    'NVIDIA_EXTENDED_BUDGET_AUTHORIZED',
  );
  if (hardCapUsd > 150) {
    throw new Session5RefusalError(
      'UNAUTHORIZED_SPEND_CAP',
      'Session 5 hard cap cannot exceed USD 150',
    );
  }
  if (initialCapUsd > 50 || initialCapUsd > hardCapUsd) {
    throw new Session5RefusalError(
      'UNAUTHORIZED_INITIAL_CAP',
      'Initial cap must be <= USD 50 and the hard cap',
    );
  }

  const config = {
    enabled: parseBoolean(env.NVIDIA_PARSING_ENABLED, false, 'NVIDIA_PARSING_ENABLED'),
    executionMode: ASYNC_EXECUTION_MODEL,
    asyncLiveRunAuthorized: parseBoolean(
      env.NVIDIA_ASYNC_LIVE_RUN_AUTHORIZED,
      false,
      'NVIDIA_ASYNC_LIVE_RUN_AUTHORIZED',
    ),
    routingMode: env.NVIDIA_ROUTING_MODE || 'benchmark',
    benchmarkAccepted: parseBoolean(
      env.NVIDIA_BENCHMARK_ACCEPTED,
      false,
      'NVIDIA_BENCHMARK_ACCEPTED',
    ),
    extendedBudgetAuthorized,
    initialBenchmarkCapUsd: initialCapUsd,
    hardIncrementalCapUsd: hardCapUsd,
    effectiveSpendCapUsd: extendedBudgetAuthorized ? hardCapUsd : initialCapUsd,
    maxConcurrentGpuJobs: positiveInteger(
      env.NVIDIA_MAX_CONCURRENT_GPU_JOBS,
      1,
      'NVIDIA_MAX_CONCURRENT_GPU_JOBS',
    ),
    maxEndpointLifetimeSeconds: positiveInteger(
      env.NVIDIA_MAX_ENDPOINT_LIFETIME_SECONDS,
      1800,
      'NVIDIA_MAX_ENDPOINT_LIFETIME_SECONDS',
    ),
    marketplaceUsdPerHostHour: positiveNumber(
      env.NVIDIA_MARKETPLACE_USD_PER_HOST_HOUR,
      1,
      'NVIDIA_MARKETPLACE_USD_PER_HOST_HOUR',
    ),
    instanceUsdPerHour: positiveNumber(
      env.NVIDIA_INSTANCE_USD_PER_HOUR,
      1,
      'NVIDIA_INSTANCE_USD_PER_HOUR',
    ),
    modelName: env.NVIDIA_MODEL_NAME || 'nemotron-parse',
    modelVersion: env.NVIDIA_MODEL_VERSION || 'UNPINNED',
    modelPackageArn: env.NVIDIA_MODEL_PACKAGE_ARN || SESSION5_MODEL_PACKAGE_ARN,
    sagemakerModelName: env.NVIDIA_SAGEMAKER_MODEL_NAME || '',
    executionRoleArn: env.NVIDIA_ASYNC_EXECUTION_ROLE_ARN || '',
    kmsKeyId: env.NVIDIA_KMS_KEY_ID || '',
    inputBucket: env.NVIDIA_INPUT_BUCKET || '',
    outputBucket: env.NVIDIA_OUTPUT_BUCKET || '',
    inputPrefix: env.NVIDIA_INPUT_PREFIX || 'phase8/nvidia/async/input',
    outputPrefix: env.NVIDIA_OUTPUT_PREFIX || 'phase8/nvidia/async/output',
    failurePrefix: env.NVIDIA_ASYNC_FAILURE_PREFIX || 'phase8/nvidia/async/failure',
    normalizedPrefix: env.NVIDIA_ASYNC_NORMALIZED_PREFIX || 'phase8/nvidia/async/normalized',
    completionQueueUrl: env.NVIDIA_COMPLETION_QUEUE_URL || '',
    dlqUrl: env.NVIDIA_DLQ_URL || '',
    ledgerTableName: env.NVIDIA_RESERVATION_LEDGER_TABLE || '',
    instanceType: env.NVIDIA_INSTANCE_TYPE || 'ml.g5.xlarge',
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1',
  };
  validateAsyncExecutionConfig(config);
  if (
    config.marketplaceUsdPerHostHour < SESSION5_MIN_MARKETPLACE_RATE_USD ||
    config.instanceUsdPerHour < SESSION5_MIN_INSTANCE_RATE_USD
  ) {
    throw new Session5RefusalError(
      'RATE_FLOOR_REQUIRED',
      'Async benchmark rates must not understate the approved Marketplace and instance rates',
    );
  }
  if (config.enabled) {
    const required = [
      ['NVIDIA_MODEL_VERSION', config.modelVersion !== 'UNPINNED'],
      ['NVIDIA_SAGEMAKER_MODEL_NAME', Boolean(config.sagemakerModelName)],
      ['NVIDIA_ASYNC_EXECUTION_ROLE_ARN', Boolean(config.executionRoleArn)],
      ['NVIDIA_INPUT_BUCKET', Boolean(config.inputBucket)],
      ['NVIDIA_OUTPUT_BUCKET', Boolean(config.outputBucket)],
      ['NVIDIA_COMPLETION_QUEUE_URL', Boolean(config.completionQueueUrl)],
      ['NVIDIA_DLQ_URL', Boolean(config.dlqUrl)],
      ['NVIDIA_RESERVATION_LEDGER_TABLE', Boolean(config.ledgerTableName)],
    ];
    const missing = required.filter(([, ok]) => !ok).map(([name]) => name);
    if (missing.length > 0) {
      throw new Session5RefusalError(
        'CONFIG_REQUIRED',
        `Async execution is missing required configuration: ${missing.join(', ')}`,
      );
    }
  }
  const reservation = computeMaximumEndpointReservationUsd(config);
  if (reservation > config.effectiveSpendCapUsd) {
    throw new Session5RefusalError(
      'ENDPOINT_RESERVATION_EXCEEDS_CAP',
      `Maximum endpoint reservation USD ${reservation} exceeds effective cap USD ${config.effectiveSpendCapUsd}`,
    );
  }
  return Object.freeze(config);
}

export function validateAsyncExecutionConfig(config) {
  if (config.executionMode && config.executionMode !== ASYNC_EXECUTION_MODEL) {
    throw new Session5RefusalError(
      'ASYNC_MODE_REQUIRED',
      'Session 5 active execution mode must be sagemaker_async_inference',
    );
  }
  if (config.maxConcurrentGpuJobs !== 1) {
    throw new Session5RefusalError(
      'UNAUTHORIZED_CONCURRENCY',
      'Session 5 permits exactly one GPU instance',
    );
  }
  if (
    !Number.isInteger(config.maxEndpointLifetimeSeconds) ||
    config.maxEndpointLifetimeSeconds < 60
  ) {
    throw new Session5RefusalError(
      'ENDPOINT_LIFETIME_REQUIRED',
      'Async endpoint lifetime must be bounded to at least 60 seconds',
    );
  }
  if (config.instanceType !== 'ml.g5.xlarge') {
    throw new Session5RefusalError(
      'UNAUTHORIZED_INSTANCE_TYPE',
      'Session 5 is pinned to ml.g5.xlarge',
    );
  }
  if (config.modelPackageArn !== SESSION5_MODEL_PACKAGE_ARN) {
    throw new Session5RefusalError(
      'UNAUTHORIZED_MODEL_PACKAGE',
      'Session 5 requires the pinned Nemotron Parse Marketplace package',
    );
  }
  if (config.routingMode !== 'benchmark' && config.benchmarkAccepted !== true) {
    throw new Session5RefusalError(
      'BENCHMARK_REQUIRED',
      'Async live execution remains benchmark-only',
    );
  }
  return { valid: true };
}

function shortName(prefix, value) {
  return `${prefix}${sha256Hex(value).slice(0, 48)}`.slice(0, MAX_NAME);
}

export function buildAsyncEndpointIdentity(input) {
  assertSha(input.corpusSha256, 'corpusSha256');
  if (input.modelPackageArn !== SESSION5_MODEL_PACKAGE_ARN) {
    throw new Session5RefusalError(
      'UNAUTHORIZED_MODEL_PACKAGE',
      'Endpoint identity is not for the pinned package',
    );
  }
  const basis = {
    corpusSha256: input.corpusSha256,
    modelPackageArn: input.modelPackageArn,
    modelVersion: input.modelVersion,
    runtimeContractVersion:
      input.runtimeContractVersion || ASYNC_RUNTIME_CONTRACT_VERSION,
    modelName: input.modelName || null,
    executionRoleArn: input.executionRoleArn || null,
    instanceType: input.instanceType || null,
    outputBucket: input.outputBucket || null,
    outputPrefix: input.outputPrefix || null,
    failureBucket: input.failureBucket || null,
    failurePrefix: input.failurePrefix || null,
    kmsKeyId: input.kmsKeyId || null,
  };
  return Object.freeze({
    endpointConfigName: shortName('capiro-s5-async-cfg-', basis),
    endpointName: shortName('capiro-s5-async-', basis),
    identitySha256: sha256Hex(basis),
    runtimeContractVersion: basis.runtimeContractVersion,
  });
}

export function buildAsyncInferenceId({ endpointName, page, attempt }) {
  if (
    !endpointName ||
    !page?.sourceSha256 ||
    !Number.isInteger(page.pageNumber) ||
    !Number.isInteger(attempt) ||
    attempt < 1
  ) {
    throw new Session5RefusalError(
      'INVALID_ASYNC_INVOCATION',
      'Endpoint, source/page and attempt are required',
    );
  }
  return shortName('s5-', {
    endpointName,
    sourceSha256: page.sourceSha256,
    pageNumber: page.pageNumber,
    providerPayloadSha256: page.providerPayloadSha256,
    attempt,
  });
}

export function buildAsyncInvocation({
  endpointName,
  endpointConfigName,
  page,
  attempt,
  inputLocation,
}) {
  const inferenceId = buildAsyncInferenceId({ endpointName, page, attempt });
  const payloadText = canonicalJson(page.providerPayload);
  const payloadSha256 = sha256Hex(payloadText);
  if (payloadSha256 !== page.providerPayloadSha256) {
    throw new Session5RefusalError(
      'PROVIDER_PAYLOAD_HASH_MISMATCH',
      `Page ${page.pageNumber} payload hash does not match`,
    );
  }
  return Object.freeze({
    executionModel: ASYNC_EXECUTION_MODEL,
    endpointName,
    endpointConfigName,
    inferenceId,
    contentType: ASYNC_INPUT_CONTENT_TYPE,
    accept: ASYNC_OUTPUT_ACCEPT,
    payload: page.providerPayload,
    payloadText,
    payloadSha256,
    inputLocation,
    provenance: Object.freeze({
      sourceSha256: page.sourceSha256,
      pageNumber: page.pageNumber,
      renderedImageSha256: page.renderedImageSha256,
      providerPayloadSha256: page.providerPayloadSha256,
      renderingConfigSha256: page.renderingConfigSha256,
      modelName: page.modelName,
      modelVersion: page.modelVersion,
      parserOptionsHash: page.parserOptionsHash,
      cacheKey: page.cacheKey,
      requestedParserMethod: page.requestedParserMethod,
      parserMethod: 'nemotron_parse',
      runtimeContractVersion: ASYNC_RUNTIME_CONTRACT_VERSION,
    }),
  });
}

export function computeMaximumEndpointReservationUsd(config) {
  const hourlyRate =
    Number(config.marketplaceUsdPerHostHour) + Number(config.instanceUsdPerHour);
  if (!Number.isFinite(hourlyRate) || hourlyRate <= 0) {
    throw new Session5RefusalError(
      'INVALID_RATE',
      'Endpoint hourly rate must be positive',
    );
  }
  return Number(
    ((config.maxEndpointLifetimeSeconds / 3600) * hourlyRate).toFixed(6),
  );
}

function endpointNotFound(error) {
  return /not found|ValidationException|Could not find|does not exist/i.test(
    String(error?.stderr || error?.message || error),
  );
}

function parseS3Uri(uri) {
  const match = /^s3:\/\/([^/]+)\/(.*)$/.exec(String(uri || ''));
  return match ? { bucket: match[1], key: match[2] } : null;
}

export class SafeAwsCliSageMakerAsyncInferenceAdapter {
  constructor(runner) {
    this.runner = runner;
  }

  async describeEndpoint(name) {
    try {
      return await this.runner.invoke('sagemaker', 'describe-endpoint', {
        EndpointName: name,
      });
    } catch (error) {
      if (endpointNotFound(error)) return null;
      throw error;
    }
  }

  async describeEndpointConfig(name) {
    try {
      return await this.runner.invoke('sagemaker', 'describe-endpoint-config', {
        EndpointConfigName: name,
      });
    } catch (error) {
      if (endpointNotFound(error)) return null;
      throw error;
    }
  }

  async ensureEndpoint(input) {
    const existing = await this.describeEndpoint(input.endpointName);
    if (existing) {
      if (existing.EndpointConfigName && existing.EndpointConfigName !== input.endpointConfigName) {
        throw new Session5RefusalError('ENDPOINT_IDENTITY_MISMATCH', `Existing endpoint ${input.endpointName} points at an unexpected endpoint config`);
      }
      return Object.freeze({
        ...input,
        endpointArn: existing.EndpointArn,
        endpointStatus: existing.EndpointStatus,
        createdAt: existing.CreationTime,
        lastModifiedAt: existing.LastModifiedTime,
        executionModel: ASYNC_EXECUTION_MODEL,
      });
    }

    const configExisting = await this.describeEndpointConfig(
      input.endpointConfigName,
    );
    if (configExisting) {
      const configuredModel = configExisting.ProductionVariants?.[0]?.ModelName;
      const configuredInstance = configExisting.ProductionVariants?.[0]?.InstanceType;
      if (
        configuredModel !== input.modelName ||
        configuredInstance !== input.instanceType ||
        !configExisting.AsyncInferenceConfig ||
        configExisting.AsyncInferenceConfig.OutputConfig?.S3OutputPath !== input.outputLocation ||
        (input.failureLocation && configExisting.AsyncInferenceConfig.OutputConfig?.S3FailurePath !== input.failureLocation)
      ) {
        throw new Session5RefusalError(
          'ENDPOINT_CONFIG_IDENTITY_MISMATCH',
          `Existing endpoint config ${input.endpointConfigName} does not match the pinned async identity`,
        );
      }
    } else {
      await this.runner.invoke('sagemaker', 'create-endpoint-config', {
        EndpointConfigName: input.endpointConfigName,
        ProductionVariants: [
          {
            VariantName: 'AllTraffic',
            ModelName: input.modelName,
            InitialInstanceCount: 1,
            InstanceType: input.instanceType,
            InitialVariantWeight: 1,
          },
        ],
        AsyncInferenceConfig: {
          OutputConfig: {
            S3OutputPath: input.outputLocation,
            ...(input.failureLocation ? { S3FailurePath: input.failureLocation } : {}),
            ...(input.kmsKeyId ? { KmsKeyId: input.kmsKeyId } : {}),
            ...(input.successTopic || input.errorTopic
              ? {
                  NotificationConfig: {
                    ...(input.successTopic
                      ? { SuccessTopic: input.successTopic }
                      : {}),
                    ...(input.errorTopic ? { ErrorTopic: input.errorTopic } : {}),
                    IncludeInferenceResponseIn: [
                      ...(input.successTopic
                        ? ['SUCCESS_NOTIFICATION_TOPIC']
                        : []),
                      ...(input.errorTopic ? ['ERROR_NOTIFICATION_TOPIC'] : []),
                    ],
                  },
                }
              : {}),
          },
        },
        Tags: [
          { Key: 'CapiroPhase', Value: 'phase8-session5' },
          { Key: 'CapiroExecutionModel', Value: ASYNC_EXECUTION_MODEL },
          { Key: 'CapiroEndpointIdentity', Value: input.identitySha256 },
        ],
      });
    }

    try {
      await this.runner.invoke('sagemaker', 'create-endpoint', {
        EndpointName: input.endpointName,
        EndpointConfigName: input.endpointConfigName,
        Tags: [
          { Key: 'CapiroPhase', Value: 'phase8-session5' },
          { Key: 'CapiroExecutionModel', Value: ASYNC_EXECUTION_MODEL },
          { Key: 'CapiroZeroIdle', Value: 'true' },
        ],
      });
    } catch (error) {
      const recovered = await this.describeEndpoint(input.endpointName);
      if (!recovered) throw error;
      return Object.freeze({
        ...input,
        endpointArn: recovered.EndpointArn,
        endpointStatus: recovered.EndpointStatus,
        createdAt: recovered.CreationTime,
        lastModifiedAt: recovered.LastModifiedTime,
        executionModel: ASYNC_EXECUTION_MODEL,
      });
    }
    const created = await this.describeEndpoint(input.endpointName);
    return Object.freeze({
      ...input,
      endpointArn: created?.EndpointArn,
      endpointStatus: created?.EndpointStatus || 'Creating',
      createdAt: created?.CreationTime || input.observedAt,
      lastModifiedAt: created?.LastModifiedTime,
      executionModel: ASYNC_EXECUTION_MODEL,
    });
  }

  async configureScaleToZero(endpointName) {
    const resourceId = `endpoint/${endpointName}/variant/AllTraffic`;
    await this.runner.invoke('application-autoscaling', 'register-scalable-target', {
      ServiceNamespace: 'sagemaker',
      ResourceId: resourceId,
      ScalableDimension: 'sagemaker:variant:DesiredInstanceCount',
      MinCapacity: 0,
      MaxCapacity: 1,
    });
    return this.runner.invoke('application-autoscaling', 'put-scaling-policy', {
      PolicyName: `${endpointName}-target-tracking`,
      ServiceNamespace: 'sagemaker',
      ResourceId: resourceId,
      ScalableDimension: 'sagemaker:variant:DesiredInstanceCount',
      PolicyType: 'TargetTrackingScaling',
      TargetTrackingScalingPolicyConfiguration: {
        TargetValue: 1,
        PredefinedMetricSpecification: {
          PredefinedMetricType: 'SageMakerVariantInvocationsPerInstance',
        },
        ScaleInCooldown: 60,
        ScaleOutCooldown: 60,
      },
    });
  }

  async invokeEndpointAsync(invocation) {
    return this.runner.invoke('sagemaker', 'invoke-endpoint-async', {
      EndpointName: invocation.endpointName,
      InputLocation: invocation.inputLocation,
      ContentType: invocation.contentType,
      Accept: invocation.accept,
      InferenceId: invocation.inferenceId,
    });
  }

  async listAsyncOutput(providerRun, inferenceId, outputLocation) {
    const bucket = providerRun.outputBucket;
    const prefix = `${String(providerRun.outputPrefix).replace(/\/$/, '')}/${inferenceId}`;
    const expectedKey = `${prefix}.out`;
    const exactLocation = parseS3Uri(outputLocation);
    if (exactLocation && (exactLocation.bucket !== bucket || exactLocation.key !== expectedKey)) {
      throw new Session5RefusalError('ASYNC_OUTPUT_LOCATION_MISMATCH', `Async output for ${inferenceId} is outside the configured output prefix`);
    }
    const response = await this.runner.invoke('s3api', 'list-objects-v2', {
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: 10,
    });
    const expectedKeys = new Set([expectedKey]);
    const matches = (response.Contents || [])
      .map((item) => item.Key)
      .filter((key) => expectedKeys.has(key));
    if (matches.length > 1) {
      throw new Session5RefusalError(
        'ASYNC_OUTPUT_DUPLICATE',
        `Multiple async outputs found for ${inferenceId}`,
        { matches },
      );
    }
    return matches.length ? { bucket, key: matches[0] } : null;
  }

  async deleteEndpoint(name) {
    try {
      return await this.runner.invoke('sagemaker', 'delete-endpoint', {
        EndpointName: name,
      });
    } catch (error) {
      if (endpointNotFound(error)) return {};
      throw error;
    }
  }

  async deleteEndpointConfig(name) {
    try {
      return await this.runner.invoke('sagemaker', 'delete-endpoint-config', {
        EndpointConfigName: name,
      });
    } catch (error) {
      if (endpointNotFound(error)) return {};
      throw error;
    }
  }

  async deregisterScaleToZero(endpointName) {
    try {
      return await this.runner.invoke(
        'application-autoscaling',
        'deregister-scalable-target',
        {
          ServiceNamespace: 'sagemaker',
          ResourceId: `endpoint/${endpointName}/variant/AllTraffic`,
          ScalableDimension: 'sagemaker:variant:DesiredInstanceCount',
        },
      );
    } catch (error) {
      if (endpointNotFound(error)) return {};
      throw error;
    }
  }

  async listPersistentEndpoints() {
    const response = await this.runner.invoke('sagemaker', 'list-endpoints', {
      NameContains: 'capiro-s5-async-',
      MaxResults: 100,
    });
    return response.Endpoints || [];
  }
}

function endpointAgeSeconds(job, now) {
  if (!job.endpointCreatedAt) return 0;
  const created = Date.parse(job.endpointCreatedAt);
  const current = Date.parse(now);
  return Number.isFinite(created) && Number.isFinite(current)
    ? Math.max(0, (current - created) / 1000)
    : 0;
}

function transition(job, status, at, patch = {}) {
  const allowed = {
    CAPACITY_RESERVED: ['ENDPOINT_CREATING', 'ENDPOINT_DRAINING'],
    ENDPOINT_CREATING: ['ENDPOINT_READY', 'ENDPOINT_DRAINING'],
    ENDPOINT_READY: ['REQUESTS_SUBMITTED', 'ENDPOINT_DRAINING'],
    REQUESTS_SUBMITTED: ['REQUESTS_RECONCILING', 'ENDPOINT_DRAINING'],
    REQUESTS_RECONCILING: ['ARTIFACT_VERIFIED', 'ENDPOINT_DRAINING'],
    ARTIFACT_VERIFIED: ['COMPLETION_PENDING', 'ENDPOINT_DRAINING'],
    COMPLETION_PENDING: ['RESUME_PUBLISHED', 'COMPLETION_PENDING'],
    RESUME_PUBLISHED: ['ENDPOINT_DRAINING'],
    ENDPOINT_DRAINING: ['ENDPOINT_DELETED'],
    ENDPOINT_DELETED: ['COMPLETE'],
    COMPLETE: [],
  }[job.status] || [];
  if (!allowed.includes(status)) {
    throw new Session5RefusalError(
      'INVALID_ASYNC_TRANSITION',
      `Invalid async transition ${job.status} -> ${status}`,
    );
  }
  return Object.freeze({
    ...job,
    ...patch,
    status,
    updatedAt: at,
    history: [...(job.history || []), { from: job.status, to: status, at }],
  });
}

export class AsyncNvidiaCoordinator {
  constructor(ports, config, clock = () => new Date().toISOString()) {
    this.ports = ports;
    this.config = config;
    this.clock = clock;
  }

  async submit(input) {
    validateAsyncExecutionConfig(this.config);
    if (this.config.enabled !== true) {
      throw new Session5RefusalError('ASYNC_PARSING_DISABLED', 'Async benchmark submission requires enabled parsing configuration');
    }
    if (!this.config.asyncLiveRunAuthorized) {
      throw new Session5RefusalError(
        'LIVE_RUN_AUTHORIZATION_REQUIRED',
        'Async endpoint creation and GPU invocation require explicit live-run authorization',
      );
    }
    assertSha(input.corpusSha256, 'corpusSha256');
    if (!Array.isArray(input.pages) || input.pages.length !== 10) {
      throw new Session5RefusalError(
        'CORPUS_CARDINALITY',
        'Session 5 async submission requires the frozen 10-page corpus',
      );
    }
    if (this.config.enabled !== true) {
      throw new Session5RefusalError('ASYNC_PARSING_DISABLED', 'Async benchmark submission requires enabled parsing configuration');
    }
    const endpoint = buildAsyncEndpointIdentity({
      corpusSha256: input.corpusSha256,
      modelPackageArn: this.config.modelPackageArn,
      modelVersion: this.config.modelVersion,
      runtimeContractVersion: ASYNC_RUNTIME_CONTRACT_VERSION,
      modelName: this.config.sagemakerModelName,
      executionRoleArn: this.config.executionRoleArn,
      instanceType: this.config.instanceType,
      outputBucket: this.config.outputBucket,
      outputPrefix: this.config.outputPrefix,
      failureBucket: this.config.outputBucket,
      failurePrefix: this.config.failurePrefix,
      kmsKeyId: this.config.kmsKeyId,
    });
    const existing = await this.ports.jobStore.get(endpoint.endpointName);
    if (existing) return this.reconcile(existing.jobId);

    const providerExisting = await this.ports.endpointClient.describeEndpoint(endpoint.endpointName);
    const providerConfigExisting = await this.ports.endpointClient.describeEndpointConfig(endpoint.endpointConfigName);
    if (providerExisting || providerConfigExisting) {
      const orphan = {
        schemaVersion: 'phase8_session5_async_job_v1',
        jobId: endpoint.endpointName,
        status: 'ENDPOINT_DRAINING',
        attempt: 1,
        corpusSha256: input.corpusSha256,
        pages: input.pages,
        reservationId: `${endpoint.endpointName}#endpoint`,
        reservedCostUsd: computeMaximumEndpointReservationUsd(this.config),
        endpoint,
        endpointCreatedAt: providerExisting?.CreationTime,
        endpointLastModifiedAt: providerExisting?.LastModifiedTime,
        endpointProviderStatus: providerExisting?.EndpointStatus,
        executionModel: ASYNC_EXECUTION_MODEL,
        createdAt: this.clock(),
        updatedAt: this.clock(),
        history: [{ from: 'ORPHANED_PROVIDER_RESOURCE', to: 'ENDPOINT_DRAINING', at: this.clock() }],
      };
      await this.ports.jobStore.put(orphan);
      return this.drain(orphan);
    }

    const reservationId = `${endpoint.endpointName}#endpoint`;
    const reservedCostUsd = computeMaximumEndpointReservationUsd(this.config);
    await this.ports.reservationLedger.reserve({
      reservationId,
      jobId: endpoint.endpointName,
      attempt: 1,
      reservedCostUsd,
      effectiveCapUsd: this.config.effectiveSpendCapUsd,
      hardCapUsd: this.config.hardIncrementalCapUsd,
      maxConcurrent: 1,
      at: this.clock(),
      resourceKind: 'async_endpoint',
    });
    let job = {
      schemaVersion: 'phase8_session5_async_job_v1',
      jobId: endpoint.endpointName,
      status: 'CAPACITY_RESERVED',
      attempt: 1,
      corpusSha256: input.corpusSha256,
      pages: input.pages,
      reservationId,
      reservedCostUsd,
      endpoint,
      createdAt: this.clock(),
      updatedAt: this.clock(),
      executionModel: ASYNC_EXECUTION_MODEL,
      history: [],
    };
    try {
      await this.ports.jobStore.put(job);
    } catch (error) {
      await this.ports.reservationLedger.release({ reservationId, reason: 'JOB_STATE_PERSISTENCE_FAILED', at: this.clock() });
      throw error;
    }
    return this.reconcile(job.jobId);
  }

  async reconcile(jobId) {
    let job = await this.ports.jobStore.get(jobId);
    if (!job) {
      throw new Session5RefusalError('ASYNC_JOB_NOT_FOUND', jobId);
    }
    const now = this.clock();
    const endpointName = job.endpoint.endpointName;
    const description = await this.ports.endpointClient.describeEndpoint(endpointName);

    if (job.status === 'ENDPOINT_DRAINING') {
      if (description) {
        await this.ports.endpointClient.deleteEndpoint(endpointName);
        return job;
      }
      return this.#finishDrain(job);
    }

    if (
      ['CAPACITY_RESERVED', 'ENDPOINT_CREATING'].includes(job.status) &&
      !description
    ) {
      let run;
      try {
        run = await this.ports.endpointClient.ensureEndpoint({
          endpointName,
          endpointConfigName: job.endpoint.endpointConfigName,
          identitySha256: job.endpoint.identitySha256,
          modelName: this.config.sagemakerModelName,
          instanceType: this.config.instanceType,
          outputLocation: `s3://${this.config.outputBucket}/${this.config.outputPrefix}/`,
          failureLocation: `s3://${this.config.outputBucket}/${this.config.failurePrefix}/`,
          executionRoleArn: this.config.executionRoleArn,
          kmsKeyId: this.config.kmsKeyId,
          observedAt: now,
        });
      } catch (error) {
        await this.ports.jobStore.put({
          ...job,
          failureCode: 'ENDPOINT_CREATE_FAILED',
          failureMessage: String(error?.message ?? error),
          updatedAt: now,
        });
        return this.drain(job);
      }
      job = transition(job, 'ENDPOINT_CREATING', now, {
        endpointCreatedAt: run.createdAt || job.endpointCreatedAt || now,
        endpointLastModifiedAt: run.lastModifiedAt,
        endpointRun: {
          ...run,
          outputBucket: this.config.outputBucket,
          outputPrefix: this.config.outputPrefix,
        },
      });
      await this.ports.jobStore.put(job);
      await this.ports.endpointClient.configureScaleToZero(endpointName);
    }

    const current = await this.ports.endpointClient.describeEndpoint(endpointName);
    if (!current) {
      if (['RESUME_PUBLISHED', 'ENDPOINT_DRAINING', 'ENDPOINT_DELETED'].includes(job.status)) {
        return this.#finishDrain(job);
      }
      if (!['CAPACITY_RESERVED', 'ENDPOINT_CREATING'].includes(job.status)) {
        return this.drain(job);
      }
      if (endpointAgeSeconds(job, now) > this.config.maxEndpointLifetimeSeconds) {
        return this.drain(job);
      }
      return job;
    }

    job = {
      ...job,
      endpointLastModifiedAt: current.LastModifiedTime || job.endpointLastModifiedAt,
      endpointProviderStatus: current.EndpointStatus,
      updatedAt: now,
    };
    if (current.EndpointStatus === 'Failed') {
      await this.ports.jobStore.put(job);
      return this.drain({ ...job, failureCode: 'ENDPOINT_FAILED' });
    }
    if (endpointAgeSeconds(job, now) > this.config.maxEndpointLifetimeSeconds) {
      await this.ports.jobStore.put(job);
      return this.drain(job);
    }
    if (current.EndpointStatus !== 'InService') {
      if (current.EndpointStatus === 'Deleting') return job;
      if (job.status !== 'ENDPOINT_CREATING') {
        job = transition(job, 'ENDPOINT_CREATING', now);
      }
      await this.ports.jobStore.put(job);
      return job;
    }
    if (job.status === 'CAPACITY_RESERVED') {
      job = transition(job, 'ENDPOINT_CREATING', now, {
        endpointCreatedAt: current.CreationTime || job.endpointCreatedAt || now,
        endpointLastModifiedAt: current.LastModifiedTime || job.endpointLastModifiedAt,
      });
      await this.ports.jobStore.put(job);
    }
    if (job.status === 'ENDPOINT_CREATING') {
      job = transition(job, 'ENDPOINT_READY', now, {
        endpointReadyAt: current.LastModifiedTime || now,
      });
      await this.ports.jobStore.put(job);
    }
    if (job.status === 'ENDPOINT_READY') {
      return this.#submitRequests(job);
    }
    if (job.status === 'REQUESTS_SUBMITTED') {
      job = transition(job, 'REQUESTS_RECONCILING', now);
      await this.ports.jobStore.put(job);
    }
    if (job.status === 'REQUESTS_RECONCILING') {
      return this.#reconcileOutputs(job);
    }
    if (job.status === 'ARTIFACT_VERIFIED') {
      job = transition(job, 'COMPLETION_PENDING', now);
      await this.ports.jobStore.put(job);
    }
    if (job.status === 'COMPLETION_PENDING') {
      return this.#publishCompletion(job);
    }
    if (job.status === 'RESUME_PUBLISHED') return this.drain(job);
    return job;
  }

  async #submitRequests(initialJob) {
    const pages = initialJob.pages;
    const invocations = [...(initialJob.invocations || [])];
    let job = transition(initialJob, 'REQUESTS_SUBMITTED', this.clock(), {
      invocations,
    });
    await this.ports.jobStore.put(job);
    for (const page of pages) {
      const manifest = buildProviderManifest({
        batchId: buildAsyncInferenceId({
          endpointName: job.endpoint.endpointName,
          page,
          attempt: job.attempt,
        }),
        sourceDocumentId: page.sourceDocumentId || job.jobId,
        sourceSha256: page.sourceSha256 || job.corpusSha256,
        parserMethod: page.parserMethod,
        modelName: page.modelName,
        modelVersion: page.modelVersion,
        parserOptionsHash: page.parserOptionsHash,
        pages: [page],
      }, { executionModel: ASYNC_EXECUTION_MODEL });
      const stored = await this.ports.artifactStore.putManifestBundle({
        batch: {
          batchId: buildAsyncInferenceId({ endpointName: job.endpoint.endpointName, page, attempt: job.attempt }),
          sourceDocumentId: page.sourceDocumentId || job.jobId,
          sourceSha256: page.sourceSha256 || job.corpusSha256,
          parserMethod: page.parserMethod,
          modelName: page.modelName,
          modelVersion: page.modelVersion,
          parserOptionsHash: page.parserOptionsHash,
          pages: [page],
        },
        body: manifest.body,
        bodySha256: manifest.bodySha256,
        sidecar: manifest.sidecar,
      });
      const invocation = buildAsyncInvocation({
        endpointName: job.endpoint.endpointName,
        endpointConfigName: job.endpoint.endpointConfigName,
        page,
        attempt: job.attempt,
        inputLocation: stored.s3Uri,
      });
      const already = invocations.find((item) => item.inferenceId === invocation.inferenceId);
      if (already) continue;
      const output = await this.ports.endpointClient.listAsyncOutput(
        { outputBucket: this.config.outputBucket, outputPrefix: this.config.outputPrefix },
        invocation.inferenceId,
      );
      const response = output
        ? { InferenceId: invocation.inferenceId, OutputLocation: `s3://${output.bucket}/${output.key}` }
        : await this.ports.endpointClient.invokeEndpointAsync(invocation);
      invocations.push({
        ...invocation,
        manifest: stored,
        sidecar: manifest.sidecar,
        outputLocation: response.OutputLocation || null,
        submittedAt: this.clock(),
      });
      job = { ...job, invocations, updatedAt: this.clock() };
      await this.ports.jobStore.put(job);
    }
    job = transition(job, 'REQUESTS_RECONCILING', this.clock(), { invocations });
    await this.ports.jobStore.put(job);
    return job;
  }

  async #reconcileOutputs(job) {
    const normalizedArtifacts = [];
    for (const invocation of job.invocations || []) {
      const output = await this.ports.endpointClient.listAsyncOutput(
        { outputBucket: this.config.outputBucket, outputPrefix: this.config.outputPrefix },
        invocation.inferenceId,
        invocation.outputLocation,
      );
      if (!output) return job;
      const rawOutputText = await this.ports.artifactStore.readRawProviderOutput(output);
      const expectedRawSha = sha256Hex(rawOutputText);
      const sidecar = invocation.sidecar;
      const normalized = normalizeProviderOutputJsonLines({
        rawOutputText,
        sidecar,
        providerRunIdentity: {
          executionModel: ASYNC_EXECUTION_MODEL,
          endpointName: job.endpoint.endpointName,
          endpointConfigName: job.endpoint.endpointConfigName,
          inferenceId: invocation.inferenceId,
          rawOutputSha256: expectedRawSha,
        },
      });
      for (const artifact of normalized.pages) {
        verifyNormalizedPageArtifact(artifact, invocation.provenance);
        await this.ports.artifactStore.putVerifiedArtifact({
          cacheKey: artifact.cacheKey,
          artifact,
          contentSha256: artifact.contentSha256,
        });
        normalizedArtifacts.push({
          pageNumber: artifact.pageNumber,
          output,
          rawOutputSha256: expectedRawSha,
          normalizedOutputSha256: artifact.contentSha256,
        });
      }
    }
    let verified = transition(job, 'ARTIFACT_VERIFIED', this.clock(), {
      normalizedArtifacts,
    });
    await this.ports.jobStore.put(verified);
    verified = transition(verified, 'COMPLETION_PENDING', this.clock());
    await this.ports.jobStore.put(verified);
    return this.#publishCompletion(verified);
  }

  async #publishCompletion(job) {
    const attempts = Number(job.completionPublishAttempts || 0) + 1;
    try {
      await this.ports.completionQueue.publish({
        schemaVersion: 'nvidia_parser_async_completion_v1',
        executionModel: ASYNC_EXECUTION_MODEL,
        jobId: job.jobId,
        corpusSha256: job.corpusSha256,
        endpointName: job.endpoint.endpointName,
        endpointConfigName: job.endpoint.endpointConfigName,
        artifacts: job.normalizedArtifacts,
      });
    } catch (error) {
      const pending = { ...job, completionPublishAttempts: attempts, completionPublishError: String(error?.message || error), updatedAt: this.clock() };
      await this.ports.jobStore.put(pending);
      return pending;
    }
    const published = transition(job, 'RESUME_PUBLISHED', this.clock(), {
      completionPublishAttempts: attempts,
      completionPublishedAt: this.clock(),
      completionPublishError: null,
    });
    await this.ports.jobStore.put(published);
    return this.drain(published);
  }

  async drain(job) {
    if (!['ENDPOINT_DRAINING', 'ENDPOINT_DELETED', 'COMPLETE'].includes(job.status)) {
      job = transition(job, 'ENDPOINT_DRAINING', this.clock(), {
        endpointDeleteRequestedAt: this.clock(),
      });
      await this.ports.jobStore.put(job);
    }
    const endpoint = await this.ports.endpointClient.describeEndpoint(job.endpoint.endpointName);
    if (endpoint) {
      if (endpoint.EndpointStatus === 'Deleting') return job;
      await this.ports.endpointClient.deleteEndpoint(job.endpoint.endpointName);
      return job;
    }
    return this.#finishDrain(job);
  }

  async #finishDrain(job) {
    await this.ports.endpointClient.deregisterScaleToZero(job.endpoint.endpointName);
    const endpointConfig = await this.ports.endpointClient.describeEndpointConfig(
      job.endpoint.endpointConfigName,
    );
    if (endpointConfig) {
      await this.ports.endpointClient.deleteEndpointConfig(
        job.endpoint.endpointConfigName,
      );
      const deleted = transition(job, 'ENDPOINT_DELETED', this.clock(), {
        endpointDeletedAt: this.clock(),
      });
      await this.ports.jobStore.put(deleted);
      return deleted;
    }
    if (job.status === 'ENDPOINT_DELETED') {
      const actualCostUsd = this.#reconciledEndpointCost(job);
      await this.ports.reservationLedger.settle({
        reservationId: job.reservationId,
        reconciledCostUsd: actualCostUsd,
        effectiveCapUsd: this.config.effectiveSpendCapUsd,
        hardCapUsd: this.config.hardIncrementalCapUsd,
        at: this.clock(),
      });
      const complete = transition(job, 'COMPLETE', this.clock(), {
        reconciledCostUsd: actualCostUsd,
      });
      await this.ports.jobStore.put(complete);
      return complete;
    }
    const deleted = transition(job, 'ENDPOINT_DELETED', this.clock(), {
      endpointDeletedAt: this.clock(),
    });
    await this.ports.jobStore.put(deleted);
    return deleted;
  }

  #reconciledEndpointCost(job) {
    const start = Date.parse(job.endpointCreatedAt || job.createdAt);
    const providerEnd = Date.parse(job.endpointDeletedAt || this.clock());
    const seconds = Number.isFinite(start) && Number.isFinite(providerEnd)
      ? Math.min(this.config.maxEndpointLifetimeSeconds, Math.max(0, (providerEnd - start) / 1000))
      : 0;
    const hourly = this.config.marketplaceUsdPerHostHour + this.config.instanceUsdPerHour;
    const reconciled = Number(((seconds / 3600) * hourly).toFixed(6));
    return Math.min(reconciled, Number(this.config.effectiveSpendCapUsd));
  }

  async zeroIdleProof() {
    const ledger = await this.ports.reservationLedger.snapshot();
    const endpoints = await this.ports.endpointClient.listPersistentEndpoints();
    return Object.freeze({
      activeJobs: ledger.activeJobs,
      spentAndReservedUsd: ledger.spentAndReservedUsd,
      persistentEndpoints: endpoints,
      zeroIdleGpu: ledger.activeJobs === 0 && endpoints.length === 0,
      checkedAt: this.clock(),
    });
  }
}

export { transition as asyncJobTransition };
