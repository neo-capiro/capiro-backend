/**
 * engagement-api ECR Registry stack.
 *
 * Assertions are explicit resource properties rather than a whole-template
 * snapshot: a snapshot would go green on `--update` and hide exactly the
 * property drift these tests exist to catch.
 *
 * Run: pnpm --dir infra/cdk exec ts-node --prefer-ts-exts test/engagement-api-registry-stack.spec.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import { type EngagementApiInfraConfig } from '../lib/engagement-api/engagement-api-config';
import { EngagementApiRegistryStack } from '../lib/engagement-api/engagement-api-registry-stack';
import {
  assertNoSensitiveTagValues,
  engagementApiTags,
} from '../lib/engagement-api/engagement-api-tags';

const CDK_ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(CDK_ROOT, 'fixtures/engagement-api.test.json');

const base = (): EngagementApiInfraConfig =>
  JSON.parse(readFileSync(FIXTURE, 'utf8')) as EngagementApiInfraConfig;

function synth(cfg: EngagementApiInfraConfig = base()): Template {
  const app = new cdk.App();
  const stack = new EngagementApiRegistryStack(app, 'Capiro-dev-EngagementApiRegistry', {
    cfg,
    env: { account: cfg.accountId, region: cfg.region },
  });
  return Template.fromStack(stack);
}


/** The single ECR repository, asserted to exist so tests never read undefined. */
function onlyRepository(template: Template): { Properties: Record<string, any> } {
  const found = Object.values(template.findResources('AWS::ECR::Repository'));
  assert.equal(found.length, 1, 'expected exactly one ECR repository');
  const repository = found[0];
  assert.ok(repository);
  return repository as { Properties: Record<string, any> };
}

// ─────────────────────────────────────────────────────────── repository shape

test('creates exactly one ECR repository with the exact name', () => {
  const template = synth();
  template.resourceCountIs('AWS::ECR::Repository', 1);
  template.hasResourceProperties('AWS::ECR::Repository', {
    RepositoryName: 'capiro/dev/engagement-api',
  });
});

test('the repository name tracks the environment', () => {
  const cfg = base();
  cfg.environment = 'prod';
  cfg.imageRepositoryName = 'capiro/prod/engagement-api';
  synth(cfg).hasResourceProperties('AWS::ECR::Repository', {
    RepositoryName: 'capiro/prod/engagement-api',
  });
});

test('image tags are immutable', () => {
  synth().hasResourceProperties('AWS::ECR::Repository', {
    ImageTagMutability: 'IMMUTABLE',
  });
});

test('scan on push is enabled', () => {
  synth().hasResourceProperties('AWS::ECR::Repository', {
    ImageScanningConfiguration: { ScanOnPush: true },
  });
});

test('the repository is KMS encrypted with the configured key', () => {
  synth().hasResourceProperties('AWS::ECR::Repository', {
    EncryptionConfiguration: {
      EncryptionType: 'KMS',
      KmsKey: base().kmsKeyArns.ecr,
    },
  });
});

test('the repository is retained and never emptied on delete', () => {
  const template = synth();
  template.hasResource('AWS::ECR::Repository', {
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  });
  const repository = onlyRepository(template);
  assert.notEqual(
    repository.Properties?.EmptyOnDelete,
    true,
    'emptyOnDelete would let a destroy take images a rollback needs',
  );
});

test('lifecycle rules expire untagged builds and retain 30 releases', () => {
  const template = synth();
  const policy = JSON.parse(
    onlyRepository(template).Properties.LifecyclePolicy.LifecyclePolicyText,
  );

  assert.equal(policy.rules.length, 2);
  const untagged = policy.rules.find((r: { selection: { tagStatus: string } }) => r.selection.tagStatus === 'untagged');
  assert.ok(untagged, 'no untagged-expiry rule');
  assert.equal(untagged.selection.countType, 'sinceImagePushed');
  assert.equal(untagged.selection.countNumber, 7);
  assert.equal(untagged.selection.countUnit, 'days');

  const retained = policy.rules.find((r: { selection: { countType: string } }) => r.selection.countType === 'imageCountMoreThan');
  assert.ok(retained, 'no release-retention rule');
  assert.equal(retained.selection.countNumber, 30);
});

test('outputs expose the ARN, URI and name', () => {
  const outputs = synth().findOutputs('*');
  for (const key of ['RepositoryArn', 'RepositoryUri', 'RepositoryName']) {
    assert.ok(Object.keys(outputs).includes(key), `missing output ${key}`);
  }
});

// ─────────────────────────────────────────────────────────────── isolation

