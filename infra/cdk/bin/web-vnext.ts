#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { awsEnv, loadConfig, stackName, type EnvConfig } from '../lib/config';
import { WebVNextStack } from '../lib/web-vnext-stack';

/**
 * Standalone Capiro web-vnext app.
 *
 * The live env=dev Compute stack is frozen/drifted and must not be used to add
 * os.capiro.ai. This app imports the already-running network/cluster/manual ALB
 * by literal identifiers and creates only the additive web-vnext resources.
 * Route53 remains an operator-controlled final cutover step after health checks.
 */
const app = new cdk.App();
const cfg = loadConfig(app);
const vnextCfg: EnvConfig = {
  ...cfg,
  protectFromDestroy: true,
  logRetentionDays: Math.max(cfg.logRetentionDays, 90),
};
const env = awsEnv(vnextCfg);
const partition = partitionForRegion(vnextCfg.region);

const releaseSha = required(app, 'releaseSha');
if (!/^[0-9a-f]{40}$/i.test(releaseSha)) {
  throw new Error('releaseSha must be the exact 40-character release SHA.');
}

const webImageDigest = required(app, 'webVnextImageDigest');
if (!/^sha256:[0-9a-f]{64}$/i.test(webImageDigest)) {
  throw new Error('webVnextImageDigest must be an immutable ECR sha256 digest.');
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
const privateSubnetAvailabilityZones = csv(required(app, 'existingPrivateSubnetAzs'));
if (privateSubnetAvailabilityZones.length !== privateSubnetIds.length) {
  throw new Error(
    'existingPrivateSubnetAzs must list one availability zone per private subnet, in order.',
  );
}

const serviceSecurityGroupId = required(app, 'existingServiceSecurityGroupId');
if (!/^sg-[a-z0-9]+$/i.test(serviceSecurityGroupId)) {
  throw new Error('existingServiceSecurityGroupId must be an sg-* id.');
}

const vpcId = required(app, 'existingVpcId');
if (!/^vpc-[a-z0-9]+$/i.test(vpcId)) {
  throw new Error('existingVpcId must be a vpc-* id.');
}

const httpsListenerArn = listenerArn(required(app, 'existingHttpsListenerArn'));
const certificateArn = acmArn(required(app, 'webVnextCertificateArn'));
const clerkPublishableKeySecretArn = completeSecretArn(
  required(app, 'existingClerkPublishableKeyArn'),
  'existingClerkPublishableKeyArn',
);
const secretsKeyArn = keyArn(required(app, 'existingSecretsKeyArn'), 'existingSecretsKeyArn');

const hostname = optional(app, 'webVnextHostname') ?? 'os.capiro.ai';
if (hostname !== 'os.capiro.ai') {
  throw new Error(
    `webVnextHostname must be os.capiro.ai for this migration stack; received ${hostname}.`,
  );
}

const listenerPriority = positiveInt(
  required(app, 'webVnextListenerPriority'),
  'webVnextListenerPriority',
);
if (listenerPriority <= 20) {
  throw new Error(
    'webVnextListenerPriority must be > 20 so existing backend path rules keep precedence.',
  );
}

const desiredCount = positiveInt(
  optional(app, 'webVnextDesiredCount') ?? '1',
  'webVnextDesiredCount',
);
const maxCount = positiveInt(optional(app, 'webVnextMaxCount') ?? '2', 'webVnextMaxCount');
if (maxCount < desiredCount) {
  throw new Error('webVnextMaxCount must be >= webVnextDesiredCount.');
}

new WebVNextStack(app, stackName(vnextCfg.envName, 'WebVNext'), {
  env,
  cfg: vnextCfg,
  releaseSha,
  clusterArn:
    optional(app, 'existingClusterArn') ??
    `arn:${partition}:ecs:${vnextCfg.region}:${vnextCfg.account}:cluster/capiro-${vnextCfg.envName}`,
  vpcId,
  privateSubnetIds,
  privateSubnetAvailabilityZones,
  serviceSecurityGroupId,
  webRepositoryName:
    optional(app, 'existingWebVnextRepositoryName') ?? `capiro/${vnextCfg.envName}/web-vnext`,
  webImageDigest,
  clerkPublishableKeySecretArn,
  secretsKeyArn,
  httpsListenerArn,
  certificateArn,
  hostname,
  listenerPriority,
  desiredCount,
  maxCount,
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

function positiveInt(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function completeSecretArn(value: string, name: string): string {
  if (!/^arn:[^:]+:secretsmanager:[^:]+:\d{12}:secret:[^:]+$/.test(value)) {
    throw new Error(`${name} must be a complete Secrets Manager ARN.`);
  }
  return value;
}

function keyArn(value: string, name: string): string {
  if (!/^arn:[^:]+:kms:[^:]+:\d{12}:key\/[a-z0-9-]+$/i.test(value)) {
    throw new Error(`${name} must be a KMS key ARN.`);
  }
  return value;
}

function listenerArn(value: string): string {
  if (!/^arn:[^:]+:elasticloadbalancing:[^:]+:\d{12}:listener\/app\/.+$/.test(value)) {
    throw new Error('existingHttpsListenerArn must be an ALB HTTPS listener ARN.');
  }
  return value;
}

function acmArn(value: string): string {
  if (!/^arn:[^:]+:acm:[^:]+:\d{12}:certificate\/[a-z0-9-]+$/i.test(value)) {
    throw new Error('webVnextCertificateArn must be an ACM certificate ARN.');
  }
  return value;
}

function partitionForRegion(region: string): string {
  if (region.startsWith('us-gov-')) return 'aws-us-gov';
  if (region.startsWith('cn-')) return 'aws-cn';
  return 'aws';
}
