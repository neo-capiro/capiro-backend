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
import { resolveAwsCli } from './lib/resolve-aws-cli.mjs';
import {
  computeControlChanges,
  controlledEnvironment,
  replaceControlledEnvironment,
  resolveControlPolicy,
} from './lib/meriv2-release-controls.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parse(process.argv.slice(2));
const sha = args.sha;
if (!/^[0-9a-f]{40}$/i.test(sha ?? '')) {
  throw new Error('--sha must be the exact 40-character release SHA.');
}
const envName = args.env ?? 'dev';
const profile = args.profile ?? 'capiro-dev';
const region = args.region ?? 'us-east-1';
const cluster = args.cluster ?? `capiro-${envName}`;
const outputDir = path.resolve(ROOT, args.outputDir ?? `.deploy-logs/meriv2-ecs-release/${sha}`);
const aws = resolveAwsCli();

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

  const candidates = [];
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
    candidates.push({
      definition,
      current,
      service,
      image: `${registry}/${definition.repository}:${sha}`,
      controlChanges: computeControlChanges(targetEnvironment(current, definition), definition.environment),
    });
  }

  const migrationFamily = args.migrationFamily ?? `capiro-${envName}-api-migrate`;
  const migrationCurrent = await describeTask(migrationFamily);
  const apiDefinition = definitions[0];
  const migrationDefinition = {
    ...apiDefinition,
    key: 'api-migrate',
    containers: ['api-migrate', 'api'],
  };
  const migrationControlChanges = computeControlChanges(
    targetEnvironment(migrationCurrent, migrationDefinition),
    migrationDefinition.environment,
  );
  const allControlChanges = candidates.flatMap(({ definition, controlChanges }) =>
    controlChanges.map((change) => ({ service: definition.key, ...change })),
  );
  allControlChanges.push(
    ...migrationControlChanges.map((change) => ({ service: migrationDefinition.key, ...change })),
  );
  const controlPolicy = resolveControlPolicy(allControlChanges, args);
  const prepared = [];
  for (const candidate of candidates) {
    const { definition, current, service, image, controlChanges } = candidate;
    const proposed = prepareTaskDefinition(current, definition, image, controlPolicy);
    const file = path.join(outputDir, `${definition.key}.task-definition.json`);
    await writeFile(file, `${JSON.stringify(proposed, null, 2)}\n`, 'utf8');
    prepared.push({
      key: definition.key,
      service: definition.service,
      repository: definition.repository,
      image,
      currentTaskDefinitionArn: service.taskDefinition,
      desiredCount: service.desiredCount,
      runningCount: service.runningCount,
      pendingCount: service.pendingCount,
      deploymentConfiguration: service.deploymentConfiguration,
      networkConfiguration: service.networkConfiguration,
      capacityProviderStrategy: service.capacityProviderStrategy,
      launchType: service.launchType,
      proposedFile: path.relative(ROOT, file),
      containerNames: definition.containers,
      darkEnvironment: definition.environment,
      liveControls: controlledEnvironment(targetEnvironment(current, definition)),
      controlChanges,
    });
  }

  const migrationProposed = prepareTaskDefinition(
    migrationCurrent,
    migrationDefinition,
    `${registry}/${apiDefinition.repository}:${sha}`,
    controlPolicy,
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
    controlPolicy,
    controlChanges: allControlChanges,
    services: prepared,
    migration: {
      family: migrationFamily,
      currentTaskDefinitionArn: migrationCurrent.taskDefinitionArn,
      proposedFile: path.relative(ROOT, migrationFile),
      networkConfiguration: apiService?.networkConfiguration,
      capacityProviderStrategy: apiService?.capacityProviderStrategy,
      launchType: apiService?.launchType,
      containerNames: migrationDefinition.containers,
      darkEnvironment: migrationDefinition.environment,
      liveControls: controlledEnvironment(targetEnvironment(migrationCurrent, migrationDefinition)),
      controlChanges: migrationControlChanges,
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
  if (!response.taskDefinition) {
    throw new Error(`Task definition ${taskDefinition} was not found.`);
  }
  return { ...response.taskDefinition, tags: response.tags ?? [] };
}

function prepareTaskDefinition(current, definition, image, controlPolicy) {
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
      // RegisterTaskDefinition rejects an empty `tags` array with
      // "Tags can not be empty", so an untagged source task definition must omit
      // the key entirely rather than forward `tags: []`.
      .filter((key) => !(key === 'tags' && Array.isArray(current[key]) && !current[key].length))
      .map((key) => [key, structuredClone(current[key])]),
  );
  const containers = proposed.containerDefinitions ?? [];
  const target =
    containers.find((item) => definition.containers.includes(item.name)) ??
    containers.find((item) => item.essential) ??
    containers[0];
  if (!target) throw new Error(`${definition.key} task definition has no container.`);
  target.image = image;
  target.environment = replaceControlledEnvironment(
    target.environment ?? [],
    definition.environment,
    controlPolicy,
  );
  return proposed;
}

