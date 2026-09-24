#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { loadConfig, stackName, type EnvConfig } from '../lib/config';
import { DefenseBudgetAnnualOperationsStack } from '../lib/defense-budget-annual-operations-stack';

const app = new cdk.App();
const cfg = loadConfig(app);
const operationsCfg: EnvConfig = {
  ...cfg,
  protectFromDestroy: true,
  logRetentionDays: Math.max(cfg.logRetentionDays, 365),
};

new DefenseBudgetAnnualOperationsStack(
  app,
  stackName(operationsCfg.envName, 'DefenseBudgetAnnualOperations'),
  {
    env: { account: operationsCfg.account, region: operationsCfg.region },
    cfg: operationsCfg,
    clusterArn:
      optional('existingClusterArn') ??
      `arn:aws:ecs:${operationsCfg.region}:${operationsCfg.account}:cluster/capiro-${operationsCfg.envName}`,
    vpcId: required('existingVpcId'),
    privateSubnetIds: csv(required('existingPrivateSubnetIds')),
    privateSubnetAvailabilityZones: csv(required('existingPrivateSubnetAvailabilityZones')),
    serviceSecurityGroupId: required('existingServiceSecurityGroupId'),
    defenseApiRepositoryName:
      optional('existingDefenseApiRepositoryName') ?? `capiro/${operationsCfg.envName}/defense-api`,
    defenseApiImageDigest: digest(required('defenseBudgetDefenseApiImageDigest')),
    releaseSha: sha(required('releaseSha')),
    dbSecretArn: secretArn(required('existingDbSecretArn')),
    defenseJobSecretArn: secretArn(required('existingDefenseJobSecretArn')),
    databaseName: optional('existingDatabaseName') ?? 'capiro',
    secretsKeyArn: keyArn(required('existingSecretsKeyArn')),
    alertsTopicArn: required('existingAlertsTopicArn'),
    scheduleEnabled: optional('enableLifecycleCoordinator') === 'true',
    discoveryRequestBudget: numeric(optional('lifecycleDiscoveryRequestBudget')),
    watcherLeaseSeconds: numeric(optional('lifecycleWatcherLeaseSeconds')),
  },
);

app.synth();

function required(name: string): string {
  const value = optional(name);
  if (!value) throw new Error(`Missing required CDK context: ${name}`);
  return value;
}
function optional(name: string): string | null {
  const value = String(app.node.tryGetContext(name) ?? '').trim();
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
function digest(value: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error('Invalid image digest.');
  return value;
}
function sha(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error('Invalid release SHA.');
  return value;
}
function secretArn(value: string): string {
  if (!/^arn:[^:]+:secretsmanager:[^:]+:\d{12}:secret:[^:]+$/.test(value)) {
    throw new Error('Expected a complete Secrets Manager ARN.');
  }
  return value;
}
function keyArn(value: string): string {
  if (!/^arn:[^:]+:kms:[^:]+:\d{12}:key\/[A-Za-z0-9-]+$/.test(value)) {
    throw new Error('Expected a KMS key ARN.');
  }
  return value;
}
function numeric(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Expected integer context, got ${value}`);
  return parsed;
}
