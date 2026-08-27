import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { commonTags, type EnvConfig } from './config';
import { OneShotDefenseBudgetIngestionDrainWorker } from './constructs/one-shot-defense-budget-ingestion-drain-worker';

export interface DefenseBudgetOperationsStackProps extends cdk.StackProps {
  cfg: EnvConfig;
  /** Existing ECS cluster, imported for the manual `aws ecs run-task`
   * invocation's own reference only -- this stack creates no ECS service and
   * no EventBridge target against it. */
  clusterArn: string;
  vpcId: string;
  privateSubnetIds: string[];
  serviceSecurityGroupId: string;
  apiRepositoryName: string;
  /** Immutable `sha256:...` digest resolved from the exact release-SHA tag. */
  apiImageDigest: string;
  dbSecretArn: string;
  appDbSecretArn: string;
  databaseName: string;
  rawBucketName: string;
  /**
   * Name of an ALREADY-VERIFIED versioned+KMS-encrypted+block-public bucket to
   * reuse for extraction artifacts. Omit to have this stack create a dedicated
   * bucket instead -- never pass an unverified bucket name here. See
   * `defense-budget-extraction-artifact-bucket-audit.md` (PR #1318 body) for
   * the audit that found no existing bucket in this account satisfies the
   * requirement without a code change to the SSE-header-enforcing bucket
   * policy the raw archive bucket carries.
   */
  existingExtractionArtifactBucketName?: string;
  extractionArtifactPrefix?: string;
  dataKeyArn: string;
  secretsKeyArn: string;
}

/**
 * Phase 10B-4 defense-budget operations stack.
 *
 * Deliberately NOT added to the historical/frozen ComputeStack (`compute-
 * stack.ts`, deployed via `capiro.ts`). That stack backs the sole-live
 * capiro-dev environment (app.capiro.ai), and this repo's own established
 * doctrine (`meriv2-operations.ts` + `memory-projection-worker-stack.ts` +
 * `meriv2-control-stack.ts`) is that a new, finite, manually-invoked one-shot
 * worker gets its own additive operations stack rather than a change to that
 * frozen, already-drifted Compute stack -- adding a construct there would
 * force a `cdk diff`/deploy of the live production Compute stack merely to
 * ship an unrelated one-off worker. This stack imports every existing
 * runtime dependency (cluster, VPC, subnets, security group, DB secrets, KMS
 * keys, ECR repo, raw archive bucket) by literal ARN/id/context value and
 * creates NOTHING else live: no ALB rule, no Route 53 record, no Aurora
 * resource, no ECS service, no EventBridge rule/schedule. The only resources
 * this stack creates are the one-shot task definition + its IAM roles/log
 * group (via `OneShotDefenseBudgetIngestionDrainWorker`), and -- only when no
 * pre-verified bucket name is supplied -- a dedicated extraction-artifact S3
 * bucket. The cluster/VPC/subnets/security group are imported and exposed as
 * outputs purely so the operator's manual `aws ecs run-task` invocation can
 * read the exact network configuration from this stack instead of
 * hand-copying it from another source; this stack never wires them onto an
 * ECS service or EventBridge target.
 *
 * The worker is bound to the API image by an immutable ECR digest (never a
 * mutable tag) so this stack's task definition can never silently drift onto
 * a different build than the one that was reviewed.
 */
export class DefenseBudgetOperationsStack extends cdk.Stack {
  readonly worker: OneShotDefenseBudgetIngestionDrainWorker;
  readonly extractionArtifactBucketName: string;
  readonly createdExtractionArtifactBucket?: s3.Bucket;

