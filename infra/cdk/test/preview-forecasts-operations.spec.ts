import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Match, Template } from 'aws-cdk-lib/assertions';
import {
  FORECASTS_ARCHIVE_DIR,
  FORECASTS_CONTAINER_NAME,
  FORECASTS_FAILURE_TERMS,
  FORECASTS_IMPORTER_SECRET_NAME,
  FORECASTS_OPERATIONS_STACK_NAME,
  forecastsOperationsBinding,
  previewForecastsOperationsApplication,
} from '../lib/preview/forecasts-operations';
import { main } from '../bin/preview-forecasts-operations';

const binding = {
  schemaVersion: 1,
  sourceHead: 'd03a118192acd2b1ed2ef5698afb0ab8f2b36ae8',
  imageDigest: 'sha256:a1e35b1aeae40889b46c75df472ced83aebe54b8f78234bffef4192c9767e375',
  scheduleEnabled: false,
  schedule: { hour: 6, minute: 30 },
};
const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'forecasts-ops-'));
const render = (input: unknown = binding) => {
  const { stack } = previewForecastsOperationsApplication(input, fresh());
  return Template.fromStack(stack);
};

test('the binding is exact: immutable digest, exact head, boolean enablement, bounded schedule', () => {
  assert.deepEqual(forecastsOperationsBinding(binding), binding);
  for (const bad of [
    { ...binding, imageDigest: 'latest' },
    { ...binding, sourceHead: 'main' },
    { ...binding, scheduleEnabled: 'yes' },
    { ...binding, schedule: { hour: 24, minute: 0 } },
    { ...binding, extra: true },
    { ...binding, schemaVersion: 2 },
  ])
    assert.throws(() => forecastsOperationsBinding(bad));
});

test('the task receives DATABASE_URL whole from the importer secret and nothing composed from DB_*', () => {
  const template = render();
  template.resourceCountIs('AWS::ECS::TaskDefinition', 1);
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    Family: 'capiro-preview-government-forecasts',
    RuntimePlatform: { CpuArchitecture: 'ARM64' },
    ContainerDefinitions: [
      Match.objectLike({
        Name: FORECASTS_CONTAINER_NAME,
        Command: ['refresh-government-forecasts', '--help'],
        Secrets: [Match.objectLike({ Name: 'DATABASE_URL' })],
        Environment: Match.not(Match.arrayWith([Match.objectLike({ Name: Match.stringLikeRegexp('^DB_') })])),
        MountPoints: [{ ContainerPath: FORECASTS_ARCHIVE_DIR, SourceVolume: 'forecast-archive', ReadOnly: false }],
      }),
    ],
    Volumes: [
      Match.objectLike({
        Name: 'forecast-archive',
        EFSVolumeConfiguration: Match.objectLike({ TransitEncryption: 'ENABLED', AuthorizationConfig: Match.objectLike({ IAM: 'ENABLED' }) }),
      }),
    ],
  });
  template.hasResourceProperties('AWS::SecretsManager::Secret', { Name: FORECASTS_IMPORTER_SECRET_NAME });
  const secrets = template.findResources('AWS::SecretsManager::Secret');
  assert.equal(Object.keys(secrets).length, 1);
  assert.equal(Object.values(secrets)[0]!.DeletionPolicy, 'Retain');
  // The image is pinned by digest, never a tag.
  const containers = Object.values(template.findResources('AWS::ECS::TaskDefinition'))[0]!.Properties.ContainerDefinitions as { Image: unknown }[];
  assert.match(JSON.stringify(containers[0]!.Image), /@sha256:a1e35b1a/);
});

