import assert from 'node:assert/strict';
import test from 'node:test';
import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Template } from 'aws-cdk-lib/assertions';
import { OneShotDefenseBudgetIngestionDrainWorker } from '../lib/constructs/one-shot-defense-budget-ingestion-drain-worker';

function synth() {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'Test', { env: { account: '000000000000', region: 'us-east-1' } });
  new OneShotDefenseBudgetIngestionDrainWorker(stack, 'Worker', {
    envName: 'test', apiRepo: ecr.Repository.fromRepositoryName(stack, 'Repo', 'api'), apiImageDigest: `sha256:${'a'.repeat(64)}`,
    appDbSecret: secretsmanager.Secret.fromSecretCompleteArn(stack, 'AppDb', 'arn:aws:secretsmanager:us-east-1:000000000000:secret:app-db-AbCdEf'),
    rawBucketName: 'raw-bucket', extractionArtifactBucketName: 'artifact-bucket', dataKeyArn: 'arn:aws:kms:us-east-1:000000000000:key/data', secretsKeyArn: 'arn:aws:kms:us-east-1:000000000000:key/secrets', protectFromDestroy: false,
  });
  return Template.fromStack(stack);
}

test('synthesizes exact one-shot command and no EventBridge schedule', () => {
  const template = synth();
  assert.equal(Object.keys(template.findResources('AWS::Events::Rule')).length, 0);
  const task: any = Object.values(template.findResources('AWS::ECS::TaskDefinition'))[0];
  assert.deepEqual(task.Properties.ContainerDefinitions[0].Command, ['drain-defense-budget-ingestion-outbox-v1']);
  const rendered = JSON.stringify(template.toJSON());
  assert.ok(!rendered.includes('PROMOTER_DATABASE_URL'));
  assert.ok(rendered.includes('DATABASE_URL'));
});

test('S3 permissions are object-scoped to the named buckets and artifact prefix', () => {
  const rendered = JSON.stringify(synth().toJSON());
  assert.ok(rendered.includes('raw-bucket/*'));
  assert.ok(rendered.includes('artifact-bucket/phase10/parser-artifacts/*'));
  const policies: any[] = Object.values(synth().findResources('AWS::IAM::Policy'));
  for (const policy of policies) for (const statement of policy.Properties.PolicyDocument.Statement) {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    if (actions.some((a: string) => a.startsWith('s3:'))) assert.notEqual(statement.Resource, '*');
  }
});