  constructor(scope: Construct, id: string, props: DefenseBudgetOperationsStackProps) {
    super(scope, id, props);
    const { cfg } = props;
    for (const [key, value] of Object.entries(commonTags(cfg))) {
      cdk.Tags.of(this).add(key, value);
    }
    if (props.privateSubnetIds.length === 0) {
      throw new Error('DefenseBudgetOperationsStack requires at least one private subnet id.');
    }

    const apiRepo = ecr.Repository.fromRepositoryName(
      this,
      'ImportedApiRepository',
      props.apiRepositoryName,
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

    let extractionArtifactBucketName: string;
    if (props.existingExtractionArtifactBucketName) {
      // Caller attests this bucket was already independently verified
      // (versioned, KMS-encrypted, block-public-access). This stack does not
      // re-verify it at synth time -- CDK synth never calls AWS -- so the
      // caller (defense-budget-operations.ts) is the one place that decision
      // is made and must be justified in the PR body, never silently assumed.
      extractionArtifactBucketName = props.existingExtractionArtifactBucketName;
    } else {
      // No pre-verified bucket supplied: create a dedicated one here, reusing
      // the SAME CMK (and therefore the same "Defense Budget policy" SSE-KMS
      // discipline) the raw archive bucket already uses, rather than
      // inventing a second encryption key for a sibling artifact class.
      const encryptionKey = kms.Key.fromKeyArn(this, 'ImportedDataKey', props.dataKeyArn);
      const bucket = new s3.Bucket(this, 'ExtractionArtifactBucket', {
        bucketName: `capiro-${cfg.envName}-defense-budget-extraction-artifacts-${this.account}`,
        versioned: true,
        encryption: s3.BucketEncryption.KMS,
        encryptionKey,
        bucketKeyEnabled: true,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        autoDeleteObjects: false,
        lifecycleRules: [
          {
            id: 'AbortIncompleteUploads',
            abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
          },
          {
            // Content is content-addressed and write-once (IfNoneMatch:'*'),
            // so a second version at the same key should never occur in
            // practice; this bounds storage if it ever does.
            id: 'ExpireOldVersions',
            noncurrentVersionExpiration: cdk.Duration.days(365),
          },
        ],
      });
      this.createdExtractionArtifactBucket = bucket;
      extractionArtifactBucketName = bucket.bucketName;
    }
    this.extractionArtifactBucketName = extractionArtifactBucketName;

    this.worker = new OneShotDefenseBudgetIngestionDrainWorker(this, 'IngestionDrainWorker', {
      envName: cfg.envName,
      apiRepo,
      apiImageDigest: props.apiImageDigest,
      dbSecret,
      appDbSecret,
      databaseName: props.databaseName,
      rawBucketName: props.rawBucketName,
      extractionArtifactBucketName,
      extractionArtifactPrefix: props.extractionArtifactPrefix,
      dataKeyArn: props.dataKeyArn,
      secretsKeyArn: props.secretsKeyArn,
      protectFromDestroy: cfg.protectFromDestroy,
    });

    new cdk.CfnOutput(this, 'IngestionDrainWorkerImageDigest', {
      value: props.apiImageDigest,
      description: 'Immutable API image digest bound to the one-shot ingestion drain task definition',
    });
    new cdk.CfnOutput(this, 'IngestionDrainWorkerTaskDefinitionArn', {
      value: this.worker.taskDefinition.taskDefinitionArn,
      description: 'Run manually with aws ecs run-task; this stack creates no schedule or service.',
    });
    new cdk.CfnOutput(this, 'ExtractionArtifactBucketName', {
      value: extractionArtifactBucketName,
      description: this.createdExtractionArtifactBucket
        ? 'Dedicated extraction-artifact bucket created by this stack.'
        : 'Pre-verified existing bucket reused for extraction artifacts.',
    });
    // Manual run-task reference only -- never attached to an ECS service or
    // EventBridge target by this stack.
    new cdk.CfnOutput(this, 'ManualRunTaskClusterArn', { value: props.clusterArn });
    new cdk.CfnOutput(this, 'ManualRunTaskSubnetIds', { value: props.privateSubnetIds.join(',') });
    new cdk.CfnOutput(this, 'ManualRunTaskSecurityGroupId', { value: props.serviceSecurityGroupId });
    new cdk.CfnOutput(this, 'ManualRunTaskVpcId', { value: props.vpcId });
  }
}
