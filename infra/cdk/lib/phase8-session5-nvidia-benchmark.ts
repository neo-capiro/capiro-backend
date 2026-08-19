import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Aws,
  aws_cloudwatch as cloudwatch,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_kms as kms,
  aws_s3 as s3,
  aws_sagemaker as sagemaker,
  aws_sqs as sqs,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

export const SESSION5_REQUIRED_MODEL_PACKAGE_ARN =
  'arn:aws:sagemaker:us-east-1:865070037744:model-package/nvidia-nemotron-parse-6673990e627d314f8aceb69f5e816587';
export const SESSION5_ASYNC_EXECUTION_MODE = 'sagemaker_async_inference' as const;

export interface Phase8Session5NvidiaBenchmarkProps {
  readonly modelPackageArn: string;
  readonly monthlyGpuBudgetUsd: number;
  readonly initialBenchmarkCapUsd?: number;
  readonly instanceType?: string;
  readonly executionMode?: typeof SESSION5_ASYNC_EXECUTION_MODE;
}

/**
 * Dark, benchmark-only NVIDIA parser plane. No public route and no SageMaker
 * Endpoint/EndpointConfig are orchestrator-owned ephemeral resources. Async Inference is the only active paid GPU path.
 */
export class Phase8Session5NvidiaBenchmark extends Construct {
  readonly artifactBucket: s3.Bucket;
  readonly escalationQueue: sqs.Queue;
  readonly completionQueue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly reservationLedger: dynamodb.Table;
  readonly executionRole: iam.Role;
  readonly orchestratorRole: iam.Role;
  readonly model: sagemaker.CfnModel;

