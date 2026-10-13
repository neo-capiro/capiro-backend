import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { AssetsStack } from '../assets-stack';
import { DataStack } from '../data-stack';
import { PreviewBindings } from './bindings';
import { PreviewBackendNetwork } from './network-stack';

export const PREVIEW_APP_ORIGIN = 'https://portfolio-preview.app.capiro.ai';
export const PREVIEW_BACKEND_ORIGIN = PREVIEW_APP_ORIGIN;

/** Concrete held definitions for the existing canonical API owners. No worker is started. */
export class PreviewBackendServices extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    bindings: PreviewBindings,
    network: PreviewBackendNetwork,
    data: DataStack,
    assets: AssetsStack,
  ) {
    super(scope, id, { env: { account: '967807252336', region: 'us-east-1' } });
    const cluster = ecs.Cluster.fromClusterAttributes(this, 'PreviewCluster', {
      clusterName: 'capiro-portfolio-preview',
      clusterArn: bindings.clusterArn,
      vpc: network.vpc,
    });
    // Import new canonical-owner references to keep KMS/resource policies from
    // referring back to this stack's roles (the existing compute pattern).
    const appCredentials = secrets.Secret.fromSecretCompleteArn(
      this,
      'PreviewAppCredentials',
      data.appSecret.secretArn,
    );
    const dataKey = kms.Key.fromKeyArn(this, 'PreviewDataEncryption', data.key.keyArn);
    const assetKey = kms.Key.fromKeyArn(this, 'PreviewAssetEncryption', assets.key.keyArn);
    const assetBucket = s3.Bucket.fromBucketAttributes(this, 'PreviewAssetBucket', {
      bucketName: assets.bucket.bucketName,
      encryptionKey: assetKey,
    });
    const clerkKey = secrets.Secret.fromSecretCompleteArn(
      this,
      'PreviewClerkKey',
      bindings.clerkSecretArn,
    );
    const encryptionKey = kms.Key.fromKeyArn(this, 'PreviewClerkEncryption', bindings.clerkKeyArn);
    // Preserve canonical same-origin proxy and conversation namespaces before Core's /api/*.
    new elb.CfnListenerRule(this, 'FrontendProxyRoutes', {
      listenerArn: bindings.listenerArn,
      priority: 609,
      conditions: [
        { field: 'host-header', hostHeaderConfig: { values: ['portfolio-preview.app.capiro.ai'] } },
        {
          field: 'path-pattern',
          pathPatternConfig: {
            values: [
              '/api/capiro/*',
              '/api/backend/*',
              '/api/action-followthrough/*',
              '/api/documents/*',
              '/api/conversations/*',
            ],
          },
        },
      ],
      actions: [{ type: 'forward', targetGroupArn: bindings.frontendTargetGroupArn }],
    });
    new elb.CfnListenerRule(this, 'UnavailableBackends', {
      listenerArn: bindings.listenerArn,
      priority: 608,
      conditions: [
        { field: 'host-header', hostHeaderConfig: { values: ['portfolio-preview.app.capiro.ai'] } },
        {
          field: 'path-pattern',
          pathPatternConfig: {
            values: ['/strategy-api/*', '/onboard-api/*', '/meri-api/*', '/api/meri/*'],
          },
        },
      ],
      actions: [
        {
          type: 'fixed-response',
          fixedResponseConfig: {
            statusCode: '503',
            contentType: 'application/json',
            messageBody: '{"error":"PREVIEW_SERVICE_UNAVAILABLE"}',
          },
        },
      ],
    });
    const owners = [
      { name: 'core' as const, port: 4000, path: '/api/*', health: '/api/health' },
      { name: 'workspace' as const, port: 4200, path: '/workspace-api/*', health: '/health' },
      { name: 'intelligence' as const, port: 4300, path: '/intel-api/*', health: '/health' },
    ];
    owners.forEach((owner, index) => {
      const role = new iam.Role(this, `${owner.name}TaskRole`, {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      });
      if (owner.name === 'core' || owner.name === 'workspace') assetBucket.grantReadWrite(role);
      const executionRole = new iam.Role(this, `${owner.name}ExecutionRole`, {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName(
            'service-role/AmazonECSTaskExecutionRolePolicy',
          ),
        ],
      });
      encryptionKey.grantDecrypt(executionRole);
      dataKey.grantDecrypt(executionRole);
      const task = new ecs.FargateTaskDefinition(this, `${owner.name}Task`, {
        family: `capiro-preview-${owner.name}`,
        cpu: 512,
        memoryLimitMiB: 1024,
        taskRole: role,
        executionRole,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });
      const log = new logs.LogGroup(this, `${owner.name}Logs`, {
        logGroupName: `/capiro/preview/${owner.name}`,
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
      const container = task.addContainer(owner.name, {
        image: ecs.ContainerImage.fromRegistry(bindings.images[owner.name].uri),
        essential: true,
        command: ['serve'],
        logging: ecs.LogDrivers.awsLogs({ logGroup: log, streamPrefix: owner.name }),
        secrets: {
          DB_USER: ecs.Secret.fromSecretsManager(appCredentials, 'username'),
          DB_PASSWORD: ecs.Secret.fromSecretsManager(appCredentials, 'password'),
          CLERK_SECRET_KEY: ecs.Secret.fromSecretsManager(clerkKey),
        },
        environment: {
          NODE_ENV: 'production',
          WEB_ORIGIN: PREVIEW_APP_ORIGIN,
          DATABASE_URL: '',
          DB_HOST: data.cluster.clusterEndpoint.hostname,
          DB_PORT: '5432',
          DB_NAME: data.databaseName,
          CLERK_JWT_ISSUER: bindings.clerkIssuer,
          RELEASE_SHA: bindings.images[owner.name].sourceHead,
          ASSETS_BUCKET: assets.bucket.bucketName,
          DIRECTORY_S3_BUCKET: assets.bucket.bucketName,
        },
      });
      container.addPortMappings({ containerPort: owner.port });
      const target = new elb.ApplicationTargetGroup(this, `${owner.name}Target`, {
        vpc: network.vpc,
        port: owner.port,
        protocol: elb.ApplicationProtocol.HTTP,
        targetType: elb.TargetType.IP,
        healthCheck: { path: owner.health },
      });
      const service = new ecs.FargateService(this, `${owner.name}Service`, {
        cluster,
        taskDefinition: task,
        serviceName: `capiro-preview-${owner.name}`,
        desiredCount: 0,
        assignPublicIp: true,
        vpcSubnets: { subnetType: cdk.aws_ec2.SubnetType.PUBLIC },
        securityGroups: [network.serviceGroup],
        circuitBreaker: { rollback: true },
      });
      service.attachToApplicationTargetGroup(target);
      new elb.CfnListenerRule(this, `${owner.name}Route`, {
        listenerArn: bindings.listenerArn,
        priority: 610 + index,
        conditions: [
          {
            field: 'host-header',
            hostHeaderConfig: { values: ['portfolio-preview.app.capiro.ai'] },
          },
          { field: 'path-pattern', pathPatternConfig: { values: [owner.path] } },
        ],
        actions: [{ type: 'forward', targetGroupArn: target.targetGroupArn }],
      });
    });
    new cdk.CfnOutput(this, 'FrontendCoreApiBaseUrl', { value: `${PREVIEW_BACKEND_ORIGIN}/api` });
    new cdk.CfnOutput(this, 'FrontendWorkspaceApiBaseUrl', {
      value: `${PREVIEW_BACKEND_ORIGIN}/workspace-api`,
    });
    new cdk.CfnOutput(this, 'FrontendIntelligenceApiBaseUrl', {
      value: `${PREVIEW_BACKEND_ORIGIN}/intel-api`,
    });
    new cdk.CfnOutput(this, 'FrontendStrategyApiBaseUrl', {
      value: `${PREVIEW_BACKEND_ORIGIN}/strategy-api`,
    });
    new cdk.CfnOutput(this, 'FrontendOnboardApiBaseUrl', {
      value: `${PREVIEW_BACKEND_ORIGIN}/onboard-api`,
    });
    new cdk.CfnOutput(this, 'FrontendExistingAppUrl', { value: PREVIEW_APP_ORIGIN });
    this.node.addMetadata('TestClerkApplicationId', bindings.clerkApplicationId);
    this.node.addMetadata('SyntheticScopeManifest', {
      neo: { tenantId: bindings.neoTenantId, actorId: bindings.neoActorId },
      automation: { tenantId: bindings.automationTenantId, actorId: bindings.automationActorId },
    });
    this.node.addMetadata(
      'ActivationGate',
      'all services held at zero; credential/schema/image/auth/runtime review required',
    );
    this.node.addMetadata(
      'MeriGate',
      'greenfield listener and Temporal bootstrap required; no legacy target',
    );
  }
}