test('the registry stack creates no compute, network, data or routing resource', () => {
  const template = synth();
  const forbidden = [
    'AWS::ECS::Cluster',
    'AWS::ECS::Service',
    'AWS::ECS::TaskDefinition',
    'AWS::ElasticLoadBalancingV2::LoadBalancer',
    'AWS::ElasticLoadBalancingV2::Listener',
    'AWS::ElasticLoadBalancingV2::ListenerRule',
    'AWS::ElasticLoadBalancingV2::TargetGroup',
    'AWS::EC2::VPC',
    'AWS::EC2::Subnet',
    'AWS::EC2::SecurityGroup',
    'AWS::EC2::SecurityGroupIngress',
    'AWS::RDS::DBCluster',
    'AWS::RDS::DBInstance',
    'AWS::Route53::RecordSet',
    'AWS::CertificateManager::Certificate',
    'AWS::KMS::Key',
    'AWS::SecretsManager::Secret',
  ];
  for (const type of forbidden) template.resourceCountIs(type, 0);
});

test('the only resource in the stack is the repository', () => {
  const resources = synth().toJSON().Resources ?? {};
  const types = [...new Set(Object.values(resources).map((r) => (r as { Type: string }).Type))];
  assert.deepEqual(types, ['AWS::ECR::Repository']);
});

test('the KMS key is imported by ARN, never created', () => {
  const template = synth();
  template.resourceCountIs('AWS::KMS::Key', 0);
  template.hasResourceProperties('AWS::ECR::Repository', {
    EncryptionConfiguration: { KmsKey: Match.stringLikeRegexp('^arn:aws:kms:') },
  });
});

test('the stack references no historical Compute stack export', () => {
  const rendered = JSON.stringify(synth().toJSON());
  assert.doesNotMatch(rendered, /Capiro-[a-z]+-Compute/);
});

// ──────────────────────────────────────────────────────────────────── tags

test('resources carry component, phase and ui-contract provenance tags', () => {
  const template = synth();
  const tags: Array<{ Key: string; Value: string }> =
    onlyRepository(template).Properties.Tags ?? [];
  const byKey = Object.fromEntries(tags.map((t) => [t.Key, t.Value]));

  assert.equal(byKey['capiro:component'], 'engagement-api');
  assert.equal(byKey['capiro:phase'], '2');
  assert.match(String(byKey['capiro:ui-contract']), /^[0-9a-f]{12}$/);
  assert.equal(byKey.Environment, 'dev');
});

test('the ui-contract tag tracks the configured contract, not a constant', () => {
  const cfg = base();
  const before = engagementApiTags(cfg)['capiro:ui-contract'];
  cfg.uiContract.capabilityManifestSha256 = 'a'.repeat(64);
  const after = engagementApiTags(cfg)['capiro:ui-contract'];
  assert.notEqual(before, after);
});

test('no tag carries user, target, client or campaign data', () => {
  const rendered = JSON.stringify(synth().toJSON());
  assert.doesNotMatch(rendered, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);

  assert.throws(
    () => assertNoSensitiveTagValues({ 'capiro:target': 'Priya Anand' }),
    /implies user or campaign data/,
  );
  assert.throws(
    () => assertNoSensitiveTagValues({ 'capiro:owner': 'priya.anand@mail.house.gov' }),
    /contact data/,
  );
  assert.throws(
    () => assertNoSensitiveTagValues({ 'capiro:component': '' }),
    /empty value/,
  );
});

test('the release-sha tag appears only when a release SHA is configured', () => {
  const withoutSha = base();
  delete withoutSha.releaseSha;
  assert.equal(engagementApiTags(withoutSha)['capiro:release-sha'], undefined);

  const withSha = base();
  withSha.releaseSha = 'a'.repeat(40);
  assert.equal(engagementApiTags(withSha)['capiro:release-sha'], 'a'.repeat(40));
});

// ────────────────────────────────────────────────────────── negative controls

test('NC-2.4-A a mutable tag setting is detectable in the synthesized template', () => {
  // The stack hardcodes IMMUTABLE, so the control proves the assertion would
  // catch a regression rather than passing regardless of the value.
  const template = synth();
  assert.throws(
    () => template.hasResourceProperties('AWS::ECR::Repository', { ImageTagMutability: 'MUTABLE' }),
    /ImageTagMutability/,
  );
  template.hasResourceProperties('AWS::ECR::Repository', { ImageTagMutability: 'IMMUTABLE' });
});

test('NC-2.4-B a Delete removal policy is detectable in the synthesized template', () => {
  const template = synth();
  assert.throws(
    () => template.hasResource('AWS::ECR::Repository', { DeletionPolicy: 'Delete' }),
    /DeletionPolicy/,
  );
  template.hasResource('AWS::ECR::Repository', { DeletionPolicy: 'Retain' });
});

test('NC-2.4-C a malformed KMS ARN fails at synthesis', () => {
  // Caught by CDK's own ARN parsing, not by the config contract — the stack
  // takes an already-validated config. The entrypoint in micro-session 2.6 is
  // what guarantees loadEngagementApiConfig runs first; this only proves a bad
  // ARN cannot silently synthesize into a template.
  const cfg = base();
  cfg.kmsKeyArns.ecr = 'not-an-arn';
  assert.throws(() => synth(cfg), /arn/i);
});
