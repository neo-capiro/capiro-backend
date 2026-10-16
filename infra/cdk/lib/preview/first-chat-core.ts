import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

// This is a separate, held service. The drifted live ComputeStack and its
// production API service are not owned or updated by this composition.
export const FIRST_CHAT_CORE_SOURCE = '13d12a7d7bdbe0be021cb218dd4cf7690cc4420b';
export const FIRST_CHAT_CORE_HOST = 'first-chat-preview.app-dev.capiro.ai';
const account = '967807252336';
const region = 'us-east-1';
const env = { account, region };
const imageRepoName = 'capiro/preview-core';

// Read-only AWS inventory, 2026-10-16. Recheck every identity before applying
// a stack: the account's env=dev is the live production environment.
const live = {
  vpcId: 'vpc-0ac26cfac7ed972be',
  privateSubnetIds: [
    'subnet-0920665f91c905f01',
    'subnet-0e38bd390f8961fef',
    'subnet-06db79cd21239de19',
  ],
  availabilityZones: ['us-east-1a', 'us-east-1b', 'us-east-1c'],
  clusterArn: `arn:aws:ecs:${region}:${account}:cluster/capiro-dev`,
  apiSecurityGroupId: 'sg-01def4e5c0fe44d4a',
  listenerArn: `arn:aws:elasticloadbalancing:${region}:${account}:listener/app/capiro-prod-alb/7a4acb332b261724/e2d19b3dd47fc440`,
  dbHost:
    'capiro-dev-data-auroracluster23d869c0-ltmz40k47ewv.cluster-csryw28ai752.us-east-1.rds.amazonaws.com',
  dbMasterSecretArn: `arn:aws:secretsmanager:${region}:${account}:secret:/capiro/dev/aurora/master-P4z1Vo`,
  dbAppSecretArn: `arn:aws:secretsmanager:${region}:${account}:secret:/capiro/dev/aurora/app-zNPtsU`,
  clerkSecretArn: `arn:aws:secretsmanager:${region}:${account}:secret:/capiro/dev/clerk/secret-key-FT67tM`,
  clerkWebhookSecretArn: `arn:aws:secretsmanager:${region}:${account}:secret:/capiro/dev/clerk/webhook-signing-secret-j4Lbkl`,
  dataKeyArn: `arn:aws:kms:${region}:${account}:key/efe8a18d-192e-4f30-8eea-b3f65ae7755e`,
  secretsKeyArn: `arn:aws:kms:${region}:${account}:key/f47b4c53-b9c0-4d91-ad57-4d882f87767e`,
  clerkIssuer: 'https://clerk.app.capiro.ai',
} as const;

export interface FirstChatCoreImageBinding {
  schemaVersion: 1;
  sourceHead: typeof FIRST_CHAT_CORE_SOURCE;
  imageDigest: string;
}

/** No arbitrary resource, credential, image tag, or environment override. */
export function firstChatCoreImageBinding(input: unknown): FirstChatCoreImageBinding {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('First-chat image binding object required');
  }
  const record = input as Record<string, unknown>;
  if (
    Object.keys(record).sort().join('|') !== 'imageDigest|schemaVersion|sourceHead' ||
    record.schemaVersion !== 1 ||
    record.sourceHead !== FIRST_CHAT_CORE_SOURCE ||
    typeof record.imageDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(record.imageDigest)
  ) {
    throw new Error('Exact PR43 source and immutable Core image digest required');
  }
  return record as unknown as FirstChatCoreImageBinding;
}

export class FirstChatCoreRegistryStack extends cdk.Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id, { env });
    const repo = new ecr.Repository(this, 'Repository', {
      repositoryName: imageRepoName,
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      emptyOnDelete: false,
    });
    new cdk.CfnOutput(this, 'RepositoryUri', { value: repo.repositoryUri });
  }
}

