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

export interface ScheduledMemoryProjectionWorkerProps {
  envName: string;
  cluster: ecs.ICluster;
  apiRepo: ecr.IRepository;
  /** Immutable `sha256:...` digest resolved from the exact release-SHA tag. */
  apiImageDigest: string;
  subnets: ec2.ISubnet[];
  securityGroup: ec2.ISecurityGroup;
  dbSecret: secretsmanager.ISecret;
  appDbSecret: secretsmanager.ISecret;
  databaseName: string;
  dataKeyArn: string;
  secretsKeyArn: string;
  region: string;
  account: string;
  protectFromDestroy: boolean;
  /** Dark by default; enabled only after one manual drain succeeds on the migrated schema. */
  scheduleEnabled: boolean;
  /** Existing encrypted operational alert topic. */
  alertsTopic: sns.ITopic;
}

/**
 * Phase 5 durable projection/index worker.
 *
 * The task receives only the app DB credential and Titan embedding permission.
 * EventBridge starts one short-lived task every five minutes only after an
 * explicit release context enables it; database leases make overlapping
 * invocations safe. Workload failures are emitted as bounded JSON and alarmed
 * through the existing encrypted operational alert topic.
 */
export class ScheduledMemoryProjectionWorker extends Construct {
  readonly taskDefinition: ecs.FargateTaskDefinition;
  readonly rule: events.Rule;

  constructor(scope: Construct, id: string, props: ScheduledMemoryProjectionWorkerProps) {
    super(scope, id);
    if (props.subnets.length === 0) {
      throw new Error('The governed-memory projection worker requires at least one private subnet.');
    }
    if (!/^sha256:[0-9a-f]{64}$/i.test(props.apiImageDigest)) {
      throw new Error('The governed-memory projection worker requires an immutable ECR digest.');
    }

    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/capiro/${props.envName}/memory-projection-worker`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: props.protectFromDestroy
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Strict governed-memory projection worker; Titan embeddings only',
    });
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${props.region}::foundation-model/amazon.titan-embed-text-v2:0`,
        ],
      }),
    );

    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family: `capiro-${props.envName}-memory-projection-worker`,
      cpu: 512,
      memoryLimitMiB: 1024,
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
        resources: [props.dbSecret.secretArn, props.appDbSecret.secretArn],
      }),
    );
    executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:DescribeKey'],
        resources: [props.dataKeyArn, props.secretsKeyArn],
      }),
    );

    this.taskDefinition.addContainer('memory-projection-worker', {
      image: ecs.ContainerImage.fromEcrRepository(props.apiRepo, props.apiImageDigest),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'worker',
      }),
      command: ['drain-memory-cleanup-outbox', '200', '300'],
      environment: {
        NODE_ENV: props.envName === 'dev' ? 'development' : 'production',
        LOG_LEVEL: 'info',
        DB_NAME: props.databaseName,
        AWS_REGION_DEFAULT: props.region,
      },
      secrets: {
        DB_HOST: ecs.Secret.fromSecretsManager(props.dbSecret, 'host'),
        DB_PORT: ecs.Secret.fromSecretsManager(props.dbSecret, 'port'),
        DB_USER: ecs.Secret.fromSecretsManager(props.appDbSecret, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(props.appDbSecret, 'password'),
      },
      readonlyRootFilesystem: false,
    });

    this.rule = new events.Rule(this, 'Schedule', {
      ruleName: `capiro-${props.envName}-memory-projection-worker`,
      description: 'Drain governed-memory projection/index obligations every five minutes.',
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      enabled: props.scheduleEnabled,
    });
    this.rule.addTarget(
      new eventsTargets.EcsTask({
        cluster: props.cluster,
        taskDefinition: this.taskDefinition,
        taskCount: 1,
        subnetSelection: { subnets: props.subnets },
        securityGroups: [props.securityGroup],
        retryAttempts: 2,
        maxEventAge: cdk.Duration.minutes(30),
      }),
    );

    const failedMetric = new logs.MetricFilter(this, 'FailedMetric', {
      logGroup,
      metricNamespace: 'Capiro/Memory',
      metricName: 'projection_worker.failed',
      filterPattern: logs.FilterPattern.literal(
        '{ $.event = "memory_projection_worker.drain" && $.failed = * }',
      ),
      metricValue: '$.failed',
      defaultValue: 0,
    }).metric({ statistic: 'Sum', period: cdk.Duration.minutes(5) });

    const deadLetterMetric = new logs.MetricFilter(this, 'DeadLetterMetric', {
      logGroup,
      metricNamespace: 'Capiro/Memory',
      metricName: 'projection_worker.dead_lettered',
      filterPattern: logs.FilterPattern.literal(
        '{ $.event = "memory_projection_worker.drain" && $.deadLettered = * }',
      ),
      metricValue: '$.deadLettered',
      defaultValue: 0,
    }).metric({ statistic: 'Sum', period: cdk.Duration.minutes(5) });

    const crashMetric = new logs.MetricFilter(this, 'CrashMetric', {
      logGroup,
      metricNamespace: 'Capiro/Memory',
      metricName: 'projection_worker.crashed',
      filterPattern: logs.FilterPattern.literal(
        '{ $.event = "memory_projection_worker.crashed" }',
      ),
      metricValue: '1',
      defaultValue: 0,
    }).metric({ statistic: 'Sum', period: cdk.Duration.minutes(5) });

    const action = new cwActions.SnsAction(props.alertsTopic);
    for (const [alarmId, metric, description] of [
      ['FailedAlarm', failedMetric, 'Governed-memory projection jobs are failing and retrying.'],
      ['DeadLetterAlarm', deadLetterMetric, 'Governed-memory projection jobs reached dead-letter.'],
      ['CrashAlarm', crashMetric, 'The governed-memory projection worker crashed.'],
    ] as const) {
      const alarm = new cloudwatch.Alarm(this, alarmId, {
        alarmName: `capiro-${props.envName}-${alarmId.replace(/Alarm$/, '').toLowerCase()}`,
        alarmDescription: description,
        metric,
        threshold: 1,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(action);
      alarm.addOkAction(action);
    }
  }
}
