import { execFile } from 'node:child_process';
import { basename, join } from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import {
  canonicalJson,
  sha256Hex,
  Session5RefusalError,
} from './session5.mjs';
import {
  REAL_BATCH_ASSEMBLE_WITH,
  REAL_BATCH_INPUT_CONTENT_TYPE,
  REAL_BATCH_OUTPUT_ACCEPT,
  REAL_BATCH_SPLIT_TYPE,
} from './real-batch-config.mjs';

const execFileAsync = promisify(execFile);
const RECONCILE_STATUSES = new Set([
  'PLANNED',
  'RETRY_PLANNED',
  'RESERVED',
  'MANIFEST_WRITTEN',
  'SUBMITTED',
  'RUNNING',
  'ARTIFACT_VERIFIED',
  'COMPLETION_PENDING',
]);

async function withTempFile(prefix, contents, fn) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    const path = join(directory, 'payload');
    await writeFile(path, contents);
    return await fn(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export class AwsCliS3RealBatchStore {
  constructor(runner, config) {
    this.runner = runner;
    this.config = config;
    this.bucket = config.outputBucket;
    this.jobPrefix = `${config.outputPrefix}/job-state-v2`;
  }

  async #exec(args) {
    const { stdout } = await execFileAsync(
      this.runner.binary,
      [...args, '--region', this.runner.region, '--output', 'json'],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout.trim() ? JSON.parse(stdout) : {};
  }

  async #putText(bucket, key, contents, contentType, metadata = '') {
    return withTempFile('capiro-s5-real-', contents, async (path) => {
      const args = [
        's3api',
        'put-object',
        '--bucket',
        bucket,
        '--key',
        key,
        '--body',
        path,
        '--content-type',
        contentType,
      ];
      if (metadata) args.push('--metadata', metadata);
      await this.#exec(args);
      return { bucket, key, s3Uri: `s3://${bucket}/${key}` };
    });
  }

  async #getText(bucket, key) {
    const directory = await mkdtemp(join(tmpdir(), 'capiro-s5-real-read-'));
    try {
      const path = join(directory, 'object');
      await this.#exec([
        's3api',
        'get-object',
        '--bucket',
        bucket,
        '--key',
        key,
        path,
      ]);
      return readFile(path, 'utf8');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async #getJson(bucket, key) {
    try {
      return JSON.parse(await this.#getText(bucket, key));
    } catch (error) {
      const message = String(error?.stderr ?? error?.message ?? error);
      if (/404|NoSuchKey|Not Found/i.test(message)) return null;
      throw error;
    }
  }

  async putManifestBundle({ batch, body, bodySha256, sidecar }) {
    const base = `${this.config.inputPrefix}/${batch.batchId}`;
    const manifestKey = `${base}/${bodySha256}.jsonl`;
    const sidecarKey = `${base}/${sidecar.contentSha256}.sidecar.json`;
    await this.#putText(
      this.config.inputBucket,
      manifestKey,
      body,
      REAL_BATCH_INPUT_CONTENT_TYPE,
      `sha256=${bodySha256},immutable=true,session=phase8-session5`,
    );
    await this.#putText(
      this.config.inputBucket,
      sidecarKey,
      canonicalJson(sidecar),
      'application/json',
      `sha256=${sidecar.contentSha256},immutable=true,session=phase8-session5`,
    );
    return Object.freeze({
      bucket: this.config.inputBucket,
      key: manifestKey,
      s3Uri: `s3://${this.config.inputBucket}/${manifestKey}`,
      bodySha256,
      sidecarBucket: this.config.inputBucket,
      sidecarKey,
      sidecarSha256: sidecar.contentSha256,
    });
  }

  async readManifestSidecar(manifest) {
    const sidecar = await this.#getJson(
      manifest.sidecarBucket,
      manifest.sidecarKey,
    );
    if (!sidecar) throw new Error(`Missing input sidecar ${manifest.sidecarKey}`);
    return sidecar;
  }

  async readRawProviderOutput(output) {
    return this.#getText(output.bucket, output.key);
  }

  async putBatchDefinition(batch) {
    const key = `${this.config.outputPrefix}/batch-definitions/${batch.batchId}.json`;
    const existing = await this.#getJson(this.bucket, key);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(batch)) {
        throw new Session5RefusalError(
          'BATCH_DEFINITION_CONFLICT',
          `Immutable batch definition changed for ${batch.batchId}`,
        );
      }
      return existing;
    }
    await this.#putText(
      this.bucket,
      key,
      canonicalJson(batch),
      'application/json',
      `sha256=${sha256Hex(batch)},immutable=true,session=phase8-session5`,
    );
    return batch;
  }

  async getBatchDefinition(batchId) {
    return this.#getJson(
      this.bucket,
      `${this.config.outputPrefix}/batch-definitions/${batchId}.json`,
    );
  }

  async getCachedArtifact(cacheKey) {
    const key = `${this.config.normalizedPrefix ?? `${this.config.outputPrefix}/artifacts-v2`}/${cacheKey}.json`;
    const head = await this.#head(this.bucket, key);
    if (!head) return null;
    const artifact = await this.#getJson(this.bucket, key);
    if (!artifact) return null;
    const expectedMetadataHash = head.Metadata?.sha256;
    if (
      expectedMetadataHash &&
      expectedMetadataHash !== artifact.contentSha256
    ) {
      throw new Session5RefusalError(
        'CACHE_METADATA_HASH_MISMATCH',
        `Cached artifact metadata SHA does not match body for ${cacheKey}`,
      );
    }
    const withoutHash = { ...artifact };
    delete withoutHash.contentSha256;
    if (sha256Hex(withoutHash) !== artifact.contentSha256) {
      throw new Session5RefusalError(
        'CACHE_BODY_HASH_MISMATCH',
        `Cached artifact body hash does not match ${cacheKey}`,
      );
    }
    if (artifact.cacheKey !== cacheKey) {
      throw new Session5RefusalError(
        'CACHE_KEY_MISMATCH',
        `Cached artifact body is stored under the wrong cache key ${cacheKey}`,
      );
    }
    return artifact;
  }

  async putVerifiedArtifact({ cacheKey, artifact, contentSha256 }) {
    const key = `${this.config.normalizedPrefix ?? `${this.config.outputPrefix}/artifacts-v2`}/${cacheKey}.json`;
    if (artifact.cacheKey !== cacheKey) {
      throw new Session5RefusalError(
        'CACHE_KEY_MISMATCH',
        `Verified artifact identity does not match cache key ${cacheKey}`,
      );
    }
    const withoutHash = { ...artifact };
    delete withoutHash.contentSha256;
    if (sha256Hex(withoutHash) !== contentSha256) {
      throw new Session5RefusalError(
        'CACHE_BODY_HASH_MISMATCH',
        `Verified artifact body hash does not match ${cacheKey}`,
      );
    }
    const existing = await this.#head(this.bucket, key);
    if (existing) {
      const current = await this.#getJson(this.bucket, key);
      if (current?.contentSha256 !== contentSha256) {
        throw new Session5RefusalError(
          'CACHE_WRITE_CONFLICT',
          `Immutable cache key ${cacheKey} already contains different content`,
        );
      }
      return {
        s3Uri: `s3://${this.bucket}/${key}`,
        contentSha256,
        cached: true,
      };
    }
    await this.#putText(
      this.bucket,
      key,
      canonicalJson(artifact),
      'application/json',
      `sha256=${contentSha256},immutable=true,cachekey=${cacheKey}`,
    );
    return {
      s3Uri: `s3://${this.bucket}/${key}`,
      contentSha256,
      cached: false,
    };
  }

  async #head(bucket, key) {
    try {
      return await this.runner.invoke('s3api', 'head-object', {
        Bucket: bucket,
        Key: key,
      });
    } catch (error) {
      const message = String(error?.stderr ?? error?.message ?? error);
      if (/404|NoSuchKey|Not Found/i.test(message)) return null;
      throw error;
    }
  }

  async put(job) {
    const stateHash = sha256Hex(job);
    const timestamp = String(job.updatedAt ?? new Date().toISOString())
      .replaceAll(':', '')
      .replaceAll('.', '');
    const eventKey = `${this.jobPrefix}/events/${job.jobId}/${timestamp}-${job.status}-${stateHash}.json`;
    const latestKey = `${this.jobPrefix}/latest/${job.jobId}.json`;
    await this.#putText(
      this.bucket,
      eventKey,
      canonicalJson(job),
      'application/json',
      `sha256=${stateHash},immutable=true,status=${job.status}`,
    );
    await this.#putText(
      this.bucket,
      latestKey,
      canonicalJson(job),
      'application/json',
      `sha256=${stateHash},status=${job.status}`,
    );
    return job;
  }

  async get(jobId) {
    return this.#getJson(
      this.bucket,
      `${this.jobPrefix}/latest/${jobId}.json`,
    );
  }

  async #listLatestKeys() {
    const response = await this.runner.invoke('s3api', 'list-objects-v2', {
      Bucket: this.bucket,
      Prefix: `${this.jobPrefix}/latest/`,
      MaxKeys: 1000,
    });
    if (response.IsTruncated) {
      throw new Error('Session 5 reconcile candidate list exceeded 1,000 jobs');
    }
    return (response.Contents ?? []).map((item) => item.Key).filter(Boolean);
  }

  async listReconcileCandidates() {
    const jobs = [];
    for (const key of await this.#listLatestKeys()) {
      const job = await this.#getJson(this.bucket, key);
      if (
        job &&
        (RECONCILE_STATUSES.has(job.status) || job.dlqPublishPending === true)
      ) {
        jobs.push(job);
      }
    }
    return jobs.sort((a, b) => String(a.jobId).localeCompare(String(b.jobId)));
  }
}

