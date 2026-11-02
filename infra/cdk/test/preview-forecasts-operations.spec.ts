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
  FORECASTS_IMPORT_RETURNED_TERM,
  FORECASTS_IMPORTER_SECRET_NAME,
  FORECASTS_OPERATIONS_STACK_NAME,
  FORECASTS_STALE_HOURS,
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
const container = (template: Template) =>
  (Object.values(template.findResources('AWS::ECS::TaskDefinition'))[0]!.Properties.ContainerDefinitions as Record<string, unknown>[])[0]!;

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

test('the task receives DATABASE_URL whole from a secret Release owns, with a read-only root and no DB_* or unused environment', () => {
  const template = render();
  template.resourceCountIs('AWS::ECS::TaskDefinition', 1);
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    Family: 'capiro-preview-government-forecasts',
    RuntimePlatform: { CpuArchitecture: 'ARM64' },
    Cpu: '1024',
    ContainerDefinitions: [
      Match.objectLike({
        Name: FORECASTS_CONTAINER_NAME,
        Command: ['refresh-government-forecasts', '--help'],
        ReadonlyRootFilesystem: true,
        Secrets: [Match.objectLike({ Name: 'DATABASE_URL' })],
        Environment: Match.arrayWith([{ Name: 'TMPDIR', Value: '/dev/shm' }]),
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
  const definition = container(template);
  const names = (definition.Environment as { Name: string }[]).map((entry) => entry.Name);
  for (const name of names) assert.doesNotMatch(name, /^DB_/);
  for (const unused of ['NODE_ENV', 'APP_ENV', 'FORECAST_ARCHIVE_DIR']) assert.ok(!names.includes(unused), unused);
  // The secret is referenced by name, never created or updated by this stack, so a deploy cannot reset its value.
  template.resourceCountIs('AWS::SecretsManager::Secret', 0);
  assert.match(JSON.stringify((definition.Secrets as unknown[])[0]), new RegExp(FORECASTS_IMPORTER_SECRET_NAME.replace(/\//g, '\\/')));
  // The image is pinned by digest, never a tag.
  assert.match(JSON.stringify(definition.Image), /@sha256:a1e35b1a/);
});

test('the archive is one durable encrypted EFS root with a job-owned access point reached only through a mount target, retained on delete', () => {
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
        Match.objectLike({
          Action: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
          Condition: { StringEquals: Match.anyValue(), Bool: { 'elasticfilesystem:AccessedViaMountTarget': 'true' } },
        }),
      ]),
    }),
  });
});

test('the daily rule ships disabled with retry 0 and a DLQ; no staging bucket or other live resource exists', () => {
  const template = render();
  template.resourceCountIs('AWS::S3::Bucket', 0);
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
  // Nothing live besides the job: no service, listener rule, DNS record or database resource.
  for (const type of ['AWS::ECS::Service', 'AWS::ElasticLoadBalancingV2::ListenerRule', 'AWS::Route53::RecordSet', 'AWS::RDS::DBCluster', 'AWS::RDS::DBInstance'])
    template.resourceCountIs(type, 0);
  assert.equal(previewForecastsOperationsApplication(binding, fresh()).stack.stackName, FORECASTS_OPERATIONS_STACK_NAME);
});

test('alarms cover the scripts\' terminal failure lines, undelivered occurrences, and silence once the schedule is enabled', () => {
  const template = render();
  const filters = Object.values(template.findResources('AWS::Logs::MetricFilter')).map((f) => String(f.Properties.FilterPattern));
  assert.equal(filters.length, 2);
  for (const term of FORECASTS_FAILURE_TERMS) assert.ok(filters.some((pattern) => pattern.includes(term)), term);
  assert.ok(filters.some((pattern) => pattern.includes(FORECASTS_IMPORT_RETURNED_TERM)));
  template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
  template.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: 'capiro-preview-government-forecasts-failed', TreatMissingData: 'notBreaching' });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: 'capiro-preview-government-forecasts-delivery-failed' });
  // Disabled schedule: the stale alarm exists but does not page; enabling the schedule enables its actions in the same render.
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmName: 'capiro-preview-government-forecasts-stale',
    ActionsEnabled: false,
    ComparisonOperator: 'LessThanThreshold',
    Threshold: 1,
    TreatMissingData: 'breaching',
    Period: 6 * 3600,
    EvaluationPeriods: FORECASTS_STALE_HOURS / 6,
    DatapointsToAlarm: FORECASTS_STALE_HOURS / 6,
    MetricName: 'import.returned',
  });
  const enabled = Template.fromStack(previewForecastsOperationsApplication({ ...binding, scheduleEnabled: true }, fresh()).stack);
  enabled.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: 'capiro-preview-government-forecasts-stale', ActionsEnabled: true });
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
