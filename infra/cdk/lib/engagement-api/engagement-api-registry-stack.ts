import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

import { engagementApiNames, type EngagementApiInfraConfig } from './engagement-api-config';
import { applyEngagementApiTags } from './engagement-api-tags';

export interface EngagementApiRegistryStackProps extends cdk.StackProps {
  cfg: EngagementApiInfraConfig;
}

/**
 * Isolated immutable image registry for `engagement-api`.
 *
 * Deliberately its own stack so the registry can be created and can retain
 * images independently of the service that consumes them: the deployment order
 * is Registry → Network → preview rule → image push → Service, and rolling the
 * Service back must never risk the images it was built from.
 *
 * Creates exactly one resource type. It imports the ECR CMK by ARN and creates
 * no ECS, ALB, VPC, database, DNS, or listener resource — the template safety
 * verifier in micro-session 2.9 asserts that independently.
 */
export class EngagementApiRegistryStack extends cdk.Stack {
  public readonly repository: ecr.IRepository;

  constructor(scope: Construct, id: string, props: EngagementApiRegistryStackProps) {
    super(scope, id, props);
    const { cfg } = props;
    const names = engagementApiNames(cfg);

    applyEngagementApiTags(this, cfg);

    // Imported, never created: the CMK is owned by the existing data/security
    // stack. Creating one here would make `cdk destroy` on this stack able to
    // orphan images that are still pullable by digest.
    const encryptionKey = kms.Key.fromKeyArn(this, 'EcrKey', cfg.kmsKeyArns.ecr);

    const repository = new ecr.Repository(this, 'Repository', {
      repositoryName: names.repository,

      // Immutable tags are the whole point: deployment pins a digest, and a
      // mutable tag would let the bytes behind a reviewed release SHA change
      // after the review.
      imageTagMutability: ecr.TagMutability.IMMUTABLE,

      imageScanOnPush: true,
      encryption: ecr.RepositoryEncryption.KMS,
      encryptionKey,

      // Images outlive the stack. A destroy must never take the artifact that
      // a running task is pulling, nor the history a rollback needs.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      emptyOnDelete: false,
    });

    // Untagged layers are build garbage; tagged releases are rollback targets.
    repository.addLifecycleRule({
      rulePriority: 1,
      description: 'Expire untagged images after 7 days',
      tagStatus: ecr.TagStatus.UNTAGGED,
      maxImageAge: cdk.Duration.days(7),
    });
    repository.addLifecycleRule({
      rulePriority: 2,
      description: 'Retain the 30 most recent tagged release images',
      tagStatus: ecr.TagStatus.ANY,
      maxImageCount: 30,
    });

    this.repository = repository;

    new cdk.CfnOutput(this, 'RepositoryArn', {
      value: repository.repositoryArn,
      description: 'engagement-api ECR repository ARN',
    });
    new cdk.CfnOutput(this, 'RepositoryUri', {
      value: repository.repositoryUri,
      description: 'engagement-api ECR repository URI (push target)',
    });
    new cdk.CfnOutput(this, 'RepositoryName', {
      value: repository.repositoryName,
      description: 'engagement-api ECR repository name',
    });
  }
}
