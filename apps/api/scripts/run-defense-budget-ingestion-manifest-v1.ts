/** Package E operator CLI. Preview is the default; writes require an explicit verb and environment confirmation. */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { RawArchiveService } from '../src/defense-budget/raw-archive.service.js';
import { makeS3, awsS3Commands } from '../src/defense-budget/s3-aws-commands.js';
import { DocumentRegistrar } from '../src/defense-budget/document-registrar.js';
import { PrismaObservationBridgeStore } from '../src/defense-budget/prisma-observation-bridge.store.js';
import { HttpsObservationByteFetchAdapter } from '../src/defense-budget/https-observation-byte-fetch.adapter.js';
import { S3SourceDocumentArchiveReadAdapter } from '../src/defense-budget/s3-source-document-archive-read.adapter.js';
import { DefaultParserHandoffAdapter } from '../src/defense-budget/default-parser-handoff.adapter.js';
import { ObservationIngestionBridgeService } from '../src/defense-budget/observation-ingestion-bridge.service.js';
import { createBudgetVerificationS3Client } from '../src/defense-budget/verification/trusted-proof/s3-proof-adapters.js';
import {
  parseIngestionManifestV1,
  type IngestionManifestV1,
} from '../src/defense-budget/governed-ingestion-manifest/ingestion-manifest-contract-v1.js';
import {
  createIngestionManifestRepositoryV1,
} from '../src/defense-budget/governed-ingestion-manifest/ingestion-manifest-repository-v1.js';
import {
  RunIngestionManifestV1,
  summarizeIngestionManifestV1,
} from '../src/defense-budget/governed-ingestion-manifest/run-ingestion-manifest-v1.js';

dotenvConfig();

export type IngestionManifestCliOptionsV1 =
  | {
      mode: 'preview' | 'start' | 'resume';
      manifestPath?: string;
      manifestS3Uri?: string;
      manifestObjectSha256?: string;
      confirm?: string;
      taskJobId?: string;
    }
  | { mode: 'status'; operationId: string }
  | { mode: 'stop'; operationId: string; confirm: string }
  | {
      mode: 'reconcile'; operationId: string; itemId: string; expectedTaskJobId: string;
      actor: string; reasonFile: string; confirm: string;
    };

export class IngestionManifestUsageErrorV1 extends Error {}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALUE_FLAGS = new Set([
  '--manifest', '--manifest-s3-uri', '--manifest-object-sha256',
  '--operation-id', '--item-id', '--expected-task-job-id', '--actor', '--reason-file',
  '--confirm', '--task-job-id',
]);
const MODE_FLAGS = new Set(['--start', '--resume', '--status', '--stop-new-work', '--reconcile-uncertain']);

