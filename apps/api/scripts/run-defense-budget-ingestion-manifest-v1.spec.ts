import { createHash } from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';

import {
  attestIngestionManifestEcsRuntimeV1,
  assertIngestionManifestRuntimeV1,
  ingestionManifestRuntimeConfigSha256V1,
  IngestionManifestUsageErrorV1,
  loadIngestionManifestInputV1,
  parseIngestionManifestArgsV1,
  parseVersionedManifestS3UriV1,
} from './run-defense-budget-ingestion-manifest-v1.js';
import type { IngestionManifestV1 } from '../src/defense-budget/governed-ingestion-manifest/ingestion-manifest-contract-v1.js';

describe('Package E manifest CLI immutable input', () => {
  const sha = 'a'.repeat(64);
  const uri = 's3://capiro-package-e-manifests/approved/operation.json?versionId=version-123';

  it('keeps local-file preview as the default and accepts one immutable S3 input', () => {
    expect(parseIngestionManifestArgsV1(['--manifest', 'manifest.json'])).toMatchObject({
      mode: 'preview', manifestPath: 'manifest.json',
    });
    expect(parseIngestionManifestArgsV1([
      '--start', '--manifest-s3-uri', uri, '--manifest-object-sha256', sha,
      '--confirm', 'capiro-dev', '--task-job-id', 'ecs-task-arn',
    ])).toMatchObject({
      mode: 'start', manifestS3Uri: uri, manifestObjectSha256: sha,
      confirm: 'capiro-dev', taskJobId: 'ecs-task-arn',
    });
  });

  it('rejects ambiguous, mutable, credential-bearing, or unpinned object inputs', () => {
    expect(() => parseIngestionManifestArgsV1([])).toThrow('choose exactly one');
    expect(() => parseIngestionManifestArgsV1([
      '--manifest', 'one.json', '--manifest-s3-uri', uri, '--manifest-object-sha256', sha,
    ])).toThrow('choose exactly one');
    expect(() => parseIngestionManifestArgsV1([
      '--start', '--manifest', 'manifest.json', '--confirm', 'capiro-dev',
    ])).toThrow('start/resume require --manifest-s3-uri');
    expect(() => parseIngestionManifestArgsV1(['--manifest-s3-uri', uri])).toThrow(
      '--manifest-s3-uri requires --manifest-object-sha256',
    );
    expect(() => parseVersionedManifestS3UriV1('s3://bucket/key.json')).toThrow(
      'immutable-version',
    );
    expect(() => parseVersionedManifestS3UriV1(
      's3://bucket/key.json?versionId=v1&X-Amz-Signature=secret',
    )).toThrow('no credentials or extra query fields');
  });

  it('pins GetObject to the exact version and refuses bytes whose independent object hash differs', async () => {
    const bytes = Buffer.from('{"not":"the reviewed manifest"}');
    const send = jest.fn(async (command: { input: unknown }) => {
      expect(command.input).toEqual({
        Bucket: 'capiro-package-e-manifests',
        Key: 'approved/operation.json',
        VersionId: 'version-123',
      });
      return { Body: { transformToByteArray: async () => bytes } };
    });
    const client = { send, destroy: jest.fn() } as unknown as S3Client;
    await expect(loadIngestionManifestInputV1({
      mode: 'start', manifestS3Uri: uri,
      manifestObjectSha256: createHash('sha256').update('different bytes').digest('hex'),
    }, client)).rejects.toThrow(IngestionManifestUsageErrorV1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('Package E manifest CLI ECS runtime attestation', () => {
  const drainDigest = `sha256:${'b'.repeat(64)}`;
  const manifest = {
    runtime: {
      taskDefinitionArn:
        'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-defense-budget-ingestion-drain:26',
      containerName: 'ingestion-drain',
      drainImageDigest: drainDigest,
    },
    limits: {
      resourceShape: { cpuUnits: 4_096, memoryMiB: 8_192 },
    },
  } as IngestionManifestV1;
  const taskArn =
    'arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/11111111111111111111111111111111';

  function metadataFetch(overrides: Record<string, unknown> = {}): typeof fetch {
    return jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        TaskARN: taskArn,
        Family: 'capiro-dev-defense-budget-ingestion-drain',
        Revision: '26',
        Limits: { CPU: 4, Memory: 8_192 },
        Containers: [{ Name: 'ingestion-drain', ImageID: drainDigest }],
        ...overrides,
      }),
    })) as unknown as typeof fetch;
  }

  it('requires version-pinned S3 extraction artifact storage for start and resume, but not preview', () => {
    const common = { APP_ENV: 'capiro-dev', AWS_REGION: 'us-east-1' };
    const start = {
      mode: 'start' as const,
      manifestS3Uri: 's3://bucket/manifest.json?versionId=v1',
      manifestObjectSha256: 'd'.repeat(64),
      confirm: 'capiro-dev',
    };
    const resume = { ...start, mode: 'resume' as const };

    expect(() => assertIngestionManifestRuntimeV1(start, null, common)).toThrow(
      'BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_BUCKET for version-pinned S3 extraction artifacts',
    );
    expect(() => assertIngestionManifestRuntimeV1(resume, null, common)).toThrow(
      'BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_BUCKET',
    );
    expect(() => assertIngestionManifestRuntimeV1({ mode: 'preview', manifestPath: 'review.json' }, null, common)).not.toThrow();
    expect(() => assertIngestionManifestRuntimeV1(start, null, {
      ...common,
      BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_BUCKET: 'capiro-dev-parser-artifacts',
    })).not.toThrow();
  });

  it('returns the exact task ARN only when task definition, image, and resources match', async () => {
    const fetchFn = metadataFetch();
    await expect(attestIngestionManifestEcsRuntimeV1(
      manifest,
      { ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/example/' },
      fetchFn,
    )).resolves.toBe(taskArn);
    expect(fetchFn).toHaveBeenCalledWith(
      'http://169.254.170.2/v4/example/task',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('fails closed without ECS metadata or when the running digest differs', async () => {
    await expect(attestIngestionManifestEcsRuntimeV1(manifest, {}, metadataFetch())).rejects.toThrow(
      'requires ECS_CONTAINER_METADATA_URI_V4',
    );
    await expect(attestIngestionManifestEcsRuntimeV1(
      manifest,
      { ECS_CONTAINER_METADATA_URI_V4: 'https://metadata.example.test/v4/forged' },
      metadataFetch(),
    )).rejects.toThrow('ECS link-local v4 metadata endpoint');
    await expect(attestIngestionManifestEcsRuntimeV1(
      manifest,
      { ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/example' },
      metadataFetch({
        Containers: [{ Name: 'ingestion-drain', ImageID: `sha256:${'c'.repeat(64)}` }],
      }),
    )).rejects.toThrow('container image digest does not match');
    await expect(attestIngestionManifestEcsRuntimeV1(
      manifest,
      { ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/example' },
      metadataFetch({
        TaskARN:
          'arn:aws:ecs:us-east-1:967807252336:task/another-cluster/11111111111111111111111111111111',
      }),
    )).rejects.toThrow('ECS cluster/task definition');
  });

  it('requires every injected release binding and the reviewed non-secret runtime hash', () => {
    const env = {
      APP_ENV: 'capiro-dev',
      GIT_SHA: '1'.repeat(40),
      API_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
      DEFENSE_BUDGET_DRAIN_IMAGE_DIGEST: drainDigest,
      ECS_TASK_DEFINITION_ARN:
        'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-defense-budget-ingestion-drain:26',
      DEFENSE_BUDGET_RAW_BUCKET: 'capiro-defense-budget-raw-dev-967807252336',
      BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT: '/work/artifacts',
      BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_BUCKET: 'capiro-dev-parser-artifacts',
      AWS_REGION: 'us-east-1',
    };
    const boundManifest = {
      ...manifest,
      environment: 'capiro-dev',
      runtime: {
        ...manifest.runtime,
        releaseRevision: env.GIT_SHA,
        apiImageDigest: env.API_IMAGE_DIGEST,
        runtimeConfigSha256: ingestionManifestRuntimeConfigSha256V1(env),
      },
    } as IngestionManifestV1;
    const options = {
      mode: 'start' as const,
      manifestS3Uri: 's3://bucket/manifest.json?versionId=v1',
      manifestObjectSha256: 'd'.repeat(64),
      confirm: 'capiro-dev',
    };

    expect(() => assertIngestionManifestRuntimeV1(options, boundManifest, env)).not.toThrow();
    expect(() => assertIngestionManifestRuntimeV1(options, boundManifest, {
      ...env,
      DEFENSE_BUDGET_RAW_BUCKET: 'changed-after-review',
    })).toThrow('runtime configuration hash');
    expect(() => assertIngestionManifestRuntimeV1(options, boundManifest, {
      ...env,
      API_IMAGE_DIGEST: `sha256:${'e'.repeat(64)}`,
    })).toThrow('API_IMAGE_DIGEST');
    expect(() => assertIngestionManifestRuntimeV1(options, boundManifest, {
      ...env,
      AWS_REGION: 'us-west-2',
    })).toThrow('AWS_REGION exactly equals us-east-1');
    expect(() => assertIngestionManifestRuntimeV1(options, boundManifest, {
      ...env,
      AWS_REGION_DEFAULT: 'us-west-2',
    })).toThrow('AWS_REGION exactly equals us-east-1');
    expect(() => assertIngestionManifestRuntimeV1(options, boundManifest, {
      ...env,
      AWS_DEFAULT_REGION: 'us-west-2',
    })).toThrow('AWS_REGION exactly equals us-east-1');
  });
});
