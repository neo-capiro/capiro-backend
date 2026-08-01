import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { commonTags, type EnvConfig } from './config';

const NAMESPACE = 'Capiro/MeriV2Control';

export interface MeriV2ControlStackProps extends cdk.StackProps {
  cfg: EnvConfig;
  clusterArn: string;
  apiRepositoryName: string;
  /** Immutable `sha256:...` digest resolved from the exact release-SHA tag. */
  apiImageDigest: string;
  privateSubnetIds: string[];
  serviceSecurityGroupId: string;
  dbSecretArn: string;
  appDbSecretArn: string;
  databaseName: string;
  dataKeyArn: string;
  secretsKeyArn: string;
  alertsTopicArn: string;
  /** Explicit CDK-context gate. A stack deploy alone does not start the monitor. */
  monitorEnabled: boolean;
}

interface AlarmDefinition {
  id: string;
  metricName: string;
  description: string;
  statistic: 'Sum' | 'Maximum' | 'Average';
  periodMinutes: number;
  threshold: number;
  comparison?: cloudwatch.ComparisonOperator;
  treatMissingData?: cloudwatch.TreatMissingData;
}

/**
 * MeriV2 Phase 20 operational control system.
 *
 * This stack is intentionally separate from ComputeStack. Existing runtime
 * dependencies are imported by literal ARN/name/id, so the dedicated operations
 * CDK app can deploy it without updating the drifted/frozen Compute stack merely
 * to add cross-stack exports. The schedule defaults OFF and is enabled only after
 * database/browser prerequisites and a manual monitor run pass.
 */
export class MeriV2ControlStack extends cdk.Stack {
  readonly taskDefinition: ecs.FargateTaskDefinition;
  readonly schedule: events.Rule;

