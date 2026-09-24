import assert from 'node:assert/strict';
import test from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DefenseBudgetAnnualOperationsStack } from '../lib/defense-budget-annual-operations-stack';
import type { EnvConfig } from '../lib/config';

const DIGEST = `sha256:${'d'.repeat(64)}`;
const SHA = 'a'.repeat(40);

function cfg(): EnvConfig {
  return {
    envName: 'dev',
    account: '000000000000',
    region: 'us-east-1',
    hostedZoneDomain: 'capiro.ai',
    rootDomain: 'capiro.ai',
    appHost: 'app.capiro.ai',
    wildcardHost: '*.app.capiro.ai',
    auroraMinAcu: 0.5,
    auroraMaxAcu: 4,
    auroraBackupRetentionDays: 7,
    apiCpu: 512,
    apiMemoryMib: 1024,
    apiDesiredCount: 1,
    apiMaxCount: 2,
    webCpu: 256,
    webMemoryMib: 512,
    webDesiredCount: 1,
    webMaxCount: 2,
    marketingCpu: 256,
    marketingMemoryMib: 512,
    marketingDesiredCount: 1,
    marketingMaxCount: 2,
    workspaceCpu: 256,
    workspaceMemoryMib: 512,
    workspaceDesiredCount: 1,
    workspaceMaxCount: 2,
    meriv2OrchestratorCpu: 256,
    meriv2OrchestratorMemoryMib: 512,
    meriv2OrchestratorDesiredCount: 1,
    meriv2OrchestratorMaxCount: 2,
    apiStrategyCpu: 256,
    apiStrategyMemoryMib: 512,
    apiStrategyDesiredCount: 1,
    apiStrategyMaxCount: 2,
    protectFromDestroy: true,
    logRetentionDays: 365,
  };
}

function synth(scheduleEnabled = false): Template {
  const app = new cdk.App();
  const envCfg = cfg();
  const stack = new DefenseBudgetAnnualOperationsStack(
    app,
    'Capiro-dev-DefenseBudgetAnnualOperations',
    {
      env: { account: envCfg.account, region: envCfg.region },
      cfg: envCfg,
      clusterArn: 'arn:aws:ecs:us-east-1:000000000000:cluster/capiro-dev',
      vpcId: 'vpc-0123456789abcdef0',
      privateSubnetIds: ['subnet-aaaaaaaaaaaaaaaaa', 'subnet-bbbbbbbbbbbbbbbbb'],
      privateSubnetAvailabilityZones: ['us-east-1a', 'us-east-1b'],
      serviceSecurityGroupId: 'sg-0123456789abcdef0',
      defenseApiRepositoryName: 'capiro/dev/defense-api',
      defenseApiImageDigest: DIGEST,
      releaseSha: SHA,
      dbSecretArn:
        'arn:aws:secretsmanager:us-east-1:000000000000:secret:/capiro/dev/aurora/master-AAAAAA',
      defenseJobSecretArn:
        'arn:aws:secretsmanager:us-east-1:000000000000:secret:/capiro/dev/aurora/defense-job-BBBBBB',
      databaseName: 'capiro',
      secretsKeyArn: 'arn:aws:kms:us-east-1:000000000000:key/secrets-key-id',
      alertsTopicArn: 'arn:aws:sns:us-east-1:000000000000:capiro-dev-platform-alarms',
      scheduleEnabled,
    },
  );
  return Template.fromStack(stack);
}

test('creates one digest-pinned ARM64 coordinator task and no service', () => {
  const template = synth();
  const tasks: any[] = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].Properties.Family, 'capiro-dev-defense-budget-lifecycle-coordinator');
  assert.equal(tasks[0].Properties.RuntimePlatform.CpuArchitecture, 'ARM64');
  assert.deepEqual(tasks[0].Properties.ContainerDefinitions[0].Command, [
    'schedule-tick',
    '--commit',
  ]);
  assert.ok(JSON.stringify(tasks[0]).includes(DIGEST));
  assert.equal(Object.keys(template.findResources('AWS::ECS::Service')).length, 0);
});

test('uses the defense-job login secret and fail-closed schedule settings', () => {
  const template = synth();
  const task: any = Object.values(template.findResources('AWS::ECS::TaskDefinition'))[0];
  const container = task.Properties.ContainerDefinitions[0];
  const env = new Map(container.Environment.map((entry: any) => [entry.Name, entry.Value]));
  assert.equal(env.get('PHASE8_SESSION10_TICK_AUTHORIZED'), 'true');
  assert.equal(env.get('PHASE8_SESSION8_LIVE_DISCOVERY'), 'true');
  assert.equal(env.get('DEFENSE_BUDGET_DISCOVERY_REQUEST_BUDGET'), '25');
  assert.equal(env.get('DEFENSE_BUDGET_WATCHER_LEASE_SECONDS'), '4500');
  assert.equal(env.get('NVIDIA_ROUTING_MODE'), 'disabled');
  const secrets = new Map(container.Secrets.map((entry: any) => [entry.Name, entry.ValueFrom]));
  assert.match(JSON.stringify(secrets.get('DB_USER')), /defense-job/);
  assert.match(JSON.stringify(secrets.get('DB_PASSWORD')), /defense-job/);
});

test('is dark by default and renders exactly one hourly rule when explicitly enabled', () => {
  const dark: any = Object.values(synth(false).findResources('AWS::Events::Rule'))[0];
  assert.equal(dark.Properties.State, 'DISABLED');
  const active: any = Object.values(synth(true).findResources('AWS::Events::Rule'))[0];
  assert.equal(active.Properties.State, 'ENABLED');
  assert.equal(active.Properties.ScheduleExpression, 'rate(1 hour)');
  assert.equal(active.Properties.Targets[0].RetryPolicy.MaximumRetryAttempts, 0);
  assert.ok(active.Properties.Targets[0].DeadLetterConfig);
});

test('creates no ALB, DNS, database, or long-running runtime resource', () => {
  const template = synth();
  assert.equal(
    Object.keys(template.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer')).length,
    0,
  );
  assert.equal(Object.keys(template.findResources('AWS::Route53::RecordSet')).length, 0);
  assert.equal(Object.keys(template.findResources('AWS::RDS::DBCluster')).length, 0);
  assert.equal(
    Object.keys(template.findResources('AWS::ApplicationAutoScaling::ScalableTarget')).length,
    0,
  );
});
