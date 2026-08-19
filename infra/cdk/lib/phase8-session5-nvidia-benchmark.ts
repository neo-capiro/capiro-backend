import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  aws_cloudwatch as cloudwatch,
  aws_iam as iam,
  aws_kms as kms,
  aws_s3 as s3,
  aws_sagemaker as sagemaker,
  aws_sqs as sqs,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

export interface Phase8Session5NvidiaBenchmarkProps {
  /** Pinned, approved AWS Marketplace model-package ARN. */
  readonly modelPackageArn: string;
  /** Hard application budget mirrored by the coordinator. */
  readonly monthlyGpuBudgetUsd: number;
  /** Optional explicit instance type; one instance per transform job. */
  readonly instanceType?: string;
}

/**
 * Dark, benchmark-only NVIDIA parser plane.
 *
 * This construct deliberately creates no SageMaker Endpoint or EndpointConfig.
 * Batch Transform capacity exists only for the duration of a transform job.
 * The public defense-api task role is never referenced or granted permissions.
 */
export class Phase8Session5NvidiaBenchmark extends Construct {
  readonly artifactBucket: s3.Bucket;
  readonly escalationQueue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly transformRole: iam.Role;
  readonly orchestratorRole: iam.Role;
  readonly model: sagemaker.CfnModel;

  constructor(
    scope: Construct,
    id: string,
    props: Phase8Session5NvidiaBenchmarkProps,
  ) {
    super(scope, id);

    if (!props.modelPackageArn.trim()) {
      throw new Error('modelPackageArn is required and must be version-pinned');
    }
    if (!Number.isFinite(props.monthlyGpuBudgetUsd) || props.monthlyGpuBudgetUsd <= 0) {
      throw new Error('monthlyGpuBudgetUsd must be a positive hard application limit');
    }

    const key = new kms.Key(this, 'ArtifactKey', {
      alias: 'alias/capiro-phase8-session5-nvidia-benchmark',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
      description: 'Session 5 immutable NVIDIA benchmark manifests and artifacts',
    });

    this.artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [
        {
          id: 'abort-incomplete-uploads',
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
        {
          id: 'retain-versioned-benchmark-evidence',
          noncurrentVersionTransitions: [
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: Duration.days(30),
            },
          ],
        },
      ],
    });

    this.deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      fifo: true,
      contentBasedDeduplication: true,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: key,
      retentionPeriod: Duration.days(14),
      visibilityTimeout: Duration.minutes(5),
    });

    this.escalationQueue = new sqs.Queue(this, 'EscalationQueue', {
      fifo: true,
      contentBasedDeduplication: true,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: key,
      retentionPeriod: Duration.days(14),
      visibilityTimeout: Duration.hours(12),
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 3,
      },
    });

    this.transformRole = new iam.Role(this, 'BatchTransformRole', {
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      description: 'Session 5 SageMaker Batch Transform role; S3 only, no database access',
      maxSessionDuration: Duration.hours(1),
    });
    this.artifactBucket.grantReadWrite(this.transformRole, 'phase8/nvidia/*');
    key.grantEncryptDecrypt(this.transformRole);

    this.model = new sagemaker.CfnModel(this, 'NemotronParseModel', {
      executionRoleArn: this.transformRole.roleArn,
      // AWS Marketplace model packages require network isolation. The Batch
      // Transform role still has only the isolated evidence-prefix access.
      enableNetworkIsolation: true,
      primaryContainer: {
        modelPackageName: props.modelPackageArn,
      },
      tags: [
        { key: 'CapiroPhase', value: 'phase8-session5' },
        { key: 'CapiroExecutionModel', value: 'batch-transform-zero-idle' },
        { key: 'CapiroPublicTraffic', value: 'false' },
      ],
    });

    this.orchestratorRole = new iam.Role(this, 'ParserOrchestratorRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description:
        'Non-HTTP Session 5 parser orchestrator; may create Batch Transform jobs but no endpoints',
      maxSessionDuration: Duration.hours(1),
    });
    this.artifactBucket.grantReadWrite(this.orchestratorRole, 'phase8/nvidia/*');
    this.escalationQueue.grantConsumeMessages(this.orchestratorRole);
    this.deadLetterQueue.grantSendMessages(this.orchestratorRole);
    key.grantEncryptDecrypt(this.orchestratorRole);

    this.orchestratorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BatchTransformOnly',
        effect: iam.Effect.ALLOW,
        actions: [
          'sagemaker:CreateTransformJob',
          'sagemaker:DescribeTransformJob',
          'sagemaker:ListTransformJobs',
          'sagemaker:StopTransformJob',
          'sagemaker:ListEndpoints',
        ],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'aws:RequestedRegion': Stack.of(this).region,
          },
        },
      }),
    );
    this.orchestratorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassOnlyBenchmarkTransformRole',
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [this.transformRole.roleArn],
        conditions: {
          StringEquals: {
            'iam:PassedToService': 'sagemaker.amazonaws.com',
          },
        },
      }),
    );
    this.orchestratorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PublishParserMetrics',
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'cloudwatch:namespace': 'Capiro/DefenseParser',
          },
        },
      }),
    );

    new cloudwatch.Alarm(this, 'DlqAlarm', {
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      alarmDescription: 'Any NVIDIA parser page in the DLQ requires governed review',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'QueueAgeAlarm', {
      metric: this.escalationQueue.metricApproximateAgeOfOldestMessage({
        period: Duration.minutes(5),
      }),
      threshold: Duration.hours(2).toSeconds(),
      evaluationPeriods: 2,
      alarmDescription: 'NVIDIA benchmark escalation queue is not draining',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'ActiveJobsAboveConfiguredLimit', {
      metric: new cloudwatch.Metric({
        namespace: 'Capiro/DefenseParser',
        metricName: 'NvidiaActiveGpuJobs',
        statistic: 'Maximum',
        period: Duration.minutes(1),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      alarmDescription: 'Session 5 allows at most one concurrent GPU job',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'ApplicationSpendStop', {
      metric: new cloudwatch.Metric({
        namespace: 'Capiro/DefenseParser',
        metricName: 'NvidiaMonthlySpendUsd',
        statistic: 'Maximum',
        period: Duration.hours(1),
      }),
      threshold: props.monthlyGpuBudgetUsd,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      alarmDescription:
        'Hard Session 5 application spend stop; coordinator must refuse new submissions',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new CfnOutput(this, 'ArtifactBucketName', {
      value: this.artifactBucket.bucketName,
    });
    new CfnOutput(this, 'EscalationQueueUrl', {
      value: this.escalationQueue.queueUrl,
    });
    new CfnOutput(this, 'DeadLetterQueueUrl', {
      value: this.deadLetterQueue.queueUrl,
    });
    new CfnOutput(this, 'SageMakerModelName', {
      value: this.model.attrModelName,
    });
    new CfnOutput(this, 'OrchestratorRoleArn', {
      value: this.orchestratorRole.roleArn,
    });
    new CfnOutput(this, 'PersistentEndpointCount', {
      value: '0',
      description: 'This construct creates no endpoint or endpoint configuration',
    });
  }
}
