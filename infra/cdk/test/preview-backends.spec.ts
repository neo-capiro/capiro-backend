import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Template } from 'aws-cdk-lib/assertions';
import { previewBackendApplication } from '../lib/preview/application';
import { previewBindings } from '../lib/preview/bindings';
import { previewConfig } from '../lib/config';
import { main } from '../bin/preview-backends';

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../fixtures/preview-backends.synthetic.json'), 'utf8'),
);
const output = path.join(os.tmpdir(), `capiro-preview-backends-synthetic-synth-${process.pid}`);
assert.equal(fs.existsSync(output), false);
after(() => {
  if (fs.existsSync(output)) {
    assert.equal(fs.lstatSync(output).isSymbolicLink(), false);
    fs.rmSync(output, { recursive: true });
  }
});
const clone = () => structuredClone(fixture);

test('preview refuses production/default/extra resource configuration before allocation', () => {
  for (const edit of [
    (x: any) => {
      delete x.clerkIssuer;
    },
    (x: any) => {
      x.vpcId += '\n';
    },
    (x: any) => {
      x.clerkIssuer = 'https://clerk.app.capiro.ai';
    },
    (x: any) => {
      x.clerkSecretArn = x.clerkSecretArn.replace('/preview/', '/dev/');
    },
    (x: any) => {
      x.clerkSecretArn = x.clerkSecretArn.replace('secretsmanager:', 'ssm:');
    },
    (x: any) => {
      x.clusterArn = x.clusterArn.replace('capiro-portfolio-preview', 'capiro-dev');
    },
    (x: any) => {
      x.listenerArn = x.listenerArn.replace('capiro-portfolio-preview', 'capiro-prod-alb');
    },
    (x: any) => {
      x.clusterArn = x.clusterArn.replace('967807252336', '000000000000');
    },
    (x: any) => {
      x.vpcCidr = '10.40.0.0/16';
    },
    (x: any) => {
      x.publicSubnetIds[1] = x.publicSubnetIds[0];
    },
    (x: any) => {
      x.availabilityZones[1] = x.availabilityZones[0];
    },
    (x: any) => {
      x.images.core.uri = x.images.core.uri.replace(/@sha256:.*/, ':latest');
    },
    (x: any) => {
      x.images.core.sourceHead = '4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace';
    },
    (x: any) => {
      x.images.workspace.uri = x.images.core.uri;
    },
    (x: any) => {
      x.databaseUrl = 'postgresql://production.invalid/capiro';
    },
    (x: any) => {
      x.coreApiBaseUrl = 'https://os.capiro.ai/api';
    },
    (x: any) => {
      x.MERIV2_ORCHESTRATOR_URL = 'https://os.capiro.ai/meri-api';
    },
    (x: any) => {
      x.automationTenantId = x.neoTenantId;
    },
    (x: any) => {
      x.automationActorId = x.neoActorId;
    },
    (x: any) => {
      x.secretValue = 'forbidden';
    },
  ]) {
    const input = clone();
    edit(input);
    assert.throws(() => previewBindings(input));
  }
  assert.equal(fs.existsSync(output), false);
  assert.throws(() => previewConfig('https://clerk.app.capiro.ai'));
});

