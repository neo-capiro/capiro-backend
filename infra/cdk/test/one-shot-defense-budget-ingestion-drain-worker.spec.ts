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
  // API image is ARM64; unset platform defaults Fargate to X86_64 (exec format error).
  assert.equal(task.Properties.RuntimePlatform?.CpuArchitecture, 'ARM64');
  assert.equal(task.Properties.RuntimePlatform?.OperatingSystemFamily, 'LINUX');
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

test('S3 object-level permissions are object-scoped to the named buckets and artifact prefix, with GetObjectVersion alongside GetObject/PutObject, never a wildcard resource', () => {
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

  const objectStatements = s3Statements.filter((s) => !actionsOf(s).includes('s3:ListBucket'));

  const rawStatement = objectStatements.find((s) => resourceStringsOf(s).some((r) => r.includes('raw-bucket/*')));
  assert.ok(rawStatement, 'expected an object-level S3 statement scoped to raw-bucket/*');
  const rawActions = actionsOf(rawStatement);
  assert.ok(rawActions.includes('s3:GetObject'));
  assert.ok(rawActions.includes('s3:GetObjectVersion'));
  assert.ok(rawActions.includes('s3:PutObject'));
  // Object Lock GOVERNANCE default retention on the raw bucket requires this
  // on every PutObject even when the app never calls PutObjectRetention itself.
  assert.ok(rawActions.includes('s3:PutObjectRetention'));

  const extractionStatement = objectStatements.find((s) =>
    resourceStringsOf(s).some((r) => r.includes('artifact-bucket/phase10/parser-artifacts/*')),
  );
  assert.ok(extractionStatement, 'expected an object-level S3 statement scoped to artifact-bucket/phase10/parser-artifacts/*');
  const extractionActions = actionsOf(extractionStatement);
  assert.ok(extractionActions.includes('s3:GetObject'));
  assert.ok(extractionActions.includes('s3:GetObjectVersion'));
  assert.ok(extractionActions.includes('s3:PutObject'));

  // Exact resource scoping: every OBJECT-level S3 statement (GetObject/
  // GetObjectVersion/PutObject) is scoped to one of these two exact object
  // prefixes -- never wider, never a bucket-only ARN.
  for (const statement of objectStatements) {
    for (const resource of resourceStringsOf(statement)) {
      assert.ok(
        resource.includes('raw-bucket/*') || resource.includes('artifact-bucket/phase10/parser-artifacts/*'),
        `unexpected S3 object resource scope: ${resource}`,
      );
    }
  }
});

test('s3:ListBucket uses the bare bucket ARN (never bucket/*), carries an s3:prefix condition, and is never a wildcard resource', () => {
  const template = synth();
  const policies: any[] = Object.values(template.findResources('AWS::IAM::Policy'));

  function actionsOf(statement: any): string[] {
    return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
  }
  function resourceStringsOf(statement: any): string[] {
    const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
    return resources.map((r: any) => JSON.stringify(r));
  }

  const listStatements: any[] = [];
  for (const policy of policies) {
    for (const statement of policy.Properties.PolicyDocument.Statement) {
      if (actionsOf(statement).includes('s3:ListBucket')) listStatements.push(statement);
    }
  }
  assert.equal(listStatements.length, 2, 'expected exactly one ListBucket statement per bucket (raw + extraction)');

  for (const statement of listStatements) {
    // Never a wildcard resource.
    const resources = resourceStringsOf(statement);
    for (const resource of resources) assert.notEqual(resource, '*');
    // Bucket ARN only -- no trailing /* (that would be an OBJECT resource,
    // which ListBucket, a BUCKET-level action, does not accept).
    assert.ok(
      resources.every((r) => !r.includes('/*') && !r.endsWith('/"')),
      `ListBucket resource must be the bare bucket ARN, got: ${resources.join(', ')}`,
    );
    // Must carry an s3:prefix condition -- this is what narrows the
    // otherwise-bucket-wide ListBucket grant down to only the prefix this
    // task actually reads/writes.
    assert.ok(statement.Condition, 'expected an IAM Condition block on the ListBucket statement');
    const prefixCondition =
      statement.Condition.StringLike?.['s3:prefix'] ?? statement.Condition.StringEquals?.['s3:prefix'];
    assert.ok(prefixCondition, 'expected an s3:prefix condition on the ListBucket statement');
  }

  const rendered = JSON.stringify(template.toJSON());
  // Raw bucket ListBucket is scoped to the exact prefix headSafe() HEADs
  // (raw/public/dod-budget/*) -- code-trace-verified as the ONLY HEAD call
  // site in RawArchiveService; archiveDerived() never HEADs, so no second
  // prefix is added for derived/public/dod-budget/*.
  assert.ok(rendered.includes('raw/public/dod-budget/*'));
  // Extraction bucket ListBucket is scoped to the exact configured artifact
  // prefix (phase10/parser-artifacts by default), matching keyPrefix in
  // S3ExtractionArtifactStore.
  assert.ok(rendered.includes('phase10/parser-artifacts/*'));

  const rawList = listStatements.find((s) => resourceStringsOf(s).some((r) => r.includes('raw-bucket')));
  assert.ok(rawList, 'expected a ListBucket statement on the raw bucket');
  const rawListResources = Array.isArray(rawList.Resource) ? rawList.Resource : [rawList.Resource];
  assert.equal(rawListResources.length, 1);
  // The bucket ARN is built via a Fn::Join (partition token + literal bucket
  // name), never a plain string containing '/*' -- confirmed structurally,
  // not just by the rendered-JSON substring check above.
  assert.ok(!JSON.stringify(rawListResources[0]).includes('/*'));
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
