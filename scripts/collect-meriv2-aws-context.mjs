#!/usr/bin/env node
/**
 * Read-only collector for the independent MeriV2 operations CDK app.
 *
 * It reads identifiers, ARNs, and the currently deployed API image digest only.
 * It never calls GetSecretValue, never registers a task definition, never changes
 * an ECS service/rule/stack, and never writes to AWS. The JSON output can be
 * passed to the local release preflight and converted to CDK --context arguments.
 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = parse(process.argv.slice(2));
const envName = options.env ?? 'dev';
const profile = options.profile ?? 'capiro-dev';
const region = options.region ?? 'us-east-1';
const clusterName = options.cluster ?? `capiro-${envName}`;
const apiServiceName = options.service ?? `capiro-${envName}-api`;
const aws = process.platform === 'win32' ? 'aws.cmd' : 'aws';

async function main() {
  const identity = await awsJson(['sts', 'get-caller-identity']);
  const account = String(identity.Account ?? '');
  if (!/^\d{12}$/.test(account)) throw new Error('AWS caller account could not be resolved.');

  const clusterResponse = await awsJson([
    'ecs',
    'describe-clusters',
    '--clusters',
    clusterName,
  ]);
  const cluster = clusterResponse.clusters?.[0];
  if (!cluster?.clusterArn || cluster.status !== 'ACTIVE') {
    throw new Error(`ECS cluster ${clusterName} is missing or not ACTIVE.`);
  }

  const serviceResponse = await awsJson([
    'ecs',
    'describe-services',
    '--cluster',
    clusterName,
    '--services',
    apiServiceName,
  ]);
  const service = serviceResponse.services?.[0];
  if (!service?.serviceArn || !service.taskDefinition) {
    throw new Error(`ECS service ${apiServiceName} is missing.`);
  }
  const network = service.networkConfiguration?.awsvpcConfiguration;
  const privateSubnetIds = unique(network?.subnets ?? []);
  const securityGroups = unique(network?.securityGroups ?? []);
  if (!privateSubnetIds.length || !securityGroups.length) {
    throw new Error('The API service did not expose awsvpc subnets and a security group.');
  }

  const taskResponse = await awsJson([
    'ecs',
    'describe-task-definition',
    '--task-definition',
    service.taskDefinition,
    '--include',
    'TAGS',
  ]);
  const task = taskResponse.taskDefinition;
  const container =
    task?.containerDefinitions?.find((item) => item.name === 'api') ??
    task?.containerDefinitions?.find((item) => item.essential) ??
    task?.containerDefinitions?.[0];
  if (!container) throw new Error('The current API task definition has no container definition.');
  const secretByName = new Map((container.secrets ?? []).map((item) => [item.name, item.valueFrom]));
  const dbSecretArn = stripSecretSelector(
    requiredSecret(secretByName, 'DB_HOST', 'master database secret'),
  );
  const appDbSecretArn = stripSecretSelector(
    requiredSecret(secretByName, 'DB_USER', 'application database secret'),
  );

  // DescribeSecret is metadata-only. No secret values are retrieved.
  await awsJson(['secretsmanager', 'describe-secret', '--secret-id', dbSecretArn]);
  await awsJson(['secretsmanager', 'describe-secret', '--secret-id', appDbSecretArn]);

  const dataKey = await awsJson([
    'kms',
    'describe-key',
    '--key-id',
    `alias/capiro/${envName}/data`,
  ]);
  const secretsKey = await awsJson([
    'kms',
    'describe-key',
    '--key-id',
    `alias/capiro/${envName}/secrets`,
  ]);
  const dataKeyArn = dataKey.KeyMetadata?.Arn;
  const secretsKeyArn = secretsKey.KeyMetadata?.Arn;
  if (!dataKeyArn || !secretsKeyArn) throw new Error('Required KMS aliases did not resolve.');

  const alertsTopicArn = `arn:${partition(region)}:sns:${region}:${account}:capiro-${envName}-alerts`;
  await awsJson(['sns', 'get-topic-attributes', '--topic-arn', alertsTopicArn]);
  const apiRepositoryName = `capiro/${envName}/api`;
  await awsJson(['ecr', 'describe-repositories', '--repository-names', apiRepositoryName]);
  const existingApiImageDigest = await resolveImageDigest(container.image, apiRepositoryName);

  const contexts = {
    account,
    region,
    env: envName,
    existingClusterArn: cluster.clusterArn,
    existingApiRepositoryName: apiRepositoryName,
    existingApiImageDigest,
    existingPrivateSubnetIds: privateSubnetIds.join(','),
    existingServiceSecurityGroupId: securityGroups[0],
    existingDbSecretArn: dbSecretArn,
    existingAppDbSecretArn: appDbSecretArn,
    existingDatabaseName: 'capiro',
    existingDataKeyArn: dataKeyArn,
    existingSecretsKeyArn: secretsKeyArn,
    existingAlertsTopicArn: alertsTopicArn,
  };

  const output = path.resolve(
    ROOT,
    options.output ?? `.artifacts/meriv2-aws-context-${envName}.json`,
  );
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(
    output,
    `${JSON.stringify(
      {
        collectedAt: new Date().toISOString(),
        readOnly: true,
        callerArn: identity.Arn,
        profile,
        cluster: {
          name: clusterName,
          arn: cluster.clusterArn,
          status: cluster.status,
        },
        apiService: {
          name: apiServiceName,
          arn: service.serviceArn,
          desiredCount: service.desiredCount,
          runningCount: service.runningCount,
          pendingCount: service.pendingCount,
          taskDefinitionArn: service.taskDefinition,
          currentImage: container.image,
          currentImageDigest: existingApiImageDigest,
        },
        contexts,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(
    JSON.stringify({
      marker: 'MERIV2_AWS_CONTEXT_COLLECTED',
      output,
      account,
      region,
      env: envName,
      existingApiImageDigest,
      privateSubnetCount: privateSubnetIds.length,
      securityGroupCount: securityGroups.length,
      secretValuesRead: false,
      awsMutation: false,
    }),
  );
}

async function resolveImageDigest(image, repository) {
  const raw = String(image ?? '').trim();
  const at = raw.match(/@(sha256:[0-9a-f]{64})$/i);
  if (at) return at[1];
  const separator = raw.lastIndexOf(':');
  const slash = raw.lastIndexOf('/');
  const tag = separator > slash ? raw.slice(separator + 1) : '';
  if (!tag) throw new Error(`Current API image is neither digest-pinned nor tagged: ${raw}`);
  const response = await awsJson([
    'ecr',
    'describe-images',
    '--repository-name',
    repository,
    '--image-ids',
    `imageTag=${tag}`,
  ]);
  const digest = response.imageDetails?.[0]?.imageDigest;
  if (!/^sha256:[0-9a-f]{64}$/i.test(String(digest ?? ''))) {
    throw new Error(`Current API image tag ${repository}:${tag} did not resolve to one digest.`);
  }
  return digest;
}

async function awsJson(args) {
  const finalArgs = [...args, '--region', region, '--profile', profile, '--output', 'json'];
  const { stdout, stderr } = await execFileAsync(aws, finalArgs, {
    cwd: ROOT,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (stderr?.trim()) process.stderr.write(stderr);
  return JSON.parse(stdout || '{}');
}

function requiredSecret(map, name, description) {
  const value = map.get(name);
  if (!value) throw new Error(`Current API task definition has no ${name} (${description}).`);
  return value;
}

function stripSecretSelector(value) {
  const parts = String(value).split(':');
  if (parts.length < 7 || parts[2] !== 'secretsmanager' || parts[5] !== 'secret') {
    throw new Error(`Unexpected Secrets Manager reference: ${value}`);
  }
  return parts.slice(0, 7).join(':');
}

function unique(values) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function partition(value) {
  if (value.startsWith('us-gov-')) return 'aws-us-gov';
  if (value.startsWith('cn-')) return 'aws-cn';
  return 'aws';
}

function parse(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const [rawName, inline] = arg.slice(2).split('=', 2);
    const name = rawName.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = inline ?? args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${rawName}`);
    parsed[name] = value;
  }
  return parsed;
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      marker: 'MERIV2_AWS_CONTEXT_COLLECTION_FAILED',
      error: error instanceof Error ? error.message : String(error),
      awsMutation: false,
    }),
  );
  process.exitCode = 1;
});