test('held service templates use new DB/asset owners, preserve proxy routing and add no Meri worker', () => {
  assert.equal(fs.existsSync(output), false);
  const result = previewBackendApplication(fixture, output);
  const services = Template.fromStack(result.services).toJSON();
  const data = Template.fromStack(result.data).toJSON();
  const assets = Template.fromStack(result.assets).toJSON();
  const network = Template.fromStack(result.network).toJSON();
  const resources = Object.values(services.Resources) as any[];
  const tasks = resources.filter((r) => r.Type === 'AWS::ECS::TaskDefinition');
  assert.equal(tasks.length, 3);
  const coreTask = tasks.find((r) => r.Properties.ContainerDefinitions[0].Name === 'core');
  assert.equal(coreTask.Properties.RuntimePlatform.CpuArchitecture, 'ARM64');
  const coreTarget = resources.find(
    (r) => r.Type === 'AWS::ElasticLoadBalancingV2::TargetGroup' && r.Properties.Port === 4000,
  );
  assert.equal(coreTarget?.Properties.HealthCheckPath, '/health');
  for (const task of tasks) {
    const container = task.Properties.ContainerDefinitions[0];
    assert.deepEqual(container.Command, ['serve']);
    const env = Object.fromEntries(container.Environment.map((r: any) => [r.Name, r.Value]));
    assert.equal(env.WEB_ORIGIN, 'https://portfolio-preview.app.capiro.ai');
    assert.equal(env.DATABASE_URL, '');
    assert.equal(env.CLERK_JWT_ISSUER, fixture.clerkIssuer);
    assert.notEqual(typeof env.DB_HOST, 'string');
    assert.notEqual(typeof env.ASSETS_BUCKET, 'string');
    assert.deepEqual(env.DIRECTORY_S3_BUCKET, env.ASSETS_BUCKET);
    assert.equal(env.DB_PORT, '5432');
    assert.equal(env.DB_NAME, 'capiro');
    assert.deepEqual(container.Secrets.map((r: any) => r.Name).sort(), [
      'CLERK_SECRET_KEY',
      ...(container.Name === 'core' ? ['CLERK_WEBHOOK_SIGNING_SECRET'] : []),
      'DB_PASSWORD',
      'DB_USER',
    ]);
  }
  for (const service of resources.filter((r) => r.Type === 'AWS::ECS::Service'))
    assert.equal(service.Properties.DesiredCount, 0);
  const rules = resources.filter(
    (r: any) => r.Type === 'AWS::ElasticLoadBalancingV2::ListenerRule',
  );
  assert.equal(rules.length, 7);
  assert.deepEqual(
    rules.map((r: any) => r.Properties.Priority).sort(),
    [608, 609, 610, 611, 612, 613, 614],
  );
  for (const rule of rules) {
    const counts = rule.Properties.Conditions.map((c: any) =>
      Object.values(c).find((v: any) => v && typeof v === 'object' && 'Values' in v),
    ).map((v: any) => v.Values.length);
    assert.ok(counts.every((n: number) => n <= 3));
    assert.ok(counts.reduce((a: number, b: number) => a + b, 0) <= 5);
  }
  const proxies = rules.filter((r: any) => [610, 611].includes(r.Properties.Priority));
  assert.deepEqual(
    proxies.flatMap((r: any) => r.Properties.Conditions[1].PathPatternConfig.Values).sort(),
    [
      '/api/capiro/*',
      '/api/backend/*',
      '/api/action-followthrough/*',
      '/api/documents/*',
      '/api/conversations/*',
    ].sort(),
  );
  for (const proxy of proxies)
    assert.deepEqual(proxy.Properties.Actions[0].TargetGroupArn, fixture.frontendTargetGroupArn);
  for (const held of rules.filter((r: any) => [608, 609].includes(r.Properties.Priority)))
    assert.equal(held.Properties.Actions[0].FixedResponseConfig.StatusCode, '503');
  assert.equal(
    resources.filter((r) => r.Type === 'AWS::ElasticLoadBalancingV2::ListenerCertificate').length,
    0,
  );
  for (const doc of [services, data, assets, network]) {
    const raw = JSON.stringify(doc);
    assert.equal(
      /os[.]capiro[.]ai|clerk[.]app[.]capiro[.]ai|updated-directory|MERIV2_ORCHESTRATOR_URL/.test(
        raw,
      ),
      false,
    );
    assert.equal(
      Object.values(doc.Resources).some((r: any) => /^AWS::(SQS|Events|Scheduler)::/.test(r.Type)),
      false,
    );
  }
  const cluster = Object.values(data.Resources).find(
    (r: any) => r.Type === 'AWS::RDS::DBCluster',
  ) as any;
  assert.deepEqual(cluster.Properties.ServerlessV2ScalingConfiguration, {
    MaxCapacity: 1,
    MinCapacity: 0.5,
  });
  assert.equal(cluster.Properties.DeletionProtection, true);
  assert.equal(
    Object.values(data.Resources).filter((r: any) => r.Type === 'AWS::RDS::DBInstance').length,
    1,
  );
  for (const instance of Object.values(data.Resources).filter(
    (r: any) => r.Type === 'AWS::RDS::DBInstance',
  ) as any[]) {
    assert.equal(instance.Properties.EnablePerformanceInsights, false);
    assert.equal(instance.Properties.PubliclyAccessible, false);
  }
  assert.equal(
    Object.values(data.Resources).some(
      (r: any) => r.Type === 'AWS::SecretsManager::RotationSchedule',
    ),
    false,
  );
  assert.equal(
    Object.values(data.Resources).filter((r: any) => r.Type === 'AWS::SecretsManager::Secret')
      .length,
    2,
  );
  assert.equal(
    Object.values(data.Resources).some(
      (r: any) =>
        r.Type === 'AWS::Lambda::Function' ||
        r.Type === 'AWS::IAM::Role' ||
        r.Type === 'Custom::LogRetention',
    ),
    false,
  );
  const dbLog = Object.values(data.Resources).find(
    (r: any) => r.Type === 'AWS::Logs::LogGroup',
  ) as any;
  assert.equal(dbLog.Properties.RetentionInDays, 14);
  assert.equal(dbLog.Properties.LogGroupName, '/aws/rds/cluster/capiro-preview/postgresql');
  assert.equal(
    Object.values(assets.Resources).some(
      (r: any) => r.Type === 'AWS::IAM::Role' || r.Type === 'AWS::IAM::Policy',
    ),
    false,
  );
  const policies = resources.filter((r: any) => r.Type === 'AWS::IAM::Policy');
  for (const policy of policies)
    for (const statement of policy.Properties.PolicyDocument.Statement) {
      const actions = [statement.Action].flat();
      if (actions.includes('s3:ListBucket'))
        assert.deepEqual(
          statement.Condition.StringLike['s3:prefix'].sort(),
          [fixture.neoTenantId, fixture.automationTenantId]
            .flatMap((t) => [`tenants/${t}/*`, `tenants/client-logo-uploads/${t}/*`])
            .sort(),
        );
      if (actions.includes('s3:PutObject')) {
        const raw = JSON.stringify(statement.Resource);
        for (const t of [fixture.neoTenantId, fixture.automationTenantId])
          assert.ok(raw.includes(t));
        assert.equal(actions.includes('s3:PutObjectLegalHold'), false);
        assert.equal(actions.includes('s3:PutObjectRetention'), false);
      }
      if (actions.includes('kms:Decrypt'))
        assert.ok(
          ['s3.us-east-1.amazonaws.com', 'secretsmanager.us-east-1.amazonaws.com'].includes(
            statement.Condition.StringEquals['kms:ViaService'],
          ),
        );
      if (statement.Resource === '*') assert.deepEqual(actions, ['ecr:GetAuthorizationToken']);
    }
  const bucket = Object.values(assets.Resources).find(
    (r: any) => r.Type === 'AWS::S3::Bucket',
  ) as any;
  assert.equal(bucket.Properties.BucketName, 'capiro-preview-tenant-assets-967807252336');
  assert.deepEqual(bucket.Properties.CorsConfiguration.CorsRules[0].AllowedOrigins, [
    'https://portfolio-preview.app.capiro.ai',
  ]);
  assert.equal(
    Object.values(network.Resources).some((r: any) => r.Type === 'AWS::EC2::Route'),
    false,
  );
  assert.equal(
    Object.values(network.Resources).filter((r: any) => r.Type === 'AWS::EC2::Subnet').length,
    2,
  );
  // CDK may allocate its owned local assembly directory; root records/cleans it.
  assert.equal(fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink(), false);
});

