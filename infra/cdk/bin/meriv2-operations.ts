#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { awsEnv, loadConfig, stackName, type EnvConfig } from '../lib/config';
import { MemoryProjectionWorkerStack } from '../lib/memory-projection-worker-stack';
import { MeriV2ControlStack } from '../lib/meriv2-control-stack';

/**
 * Independent MeriV2 operations app.
 *
 * The live environment named `dev` serves production traffic and its historical
 * Compute stack is intentionally not a safe prerequisite for this release. This
 * app imports the already-running cluster/network/secrets/topic by literal
 * identifiers and deploys only the two additive MeriV2 operational stacks:
 *
 *   - Capiro-<env>-MemoryProjectionWorker
 *   - Capiro-<env>-MeriV2Control
 *
 * It never creates or updates the ALB, DNS, Aurora, long-running ECS services,
 * ECR repositories, or existing secrets. Both EventBridge schedules default
 * disabled. Every synthesis binds the API container by immutable ECR digest;
 * `releaseSha` remains separate audit evidence for the tag that resolved to it.
 */
const app = new cdk.App();
const cfg = loadConfig(app);
// The historical `dev` config allows stack deletion for iteration, but that
// environment is production. These audit/control stacks always retain evidence.
const operationsCfg: EnvConfig = {
  ...cfg,
  protectFromDestroy: true,
  logRetentionDays: Math.max(cfg.logRetentionDays, 365),
};
const env = awsEnv(operationsCfg);
const partition = partitionForRegion(operationsCfg.region);

const releaseSha = required(app, 'releaseSha');
if (!/^[0-9a-f]{40}$/i.test(releaseSha)) {
  throw new Error('releaseSha must be the exact 40-character release SHA.');
}
const apiImageDigest = required(app, 'meriv2ApiImageDigest');
if (!/^sha256:[0-9a-f]{64}$/i.test(apiImageDigest)) {
  throw new Error('meriv2ApiImageDigest must be an immutable ECR sha256 digest.');
}

const privateSubnetIds = csv(required(app, 'existingPrivateSubnetIds'));
if (
  privateSubnetIds.length === 0 ||
  privateSubnetIds.some((id) => !/^subnet-[a-z0-9]+$/i.test(id))
) {
  throw new Error(
    'existingPrivateSubnetIds must contain one or more comma-separated subnet-* ids.',
  );
}
const serviceSecurityGroupId = required(app, 'existingServiceSecurityGroupId');
if (!/^sg-[a-z0-9]+$/i.test(serviceSecurityGroupId)) {
  throw new Error('existingServiceSecurityGroupId must be an sg-* id.');
}

const shared = {
  cfg: operationsCfg,
  clusterArn:
    optional(app, 'existingClusterArn') ??
    `arn:${partition}:ecs:${operationsCfg.region}:${operationsCfg.account}:cluster/capiro-${operationsCfg.envName}`,
  apiRepositoryName:
    optional(app, 'existingApiRepositoryName') ?? `capiro/${operationsCfg.envName}/api`,
  apiImageDigest,
  privateSubnetIds,
  serviceSecurityGroupId,
  dbSecretArn: completeArn(required(app, 'existingDbSecretArn'), 'existingDbSecretArn'),
  appDbSecretArn: completeArn(required(app, 'existingAppDbSecretArn'), 'existingAppDbSecretArn'),
  databaseName: optional(app, 'existingDatabaseName') ?? 'capiro',
  dataKeyArn: keyArn(required(app, 'existingDataKeyArn'), 'existingDataKeyArn'),
  secretsKeyArn: keyArn(required(app, 'existingSecretsKeyArn'), 'existingSecretsKeyArn'),
  alertsTopicArn:
    optional(app, 'existingAlertsTopicArn') ??
    `arn:${partition}:sns:${operationsCfg.region}:${operationsCfg.account}:capiro-${operationsCfg.envName}-alerts`,
};

const projectionWorker = new MemoryProjectionWorkerStack(
  app,
  stackName(operationsCfg.envName, 'MemoryProjectionWorker'),
  {
    env,
    ...shared,
    scheduleEnabled: exactTrue(app.node.tryGetContext('enableMemoryProjectionWorker')),
  },
);

const control = new MeriV2ControlStack(app, stackName(operationsCfg.envName, 'MeriV2Control'), {
  env,
  ...shared,
  monitorEnabled: exactTrue(app.node.tryGetContext('enableMeriV2ControlMonitor')),
});
control.addDependency(projectionWorker);

new cdk.CfnOutput(projectionWorker, 'MeriV2OperationsReleaseSha', {
  value: releaseSha,
  description: 'Exact release SHA whose API tag resolved to the bound digest',
});

app.synth();

function required(target: cdk.App, name: string): string {
  const value = optional(target, name);
  if (!value) throw new Error(`Missing required CDK context: ${name}`);
  return value;
}

function optional(target: cdk.App, name: string): string | null {
  const value = String(target.node.tryGetContext(name) ?? '').trim();
  return value || null;
}

function csv(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function exactTrue(value: unknown): boolean {
  return (
    String(value ?? '')
      .trim()
      .toLowerCase() === 'true'
  );
}

function completeArn(value: string, name: string): string {
  if (!/^arn:[^:]+:secretsmanager:[^:]+:\d{12}:secret:[^:]+$/.test(value)) {
    throw new Error(`${name} must be a complete Secrets Manager ARN without a JSON-key selector.`);
  }
  return value;
}

function keyArn(value: string, name: string): string {
  if (!/^arn:[^:]+:kms:[^:]+:\d{12}:key\/[a-z0-9-]+$/i.test(value)) {
    throw new Error(`${name} must be a KMS key ARN.`);
  }
  return value;
}

function partitionForRegion(region: string): string {
  if (region.startsWith('us-gov-')) return 'aws-us-gov';
  if (region.startsWith('cn-')) return 'aws-cn';
  return 'aws';
}
