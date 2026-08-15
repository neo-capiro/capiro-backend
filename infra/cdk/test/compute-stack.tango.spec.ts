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
 * The FIRST CDK synth test in this package (see jest.config.cjs).
 *
 * Scoped to what P16 actually changed: MakeGov/Tango's optional secret and its
 * HTTPS-enforced base URL. This is not a full ComputeStack regression suite —
 * that would need to assert every existing task definition's every env var,
 * which is a much larger undertaking than one phase's config-and-secrets
 * wiring — but it proves the plan's own P16 acceptance criteria against a REAL
 * synthesized CloudFormation template, not a source-level guess:
 *
 *   "CDK synth tests prove the key is absent from serve/migrate containers and
 *    present only in sync when configured."
 *   "No secret value appears in synthesized templates or snapshots."
 *
 * A source-level regex check (grep the .ts file for 'TANGO_API_KEY') could not
 * catch a bug where some OTHER code path — a shared secrets spread, a stray
 * assignment — put the key on the serve task's Secrets array despite the
 * source appearing correct. Only the synthesized template's actual
 * ContainerDefinitions[].Secrets settles that question.
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

describe('MakeGov/Tango secret wiring (P16)', () => {
  test('with NO tangoApiKey ARN configured, TANGO_API_KEY appears on NO task definition', () => {
    const template = synthComputeStack(baseConfig());
    const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
    for (const [logicalId, resource] of Object.entries(taskDefs)) {
      const containers = (resource as any).Properties?.ContainerDefinitions ?? [];
      for (const container of containers) {
        const secretNames = (container.Secrets ?? []).map((s: { Name: string }) => s.Name);
        expect(secretNames).not.toContain('TANGO_API_KEY');
      }
      void logicalId;
    }
  });

  test('with the ARN configured, TANGO_API_KEY appears on the SYNC task and NO other', () => {
    const template = synthComputeStack(
      baseConfig({
        tangoApiKey: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:tango-AAAAAA',
      }),
    );
    const taskDefs = template.findResources('AWS::ECS::TaskDefinition');

    const familiesWithTango: string[] = [];
    for (const resource of Object.values(taskDefs) as any[]) {
      const family = resource.Properties?.Family as string | undefined;
      const containers = resource.Properties?.ContainerDefinitions ?? [];
      for (const container of containers) {
        const secretNames = (container.Secrets ?? []).map((s: { Name: string }) => s.Name);
        if (secretNames.includes('TANGO_API_KEY')) familiesWithTango.push(family ?? '(unnamed)');
      }
    }

    expect(familiesWithTango).toHaveLength(1);
    expect(familiesWithTango[0]).toMatch(/sync-jobs/);
  });

  test('the sync task Secret reference points at the "tango" secret name, not a capiro/dev/ path', () => {
    // This secret's real name IS "tango" — confirmed provenance, not a
    // convention slip. A test asserting the wrong name would pass today and
    // silently mask a real wiring bug the moment someone "fixes" the name to
    // match the other capiro/dev/* entries.
    const template = synthComputeStack(
      baseConfig({
        tangoApiKey: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:tango-AAAAAA',
      }),
    );
    // CDK's own `Match` helpers, not jest's `expect.*` asymmetric matchers —
    // `Template.hasResourceProperties` runs its own structural comparison and
    // does not understand jest's matcher objects.
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: Match.stringLikeRegexp('sync-jobs'),
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Secrets: Match.arrayWith([
            Match.objectLike({
              Name: 'TANGO_API_KEY',
              ValueFrom: Match.stringLikeRegexp('secret:tango-'),
            }),
          ]),
        }),
      ]),
    });
  });

  test('no secret VALUE — only an ARN reference — ever appears in the synthesized template', () => {
    // The whole point of ecs.Secret.fromSecretsManager: the template names
    // WHERE to fetch the value at container start, never the value itself.
    const template = synthComputeStack(
      baseConfig({
        tangoApiKey: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:tango-AAAAAA',
      }),
    );
    const json = JSON.stringify(template.toJSON());
    // A real key would never look like this ARN reference shape; asserting the
    // ARN appears only inside a Secrets ValueFrom (never as a bare Environment
    // value) is the structural proof.
    const envValues = Object.values(template.findResources('AWS::ECS::TaskDefinition'))
      .flatMap((r: any) => r.Properties?.ContainerDefinitions ?? [])
      .flatMap((c: any) => c.Environment ?? [])
      .map((e: any) => e.Value);
    expect(envValues.every((v) => typeof v !== 'string' || !v.includes('tango-AAAAAA'))).toBe(true);
    expect(json).toContain('secret:tango-AAAAAA');
  });
});