export function parseIngestionManifestArgsV1(argv: string[]): IngestionManifestCliOptionsV1 {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (!VALUE_FLAGS.has(flag) && !MODE_FLAGS.has(flag)) throw new IngestionManifestUsageErrorV1(`Unknown argument: ${flag}`);
    if (values.has(flag)) throw new IngestionManifestUsageErrorV1(`Duplicate argument: ${flag}`);
    if (MODE_FLAGS.has(flag)) { values.set(flag, 'true'); continue; }
    const value = argv[++index];
    if (!value?.trim() || value.startsWith('--')) throw new IngestionManifestUsageErrorV1(`${flag} requires a value`);
    values.set(flag, value.trim());
  }
  const modes = [...MODE_FLAGS].filter(flag => values.has(flag));
  if (modes.length > 1) throw new IngestionManifestUsageErrorV1('Choose exactly one action');
  const required = (flag: string, pattern?: RegExp): string => {
    const value = values.get(flag);
    if (!value || (pattern && !pattern.test(value))) throw new IngestionManifestUsageErrorV1(`${flag} is missing or invalid`);
    return value;
  };
  const confirm = values.get('--confirm');
  if (values.has('--status')) return { mode: 'status', operationId: required('--operation-id', UUID) };
  if (values.has('--stop-new-work')) return { mode: 'stop', operationId: required('--operation-id', UUID), confirm: required('--confirm') };
  if (values.has('--reconcile-uncertain')) return {
    mode: 'reconcile', operationId: required('--operation-id', UUID), itemId: required('--item-id', UUID),
    expectedTaskJobId: required('--expected-task-job-id'), actor: required('--actor'),
    reasonFile: required('--reason-file'), confirm: required('--confirm'),
  };
  const allowed = new Set([
    '--manifest', '--manifest-s3-uri', '--manifest-object-sha256',
    '--start', '--resume', '--confirm', '--task-job-id',
  ]);
  if ([...values.keys()].some(key => !allowed.has(key))) throw new IngestionManifestUsageErrorV1('preview/start/resume accepts only manifest, confirmation, and task identity');
  const mode = values.has('--start') ? 'start' : values.has('--resume') ? 'resume' : 'preview';
  if (mode === 'preview' && confirm) throw new IngestionManifestUsageErrorV1('--confirm is invalid for read-only preview');
  const manifestPath = values.get('--manifest');
  const manifestS3Uri = values.get('--manifest-s3-uri');
  const manifestObjectSha256 = values.get('--manifest-object-sha256');
  if (Boolean(manifestPath) === Boolean(manifestS3Uri)) {
    throw new IngestionManifestUsageErrorV1('choose exactly one of --manifest or --manifest-s3-uri');
  }
  if (manifestS3Uri && !manifestObjectSha256?.match(/^[0-9a-f]{64}$/)) {
    throw new IngestionManifestUsageErrorV1('--manifest-s3-uri requires --manifest-object-sha256');
  }
  if (manifestPath && manifestObjectSha256) {
    throw new IngestionManifestUsageErrorV1('--manifest-object-sha256 is valid only with --manifest-s3-uri');
  }
  if (mode !== 'preview' && manifestPath) {
    throw new IngestionManifestUsageErrorV1(
      'start/resume require --manifest-s3-uri with an immutable version and independent object SHA-256',
    );
  }
  return {
    mode,
    ...(manifestPath ? { manifestPath } : {}),
    ...(manifestS3Uri ? { manifestS3Uri, manifestObjectSha256 } : {}),
    ...(confirm ? { confirm } : {}),
    ...(values.get('--task-job-id') ? { taskJobId: values.get('--task-job-id') } : {}),
  };
}

function actualEnvironment(env: NodeJS.ProcessEnv): string {
  return env.APP_ENV?.trim() || env.NODE_ENV?.trim() || '';
}

export function ingestionManifestRuntimeConfigSha256V1(env: NodeJS.ProcessEnv): string {
  const secretName = /(?:PASSWORD|SECRET|TOKEN|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|API_KEY|DATABASE_URL|AUTHORIZATION)/i;
  const settings: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    if (!/^(?:BUDGET|DEFENSE_BUDGET)_/.test(key) || secretName.test(key)) continue;
    const value = env[key]?.trim();
    if (value) settings[key] = value;
  }
  settings.AWS_REGION = env.AWS_REGION?.trim() ?? '';
  return createHash('sha256').update(JSON.stringify(settings)).digest('hex');
}

