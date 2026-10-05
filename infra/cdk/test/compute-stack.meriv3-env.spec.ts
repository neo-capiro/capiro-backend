import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { ComputeStack } from '../lib/compute-stack';
import { SecretsStack } from '../lib/secrets-stack';
import { AssetsStack } from '../lib/assets-stack';
import type { EnvConfig } from '../lib/config';

/**
 * Program plan 2026-10-05 Stage 1 §4.2: MeriV3 is the only chat runtime, and its
 * global kill switch MERIV3_ENABLED must be present on BOTH the api and the
 * meriv2-orchestrator task definitions so a future deploy keeps it explicit.
 * MERIV3_CANARY_TENANT_SLUGS is no longer read and must not be codified.
 * The env needed by the V3 client and the narrow assistants stays.
 */

function baseConfig(overrides: Partial<EnvConfig['externalSecretArns']> = {}): EnvConfig {
  return {
    envName: 'dev',
    account: '123456789012',
    region: 'us-east-1',
    hostedZoneDomain: 'capiro.ai',
    rootDomain: 'capiro.ai',
    appHost: 'app.capiro.ai',
    wildcardHost: '*.app.capiro.ai',
    clerkJwtIssuer: 'https://clerk.example.test',
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
    protectFromDestroy: false,
    logRetentionDays: 14,
    externalSecretArns: {
      microsoftClientId:
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:test/ms-client-id-AAAAAA',
      microsoftTenantId:
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:test/ms-tenant-id-AAAAAA',
      microsoftCertThumbprint:
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:test/ms-thumb-AAAAAA',
      microsoftCertPrivateKey:
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:test/ms-key-AAAAAA',
      oauthTokenEncryptionKey:
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:test/oauth-token-key-AAAAAA',
      oauthStateSecret:
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:test/oauth-state-AAAAAA',
      openaiApiKey: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test/openai-AAAAAA',
      anthropicApiKey: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test/anthropic-AAAAAA',
      notesEncryptionKey:
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:test/notes-key-AAAAAA',
      ...overrides,
    },
  };
}

/** Synthesizes ComputeStack with minimal, synth-only stand-ins for every dependency. */
function synthComputeStack(cfg: EnvConfig): Template {
  const app = new cdk.App();

  // Real, tiny, unprovisioned resources — CDK synth never calls AWS, so a real
  // ec2.Vpc/SecurityGroup here costs nothing and needs no context lookup (unlike
  // ec2.Vpc.fromLookup, which DOES require AWS API access and would make this
  // test flaky/impossible in CI).
  const vpcStack = new cdk.Stack(app, 'VpcStack', {
    env: { account: cfg.account, region: cfg.region },
  });
  // ComputeStack's services run in PRIVATE_WITH_EGRESS subnets, which a plain
  // `new ec2.Vpc()` does not create unless a NAT gateway is requested — with
  // natGateways: 0 the default subnet configuration falls back to
  // public-only/isolated. One NAT gateway is the minimum that actually
  // produces a private-with-egress subnet group in the synthesized template;
  // it costs nothing in a synth-only test (no AWS call is ever made).
  const vpc = new ec2.Vpc(vpcStack, 'Vpc', { natGateways: 1, maxAzs: 2 });
  const albSecurityGroup = new ec2.SecurityGroup(vpcStack, 'AlbSg', { vpc });
  const serviceSecurityGroup = new ec2.SecurityGroup(vpcStack, 'ServiceSg', { vpc });

  const secretsStack = new SecretsStack(app, 'SecretsStack', {
    cfg,
    env: { account: cfg.account, region: cfg.region },
  });
  const assetsStack = new AssetsStack(app, 'AssetsStack', {
    cfg,
    env: { account: cfg.account, region: cfg.region },
  });

  const dbCluster = rds.DatabaseCluster.fromDatabaseClusterAttributes(vpcStack, 'DbCluster', {
    clusterIdentifier: 'test-cluster',
    clusterEndpointAddress: 'test-cluster.cluster-xxxx.us-east-1.rds.amazonaws.com',
    readerEndpointAddress: 'test-cluster.cluster-ro-xxxx.us-east-1.rds.amazonaws.com',
    port: 5432,
    securityGroups: [serviceSecurityGroup],
  });

  const certificate = acm.Certificate.fromCertificateArn(
    vpcStack,
    'Cert',
    'arn:aws:acm:us-east-1:123456789012:certificate/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  );
  const apexCertificate = acm.Certificate.fromCertificateArn(
    vpcStack,
    'ApexCert',
    'arn:aws:acm:us-east-1:123456789012:certificate/ffffffff-1111-2222-3333-444444444444',
  );
  const hostedZone = route53.HostedZone.fromHostedZoneAttributes(vpcStack, 'Zone', {
    hostedZoneId: 'Z0000000000000000000',
    zoneName: cfg.hostedZoneDomain,
  });

  const stack = new ComputeStack(app, 'ComputeStack', {
    env: { account: cfg.account, region: cfg.region },
    cfg,
    vpc,
    albSecurityGroup,
    serviceSecurityGroup,
    dbCluster,
    dbSecret: secretsStack.clerkSecretKey, // stand-in ISecret; only .secretArn/grantRead are used pre-synth
    appDbSecret: secretsStack.clerkWebhookSigningSecret,
    promoterDbSecret: secretsStack.clerkPublishableKey, // stand-in ISecret, same reasoning
    analyticsDbSecret: secretsStack.clioApiServerKey, // stand-in ISecret, same reasoning
    readerEndpoint: dbCluster.clusterReadEndpoint.hostname,
    databaseName: 'capiro_test',
    dataKey: secretsStack.secretsKey,
    secretsStack,
    certificate,
    apexCertificate,
    hostedZone,
    assetsStack,
  });

  return Template.fromStack(stack);
}

function envOf(template: Template, family: string): Record<string, string> {
  const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
  for (const resource of Object.values(taskDefs) as any[]) {
    if (resource.Properties?.Family !== family) continue;
    const container = (resource.Properties?.ContainerDefinitions ?? [])[0];
    return Object.fromEntries(
      (container?.Environment ?? []).map((entry: { Name: string; Value: string }) => [
        entry.Name,
        entry.Value,
      ]),
    );
  }
  throw new Error(`task definition family ${family} not found`);
}

describe('MeriV3 runtime env (Stage 1 §4.2)', () => {
  const template = synthComputeStack(baseConfig());
  const api = envOf(template, 'capiro-dev-api');
  const orchestrator = envOf(template, 'capiro-dev-meriv2-orchestrator');

  test('both services carry the explicit global kill switch', () => {
    expect(api.MERIV3_ENABLED).toBe('true');
    expect(orchestrator.MERIV3_ENABLED).toBe('true');
  });

  test('the retired slug allow-list is not codified on either service', () => {
    expect(api).not.toHaveProperty('MERIV3_CANARY_TENANT_SLUGS');
    expect(orchestrator).not.toHaveProperty('MERIV3_CANARY_TENANT_SLUGS');
  });

  test('the env the V3 client and the narrow assistants read stays', () => {
    expect(api.MERIV2_ORCHESTRATOR_URL).toBe('https://app.capiro.ai');
    expect(api.MERIV2_ENABLED).toBe('true');
    expect(api.MERIV2_ACTION_PROPOSALS_ENABLED).toBe('true');
    expect(orchestrator.MERIV3_MODEL).toBe('gpt-6-astra');
    expect(orchestrator.MERIV3_STANDARD_REASONING_EFFORT).toBe('medium');
    expect(orchestrator.MERIV2_API_BASE_URL).toBe('https://app.capiro.ai');
  });
});
