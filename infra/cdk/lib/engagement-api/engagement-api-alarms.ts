import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

import { engagementApiNames, type EngagementApiInfraConfig } from './engagement-api-config';

/**
 * Observability for the dark `engagement-api` service.
 *
 * The service carries real tenant data on safe reads, so the diagnostic value
 * here comes from route FAMILY and status CLASS — never from campaign content.
 * `ENGAGEMENT_API_LOG_FIELDS` and `ENGAGEMENT_API_FORBIDDEN_LOG_FIELDS` are the
 * machine-readable form of that contract; the spec asserts no dashboard,
 * metric filter or alarm dimension references a forbidden field.
 */

/** Structured log fields the service may emit. */
export const ENGAGEMENT_API_LOG_FIELDS = [
  'service',
  'release_sha',
  'route_family',
  'http_method',
  'status_class',
  'latency_bucket',
  'shadow_denial_action',
  'ui_contract_sha',
] as const;

/** Route families the observability contract recognises. */
export const ENGAGEMENT_API_ROUTE_FAMILIES = [
  'meetings',
  'reports',
  'integrations',
  'outreach_records',
  'targets',
  'profiles',
  'context',
  'drafts',
  'preflight',
  'delivery_history',
  'health',
] as const;

/**
 * Values that must never reach a log line, metric dimension, or dashboard.
 * Campaign content and contact data are the whole point of the restriction.
 */
export const ENGAGEMENT_API_FORBIDDEN_LOG_FIELDS = [
  'goal_text',
  'message_body',
  'subject',
  'recipient_email',
  'recipient',
  'target_name',
  'client_name',
  'context_text',
  'source_excerpt',
  'note_body',
  'oauth_state',
  'bearer_token',
  'campaign_prompt',
] as const;

/** Log patterns that indicate the process failed or came up armed. */
export const ENGAGEMENT_API_FATAL_PATTERN = 'Fatal engagement-api bootstrap error';
export const ENGAGEMENT_API_POSTURE_PATTERN = 'engagement runtime policy rejected';

const METRIC_NAMESPACE = 'Capiro/EngagementApi';

export interface EngagementApiObservabilityProps {
  cfg: EngagementApiInfraConfig;
  service: ecs.FargateService;
  logGroup: logs.ILogGroup;
  /** Derived `app/<name>/<id>` form used by ALB metric dimensions. */
  loadBalancerFullName: string;
  /** Derived `targetgroup/<name>/<id>` form used by target metric dimensions. */
  targetGroupFullName: string;
}

export class EngagementApiObservability extends Construct {
  public readonly alarms: cloudwatch.Alarm[] = [];

