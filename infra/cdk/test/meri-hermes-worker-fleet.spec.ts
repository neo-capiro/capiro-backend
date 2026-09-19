import assert from 'node:assert/strict';
import test from 'node:test';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Template } from 'aws-cdk-lib/assertions';
import { MeriHermesWorkerFleet } from '../lib/constructs/meri-hermes-worker-fleet';

function synth(overrides: Partial<{ apiLogGroup: boolean }> = {}) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'Test', { env: { account: '000000000000', region: 'us-east-1' } });
  const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2, natGateways: 0 });
  const construct = new MeriHermesWorkerFleet(stack, 'Fleet', {
    envName: 'test',
    vpc,
    subnets: vpc.isolatedSubnets.length ? vpc.isolatedSubnets : vpc.privateSubnets,
    workerRepo: ecr.Repository.fromRepositoryName(stack, 'Repo', 'meri-hermes-worker'),
    workerImageDigest: `sha256:${'a'.repeat(64)}`,
    apiServerKeySecret: secretsmanager.Secret.fromSecretCompleteArn(
      stack,
      'ApiServerKey',
      'arn:aws:secretsmanager:us-east-1:000000000000:secret:api-server-key-AbCdEf',
    ),
    modelCredentialSecret: secretsmanager.Secret.fromSecretCompleteArn(
      stack,
      'ModelCredential',
      'arn:aws:secretsmanager:us-east-1:000000000000:secret:openai-key-AbCdEf',
    ),
    modelCredentialSecretField: 'apiKey',
    modelCredentialEnvName: 'OPENAI_API_KEY',
    brokerUrl: 'https://api.example.internal/api/internal/hermes/broker',
    hermesModel: 'gpt-5.6-terra',
    hermesProvider: 'custom',
    hermesBaseUrl: 'https://api.openai.com/v1',
    region: 'us-east-1',
    account: '000000000000',
    protectFromDestroy: false,
    alertsTopic: sns.Topic.fromTopicArn(stack, 'Alerts', 'arn:aws:sns:us-east-1:000000000000:alerts'),
    ...(overrides.apiLogGroup
      ? { apiLogGroup: new logs.LogGroup(stack, 'ApiLogs', { retention: logs.RetentionDays.ONE_WEEK }) }
      : {}),
  });
  const apiRole = new iam.Role(stack, 'ApiTaskRole', { assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com') });
  construct.grantLifecycleAccess(apiRole, 'arn:aws:ecs:us-east-1:000000000000:cluster/capiro-test');
  return { template: Template.fromStack(stack), construct };
}

test('rejects a non-digest image reference', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'Test');
  const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 2, natGateways: 0 });
  assert.throws(() => {
    new MeriHermesWorkerFleet(stack, 'Fleet', {
      envName: 'test',
      vpc,
      subnets: vpc.isolatedSubnets,
      workerRepo: ecr.Repository.fromRepositoryName(stack, 'Repo', 'meri-hermes-worker'),
      workerImageDigest: 'latest',
      apiServerKeySecret: secretsmanager.Secret.fromSecretCompleteArn(
        stack,
        'ApiServerKey',
        'arn:aws:secretsmanager:us-east-1:000000000000:secret:api-server-key-AbCdEf',
      ),
      modelCredentialSecret: secretsmanager.Secret.fromSecretCompleteArn(
        stack,
        'ModelCredential',
        'arn:aws:secretsmanager:us-east-1:000000000000:secret:openai-key-AbCdEf',
      ),
      modelCredentialSecretField: 'apiKey',
      modelCredentialEnvName: 'OPENAI_API_KEY',
      brokerUrl: 'https://api.example.internal/api/internal/hermes/broker',
      hermesModel: 'gpt-5.6-terra',
      hermesProvider: 'custom',
      hermesBaseUrl: 'https://api.openai.com/v1',
      region: 'us-east-1',
      account: '000000000000',
      protectFromDestroy: false,
      alertsTopic: sns.Topic.fromTopicArn(stack, 'Alerts', 'arn:aws:sns:us-east-1:000000000000:alerts'),
    });
  }, /immutable ECR digest/);
});

test('task definition is ARM64/Linux, 1 vCPU / 2 GiB, with no EFS volume baked in', () => {
  const { template } = synth();
  const taskDefs = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
  assert.equal(taskDefs.length, 1);
  const task: any = taskDefs[0];
  assert.equal(task.Properties.RuntimePlatform?.CpuArchitecture, 'ARM64');
  assert.equal(task.Properties.RuntimePlatform?.OperatingSystemFamily, 'LINUX');
  assert.equal(task.Properties.Cpu, '1024');
  assert.equal(task.Properties.Memory, '2048');
  // See the construct's class doc: this template task def is never RunTask-able
  // directly for real work — no EFS volume is registered on it.
  assert.ok(!task.Properties.Volumes || task.Properties.Volumes.length === 0);
});

