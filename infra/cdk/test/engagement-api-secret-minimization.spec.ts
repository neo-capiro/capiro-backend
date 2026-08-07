import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import type { EngagementApiInfraConfig } from '../lib/engagement-api/engagement-api-config';
import { EngagementApiServiceStack } from '../lib/engagement-api/engagement-api-service-stack';

const CDK_ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(CDK_ROOT, 'fixtures/engagement-api.test.json');
const TARGET_GROUP_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/capiro-dev-engagement-api/3333';

function synth(): Template {
  const cfg = JSON.parse(readFileSync(FIXTURE, 'utf8')) as EngagementApiInfraConfig;
  cfg.imageDigest = `sha256:${'ab'.repeat(32)}`;
  cfg.releaseSha = 'c'.repeat(40);
  const app = new cdk.App();
  return Template.fromStack(
    new EngagementApiServiceStack(app, 'Capiro-dev-EngagementApiService', {
      cfg,
      env: { account: cfg.accountId, region: cfg.region },
      targetGroupArn: TARGET_GROUP_ARN,
    }),
  );
}

function taskContainer(template: Template): Record<string, any> {
  const task = Object.values(template.findResources('AWS::ECS::TaskDefinition'))[0] as {
    Properties: { ContainerDefinitions: Array<Record<string, any>> };
  };
  assert.ok(task);
  return task.Properties.ContainerDefinitions[0]!;
}

test('the dark task omits the unused Clerk webhook signing secret completely', () => {
  const template = synth();
  const secrets = (taskContainer(template).Secrets ?? []) as Array<{
    Name: string;
    ValueFrom: unknown;
  }>;
  const names = secrets.map((entry) => entry.Name).sort();
  assert.deepEqual(names, [
    'CLERK_SECRET_KEY',
    'DB_HOST',
    'DB_PASSWORD',
    'DB_PORT',
    'DB_USER',
    'NOTES_ENCRYPTION_KEY',
    'OAUTH_TOKEN_ENCRYPTION_KEY',
  ]);
  assert.ok(!names.includes('CLERK_WEBHOOK_SIGNING_SECRET'));
});

test('the execution role receives no permission to read the webhook signing secret', () => {
  const rendered = JSON.stringify(synth().toJSON());
  assert.doesNotMatch(rendered, /webhook-signing-secret/);
  assert.doesNotMatch(rendered, /CLERK_WEBHOOK_SIGNING_SECRET/);
});
