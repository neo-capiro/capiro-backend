import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import type { ScheduledIngestionJob } from '../ingestion-schedule';

export interface ScheduledIngestionJobsProps {
  envName: string;
  cluster: ecs.ICluster;
  /** Shared sync task definition (API image; command overridden per job). */
  taskDefinition: ecs.FargateTaskDefinition;
  /** Container name within the task def whose command we override. */
  containerName: string;
  securityGroup: ec2.ISecurityGroup;
  jobs: ScheduledIngestionJob[];
}

/**
 * Creates one EventBridge rule per ingestion job, each firing the shared sync
 * Fargate task with a command override (the kebab job name + flags). The task
 * runs in private-with-egress subnets on the existing service security group.
 *
 * Concurrency: EventBridge fires at the scheduled minute; the schedule matrix
 * staggers jobs so two heavy jobs never share a minute. The scripts themselves
 * are idempotent (upsert) and write SyncRun, so an accidental overlap is safe.
 */
export class ScheduledIngestionJobs extends Construct {
  public readonly rules: events.Rule[] = [];

  constructor(scope: Construct, id: string, props: ScheduledIngestionJobsProps) {
    super(scope, id);

    for (const job of props.jobs) {
      const rule = new events.Rule(this, `${job.id}Rule`, {
        ruleName: `capiro-${props.envName}-${kebab(job.id)}`,
        description: `[${job.tier}] ${job.description}`,
        schedule: events.Schedule.cron({
          minute: job.cron.minute,
          hour: job.cron.hour,
          day: job.cron.day ?? (job.cron.weekDay ? undefined : '*'),
          month: job.cron.month ?? '*',
          weekDay: job.cron.weekDay,
          year: '*',
        }),
        // 2026-07-10 hot-fix (R7): a job may ship dark (enabled:false) while
        // its code-level guard is the primary safety mechanism — see
        // ScheduledIngestionJob.enabled's doc comment.
        enabled: job.enabled ?? true,
      });

      rule.addTarget(
        new eventsTargets.EcsTask({
          cluster: props.cluster,
          taskDefinition: props.taskDefinition,
          taskCount: 1,
          subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
          securityGroups: [props.securityGroup as ec2.SecurityGroup],
          containerOverrides: [
            {
              containerName: props.containerName,
              command: job.command,
            },
          ],
        }),
      );

      this.rules.push(rule);
    }
  }
}

/** SyncCongress -> sync-congress for a readable rule name. */
function kebab(id: string): string {
  return id.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}
