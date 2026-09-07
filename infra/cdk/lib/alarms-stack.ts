import { districtNexusIngestionErrorAlarm } from './district-nexus-ingestion-monitoring';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as kms from 'aws-cdk-lib/aws-kms';
import { commonTags, type EnvConfig } from './config';

export interface AlarmsStackProps extends cdk.StackProps {
  cfg: EnvConfig;
  // CDK-native "full name" tokens (e.g. `app/Capiro-Alb16-XYZ/abc`), these
  // are the exact form CloudWatch expects in the metric dimension.
  albFullName: string;
  apiTargetGroupFullName: string;
  webTargetGroupFullName: string;
  marketingTargetGroupFullName: string;
  ecsClusterName: string;
  apiServiceName: string;
  webServiceName: string;
  marketingServiceName: string;
  auroraClusterIdentifier: string;
  // Email subscribed to the alerts topic. Operator confirms via the AWS
  // confirmation email after first deploy. Multiple emails comma-separated.
  alertEmails?: string;
}

/**
 * CloudWatch alarms wired to a single SNS topic that fans out to email
 * (and PagerDuty later via an SNS → Lambda → PagerDuty Events bridge, when
 * an account is provisioned).
 *
 * Alarms shipped:
 *   - ALB 5xx rate (target group + LB-level)
 *   - ALB target health (any unhealthy in api/web/marketing target groups)
 *   - ECS service running task count below desired
 *   - Aurora CPU > 80% sustained
 *   - Aurora connection count near limit
 *   - KMS access denied events (via metric filter from CloudTrail, added later)
 *
 * The alarms are intentionally conservative (1 datapoint, short evaluation
 * windows) for dev so we see noise; tighten thresholds + evaluation periods
 * before prod.
 */
