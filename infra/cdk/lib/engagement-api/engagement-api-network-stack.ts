import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

import {
  ENGAGEMENT_API_CONTRACT,
  engagementApiNames,
  type EngagementApiInfraConfig,
} from './engagement-api-config';
import { applyEngagementApiTags } from './engagement-api-tags';

export interface EngagementApiNetworkStackProps extends cdk.StackProps {
  cfg: EngagementApiInfraConfig;
}

/**
 * Imported network bindings and the empty `engagement-api` target group.
 *
 * Separate from the Service stack because the deployment order is Registry →
 * Network → preview rule → image push → Service. The target group must already
 * be attached to the live listener before ECS creates a service that
 * references it, and it must be able to exist with zero targets in between.
 *
 * This stack creates ONE resource: the target group. Everything else — VPC,
 * subnets, the service security group — is imported by identifier. It creates
 * no listener rule: the live listener is manually managed and only the
 * fail-closed script in micro-session 2.11 may touch it.
 */
export class EngagementApiNetworkStack extends cdk.Stack {
  public readonly targetGroup: elbv2.ApplicationTargetGroup;
  public readonly vpc: ec2.IVpc;
  public readonly serviceSecurityGroup: ec2.ISecurityGroup;

  constructor(scope: Construct, id: string, props: EngagementApiNetworkStackProps) {
    super(scope, id, props);
    const { cfg } = props;
    const names = engagementApiNames(cfg);

    applyEngagementApiTags(this, cfg);

    // fromVpcAttributes, not fromLookup: a lookup needs live AWS credentials at
    // synth time, which would make CI synthesis impossible and would let a
    // context cache silently pin the wrong VPC.
    this.vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId: cfg.vpcId,
      availabilityZones: cfg.privateSubnetAvailabilityZones,
      privateSubnetIds: cfg.privateSubnetIds,
    });

    // mutable: false is load-bearing. It makes CDK refuse to synthesize any
    // ingress or egress rule onto the shared service security group, so this
    // stack cannot widen the network posture of every other Capiro service.
    // If ALB-to-4500 is not already permitted, Phase 2 stops and a separately
    // reviewed network change is planned — see the full plan, section 15.
    this.serviceSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'ServiceSecurityGroup',
      cfg.serviceSecurityGroupId,
      { mutable: false },
    );

    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      targetGroupName: names.targetGroup,
      vpc: this.vpc,
      protocol: elbv2.ApplicationProtocol.HTTP,
      port: ENGAGEMENT_API_CONTRACT.containerPort,

      // IP targets, because Fargate awsvpc tasks register by ENI address.
      targetType: elbv2.TargetType.IP,
      deregistrationDelay: cdk.Duration.seconds(30),

      // The health endpoint is how the target group learns the container is
      // both up and in the expected shadow posture. It is reachable only from
      // inside the VPC: no /health listener rule is ever added, so nothing
      // outside the ALB can probe it.
      healthCheck: {
        path: ENGAGEMENT_API_CONTRACT.healthCheckPath,
        port: 'traffic-port',
        protocol: elbv2.Protocol.HTTP,
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // A target group must never be destroyed while a listener rule still
    // forwards to it. Retaining makes the unsafe ordering impossible by
    // accident; the rollback runbook removes the rule first, deliberately.
    this.targetGroup.node.defaultChild?.node.addMetadata(
      'capiro:rollback',
      'delete the preview listener rule before removing this target group',
    );
    (this.targetGroup.node.defaultChild as elbv2.CfnTargetGroup).applyRemovalPolicy(
      cdk.RemovalPolicy.RETAIN,
    );

    new cdk.CfnOutput(this, 'TargetGroupArn', {
      value: this.targetGroup.targetGroupArn,
      description: 'engagement-api target group ARN (empty until the Service stack deploys)',
    });
    new cdk.CfnOutput(this, 'TargetGroupName', {
      value: names.targetGroup,
      description: 'engagement-api target group name',
    });
    new cdk.CfnOutput(this, 'ServiceSecurityGroupId', {
      value: cfg.serviceSecurityGroupId,
      description: 'Imported service security group (not modified by this stack)',
    });
  }
}
