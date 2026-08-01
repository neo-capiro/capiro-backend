import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from '@jest/globals';

function infra(path: string): string {
  return readFileSync(resolve(process.cwd(), '../../infra/cdk', path), 'utf8');
}

const construct = infra('lib/constructs/scheduled-memory-projection-worker.ts');
const stack = infra('lib/memory-projection-worker-stack.ts');
const control = infra('lib/meriv2-control-stack.ts');
const primaryApp = infra('bin/capiro.ts');
const operationsApp = infra('bin/meriv2-operations.ts');
const infraPackage = infra('package.json');
const dispatcher = readFileSync(
  resolve(process.cwd(), 'scripts/entrypoint-dispatcher.inc'),
  'utf8',
);

describe('scheduled governed-memory projection infrastructure', () => {
  test('runs a bounded out-of-band worker every five minutes only after an explicit enable', () => {
    expect(construct).toContain('events.Schedule.rate(cdk.Duration.minutes(5))');
    expect(construct).toContain("command: ['drain-memory-cleanup-outbox', '200', '300']");
    expect(construct).toContain('enabled: props.scheduleEnabled');
    expect(construct).not.toContain('enabled: true');
    expect(dispatcher).toContain('drain-memory-cleanup-outbox)');
    expect(operationsApp).toContain("tryGetContext('enableMemoryProjectionWorker')");
    expect(operationsApp).toContain('scheduleEnabled: exactTrue');
  });

  test('binds scheduled tasks to an immutable ECR image digest', () => {
    expect(construct).toContain(
      'ecs.ContainerImage.fromEcrRepository(props.apiRepo, props.apiImageDigest)',
    );
    expect(control).toContain(
      'ecs.ContainerImage.fromEcrRepository(apiRepo, props.apiImageDigest)',
    );
    // The release SHA remains audit evidence; the digest is the container identity.
    expect(operationsApp).toContain("required(app, 'meriv2ApiImageDigest')");
    expect(operationsApp).toContain('/^sha256:[0-9a-f]{64}$/i.test(apiImageDigest)');
    expect(operationsApp).toContain('/^[0-9a-f]{40}$/i.test(releaseSha)');
    expect(operationsApp).not.toContain("'latest'");
  });

  test('uses the app database credential and Titan-only model invocation', () => {
    expect(construct).toContain(
      "DB_USER: ecs.Secret.fromSecretsManager(props.appDbSecret, 'username')",
    );
    expect(construct).toContain(
      "DB_PASSWORD: ecs.Secret.fromSecretsManager(props.appDbSecret, 'password')",
    );
    expect(construct).toContain('amazon.titan-embed-text-v2:0');
    expect(construct).toContain("actions: ['bedrock:InvokeModel']");
    expect(construct).not.toContain('bedrock:*');
  });

  test('has dedicated retained logs, workload metrics, retries, and notified alarms', () => {
    expect(construct).toContain('RetentionDays.ONE_YEAR');
    expect(construct).toContain('retryAttempts: 2');
    expect(construct).toContain("metricName: 'projection_worker.failed'");
    expect(construct).toContain("metricName: 'projection_worker.dead_lettered'");
    expect(construct).toContain("metricName: 'projection_worker.crashed'");
    expect(construct).toContain('new cwActions.SnsAction(props.alertsTopic)');
    expect(construct).toContain('alarm.addAlarmAction(action)');
    expect(construct).toContain('alarm.addOkAction(action)');
    expect(operationsApp).toContain('protectFromDestroy: true');
  });

  test('keeps an intentionally disabled control monitor from false-alarming on silence', () => {
    expect(control).toContain('enabled: props.monitorEnabled');
    expect(control).toContain('props.monitorEnabled');
    expect(control).toContain('cloudwatch.TreatMissingData.BREACHING');
    expect(control).toContain('cloudwatch.TreatMissingData.NOT_BREACHING');
  });

  test('deploys operations without instantiating or updating the frozen Compute stack', () => {
    // The cluster must be IMPORTED, never redeclared. fromClusterAttributes is
    // required over fromClusterArn because EventBridge EcsTask targets need
    // cluster.vpc, which the ARN-only import leaves undefined.
    expect(stack).toContain('ecs.Cluster.fromClusterAttributes');
    expect(stack).toContain('ec2.Subnet.fromSubnetId');
    expect(stack).toContain('ec2.SecurityGroup.fromSecurityGroupId');
    expect(control).toContain('ecs.Cluster.fromClusterAttributes');
    expect(control).toContain('ec2.Subnet.fromSubnetId');
    expect(control).toContain('secretsmanager.Secret.fromSecretCompleteArn');
    expect(operationsApp).not.toContain('new ComputeStack');
    expect(operationsApp).not.toContain('new DataStack');
    expect(operationsApp).not.toContain('new NetworkStack');
    expect(operationsApp).not.toContain('new AlarmsStack');
    expect(primaryApp).not.toContain('new MemoryProjectionWorkerStack');
    expect(primaryApp).not.toContain('new MeriV2ControlStack');
    expect(primaryApp).toContain('owned only by `bin/meriv2-operations.ts`');
    expect(operationsApp).toContain("stackName(operationsCfg.envName, 'MemoryProjectionWorker')");
    expect(operationsApp).toContain("stackName(operationsCfg.envName, 'MeriV2Control')");
    expect(infraPackage).toContain('synth:meriv2-ops');
    expect(infraPackage).toContain('deploy:meriv2-ops');
  });
});
