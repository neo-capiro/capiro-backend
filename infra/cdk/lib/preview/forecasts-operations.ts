import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { FIRST_CHAT_CORE_LIVE } from './first-chat-core';

/**
 * Government forecasts on the preview clone: the production-ready path for
 * `refresh-government-forecasts` (daily) and the one-off `sync-government-forecasts`
 * apply, as the scripts themselves require (apps/api/scripts/government-forecasts-refresh.txt):
 *
 *   - one durable archive root shared by every execution (EFS access point,
 *     never /tmp, retention RETAIN), where the exclusive producer marker lives;
 *   - DATABASE_URL supplied whole from one Secrets Manager secret bound to the
 *     least-privilege importer role (migration 20281102110000), never DB_*;
 *   - one daily EventBridge occurrence, retry policy 0 (duplicates refuse and
 *     unknown outcomes need reconciliation, not another fetch), created DISABLED
 *     and enabled only by a re-render after the first successful run;
 *   - S3 custody for the pinned edition XML the one-off pin check is judged against;
 *   - alarms on the scripts' own failure lines and on undelivered occurrences.
 *
 * Clone only: identities come from the preview Core inventory (first-chat-core.ts).
 * This composition creates no ECS service, listener rule, DNS record or Aurora resource.
 */
export const FORECASTS_OPERATIONS_STACK_NAME = 'Capiro-Preview-Government-Forecasts';
export const FORECASTS_ARCHIVE_DIR = '/var/lib/capiro/forecast-archive';
export const FORECASTS_CONTAINER_NAME = 'government-forecasts';
export const FORECASTS_IMPORTER_SECRET_NAME = '/capiro/preview/government-forecasts/importer-database-url';
/** The scripts' own terminal failure lines (sync-government-forecasts.ts, refresh-government-forecasts.ts). */
export const FORECASTS_FAILURE_TERMS = ['Forecast import failed', 'Forecast refresh failed'] as const;
const imageRepoName = 'capiro/preview-core';
const env = { account: '967807252336', region: 'us-east-1' };

export interface ForecastsOperationsBinding {
  schemaVersion: 1;
  /** Exact Core source head the image was built from. */
  sourceHead: string;
  /** Immutable preview-core image digest; never a tag. */
  imageDigest: string;
  /** False until the first successful run is verified; enabling is a re-render, so a later deploy cannot disable it by accident. */
  scheduleEnabled: boolean;
  /** UTC hour and minute of the single daily occurrence. */
  schedule: { hour: number; minute: number };
}