describe('MakeGov/Tango WEBHOOK secret wiring (P46)', () => {
  const WEBHOOK_ARN =
    'arn:aws:secretsmanager:us-east-1:123456789012:secret:capiro/dev/tango-webhook-secret-BBBBBB';

  /** Families carrying a given secret name, read off the synthesized template. */
  function familiesWithSecret(template: Template, secretName: string): string[] {
    const found: string[] = [];
    for (const resource of Object.values(
      template.findResources('AWS::ECS::TaskDefinition'),
    ) as any[]) {
      const family = resource.Properties?.Family as string | undefined;
      for (const container of resource.Properties?.ContainerDefinitions ?? []) {
        const secretNames = (container.Secrets ?? []).map((s: { Name: string }) => s.Name);
        if (secretNames.includes(secretName)) found.push(family ?? '(unnamed)');
      }
    }
    return found;
  }

  test('with NO ARN configured, the webhook secret appears on NO task definition', () => {
    // This is what "deploy the receiver dark" means at the infrastructure
    // layer: nothing is wired, so the running API cannot verify anything and
    // rejects every delivery.
    const template = synthComputeStack(baseConfig());
    expect(familiesWithSecret(template, 'TANGO_WEBHOOK_SIGNING_SECRET')).toHaveLength(0);
  });

  test('with the ARN configured, it appears on exactly ONE task definition', () => {
    const template = synthComputeStack(baseConfig({ tangoWebhookSecret: WEBHOOK_ARN }));
    expect(familiesWithSecret(template, 'TANGO_WEBHOOK_SIGNING_SECRET')).toHaveLength(1);
  });

  test('that one task is SERVE — never the sync or migrate task', () => {
    const template = synthComputeStack(baseConfig({ tangoWebhookSecret: WEBHOOK_ARN }));
    const [family] = familiesWithSecret(template, 'TANGO_WEBHOOK_SIGNING_SECRET');

    expect(family).toBeDefined();
    expect(family).not.toMatch(/sync-jobs/);
    expect(family).not.toMatch(/migrate/);

    // Pinned POSITIVELY rather than by guessing the family string: RECALL_API_KEY
    // is already a serve-only secret, so the task carrying both is the serve
    // task by construction. If serve is ever renamed this still holds.
    expect(familiesWithSecret(template, 'RECALL_API_KEY')).toContain(family);
  });

  test('the two Tango credentials are NEVER on the same task — outbound vs inbound', () => {
    // The whole reason these are separate ARNs. TANGO_API_KEY is outbound
    // (Capiro calling MakeGov, sync task only); the webhook secret is inbound
    // (MakeGov calling Capiro, serve task only). A task holding both would be
    // holding one credential it has no use for, which is pure blast radius.
    const template = synthComputeStack(
      baseConfig({
        tangoApiKey: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:tango-AAAAAA',
        tangoWebhookSecret: WEBHOOK_ARN,
      }),
    );

    const apiKeyFamilies = familiesWithSecret(template, 'TANGO_API_KEY');
    const webhookFamilies = familiesWithSecret(template, 'TANGO_WEBHOOK_SIGNING_SECRET');

    expect(apiKeyFamilies).toHaveLength(1);
    expect(webhookFamilies).toHaveLength(1);
    expect(apiKeyFamilies[0]).not.toEqual(webhookFamilies[0]);
    // And each is where it belongs.
    expect(apiKeyFamilies[0]).toMatch(/sync-jobs/);
    expect(webhookFamilies[0]).not.toMatch(/sync-jobs/);
  });

  test('the reference points at the tango-webhook-secret name', () => {
    const template = synthComputeStack(baseConfig({ tangoWebhookSecret: WEBHOOK_ARN }));
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Secrets: Match.arrayWith([
            Match.objectLike({
              Name: 'TANGO_WEBHOOK_SIGNING_SECRET',
              ValueFrom: Match.stringLikeRegexp('tango-webhook-secret-'),
            }),
          ]),
        }),
      ]),
    });
  });

  test('no secret VALUE appears as a plain Environment entry', () => {
    const template = synthComputeStack(baseConfig({ tangoWebhookSecret: WEBHOOK_ARN }));
    const envValues = Object.values(template.findResources('AWS::ECS::TaskDefinition'))
      .flatMap((r: any) => r.Properties?.ContainerDefinitions ?? [])
      .flatMap((c: any) => c.Environment ?? [])
      .map((e: any) => e.Value);
    expect(
      envValues.every((v) => typeof v !== 'string' || !v.includes('tango-webhook-secret-BBBBBB')),
    ).toBe(true);
    // Present, but only as a Secrets ValueFrom reference.
    expect(JSON.stringify(template.toJSON())).toContain('tango-webhook-secret-BBBBBB');
  });
});

describe('every other optional-secret task placement still holds (regression net)', () => {
  test('LEGISTORM_API_KEY and CENSUS_API_KEY still land ONLY on the sync task', () => {
    // Not new in P16, but proves the test harness itself is trustworthy: if it
    // could not reproduce a KNOWN, already-shipped placement rule, it would not
    // be believable for the NEW one either.
    const template = synthComputeStack(baseConfig());
    const taskDefs = Object.values(template.findResources('AWS::ECS::TaskDefinition')) as any[];
    for (const resource of taskDefs) {
      const family = resource.Properties?.Family as string;
      const containers = resource.Properties?.ContainerDefinitions ?? [];
      for (const container of containers) {
        const secretNames = (container.Secrets ?? []).map((s: { Name: string }) => s.Name);
        if (secretNames.includes('LEGISTORM_API_KEY') || secretNames.includes('CENSUS_API_KEY')) {
          expect(family).toMatch(/sync-jobs/);
        }
      }
    }
  });
});
