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

function synth(recordSecret?: string, inventoried = true): Template {
  const cfg = JSON.parse(readFileSync(FIXTURE, 'utf8')) as EngagementApiInfraConfig;
  cfg.imageDigest = `sha256:${'ab'.repeat(32)}`;
  cfg.releaseSha = 'c'.repeat(40);
  if (recordSecret) {
    cfg.publishedRecordRead = { internalServiceSecretArn: recordSecret };
    if (inventoried) cfg.requiredSecretArns.push(recordSecret);
  }
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
    'ANTHROPIC_API_KEY',
    'CLERK_SECRET_KEY',
    'DB_HOST',
    'DB_PASSWORD',
    'DB_PORT',
    'DB_USER',
    'NOTES_ENCRYPTION_KEY',
    'OAUTH_TOKEN_ENCRYPTION_KEY',
    'OPENAI_API_KEY',
  ]);
  assert.ok(!names.includes('CLERK_WEBHOOK_SIGNING_SECRET'));
});

test('the execution role receives no permission to read the webhook signing secret', () => {
  const rendered = JSON.stringify(synth().toJSON());
  assert.doesNotMatch(rendered, /webhook-signing-secret/);
  assert.doesNotMatch(rendered, /CLERK_WEBHOOK_SIGNING_SECRET/);
});

test('private record read credential is exact and does not promote the shadow service', () => {
  const arn = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:capiro/dev/internal-service-ABC123';
  const template = synth(arn), container = taskContainer(template);
  assert.deepEqual(container.Secrets.find((s: any) => s.Name === 'INTERNAL_SERVICE_SECRET'), {
    Name: 'INTERNAL_SERVICE_SECRET', ValueFrom: arn,
  });
  const env = Object.fromEntries(container.Environment.map((e: any) => [e.Name, e.Value]));
  assert.equal(env.ENGAGEMENT_EXTERNAL_ACTIONS, 'disabled');
  assert.equal(env.ENGAGEMENT_API_PROMOTION_TOKEN, undefined);
  const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
  assert.ok(policies.includes(arn));
  assert.doesNotMatch(policies, /internal-service-\*/);
});

test('uninventoried and wildcard record read credentials fail synthesis', () => {
  const arn = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:capiro/dev/internal-service-ABC123';
  assert.throws(() => synth(arn, false), /exact inventoried/);
  assert.throws(() => synth(arn.replace('ABC123', '*')), /exact inventoried/);
});
