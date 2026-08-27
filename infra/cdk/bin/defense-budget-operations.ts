#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { loadConfig, stackName, type EnvConfig } from '../lib/config';
import { DefenseBudgetOperationsStack } from '../lib/defense-budget-operations-stack';

/**
 * Independent defense-budget operations app (Phase 10B-4).
 *
 * Mirrors the deployment-isolation doctrine `infra/cdk/bin/meriv2-operations.ts`
 * already established: the live `dev` environment serves production traffic
 * (app.capiro.ai) through the historical, already-drifted Compute stack, and
 * that stack is intentionally not a safe prerequisite for shipping a new
 * one-shot worker. This app imports the already-running cluster/VPC/subnets/
 * security group/secrets/KMS keys/S3 buckets by literal context values and
 * deploys exactly ONE additive stack:
 *
 *   - Capiro-<env>-DefenseBudgetOperations
 *
 * It never creates or updates the ALB, DNS, Aurora, any long-running ECS
 * service, or any EventBridge rule/schedule. Every synthesis binds the API
 * container by immutable ECR digest.
 */
const app = new cdk.App();
const cfg = loadConfig(app);
// This one-off worker's task definition + log group are audit evidence, same
// posture as the MeriV2 operations app's own operationsCfg override.
const operationsCfg: EnvConfig = {
  ...cfg,
  protectFromDestroy: true,
  logRetentionDays: Math.max(cfg.logRetentionDays, 365),
};
const env = { account: operationsCfg.account, region: operationsCfg.region };

const apiImageDigest = required(app, 'defenseBudgetApiImageDigest');
if (!/^sha256:[0-9a-f]{64}$/i.test(apiImageDigest)) {
  throw new Error('defenseBudgetApiImageDigest must be an immutable ECR sha256 digest.');
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
const vpcId = (() => {
  const value = required(app, 'existingVpcId');
  if (!/^vpc-[a-z0-9]+$/i.test(value)) {
    throw new Error('existingVpcId must be a vpc-* id.');
  }
  return value;
})();
const clusterArn =
  optional(app, 'existingClusterArn') ??
  `arn:${partitionForRegion(operationsCfg.region)}:ecs:${operationsCfg.region}:${operationsCfg.account}:cluster/capiro-${operationsCfg.envName}`;

const stack = new DefenseBudgetOperationsStack(
  app,
  stackName(operationsCfg.envName, 'DefenseBudgetOperations'),
  {
    env,
    cfg: operationsCfg,
    clusterArn,
    vpcId,
    privateSubnetIds,
    serviceSecurityGroupId,
    apiRepositoryName:
      optional(app, 'existingApiRepositoryName') ?? `capiro/${operationsCfg.envName}/api`,
    apiImageDigest,
    dbSecretArn: completeArn(required(app, 'existingDbSecretArn'), 'existingDbSecretArn'),
    appDbSecretArn: completeArn(
      required(app, 'existingAppDbSecretArn'),
      'existingAppDbSecretArn',
    ),
    databaseName: optional(app, 'existingDatabaseName') ?? 'capiro',
    rawBucketName: required(app, 'existingRawBucketName'),
    existingExtractionArtifactBucketName:
      optional(app, 'existingExtractionArtifactBucketName') ?? undefined,
    extractionArtifactPrefix: optional(app, 'extractionArtifactPrefix') ?? undefined,
    dataKeyArn: keyArn(required(app, 'existingDataKeyArn'), 'existingDataKeyArn'),
    secretsKeyArn: keyArn(required(app, 'existingSecretsKeyArn'), 'existingSecretsKeyArn'),
  },
);

const releaseSha = optional(app, 'releaseSha');
if (releaseSha) {
  if (!/^[0-9a-f]{40}$/i.test(releaseSha)) {
    throw new Error('releaseSha must be the exact 40-character release SHA.');
  }
  new cdk.CfnOutput(stack, 'DefenseBudgetOperationsReleaseSha', {
    value: releaseSha,
    description: 'Exact release SHA whose API tag resolved to the bound digest',
  });
}

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
