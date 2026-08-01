import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { commonTags, type EnvConfig } from './config';
import { ScheduledMemoryProjectionWorker } from './constructs/scheduled-memory-projection-worker';

export interface MemoryProjectionWorkerStackProps extends cdk.StackProps {
  cfg: EnvConfig;
  clusterArn: string;
  /** VPC that owns the imported private subnets (required by fromClusterAttributes). */
  vpcId: string;
  /** One AZ per privateSubnetIds entry, same order. */
  privateSubnetAvailabilityZones: string[];
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
  scheduleEnabled: boolean;
  alertsTopicArn: string;
}

/**
 * Separate stack for the scheduled governed-memory projector.
 *
 * Every existing runtime dependency is imported by a literal ARN/name/id. That
 * lets the operator deploy this stack from the dedicated MeriV2 operations CDK
 * app without updating the drifted/frozen Compute stack merely to add new
 * cross-stack exports. The stack creates no database, customer-data, or migration
 * resource and its schedule remains dark unless explicitly enabled.
 */
export class MemoryProjectionWorkerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MemoryProjectionWorkerStackProps) {
    super(scope, id, props);
    const { cfg } = props;
    for (const [key, value] of Object.entries(commonTags(cfg))) {
      cdk.Tags.of(this).add(key, value);
    }

    const securityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'ImportedServiceSecurityGroup',
      props.serviceSecurityGroupId,
      { mutable: false },
    );
    // fromClusterArn() leaves cluster.vpc undefined, and EventBridge EcsTask then
    // throws "vpc is not available for a Cluster imported using fromClusterArn()".
    // Import by attributes with the real VPC + private subnets instead.
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedVpc', {
      vpcId: props.vpcId,
      availabilityZones: props.privateSubnetAvailabilityZones,
      privateSubnetIds: props.privateSubnetIds,
    });
    const clusterName =
      cdk.Arn.split(props.clusterArn, cdk.ArnFormat.SLASH_RESOURCE_NAME).resourceName ??
      props.clusterArn.split('/').pop() ??
      '';
    if (!clusterName) {
      throw new Error(`Could not parse ECS cluster name from ARN: ${props.clusterArn}`);
    }
    const cluster = ecs.Cluster.fromClusterAttributes(this, 'ImportedCluster', {
      clusterName,
      clusterArn: props.clusterArn,
      vpc,
      securityGroups: [securityGroup],
    });
    const apiRepo = ecr.Repository.fromRepositoryName(
      this,
      'ImportedApiRepository',
      props.apiRepositoryName,
    );
    const subnets = props.privateSubnetIds.map((subnetId, index) =>
      ec2.Subnet.fromSubnetId(this, `ImportedPrivateSubnet${index + 1}`, subnetId),
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

    const worker = new ScheduledMemoryProjectionWorker(this, 'ScheduledWorker', {
      envName: cfg.envName,
      cluster,
      apiRepo,
      apiImageDigest: props.apiImageDigest,
      subnets,
      securityGroup,
      dbSecret,
      appDbSecret,
      databaseName: props.databaseName,
      dataKeyArn: props.dataKeyArn,
      secretsKeyArn: props.secretsKeyArn,
      region: this.region,
      account: this.account,
      protectFromDestroy: cfg.protectFromDestroy,
      scheduleEnabled: props.scheduleEnabled,
      alertsTopic,
    });

    new cdk.CfnOutput(this, 'ProjectionWorkerScheduleName', {
      value: worker.rule.ruleName,
      description: `Governed-memory projection schedule (enabled=${props.scheduleEnabled})`,
    });
    new cdk.CfnOutput(this, 'ProjectionWorkerImageDigest', {
      value: props.apiImageDigest,
      description: 'Immutable API image digest bound to the projection task definition',
    });
  }
}
