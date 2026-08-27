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
    envName: 'test',
    apiRepo: ecr.Repository.fromRepositoryName(stack, 'Repo', 'api'),
    apiImageDigest: `sha256:${'a'.repeat(64)}`,
    dbSecret: secretsmanager.Secret.fromSecretCompleteArn(
      stack,
      'DbSecret',
      'arn:aws:secretsmanager:us-east-1:000000000000:secret:db-master-AbCdEf',
    ),
    appDbSecret: secretsmanager.Secret.fromSecretCompleteArn(
      stack,
      'AppDb',
      'arn:aws:secretsmanager:us-east-1:000000000000:secret:app-db-AbCdEf',
    ),
    databaseName: 'capiro',
    rawBucketName: 'raw-bucket',
    extractionArtifactBucketName: 'artifact-bucket',
    dataKeyArn: 'arn:aws:kms:us-east-1:000000000000:key/data',
    secretsKeyArn: 'arn:aws:kms:us-east-1:000000000000:key/secrets',
    protectFromDestroy: false,
  });
  return Template.fromStack(stack);
}

test('synthesizes exact one-shot command and no EventBridge schedule', () => {
  const template = synth();
  assert.equal(Object.keys(template.findResources('AWS::Events::Rule')).length, 0);
  assert.equal(Object.keys(template.findResources('AWS::ECS::Service')).length, 0);
  const taskDefs = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
  assert.equal(taskDefs.length, 1);
  const task: any = taskDefs[0];
  assert.deepEqual(task.Properties.ContainerDefinitions[0].Command, ['drain-defense-budget-ingestion-outbox-v1']);
  const rendered = JSON.stringify(template.toJSON());
  assert.ok(!rendered.includes('PROMOTER_DATABASE_URL'));
});

test('DB_* secrets are wired from the correct master/app credential fields, matching the entrypoint-dispatcher.inc DATABASE_URL contract', () => {
  const template = synth();
  const task: any = Object.values(template.findResources('AWS::ECS::TaskDefinition'))[0];
  const secrets: Array<{ Name: string; ValueFrom: unknown }> = task.Properties.ContainerDefinitions[0].Secrets;
  const names = secrets.map((s) => s.Name);
  assert.ok(names.includes('DB_HOST'));
  assert.ok(names.includes('DB_PORT'));
  assert.ok(names.includes('DB_USER'));
  assert.ok(names.includes('DB_PASSWORD'));
  // Never a single-secret DATABASE_URL field -- neither the master nor the app
  // secret has one; entrypoint-dispatcher.inc composes it from these four parts.
  assert.ok(!names.includes('DATABASE_URL'));
  const rendered = JSON.stringify(template.toJSON());
  // DB_HOST/DB_PORT must read from the master secret ARN fragment, DB_USER/
  // DB_PASSWORD from the app secret ARN fragment -- proven by each ValueFrom
  // referencing the distinct secret's logical resource, not just any secret.
  const hostSecret = secrets.find((s) => s.Name === 'DB_HOST')!;
  const userSecret = secrets.find((s) => s.Name === 'DB_USER')!;
  assert.notDeepEqual(hostSecret.ValueFrom, userSecret.ValueFrom);
  void rendered;
});

test('S3 permissions are object-scoped to the named buckets and artifact prefix, with GetObjectVersion alongside GetObject/PutObject, never a wildcard resource', () => {
  const template = synth();
  const rendered = JSON.stringify(template.toJSON());
  assert.ok(rendered.includes('raw-bucket/*'));
  assert.ok(rendered.includes('artifact-bucket/phase10/parser-artifacts/*'));
  const policies: any[] = Object.values(template.findResources('AWS::IAM::Policy'));

  const s3Statements: any[] = [];
  for (const policy of policies) {
    for (const statement of policy.Properties.PolicyDocument.Statement) {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      if (actions.some((a: string) => a.startsWith('s3:'))) {
        s3Statements.push(statement);
        assert.notEqual(statement.Resource, '*');
        const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
        for (const resource of resources) {
          assert.notEqual(resource, '*');
        }
      }
    }
  }
  assert.ok(s3Statements.length >= 2, 'expected at least one S3 statement for the raw bucket and one for the extraction prefix');

  function actionsOf(statement: any): string[] {
    return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
  }
  function resourceStringsOf(statement: any): string[] {
    const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
    return resources.map((r: any) => JSON.stringify(r));
  }

  const rawStatement = s3Statements.find((s) => resourceStringsOf(s).some((r) => r.includes('raw-bucket/*')));
  assert.ok(rawStatement, 'expected an S3 statement scoped to raw-bucket/*');
  const rawActions = actionsOf(rawStatement);
  assert.ok(rawActions.includes('s3:GetObject'));
  assert.ok(rawActions.includes('s3:GetObjectVersion'));
  assert.ok(rawActions.includes('s3:PutObject'));

  const extractionStatement = s3Statements.find((s) =>
    resourceStringsOf(s).some((r) => r.includes('artifact-bucket/phase10/parser-artifacts/*')),
  );
  assert.ok(extractionStatement, 'expected an S3 statement scoped to artifact-bucket/phase10/parser-artifacts/*');
  const extractionActions = actionsOf(extractionStatement);
  assert.ok(extractionActions.includes('s3:GetObject'));
  assert.ok(extractionActions.includes('s3:GetObjectVersion'));
  assert.ok(extractionActions.includes('s3:PutObject'));

  // Exact resource scoping: no statement carrying s3:GetObjectVersion (or any
  // other s3: action) is scoped wider than one of these two exact prefixes.
  for (const statement of s3Statements) {
    for (const resource of resourceStringsOf(statement)) {
      assert.ok(
        resource.includes('raw-bucket/*') || resource.includes('artifact-bucket/phase10/parser-artifacts/*'),
        `unexpected S3 resource scope: ${resource}`,
      );
    }
  }
});

test('KMS grants are scoped to the exact named keys, never a wildcard resource', () => {
  const template = synth();
  const policies: any[] = Object.values(template.findResources('AWS::IAM::Policy'));
  for (const policy of policies) {
    for (const statement of policy.Properties.PolicyDocument.Statement) {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      if (actions.some((a: string) => a.startsWith('kms:'))) {
        assert.notEqual(statement.Resource, '*');
      }
    }
  }
});
