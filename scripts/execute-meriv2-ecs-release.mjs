#!/usr/bin/env node
/**
 * Execute the MeriV2 additive migration and all-controls-dark ECS deployment.
 *
 * MUTATES AWS. It requires an exact release SHA, a manifest produced by
 * prepare-meriv2-ecs-release.mjs, and an explicit production confirmation. It
 * resolves every SHA tag to an immutable ECR digest before registration, runs the
 * dedicated migration task, then updates services one at a time. On service
 * stabilization failure it restores every already-updated service to its prior
 * task definition. Additive migrations are deliberately left in place.
 *
 * This script does NOT enable governed-memory tenants, Context Packet v2,
 * persisted policy packs, assurance, the projection-worker schedule, the control
 * monitor, any backfill, or any external send.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveAwsCli } from './lib/resolve-aws-cli.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parse(process.argv.slice(2));
const sha = requiredArg('sha');
if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('--sha must be an exact 40-character SHA.');
const manifestPath = path.resolve(ROOT, requiredArg('manifest'));
const profile = args.profile ?? 'capiro-dev';
const region = args.region ?? 'us-east-1';
const confirmation = requiredArg('confirm');
const aws = resolveAwsCli();
const evidenceDir = path.resolve(
  ROOT,
  args.evidenceDir ?? `.deploy-logs/meriv2-ecs-release/${sha}/execution`,
);

const SERVICE_ORDER = ['api', 'meriv2-orchestrator', 'workspace', 'api-strategy', 'web'];

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  validateManifest(manifest);
  const expectedConfirmation = `DEPLOY_CAPIRO_${String(manifest.env).toUpperCase()}_PRODUCTION`;
  if (confirmation !== expectedConfirmation) {
    throw new Error(`--confirm must equal ${expectedConfirmation}.`);
  }

  const identity = await awsJson(['sts', 'get-caller-identity']);
  if (String(identity.Account ?? '') !== String(manifest.account)) {
    throw new Error(
      `AWS caller account ${String(identity.Account ?? 'unknown')} does not match manifest account ${manifest.account}.`,
    );
  }

  await mkdir(evidenceDir, { recursive: true });
  const baseline = Object.fromEntries(
    manifest.services.map((service) => [service.key, service.currentTaskDefinitionArn]),
  );
  await writeJson('00-baseline.json', {
    capturedAt: new Date().toISOString(),
    sha,
    account: manifest.account,
    region,
    profile,
    cluster: manifest.cluster,
    callerArn: identity.Arn,
    baseline,
  });

  const registrations = {};
  const registrationEntries = [
    {
      key: 'api-migrate',
      repository: serviceByKey(manifest, 'api').repository,
      file: manifest.migration.proposedFile,
    },
    ...SERVICE_ORDER.map((key) => {
      const service = serviceByKey(manifest, key);
      return { key, repository: service.repository, file: service.proposedFile };
    }),
  ];

  for (const entry of registrationEntries) {
    const digest = await imageDigest(entry.repository, sha);
    const source = JSON.parse(await readFile(path.resolve(ROOT, entry.file), 'utf8'));
    const pinned = pinTaskImages(source, entry.repository, sha, digest);
    assertDarkTaskDefinition(entry.key, pinned);
    const pinnedFile = path.join(evidenceDir, `${entry.key}.digest-pinned.task-definition.json`);
    await writeFile(pinnedFile, `${JSON.stringify(pinned, null, 2)}\n`, 'utf8');
    const registered = await awsJson([
      'ecs',
      'register-task-definition',
      '--cli-input-json',
      `file://${pinnedFile}`,
    ]);
    const arn = registered.taskDefinition?.taskDefinitionArn;
    if (!arn) throw new Error(`AWS did not return a task-definition ARN for ${entry.key}.`);
    registrations[entry.key] = { arn, repository: entry.repository, digest };
    await writeJson(`10-register-${entry.key}.json`, registrations[entry.key]);
  }

  const migrationTaskArn = await runMigration(manifest, registrations['api-migrate'].arn);
  await writeJson('20-migration.json', {
    taskArn: migrationTaskArn,
    taskDefinitionArn: registrations['api-migrate'].arn,
    completedAt: new Date().toISOString(),
    exitCode: 0,
  });

  const updated = [];
  try {
    for (const key of SERVICE_ORDER) {
      const service = serviceByKey(manifest, key);
      const taskDefinitionArn = registrations[key].arn;
      await awsJson([
        'ecs',
        'update-service',
        '--cluster',
        manifest.cluster,
        '--service',
        service.service,
        '--task-definition',
        taskDefinitionArn,
        '--force-new-deployment',
      ]);
      updated.push(key);
      await awsCall([
        'ecs',
        'wait',
        'services-stable',
        '--cluster',
        manifest.cluster,
        '--services',
        service.service,
      ]);
      const verified = await describeService(manifest.cluster, service.service);
      if (
        verified.taskDefinition !== taskDefinitionArn ||
        Number(verified.runningCount ?? -1) !== Number(verified.desiredCount ?? -2) ||
        Number(verified.pendingCount ?? 1) !== 0
      ) {
        throw new Error(`Service ${service.service} did not stabilize on ${taskDefinitionArn}.`);
      }
      await writeJson(`30-service-${key}.json`, verified);
    }
  } catch (error) {
    await rollbackServices(manifest, updated, baseline, error);
    throw error;
  }

  const summary = {
    marker: 'MERIV2_ECS_DARK_RELEASE_COMPLETE',
    completedAt: new Date().toISOString(),
    sha,
    account: manifest.account,
    region,
    profile,
    cluster: manifest.cluster,
    migrationTaskArn,
    registrations,
    updatedServices: SERVICE_ORDER,
    controlsDark: true,
    workerScheduleChanged: false,
    controlMonitorChanged: false,
    backfillExecuted: false,
    externalSendExecuted: false,
  };
  await writeJson('summary.json', summary);
  console.log(JSON.stringify(summary));
}

async function runMigration(manifest, taskDefinitionArn) {
  const runArgs = [
    'ecs',
    'run-task',
    '--cluster',
    manifest.cluster,
    '--task-definition',
    taskDefinitionArn,
    '--count',
    '1',
    '--network-configuration',
    JSON.stringify(manifest.migration.networkConfiguration),
  ];
  if (
    Array.isArray(manifest.migration.capacityProviderStrategy) &&
    manifest.migration.capacityProviderStrategy.length
  ) {
    runArgs.push(
      '--capacity-provider-strategy',
      JSON.stringify(manifest.migration.capacityProviderStrategy),
    );
  } else {
    runArgs.push('--launch-type', String(manifest.migration.launchType ?? 'FARGATE'));
  }
  const started = await awsJson(runArgs);
  const failure = started.failures?.[0];
  if (failure) throw new Error(`Migration task failed to start: ${failure.reason ?? 'unknown'}.`);
  const taskArn = started.tasks?.[0]?.taskArn;
  if (!taskArn) throw new Error('Migration run-task returned no task ARN.');
  await awsCall([
    'ecs',
    'wait',
    'tasks-stopped',
    '--cluster',
    manifest.cluster,
    '--tasks',
    taskArn,
  ]);
  const described = await awsJson([
    'ecs',
    'describe-tasks',
    '--cluster',
    manifest.cluster,
    '--tasks',
    taskArn,
  ]);
  const task = described.tasks?.[0];
  const failedContainer = (task?.containers ?? []).find(
    (container) => Number(container.exitCode) !== 0,
  );
  if (!task || task.stopCode === 'TaskFailedToStart' || failedContainer) {
    throw new Error(
      `Migration task failed: stopCode=${task?.stopCode ?? 'missing'} exitCode=${failedContainer?.exitCode ?? 'missing'} reason=${failedContainer?.reason ?? task?.stoppedReason ?? 'unknown'}.`,
    );
  }
  return taskArn;
}

async function rollbackServices(manifest, updated, baseline, cause) {
  const results = [];
  for (const key of [...updated].reverse()) {
    const service = serviceByKey(manifest, key);
    const prior = baseline[key];
    try {
      await awsJson([
        'ecs',
        'update-service',
        '--cluster',
        manifest.cluster,
        '--service',
        service.service,
        '--task-definition',
        prior,
        '--force-new-deployment',
      ]);
      await awsCall([
        'ecs',
        'wait',
        'services-stable',
        '--cluster',
        manifest.cluster,
        '--services',
        service.service,
      ]);
      results.push({ key, restored: true, taskDefinitionArn: prior });
    } catch (rollbackError) {
      results.push({
        key,
        restored: false,
        taskDefinitionArn: prior,
        error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      });
    }
  }
  await writeJson('rollback.json', {
    triggeredAt: new Date().toISOString(),
    cause: cause instanceof Error ? cause.message : String(cause),
    results,
    additiveMigrationsRetained: true,
  });
}

function pinTaskImages(taskDefinition, repository, imageTag, digest) {
  const suffix = `/${repository}:${imageTag}`;
  let replacements = 0;
  for (const container of taskDefinition.containerDefinitions ?? []) {
    if (typeof container.image === 'string' && container.image.endsWith(suffix)) {
      container.image = container.image.slice(0, -`:${imageTag}`.length) + `@${digest}`;
      replacements += 1;
    }
  }
  if (replacements !== 1) {
    throw new Error(
      `Expected exactly one ${repository}:${imageTag} container, found ${replacements}.`,
    );
  }
  // RegisterTaskDefinition rejects an empty tag list ("Tags can not be empty").
  // The preparer already omits it for untagged sources; drop it here too so a
  // manifest produced before that fix cannot fail the release at registration.
  if (Array.isArray(taskDefinition.tags) && !taskDefinition.tags.length) {
    delete taskDefinition.tags;
  }
  return taskDefinition;
}

function assertDarkTaskDefinition(key, taskDefinition) {
  const controlled = new Map();
  for (const container of taskDefinition.containerDefinitions ?? []) {
    for (const entry of container.environment ?? [])
      controlled.set(entry.name, String(entry.value ?? ''));
  }
  const mustBeOff = [
    'MEMORY_GOVERNANCE_LIFECYCLE',
    'MEMORY_GOVERNANCE_ENFORCE',
    'MEMORY_CLIENT_REVIEW',
    'MEMORY_GOVERNANCE_CENTER',
    'MERIV2_CONTEXT_PACKET_V2',
    'MERI_POLICY_PACK_SOURCE',
    'MERI_RELEASE_GATE',
  ];
  for (const name of mustBeOff) {
    const value = controlled.get(name);
    if (value !== undefined && value !== 'off') {
      throw new Error(`${key} is not dark: ${name}=${value}.`);
    }
  }
  for (const name of [
    'MEMORY_GOVERNANCE_TENANTS',
    'MERI_POLICY_PACK_TENANTS',
    'MERI_RELEASE_GATE_TENANTS',
    'MERI_RELEASE_GATE_SURFACES',
    'CONTEXT_PACKET_V2',
  ]) {
    if ((controlled.get(name) ?? '') !== '') {
      throw new Error(`${key} retained a rollout selection in ${name}.`);
    }
  }
  if ((controlled.get('MEMORY_AUTOLEARN_GOVERNED') ?? 'false') !== 'false') {
    throw new Error(`${key} enabled governed auto-learning.`);
  }
}

async function imageDigest(repository, imageTag) {
  const response = await awsJson([
    'ecr',
    'describe-images',
    '--repository-name',
    repository,
    '--image-ids',
    `imageTag=${imageTag}`,
  ]);
  const digest = response.imageDetails?.[0]?.imageDigest;
  if (!/^sha256:[0-9a-f]{64}$/i.test(String(digest ?? ''))) {
    throw new Error(`No immutable digest resolved for ${repository}:${imageTag}.`);
  }
  return digest;
}

async function describeService(cluster, serviceName) {
  const response = await awsJson([
    'ecs',
    'describe-services',
    '--cluster',
    cluster,
    '--services',
    serviceName,
  ]);
  const service = response.services?.[0];
  if (!service) throw new Error(`Service ${serviceName} disappeared during deployment.`);
  return service;
}

function validateManifest(manifest) {
  if (manifest.marker !== 'MERIV2_ECS_RELEASE_DEFINITIONS_PREPARED') {
    throw new Error('The supplied file is not a MeriV2 release manifest.');
  }
  if (manifest.sha !== sha) throw new Error('Manifest SHA does not match --sha.');
  if (!manifest.cluster || !manifest.account || !Array.isArray(manifest.services)) {
    throw new Error('Manifest is missing cluster, account, or service data.');
  }
  for (const key of SERVICE_ORDER) serviceByKey(manifest, key);
  if (!manifest.migration?.proposedFile || !manifest.migration?.networkConfiguration) {
    throw new Error('Manifest is missing migration task or network configuration.');
  }
}

function serviceByKey(manifest, key) {
  const service = manifest.services.find((item) => item.key === key);
  if (!service) throw new Error(`Manifest is missing service ${key}.`);
  return service;
}

async function awsJson(commandArgs) {
  const { stdout, stderr } = await execFileAsync(
    aws,
    [...commandArgs, '--region', region, '--profile', profile, '--output', 'json'],
    { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  );
  if (stderr?.trim()) process.stderr.write(stderr);
  return JSON.parse(stdout || '{}');
}

async function awsCall(commandArgs) {
  const { stdout, stderr } = await execFileAsync(
    aws,
    [...commandArgs, '--region', region, '--profile', profile],
    { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  );
  if (stdout?.trim()) process.stdout.write(stdout);
  if (stderr?.trim()) process.stderr.write(stderr);
}

async function writeJson(name, value) {
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function requiredArg(name) {
  const value = args[name];
  if (!value)
    throw new Error(`--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required.`);
  return String(value);
}

function parse(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const [raw, inline] = arg.slice(2).split('=', 2);
    const key = raw.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = inline ?? values[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${raw}`);
    parsed[key] = value;
  }
  return parsed;
}

main().catch(async (error) => {
  const payload = {
    marker: 'MERIV2_ECS_DARK_RELEASE_FAILED',
    failedAt: new Date().toISOString(),
    sha,
    error: error instanceof Error ? error.message : String(error),
    featureActivationAttempted: false,
  };
  await writeJson('failure.json', payload).catch(() => undefined);
  console.error(JSON.stringify(payload));
  process.exitCode = 1;
});