  constructor(scope: Construct, id: string, props: EngagementApiObservabilityProps) {
    super(scope, id);
    const { cfg, service, logGroup, loadBalancerFullName, targetGroupFullName } = props;
    const names = engagementApiNames(cfg);
    const topic = sns.Topic.fromTopicArn(this, 'AlarmTopic', cfg.alarmTopicArn);

    const alarm = (
      alarmId: string,
      metric: cloudwatch.IMetric,
      options: {
        threshold: number;
        evaluationPeriods: number;
        datapointsToAlarm?: number;
        comparisonOperator?: cloudwatch.ComparisonOperator;
        treatMissingData?: cloudwatch.TreatMissingData;
        description: string;
      },
    ): cloudwatch.Alarm => {
      const created = new cloudwatch.Alarm(this, alarmId, {
        alarmName: `${names.service}-${alarmId}`,
        alarmDescription: options.description,
        metric,
        threshold: options.threshold,
        evaluationPeriods: options.evaluationPeriods,
        datapointsToAlarm: options.datapointsToAlarm,
        comparisonOperator:
          options.comparisonOperator ?? cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: options.treatMissingData ?? cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      created.addAlarmAction(new actions.SnsAction(topic));
      this.alarms.push(created);
      return created;
    };

    const albDimensions = {
      LoadBalancer: loadBalancerFullName,
      TargetGroup: targetGroupFullName,
    };
    const albMetric = (metricName: string, statistic: string, period = cdk.Duration.minutes(1)) =>
      new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName,
        dimensionsMap: albDimensions,
        statistic,
        period,
      });

    // ── target health ─────────────────────────────────────────────────────
    // Breaching means the dark service is down. That must page, but it must
    // not page before the service exists, hence NOT_BREACHING on missing data.
    alarm('HealthyHosts', albMetric('HealthyHostCount', 'Minimum'), {
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      description: 'engagement-api has no healthy target for three consecutive minutes',
    });

    alarm(
      'Target5xx',
      albMetric('HTTPCode_Target_5XX_Count', 'Sum', cdk.Duration.minutes(5)),
      {
        threshold: 5,
        evaluationPeriods: 1,
        description: 'engagement-api returned five or more 5xx responses in five minutes',
      },
    );

    alarm('LatencyP95', albMetric('TargetResponseTime', 'p95'), {
      threshold: 3,
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      description: 'engagement-api p95 latency exceeded three seconds',
    });

    // ── service saturation ────────────────────────────────────────────────
    for (const [alarmId, metricName, description] of [
      ['Cpu', 'CPUUtilization', 'engagement-api CPU above 80%'],
      ['Memory', 'MemoryUtilization', 'engagement-api memory above 80%'],
    ] as const) {
      alarm(
        alarmId,
        new cloudwatch.Metric({
          namespace: 'AWS/ECS',
          metricName,
          dimensionsMap: {
            ClusterName: service.cluster.clusterName,
            ServiceName: names.service,
          },
          statistic: 'Average',
          period: cdk.Duration.minutes(1),
        }),
        { threshold: 80, evaluationPeriods: 5, datapointsToAlarm: 3, description },
      );
    }

    // ── log-derived posture metrics ───────────────────────────────────────
    // One event is enough: a fatal bootstrap or an armed runtime posture is
    // never acceptable, so these do not wait for a trend.
    const fatal = new logs.MetricFilter(this, 'FatalBootstrapFilter', {
      logGroup,
      metricNamespace: METRIC_NAMESPACE,
      metricName: 'FatalBootstrapError',
      filterPattern: logs.FilterPattern.literal(`"${ENGAGEMENT_API_FATAL_PATTERN}"`),
      metricValue: '1',
      defaultValue: 0,
    });
    alarm(
      'FatalBootstrap',
      fatal.metric({ statistic: 'Sum', period: cdk.Duration.minutes(1) }),
      {
        threshold: 0,
        evaluationPeriods: 1,
        description: 'engagement-api logged a fatal bootstrap error',
      },
    );

    const posture = new logs.MetricFilter(this, 'InvalidPostureFilter', {
      logGroup,
      metricNamespace: METRIC_NAMESPACE,
      metricName: 'InvalidShadowPosture',
      filterPattern: logs.FilterPattern.literal(`"${ENGAGEMENT_API_POSTURE_PATTERN}"`),
      metricValue: '1',
      defaultValue: 0,
    });
    alarm(
      'InvalidShadowPosture',
      posture.metric({ statistic: 'Sum', period: cdk.Duration.minutes(1) }),
      {
        threshold: 0,
        evaluationPeriods: 1,
        description: 'engagement-api rejected its runtime configuration as armed',
      },
    );

    // ── shared database ───────────────────────────────────────────────────
    // The dark service shares Aurora with the main API. This alarm protects
    // the MAIN product, not the preview.
    alarm(
      'DatabaseConnections',
      new cloudwatch.Metric({
        namespace: 'AWS/RDS',
        metricName: 'DatabaseConnections',
        dimensionsMap: { DBClusterIdentifier: cfg.auroraClusterIdentifier },
        statistic: 'Maximum',
        period: cdk.Duration.minutes(5),
      }),
      {
        threshold: cfg.dbConnectionBudget.alarmThreshold,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.MISSING,
        description:
          'Aurora connections exceeded the reviewed engagement-api budget threshold; the ' +
          'shared database is the blast radius that matters',
      },
    );

    // ── deployment and task events ────────────────────────────────────────
    new events.Rule(this, 'DeploymentFailureRule', {
      description: 'engagement-api ECS deployment failure',
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Deployment State Change'],
        detail: {
          eventName: ['SERVICE_DEPLOYMENT_FAILED'],
        },
        resources: events.Match.prefix(
          `arn:aws:ecs:${cfg.region}:${cfg.accountId}:service/`,
        ),
      },
      targets: [new targets.SnsTopic(topic)],
    });