export function assertIngestionManifestRuntimeV1(
  options: IngestionManifestCliOptionsV1,
  manifest: IngestionManifestV1 | null,
  env: NodeJS.ProcessEnv,
): void {
  if (options.mode === 'status') return;
  const environment = actualEnvironment(env);
  if (environment !== 'capiro-dev') throw new IngestionManifestUsageErrorV1('Package E v1 runs only when APP_ENV exactly equals capiro-dev');
  const region = env.AWS_REGION?.trim();
  const alternateRegions = [env.AWS_DEFAULT_REGION, env.AWS_REGION_DEFAULT]
    .map(value => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (region !== 'us-east-1' || alternateRegions.some(value => value !== region)) {
    throw new IngestionManifestUsageErrorV1('Package E v1 runs only when AWS_REGION exactly equals us-east-1');
  }
  if ('confirm' in options && options.mode !== 'preview' && options.confirm !== environment) {
    throw new IngestionManifestUsageErrorV1('write actions require --confirm matching APP_ENV');
  }
  if ((options.mode === 'start' || options.mode === 'resume') &&
    !env.BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_BUCKET?.trim()) {
    throw new IngestionManifestUsageErrorV1(
      'start/resume require BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_BUCKET for version-pinned S3 extraction artifacts',
    );
  }
  if (!manifest) return;
  if (manifest.environment !== environment) throw new IngestionManifestUsageErrorV1('manifest environment does not match APP_ENV');
  if (options.mode === 'preview') return;
  const bindings: Array<[string, string | undefined, string]> = [
    [manifest.runtime.releaseRevision, env.GIT_SHA, 'GIT_SHA'],
    [manifest.runtime.apiImageDigest, env.API_IMAGE_DIGEST, 'API_IMAGE_DIGEST'],
    [manifest.runtime.drainImageDigest, env.DEFENSE_BUDGET_DRAIN_IMAGE_DIGEST, 'DEFENSE_BUDGET_DRAIN_IMAGE_DIGEST'],
    [manifest.runtime.taskDefinitionArn, env.ECS_TASK_DEFINITION_ARN, 'ECS_TASK_DEFINITION_ARN'],
    [manifest.runtime.runtimeConfigSha256, ingestionManifestRuntimeConfigSha256V1(env), 'runtime configuration hash'],
  ];
  for (const [expected, actual, name] of bindings) {
    if (!actual?.trim() || actual.trim() !== expected) throw new IngestionManifestUsageErrorV1(`${name} must exactly match the immutable manifest`);
  }
}

function readJsonFile(path: string): unknown {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 2_000_000) throw new Error('manifest must be a file no larger than 2 MB');
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new IngestionManifestUsageErrorV1(`cannot read manifest ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseVersionedManifestS3UriV1(value: string): {
  bucket: string;
  key: string;
  versionId: string;
} {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IngestionManifestUsageErrorV1('--manifest-s3-uri must be an absolute s3:// URI');
  }
  const queryKeys = [...url.searchParams.keys()];
  const versionId = url.searchParams.get('versionId')?.trim() ?? '';
  const key = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (url.protocol !== 's3:' || !url.hostname || !key || !versionId || versionId.toLowerCase() === 'null' ||
      url.username || url.password || url.port || url.hash || queryKeys.length !== 1 || queryKeys[0] !== 'versionId') {
    throw new IngestionManifestUsageErrorV1(
      '--manifest-s3-uri must be s3://bucket/key?versionId=<immutable-version> with no credentials or extra query fields',
    );
  }
  return { bucket: url.hostname, key, versionId };
}

export async function loadIngestionManifestInputV1(
  options: Extract<IngestionManifestCliOptionsV1, { mode: 'preview' | 'start' | 'resume' }>,
  client?: S3Client,
): Promise<IngestionManifestV1> {
  if (options.manifestPath) return parseIngestionManifestV1(readJsonFile(options.manifestPath));
  if (!options.manifestS3Uri || !options.manifestObjectSha256) {
    throw new IngestionManifestUsageErrorV1('manifest input is missing');
  }
  const locator = parseVersionedManifestS3UriV1(options.manifestS3Uri);
  const s3 = client ?? createBudgetVerificationS3Client(process.env);
  try {
    const output = await s3.send(new GetObjectCommand({
      Bucket: locator.bucket, Key: locator.key, VersionId: locator.versionId,
    }));
    const body = output.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
    if (!body?.transformToByteArray) throw new Error('versioned manifest object returned an empty body');
    const bytes = Buffer.from(await body.transformToByteArray());
    if (bytes.length === 0 || bytes.length > 2_000_000) {
      throw new Error('manifest object must contain 1 to 2000000 bytes');
    }
    const actualSha256 = createHash('sha256').update(bytes).digest('hex');
    if (actualSha256 !== options.manifestObjectSha256) {
      throw new Error(`manifest object SHA-256 mismatch: expected ${options.manifestObjectSha256}, got ${actualSha256}`);
    }
    return parseIngestionManifestV1(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if (error instanceof IngestionManifestUsageErrorV1) throw error;
    throw new IngestionManifestUsageErrorV1(
      `cannot load immutable manifest object: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (!client) s3.destroy();
  }
}

interface EcsTaskMetadataV4 {
  TaskARN?: string;
  Family?: string;
  Revision?: string;
  Limits?: { CPU?: number | string; Memory?: number | string };
  Containers?: Array<{ Name?: string; ImageID?: string }>;
}