export class SafeAwsCliSageMakerBatchTransformAdapter {
  constructor(runner) {
    this.runner = runner;
  }

  async ensureTransformJob({ transformJobName, batch, manifest, config }) {
    const existing = await this.#describeIfExists(transformJobName);
    if (existing) {
      return this.#handleFromDescription(existing, manifest, config);
    }

    const outputPrefix = `${config.outputPrefix}/provider-raw/${batch.batchId}/attempt-${transformJobName.slice(-2)}`;
    const outputUri = `s3://${config.outputBucket}/${outputPrefix}/`;
    try {
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
          ContentType: REAL_BATCH_INPUT_CONTENT_TYPE,
          SplitType: REAL_BATCH_SPLIT_TYPE,
        },
        TransformOutput: {
          S3OutputPath: outputUri,
          Accept: REAL_BATCH_OUTPUT_ACCEPT,
          AssembleWith: REAL_BATCH_ASSEMBLE_WITH,
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
    } catch (error) {
      const recovered = await this.#describeIfExists(transformJobName);
      if (!recovered) throw error;
      return this.#handleFromDescription(recovered, manifest, config);
    }
    const created = await this.#describeIfExists(transformJobName);
    return Object.freeze({
      transformJobName,
      outputBucket: config.outputBucket,
      outputPrefix,
      manifestBucket: manifest.bucket,
      manifestKey: manifest.key,
      submittedAt: created?.CreationTime ?? new Date().toISOString(),
      executionModel: 'sagemaker_batch_transform',
    });
  }

