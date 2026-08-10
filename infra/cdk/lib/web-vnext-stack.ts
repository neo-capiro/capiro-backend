import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { commonTags, type EnvConfig } from './config';

export interface WebVNextStackProps extends cdk.StackProps {
  cfg: EnvConfig;
  releaseSha: string;
  clusterArn: string;
  vpcId: string;
  privateSubnetIds: string[];
  privateSubnetAvailabilityZones: string[];
  serviceSecurityGroupId: string;
  webRepositoryName: string;
  webImageDigest: string;
  clerkPublishableKeySecretArn: string;
  secretsKeyArn: string;
  httpsListenerArn: string;
  certificateArn: string;
  hostname: string;
  listenerPriority: number;
  desiredCount: number;
  maxCount: number;
}

/**
 * Additive, independently deployable Fargate stack for the Capiro vNext web UI.
 *
 * The live env=dev Compute stack is intentionally not mutated here. This stack
 * imports the existing network, ECS cluster, service security group, web-vNext
 * ECR repository, Clerk public-key secret and manual production ALB listener.
 * It creates only the isolated os.capiro.ai presentation service.
 */
export class WebVNextStack extends cdk.Stack {
  public readonly service: ecs.FargateService;
  public readonly targetGroup: elb.ApplicationTargetGroup;
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: WebVNextStackProps) {
    super(scope, id, props);

    const { cfg } = props;
    for (const [key, value] of Object.entries(commonTags(cfg))) {
      cdk.Tags.of(this).add(key, value);
    }
    cdk.Tags.of(this).add('Surface', 'web-vnext');
    cdk.Tags.of(this).add('Hostname', props.hostname);
    cdk.Tags.of(this).add('ReleaseSha', props.releaseSha);

    const serviceSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
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

    const privateSubnets = props.privateSubnetIds.map((subnetId, index) =>
      ec2.Subnet.fromSubnetId(this, `ImportedPrivateSubnet${index + 1}`, subnetId),
    );

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
      securityGroups: [serviceSecurityGroup],
    });

    const webRepository = ecr.Repository.fromRepositoryName(
      this,
      'ImportedWebVNextRepository',
      props.webRepositoryName,
    );
    const clerkPublishableKey = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'ImportedClerkPublishableKey',
      props.clerkPublishableKeySecretArn,
    );

    this.logGroup = new logs.LogGroup(this, 'WebVNextLogs', {
      logGroupName: `/capiro/${cfg.envName}/web-vnext`,
      retention: cfg.logRetentionDays as unknown as logs.RetentionDays,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const taskRole = new iam.Role(this, 'WebVNextTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Capiro web-vnext task role; browser assets only, no backend/data permissions',
    });

    const executionRole = new iam.Role(this, 'WebVNextExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Capiro web-vnext ECS execution role',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [props.clerkPublishableKeySecretArn],
      }),
    );
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:DescribeKey'],
        resources: [props.secretsKeyArn],
      }),
    );

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'WebVNextTaskDef', {
      family: `capiro-${cfg.envName}-web-vnext`,
      cpu: cfg.webCpu,
      memoryLimitMiB: cfg.webMemoryMib,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskRole,
      executionRole,
    });

    taskDefinition.addContainer('web-vnext', {
      image: ecs.ContainerImage.fromEcrRepository(webRepository, props.webImageDigest),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: this.logGroup,
        streamPrefix: 'web-vnext',
      }),
      environment: {
        APP_ENV: `${cfg.envName}-vnext`,
        API_BASE_URL: `https://${props.hostname}`,
        MAP_STYLE_URL: 'https://tiles.openfreemap.org/styles/positron',
        MAP_STYLE_ATTRIBUTION: '© OpenStreetMap contributors',
        WEB_SURFACE: 'vnext',
        CAPIRO_WEB_RELEASE_SHA: props.releaseSha,
      },
      secrets: {
        CLERK_PUBLISHABLE_KEY: ecs.Secret.fromSecretsManager(clerkPublishableKey),
      },
      readonlyRootFilesystem: false,
      portMappings: [{ containerPort: 8080, protocol: ecs.Protocol.TCP }],
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:8080/healthz || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(15),
      },
    });

    this.targetGroup = new elb.ApplicationTargetGroup(this, 'WebVNextTargetGroup', {
      vpc,
      port: 8080,
      protocol: elb.ApplicationProtocol.HTTP,
      targetType: elb.TargetType.IP,
      healthCheck: {
        path: '/healthz',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        unhealthyThresholdCount: 3,
        healthyThresholdCount: 2,
      },
      deregistrationDelay: cdk.Duration.seconds(15),
    });

    const listenerRule = new elb.CfnListenerRule(this, 'WebVNextHostRule', {
      listenerArn: props.httpsListenerArn,
      priority: props.listenerPriority,
      conditions: [
        {
          field: 'host-header',
          hostHeaderConfig: { values: [props.hostname] },
        },
      ],
      actions: [
        {
          type: 'forward',
          targetGroupArn: this.targetGroup.targetGroupArn,
        },
      ],
    });

    new elb.CfnListenerCertificate(this, 'WebVNextListenerCertificate', {
      listenerArn: props.httpsListenerArn,
      certificates: [{ certificateArn: props.certificateArn }],
    });

    this.service = new ecs.FargateService(this, 'WebVNextService', {
      cluster,
      taskDefinition,
      serviceName: `capiro-${cfg.envName}-web-vnext`,
      desiredCount: props.desiredCount,
      vpcSubnets: { subnets: privateSubnets },
      securityGroups: [serviceSecurityGroup],
      assignPublicIp: false,
      enableExecuteCommand: true,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: cdk.Duration.seconds(60),
    });
    this.service.attachToApplicationTargetGroup(this.targetGroup);
    this.service.node.addDependency(listenerRule);

    const scaling = this.service.autoScaleTaskCount({
      minCapacity: props.desiredCount,
      maxCapacity: props.maxCount,
    });
    scaling.scaleOnCpuUtilization('WebVNextCpuScaling', {
      targetUtilizationPercent: 60,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(30),
    });

    new cdk.CfnOutput(this, 'WebVNextHostname', { value: props.hostname });
    new cdk.CfnOutput(this, 'WebVNextServiceName', { value: this.service.serviceName });
    new cdk.CfnOutput(this, 'WebVNextTargetGroupArn', {
      value: this.targetGroup.targetGroupArn,
    });
    new cdk.CfnOutput(this, 'WebVNextLogGroupName', { value: this.logGroup.logGroupName });
    new cdk.CfnOutput(this, 'WebVNextReleaseSha', { value: props.releaseSha });
    new cdk.CfnOutput(this, 'WebVNextImageDigest', { value: props.webImageDigest });
    new cdk.CfnOutput(this, 'WebVNextListenerPriority', {
      value: String(props.listenerPriority),
    });
  }
}