  constructor(scope: Construct, id: string, props: MeriV2ControlStackProps) {
    super(scope, id, props);
    const { cfg } = props;
    if (props.privateSubnetIds.length === 0) {
      throw new Error('The MeriV2 control monitor requires at least one private subnet.');
    }
    if (!/^sha256:[0-9a-f]{64}$/i.test(props.apiImageDigest)) {
      throw new Error('The MeriV2 control monitor requires an immutable ECR digest.');
    }
    for (const [key, value] of Object.entries(commonTags(cfg))) {
      cdk.Tags.of(this).add(key, value);
    }

    const cluster = ecs.Cluster.fromClusterArn(this, 'ImportedCluster', props.clusterArn);
    const apiRepo = ecr.Repository.fromRepositoryName(
      this,
      'ImportedApiRepository',
      props.apiRepositoryName,
    );
    const subnets = props.privateSubnetIds.map((subnetId, index) =>
      ec2.Subnet.fromSubnetId(this, `ImportedPrivateSubnet${index + 1}`, subnetId),
    );
    const securityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'ImportedServiceSecurityGroup',
      props.serviceSecurityGroupId,
      { mutable: false },
    );
    const dbSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'ImportedDatabaseSecret',
      props.dbSecretArn,
    );
    const appDbSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'ImportedApplicationDatabaseSecret',
      props.appDbSecretArn,
    );
    const alertsTopic = sns.Topic.fromTopicArn(this, 'ImportedAlertsTopic', props.alertsTopicArn);

    const logGroup = new logs.LogGroup(this, 'ControlMonitorLogs', {
      logGroupName: `/capiro/${cfg.envName}/meriv2-control-monitor`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cfg.protectFromDestroy ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'ControlMonitorTaskDef', {
      family: `capiro-${cfg.envName}-meriv2-control-monitor`,
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const executionRole = this.taskDefinition.obtainExecutionRole();
    executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [props.dbSecretArn, props.appDbSecretArn],
      }),
    );
    executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:DescribeKey'],
        resources: [props.dataKeyArn, props.secretsKeyArn],
      }),
    );

    this.taskDefinition.addContainer('meriv2-control-monitor', {
      image: ecs.ContainerImage.fromEcrRepository(apiRepo, props.apiImageDigest),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'monitor' }),
      command: ['emit-meriv2-control-metrics'],
      environment: {
        NODE_ENV: cfg.envName === 'dev' ? 'development' : 'production',
        CAPIRO_ENV: cfg.envName,
        MERIV2_CONTROL_METRICS: 'on',
        LOG_LEVEL: 'info',
        DB_NAME: props.databaseName,
      },
      secrets: {
        DB_HOST: ecs.Secret.fromSecretsManager(dbSecret, 'host'),
        DB_PORT: ecs.Secret.fromSecretsManager(dbSecret, 'port'),
        DB_USER: ecs.Secret.fromSecretsManager(appDbSecret, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(appDbSecret, 'password'),
      },
      readonlyRootFilesystem: false,
    });

    this.schedule = new events.Rule(this, 'ControlMonitorSchedule', {
      ruleName: `capiro-${cfg.envName}-meriv2-control-monitor`,
      description: 'Emit bounded governed-memory and assurance control gauges every five minutes.',
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      enabled: props.monitorEnabled,
    });
    this.schedule.addTarget(
      new eventsTargets.EcsTask({
        cluster,
        taskDefinition: this.taskDefinition,
        taskCount: 1,
        subnetSelection: { subnets },
        securityGroups: [securityGroup],
        retryAttempts: 2,
        maxEventAge: cdk.Duration.minutes(30),
      }),
    );

    const action = new cwActions.SnsAction(alertsTopic);
    const dimensionsMap = { Environment: cfg.envName };
    const definitions: AlarmDefinition[] = [
      {
        id: 'PendingCandidateAge',
        metricName: 'PendingCandidateOldestAgeSeconds',
        description: 'The oldest pending governed-memory proposal is over 24 hours old.',
        statistic: 'Maximum',
        periodMinutes: 5,
        threshold: 86_400,
      },
      {
        id: 'SelfReviewDenials',
        metricName: 'SelfReviewDenials',
        description: 'A shared-memory self-review attempt was denied.',
        statistic: 'Sum',
        periodMinutes: 5,
        threshold: 1,
      },
      {
        id: 'EthicalWallDenials',
        metricName: 'EthicalWallDenials',
        description: 'Ethical-wall denials exceeded the bounded five-minute threshold.',
        statistic: 'Sum',
        periodMinutes: 5,
        threshold: 10,
      },
      {
        id: 'ConflictedMemory',
        metricName: 'ConflictedMemoryCount',
        description: 'One or more governed-memory conflicts require resolution.',
        statistic: 'Maximum',
        periodMinutes: 5,
        threshold: 1,
      },
      {
        id: 'ContextPersistence',
        metricName: 'ContextPacketPersistenceFailures',
        description: 'A required truthful Context Packet could not be durably persisted.',
        statistic: 'Sum',
        periodMinutes: 5,
        threshold: 1,
      },
      {
        id: 'AssuranceHeld',
        metricName: 'AssuranceHeldOutcomes',
        description: 'Assurance held or repaired five or more outputs in fifteen minutes.',
        statistic: 'Sum',
        periodMinutes: 15,
        threshold: 5,
      },
      {
        id: 'AssuranceDegraded',
        metricName: 'AssuranceDegradedOutcomes',
        description: 'Assurance degraded ten or more outputs in fifteen minutes.',
        statistic: 'Sum',
        periodMinutes: 15,
        threshold: 10,
      },
      {
        id: 'UnsupportedHighRiskRate',
        metricName: 'UnsupportedHighRiskClaimRate',
        description: 'Average unsupported high-risk claim rate exceeded 20 percent.',
        statistic: 'Average',
        periodMinutes: 15,
        threshold: 20,
      },
      {
        id: 'OutboxOldestAge',
        metricName: 'OutboxOldestAgeSeconds',
        description: 'A governed-memory projection obligation is more than fifteen minutes old.',
        statistic: 'Maximum',
        periodMinutes: 5,
        threshold: 900,
      },
      {
        id: 'OutboxRetries',
        metricName: 'OutboxRetryingCount',
        description: 'One or more governed-memory projection obligations are retrying.',
        statistic: 'Maximum',
        periodMinutes: 5,
        threshold: 1,
      },
      {
        id: 'OutboxDeadLetter',
        metricName: 'OutboxDeadLetterCount',
        description: 'A governed-memory projection obligation reached dead-letter.',
        statistic: 'Maximum',
        periodMinutes: 5,
        threshold: 1,
      },
      {
        id: 'PolicyDrift',
        metricName: 'PolicyDriftInvalidations',
        description: 'Destination-side assurance invalidated a stale policy binding.',
        statistic: 'Sum',
        periodMinutes: 5,
        threshold: 1,
      },
      {
        id: 'BackfillQuarantine',
        metricName: 'BackfillQuarantineCount',
        description: 'Governance backfill rows remain quarantined for human review.',
        statistic: 'Maximum',
        periodMinutes: 5,
        threshold: 1,
      },
      {
        id: 'BackfillDrift',
        metricName: 'BackfillDriftCount',
        description: 'Governance backfill execution or rollback encountered row drift.',
        statistic: 'Maximum',
        periodMinutes: 5,
        threshold: 1,
      },
      {
        id: 'ControlMonitorFailure',
        metricName: 'ControlMonitorFailures',
        description: 'The scheduled MeriV2 control monitor failed.',
        statistic: 'Sum',
        periodMinutes: 5,
        threshold: 1,
        // Intentional silence while the schedule is dark is healthy. Once armed,
        // a missing heartbeat must alarm.
        treatMissingData: props.monitorEnabled
          ? cloudwatch.TreatMissingData.BREACHING
          : cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    ];

    for (const definition of definitions) {
      const metric = new cloudwatch.Metric({
        namespace: NAMESPACE,
        metricName: definition.metricName,
        dimensionsMap,
        statistic: definition.statistic,
        period: cdk.Duration.minutes(definition.periodMinutes),
      });
      const alarm = new cloudwatch.Alarm(this, `${definition.id}Alarm`, {
        alarmName: `capiro-${cfg.envName}-meriv2-${kebab(definition.id)}`,
        alarmDescription: definition.description,
        metric,
        threshold: definition.threshold,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        comparisonOperator:
          definition.comparison ?? cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: definition.treatMissingData ?? cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(action);
      alarm.addOkAction(action);
    }

    const dashboard = new cloudwatch.Dashboard(this, 'MeriV2ControlDashboard', {
      dashboardName: `capiro-${cfg.envName}-meriv2-control`,
    });
    const metric = (name: string, statistic: string = 'Maximum') =>
      new cloudwatch.Metric({
        namespace: NAMESPACE,
        metricName: name,
        dimensionsMap,
        statistic,
        period: cdk.Duration.minutes(5),
      });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Governed memory queues and conflicts',
        left: [
          metric('PendingCandidateOldestAgeSeconds'),
          metric('ConflictedMemoryCount'),
          metric('BackfillQuarantineCount'),
          metric('BackfillDriftCount'),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Authorization and persistence denials',
        left: [
          metric('SelfReviewDenials', 'Sum'),
          metric('EthicalWallDenials', 'Sum'),
          metric('ContextPacketPersistenceFailures', 'Sum'),
          metric('PolicyDriftInvalidations', 'Sum'),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Assurance release posture',
        left: [
          metric('AssuranceHeldOutcomes', 'Sum'),
          metric('AssuranceDegradedOutcomes', 'Sum'),
          metric('UnsupportedHighRiskClaimRate', 'Average'),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Projection outbox recovery',
        left: [
          metric('OutboxOldestAgeSeconds'),
          metric('OutboxRetryingCount'),
          metric('OutboxDeadLetterCount'),
          metric('ControlMonitorFailures', 'Sum'),
        ],
      }),
    );

    new cdk.CfnOutput(this, 'ControlMonitorScheduleName', {
      value: this.schedule.ruleName,
      description: `MeriV2 control monitor schedule (enabled=${props.monitorEnabled})`,
    });
    new cdk.CfnOutput(this, 'ControlMonitorImageDigest', {
      value: props.apiImageDigest,
      description: 'Immutable API image digest bound to the control monitor task definition',
    });
  }
}

function kebab(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-z0-9-]+/gi, '-')
    .toLowerCase();
}