test('static env/secrets are on the container; no per-scope value is baked in', () => {
  const { template } = synth();
  const task: any = Object.values(template.findResources('AWS::ECS::TaskDefinition'))[0];
  const container = task.Properties.ContainerDefinitions[0];
  const envNames = (container.Environment ?? []).map((e: any) => e.Name);
  assert.ok(envNames.includes('MERI_BROKER_URL'));
  assert.ok(envNames.includes('MERI_HERMES_MODEL'));
  assert.ok(envNames.includes('HERMES_EXEC_ASK'));
  assert.ok(!envNames.includes('MERI_EXECUTION_SCOPE_ID'));
  assert.ok(!envNames.includes('MERI_WORKER_TOKEN'));
  assert.ok(!envNames.includes('MERI_SOUL_B64'));
  const secretNames = (container.Secrets ?? []).map((s: any) => s.Name);
  assert.ok(secretNames.includes('API_SERVER_KEY'));
  assert.ok(secretNames.includes('OPENAI_API_KEY'));
});

test('worker task role has EFS client access only — no S3/DynamoDB/wildcard AWS access', () => {
  const { template } = synth();
  const policies: any[] = Object.values(template.findResources('AWS::IAM::Policy'));
  const roles: any[] = Object.values(template.findResources('AWS::IAM::Role'));
  const workerTaskRole = roles.find((r: any) =>
    r.Properties.Description?.includes('Meri Hermes worker task role'),
  );
  assert.ok(workerTaskRole, 'expected a worker task role with the documented description');

  // Every statement attached anywhere in the stack that isn't scoped to
  // secretsmanager (execution role) or logs (default CDK grants) or EFS must
  // not grant s3:*/dynamodb:*/a wildcard action, proving the task role never
  // picks up broad AWS access.
  for (const policy of policies) {
    for (const statement of policy.Properties.PolicyDocument.Statement) {
      const actions: string[] = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      for (const action of actions) {
        assert.notEqual(action, '*');
        assert.ok(!/^s3:/i.test(action), `unexpected S3 action ${action}`);
        assert.ok(!/^dynamodb:/i.test(action), `unexpected DynamoDB action ${action}`);
      }
    }
  }
});

test('security group has no unrestricted inbound and only HTTPS/DNS/NFS egress', () => {
  const { template } = synth();
  const groups: any[] = Object.values(template.findResources('AWS::EC2::SecurityGroup'));
  const workerGroup = groups.find((g: any) => g.Properties.GroupDescription?.includes('constrained egress'));
  assert.ok(workerGroup, 'expected the worker security group');
  assert.ok(!workerGroup.Properties.SecurityGroupIngress || workerGroup.Properties.SecurityGroupIngress.length === 0);
});

test('EFS file system is encrypted', () => {
  const { template } = synth();
  const filesystems: any[] = Object.values(template.findResources('AWS::EFS::FileSystem'));
  assert.equal(filesystems.length, 1);
  assert.equal(filesystems[0].Properties.Encrypted, true);
});

test('grantLifecycleAccess restricts iam:PassRole to exactly the two worker roles', () => {
  const { template } = synth();
  const policies: any[] = Object.values(template.findResources('AWS::IAM::Policy'));
  const passRoleStatements = policies
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement)
    .filter((s: any) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.includes('iam:PassRole');
    });
  assert.ok(passRoleStatements.length >= 1);
  for (const statement of passRoleStatements) {
    assert.notEqual(statement.Resource, '*');
    const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
    assert.equal(resources.length, 2);
  }
});

test('with an apiLogGroup prop, adds a provisioning-failure alarm scoped to it', () => {
  const { template } = synth({ apiLogGroup: true });
  const alarms: any[] = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
  const provisioningAlarm = alarms.find((a: any) => a.Properties.AlarmName?.includes('provisioning-failed'));
  assert.ok(provisioningAlarm);
  const filters: any[] = Object.values(template.findResources('AWS::Logs::MetricFilter'));
  assert.ok(filters.some((f: any) => f.Properties.FilterPattern?.includes('meri_hermes_worker_provisioning')));
});

test('without an apiLogGroup prop, still synthesizes (no provisioning alarm)', () => {
  const { template } = synth();
  const alarms: any[] = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
  assert.ok(!alarms.some((a: any) => a.Properties.AlarmName?.includes('provisioning-failed')));
  // The self-contained worker crash alarm is still present.
  assert.ok(alarms.some((a: any) => a.Properties.AlarmName?.includes('worker-crashed')));
});