test('CLI help/missing/unknown modes never allocate output', () => {
  const before = fs.existsSync(output) ? fs.readdirSync(output).sort() : [];
  assert.equal(main(['--help']), 0);
  assert.equal(main([]), 2);
  assert.equal(main(['--deploy']), 2);
  assert.deepEqual(fs.existsSync(output) ? fs.readdirSync(output).sort() : [], before);
});

test('CLI refuses a dangling output symlink before assembly allocation', () => {
  const link = path.join(os.tmpdir(), `capiro-preview-output-link-${process.pid}`);
  const target = path.join(os.tmpdir(), `capiro-preview-output-target-${process.pid}`);
  assert.equal(fs.lstatSync(link, { throwIfNoEntry: false }), undefined);
  assert.equal(fs.lstatSync(target, { throwIfNoEntry: false }), undefined);
  // Windows requires the junction target to exist at creation; remove the
  // newly owned empty directory immediately to retain the dangling-link case.
  if (process.platform === 'win32') fs.mkdirSync(target);
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  if (process.platform === 'win32') fs.rmdirSync(target);
  try {
    assert.equal(
      main(['--render', path.join(__dirname, '../fixtures/preview-backends.synthetic.json'), link]),
      2,
    );
    assert.equal(fs.lstatSync(target, { throwIfNoEntry: false }), undefined);
  } finally {
    assert.equal(path.resolve(fs.readlinkSync(link)), path.resolve(target));
    fs.unlinkSync(link);
  }
});
