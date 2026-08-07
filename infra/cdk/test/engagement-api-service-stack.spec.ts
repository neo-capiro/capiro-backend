/**
 * engagement-api Fargate service stack — dark shadow posture.
 *
 * Run: pnpm --dir infra/cdk exec ts-node --prefer-ts-exts test/engagement-api-service-stack.spec.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';

import { type EngagementApiInfraConfig } from '../lib/engagement-api/engagement-api-config';
import {
  EngagementApiServiceStack,
  FORBIDDEN_TASK_ENV_PATTERNS,
  engagementApiTaskEnvironment,
} from '../lib/engagement-api/engagement-api-service-stack';

const CDK_ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(CDK_ROOT, 'fixtures/engagement-api.test.json');
const TARGET_GROUP_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/capiro-dev-engagement-api/3333333333333333';

const base = (): EngagementApiInfraConfig => {
  const cfg = JSON.parse(readFileSync(FIXTURE, 'utf8')) as EngagementApiInfraConfig;
  cfg.imageDigest = `sha256:${'ab'.repeat(32)}`;
  cfg.releaseSha = 'c'.repeat(40);
  return cfg;
};

function buildRaw(cfg: EngagementApiInfraConfig = base()) {
  const app = new cdk.App();
  return new EngagementApiServiceStack(app, 'Capiro-dev-EngagementApiService', {
    cfg,
    env: { account: cfg.accountId, region: cfg.region },
    targetGroupArn: TARGET_GROUP_ARN,
  });
}

const synth = (cfg?: EngagementApiInfraConfig) => Template.fromStack(buildRaw(cfg));

function theTaskDefinition(template: Template): Record<string, any> {
  const found = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
  assert.equal(found.length, 1, 'expected exactly one task definition');
  const task = found[0];
  assert.ok(task);
  return (task as { Properties: Record<string, any> }).Properties;
}

function theContainer(template: Template): Record<string, any> {
  const containers = theTaskDefinition(template).ContainerDefinitions as Array<Record<string, any>>;
  assert.equal(containers.length, 1, 'expected exactly one container');
  const container = containers[0];
  assert.ok(container);
  return container;
}

function envOf(template: Template): Record<string, string> {
  const entries = (theContainer(template).Environment ?? []) as Array<{
    Name: string;
    Value: string;
  }>;
  return Object.fromEntries(entries.map((e) => [e.Name, e.Value]));
}

test('the shadow runtime posture is exact', () => {
  const env = envOf(synth());
  assert.equal(env.CAPIRO_SERVICE_NAME, 'engagement-api');
  assert.equal(env.ENGAGEMENT_PROCESS_MODE, 'shadow');
  assert.equal(env.ENGAGEMENT_BACKGROUND_OWNER, 'disabled');
  assert.equal(env.ENGAGEMENT_EXTERNAL_ACTIONS, 'disabled');
  assert.equal(env.ENGAGEMENT_CALLBACKS_ENABLED, 'false');
  assert.equal(env.ENGAGEMENT_RECALL_WEBHOOK_ENABLED, 'false');
});

test('CLERK_JWT_ISSUER is present and matches the configured value', () => {
  const cfg = base();
  cfg.clerkJwtIssuer = 'https://clerk.app.capiro.ai';
  const env = envOf(synth(cfg));
  assert.equal(env.CLERK_JWT_ISSUER, 'https://clerk.app.capiro.ai');
});

test('the shadow posture is literal and cannot be armed through config', () => {
  const cfg = base();
  Object.assign(cfg as unknown as Record<string, unknown>, {
    processMode: 'active',
    externalActions: 'enabled',
    backgroundOwner: 'engagement-api',
  });
  const env = engagementApiTaskEnvironment(cfg);
  assert.equal(env.ENGAGEMENT_PROCESS_MODE, 'shadow');
  assert.equal(env.ENGAGEMENT_EXTERNAL_ACTIONS, 'disabled');
  assert.equal(env.ENGAGEMENT_BACKGROUND_OWNER, 'disabled');
});

test('the port and bind host match the container contract', () => {
  const env = envOf(synth());
  assert.equal(env.ENGAGEMENT_API_PORT, '4500');
  assert.equal(env.ENGAGEMENT_API_BIND_HOST, '0.0.0.0');
  const [mapping] = theContainer(synth()).PortMappings as Array<Record<string, unknown>>;
  assert.deepEqual(mapping, { ContainerPort: 4500, Protocol: 'tcp' });
});

test('release provenance is present and nonsecret', () => {
  const cfg = base();
  const env = envOf(synth(cfg));
  assert.equal(env.RELEASE_SHA, cfg.releaseSha);
  assert.equal(env.OUTREACH_V3_PROTOTYPE_SHA256, cfg.uiContract.prototypeSha256);
  assert.match(String(env.OUTREACH_V3_UI_CONTRACT_SHA256), /^[0-9a-f]{64}$/);
});

test('no environment variable claims Outreach V3 is available', () => {
  const env = envOf(synth());
  for (const name of Object.keys(env)) {
    for (const pattern of FORBIDDEN_TASK_ENV_PATTERNS) {
      assert.ok(!pattern.test(name), `forbidden task environment variable ${name}`);
    }
  }
  assert.equal(env.OUTREACH_V3_ENABLED, undefined);
});

test('no plaintext secret appears in the environment', () => {
  const env = envOf(synth());
  for (const [name, value] of Object.entries(env)) {
    assert.ok(
      !/SECRET|PASSWORD|PRIVATE_KEY|API_KEY|TOKEN/i.test(name),
      `secret-shaped variable in plaintext environment: ${name}`,
    );
    assert.ok(!/^(sk|pk)_(live|test)_/.test(value), `secret-shaped value for ${name}`);
  }
});

test('the task runs Linux ARM64 at the contracted size', () => {
  synth().hasResourceProperties('AWS::ECS::TaskDefinition', {
    Cpu: '512',
    Memory: '1024',
    RequiresCompatibilities: ['FARGATE'],
    RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
    Family: 'capiro-dev-engagement-api',
  });
});

test('NC-2.6-C x86 would be visible in the template', () => {
  const template = synth();
  assert.throws(
    () =>
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        RuntimePlatform: { CpuArchitecture: 'X86_64' },
      }),
    /CpuArchitecture/,
  );
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    RuntimePlatform: { CpuArchitecture: 'ARM64' },
  });
});

test('the image is pinned by digest, never by tag', () => {
  const image = theContainer(synth()).Image;
  const rendered = JSON.stringify(image);
  assert.match(rendered, /@sha256:/, `image is not digest-pinned: ${rendered}`);
  assert.doesNotMatch(rendered, /:latest/);
});

test('NC-2.6-D a missing digest refuses to synthesize', () => {
  const cfg = base();
  delete cfg.imageDigest;
  assert.throws(() => buildRaw(cfg), /imageDigest is required/);

  const noSha = base();
  delete noSha.releaseSha;
  assert.throws(() => buildRaw(noSha), /releaseSha is required/);
});

test('the root filesystem is read-only with writable temp mounts', () => {
  const container = theContainer(synth());
  assert.equal(container.ReadonlyRootFilesystem, true);
  const mounts = (container.MountPoints ?? []) as Array<Record<string, unknown>>;
  const paths = mounts.map((m) => m.ContainerPath).sort();
  assert.deepEqual(paths, ['/app/tmp', '/tmp']);
  for (const mount of mounts) assert.equal(mount.ReadOnly, false);
  const volumes = (theTaskDefinition(synth()).Volumes ?? []) as Array<{ Name: string }>;
  assert.deepEqual(volumes.map((v) => v.Name).sort(), ['AppTmp', 'Tmp']);
});

test('the container health check asserts service identity', () => {
  const health = theContainer(synth()).HealthCheck as { Command: string[] };
  assert.equal(health.Command[0], 'CMD-SHELL');
  assert.match(String(health.Command[1]), /127\.0\.0\.1:4500\/health/);
  assert.match(String(health.Command[1]), /"service":"engagement-api"/);
});

test('no migration or operational command overrides the serve-only entrypoint', () => {
  const container = theContainer(synth());
  assert.equal(container.Command, undefined, 'the task must not override CMD');
  assert.equal(container.EntryPoint, undefined, 'the task must not override the entrypoint');
  assert.doesNotMatch(JSON.stringify(container), /migrate|seed|prisma/i);
});

test('the container is not privileged and adds no Linux capabilities', () => {
  const container = theContainer(synth());
  assert.notEqual(container.Privileged, true);
  assert.equal(container.LinuxParameters, undefined);
});

test('the service is private with no public IP and no ECS Exec', () => {
  synth().hasResourceProperties('AWS::ECS::Service', {
    ServiceName: 'capiro-dev-engagement-api',
    DesiredCount: 1,
    EnableExecuteCommand: false,
    NetworkConfiguration: {
      AwsvpcConfiguration: {
        AssignPublicIp: 'DISABLED',
        Subnets: base().privateSubnetIds,
      },
    },
  });
});

test('NC-2.6-B enabling ECS Exec would be visible in the template', () => {
  const template = synth();
  assert.throws(
    () => template.hasResourceProperties('AWS::ECS::Service', { EnableExecuteCommand: true }),
    /EnableExecuteCommand/,
  );
});

test('the deployment circuit breaker rolls back', () => {
  synth().hasResourceProperties('AWS::ECS::Service', {
    DeploymentConfiguration: {
      DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      MinimumHealthyPercent: 100,
      MaximumPercent: 200,
    },
    HealthCheckGracePeriodSeconds: 120,
  });
});

test('the service attaches to the imported target group', () => {
  synth().hasResourceProperties('AWS::ECS::Service', {
    LoadBalancers: [
      Match.objectLike({
        ContainerName: 'engagement-api',
        ContainerPort: 4500,
        TargetGroupArn: TARGET_GROUP_ARN,
      }),
    ],
  });
});

test('autoscaling stays between one and two tasks', () => {
  const template = synth();
  template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
    MinCapacity: 1,
    MaxCapacity: 2,
  });
  template.resourceCountIs('AWS::ApplicationAutoScaling::ScalingPolicy', 2);
});

test('the log group is KMS encrypted by a stack-owned key and retained', () => {
  synth().hasResource('AWS::Logs::LogGroup', {
    Properties: Match.objectLike({
      LogGroupName: '/capiro/dev/engagement-api',
      KmsKeyId: Match.objectLike({
        'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('^LogsKey'), 'Arn']),
      }),
    }),
    DeletionPolicy: 'Retain',
  });
});

test('the logs key policy grants CloudWatch Logs access scoped to this log group only', () => {
  synth().hasResourceProperties('AWS::KMS::Key', {
    KeyPolicy: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Effect: 'Allow',
          Principal: { Service: 'logs.us-east-1.amazonaws.com' },
          Condition: {
            ArnLike: {
              'kms:EncryptionContext:aws:logs:arn':
                'arn:aws:logs:us-east-1:000000000000:log-group:/capiro/dev/engagement-api',
            },
          },
        }),
      ]),
    }),
  });
});

test('the service stack creates no routing, network, registry or data resource', () => {
  const template = synth();
  for (const type of [
    'AWS::ElasticLoadBalancingV2::ListenerRule',
    'AWS::ElasticLoadBalancingV2::Listener',
    'AWS::ElasticLoadBalancingV2::LoadBalancer',
    'AWS::ElasticLoadBalancingV2::TargetGroup',
    'AWS::EC2::VPC',
    'AWS::EC2::Subnet',
    'AWS::EC2::SecurityGroup',
    'AWS::EC2::SecurityGroupIngress',
    'AWS::ECS::Cluster',
    'AWS::ECR::Repository',
    'AWS::RDS::DBCluster',
    'AWS::Route53::RecordSet',
    'AWS::SecretsManager::Secret',
  ]) {
    template.resourceCountIs(type, 0);
  }
  template.resourceCountIs('AWS::KMS::Key', 1);
});

test('the stack references no historical Compute stack export', () => {
  assert.doesNotMatch(JSON.stringify(synth().toJSON()), /Capiro-[a-z]+-Compute/);
});

test('secrets come from the least-privilege helper, field by field', () => {
  const secrets = (theContainer(synth()).Secrets ?? []) as Array<{ Name: string }>;
  const names = secrets.map((s) => s.Name).sort();
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

test('DB_NAME is a literal environment variable, not a secret', () => {
  const cfg = base();
  cfg.databaseName = 'capiro';
  const env = envOf(synth(cfg));
  assert.equal(env.DB_NAME, 'capiro');
  const secrets = (theContainer(synth(cfg)).Secrets ?? []) as Array<{ Name: string }>;
  assert.ok(!secrets.some((s) => s.Name === 'DB_NAME'));
});

test('NC-2.6-A an armed external-action value never reaches the template', () => {
  const cfg = base();
  (cfg as unknown as Record<string, unknown>).ENGAGEMENT_EXTERNAL_ACTIONS = 'enabled';
  const env = envOf(synth(cfg));
  assert.equal(env.ENGAGEMENT_EXTERNAL_ACTIONS, 'disabled');
  const rendered = JSON.stringify(synth(cfg).toJSON());
  assert.doesNotMatch(rendered, /"ENGAGEMENT_EXTERNAL_ACTIONS"[^}]*"enabled"/);
});

test('NC-2.6-B a V3 enable flag would be caught by the forbidden pattern list', () => {
  for (const name of ['OUTREACH_V3_ENABLED', 'VITE_API_URL', 'LANGGRAPH_URL', 'CAMPAIGN_SPEC_TABLE']) {
    assert.ok(
      FORBIDDEN_TASK_ENV_PATTERNS.some((pattern) => pattern.test(name)),
      `${name} should be forbidden`,
    );
  }
  for (const name of ['OUTREACH_V3_PROTOTYPE_SHA256', 'OUTREACH_V3_UI_CONTRACT_SHA256']) {
    assert.ok(!FORBIDDEN_TASK_ENV_PATTERNS.some((pattern) => pattern.test(name)));
  }
});