    new events.Rule(this, 'StoppedTaskRule', {
      description: 'engagement-api task stopped unexpectedly',
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: {
          lastStatus: ['STOPPED'],
          // A planned deployment drain is not an incident; only unexpected
          // stops are routed, so the topic stays credible.
          stoppedReason: [{ 'anything-but': { prefix: 'Scaling activity initiated by' } }],
          group: [`service:${names.service}`],
        },
      },
      targets: [new targets.SnsTopic(topic)],
    });

    // ── dashboard ─────────────────────────────────────────────────────────
    // Route family and status class only. No widget can render message
    // bodies, recipients or campaign text because no such metric exists.
    new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${names.service}`,
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: 'Tasks (desired vs running)',
            left: [
              service.metric('DesiredTaskCount', { statistic: 'Maximum' }),
              service.metric('RunningTaskCount', { statistic: 'Minimum' }),
            ],
            width: 8,
          }),
          new cloudwatch.GraphWidget({
            title: 'CPU and memory %',
            left: [service.metricCpuUtilization(), service.metricMemoryUtilization()],
            width: 8,
          }),
          new cloudwatch.GraphWidget({
            title: 'Healthy hosts',
            left: [albMetric('HealthyHostCount', 'Minimum')],
            width: 8,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Target 5xx by status class',
            left: [
              albMetric('HTTPCode_Target_5XX_Count', 'Sum', cdk.Duration.minutes(5)),
              albMetric('HTTPCode_Target_4XX_Count', 'Sum', cdk.Duration.minutes(5)),
            ],
            width: 8,
          }),
          new cloudwatch.GraphWidget({
            title: 'Latency p50 / p95',
            left: [albMetric('TargetResponseTime', 'p50'), albMetric('TargetResponseTime', 'p95')],
            width: 8,
          }),
          new cloudwatch.GraphWidget({
            title: 'Shared Aurora connections',
            left: [
              new cloudwatch.Metric({
                namespace: 'AWS/RDS',
                metricName: 'DatabaseConnections',
                dimensionsMap: { DBClusterIdentifier: cfg.auroraClusterIdentifier },
                statistic: 'Maximum',
              }),
            ],
            width: 8,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Runtime posture and bootstrap errors',
            left: [
              fatal.metric({ statistic: 'Sum' }),
              posture.metric({ statistic: 'Sum' }),
            ],
            width: 24,
          }),
        ],
      ],
    });
  }
}

/** `app/<name>/<id>` from a listener ARN, for ALB metric dimensions. */
export function loadBalancerFullNameFromListenerArn(listenerArn: string): string {
  const match = /:listener\/(app\/[^/]+\/[^/]+)\//.exec(listenerArn);
  if (!match?.[1]) {
    throw new Error(`cannot derive load balancer full name from listener ARN: ${listenerArn}`);
  }
  return match[1];
}

/**
 * `targetgroup/<name>/<id>` from a LITERAL target group ARN.
 *
 * Only usable where the ARN is a real string — discovery output, preflight,
 * the acceptance harness. Inside a stack the ARN is usually a cross-stack
 * token, and the CDK attribute `targetGroup.targetGroupFullName` must be used
 * instead; the explicit token check makes that failure legible rather than
 * producing a regex miss at synth time.
 */
export function targetGroupFullNameFromArn(targetGroupArn: string): string {
  if (cdk.Token.isUnresolved(targetGroupArn)) {
    throw new Error(
      'targetGroupFullNameFromArn received an unresolved token. Use ' +
        'targetGroup.targetGroupFullName inside a stack.',
    );
  }
  const match = /:(targetgroup\/[^/]+\/[^/]+)$/.exec(targetGroupArn);
  if (!match?.[1]) {
    throw new Error(`cannot derive target group full name from ARN: ${targetGroupArn}`);
  }
  return match[1];
}
