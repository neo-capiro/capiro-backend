import assert from 'node:assert/strict';
import test from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import {
  GovernmentForecastOperationsStack,
  FORECAST_ARCHIVE,
  FORECAST_IMAGE,
} from '../lib/government-forecast-operations-stack';
import { ScheduledIngestionJobs } from '../lib/constructs/scheduled-ingestion-jobs';

function synth() {
  return Template.fromStack(
    new GovernmentForecastOperationsStack(
      new cdk.App({ context: { '@aws-cdk/core:validateAgainstDefaultRules': true } }),
      'ForecastTest',
      {
        env: { account: '967807252336', region: 'us-east-1' },
      },
    ),
  );
}

test('one additive job; current pinned ARM64 image, no service/DB/secret creation', () => {
  const t = synth();
  for (const kind of [
    'AWS::ECS::Service',
    'AWS::RDS::DBCluster',
    'AWS::SecretsManager::Secret',
    'AWS::Lambda::Function',
  ])
    t.resourceCountIs(kind, 0);
  t.resourceCountIs('AWS::ECS::TaskDefinition', 1);
  t.resourceCountIs('AWS::Events::Rule', 1);
  t.hasResourceProperties('AWS::ECS::TaskDefinition', {
    Family: 'capiro-preview-government-forecasts',
    NetworkMode: 'awsvpc',
    RequiresCompatibilities: ['FARGATE'],
    Cpu: '512',
    Memory: '2048',
    RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: 'forecast',
        Image: FORECAST_IMAGE,
        Command: ['refresh-government-forecasts', '--help'],
        ReadonlyRootFilesystem: true,
        Secrets: [{ Name: 'DATABASE_URL', ValueFrom: { Ref: 'ForecastDatabaseUrlSecretArn' } }],
        MountPoints: [
          { ContainerPath: FORECAST_ARCHIVE, ReadOnly: false, SourceVolume: 'forecast-archive' },
        ],
      }),
    ]),
  });
  assert(!JSON.stringify(t.toJSON()).includes('fo-dev-sync-tango-forecasts'));
});

test('clone inputs have no invented defaults and subnet/AZ relations are asserted', () => {
  const json = synth().toJSON();
  for (const name of [
    'CloneVpcId',
    'ClonePrivateSubnetA',
    'ClonePrivateSubnetB',
    'CloneSubnetAzA',
    'CloneSubnetAzB',
    'CloneClusterArn',
    'CloneDatabaseSecurityGroupId',
    'ForecastDatabaseUrlSecretArn',
  ]) {
    assert(json.Parameters[name]);
    assert(!('Default' in json.Parameters[name]));
  }
  assert.equal(json.Parameters.EnableDailyRule.Default, 'false');
  assert(JSON.stringify(json.Rules).includes('Fn::ValueOfAll'));
  assert(JSON.stringify(json.Rules).includes('AvailabilityZone'));
  assert(
    JSON.stringify(json.Parameters.ForecastDatabaseUrlSecretArn).includes(
      'arn:aws:secretsmanager:',
    ),
  );
  assert(!JSON.stringify(json).includes('postgresql://'));
});

test('retained encrypted archive, private mount targets, AP POSIX identity, TLS and IAM', () => {
  const t = synth();
  t.resourceCountIs('AWS::EFS::FileSystem', 1);
  t.resourceCountIs('AWS::EFS::MountTarget', 2);
  t.hasResource('AWS::EFS::FileSystem', {
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: Match.objectLike({ Encrypted: true, BackupPolicy: { Status: 'ENABLED' } }),
  });
  t.hasResource('AWS::EFS::AccessPoint', {
    DeletionPolicy: 'Retain',
    Properties: Match.objectLike({
      PosixUser: { Uid: '1001', Gid: '1001' },
      RootDirectory: {
        Path: '/government-forecasts',
        CreationInfo: { OwnerUid: '1001', OwnerGid: '1001', Permissions: '0700' },
      },
    }),
  });
  t.hasResourceProperties('AWS::ECS::TaskDefinition', {
    Volumes: [
      {
        Name: 'forecast-archive',
        EFSVolumeConfiguration: {
          FilesystemId: Match.anyValue(),
          TransitEncryption: 'ENABLED',
          AuthorizationConfig: { AccessPointId: Match.anyValue(), IAM: 'ENABLED' },
        },
      },
    ],
  });
  const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'));
  assert(policies.includes('elasticfilesystem:AccessPointArn'));
  assert(policies.includes('elasticfilesystem:AccessedViaMountTarget'));
  assert(policies.includes('elasticfilesystem:ClientWrite'));
  assert(!policies.includes('elasticfilesystem:ClientRootAccess'));
  const fs = JSON.stringify(t.findResources('AWS::EFS::FileSystem'));
  assert(fs.includes('aws:SecureTransport'));
  assert(fs.includes('aws:PrincipalArn'));
});