function targetEnvironment(taskDefinition, definition) {
  const containers = taskDefinition.containerDefinitions ?? [];
  const target =
    containers.find((item) => definition.containers.includes(item.name)) ??
    containers.find((item) => item.essential) ??
    containers[0];
  if (!target) throw new Error(`${definition.key} task definition has no container.`);
  return target.environment ?? [];
}

function darkApiEnvironment() {
  return {
    MEMORY_GOVERNANCE_TENANTS: '',
    MEMORY_GOVERNANCE_LIFECYCLE: 'off',
    MEMORY_GOVERNANCE_ENFORCE: 'off',
    MEMORY_CLIENT_REVIEW: 'off',
    MEMORY_GOVERNANCE_CENTER: 'off',
    MEMORY_AUTOLEARN_GOVERNED: 'false',
    MERIV2_CONTEXT_PACKET_V2: 'off',
    CONTEXT_PACKET_V2: '',
    MERI_POLICY_PACK_SOURCE: 'off',
    MERI_POLICY_PACK_TENANTS: '',
    MERI_RELEASE_GATE: 'off',
    MERI_RELEASE_GATE_TENANTS: '',
    MERI_RELEASE_GATE_SURFACES: '',
    MERI_EVIDENCE_ACCURACY_MODE: 'off',
    MERI_EVIDENCE_ACCURACY_TENANTS: '',
    MERI_EVIDENCE_ACCURACY_SURFACES: '',
    MERI_COVERAGE_RETRIEVAL_MODE: 'off',
    MERI_COVERAGE_RETRIEVAL_TENANTS: '',
    MERI_COVERAGE_RETRIEVAL_SURFACES: '',
    MERI_CLAIM_ASSESSMENT_MODE: 'off',
    MERI_CLAIM_ASSESSMENT_TENANTS: '',
    MERI_CLAIM_ASSESSMENT_SURFACES: '',
    MERI_AUTO_CORRECTION_MODE: 'off',
    MERI_AUTO_CORRECTION_TENANTS: '',
    MERI_AUTO_CORRECTION_SURFACES: '',
    MERI_AUTO_CORRECTION_CATEGORIES: '',
    MERI_PASSAGE_SELECTION_MODE: 'off',
    MERI_PASSAGE_SELECTION_TENANTS: '',
    MERI_PASSAGE_SELECTION_SURFACES: '',
    MERI_EVIDENCE_PROFILES_MODE: 'off',
    MERI_EVIDENCE_PROFILES_TENANTS: '',
    MERI_EVIDENCE_PROFILES_SURFACES: '',
    MERI_MATCH_LABEL_MODE: 'off',
    MERI_MATCH_LABEL_TENANTS: '',
    MERI_MATCH_LABEL_SURFACES: '',
    MERI_STATUS_PROVENANCE_MODE: 'off',
    MERI_STATUS_PROVENANCE_TENANTS: '',
    MERI_STATUS_PROVENANCE_SURFACES: '',
    MERI_JEV_CACHE_MODE: 'off',
    MERI_JEV_CACHE_TENANTS: '',
    MERI_JEV_CACHE_SURFACES: '',
    MERI_JEV_PROVIDER_MODE: 'off',
    MERI_JEV_PROVIDER_TENANTS: '',
    MERI_JEV_PROVIDER_SURFACES: '',
    MERI_JEV_MODEL: 'jev-1.13.0',
    MERI_JEV_TIMEOUT_MS: '8000',
    MERI_JEV_MAX_ATTEMPTS: '2',
    MERI_CHAT_EVIDENCE_JUDGE: 'llm',
    MERI_JEV_TASKS: '',
    MERIV2_CONTROL_METRICS: 'on',
  };
}