  constructor(
    scope: Construct,
    id: string,
    props: Phase8Session5NvidiaBenchmarkProps,
  ) {
    super(scope, id);

    const initialCap = props.initialBenchmarkCapUsd ?? 50;
    const executionMode = props.executionMode ?? SESSION5_ASYNC_EXECUTION_MODE;
    if (executionMode !== SESSION5_ASYNC_EXECUTION_MODE) {
      throw new Error('Session 5 active execution mode must be sagemaker_async_inference');
    }
    if (props.modelPackageArn !== SESSION5_REQUIRED_MODEL_PACKAGE_ARN) {
      throw new Error(
        'Session 5 requires the approved pinned NVIDIA Nemotron Parse model package ARN',
      );
    }
    if (
      !Number.isFinite(props.monthlyGpuBudgetUsd) ||
      props.monthlyGpuBudgetUsd <= 0 ||
      props.monthlyGpuBudgetUsd > 150
    ) {
      throw new Error(
        'monthlyGpuBudgetUsd must be positive and <= USD 150',
      );
    }
    if (
      !Number.isFinite(initialCap) ||
      initialCap <= 0 ||
      initialCap > 50 ||
      initialCap > props.monthlyGpuBudgetUsd
    ) {
      throw new Error(
        'initialBenchmarkCapUsd must be positive, <= USD 50, and <= monthlyGpuBudgetUsd',
      );
    }

    const key = new kms.Key(this, 'ArtifactKey', {
      alias: 'alias/capiro-phase8-session5-nvidia-benchmark',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
      description:
        'Session 5 immutable NVIDIA benchmark evidence and atomic spend ledger',
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

    // Separate completion/outbox queue. Artifact verification can succeed even if
    // downstream delivery is temporarily unavailable; reconciliation retries this
    // queue before a job can become RESUME_PUBLISHED.
    this.completionQueue = new sqs.Queue(this, 'CompletionQueue', {
      fifo: true,
      contentBasedDeduplication: true,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: key,
      retentionPeriod: Duration.days(14),
      visibilityTimeout: Duration.minutes(5),
    });

    // One strongly-consistent control row plus immutable reservation rows make
    // concurrency and spend reservation atomic across retries/workers.
    this.reservationLedger = new dynamodb.Table(this, 'ReservationLedger', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: key,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.executionRole = new iam.Role(this, 'AsyncInferenceExecutionRole', {
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      description:
        'Session 5 Async Inference model role; evidence-prefix S3 only, no database access',
      maxSessionDuration: Duration.hours(1),
    });
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject'],
        resources: [this.artifactBucket.arnForObjects('phase8/nvidia/*')],
      }),
    );
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [this.artifactBucket.bucketArn],
        conditions: { StringLike: { 's3:prefix': ['phase8/nvidia/*'] } },
      }),
    );
    key.grantEncryptDecrypt(this.executionRole);

    this.model = new sagemaker.CfnModel(this, 'NemotronParseModel', {
      executionRoleArn: this.executionRole.roleArn,
      enableNetworkIsolation: true,
      primaryContainer: { modelPackageName: props.modelPackageArn },
      tags: [
        { key: 'CapiroPhase', value: 'phase8-session5' },
        {
          key: 'CapiroExecutionModel',
          value: executionMode,
        },
        { key: 'CapiroPublicTraffic', value: 'false' },
      ],
    });

    this.orchestratorRole = new iam.Role(this, 'ParserOrchestratorRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description:
        'Non-HTTP Session 5 orchestrator; Async Inference only, ephemeral endpoint lifecycle',
      maxSessionDuration: Duration.hours(1),
    });
    this.orchestratorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          's3:GetObject',
          's3:GetObjectVersion',
          's3:PutObject',
        ],
        resources: [this.artifactBucket.arnForObjects('phase8/nvidia/*')],
      }),
    );
    this.orchestratorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [this.artifactBucket.bucketArn],
        conditions: { StringLike: { 's3:prefix': ['phase8/nvidia/*'] } },
      }),
    );
    this.escalationQueue.grantConsumeMessages(this.orchestratorRole);
    this.completionQueue.grantSendMessages(this.orchestratorRole);
    this.deadLetterQueue.grantSendMessages(this.orchestratorRole);
    this.orchestratorRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:TransactWriteItems'],
        resources: [this.reservationLedger.tableArn],
      }),
    );
    key.grantEncryptDecrypt(this.orchestratorRole);

    this.orchestratorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AsyncInferenceOnly',
        effect: iam.Effect.ALLOW,
        actions: [
          'sagemaker:CreateEndpointConfig',
          'sagemaker:DescribeEndpointConfig',
          'sagemaker:DeleteEndpointConfig',
          'sagemaker:CreateEndpoint',
          'sagemaker:DescribeEndpoint',
          'sagemaker:DeleteEndpoint',
          'sagemaker:InvokeEndpointAsync',
          'sagemaker:AddTags',
          'sagemaker:ListTags',
          'sagemaker:DescribeModel',
        ],
        resources: [
          `arn:${Aws.PARTITION}:sagemaker:${Aws.REGION}:${Aws.ACCOUNT_ID}:endpoint/capiro-s5-async-*`,
          `arn:${Aws.PARTITION}:sagemaker:${Aws.REGION}:${Aws.ACCOUNT_ID}:endpoint-config/capiro-s5-async-cfg-*`,
          `arn:${Aws.PARTITION}:sagemaker:${Aws.REGION}:${Aws.ACCOUNT_ID}:model/capiro-s5-*`,
        ],
        conditions: {
          StringEquals: {
            'aws:RequestedRegion': Stack.of(this).region,
          },
        },
      }),
    );
    // ListEndpoints does not support resource-level authorization; isolate this read-only action.
    this.orchestratorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ListOnlySession5Endpoints',
        effect: iam.Effect.ALLOW,
        actions: ['sagemaker:ListEndpoints'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'aws:RequestedRegion': Stack.of(this).region },
        },
      }),
    );
    this.orchestratorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassOnlyAsyncInferenceExecutionRole',
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [this.executionRole.roleArn],
        conditions: {
          StringEquals: {
            'iam:PassedToService': 'sagemaker.amazonaws.com',
          },
        },
      }),
    );
    this.orchestratorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AsyncEndpointAutoscalingOnly',
        effect: iam.Effect.ALLOW,
        actions: [
          'application-autoscaling:RegisterScalableTarget',
          'application-autoscaling:PutScalingPolicy',
          'application-autoscaling:DeregisterScalableTarget',
        ],
        resources: [
          `arn:${Aws.PARTITION}:application-autoscaling:${Aws.REGION}:${Aws.ACCOUNT_ID}:scalable-target/*`,
          `arn:${Aws.PARTITION}:application-autoscaling:${Aws.REGION}:${Aws.ACCOUNT_ID}:scalingPolicy/*`,
        ],
        conditions: {
          StringEquals: { 'aws:RequestedRegion': Stack.of(this).region },
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
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      alarmDescription: 'Session 5 allows exactly one concurrent GPU job',
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
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      alarmDescription: 'Session 5 hard incremental spend stop',
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new CfnOutput(this, 'ArtifactBucketName', {
      value: this.artifactBucket.bucketName,
    });
    new CfnOutput(this, 'EscalationQueueUrl', {
      value: this.escalationQueue.queueUrl,
    });
    new CfnOutput(this, 'CompletionQueueUrl', {
      value: this.completionQueue.queueUrl,
    });
    new CfnOutput(this, 'DeadLetterQueueUrl', {
      value: this.deadLetterQueue.queueUrl,
    });
    new CfnOutput(this, 'ReservationLedgerTableName', {
      value: this.reservationLedger.tableName,
    });
    new CfnOutput(this, 'SageMakerModelName', {
      value: this.model.attrModelName,
    });
    new CfnOutput(this, 'OrchestratorRoleArn', {
      value: this.orchestratorRole.roleArn,
    });
    new CfnOutput(this, 'InitialBenchmarkCapUsd', {
      value: String(initialCap),
    });
    new CfnOutput(this, 'HardIncrementalCapUsd', {
      value: String(props.monthlyGpuBudgetUsd),
    });
    new CfnOutput(this, 'PersistentEndpointCount', {
      value: '0',
      description:
        'Endpoints are orchestrator-owned ephemeral resources and must be deleted after the run',
    });
    new CfnOutput(this, 'ExecutionMode', { value: executionMode });
  }
}
