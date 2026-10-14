import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Template } from 'aws-cdk-lib/assertions';
import { existingCoreBindings } from '../lib/preview/existing-core-bindings';
import { existingCorePreviewApplication } from '../lib/preview/existing-core-application';
import { previewCoreRuntimeEnvironment } from '../lib/preview/core-runtime-environment';

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../fixtures/preview-core-existing.synthetic.json'), 'utf8'),
);
const output = path.join(os.tmpdir(), `capiro-existing-core-synth-${process.pid}`);
assert.equal(fs.existsSync(output), false);
after(() => {
  if (fs.existsSync(output)) {
    assert.equal(fs.lstatSync(output).isSymbolicLink(), false);
    fs.rmSync(output, { recursive: true });
  }
});
test('existing database proposal rejects values, tag images, production hosts and late rules', () => {
  for (const edit of [
    (x: any) => {
      x.secretValue = 'not-a-reference';
    },
    (x: any) => {
      x.hostname = 'os.capiro.ai';
    },
    (x: any) => {
      x.listenerPriority = 10;
    },
    (x: any) => {
      x.imageUri = x.imageUri.replace(/@sha256:.*/, ':latest');
    },
    (x: any) => {
      x.dbPasswordReference = 'postgresql://user:password@localhost/capiro';
    },
    (x: any) => {
      delete x.clerkWebhookReference;
    },
    (x: any) => {
      x.executionRoleArn = x.executionRoleArn.replace('967807252336', '000000000000');
    },
    (x: any) => {
      x.subnetIds[1] = x.subnetIds[0];
    },
    (x: any) => {
      x.databaseName = 'invented';
    },
  ]) {
    const input = structuredClone(fixture);
    edit(input);
    assert.throws(() => existingCoreBindings(input));
  }
});

test('Core-only template borrows database/access and changes no production service', () => {
  const { stack } = existingCorePreviewApplication(fixture, output);
  const resources = Object.values(Template.fromStack(stack).toJSON().Resources) as any[];
  assert.deepEqual(resources.map((r) => r.Type).sort(), [
    'AWS::ECS::Service',
    'AWS::ECS::TaskDefinition',
    'AWS::ElasticLoadBalancingV2::ListenerRule',
    'AWS::ElasticLoadBalancingV2::TargetGroup',
  ]);
  const task = resources.find((r) => r.Type === 'AWS::ECS::TaskDefinition').Properties;
  assert.equal(task.RuntimePlatform.CpuArchitecture, 'ARM64');
  assert.equal(task.ExecutionRoleArn, fixture.executionRoleArn);
  assert.equal(task.TaskRoleArn, fixture.taskRoleArn);
  const container = task.ContainerDefinitions[0];
  assert.equal(container.Image, fixture.imageUri);
  assert.deepEqual(container.Command, ['serve']);
  const refs = Object.fromEntries(container.Secrets.map((r: any) => [r.Name, r.ValueFrom]));
  assert.equal(refs.DB_PASSWORD, fixture.dbPasswordReference);
  assert.equal(refs.CLERK_WEBHOOK_SIGNING_SECRET, fixture.clerkWebhookReference);
  assert.deepEqual(Object.keys(refs).sort(), [
    'CLERK_SECRET_KEY',
    'CLERK_WEBHOOK_SIGNING_SECRET',
    'DB_HOST',
    'DB_PASSWORD',
    'DB_PORT',
    'DB_USER',
  ]);
  const environment = Object.fromEntries(container.Environment.map((r: any) => [r.Name, r.Value]));
  assert.equal(environment.CLERK_JWT_ISSUER, 'https://clerk.app.capiro.ai');
  assert.equal(environment.DB_NAME, 'capiro');
  assert.equal(environment.ASSETS_BUCKET, fixture.assetsBucket);
  assert.equal(environment.NODE_ENV, 'production');
  assert.equal(environment.RELEASE_SHA, fixture.sourceHead);
  const service = resources.find((r) => r.Type === 'AWS::ECS::Service').Properties;
  assert.equal(service.DesiredCount, 0);
  assert.equal(service.Cluster, fixture.clusterArn);
  assert.equal(service.ServiceName, 'capiro-preview-core-existing-db');
  assert.deepEqual(service.NetworkConfiguration.AwsvpcConfiguration.SecurityGroups, [
    fixture.serviceSecurityGroupId,
  ]);
  const target = resources.find(
    (r) => r.Type === 'AWS::ElasticLoadBalancingV2::TargetGroup',
  ).Properties;
  assert.equal(target.HealthCheckPath, '/health');
  const rule = resources.find(
    (r) => r.Type === 'AWS::ElasticLoadBalancingV2::ListenerRule',
  ).Properties;
  assert.equal(rule.Priority, 4);
  assert.deepEqual(rule.Conditions[0].HostHeaderConfig.Values, [fixture.hostname]);
  assert.deepEqual(rule.Conditions[1].PathPatternConfig.Values, ['/api/*', '/health']);
});

test('canonical Core runtime policy admits preview posture without background ownership', () => {
  const {
    resolveEngagementRuntimeEnvironment,
  } = require('../../../apps/api/src/engagement/runtime/engagement-runtime-env');
  const env = previewCoreRuntimeEnvironment();
  const result = resolveEngagementRuntimeEnvironment(env);
  assert.equal(result.serviceName, 'api');
  assert.equal(result.backgroundOwner, 'disabled');
  assert.equal(result.externalActions, 'disabled');
  assert.equal(result.callbacksEnabled, false);
  assert.equal(result.recallWebhookEnabled, false);
});

test('canonical completion worker does not sweep with the proposed control', () => {
  const {
    ClientProfileFillCompletionRuntime,
  } = require('../../../apps/api/src/clients/client-profile-fill-completion-runtime');
  const previous = process.env.CLIENT_PROFILE_FILL_COMPLETION_WORKER_ENABLED;
  let effects = 0;
  process.env.CLIENT_PROFILE_FILL_COMPLETION_WORKER_ENABLED =
    previewCoreRuntimeEnvironment().CLIENT_PROFILE_FILL_COMPLETION_WORKER_ENABLED;
  try {
    const runtime = new ClientProfileFillCompletionRuntime({ httpAdapter: {} }, 'preview', {
      requestTaskSweep: () => effects++,
      requestScheduleSweep: () => effects++,
      log: () => effects++,
    });
    runtime.onModuleInit();
    runtime.onModuleDestroy();
    assert.equal(effects, 0);
  } finally {
    if (previous === undefined) delete process.env.CLIENT_PROFILE_FILL_COMPLETION_WORKER_ENABLED;
    else process.env.CLIENT_PROFILE_FILL_COMPLETION_WORKER_ENABLED = previous;
  }
});
