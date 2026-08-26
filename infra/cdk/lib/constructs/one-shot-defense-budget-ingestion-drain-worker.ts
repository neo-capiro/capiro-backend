import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface OneShotDefenseBudgetIngestionDrainWorkerProps {
  envName: string;
  apiRepo: ecr.IRepository;
  apiImageDigest: string;
  appDbSecret: secretsmanager.ISecret;
  rawBucketName: string;
  extractionArtifactBucketName: string;
  extractionArtifactPrefix?: string;
  dataKeyArn: string;
  secretsKeyArn: string;
  protectFromDestroy: boolean;
}

/** Manually invoked, finite Phase 10B ingestion drain task. It creates no schedule or service. */
export class OneShotDefenseBudgetIngestionDrainWorker extends Construct {
  readonly taskDefinition: ecs.FargateTaskDefinition;
  constructor(scope: Construct, id: string, props: OneShotDefenseBudgetIngestionDrainWorkerProps) {
    super(scope, id);
    if (!/^sha256:[0-9a-f]{64}$/i.test(props.apiImageDigest)) throw new Error('one-shot ingestion worker requires an immutable ECR digest');
    const prefix = (props.extractionArtifactPrefix ?? 'phase10/parser-artifacts').replace(/^\/+|\/+$/g, '');
    const taskRole = new iam.Role(this, 'TaskRole', { assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com') });
    taskRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject', 's3:PutObject'], resources: [`arn:${cdk.Aws.PARTITION}:s3:::${props.rawBucketName}/*`] }));
    taskRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject', 's3:PutObject'], resources: [`arn:${cdk.Aws.PARTITION}:s3:::${props.extractionArtifactBucketName}/${prefix}/*`] }));
    taskRole.addToPolicy(new iam.PolicyStatement({ actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey'], resources: [props.dataKeyArn] }));
    const logGroup = new logs.LogGroup(this, 'Logs', { retention: logs.RetentionDays.ONE_YEAR, removalPolicy: props.protectFromDestroy ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY });
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', { family: `capiro-${props.envName}-defense-budget-ingestion-drain`, cpu: 1024, memoryLimitMiB: 2048, taskRole });
    this.taskDefinition.obtainExecutionRole().addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'], resources: [props.appDbSecret.secretArn] }));
    this.taskDefinition.obtainExecutionRole().addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['kms:Decrypt', 'kms:DescribeKey'], resources: [props.secretsKeyArn] }));
    this.taskDefinition.addContainer('ingestion-drain', {
      image: ecs.ContainerImage.fromEcrRepository(props.apiRepo, props.apiImageDigest),
      command: ['drain-defense-budget-ingestion-outbox-v1'],
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'worker' }),
      environment: {
        NODE_ENV: props.envName === 'dev' ? 'development' : 'production',
        DEFENSE_BUDGET_RAW_BUCKET: props.rawBucketName,
        BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_BUCKET: props.extractionArtifactBucketName,
        BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_PREFIX: prefix,
        // Ephemeral per-task scratch only (Fargate ephemeral storage). Never
        // durable state -- the composed extraction artifact itself persists
        // through BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_BUCKET above; this
        // root only ever holds the parser runtime's transient working files
        // and this container's own local-parser-run cache, both of which are
        // safe to lose on restart.
        BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT: '/tmp/defense-budget-parser-scratch',
      },
      secrets: { DATABASE_URL: ecs.Secret.fromSecretsManager(props.appDbSecret, 'url') },
      readonlyRootFilesystem: false,
    });
    new cdk.CfnOutput(this, 'TaskDefinitionArn', { value: this.taskDefinition.taskDefinitionArn, description: 'Run manually with aws ecs run-task; this construct creates no schedule.' });
  }
}
