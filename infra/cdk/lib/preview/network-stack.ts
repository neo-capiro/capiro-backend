import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { PreviewBindings } from './bindings';

/** Adds owned backend/DB resources to the preview VPC; no source VPC is imported. */
export class PreviewBackendNetwork extends cdk.Stack {
  readonly vpc: ec2.IVpc;
  readonly databaseGroup: ec2.SecurityGroup;
  readonly serviceGroup: ec2.SecurityGroup;
  constructor(scope: Construct, id: string, bindings: PreviewBindings) {
    super(scope, id, { env: { account: '967807252336', region: 'us-east-1' } });
    const routeTable = new ec2.CfnRouteTable(this, 'IsolatedDatabaseRoutes', {
      vpcId: bindings.vpcId,
    });
    const subnets = bindings.availabilityZones.map((zone, index) => {
      const subnet = new ec2.CfnSubnet(this, `DatabaseSubnet${index}`, {
        vpcId: bindings.vpcId,
        availabilityZone: zone,
        cidrBlock: `10.90.${11 + index}.0/24`,
        mapPublicIpOnLaunch: false,
      });
      new ec2.CfnSubnetRouteTableAssociation(this, `DatabaseRoute${index}`, {
        subnetId: subnet.ref,
        routeTableId: routeTable.ref,
      });
      return subnet;
    });
    this.vpc = ec2.Vpc.fromVpcAttributes(this, 'PreviewVpc', {
      vpcId: bindings.vpcId,
      availabilityZones: bindings.availabilityZones,
      publicSubnetIds: bindings.publicSubnetIds,
      isolatedSubnetIds: subnets.map((subnet) => subnet.ref),
      isolatedSubnetRouteTableIds: [routeTable.ref, routeTable.ref],
    });
    this.serviceGroup = new ec2.SecurityGroup(this, 'BackendServiceGroup', {
      vpc: this.vpc,
      allowAllOutbound: false,
      description: 'Preview backend targets only',
    });
    this.databaseGroup = new ec2.SecurityGroup(this, 'DatabaseGroup', {
      vpc: this.vpc,
      allowAllOutbound: false,
      description: 'Preview database only',
    });
    this.databaseGroup.addIngressRule(this.serviceGroup, ec2.Port.tcp(5432));
    this.serviceGroup.addEgressRule(this.databaseGroup, ec2.Port.tcp(5432));
    // External HTTPS is necessary for Clerk/ECR/logs. Runtime provider admission stays held.
    this.serviceGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));
    const alb = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'PreviewAlbGroup',
      bindings.albSecurityGroupId,
      { mutable: false },
    );
    for (const port of [4000, 4200, 4300]) {
      this.serviceGroup.addIngressRule(alb, ec2.Port.tcp(port));
      new ec2.CfnSecurityGroupEgress(this, `PreviewAlbBackendEgress${port}`, {
        groupId: bindings.albSecurityGroupId,
        destinationSecurityGroupId: this.serviceGroup.securityGroupId,
        ipProtocol: 'tcp',
        fromPort: port,
        toPort: port,
      });
    }
  }
}
