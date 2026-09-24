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
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface ScheduledDefenseBudgetLifecycleCoordinatorProps {
  envName: string;
  cluster: ecs.ICluster;
  defenseApiRepo: ecr.IRepository;
  defenseApiImageDigest: string;
  releaseSha: string;
  subnets: ec2.ISubnet[];
  securityGroup: ec2.ISecurityGroup;
  dbSecret: secretsmanager.ISecret;
  defenseJobSecret: secretsmanager.ISecret;
  databaseName: string;
  secretsKeyArn: string;
  protectFromDestroy: boolean;
  scheduleEnabled: boolean;
  alertsTopic: sns.ITopic;
  discoveryRequestBudget?: number;
  watcherLeaseSeconds?: number;
}

/**
 * Package 1's single operational owner for annual lifecycle discovery.
 *
 * One short-lived task is offered each hour. Persisted per-adapter due times
 * decide which crawlers actually run; leases and content hashes fence duplicate
 * deliveries. The target has no EventBridge retry because the next hourly tick
 * is the bounded catch-up path and replaying RunTask can create an avoidable
 * overlap. Failed target deliveries remain visible in the encrypted DLQ.
 */
export class ScheduledDefenseBudgetLifecycleCoordinator extends Construct {
  readonly taskDefinition: ecs.FargateTaskDefinition;
  readonly rule: events.Rule;
  readonly deadLetterQueue: sqs.Queue;

  constructor(
    scope: Construct,
    id: string,
    props: ScheduledDefenseBudgetLifecycleCoordinatorProps,
  ) {
    super(scope, id);
    if (props.subnets.length === 0) {
      throw new Error('The defense-budget lifecycle coordinator requires a private subnet.');
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(props.defenseApiImageDigest)) {
      throw new Error('The lifecycle coordinator requires an immutable ECR image digest.');
    }
    if (!/^[0-9a-f]{40}$/.test(props.releaseSha)) {
      throw new Error('The lifecycle coordinator requires an exact lowercase release SHA.');
    }
    const requestBudget = props.discoveryRequestBudget ?? 25;
    if (!Number.isInteger(requestBudget) || requestBudget < 1 || requestBudget > 250) {
      throw new Error('discoveryRequestBudget must be an integer from 1 through 250.');
    }
    const leaseSeconds = props.watcherLeaseSeconds ?? 4_500;
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 3_600 || leaseSeconds > 21_600) {
      throw new Error('watcherLeaseSeconds must be an integer from 3600 through 21600.');
    }

    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/capiro/${props.envName}/defense-budget-lifecycle-coordinator`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: props.protectFromDestroy
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description:
        'Defense-budget lifecycle coordinator; database and public-source discovery only',
    });
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family: `capiro-${props.envName}-defense-budget-lifecycle-coordinator`,
      cpu: 1024,
      memoryLimitMiB: 2048,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskRole,
    });

    const executionRole = this.taskDefinition.obtainExecutionRole();
    executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [props.dbSecret.secretArn, props.defenseJobSecret.secretArn],
      }),
    );
    executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:DescribeKey'],
        resources: [props.secretsKeyArn],
      }),
    );

    this.taskDefinition.addContainer('lifecycle-coordinator', {
      image: ecs.ContainerImage.fromEcrRepository(
        props.defenseApiRepo,
        props.defenseApiImageDigest,
      ),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'schedule' }),
      command: ['schedule-tick', '--commit'],
      environment: {
        NODE_ENV: props.envName === 'dev' ? 'development' : 'production',
        APP_ENV: `capiro-${props.envName}`,
        AWS_REGION: cdk.Stack.of(this).region,
        AWS_DEFAULT_REGION: cdk.Stack.of(this).region,
        DB_NAME: props.databaseName,
        DEFENSE_JOB_DB_ROLE: 'capiro_defense_job',
        PHASE8_SESSION10_TICK_AUTHORIZED: 'true',
        PHASE8_SESSION8_LIVE_DISCOVERY: 'true',
        DEFENSE_BUDGET_DISCOVERY_REQUEST_BUDGET: String(requestBudget),
        DEFENSE_BUDGET_WATCHER_LEASE_SECONDS: String(leaseSeconds),
        NVIDIA_ROUTING_MODE: 'disabled',
        ACTIVE_GPU_CAPACITY: '0',
        GIT_SHA: props.releaseSha,
        RELEASE_SHA: props.releaseSha,
      },
      secrets: {
        DB_HOST: ecs.Secret.fromSecretsManager(props.dbSecret, 'host'),
        DB_PORT: ecs.Secret.fromSecretsManager(props.dbSecret, 'port'),
        DB_USER: ecs.Secret.fromSecretsManager(props.defenseJobSecret, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(props.defenseJobSecret, 'password'),
      },
      readonlyRootFilesystem: false,
    });

    this.deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      queueName: `capiro-${props.envName}-defense-budget-lifecycle-coordinator-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.rule = new events.Rule(this, 'Schedule', {
      ruleName: `capiro-${props.envName}-defense-budget-lifecycle-coordinator`,
      description:
        'Package 1 single owner: run one bounded annual lifecycle coordinator tick hourly.',
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      enabled: props.scheduleEnabled,
    });
    this.rule.addTarget(
      new eventsTargets.EcsTask({
        cluster: props.cluster,
        taskDefinition: this.taskDefinition,
        taskCount: 1,
        subnetSelection: { subnets: props.subnets },
        securityGroups: [props.securityGroup],
        retryAttempts: 0,
        maxEventAge: cdk.Duration.minutes(30),
        deadLetterQueue: this.deadLetterQueue,
      }),
    );

    const action = new cwActions.SnsAction(props.alertsTopic);
    const taskFailureMetric = new logs.MetricFilter(this, 'TaskFailureMetric', {
      logGroup,
      metricNamespace: 'Capiro/DefenseBudget',
      metricName: 'lifecycle_coordinator.failed',
      filterPattern: logs.FilterPattern.literal('"PHASE9_SCHEDULE_TICK_FAILED"'),
      metricValue: '1',
      defaultValue: 0,
    }).metric({ statistic: 'Sum', period: cdk.Duration.hours(1) });
    const taskFailureAlarm = new cloudwatch.Alarm(this, 'TaskFailureAlarm', {
      alarmName: `capiro-${props.envName}-defense-budget-lifecycle-coordinator-failed`,
      alarmDescription: 'A defense-budget lifecycle coordinator tick failed.',
      metric: taskFailureMetric,
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    taskFailureAlarm.addAlarmAction(action);
    taskFailureAlarm.addOkAction(action);

    const deliveryFailureAlarm = new cloudwatch.Alarm(this, 'DeliveryFailureAlarm', {
      alarmName: `capiro-${props.envName}-defense-budget-lifecycle-delivery-failed`,
      alarmDescription: 'EventBridge could not deliver a lifecycle coordinator task.',
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    deliveryFailureAlarm.addAlarmAction(action);
    deliveryFailureAlarm.addOkAction(action);
  }
}