export async function attestIngestionManifestEcsRuntimeV1(
  manifest: IngestionManifestV1,
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const metadataUri = env.ECS_CONTAINER_METADATA_URI_V4?.trim();
  if (!metadataUri) {
    throw new IngestionManifestUsageErrorV1('write execution requires ECS_CONTAINER_METADATA_URI_V4 runtime attestation');
  }
  let metadataBase: URL;
  try {
    metadataBase = new URL(metadataUri);
  } catch {
    throw new IngestionManifestUsageErrorV1('ECS_CONTAINER_METADATA_URI_V4 is not a valid ECS metadata URI');
  }
  if (metadataBase.protocol !== 'http:' || metadataBase.hostname !== '169.254.170.2' ||
      metadataBase.port || metadataBase.username || metadataBase.password ||
      metadataBase.search || metadataBase.hash || !metadataBase.pathname.startsWith('/v4/')) {
    throw new IngestionManifestUsageErrorV1(
      'ECS_CONTAINER_METADATA_URI_V4 must use the ECS link-local v4 metadata endpoint',
    );
  }
  let metadata: EcsTaskMetadataV4;
  try {
    const response = await fetchFn(`${metadataBase.href.replace(/\/$/, '')}/task`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`metadata endpoint returned HTTP ${response.status}`);
    metadata = await response.json() as EcsTaskMetadataV4;
  } catch (error) {
    throw new IngestionManifestUsageErrorV1(
      `cannot attest ECS task metadata: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const taskArn = metadata.TaskARN?.trim() ?? '';
  const taskArnMatch =
    /^(arn:aws:ecs:us-east-1:967807252336):task\/capiro-dev\/[0-9a-f]{32}$/.exec(taskArn);
  const expectedTaskDefinitionArn = taskArnMatch
    ? `${taskArnMatch[1]}:task-definition/${metadata.Family ?? ''}:${metadata.Revision ?? ''}`
    : '';
  if (!taskArnMatch || expectedTaskDefinitionArn !== manifest.runtime.taskDefinitionArn) {
    throw new IngestionManifestUsageErrorV1(
      'running ECS cluster/task definition does not match capiro-dev and the immutable manifest',
    );
  }
  const container = metadata.Containers?.find(candidate => candidate.Name === manifest.runtime.containerName);
  const imageDigest = container?.ImageID?.match(/sha256:[0-9a-f]{64}/)?.[0];
  if (!container || imageDigest !== manifest.runtime.drainImageDigest) {
    throw new IngestionManifestUsageErrorV1('running ECS container image digest does not match the immutable manifest');
  }
  const cpu = Number(metadata.Limits?.CPU);
  const memory = Number(metadata.Limits?.Memory);
  if (!Number.isFinite(cpu) || cpu * 1_024 !== manifest.limits.resourceShape.cpuUnits ||
      !Number.isFinite(memory) || memory !== manifest.limits.resourceShape.memoryMiB) {
    throw new IngestionManifestUsageErrorV1('running ECS task CPU/memory limits do not match the immutable manifest');
  }
  return taskArn;
}

function taskJobId(options: { taskJobId?: string }, attestedTaskArn: string): string {
  const requested = options.taskJobId?.trim();
  if (requested && requested !== attestedTaskArn) {
    throw new IngestionManifestUsageErrorV1('--task-job-id must equal the attested ECS task ARN');
  }
  return attestedTaskArn;
}

export function ingestionManifestExitCodeV1(outcome: string): number {
  if (outcome === 'preview' || outcome === 'completed' || outcome === 'stopped' || outcome === 'reconciled') return 0;
  if (outcome === 'uncertain') return 4;
  return 3;
}

export async function mainIngestionManifestV1(argv = process.argv.slice(2)): Promise<number> {
  const options = parseIngestionManifestArgsV1(argv);
  // Validate the environment before an S3-backed manifest load so a
  // conflicting/default region cannot direct even the immutable input read
  // outside the reviewed capiro-dev region.
  assertIngestionManifestRuntimeV1(options, null, process.env);
  const manifest = options.mode === 'preview' || options.mode === 'start' || options.mode === 'resume'
    ? await loadIngestionManifestInputV1(options)
    : null;
  assertIngestionManifestRuntimeV1(options, manifest, process.env);
  const attestedTaskArn = manifest && (options.mode === 'start' || options.mode === 'resume')
    ? await attestIngestionManifestEcsRuntimeV1(manifest, process.env)
    : null;
  const prisma = new PrismaClient();
  try {
    const repository = createIngestionManifestRepositoryV1(prisma);
    if (options.mode === 'status') {
      const operation = await repository.read(options.operationId);
      console.log(JSON.stringify({
        outcome: operation ? 'status' : 'not_found',
        summary: operation ? summarizeIngestionManifestV1(operation) : null,
      }, null, 2));
      return operation ? 0 : 3;
    }
    if (options.mode === 'stop') {
      const operation = await repository.requestStop(options.operationId);
      console.log(JSON.stringify({ outcome: operation ? 'stopped' : 'not_found', summary: operation ? summarizeIngestionManifestV1(operation) : null }, null, 2));
      return operation ? 0 : 3;
    }
    if (options.mode === 'reconcile') {
      const reason = readFileSync(options.reasonFile, 'utf8').trim();
      if (!reason || reason.length > 16_000) throw new IngestionManifestUsageErrorV1('reason must contain 1 to 16000 characters');
      const outcome = await repository.reconcileUncertain({
        operationId: options.operationId, itemId: options.itemId,
        expectedTaskJobId: options.expectedTaskJobId, actor: options.actor, reason,
      });
      console.log(JSON.stringify({ outcome, operation: await repository.read(options.operationId) }, null, 2));
      return outcome === 'ineligible' ? 3 : 0;
    }

    if (options.mode === 'preview') {
      const controller = new RunIngestionManifestV1({
        repository,
        bridge: { bridge: async () => { throw new Error('preview never invokes the ingestion bridge'); } },
      });
      const result = await controller.preview(manifest!);
      console.log(JSON.stringify({
        ...result,
        safety: 'Read-only preview; no archive read, parser execution, outbox write, or downstream hook was invoked.',
      }, null, 2));
      return ingestionManifestExitCodeV1(result.outcome);
    }

    const bucket = process.env.DEFENSE_BUDGET_RAW_BUCKET?.trim();
    const artifactRoot = process.env.BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT?.trim();
    if (!bucket || !artifactRoot) throw new IngestionManifestUsageErrorV1('DEFENSE_BUDGET_RAW_BUCKET and BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT are required');
    const region = process.env.AWS_REGION!.trim();
    const retentionYears = Number(process.env.DEFENSE_BUDGET_RETENTION_YEARS ?? '7');
    const archiveReader = new S3SourceDocumentArchiveReadAdapter();
    try {
      const registrar = new DocumentRegistrar(
        new RawArchiveService(makeS3(region), awsS3Commands, {
          bucket, kmsKeyArn: process.env.DEFENSE_BUDGET_RAW_KMS_KEY_ARN, retentionYears,
        }),
        prisma,
      );
      const bridge = new ObservationIngestionBridgeService(
        new PrismaObservationBridgeStore(prisma), new HttpsObservationByteFetchAdapter(), registrar,
        new DefaultParserHandoffAdapter({ workDir: artifactRoot }), archiveReader,
      );
      const controller = new RunIngestionManifestV1({ repository, bridge });
      const result = await controller.run(manifest!, {
        taskJobId: taskJobId(options, attestedTaskArn!), resume: options.mode === 'resume',
      });
      console.log(JSON.stringify({
        ...result,
        safety: 'Ingestion evidence only; readiness, approval, correction, and canonical publication were not performed.',
      }, null, 2));
      return ingestionManifestExitCodeV1(result.outcome);
    } finally {
      await archiveReader.destroy();
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void mainIngestionManifestV1().then(code => { process.exitCode = code; }).catch(error => {
    console.error(JSON.stringify({
      outcome: 'failed', approvals: 'not_performed', readiness: 'not_performed', canonicalPublication: 'not_performed',
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = error instanceof IngestionManifestUsageErrorV1 ? 2 : 1;
  });
}