export class FirstChatCoreServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, binding: FirstChatCoreImageBinding) {
    super(scope, id, { env });
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'ExistingCapiroVpc', {
      vpcId: live.vpcId,
      availabilityZones: [...live.availabilityZones],
      privateSubnetIds: [...live.privateSubnetIds],
    });
    const cluster = ecs.Cluster.fromClusterAttributes(this, 'ExistingCapiroCluster', {
      clusterArn: live.clusterArn,
      clusterName: 'capiro-dev',
      vpc,
    });
    // The existing API SG already has ALB:4000 ingress and DB:5432 egress.
    // Sharing it avoids a live DB SG change, but must be rechecked at apply time.
    const apiGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'ExistingApiNetworkIdentity',
      live.apiSecurityGroupId,
      { mutable: false },
    );
    const repository = ecr.Repository.fromRepositoryName(this, 'PreviewCoreRepository', imageRepoName);
    const dataKey = kms.Key.fromKeyArn(this, 'ExistingDataKey', live.dataKeyArn);
    const secretsKey = kms.Key.fromKeyArn(this, 'ExistingSecretsKey', live.secretsKeyArn);
    const master = secrets.Secret.fromSecretAttributes(this, 'ExistingMasterCredential', {
      secretCompleteArn: live.dbMasterSecretArn,
      encryptionKey: dataKey,
    });
    const appCredential = secrets.Secret.fromSecretAttributes(this, 'ExistingAppCredential', {
      secretCompleteArn: live.dbAppSecretArn,
      encryptionKey: dataKey,
    });
    const clerk = secrets.Secret.fromSecretAttributes(this, 'ExistingClerkCredential', {
      secretCompleteArn: live.clerkSecretArn,
      encryptionKey: secretsKey,
    });
    const clerkWebhook = secrets.Secret.fromSecretAttributes(this, 'ExistingClerkWebhook', {
      secretCompleteArn: live.clerkWebhookSecretArn,
      encryptionKey: secretsKey,
    });
    const image = ecs.ContainerImage.fromRegistry(
      `${account}.dkr.ecr.${region}.amazonaws.com/${imageRepoName}@${binding.imageDigest}`,
    );

    const serveExecutionRole = new iam.Role(this, 'ServeExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    repository.grantPull(serveExecutionRole);
    appCredential.grantRead(serveExecutionRole);
    clerk.grantRead(serveExecutionRole);
    clerkWebhook.grantRead(serveExecutionRole);
    const serveTask = new ecs.FargateTaskDefinition(this, 'ServeTask', {
      family: 'capiro-preview-first-chat-core',
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole: serveExecutionRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    const serveLog = new logs.LogGroup(this, 'ServeLog', {
      logGroupName: '/capiro/preview-first-chat/core',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    serveLog.grantWrite(serveExecutionRole);
    const serve = serveTask.addContainer('core', {
      image,
      essential: true,
      command: ['serve'],
      logging: ecs.LogDrivers.awsLogs({ logGroup: serveLog, streamPrefix: 'core' }),
      environment: {
        NODE_ENV: 'production',
        DATABASE_URL: '',
        DB_HOST: live.dbHost,
        DB_PORT: '5432',
        DB_NAME: 'capiro',
        CLERK_JWT_ISSUER: live.clerkIssuer,
        WEB_ORIGIN: 'https://portfolio-preview.app.capiro.ai',
        RELEASE_SHA: FIRST_CHAT_CORE_SOURCE,
        // PR43 boots the full AppModule. Explicitly disable its worker and
        // outbound-action posture in this separate API task.
        CAPIRO_SERVICE_NAME: 'api',
        ENGAGEMENT_PROCESS_MODE: 'shadow',
        ENGAGEMENT_BACKGROUND_OWNER: 'disabled',
        ENGAGEMENT_EXTERNAL_ACTIONS: 'disabled',
        ENGAGEMENT_CALLBACKS_ENABLED: 'false',
        ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false',
        CLIENT_PROFILE_FILL_WORKER_ENABLED: 'false',
        CLIENT_PROFILE_FILL_COMPLETION_WORKER_ENABLED: 'false',
        MERI_JOB_SWEEPER_ENABLED: 'false',
        RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED: 'false',
        NEWSLETTER_REVIEW_EMAIL_ENABLED: 'false',
        NEWSLETTER_INVITATION_EMAIL_ENABLED: 'false',
      },
      secrets: {
        DB_USER: ecs.Secret.fromSecretsManager(appCredential, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(appCredential, 'password'),
        CLERK_SECRET_KEY: ecs.Secret.fromSecretsManager(clerk),
        CLERK_WEBHOOK_SIGNING_SECRET: ecs.Secret.fromSecretsManager(clerkWebhook),
      },
    });
    serve.addPortMappings({ containerPort: 4000 });

    const target = new elb.ApplicationTargetGroup(this, 'CoreTarget', {
      vpc,
      protocol: elb.ApplicationProtocol.HTTP,
      port: 4000,
      targetType: elb.TargetType.IP,
      healthCheck: { path: '/health', healthyHttpCodes: '200' },
    });
    const service = new ecs.FargateService(this, 'HeldCoreService', {
      cluster,
      taskDefinition: serveTask,
      serviceName: 'capiro-preview-first-chat-core',
      desiredCount: 0,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [apiGroup],
      circuitBreaker: { rollback: true },
    });
    service.attachToApplicationTargetGroup(target);

    // ALB permits at most three path match evaluations per condition and five
    // per rule. Keep every POST path exact in two rules. The host-only 404 rule
    // prevents the global /api/* production route from serving this host.
    const firstChatPosts = new elb.CfnListenerRule(this, 'FirstChatPostsOnly', {
      listenerArn: live.listenerArn,
      priority: 1,
      conditions: [
        { field: 'host-header', hostHeaderConfig: { values: [FIRST_CHAT_CORE_HOST] } },
        {
          field: 'path-pattern',
          pathPatternConfig: {
            values: [
              '/api/clio/conversations/bootstrap',
              '/api/clio/application-authority/identity',
              '/api/clio/application-authority/context',
            ],
          },
        },
        { field: 'http-request-method', httpRequestMethodConfig: { values: ['POST'] } },
      ],
      actions: [{ type: 'forward', targetGroupArn: target.targetGroupArn }],
    });
    const membershipPost = new elb.CfnListenerRule(this, 'FirstChatMembershipPostOnly', {
      listenerArn: live.listenerArn,
      priority: 2,
      conditions: [
        { field: 'host-header', hostHeaderConfig: { values: [FIRST_CHAT_CORE_HOST] } },
        {
          field: 'path-pattern',
          pathPatternConfig: { values: ['/api/clio/application-authority/membership'] },
        },
        { field: 'http-request-method', httpRequestMethodConfig: { values: ['POST'] } },
      ],
      actions: [{ type: 'forward', targetGroupArn: target.targetGroupArn }],
    });
    // ECS registration requires the target group to be associated with the
    // listener before CreateService, even while desiredCount is zero.
    service.node.addDependency(firstChatPosts, membershipPost);
    new elb.CfnListenerRule(this, 'RejectOtherPreviewHostTraffic', {
      listenerArn: live.listenerArn,
      priority: 3,
      conditions: [{ field: 'host-header', hostHeaderConfig: { values: [FIRST_CHAT_CORE_HOST] } }],
      actions: [
        {
          type: 'fixed-response',
          fixedResponseConfig: {
            statusCode: '404',
            contentType: 'application/json',
            messageBody: '{"error":"PREVIEW_ROUTE_NOT_FOUND"}',
          },
        },
      ],
    });

    // Separate, unscheduled, master-credential task. Registration never runs
    // SQL. A human reviews the ledger before overriding to command 'migrate'.
    const migrationExecutionRole = new iam.Role(this, 'MigrationExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    repository.grantPull(migrationExecutionRole);
    master.grantRead(migrationExecutionRole);
    const migrationTask = new ecs.FargateTaskDefinition(this, 'MigrationTask', {
      family: 'capiro-preview-first-chat-core-migration',
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole: migrationExecutionRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    const migrationLog = new logs.LogGroup(this, 'MigrationLog', {
      logGroupName: '/capiro/preview-first-chat/core-migration',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    migrationLog.grantWrite(migrationExecutionRole);
    migrationTask.addContainer('migration', {
      image,
      essential: true,
      command: ['migration-status'],
      logging: ecs.LogDrivers.awsLogs({ logGroup: migrationLog, streamPrefix: 'migration' }),
      environment: {
        NODE_ENV: 'production',
        DATABASE_URL: '',
        DB_HOST: live.dbHost,
        DB_PORT: '5432',
        DB_NAME: 'capiro',
        RELEASE_SHA: FIRST_CHAT_CORE_SOURCE,
      },
      secrets: {
        DB_USER: ecs.Secret.fromSecretsManager(master, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(master, 'password'),
      },
    });
    new cdk.CfnOutput(this, 'CoreApiBaseUrl', {
      value: `https://${FIRST_CHAT_CORE_HOST}/api`,
    });
    new cdk.CfnOutput(this, 'MigrationTaskDefinitionArn', {
      value: migrationTask.taskDefinitionArn,
    });
  }
}

/** Deterministic, import-safe source composition. Never deploys by itself. */
export function previewFirstChatCoreApplication(input: unknown, outdir: string) {
  const binding = firstChatCoreImageBinding(input);
  const app = new cdk.App({ outdir });
  const registry = new FirstChatCoreRegistryStack(app, 'Capiro-Preview-First-Chat-Core-Registry');
  const service = new FirstChatCoreServiceStack(app, 'Capiro-Preview-First-Chat-Core', binding);
  return { app, registry, service, binding };
}

/** First deployment phase needs no image digest because the ECR repo is empty. */
export function previewFirstChatCoreRegistryApplication(outdir: string) {
  const app = new cdk.App({ outdir });
  const registry = new FirstChatCoreRegistryStack(app, 'Capiro-Preview-First-Chat-Core-Registry');
  return { app, registry };
}
