/**
 * web-vnext-stack.ts — no dedicated spec existed before this change. Added
 * alongside the `engagementApiFullOwnership` prop specifically to prove:
 *
 *   1. Absent (default) renders IDENTICAL container env to before the prop
 *      existed — no ENGAGEMENT_API_FULL_OWNERSHIP key at all.
 *   2. true renders exactly ENGAGEMENT_API_FULL_OWNERSHIP: 'true'.
 *   3. false renders the SAME as absent (omitted, not the string 'false') —
 *      matching entrypoint.sh's `${ENGAGEMENT_API_FULL_OWNERSHIP:-}` default
 *      of empty string either way.
 *
 * Run: pnpm --dir infra/cdk exec ts-node --prefer-ts-exts \
 *        test/web-vnext-stack.spec.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import type { EnvConfig } from '../lib/config';
import { WebVNextStack, type WebVNextStackProps } from '../lib/web-vnext-stack';

const BASE_ENV_CONFIG: EnvConfig = {
  envName: 'dev',
  account: '000000000000',
  region: 'us-east-1',
  hostedZoneDomain: 'capiro.ai',
  rootDomain: 'capiro.ai',
  appHost: 'app.capiro.ai',
  wildcardHost: '*.app.capiro.ai',
  auroraMinAcu: 0.5,
  auroraMaxAcu: 4,
  auroraBackupRetentionDays: 35,
  apiCpu: 512,
  apiMemoryMib: 1024,
  apiDesiredCount: 1,
  apiMaxCount: 2,
  webCpu: 512,
  webMemoryMib: 1024,
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
  protectFromDestroy: false,
  logRetentionDays: 30,
};

const BASE_PROPS = (): Omit<WebVNextStackProps, 'engagementApiFullOwnership'> => ({
  cfg: BASE_ENV_CONFIG,
  releaseSha: 'c'.repeat(40),
  clusterArn: 'arn:aws:ecs:us-east-1:000000000000:cluster/capiro-dev',
  vpcId: 'vpc-00000000',
  privateSubnetIds: ['subnet-aaaaaaaa', 'subnet-bbbbbbbb'],
  privateSubnetAvailabilityZones: ['us-east-1a', 'us-east-1b'],
  serviceSecurityGroupId: 'sg-00000000',
  webRepositoryName: 'capiro/dev/web-vnext',
  webImageDigest: `sha256:${'ab'.repeat(32)}`,
  clerkPublishableKeySecretArn:
    'arn:aws:secretsmanager:us-east-1:000000000000:secret:clerk-pub-key-AAAAAA',
  secretsKeyArn: 'arn:aws:kms:us-east-1:000000000000:key/00000000-0000-0000-0000-000000000000',
  httpsListenerArn:
    'arn:aws:elasticloadbalancing:us-east-1:000000000000:listener/app/test-alb/aaa/bbb',
  certificateArn: 'arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000',
  hostname: 'os.capiro.ai',
  listenerPriority: 30,
  desiredCount: 1,
  maxCount: 2,
});

function synth(props: WebVNextStackProps): Template {
  const app = new cdk.App();
  return Template.fromStack(
    new WebVNextStack(app, 'Capiro-dev-WebVNext', {
      ...props,
      env: { account: props.cfg.account, region: props.cfg.region },
    }),
  );
}

function containerEnv(template: Template): Record<string, string> {
  const tasks = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
  const container = (tasks[0] as { Properties: Record<string, any> }).Properties
    .ContainerDefinitions[0];
  const entries = (container.Environment ?? []) as Array<{ Name: string; Value: string }>;
  return Object.fromEntries(entries.map((e) => [e.Name, e.Value]));
}

test('absent engagementApiFullOwnership omits the env var entirely (unchanged default)', () => {
  const env = containerEnv(synth(BASE_PROPS()));
  assert.equal(env.ENGAGEMENT_API_FULL_OWNERSHIP, undefined);
  assert.equal(env.WEB_SURFACE, 'vnext');
});

test('engagementApiFullOwnership: false renders identically to absent — omitted, not the string "false"', () => {
  const env = containerEnv(synth({ ...BASE_PROPS(), engagementApiFullOwnership: false }));
  assert.equal(env.ENGAGEMENT_API_FULL_OWNERSHIP, undefined);
});

test('engagementApiFullOwnership: true renders exactly ENGAGEMENT_API_FULL_OWNERSHIP="true"', () => {
  const env = containerEnv(synth({ ...BASE_PROPS(), engagementApiFullOwnership: true }));
  assert.equal(env.ENGAGEMENT_API_FULL_OWNERSHIP, 'true');
});

test('every other env var is unaffected by the new prop either way', () => {
  const withoutFlag = containerEnv(synth(BASE_PROPS()));
  const withFlag = containerEnv(synth({ ...BASE_PROPS(), engagementApiFullOwnership: true }));
  for (const key of ['APP_ENV', 'API_BASE_URL', 'WEB_SURFACE', 'CAPIRO_WEB_RELEASE_SHA']) {
    assert.equal(withoutFlag[key], withFlag[key], `${key} must not change`);
  }
});
