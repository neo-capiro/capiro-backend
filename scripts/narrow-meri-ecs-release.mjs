#!/usr/bin/env node
/**
 * One-service-at-a-time production ECS release gate for API / MeriV2 orchestrator.
 *
 * `prepare` is the default and uses AWS Describe/List only. `execute` and
 * `rollback` are the ONLY mutating actions and require exact confirmation pins.
 * No migration, CDK, WAF, Cloud Map, or other service is touched.
 *
 * The gate checks ECS health, NOT authenticated browser behavior or factual
 * correctness. Stop after each execute for those manual acceptance gates.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveAwsCli } from './lib/resolve-aws-cli.mjs';
import {
  SERVICES, assertBaselineUnchanged, assertServiceState, assertTargetImage,
  cloneWithOnlyImageChanged, parseEcrImage, serviceConfig, targetContainer,
  validateManifest,
} from './lib/narrow-meri-ecs-release.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGION = 'us-east-1';
const CLUSTER = 'capiro-dev';
const argv = parse(process.argv.slice(2));
const action = argv.action ?? 'prepare';
const profile = argv.profile ?? 'capiro-dev';
const aws = resolveAwsCli();

async function main() {
  if (!['prepare', 'execute', 'rollback'].includes(action)) {
    throw new Error('Action must be prepare, execute, or rollback.');
  }
  const key = required('service');
  serviceConfig(key);
  const identity = await awsJson(['sts', 'get-caller-identity']);
  const account = String(identity.Account ?? '');
  if (!/^\d{12}$/.test(account)) throw new Error('Could not resolve the AWS account.');
  if (action === 'prepare') return prepare(key, account, identity.Arn);
  if (action === 'execute') return execute(key, account);
  return rollback(key, account);
}

async function prepare(key, account, callerArn) {
  const targetImage = required('image');
  const target = assertTargetImage(targetImage, account, REGION, key);
  await assertEcrDigest(target.repository, target.digest);
  const baseline = await liveBaseline(account);
  const manifest = {
    marker: 'NARROW_MERI_ECS_RELEASE_V1',
    preparedAt: new Date().toISOString(),
    account, region: REGION, cluster: CLUSTER, profile, callerArn,
    service: key, targetImage, baseline,
    awsMutation: false,
    secretsManagerValuesRead: false,
    liveTaskDefinitionEnvironmentReadButNotRecorded: true,
    manualGates: [
      'Confirm change window, source commit and immutable image provenance.',
      'Confirm current baseline health when ECS health is UNKNOWN.',
      'After this ONE service stabilizes, perform authenticated browser, health, factual and rollback checks before any next service.',
    ],
  };
  if (argv.manifest) {
    const file = path.resolve(ROOT, argv.manifest);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ marker: 'NARROW_MERI_PREPARED', manifest: file, ...manifest }));
  } else {
    console.log(JSON.stringify({ marker: 'NARROW_MERI_PREPARED', ...manifest }));
  }
}

async function execute(key, account) {
  const manifest = JSON.parse(await readFile(path.resolve(ROOT, required('manifest')), 'utf8'));
  const rollbackArn = required('rollback-task-definition');
  validateManifest(manifest, account, REGION, key, rollbackArn);
  if (manifest.profile !== profile) throw new Error('AWS profile differs from the prepared manifest.');
  const confirmation = `UPDATE_CAPIRO_DEV_${key.toUpperCase()}_PRODUCTION`;
  if (argv.confirm !== confirmation) throw new Error(`--confirm must equal ${confirmation}.`);
  if (argv.ackManualBaselineHealth !== 'yes') {
    throw new Error('--ack-manual-baseline-health yes is required; ECS checks do not prove app health.');
  }
  await assertEcrDigest(serviceConfig(key).repository, assertTargetImage(manifest.targetImage, account, REGION, key).digest);

  // First read occurs before any mutation. Read again after task-definition
  // registration, directly before UpdateService, to catch intervening drift.
  assertBaselineUnchanged(manifest.baseline, await liveBaseline(account));
  const liveTask = await describeTask(manifest.baseline[key].taskDefinitionArn);
  const proposed = cloneWithOnlyImageChanged(liveTask, key, manifest.targetImage);
  const registered = await registerTask(proposed);
  const newArn = registered.taskDefinition?.taskDefinitionArn;
  if (!newArn || newArn === rollbackArn) throw new Error('Registration did not return a new task-definition ARN.');
  console.log(JSON.stringify({ marker: 'NARROW_MERI_TASK_DEFINITION_REGISTERED', service: key,
    taskDefinitionArn: newArn, serviceUpdated: false }));
  assertBaselineUnchanged(manifest.baseline, await liveBaseline(account));
  const service = serviceConfig(key).name;
  await awsJson(['ecs', 'update-service', '--cluster', CLUSTER, '--service', service,
    '--task-definition', newArn]);
  console.log(JSON.stringify({ marker: 'NARROW_MERI_SERVICE_UPDATE_SENT', service,
    newTaskDefinitionArn: newArn, rollbackTaskDefinitionArn: rollbackArn }));
  try {
    await waitStable(key, newArn, assertTargetImage(manifest.targetImage, account, REGION, key).digest);
  } catch (error) {
    const current = await describeService(service);
    if (current.taskDefinition === newArn) {
      await awsJson(['ecs', 'update-service', '--cluster', CLUSTER, '--service', service,
        '--task-definition', rollbackArn]);
      console.error(JSON.stringify({ marker: 'NARROW_MERI_AUTOMATIC_ROLLBACK_SENT', service,
        rollbackTaskDefinitionArn: rollbackArn, cause: String(error) }));
      await waitStable(key, rollbackArn, manifest.baseline[key].imageDigest);
    }
    throw error;
  }
  console.log(JSON.stringify({ marker: 'NARROW_MERI_ECS_STABLE_MANUAL_ACCEPTANCE_REQUIRED',
    service, newTaskDefinitionArn: newArn, rollbackTaskDefinitionArn: rollbackArn,
    required: ['authenticated browser QA', 'health and auth verification',
      'factual-value verification', 'operator go/no-go before the next service'] }));
}

async function rollback(key, account) {
  const manifest = JSON.parse(await readFile(path.resolve(ROOT, required('manifest')), 'utf8'));
  const rollbackArn = required('rollback-task-definition');
  validateManifest(manifest, account, REGION, key, rollbackArn, { allowOlderForRollback: true });
  if (manifest.profile !== profile) throw new Error('AWS profile differs from the prepared manifest.');
  const expectedCurrent = required('expected-current-task-definition');
  if (argv.confirm !== `ROLLBACK_CAPIRO_DEV_${key.toUpperCase()}_PRODUCTION`) {
    throw new Error(`--confirm must equal ROLLBACK_CAPIRO_DEV_${key.toUpperCase()}_PRODUCTION.`);
  }
  const current = await describeService(serviceConfig(key).name);
  if (current.taskDefinition !== expectedCurrent || expectedCurrent === rollbackArn) {
    throw new Error('Current task definition differs from the explicit rollback source pin.');
  }
  const rollbackTask = await describeTask(rollbackArn);
  const parsed = parseEcrImage(targetContainer(rollbackTask, key).image, account, REGION,
    serviceConfig(key).repository);
  const digest = await resolveDigest(parsed);
  if (digest !== manifest.baseline[key].imageDigest) {
    throw new Error('Rollback task-definition image digest no longer matches prepare baseline.');
  }
  await awsJson(['ecs', 'update-service', '--cluster', CLUSTER, '--service', serviceConfig(key).name,
    '--task-definition', rollbackArn]);
  await waitStable(key, rollbackArn, manifest.baseline[key].imageDigest);
  console.log(JSON.stringify({ marker: 'NARROW_MERI_ROLLBACK_ECS_STABLE', service: key,
    rollbackTaskDefinitionArn: rollbackArn, manualVerificationStillRequired: true }));
}

async function liveBaseline(account) {
  const baseline = {};
  for (const [key, config] of Object.entries(SERVICES)) {
    const service = await describeService(config.name);
    const taskDefinition = await describeTask(service.taskDefinition);
    const image = targetContainer(taskDefinition, key).image;
    const parsed = parseEcrImage(image, account, REGION, config.repository);
    const digest = await resolveDigest(parsed);
    const tasks = await runningTasks(config.name);
    assertServiceState(service, tasks, key);
    for (const task of tasks) {
      const containers = (task.containers ?? []).filter((container) => container.name === config.container);
      if (containers.length !== 1 || containers[0].imageDigest?.toLowerCase() !== digest ||
          containers[0].lastStatus !== 'RUNNING' || containers[0].healthStatus === 'UNHEALTHY') {
        throw new Error(`${config.name} running container digest/status differs from its task definition.`);
      }
    }
    const targetHealth = await loadBalancerHealth(service);
    baseline[key] = {
      taskDefinitionArn: service.taskDefinition,
      desiredCount: service.desiredCount,
      runningCount: service.runningCount,
      pendingCount: service.pendingCount,
      runningTaskCount: tasks.length,
      deploymentId: service.deployments[0].id,
      imageDigest: digest,
      healthyTargetCount: targetHealth,
      unknownHealthCount: tasks.filter((task) => task.healthStatus !== 'HEALTHY').length,
    };
  }
  return baseline;
}

async function loadBalancerHealth(service) {
  const groups = (service.loadBalancers ?? []).map((entry) => entry.targetGroupArn).filter(Boolean);
  if (!groups.length) return null;
  let smallestHealthy = Infinity;
  for (const group of groups) {
    const response = await awsJson(['elbv2', 'describe-target-health', '--target-group-arn', group]);
    const states = (response.TargetHealthDescriptions ?? []).map((entry) => entry.TargetHealth?.State);
    const healthy = states.filter((state) => state === 'healthy').length;
    if (healthy < service.desiredCount || states.some((state) => state === 'unhealthy')) {
      throw new Error(`${service.serviceName} target group is not healthy for every desired task.`);
    }
    smallestHealthy = Math.min(smallestHealthy, healthy);
  }
  return smallestHealthy;
}

async function runningTasks(serviceName) {
  const listed = await awsJson(['ecs', 'list-tasks', '--cluster', CLUSTER,
    '--service-name', serviceName, '--desired-status', 'RUNNING']);
  const arns = listed.taskArns ?? [];
  if (!arns.length || arns.length > 100) throw new Error(`Unexpected task count for ${serviceName}.`);
  const described = await awsJson(['ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', ...arns]);
  if (described.failures?.length) throw new Error(`Could not describe all ${serviceName} tasks.`);
  return described.tasks ?? [];
}

async function resolveDigest(parsed) {
  const imageId = parsed.digest ? `imageDigest=${parsed.digest}` : `imageTag=${parsed.tag}`;
  const response = await awsJson(['ecr', 'describe-images', '--repository-name', parsed.repository,
    '--image-ids', imageId]);
  const digest = String(response.imageDetails?.[0]?.imageDigest ?? '').toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('ECR did not return an image digest.');
  if (parsed.digest && parsed.digest !== digest) throw new Error('ECR digest lookup mismatch.');
  return digest;
}

async function assertEcrDigest(repository, digest) {
  await resolveDigest({ repository, digest, tag: null });
}

async function describeService(name) {
  const response = await awsJson(['ecs', 'describe-services', '--cluster', CLUSTER, '--services', name]);
  if (response.failures?.length || response.services?.length !== 1) throw new Error(`Missing ECS service ${name}.`);
  return response.services[0];
}

async function describeTask(arn) {
  const response = await awsJson(['ecs', 'describe-task-definition', '--task-definition', arn, '--include', 'TAGS']);
  if (!response.taskDefinition) throw new Error(`Missing task definition ${arn}.`);
  return { ...response.taskDefinition, tags: response.tags ?? [] };
}

async function registerTask(taskDefinition) {
  // AWS CLI requires JSON input. Keep the cloned environment/secret references
  // out of process arguments and release logs; remove the private temp file.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'capiro-narrow-ecs-'));
  const file = path.join(dir, 'task-definition.json');
  try {
    await writeFile(file, JSON.stringify(taskDefinition), { mode: 0o600, flag: 'wx' });
    return await awsJson(['ecs', 'register-task-definition', '--cli-input-json', `file://${file}`]);
  } finally {
    await rm(file, { force: true });
    await rmdir(dir);
  }
}

async function waitStable(key, expectedArn, expectedDigest) {
  const deadline = Date.now() + 25 * 60_000;
  const config = serviceConfig(key);
  while (Date.now() < deadline) {
    const service = await describeService(config.name);
    const deployments = service.deployments ?? [];
    if (deployments.some((item) => item.rolloutState === 'FAILED')) {
      throw new Error(`${config.name} ECS rollout failed.`);
    }
    if (service.taskDefinition === expectedArn && service.desiredCount > 0 &&
        service.runningCount === service.desiredCount && service.pendingCount === 0 &&
        deployments.length === 1 && ['COMPLETED', undefined].includes(deployments[0].rolloutState)) {
      const tasks = await runningTasks(config.name);
      assertServiceState(service, tasks, key);
      if (tasks.some((task) => {
        const containers = (task.containers ?? []).filter((item) => item.name === config.container);
        return containers.length !== 1 ||
          containers[0].imageDigest?.toLowerCase() !== expectedDigest ||
          containers[0].lastStatus !== 'RUNNING' || containers[0].healthStatus === 'UNHEALTHY';
      })) throw new Error(`${config.name} running image digest or container health is wrong.`);
      await loadBalancerHealth(service);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  throw new Error(`${config.name} did not reach ECS stable state within 25 minutes.`);
}

async function awsJson(command) {
  const { stdout } = await execFileAsync(aws,
    [...command, '--region', REGION, '--profile', profile, '--output', 'json'],
    { cwd: ROOT, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout || '{}');
}

function required(name) {
  const value = argv[name];
  if (!value || value === true) throw new Error(`--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required.`);
  return String(value);
}

function parse(values) {
  const result = {};
  let index = 0;
  if (values[0] && !values[0].startsWith('--')) result.action = values[index++];
  for (; index < values.length; index += 1) {
    const arg = values[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const [raw, inline] = arg.slice(2).split('=', 2);
    const key = raw.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = inline ?? values[++index];
    if (!value || value.startsWith('--') || Object.hasOwn(result, key)) throw new Error(`Invalid or duplicate --${raw}.`);
    result[key] = value;
  }
  return result;
}

main().catch((error) => {
  console.error(JSON.stringify({ marker: 'NARROW_MERI_ECS_RELEASE_FAILED', action,
    error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
