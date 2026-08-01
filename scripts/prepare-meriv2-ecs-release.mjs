#!/usr/bin/env node
/**
 * Prepare immutable, all-controls-dark ECS task-definition JSON for MeriV2.
 *
 * READ-ONLY AWS behavior: Describe/List calls only. The script validates that
 * every SHA-tagged image exists, clones the currently running task definitions,
 * changes only the intended image/environment fields, and writes local JSON.
 * It never calls RegisterTaskDefinition, UpdateService, RunTask, or any other
 * mutating AWS API.
 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parse(process.argv.slice(2));
const sha = args.sha;
if (!/^[0-9a-f]{40}$/i.test(sha ?? ''))
  throw new Error('--sha must be the exact 40-character release SHA.');
const envName = args.env ?? 'dev';
const profile = args.profile ?? 'capiro-dev';
const region = args.region ?? 'us-east-1';
const cluster = args.cluster ?? `capiro-${envName}`;
const outputDir = path.resolve(
  ROOT,
  args.outputDir ?? `.deploy-logs/meriv2-ecs-release/${sha}`,
);
const aws = process.platform === 'win32' ? 'aws.cmd' : 'aws';

const definitions = [
  {
    key: 'api',
    service: `capiro-${envName}-api`,
    repository: `capiro/${envName}/api`,
    containers: ['api'],
    environment: darkApiEnvironment(),
  },
  {
    key: 'meriv2-orchestrator',
    service: `capiro-${envName}-meriv2-orchestrator`,
    repository: `capiro/${envName}/meriv2-orchestrator`,
    containers: ['meriv2-orchestrator', 'orchestrator'],
    environment: darkAssuranceEnvironment(),
  },
  {
    key: 'workspace',
    service: `capiro-${envName}-workspace`,
    repository: `capiro/${envName}/workspace`,
    containers: ['workspace'],
    environment: darkAssuranceEnvironment(),
  },
  {
    key: 'api-strategy',
    service: `capiro-${envName}-api-strategy`,
    repository: `capiro/${envName}/api-strategy`,
    containers: ['api-strategy', 'strategy'],
    environment: darkAssuranceEnvironment(),
  },
  {
    key: 'web',
    service: `capiro-${envName}-web`,
    repository: `capiro/${envName}/web`,
    containers: ['web'],
    environment: {},
  },
];

async function main() {
  const identity = await awsJson(['sts', 'get-caller-identity']);
  const account = String(identity.Account ?? '');
  if (!/^\d{12}$/.test(account)) throw new Error('AWS account could not be resolved.');
  const registry = `${account}.dkr.ecr.${region}.${partitionDns(region)}`;
  await mkdir(outputDir, { recursive: true });

  const prepared = [];
  for (const definition of definitions) {
    await assertImage(definition.repository, sha);
    const serviceResponse = await awsJson([
      'ecs',
      'describe-services',
      '--cluster',
      cluster,
      '--services',
      definition.service,
    ]);
    const service = serviceResponse.services?.[0];
    if (!service?.taskDefinition) throw new Error(`Service ${definition.service} is missing.`);
    const current = await describeTask(service.taskDefinition);
    const proposed = prepareTaskDefinition(
      current,
      definition,
      `${registry}/${definition.repository}:${sha}`,
    );
    const file = path.join(outputDir, `${definition.key}.task-definition.json`);
    await writeFile(file, `${JSON.stringify(proposed, null, 2)}\n`, 'utf8');
    prepared.push({
      key: definition.key,
      service: definition.service,
      repository: definition.repository,
      image: `${registry}/${definition.repository}:${sha}`,
      currentTaskDefinitionArn: service.taskDefinition,
      desiredCount: service.desiredCount,
      runningCount: service.runningCount,
      pendingCount: service.pendingCount,
      deploymentConfiguration: service.deploymentConfiguration,
      networkConfiguration: service.networkConfiguration,
      capacityProviderStrategy: service.capacityProviderStrategy,
      launchType: service.launchType,
      proposedFile: path.relative(ROOT, file),
      darkEnvironment: definition.environment,
    });
  }

  // API migration is an on-demand task family, not an ECS service. Preserve its
  // current secrets/roles/network mode and bind it to the same release image.
  const migrationFamily = args.migrationFamily ?? `capiro-${envName}-api-migrate`;
  const migrationCurrent = await describeTask(migrationFamily);
  const apiDefinition = definitions[0];
  const migrationProposed = prepareTaskDefinition(
    migrationCurrent,
    { ...apiDefinition, key: 'api-migrate', containers: ['api-migrate', 'api'] },
    `${registry}/${apiDefinition.repository}:${sha}`,
  );
  const migrationFile = path.join(outputDir, 'api-migrate.task-definition.json');
  await writeFile(migrationFile, `${JSON.stringify(migrationProposed, null, 2)}\n`, 'utf8');

  const apiService = prepared.find((item) => item.key === 'api');
  const manifest = {
    marker: 'MERIV2_ECS_RELEASE_DEFINITIONS_PREPARED',
    preparedAt: new Date().toISOString(),
    sha,
    env: envName,
    account,
    region,
    profile,
    cluster,
    callerArn: identity.Arn,
    awsMutation: false,
    secretValuesRead: false,
    services: prepared,
    migration: {
      family: migrationFamily,
      currentTaskDefinitionArn: migrationCurrent.taskDefinitionArn,
      proposedFile: path.relative(ROOT, migrationFile),
      networkConfiguration: apiService?.networkConfiguration,
      capacityProviderStrategy: apiService?.capacityProviderStrategy,
      launchType: apiService?.launchType,
    },
    registrationOrder: [
      'api-migrate',
      'api',
      'meriv2-orchestrator',
      'workspace',
      'api-strategy',
      'web',
    ],
  };
  const manifestFile = path.join(outputDir, 'manifest.json');
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(
    path.join(outputDir, 'REGISTERING_THESE_FILES_MUTATES_AWS.txt'),
    [
      'The JSON files in this directory were generated with read-only AWS calls.',
      'They have NOT been registered and no service has been updated.',
      'Follow docs/runbooks/meriv2-merge-and-aws-ship.md under explicit release authorization.',
      '',
    ].join('\n'),
    'utf8',
  );
  console.log(JSON.stringify({ ...manifest, manifestFile: path.relative(ROOT, manifestFile) }));
}

async function describeTask(taskDefinition) {
  const response = await awsJson([
    'ecs',
    'describe-task-definition',
    '--task-definition',
    taskDefinition,
    '--include',
    'TAGS',
  ]);
  if (!response.taskDefinition)
    throw new Error(`Task definition ${taskDefinition} was not found.`);
  return { ...response.taskDefinition, tags: response.tags ?? [] };
}

function prepareTaskDefinition(current, definition, image) {
  const allowed = [
    'family',
    'taskRoleArn',
    'executionRoleArn',
    'networkMode',
    'containerDefinitions',
    'volumes',
    'placementConstraints',
    'requiresCompatibilities',
    'cpu',
    'memory',
    'tags',
    'pidMode',
    'ipcMode',
    'proxyConfiguration',
    'inferenceAccelerators',
    'ephemeralStorage',
    'runtimePlatform',
    'enableFaultInjection',
  ];
  const proposed = Object.fromEntries(
    allowed
      .filter((key) => current[key] !== undefined)
      .map((key) => [key, structuredClone(current[key])]),
  );
  const containers = proposed.containerDefinitions ?? [];
  const target =
    containers.find((item) => definition.containers.includes(item.name)) ??
    containers.find((item) => item.essential) ??
    containers[0];
  if (!target) throw new Error(`${definition.key} task definition has no container.`);
  target.image = image;
  target.environment = replaceEnvironment(target.environment ?? [], definition.environment);
  return proposed;
}

function replaceEnvironment(existing, intended) {
  const controlled = new Set([
    'MEMORY_GOVERNANCE_LIFECYCLE',
    'MEMORY_GOVERNANCE_ENFORCE',
    'MEMORY_CLIENT_REVIEW',
    'MEMORY_GOVERNANCE_CENTER',
    'MERIV2_CONTEXT_PACKET_V2',
    'MERI_POLICY_PACK_SOURCE',
    'MERI_POLICY_PACK_TENANTS',
    'MERI_RELEASE_GATE',
    'MERI_RELEASE_GATE_TENANTS',
    'MERI_RELEASE_GATE_SURFACES',
    'MEMORY_AUTOLEARN_GOVERNED',
    'MERIV2_CONTROL_METRICS',
  ]);
  const values = new Map(
    existing
      .filter((item) => !controlled.has(item.name))
      .map((item) => [item.name, { name: item.name, value: String(item.value ?? '') }]),
  );
  for (const [name, value] of Object.entries(intended)) values.set(name, { name, value });
  return [...values.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function darkApiEnvironment() {
  return {
    MEMORY_GOVERNANCE_LIFECYCLE: 'off',
    MEMORY_GOVERNANCE_ENFORCE: 'off',
    MEMORY_CLIENT_REVIEW: 'off',
    MEMORY_GOVERNANCE_CENTER: 'off',
    MEMORY_AUTOLEARN_GOVERNED: 'false',
    MERIV2_CONTEXT_PACKET_V2: 'off',
    MERI_POLICY_PACK_SOURCE: 'off',
    MERI_POLICY_PACK_TENANTS: '',
    MERI_RELEASE_GATE: 'off',
    MERI_RELEASE_GATE_TENANTS: '',
    MERI_RELEASE_GATE_SURFACES: '',
    MERIV2_CONTROL_METRICS: 'on',
  };
}

function darkAssuranceEnvironment() {
  return {
    MERI_RELEASE_GATE: 'off',
    MERI_RELEASE_GATE_TENANTS: '',
    MERI_RELEASE_GATE_SURFACES: '',
    MERIV2_CONTEXT_PACKET_V2: 'off',
  };
}

async function assertImage(repository, imageTag) {
  await awsJson([
    'ecr',
    'describe-images',
    '--repository-name',
    repository,
    '--image-ids',
    `imageTag=${imageTag}`,
  ]);
}

async function awsJson(commandArgs) {
  const final = [...commandArgs, '--region', region, '--profile', profile, '--output', 'json'];
  const { stdout, stderr } = await execFileAsync(aws, final, {
    cwd: ROOT,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (stderr?.trim()) process.stderr.write(stderr);
  return JSON.parse(stdout || '{}');
}

function partitionDns(value) {
  return value.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
}

function parse(values) {
  const output = {};
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const [raw, inline] = arg.slice(2).split('=', 2);
    const key = raw.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = inline ?? values[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${raw}`);
    output[key] = value;
  }
  return output;
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      marker: 'MERIV2_ECS_RELEASE_DEFINITION_PREP_FAILED',
      sha,
      error: error instanceof Error ? error.message : String(error),
      awsMutation: false,
      secretValuesRead: false,
    }),
  );
  process.exitCode = 1;
});