function exactKeys(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: object required`);
  const record = value as Record<string, unknown>;
  const present = Object.keys(record).sort();
  if (present.join(',') !== [...keys].sort().join(',')) throw new Error(`${label}: exactly ${keys.join(', ')} required`);
  return record;
}

/** Validates the operator binding; no AWS call. */
export function forecastsOperationsBinding(input: unknown): ForecastsOperationsBinding {
  const record = exactKeys(input, ['schemaVersion', 'sourceHead', 'imageDigest', 'scheduleEnabled', 'schedule'], 'Forecasts binding');
  if (record.schemaVersion !== 1) throw new Error('Forecasts binding: schemaVersion 1 required');
  if (typeof record.sourceHead !== 'string' || !/^[0-9a-f]{40}$/.test(record.sourceHead)) throw new Error('Forecasts binding: exact lowercase source head required');
  if (typeof record.imageDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(record.imageDigest)) throw new Error('Forecasts binding: immutable image digest required');
  if (typeof record.scheduleEnabled !== 'boolean') throw new Error('Forecasts binding: scheduleEnabled boolean required');
  const schedule = exactKeys(record.schedule, ['hour', 'minute'], 'Forecasts binding schedule');
  const hour = schedule.hour, minute = schedule.minute;
  if (!Number.isInteger(hour) || (hour as number) < 0 || (hour as number) > 23 || !Number.isInteger(minute) || (minute as number) < 0 || (minute as number) > 59)
    throw new Error('Forecasts binding: schedule hour 0-23 and minute 0-59 required');
  return {
    schemaVersion: 1,
    sourceHead: record.sourceHead,
    imageDigest: record.imageDigest,
    scheduleEnabled: record.scheduleEnabled,
    schedule: { hour: hour as number, minute: minute as number },
  };
}

export class ForecastsOperationsStack extends cdk.Stack {
  readonly taskDefinition: ecs.FargateTaskDefinition;
  readonly rule: events.Rule;
  readonly archive: efs.FileSystem;
  readonly archiveAccessPoint: efs.AccessPoint;
  readonly stagingBucket: s3.Bucket;
  readonly importerSecret: secretsmanager.Secret;
  readonly alertsTopic: sns.Topic;

  constructor(scope: Construct, id: string, binding: ForecastsOperationsBinding) {
    super(scope, id, { env, terminationProtection: true });
    const live = FIRST_CHAT_CORE_LIVE;
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId: live.vpcId,
      availabilityZones: [...live.availabilityZones],
      privateSubnetIds: [...live.privateSubnetIds],
    });
    const subnets = live.privateSubnetIds.map((subnetId, index) =>
      ec2.Subnet.fromSubnetAttributes(this, `Subnet${index}`, { subnetId, availabilityZone: live.availabilityZones[index] }),
    );
    const cluster = ecs.Cluster.fromClusterAttributes(this, 'Cluster', {
      clusterName: 'capiro-dev',
      clusterArn: live.clusterArn,
      vpc,
    });
    const taskSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(this, 'TaskSecurityGroup', live.apiSecurityGroupId, { mutable: false });
    const repo = ecr.Repository.fromRepositoryName(this, 'ImageRepository', imageRepoName);

    // The one durable archive root: the exclusive marker, per-run receipts and source bytes live here.
    const archiveSecurityGroup = new ec2.SecurityGroup(this, 'ArchiveSecurityGroup', {
      vpc,
      description: 'Government forecasts archive (EFS); NFS from the forecasts task only',
      allowAllOutbound: false,
    });
    archiveSecurityGroup.addIngressRule(taskSecurityGroup, ec2.Port.tcp(2049), 'NFS from the forecasts task');
    this.archive = new efs.FileSystem(this, 'Archive', {
      vpc,
      vpcSubnets: { subnets },
      securityGroup: archiveSecurityGroup,
      encrypted: true,
      enableAutomaticBackups: true,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      outOfInfrequentAccessPolicy: efs.OutOfInfrequentAccessPolicy.AFTER_1_ACCESS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.ELASTIC,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      fileSystemPolicy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ['*'],
            resources: ['*'],
            conditions: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ],
      }),
    });
    // The API image runs as uid 1001 (apps/api/Dockerfile); the access point pins ownership so the marker is writable by the job only.
    this.archiveAccessPoint = this.archive.addAccessPoint('ArchiveRoot', {
      path: '/forecast-archive',
      createAcl: { ownerUid: '1001', ownerGid: '1001', permissions: '750' },
      posixUser: { uid: '1001', gid: '1001' },
    });

    // Custody for the pinned edition XML (FORECASTS-OPERATIONS-BRIEF.md): Release uploads it, the pin check compares against it.
    // The task never reads it: the image dispatches only its own verbs, and refresh-government-forecasts fetches the publisher itself.
    this.stagingBucket = new s3.Bucket(this, 'Staging', {
      bucketName: `capiro-preview-government-forecasts-staging-${env.account}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ noncurrentVersionExpiration: cdk.Duration.days(365), abortIncompleteMultipartUploadAfter: cdk.Duration.days(7) }],
    });

    // DATABASE_URL whole, as the scripts require; the value is set once by Release, never rendered here.
    this.importerSecret = new secretsmanager.Secret(this, 'ImporterDatabaseUrl', {
      secretName: FORECASTS_IMPORTER_SECRET_NAME,
      description: 'postgresql URL for capiro_forecast_importer on the preview clone (sslmode=require); set by Release, never the master user',
      secretStringValue: cdk.SecretValue.unsafePlainText('placeholder-set-by-release'),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: '/capiro/preview/government-forecasts',
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Government forecasts job: archive write and public source fetch; no other AWS access',
    });
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family: 'capiro-preview-government-forecasts',
      cpu: 1024,
      memoryLimitMiB: 2048,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
      taskRole,
      volumes: [
        {
          name: 'forecast-archive',
          efsVolumeConfiguration: {
            fileSystemId: this.archive.fileSystemId,
            transitEncryption: 'ENABLED',
            authorizationConfig: { accessPointId: this.archiveAccessPoint.accessPointId, iam: 'ENABLED' },
          },
        },
      ],
    });
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite'],
        resources: [this.archive.fileSystemArn],
        conditions: { StringEquals: { 'elasticfilesystem:AccessPointArn': this.archiveAccessPoint.accessPointArn } },
      }),
    );

    const container = this.taskDefinition.addContainer(FORECASTS_CONTAINER_NAME, {
      image: ecs.ContainerImage.fromEcrRepository(repo, binding.imageDigest),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'forecasts' }),
      // A run-task without an override does nothing: every real invocation names its command (schedule below; one-off in the brief).
      command: ['refresh-government-forecasts', '--help'],
      environment: {
        NODE_ENV: 'production',
        APP_ENV: 'capiro-preview',
        AWS_REGION: env.region,
        AWS_DEFAULT_REGION: env.region,
        FORECAST_ARCHIVE_DIR: FORECASTS_ARCHIVE_DIR,
        GIT_SHA: binding.sourceHead,
        RELEASE_SHA: binding.sourceHead,
      },
      secrets: { DATABASE_URL: ecs.Secret.fromSecretsManager(this.importerSecret) },
      readonlyRootFilesystem: false,
    });
    container.addMountPoints({ containerPath: FORECASTS_ARCHIVE_DIR, sourceVolume: 'forecast-archive', readOnly: false });

    const deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      queueName: 'capiro-preview-government-forecasts-dlq',
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });
    this.rule = new events.Rule(this, 'Daily', {
      ruleName: 'capiro-preview-government-forecasts-daily',
      description: 'One daily government-forecast refresh occurrence (retry 0; the next day is the catch-up path).',
      schedule: events.Schedule.cron({ minute: String(binding.schedule.minute), hour: String(binding.schedule.hour), day: '*', month: '*', year: '*' }),
      enabled: binding.scheduleEnabled,
    });
    this.rule.addTarget(
      new eventsTargets.EcsTask({
        cluster,
        taskDefinition: this.taskDefinition,
        taskCount: 1,
        subnetSelection: { subnets },
        securityGroups: [taskSecurityGroup],
        retryAttempts: 0,
        maxEventAge: cdk.Duration.minutes(30),
        deadLetterQueue,
        // The EventBridge event id is the stable per-occurrence run id (the script requires [A-Za-z0-9][A-Za-z0-9_-]{0,79}).
        containerOverrides: [
          {
            containerName: FORECASTS_CONTAINER_NAME,
            command: ['refresh-government-forecasts', '--archive-dir', FORECASTS_ARCHIVE_DIR, '--run-id', events.EventField.fromPath('$.id'), '--apply'],
          },
        ],
      }),
    );

    this.alertsTopic = new sns.Topic(this, 'Alerts', { topicName: 'capiro-preview-government-forecasts-alerts' });
    const action = new cwActions.SnsAction(this.alertsTopic);
    const failures = new logs.MetricFilter(this, 'FailureMetric', {
      logGroup,
      metricNamespace: 'Capiro/GovernmentForecasts',
      metricName: 'task.failed',
      filterPattern: logs.FilterPattern.anyTerm(...FORECASTS_FAILURE_TERMS),
      metricValue: '1',
      defaultValue: 0,
    }).metric({ statistic: 'Sum', period: cdk.Duration.hours(1) });
    const failureAlarm = new cloudwatch.Alarm(this, 'FailureAlarm', {
      alarmName: 'capiro-preview-government-forecasts-failed',
      alarmDescription: 'A government-forecast refresh or import run ended in failure; inspect the retained receipts and the active marker before any new run.',
      metric: failures,
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    failureAlarm.addAlarmAction(action);
    failureAlarm.addOkAction(action);
    const deliveryAlarm = new cloudwatch.Alarm(this, 'DeliveryAlarm', {
      alarmName: 'capiro-preview-government-forecasts-delivery-failed',
      alarmDescription: 'EventBridge could not start the daily government-forecast task.',
      metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5), statistic: 'Maximum' }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    deliveryAlarm.addAlarmAction(action);
    deliveryAlarm.addOkAction(action);

    for (const [name, value] of Object.entries({
      TaskDefinitionArn: this.taskDefinition.taskDefinitionArn,
      ArchiveFileSystemId: this.archive.fileSystemId,
      ArchiveAccessPointId: this.archiveAccessPoint.accessPointId,
      StagingBucketName: this.stagingBucket.bucketName,
      ImporterSecretArn: this.importerSecret.secretArn,
      DailyRuleName: this.rule.ruleName,
      AlertsTopicArn: this.alertsTopic.topicArn,
      LogGroupName: logGroup.logGroupName,
    }))
      new cdk.CfnOutput(this, name, { value });
  }
}

/** Renders the single additive stack from a binding. No AWS call. */
export function previewForecastsOperationsApplication(input: unknown, outdir: string) {
  const binding = forecastsOperationsBinding(input);
  const app = new cdk.App({ outdir });
  const stack = new ForecastsOperationsStack(app, FORECASTS_OPERATIONS_STACK_NAME, binding);
  return { app, stack, binding };
}