test('the archive is one durable encrypted EFS root with a job-owned access point, retained on delete', () => {
  const template = render();
  template.hasResource('AWS::EFS::FileSystem', { DeletionPolicy: 'Retain', Properties: Match.objectLike({ Encrypted: true, LifecyclePolicies: Match.arrayWith([{ TransitionToIA: 'AFTER_30_DAYS' }]) }) });
  template.hasResourceProperties('AWS::EFS::AccessPoint', {
    RootDirectory: { Path: '/forecast-archive', CreationInfo: { OwnerUid: '1001', OwnerGid: '1001', Permissions: '750' } },
    PosixUser: { Uid: '1001', Gid: '1001' },
  });
  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', Match.objectLike({ FromPort: 2049, ToPort: 2049, SourceSecurityGroupId: 'sg-01def4e5c0fe44d4a' }));
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({ Action: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'], Condition: Match.objectLike({ StringEquals: Match.anyValue() }) }),
      ]),
    }),
  });
});

test('staging is versioned, private and read-only for the task; the daily rule ships disabled with retry 0 and a DLQ', () => {
  const template = render();
  template.hasResource('AWS::S3::Bucket', {
    DeletionPolicy: 'Retain',
    Properties: Match.objectLike({ VersioningConfiguration: { Status: 'Enabled' }, PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true, RestrictPublicBuckets: true }) }),
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    Name: 'capiro-preview-government-forecasts-daily',
    State: 'DISABLED',
    ScheduleExpression: 'cron(30 6 * * ? *)',
    Targets: [
      Match.objectLike({
        RetryPolicy: { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 1800 },
        DeadLetterConfig: Match.anyValue(),
        EcsParameters: Match.objectLike({ TaskCount: 1 }),
        InputTransformer: Match.objectLike({ InputPathsMap: { id: '$.id' } }),
      }),
    ],
  });
  const rule = Object.values(template.findResources('AWS::Events::Rule'))[0]!;
  const transformer = JSON.stringify(rule.Properties.Targets[0].InputTransformer.InputTemplate);
  for (const part of ['refresh-government-forecasts', '--archive-dir', FORECASTS_ARCHIVE_DIR, '--run-id', '--apply']) assert.ok(transformer.includes(part), part);
  const enabled = previewForecastsOperationsApplication({ ...binding, scheduleEnabled: true }, fresh());
  Template.fromStack(enabled.stack).hasResourceProperties('AWS::Events::Rule', { State: 'ENABLED' });
});

test('failures alarm on the scripts\' own terminal lines and on undelivered occurrences', () => {
  const template = render();
  template.hasResourceProperties('AWS::Logs::MetricFilter', {
    MetricTransformations: [Match.objectLike({ MetricNamespace: 'Capiro/GovernmentForecasts', MetricName: 'task.failed' })],
  });
  const filter = Object.values(template.findResources('AWS::Logs::MetricFilter'))[0]!;
  for (const term of FORECASTS_FAILURE_TERMS) assert.ok(String(filter.Properties.FilterPattern).includes(term), term);
  template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
  template.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: 'capiro-preview-government-forecasts-failed', TreatMissingData: 'notBreaching' });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: 'capiro-preview-government-forecasts-delivery-failed' });
  // Nothing live besides the job: no service, listener rule, DNS record or database resource.
  for (const type of ['AWS::ECS::Service', 'AWS::ElasticLoadBalancingV2::ListenerRule', 'AWS::Route53::RecordSet', 'AWS::RDS::DBCluster', 'AWS::RDS::DBInstance'])
    template.resourceCountIs(type, 0);
  assert.equal(previewForecastsOperationsApplication(binding, fresh()).stack.stackName, FORECASTS_OPERATIONS_STACK_NAME);
});

test('the bin renders only from a bounded binding into a fresh directory', () => {
  const dir = fresh();
  const file = path.join(dir, 'binding.json');
  fs.writeFileSync(file, JSON.stringify(binding));
  assert.equal(main(['--render', file, path.join(dir, 'out')]), 0);
  assert.ok(fs.existsSync(path.join(dir, 'out', `${FORECASTS_OPERATIONS_STACK_NAME}.template.json`)));
  assert.equal(main(['--render', file, path.join(dir, 'out')]), 2, 'an existing output directory is refused');
  assert.equal(main(['--help']), 0);
  assert.equal(main([]), 2);
});
