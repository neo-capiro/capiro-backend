import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  AwsCliCloudWatchMetrics,
  AwsCliRunner,
  AwsCliSageMakerBatchTransformAdapter,
  AwsCliSqsPublisher,
  canonicalJson,
  sha256Hex,
} from './session5.mjs';

const execFileAsync = promisify(execFile);
const ACTIVE_STATUSES = new Set(['PLANNED', 'MANIFEST_WRITTEN', 'SUBMITTED', 'RUNNING']);

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

export class AwsCliS3RuntimeStore {
  constructor(runner, config) {
    this.runner = runner;
    this.config = config;
  }

  async #exec(args) {
    const { stdout } = await execFileAsync(
      this.runner.binary,
      [...args, '--region', this.runner.region, '--output', 'json'],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    return stdout.trim() ? JSON.parse(stdout) : {};
  }

  async head(cacheKey) {
    const key = `${this.config.outputPrefix}/artifacts/${cacheKey}.json`;
    try {
      const result = await this.runner.invoke('s3api', 'head-object', {
        Bucket: this.config.outputBucket,
        Key: key,
      });
      return {
        s3Uri: `s3://${this.config.outputBucket}/${key}`,
        eTag: result.ETag,
        metadata: result.Metadata,
      };
    } catch (error) {
      const text = String(error?.stderr ?? error?.message ?? error);
      if (/404|NoSuchKey|Not Found/i.test(text)) return null;
      throw error;
    }
  }

  async putManifest({ batchId, body, sha256 }) {
    return withTempFile('capiro-nvidia-manifest-', body, async (path) => {
      const key = `${this.config.inputPrefix}/${batchId}/${sha256}.jsonl`;
      await this.#exec([
        's3api',
        'put-object',
        '--bucket',
        this.config.inputBucket,
        '--key',
        key,
        '--body',
        path,
        '--content-type',
        'application/jsonlines',
        '--metadata',
        `sha256=${sha256},immutable=true,session=phase8-session5`,
      ]);
      return {
        s3Uri: `s3://${this.config.inputBucket}/${key}`,
        bucket: this.config.inputBucket,
        key,
        sha256,
      };
    });
  }

  async readProviderOutput(output) {
    if (output.body !== undefined) {
      return typeof output.body === 'string' ? JSON.parse(output.body) : output.body;
    }
    const directory = await mkdtemp(join(tmpdir(), 'capiro-nvidia-output-'));
    try {
      const path = join(directory, 'output.json');
      await this.#exec([
        's3api',
        'get-object',
        '--bucket',
        output.bucket,
        '--key',
        output.key,
        path,
      ]);
      return JSON.parse(await readFile(path, 'utf8'));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async putVerifiedArtifact({ cacheKey, artifact, contentSha256 }) {
    return withTempFile(
      'capiro-nvidia-artifact-',
      canonicalJson(artifact),
      async (path) => {
        const key = `${this.config.outputPrefix}/artifacts/${cacheKey}.json`;
        await this.#exec([
          's3api',
          'put-object',
          '--bucket',
          this.config.outputBucket,
          '--key',
          key,
          '--body',
          path,
          '--content-type',
          'application/json',
          '--metadata',
          `sha256=${contentSha256},immutable=true,cachekey=${cacheKey}`,
        ]);
        return {
          s3Uri: `s3://${this.config.outputBucket}/${key}`,
          contentSha256,
        };
      },
    );
  }
}

/**
 * S3-backed append-only job state. Every state transition is written as an
 * immutable event object and the latest materialized state is updated under a
 * deterministic key. Session 5 is benchmark/fallback only, so list operations
 * remain deliberately bounded to the dedicated prefix.
 */
export class AwsCliS3JobStore {
  constructor(runner, config) {
    this.runner = runner;
    this.config = config;
    this.bucket = config.outputBucket;
    this.prefix = `${config.outputPrefix}/job-state`;
  }

  async #exec(args) {
    const { stdout } = await execFileAsync(
      this.runner.binary,
      [...args, '--region', this.runner.region, '--output', 'json'],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    return stdout.trim() ? JSON.parse(stdout) : {};
  }

  async #putJson(key, value, metadata = '') {
    return withTempFile('capiro-nvidia-job-', canonicalJson(value), async (path) => {
      const args = [
        's3api',
        'put-object',
        '--bucket',
        this.bucket,
        '--key',
        key,
        '--body',
        path,
        '--content-type',
        'application/json',
      ];
      if (metadata) args.push('--metadata', metadata);
      return this.#exec(args);
    });
  }

  async #getJson(key) {
    const directory = await mkdtemp(join(tmpdir(), 'capiro-nvidia-job-read-'));
    try {
      const path = join(directory, 'state.json');
      await this.#exec([
        's3api',
        'get-object',
        '--bucket',
        this.bucket,
        '--key',
        key,
        path,
      ]);
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      const text = String(error?.stderr ?? error?.message ?? error);
      if (/404|NoSuchKey|Not Found/i.test(text)) return null;
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async put(job) {
    const stateHash = sha256Hex(job);
    const timestamp = String(job.updatedAt ?? new Date().toISOString())
      .replaceAll(':', '')
      .replaceAll('.', '');
    const eventKey = `${this.prefix}/events/${job.jobId}/${timestamp}-${job.status}-${stateHash}.json`;
    const latestKey = `${this.prefix}/latest/${job.jobId}.json`;
    await this.#putJson(
      eventKey,
      job,
      `sha256=${stateHash},immutable=true,status=${job.status}`,
    );
    await this.#putJson(
      latestKey,
      job,
      `sha256=${stateHash},status=${job.status}`,
    );
    return job;
  }

  async get(jobId) {
    return this.#getJson(`${this.prefix}/latest/${jobId}.json`);
  }

  async #listLatestKeys() {
    const response = await this.runner.invoke('s3api', 'list-objects-v2', {
      Bucket: this.bucket,
      Prefix: `${this.prefix}/latest/`,
      MaxKeys: 1000,
    });
    if (response.IsTruncated) {
      throw new Error(
        'Session 5 job-state listing exceeded 1,000 entries; replace benchmark S3 store with indexed production store before increasing scope',
      );
    }
    return (response.Contents ?? []).map((item) => item.Key).filter(Boolean);
  }

  async #allLatest() {
    const states = [];
    for (const key of await this.#listLatestKeys()) {
      const state = await this.#getJson(key);
      if (state) states.push(state);
    }
    return states;
  }

  async countActive() {
    return (await this.#allLatest()).filter((job) => ACTIVE_STATUSES.has(job.status)).length;
  }

  async monthSpendUsd(nowIso) {
    const month = String(nowIso).slice(0, 7);
    return (await this.#allLatest())
      .filter((job) => String(job.completedAt ?? job.updatedAt ?? '').startsWith(month))
      .reduce((sum, job) => sum + Number(job.actualCostUsd ?? 0), 0);
  }
}

export function createAwsRuntimePorts(config, options = {}) {
  const runner = options.runner ?? new AwsCliRunner({ region: config.region });
  return {
    artifactStore: new AwsCliS3RuntimeStore(runner, config),
    batchClient: new AwsCliSageMakerBatchTransformAdapter(runner),
    jobStore: new AwsCliS3JobStore(runner, config),
    completionQueue: new AwsCliSqsPublisher(runner, config.completionQueueUrl),
    dlq: new AwsCliSqsPublisher(runner, config.dlqUrl),
    metrics: new AwsCliCloudWatchMetrics(runner),
  };
}