test('daily rule stays disabled until explicit enablement; event ID drives run identity with retry0', () => {
  const t = synth();
  t.hasResourceProperties('AWS::Events::Rule', {
    Name: 'capiro-preview-government-forecasts',
    ScheduleExpression: 'cron(13 4 * * ? *)',
    State: { 'Fn::If': ['DailyApproved', 'ENABLED', 'DISABLED'] },
    Targets: Match.arrayWith([
      Match.objectLike({
        Arn: { Ref: 'CloneClusterArn' },
        RetryPolicy: { MaximumRetryAttempts: 0 },
        EcsParameters: Match.objectLike({
          TaskCount: 1,
          NetworkConfiguration: {
            AwsVpcConfiguration: {
              AssignPublicIp: 'DISABLED',
              Subnets: [{ Ref: 'ClonePrivateSubnetA' }, { Ref: 'ClonePrivateSubnetB' }],
              SecurityGroups: Match.anyValue(),
            },
          },
        }),
        InputTransformer: Match.objectLike({
          InputPathsMap: { id: '$.id' },
          InputTemplate: Match.anyValue(),
        }),
      }),
    ]),
  });
  const rule = JSON.stringify(t.findResources('AWS::Events::Rule'));
  for (const word of ['refresh-government-forecasts', '--run-id', '--apply', FORECAST_ARCHIVE])
    assert(rule.includes(word));
});

test('database ingress is scoped to producer SG and secret reads to execution role', () => {
  const t = synth();
  t.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    GroupId: { Ref: 'CloneDatabaseSecurityGroupId' },
    SourceSecurityGroupId: Match.anyValue(),
    IpProtocol: 'tcp',
    FromPort: 5432,
    ToPort: 5432,
  });
  t.hasResourceProperties('AWS::EC2::SecurityGroupEgress', {
    DestinationSecurityGroupId: { Ref: 'CloneDatabaseSecurityGroupId' },
    IpProtocol: 'tcp',
    FromPort: 5432,
    ToPort: 5432,
  });
  const policies = Object.values(t.findResources('AWS::IAM::Policy')) as Array<{
    Properties: { PolicyDocument: unknown; Roles: unknown };
  }>;
  const secretPolicies = policies.filter((p) =>
    JSON.stringify(p.Properties.PolicyDocument).includes('secretsmanager:GetSecretValue'),
  );
  assert.equal(secretPolicies.length, 1);
  assert(JSON.stringify(secretPolicies[0]?.Properties.Roles).includes('ExecutionRole'));
  assert(
    JSON.stringify(secretPolicies[0]?.Properties.PolicyDocument).includes(
      'ForecastDatabaseUrlSecretArn',
    ),
  );
  t.hasResource('AWS::IAM::Policy', {
    Condition: 'CustomerSecretKey',
    Properties: Match.objectLike({
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'kms:Decrypt', Resource: { Ref: 'ForecastSecretKmsKeyArn' } }),
        ]),
      }),
    }),
  });
});

test('shared scheduled-job defaults are preserved when retryAttempts is omitted', () => {
  const stack = new cdk.Stack(new cdk.App(), 'LegacyDefaults', {
    env: { account: '000000000000', region: 'us-east-1' },
  });
  const vpc = ec2.Vpc.fromVpcAttributes(stack, 'Vpc', {
    vpcId: 'vpc-00000000000000001',
    availabilityZones: ['us-east-1a'],
    privateSubnetIds: ['subnet-00000000000000001'],
  });
  const cluster = ecs.Cluster.fromClusterAttributes(stack, 'Cluster', {
    clusterArn: 'arn:aws:ecs:us-east-1:000000000000:cluster/synthetic',
    clusterName: 'synthetic',
    vpc,
  });
  const task = new ecs.FargateTaskDefinition(stack, 'Task');
  task.addContainer('core', { image: ecs.ContainerImage.fromRegistry('synthetic:fixture') });
  new ScheduledIngestionJobs(stack, 'Jobs', {
    envName: 'test',
    cluster,
    taskDefinition: task,
    containerName: 'core',
    securityGroup: new ec2.SecurityGroup(stack, 'SG', { vpc }),
    jobs: [
      {
        id: 'Existing',
        tier: 'daily',
        description: 'Synthetic existing job',
        command: ['existing'],
        cron: { hour: '1', minute: '0' },
      },
      {
        id: 'OutOfBand',
        tier: 'daily',
        description: 'Not owned',
        command: ['unowned'],
        cron: { hour: '2', minute: '0' },
        managedOutOfBand: true,
      },
    ],
  });
  const t = Template.fromStack(stack);
  t.resourceCountIs('AWS::Events::Rule', 1);
  t.hasResourceProperties('AWS::Events::Rule', {
    State: 'ENABLED',
    Targets: Match.arrayWith([
      Match.objectLike({
        RetryPolicy: Match.absent(),
        Input: JSON.stringify({ containerOverrides: [{ name: 'core', command: ['existing'] }] }),
      }),
    ]),
  });
});
