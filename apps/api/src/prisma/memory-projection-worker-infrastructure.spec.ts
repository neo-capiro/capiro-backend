import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from '@jest/globals';

function infra(path: string): string {
  return readFileSync(resolve(process.cwd(), '../../infra/cdk', path), 'utf8');
}

const construct = infra('lib/constructs/scheduled-memory-projection-worker.ts');
const stack = infra('lib/memory-projection-worker-stack.ts');
const control = infra('lib/meriv2-control-stack.ts');
const app = infra('bin/capiro.ts');
const dispatcher = readFileSync(resolve(process.cwd(), 'scripts/entrypoint-dispatcher.inc'), 'utf8');

describe('scheduled governed-memory projection infrastructure', () => {
  test('runs a bounded out-of-band worker every five minutes only after an explicit enable', () => {
    expect(construct).toContain('events.Schedule.rate(cdk.Duration.minutes(5))');
    expect(construct).toContain("command: ['drain-memory-cleanup-outbox', '200', '300']");
    expect(construct).toContain('enabled: props.scheduleEnabled');
    expect(construct).not.toContain('enabled: true');
    expect(dispatcher).toContain('drain-memory-cleanup-outbox)');
    expect(app).toContain("tryGetContext('enableMemoryProjectionWorker')");
    expect(app).toContain('scheduleEnabled: memoryProjectionWorkerEnabled');
  });

  test('binds scheduled tasks to an exact immutable release-SHA image tag', () => {
    expect(construct).toContain(
      'ecs.ContainerImage.fromEcrRepository(props.apiRepo, props.apiImageTag)',
    );
    expect(control).toContain(
      'ecs.ContainerImage.fromEcrRepository(props.apiRepo, props.apiImageTag)',
    );
    expect(app).toContain("tryGetContext('meriv2ApiImageTag')");
    expect(app).toContain('/^[0-9a-f]{40}$/i.test(tag)');
    expect(app).toContain('mutable tags such as latest are refused');
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
  });

  test('keeps an intentionally disabled control monitor from false-alarming on silence', () => {
    expect(control).toContain('enabled: props.monitorEnabled');
    expect(control).toContain('props.monitorEnabled');
    expect(control).toContain('cloudwatch.TreatMissingData.BREACHING');
    expect(control).toContain('cloudwatch.TreatMissingData.NOT_BREACHING');
  });

  test('is isolated in its own stack with explicit rollback and alert dependencies', () => {
    expect(stack).toContain('export class MemoryProjectionWorkerStack');
    expect(stack).toContain("new ScheduledMemoryProjectionWorker(this, 'ScheduledWorker'");
    expect(stack).toContain('alertsTopic');
    expect(app).toContain("stackName(cfg.envName, 'MemoryProjectionWorker')");
    expect(app).toContain('memoryProjectionWorker.addDependency(compute)');
    expect(app).toContain('memoryProjectionWorker.addDependency(data)');
    expect(app).toContain('memoryProjectionWorker.addDependency(alarms)');
  });
});
