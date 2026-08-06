import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

import {
  ENGAGEMENT_API_CONTRACT,
  engagementApiNames,
  uiContractSha256,
  type EngagementApiInfraConfig,
} from './engagement-api-config';
import { buildEngagementApiIam } from './engagement-api-iam';
import { applyEngagementApiTags } from './engagement-api-tags';

export interface EngagementApiServiceStackProps extends cdk.StackProps {
  cfg: EngagementApiInfraConfig;
  /** Target group ARN from the Network stack. */
  targetGroupArn: string;
}

/**
 * The dark `engagement-api` Fargate service.
 *
 * Every identifier is imported. The stack creates a log group, a task
 * definition, a service and its autoscaling target — nothing else. It creates
 * no listener rule, so deploying it cannot route a single user request.
 *
 * The runtime posture is the Phase 1 shadow matrix, written literally rather
 * than derived from config, so no deployment parameter can arm this service.
 */
export class EngagementApiServiceStack extends cdk.Stack {
  public readonly service: ecs.FargateService;
  public readonly logGroup: logs.ILogGroup;

  constructor(scope: Construct, id: string, props: EngagementApiServiceStackProps) {
    super(scope, id, props);
    const { cfg, targetGroupArn } = props;
    const names = engagementApiNames(cfg);

    applyEngagementApiTags(this, cfg);

    if (!cfg.imageDigest) {
      throw new Error(
        'imageDigest is required to deploy the Service stack. Resolve it from ECR after an ' +
          'authorized push; Phase 2 never deploys by tag.',
      );
    }
    if (!cfg.releaseSha) {
      throw new Error('releaseSha is required to deploy the Service stack.');
    }

    // ── imported ────────────────────────────────────────────────────────────
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId: cfg.vpcId,
      availabilityZones: cfg.privateSubnetAvailabilityZones,
      privateSubnetIds: cfg.privateSubnetIds,
    });
    const securityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'ServiceSecurityGroup',
      cfg.serviceSecurityGroupId,
      { mutable: false },
    );
    const cluster = ecs.Cluster.fromClusterAttributes(this, 'Cluster', {
      clusterArn: cfg.ecsClusterArn,
      clusterName: cdk.Fn.select(1, cdk.Fn.split('/', cfg.ecsClusterArn)),
      vpc,
      securityGroups: [securityGroup],
    });
    const repository = ecr.Repository.fromRepositoryAttributes(this, 'Repository', {
      repositoryName: names.repository,
      repositoryArn: cdk.Stack.of(this).formatArn({
        service: 'ecr',
        resource: 'repository',
        resourceName: names.repository,
      }),
    });
    const targetGroup = elbv2.ApplicationTargetGroup.fromTargetGroupAttributes(
      this,
      'TargetGroup',
      { targetGroupArn },
    );

    // ── logs ────────────────────────────────────────────────────────────────
    // Created here because the task definition cannot exist without a log
    // destination. Micro-session 2.8 adds metric filters, alarms and the
    // dashboard on top of this group; it does not move it.
    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: names.logGroup,
      encryptionKey: kms.Key.fromKeyArn(this, 'LogsKey', cfg.kmsKeyArns.logs),
      retention:
        cfg.environment === 'prod' ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── task definition ─────────────────────────────────────────────────────
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      family: names.taskFamily,
      cpu: ENGAGEMENT_API_CONTRACT.cpu,
      memoryLimitMiB: ENGAGEMENT_API_CONTRACT.memoryMiB,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
      },
    });

    // Read-only root means every writable path is an explicit, task-scoped
    // tmpfs. The entrypoint prefers /dev/shm and falls back to /app/tmp, and
    // node itself needs /tmp, so both are mounted.
    for (const name of ['AppTmp', 'Tmp']) {
      taskDefinition.addVolume({ name });
    }

    // Roles and the secret map come from the tested least-privilege helper, so
    // the permission surface is reviewed in one place instead of inline here.
    const iamRoles = buildEngagementApiIam(this, cfg, taskDefinition);

    const container = taskDefinition.addContainer('engagement-api', {
      containerName: 'engagement-api',
      // Digest-pinned. A tag would let the bytes behind a reviewed release SHA
      // change after review. fromEcrRepository routes a `sha256:` value through
      // repositoryUriForTagOrDigest, rendering <uri>@sha256:<64-hex>, and grants
      // the execution role pull on bind.
      image: ecs.ContainerImage.fromEcrRepository(repository, cfg.imageDigest),
      essential: true,
      readonlyRootFilesystem: true,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'engagement-api',
        logGroup: this.logGroup,
        mode: ecs.AwsLogDriverMode.NON_BLOCKING,
      }),
      environment: engagementApiTaskEnvironment(cfg),
      // Exact boot-required and safe-read fields only, mapped individually
      // rather than as whole JSON documents. See engagement-api-iam.ts.
      secrets: iamRoles.secrets,
      healthCheck: {
        command: [
          'CMD-SHELL',
          `wget -q -O - http://127.0.0.1:${ENGAGEMENT_API_CONTRACT.containerPort}/health ` +
            `| grep -q '"service":"engagement-api"'`,
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    container.addPortMappings({
      containerPort: ENGAGEMENT_API_CONTRACT.containerPort,
      protocol: ecs.Protocol.TCP,
    });
    container.addMountPoints(
      { sourceVolume: 'AppTmp', containerPath: '/app/tmp', readOnly: false },
      { sourceVolume: 'Tmp', containerPath: '/tmp', readOnly: false },
    );

    // ── service ─────────────────────────────────────────────────────────────
    this.service = new ecs.FargateService(this, 'Service', {
      serviceName: names.service,
      cluster,
      taskDefinition,
      desiredCount: ENGAGEMENT_API_CONTRACT.desiredCount,
      assignPublicIp: false,
      vpcSubnets: {
        subnets: cfg.privateSubnetIds.map((subnetId, index) =>
          ec2.Subnet.fromSubnetAttributes(this, `PrivateSubnet${index}`, {
            subnetId,
            availabilityZone: cfg.privateSubnetAvailabilityZones[index],
          }),
        ),
      },
      securityGroups: [securityGroup],
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: cdk.Duration.seconds(120),
      circuitBreaker: { rollback: true },
      // ECS Exec is a shell into a task holding live tenant data. It stays off.
      enableExecuteCommand: false,
      enableECSManagedTags: true,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
    });

    this.service.attachToApplicationTargetGroup(targetGroup);

    const scaling = this.service.autoScaleTaskCount({
      minCapacity: ENGAGEMENT_API_CONTRACT.minimumCount,
      maxCapacity: ENGAGEMENT_API_CONTRACT.maximumCount,
    });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 60,
      scaleOutCooldown: cdk.Duration.seconds(60),
      scaleInCooldown: cdk.Duration.seconds(300),
    });
    scaling.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 70,
      scaleOutCooldown: cdk.Duration.seconds(60),
      scaleInCooldown: cdk.Duration.seconds(300),
    });

    new cdk.CfnOutput(this, 'ServiceName', { value: names.service });
    new cdk.CfnOutput(this, 'TaskFamily', { value: names.taskFamily });
    new cdk.CfnOutput(this, 'LogGroupName', { value: names.logGroup });
    new cdk.CfnOutput(this, 'ReleaseSha', { value: cfg.releaseSha });
    new cdk.CfnOutput(this, 'ImageDigest', { value: cfg.imageDigest });
  }
}