function darkAssuranceEnvironment() {
  return {
    MERIV2_CONTEXT_PACKET_V2: 'off',
    CONTEXT_PACKET_V2: '',
    MERI_RELEASE_GATE: 'off',
    MERI_RELEASE_GATE_TENANTS: '',
    MERI_RELEASE_GATE_SURFACES: '',
    MERI_EVIDENCE_ACCURACY_MODE: 'off',
    MERI_EVIDENCE_ACCURACY_TENANTS: '',
    MERI_EVIDENCE_ACCURACY_SURFACES: '',
    MERI_COVERAGE_RETRIEVAL_MODE: 'off',
    MERI_COVERAGE_RETRIEVAL_TENANTS: '',
    MERI_COVERAGE_RETRIEVAL_SURFACES: '',
    MERI_CLAIM_ASSESSMENT_MODE: 'off',
    MERI_CLAIM_ASSESSMENT_TENANTS: '',
    MERI_CLAIM_ASSESSMENT_SURFACES: '',
    MERI_AUTO_CORRECTION_MODE: 'off',
    MERI_AUTO_CORRECTION_TENANTS: '',
    MERI_AUTO_CORRECTION_SURFACES: '',
    MERI_AUTO_CORRECTION_CATEGORIES: '',
    MERI_PASSAGE_SELECTION_MODE: 'off',
    MERI_PASSAGE_SELECTION_TENANTS: '',
    MERI_PASSAGE_SELECTION_SURFACES: '',
    MERI_EVIDENCE_PROFILES_MODE: 'off',
    MERI_EVIDENCE_PROFILES_TENANTS: '',
    MERI_EVIDENCE_PROFILES_SURFACES: '',
    MERI_MATCH_LABEL_MODE: 'off',
    MERI_MATCH_LABEL_TENANTS: '',
    MERI_MATCH_LABEL_SURFACES: '',
    MERI_STATUS_PROVENANCE_MODE: 'off',
    MERI_STATUS_PROVENANCE_TENANTS: '',
    MERI_STATUS_PROVENANCE_SURFACES: '',
    MERI_JEV_CACHE_MODE: 'off',
    MERI_JEV_CACHE_TENANTS: '',
    MERI_JEV_CACHE_SURFACES: '',
    MERI_JEV_PROVIDER_MODE: 'off',
    MERI_JEV_PROVIDER_TENANTS: '',
    MERI_JEV_PROVIDER_SURFACES: '',
    MERI_JEV_MODEL: 'jev-1.13.0',
    MERI_JEV_TIMEOUT_MS: '8000',
    MERI_JEV_MAX_ATTEMPTS: '2',
    MERI_CHAT_EVIDENCE_JUDGE: 'llm',
    MERI_JEV_TASKS: '',
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
    if (raw === 'preserve-live-controls' || raw === 'reset-controls') {
      if (inline !== undefined) throw new Error(`--${raw} does not take a value.`);
      output[key] = true;
      continue;
    }
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
