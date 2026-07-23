import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';

/**
 * EcsCaptureLauncher — spawns ONE ephemeral Fargate task per live Senate hearing
 * (Neo's "run-task per hearing" decision). The poller injects `launch` as its
 * `launchCapture` hook; each task runs the container's `task capture <captureId>`
 * verb (entrypoint `task)` arm) for the hearing's duration and exits on EOF.
 *
 * All wiring is env-driven so the code ships now and goes live only once the
 * gated infra exists (capture task-def + private subnets + SG + ecs:RunTask /
 * iam:PassRole on the poller's role). Until then `configured()` is false and
 * `launch()` no-ops (returns null) — the poller records the hearing as 'live'
 * and simply retries next cycle, so nothing breaks while dark.
 *
 *   CAPTURE_ECS_CLUSTER      (default 'capiro-dev')
 *   CAPTURE_TASK_DEF         family:revision or full ARN of the capture task-def
 *   CAPTURE_CONTAINER        container name in that task-def whose command we override
 *   CAPTURE_SUBNETS          comma-separated private subnet ids (awsvpc)
 *   CAPTURE_SECURITY_GROUPS  comma-separated security-group ids
 *   CAPTURE_ASSIGN_PUBLIC_IP 'ENABLED' | 'DISABLED' (default DISABLED — private subnets + NAT)
 */
@Injectable()
export class EcsCaptureLauncher {
  private readonly logger = new Logger(EcsCaptureLauncher.name);
  private readonly cluster: string;
  private readonly taskDef: string;
  private readonly container: string;
  private readonly subnets: string[];
  private readonly securityGroups: string[];
  private readonly assignPublicIp: 'ENABLED' | 'DISABLED';
  private client?: ECSClient;

  constructor(config: ConfigService) {
    this.cluster =
      config.get<string>('CAPTURE_ECS_CLUSTER')?.trim() ||
      config.get<string>('ECS_CLUSTER')?.trim() ||
      'capiro-dev';
    this.taskDef = config.get<string>('CAPTURE_TASK_DEF')?.trim() || '';
    this.container = config.get<string>('CAPTURE_CONTAINER')?.trim() || 'intel-api-capture';
    this.subnets = splitCsv(config.get<string>('CAPTURE_SUBNETS'));
    this.securityGroups = splitCsv(config.get<string>('CAPTURE_SECURITY_GROUPS'));
    this.assignPublicIp =
      (config.get<string>('CAPTURE_ASSIGN_PUBLIC_IP')?.trim().toUpperCase() === 'ENABLED')
        ? 'ENABLED'
        : 'DISABLED';
  }

  /** True once the gated infra env is present; false → launch() no-ops. */
  configured(): boolean {
    return Boolean(this.taskDef && this.subnets.length && this.securityGroups.length);
  }

  /**
   * RunTask a capture worker for `captureId`. Returns the task ARN, or null when
   * unconfigured or the RunTask failed (the poller leaves the row 'live' to
   * retry). One task, FARGATE, awsvpc — command overridden to `task capture <id>`.
   */
  async launch(captureId: string): Promise<string | null> {
    if (!this.configured()) {
      this.logger.warn(
        `capture launch skipped: EcsCaptureLauncher not configured (set CAPTURE_TASK_DEF/SUBNETS/SECURITY_GROUPS)`,
      );
      return null;
    }
    this.client ??= new ECSClient({});
    try {
      const res = await this.client.send(
        new RunTaskCommand({
          cluster: this.cluster,
          taskDefinition: this.taskDef,
          launchType: 'FARGATE',
          count: 1,
          startedBy: 'senate-auto-capture-poller',
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: this.subnets,
              securityGroups: this.securityGroups,
              assignPublicIp: this.assignPublicIp,
            },
          },
          overrides: {
            containerOverrides: [
              { name: this.container, command: ['task', 'capture', captureId] },
            ],
          },
        }),
      );
      const arn = res.tasks?.[0]?.taskArn ?? null;
      if (!arn) {
        const why = res.failures?.map((f) => `${f.arn ?? '?'}:${f.reason ?? '?'}`).join(', ');
        this.logger.error(`RunTask returned no task for capture ${captureId}: ${why ?? 'unknown'}`);
        return null;
      }
      return arn;
    } catch (err) {
      this.logger.error(`RunTask failed for capture ${captureId}: ${(err as Error).message}`);
      return null;
    }
  }
}

function splitCsv(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