/**
 * The exact task environment.
 *
 * The six shadow variables are literals, not config lookups: the point of the
 * Phase 1 runtime policy is that no deployment parameter can arm this service.
 * Provenance values are nonsecret and enable nothing.
 */
export function engagementApiTaskEnvironment(
  cfg: EngagementApiInfraConfig,
): Record<string, string> {
  return {
    NODE_ENV: 'production',
    CAPIRO_SERVICE_NAME: 'engagement-api',
    RELEASE_SHA: cfg.releaseSha ?? '',

    ENGAGEMENT_API_PORT: String(ENGAGEMENT_API_CONTRACT.containerPort),
    ENGAGEMENT_API_BIND_HOST: '0.0.0.0',

    ENGAGEMENT_PROCESS_MODE: 'shadow',
    ENGAGEMENT_BACKGROUND_OWNER: 'disabled',
    ENGAGEMENT_EXTERNAL_ACTIONS: 'disabled',
    ENGAGEMENT_CALLBACKS_ENABLED: 'false',
    ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false',

    AWS_REGION_DEFAULT: cfg.region,

    OUTREACH_V3_PROTOTYPE_SHA256: cfg.uiContract.prototypeSha256,
    OUTREACH_V3_UI_CONTRACT_SHA256: uiContractSha256(cfg.uiContract),
  };
}

/** Environment variable names that would imply Outreach V3 is available. */
export const FORBIDDEN_TASK_ENV_PATTERNS = [
  /^OUTREACH_V3_ENABLED$/,
  /^VITE_/,
  /^LANGGRAPH_/,
  /^CAMPAIGN_SPEC_/,
];