export class AlarmsStack extends cdk.Stack {
  public readonly alertsTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: AlarmsStackProps) {
    super(scope, id, props);
    const { cfg } = props;
    Object.entries(commonTags(cfg)).forEach(([k, v]) => cdk.Tags.of(this).add(k, v));

    const topicKey = new kms.Key(this, 'AlertsKey', {
      alias: `alias/capiro/${cfg.envName}/alerts`,
      description: `Capiro ${cfg.envName} CloudWatch alerts SNS encryption CMK`,
      enableKeyRotation: true,
      removalPolicy: cfg.protectFromDestroy
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    this.alertsTopic = new sns.Topic(this, 'AlertsTopic', {
      topicName: `capiro-${cfg.envName}-alerts`,
      displayName: `Capiro ${cfg.envName} alerts`,
      masterKey: topicKey,
    });

    // CloudWatch alarms are an AWS service principal, they need to publish
    // to the topic and decrypt with the topic's CMK.
    const cwPrincipal = new iam.ServicePrincipal('cloudwatch.amazonaws.com');
    this.alertsTopic.grantPublish(cwPrincipal);
    topicKey.grant(cwPrincipal, 'kms:Decrypt', 'kms:GenerateDataKey');

    const emails = (props.alertEmails ?? '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    for (const email of emails) {
      this.alertsTopic.addSubscription(new snsSubs.EmailSubscription(email));
    }

    const action = new cwActions.SnsAction(this.alertsTopic);

    // ----- ALB 5xx -----
    const alb5xx = new cloudwatch.Alarm(this, 'Alb5xxAlarm', {
      alarmName: `capiro-${cfg.envName}-alb-5xx`,
      alarmDescription: 'ALB returned 5xx (LB-level, not target) above threshold',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'HTTPCode_ELB_5XX_Count',
        statistic: 'Sum',
        period: cdk.Duration.minutes(1),
        dimensionsMap: { LoadBalancer: props.albFullName },
      }),
      threshold: 5,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    alb5xx.addAlarmAction(action);

    // ----- API target 5xx -----
    const apiTarget5xx = new cloudwatch.Alarm(this, 'ApiTarget5xxAlarm', {
      alarmName: `capiro-${cfg.envName}-api-target-5xx`,
      alarmDescription: 'API target group returned 5xx above threshold',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'HTTPCode_Target_5XX_Count',
        statistic: 'Sum',
        period: cdk.Duration.minutes(1),
        dimensionsMap: {
          LoadBalancer: props.albFullName,
          TargetGroup: props.apiTargetGroupFullName,
        },
      }),
      threshold: 10,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    apiTarget5xx.addAlarmAction(action);

    // ----- Target health (api / web / marketing) -----
    for (const [id, tg] of [
      ['ApiUnhealthy', props.apiTargetGroupFullName],
      ['WebUnhealthy', props.webTargetGroupFullName],
      ['MarketingUnhealthy', props.marketingTargetGroupFullName],
    ] as const) {
      const a = new cloudwatch.Alarm(this, id + 'Alarm', {
        alarmName: `capiro-${cfg.envName}-${id.toLowerCase()}`,
        alarmDescription: `${id}, target group has unhealthy hosts`,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/ApplicationELB',
          metricName: 'UnHealthyHostCount',
          statistic: 'Maximum',
          period: cdk.Duration.minutes(1),
          dimensionsMap: { LoadBalancer: props.albFullName, TargetGroup: tg },
        }),
        threshold: 1,
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      });
      a.addAlarmAction(action);
    }

    // ----- ECS service: running count < desired -----
    for (const [id, serviceName] of [
      ['ApiRunningCount', props.apiServiceName],
      ['WebRunningCount', props.webServiceName],
      ['MarketingRunningCount', props.marketingServiceName],
    ] as const) {
      const a = new cloudwatch.Alarm(this, id + 'Alarm', {
        alarmName: `capiro-${cfg.envName}-${id.toLowerCase()}`,
        alarmDescription: `${id}, ECS RunningTaskCount dropped to zero`,
        metric: new cloudwatch.Metric({
          namespace: 'ECS/ContainerInsights',
          metricName: 'RunningTaskCount',
          statistic: 'Minimum',
          period: cdk.Duration.minutes(1),
          dimensionsMap: { ClusterName: props.ecsClusterName, ServiceName: serviceName },
        }),
        threshold: 1,
        evaluationPeriods: 5,
        datapointsToAlarm: 5,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      });
      a.addAlarmAction(action);
    }

    // ----- Aurora CPU + connection count -----
    const auroraCpu = new cloudwatch.Alarm(this, 'AuroraCpuAlarm', {
      alarmName: `capiro-${cfg.envName}-aurora-cpu`,
      alarmDescription: 'Aurora writer CPU above 80% sustained',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/RDS',
        metricName: 'CPUUtilization',
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
        dimensionsMap: { DBClusterIdentifier: props.auroraClusterIdentifier, Role: 'WRITER' },
      }),
      threshold: 80,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    auroraCpu.addAlarmAction(action);

    const auroraConnections = new cloudwatch.Alarm(this, 'AuroraConnectionsAlarm', {
      alarmName: `capiro-${cfg.envName}-aurora-connections`,
      alarmDescription: 'Aurora writer connection count climbing, possible leak',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/RDS',
        metricName: 'DatabaseConnections',
        statistic: 'Average',
        period: cdk.Duration.minutes(5),
        dimensionsMap: { DBClusterIdentifier: props.auroraClusterIdentifier, Role: 'WRITER' },
      }),
      threshold: 100,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    auroraConnections.addAlarmAction(action);

    const peErrorAlarm = new cloudwatch.Alarm(this, 'PeSyncErrorAlarm', {
      alarmName: `capiro-${cfg.envName}-pe-sync-error`,
      alarmDescription: 'PE sync errors detected for 2 consecutive runs',
      metric: new cloudwatch.Metric({
        namespace: 'Capiro/ProgramElementSync',
        metricName: 'pe_sync.error_count',
        statistic: 'Sum',
        period: cdk.Duration.minutes(15),
      }),
      threshold: 0,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    peErrorAlarm.addAlarmAction(action);

    const peStaleBySourceAlarm = new cloudwatch.Alarm(this, 'PeSyncStaleBySourceAlarm', {
      alarmName: `capiro-${cfg.envName}-pe-sync-stale-by-source`,
      alarmDescription: 'PE sync had zero inserted+updated rows for 3 consecutive runs (source-level)',
      metric: new cloudwatch.MathExpression({
        expression: 'm1 + m2',
        usingMetrics: {
          m1: new cloudwatch.Metric({
            namespace: 'Capiro/ProgramElementSync',
            metricName: 'pe_sync.rows_inserted',
            statistic: 'Sum',
            period: cdk.Duration.minutes(15),
          }),
          m2: new cloudwatch.Metric({
            namespace: 'Capiro/ProgramElementSync',
            metricName: 'pe_sync.rows_updated',
            statistic: 'Sum',
            period: cdk.Duration.minutes(15),
          }),
        },
      }),
      threshold: 0,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    peStaleBySourceAlarm.addAlarmAction(action);

    const peDurationAlarm = new cloudwatch.Alarm(this, 'PeSyncDurationAlarm', {
      alarmName: `capiro-${cfg.envName}-pe-sync-duration`,
      alarmDescription: 'PE sync duration exceeded 1800 seconds',
      metric: new cloudwatch.Metric({
        namespace: 'Capiro/ProgramElementSync',
        metricName: 'pe_sync.duration_seconds',
        statistic: 'Maximum',
        period: cdk.Duration.minutes(15),
      }),
      threshold: 1800,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    peDurationAlarm.addAlarmAction(action);

    // Aggregate ingestion-error alarm (Production Ingestion plan, Phase 2.3).
    // Fires if ANY scheduled sync job reports errors across 2 consecutive
    // 1-hour windows. Sourced from the IngestionErrorMetricFilter on the
    // api-sync-jobs log group (Capiro/Ingestion namespace).
    const ingestionErrorAlarm = new cloudwatch.Alarm(this, 'IngestionErrorAlarm', {
      alarmName: `capiro-${cfg.envName}-ingestion-error`,
      alarmDescription: 'A scheduled ingestion job reported errors (any source)',
      metric: new cloudwatch.Metric({
        namespace: 'Capiro/Ingestion',
        metricName: 'ingestion.error_count',
        statistic: 'Sum',
        period: cdk.Duration.hours(1),
      }),
      threshold: 0,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    ingestionErrorAlarm.addAlarmAction(action);
    districtNexusIngestionErrorAlarm(this, cfg.envName).addAlarmAction(action);

    const peSyncDashboard = new cloudwatch.Dashboard(this, 'PeSyncDashboard', {
      dashboardName: `capiro-${cfg.envName}-pe-sync`,
    });

    peSyncDashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'PE rows synced by source (inserted + updated)',
        left: [
          new cloudwatch.MathExpression({
            expression: 'm1 + m2',
            usingMetrics: {
              m1: new cloudwatch.Metric({
                namespace: 'Capiro/ProgramElementSync',
                metricName: 'pe_sync.rows_inserted',
                statistic: 'Sum',
                period: cdk.Duration.hours(1),
              }),
              m2: new cloudwatch.Metric({
                namespace: 'Capiro/ProgramElementSync',
                metricName: 'pe_sync.rows_updated',
                statistic: 'Sum',
                period: cdk.Duration.hours(1),
              }),
            },
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'PE sync duration by source',
        left: [
          new cloudwatch.Metric({
            namespace: 'Capiro/ProgramElementSync',
            metricName: 'pe_sync.duration_seconds',
            statistic: 'Maximum',
            period: cdk.Duration.hours(1),
          }),
        ],
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Total PEs in DB',
        metrics: [
          new cloudwatch.Metric({
            namespace: 'Capiro/ProgramElementSync',
            metricName: 'pe_sync.rows_in_db',
            statistic: 'Maximum',
            period: cdk.Duration.hours(1),
          }),
        ],
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Total quarantined',
        metrics: [
          new cloudwatch.Metric({
            namespace: 'Capiro/ProgramElementSync',
            metricName: 'pe_sync.quarantine_count',
            statistic: 'Maximum',
            period: cdk.Duration.hours(1),
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'PE updates by Service (30d, surrogate heatmap)',
        left: [
          new cloudwatch.Metric({
            namespace: 'Capiro/ProgramElementSync',
            metricName: 'pe_sync.rows_updated',
            statistic: 'Sum',
            period: cdk.Duration.days(1),
          }),
        ],
      }),
    );

    new cdk.CfnOutput(this, 'AlertsTopicArn', { value: this.alertsTopic.topicArn });
    new cdk.CfnOutput(this, 'PeSyncDashboardName', { value: peSyncDashboard.dashboardName });
  }
}