  #handleFromDescription(description, manifest, config) {
    const outputUri = description.TransformOutput?.S3OutputPath ?? '';
    const match = /^s3:\/\/([^/]+)\/(.*)\/?$/.exec(outputUri);
    return Object.freeze({
      transformJobName: description.TransformJobName,
      transformJobArn: description.TransformJobArn,
      outputBucket: match?.[1] ?? config.outputBucket,
      outputPrefix: (
        match?.[2] ?? `${config.outputPrefix}/provider-raw`
      ).replace(/\/$/, ''),
      manifestBucket: manifest.bucket,
      manifestKey: manifest.key,
      submittedAt: description.CreationTime ?? new Date().toISOString(),
      executionModel: 'sagemaker_batch_transform',
    });
  }

  async #describeIfExists(name) {
    try {
      return await this.describeTransformJob(name);
    } catch (error) {
      const message = String(error?.stderr ?? error?.message ?? error);
      if (/Could not find|ValidationException|does not exist|not found/i.test(message)) {
        return null;
      }
      throw error;
    }
  }

  async confirmTransformJobAbsent(name) {
    return (await this.#describeIfExists(name)) === null;
  }

  async describeTransformJob(name) {
    return this.runner.invoke('sagemaker', 'describe-transform-job', {
      TransformJobName: name,
    });
  }

  async stopTransformJob(name) {
    return this.runner.invoke('sagemaker', 'stop-transform-job', {
      TransformJobName: name,
    });
  }

  async resolveOutputObject(providerRun) {
    const response = await this.runner.invoke('s3api', 'list-objects-v2', {
      Bucket: providerRun.outputBucket,
      Prefix: `${providerRun.outputPrefix}/`,
      MaxKeys: 100,
    });
    const expectedSuffix = `${basename(providerRun.manifestKey)}.out`;
    const matches = (response.Contents ?? [])
      .map((item) => item.Key)
      .filter((key) => key && key.endsWith(expectedSuffix));
    if (matches.length !== 1) {
      throw new Session5RefusalError(
        'PROVIDER_OUTPUT_OBJECT_MISMATCH',
        `Expected one provider .out object ending ${expectedSuffix}, found ${matches.length}`,
        { matches },
      );
    }
    return { bucket: providerRun.outputBucket, key: matches[0] };
  }

  async listActiveTransformJobs() {
    const active = [];
    for (const status of ['InProgress', 'Stopping']) {
      let token;
      do {
        const response = await this.runner.invoke(
          'sagemaker',
          'list-transform-jobs',
          {
            StatusEquals: status,
            NameContains: 'capiro-s5-',
            MaxResults: 100,
            ...(token ? { NextToken: token } : {}),
          },
        );
        active.push(...(response.TransformJobSummaries ?? []));
        token = response.NextToken;
      } while (token);
    }
    return active;
  }

  async listPersistentEndpoints() {
    const response = await this.runner.invoke('sagemaker', 'list-endpoints', {
      NameContains: 'capiro-defense-nvidia',
      MaxResults: 100,
    });
    return response.Endpoints ?? [];
  }
}

export class AwsCliParserMetrics {
  constructor(runner, namespace = 'Capiro/DefenseParser') {
    this.runner = runner;
    this.namespace = namespace;
  }

  async put(metricName, value, dimensions = {}) {
    const unit = metricName === 'NvidiaMonthlySpendUsd' ? 'None' : 'Count';
    return this.runner.invoke('cloudwatch', 'put-metric-data', {
      Namespace: this.namespace,
      MetricData: [
        {
          MetricName: metricName,
          Value: Number(value),
          Unit: unit,
          Dimensions: Object.entries(dimensions).map(([Name, Value]) => ({
            Name,
            Value: String(Value),
          })),
        },
      ],
    });
  }
}
