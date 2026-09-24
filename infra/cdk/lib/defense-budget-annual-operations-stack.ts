import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { commonTags, type EnvConfig } from './config';
import { ScheduledDefenseBudgetLifecycleCoordinator } from './constructs/scheduled-defense-budget-lifecycle-coordinator';

export interface DefenseBudgetAnnualOperationsStackProps extends cdk.StackProps {
  cfg: EnvConfig;
  clusterArn: string;
  vpcId: string;
  privateSubnetIds: string[];
  privateSubnetAvailabilityZones: string[];
  serviceSecurityGroupId: string;
  defenseApiRepositoryName: string;
  defenseApiImageDigest: string;
  releaseSha: string;
  dbSecretArn: string;
  defenseJobSecretArn: string;
  databaseName: string;
  secretsKeyArn: string;
  alertsTopicArn: string;
  scheduleEnabled: boolean;
  discoveryRequestBudget?: number;
  watcherLeaseSeconds?: number;
}

/** Additive Package 1 stack; it never updates the historical Compute stack. */
export class DefenseBudgetAnnualOperationsStack extends cdk.Stack {
  readonly coordinator: ScheduledDefenseBudgetLifecycleCoordinator;

  constructor(scope: Construct, id: string, props: DefenseBudgetAnnualOperationsStackProps) {
    super(scope, id, props);
    for (const [key, value] of Object.entries(commonTags(props.cfg))) {
      cdk.Tags.of(this).add(key, value);
    }
    if (
      props.privateSubnetIds.length === 0 ||
      props.privateSubnetIds.length !== props.privateSubnetAvailabilityZones.length
    ) {
      throw new Error('Private subnet ids and availability zones must be nonempty and aligned.');
    }

    const securityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'ImportedServiceSecurityGroup',
      props.serviceSecurityGroupId,
      { mutable: false },
    );
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'ImportedVpc', {
      vpcId: props.vpcId,
      availabilityZones: props.privateSubnetAvailabilityZones,
      privateSubnetIds: props.privateSubnetIds,
    });
    const clusterName = props.clusterArn.split('/').pop() ?? '';
    if (!clusterName) throw new Error(`Could not parse ECS cluster name: ${props.clusterArn}`);
    const cluster = ecs.Cluster.fromClusterAttributes(this, 'ImportedCluster', {
      clusterArn: props.clusterArn,
      clusterName,
      vpc,
      securityGroups: [securityGroup],
    });
    const subnets = props.privateSubnetIds.map((subnetId, index) =>
      ec2.Subnet.fromSubnetId(this, `ImportedPrivateSubnet${index + 1}`, subnetId),
    );
    const repo = ecr.Repository.fromRepositoryName(
      this,
      'ImportedDefenseApiRepository',
      props.defenseApiRepositoryName,
    );
    const dbSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'ImportedDatabaseSecret',
      props.dbSecretArn,
    );
    const jobSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'ImportedDefenseJobSecret',
      props.defenseJobSecretArn,
    );
    const alertsTopic = sns.Topic.fromTopicArn(this, 'ImportedAlertsTopic', props.alertsTopicArn);

    this.coordinator = new ScheduledDefenseBudgetLifecycleCoordinator(this, 'Coordinator', {
      envName: props.cfg.envName,
      cluster,
      defenseApiRepo: repo,
      defenseApiImageDigest: props.defenseApiImageDigest,
      releaseSha: props.releaseSha,
      subnets,
      securityGroup,
      dbSecret,
      defenseJobSecret: jobSecret,
      databaseName: props.databaseName,
      secretsKeyArn: props.secretsKeyArn,
      protectFromDestroy: props.cfg.protectFromDestroy,
      scheduleEnabled: props.scheduleEnabled,
      alertsTopic,
      discoveryRequestBudget: props.discoveryRequestBudget,
      watcherLeaseSeconds: props.watcherLeaseSeconds,
    });

    new cdk.CfnOutput(this, 'LifecycleCoordinatorTaskDefinitionArn', {
      value: this.coordinator.taskDefinition.taskDefinitionArn,
    });
    new cdk.CfnOutput(this, 'LifecycleCoordinatorRuleName', {
      value: this.coordinator.rule.ruleName,
      description: `Enabled=${props.scheduleEnabled}`,
    });
    new cdk.CfnOutput(this, 'LifecycleCoordinatorImageDigest', {
      value: props.defenseApiImageDigest,
    });
    new cdk.CfnOutput(this, 'LifecycleCoordinatorReleaseSha', { value: props.releaseSha });
  }
}
