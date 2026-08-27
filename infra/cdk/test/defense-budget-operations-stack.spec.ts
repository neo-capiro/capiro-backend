import assert from 'node:assert/strict';
import test from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DefenseBudgetOperationsStack } from '../lib/defense-budget-operations-stack';
import type { EnvConfig } from '../lib/config';

const DIGEST = `sha256:${'b'.repeat(64)}`;

function baseCfg(): EnvConfig {
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

function synth(overrides: Partial<Parameters<typeof buildStack>[0]> = {}) {
  return buildStack(overrides).template;
}

function buildStack(overrides: {
  existingExtractionArtifactBucketName?: string;
  extractionArtifactPrefix?: string;
} = {}) {
  const app = new cdk.App();
  const cfg = baseCfg();
  const stack = new DefenseBudgetOperationsStack(app, 'Capiro-dev-DefenseBudgetOperations', {
    env: { account: cfg.account, region: cfg.region },
    cfg,
    clusterArn: 'arn:aws:ecs:us-east-1:000000000000:cluster/capiro-dev',
    vpcId: 'vpc-0123456789abcdef0',
    privateSubnetIds: ['subnet-aaaaaaaaaaaaaaaaa', 'subnet-bbbbbbbbbbbbbbbbb'],
    serviceSecurityGroupId: 'sg-0123456789abcdef0',
    apiRepositoryName: 'capiro/dev/api',
    apiImageDigest: DIGEST,
    dbSecretArn: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:capiro/dev/aurora/master-AAAAAA',
    appDbSecretArn: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:capiro/dev/aurora/app-AAAAAA',
    databaseName: 'capiro',
    rawBucketName: 'capiro-defense-budget-raw-dev-000000000000',
    dataKeyArn: 'arn:aws:kms:us-east-1:000000000000:key/data-key-id',
    secretsKeyArn: 'arn:aws:kms:us-east-1:000000000000:key/secrets-key-id',
    ...overrides,
  });
  return { stack, template: Template.fromStack(stack) };
}

test('synthesizes exactly one one-shot task definition with the exact drain command', () => {
  const template = synth();
  const taskDefs = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
  assert.equal(taskDefs.length, 1);
  const task: any = taskDefs[0];
  assert.deepEqual(task.Properties.ContainerDefinitions[0].Command, [
    'drain-defense-budget-ingestion-outbox-v1',
  ]);
});

test('binds an immutable image digest, not a mutable tag', () => {
  const template = synth();
  const rendered = JSON.stringify(template.toJSON());
  assert.ok(rendered.includes(DIGEST));
});

test('DB secret is wired correctly and no PROMOTER_DATABASE_URL appears anywhere in the template', () => {
  const template = synth();
  const rendered = JSON.stringify(template.toJSON());
  assert.ok(!rendered.includes('PROMOTER_DATABASE_URL'));
  const task: any = Object.values(template.findResources('AWS::ECS::TaskDefinition'))[0];
  const names = task.Properties.ContainerDefinitions[0].Secrets.map((s: any) => s.Name);
  assert.deepEqual(new Set(names), new Set(['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD']));
});

test('extraction bucket env + exact artifact prefix + ephemeral parser scratch are set', () => {
  const template = synth({ existingExtractionArtifactBucketName: 'capiro-dev-preverified-extraction-artifacts' });
  const task: any = Object.values(template.findResources('AWS::ECS::TaskDefinition'))[0];
  const env: Array<{ Name: string; Value: string }> = task.Properties.ContainerDefinitions[0].Environment;
  const byName = new Map(env.map((e) => [e.Name, e.Value]));
  assert.equal(byName.get('BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_BUCKET'), 'capiro-dev-preverified-extraction-artifacts');
  assert.equal(byName.get('BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_PREFIX'), 'phase10/parser-artifacts');
  assert.equal(byName.get('BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT'), '/tmp/defense-budget-parser-scratch');
  assert.equal(byName.get('DEFENSE_BUDGET_RAW_BUCKET'), 'capiro-defense-budget-raw-dev-000000000000');
});

test('GetObjectVersion is present for both the raw bucket and the extraction prefix', () => {
  const template = synth({ existingExtractionArtifactBucketName: 'capiro-dev-preverified-extraction-artifacts' });
  const policies: any[] = Object.values(template.findResources('AWS::IAM::Policy'));
  const s3Statements: any[] = [];
  for (const policy of policies) {
    for (const statement of policy.Properties.PolicyDocument.Statement) {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      if (actions.some((a: string) => a.startsWith('s3:'))) s3Statements.push(statement);
    }
  }
  const rendered = JSON.stringify(s3Statements);
  const versionActions = s3Statements.filter((s) => {
    const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
    return actions.includes('s3:GetObjectVersion');
  });
  assert.ok(versionActions.length >= 2, `expected GetObjectVersion on at least 2 statements, got: ${rendered}`);
});

test('when no pre-verified bucket is supplied, this stack creates its OWN versioned+KMS+block-public extraction bucket', () => {
  const { template } = buildStack();
  const buckets: any[] = Object.values(template.findResources('AWS::S3::Bucket'));
  assert.equal(buckets.length, 1, 'expected exactly one dedicated extraction-artifact bucket');
  const bucket = buckets[0];
  assert.equal(bucket.Properties.VersioningConfiguration?.Status, 'Enabled');
  assert.ok(bucket.Properties.BucketEncryption?.ServerSideEncryptionConfiguration?.[0]?.ServerSideEncryptionByDefault?.SSEAlgorithm === 'aws:kms');
  assert.deepEqual(bucket.Properties.PublicAccessBlockConfiguration, {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  });
});

test('when a pre-verified bucket name IS supplied, no new S3 bucket is created', () => {
  const template = synth({ existingExtractionArtifactBucketName: 'capiro-dev-preverified-extraction-artifacts' });
  const buckets = Object.keys(template.findResources('AWS::S3::Bucket'));
  assert.equal(buckets.length, 0);
});

test('no ECS Service, no EventBridge Rule, no schedule of any kind', () => {
  const template = synth();
  assert.equal(Object.keys(template.findResources('AWS::ECS::Service')).length, 0);
  assert.equal(Object.keys(template.findResources('AWS::Events::Rule')).length, 0);
  assert.equal(Object.keys(template.findResources('AWS::Scheduler::Schedule')).length, 0);
  assert.equal(Object.keys(template.findResources('AWS::ApplicationAutoScaling::ScalableTarget')).length, 0);
});

test('no ALB, no Route53, no Aurora resource is created by this stack', () => {
  const template = synth();
  assert.equal(Object.keys(template.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer')).length, 0);
  assert.equal(Object.keys(template.findResources('AWS::ElasticLoadBalancingV2::Listener')).length, 0);
  assert.equal(Object.keys(template.findResources('AWS::Route53::RecordSet')).length, 0);
  assert.equal(Object.keys(template.findResources('AWS::RDS::DBCluster')).length, 0);
});

test('the operations app/stack imports nothing from compute-stack.ts (source-level guard, comment-blind)', () => {
  // This is a structural guard against a future edit accidentally wiring the
  // one-shot worker INTO the frozen Compute stack instead of this isolated
  // one. It deliberately checks only real import/instantiation statements,
  // not prose -- a naive whole-file substring match would false-positive on
  // this very file's own explanatory doc comments (which must be free to
  // name what they're avoiding). The actual git-diff proof that capiro.ts /
  // compute-stack.ts carry zero line changes in this PR is run separately
  // (`git diff --stat origin/main -- infra/cdk/bin/capiro.ts
  // infra/cdk/lib/compute-stack.ts`); this test only proves the import graph.
  const fs = require('node:fs');
  const path = require('node:path');
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const importOrInstantiationPattern = /from\s+['"][^'"]*compute-stack['"]|new\s+ComputeStack\s*\(/;

  const opsAppSource = stripComments(
    fs.readFileSync(path.join(__dirname, '..', 'bin', 'defense-budget-operations.ts'), 'utf8'),
  );
  assert.ok(!importOrInstantiationPattern.test(opsAppSource));

  const opsStackSource = stripComments(
    fs.readFileSync(path.join(__dirname, '..', 'lib', 'defense-budget-operations-stack.ts'), 'utf8'),
  );
  assert.ok(!importOrInstantiationPattern.test(opsStackSource));
});
