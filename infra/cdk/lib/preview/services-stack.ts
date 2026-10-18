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
const PREVIEW_HOST = 'portfolio-preview.app.capiro.ai';
// An ALB path regex keeps the detail read to one UUID segment. A value
// pattern such as /api/clients/* would also expose nested client GETs.
const CORE_CLIENT_DETAIL_PATH =
  '^/api/clients/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

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
    const clerkWebhook = secrets.Secret.fromSecretCompleteArn(
      this,
      'PreviewClerkWebhook',
      bindings.clerkWebhookSecretArn,
    );
    const encryptionKey = kms.Key.fromKeyArn(this, 'PreviewClerkEncryption', bindings.clerkKeyArn);
    const heldPaths = [['/strategy-api/*', '/onboard-api/*', '/meri-api/*'], ['/api/meri/*']];
    heldPaths.forEach(
      (values, index) =>
        new elb.CfnListenerRule(this, `UnavailableBackends${index}`, {
          listenerArn: bindings.listenerArn,
          priority: 608 + index,
          conditions: [
            {
              field: 'host-header',
              hostHeaderConfig: { values: [PREVIEW_HOST] },
            },
            { field: 'path-pattern', pathPatternConfig: { values } },
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
        }),
    );
    const proxyPaths = [
      ['/api/capiro/*', '/api/backend/*', '/api/action-followthrough/*'],
      ['/api/documents/*', '/api/conversations/*'],
    ];
    proxyPaths.forEach(
      (values, index) =>
        new elb.CfnListenerRule(this, `FrontendProxyRoutes${index}`, {
          listenerArn: bindings.listenerArn,
          priority: 610 + index,
          conditions: [
            {
              field: 'host-header',
              hostHeaderConfig: { values: [PREVIEW_HOST] },
            },
            { field: 'path-pattern', pathPatternConfig: { values } },
          ],
          actions: [{ type: 'forward', targetGroupArn: bindings.frontendTargetGroupArn }],
        }),
    );
    const tenantPrefixes = [bindings.neoTenantId, bindings.automationTenantId].flatMap(
      (tenantId) => [`tenants/${tenantId}/*`, `tenants/client-logo-uploads/${tenantId}/*`],
    );
    const owners = [
      { name: 'core' as const, port: 4000, path: null, health: '/health' },
      { name: 'workspace' as const, port: 4200, path: '/workspace-api/*', health: '/health' },
      { name: 'intelligence' as const, port: 4300, path: '/intel-api/*', health: '/health' },
    ];
    owners.forEach((owner, index) => {
      const role = new iam.Role(this, `${owner.name}TaskRole`, {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      });
      if (owner.name === 'core') {
        role.addToPrincipalPolicy(
          new iam.PolicyStatement({
            actions: [
              's3:GetObject',
              's3:GetObjectVersion',
              's3:PutObject',
              's3:DeleteObject',
              's3:AbortMultipartUpload',
              's3:ListMultipartUploadParts',
            ],
            resources: tenantPrefixes.map((prefix) => assetBucket.arnForObjects(prefix)),
          }),
        );
        role.addToPrincipalPolicy(
          new iam.PolicyStatement({
            actions: ['s3:ListBucket'],
            resources: [assetBucket.bucketArn],
            conditions: { StringLike: { 's3:prefix': tenantPrefixes } },
          }),
        );
        role.addToPrincipalPolicy(
          new iam.PolicyStatement({
            actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
            resources: [assetKey.keyArn],
            conditions: { StringEquals: { 'kms:ViaService': 's3.us-east-1.amazonaws.com' } },
          }),
        );
      }
      const executionRole = new iam.Role(this, `${owner.name}ExecutionRole`, {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      });
      executionRole.addToPrincipalPolicy(
        new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }),
      );
      executionRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: [
            'ecr:BatchCheckLayerAvailability',
            'ecr:GetDownloadUrlForLayer',
            'ecr:BatchGetImage',
          ],
          resources: [`arn:aws:ecr:us-east-1:967807252336:repository/capiro/preview-${owner.name}`],
        }),
      );
      executionRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['kms:Decrypt'],
          resources: [encryptionKey.keyArn, dataKey.keyArn],
          conditions: {
            StringEquals: { 'kms:ViaService': 'secretsmanager.us-east-1.amazonaws.com' },
          },
        }),
      );
      const task = new ecs.FargateTaskDefinition(this, `${owner.name}Task`, {
        family: `capiro-preview-${owner.name}`,
        cpu: owner.name === 'core' ? 1024 : 512,
        memoryLimitMiB: owner.name === 'core' ? 2048 : 1024,
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
          ...(owner.name === 'core'
            ? { CLERK_WEBHOOK_SIGNING_SECRET: ecs.Secret.fromSecretsManager(clerkWebhook) }
            : {}),
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
          ...(owner.name === 'core'
            ? {
                // The portfolio API uses ordinary tenant-scoped reads on this
                // host. First-chat native reads are host-specific and stay off.
                CORE_DEPLOYMENT_PROFILE: 'standard',
                PREVIEW_NATIVE_GETS_ENABLED: 'false',
                RETAINED_READS_ENABLED: 'false',
                // Booting the full API module must not start its background
                // processors or trigger outbound Engagement actions.
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
              }
            : {}),
        },
      });
      container.addPortMappings({ containerPort: owner.port });
      const target = new elb.ApplicationTargetGroup(this, `${owner.name}Target`, {
        vpc: network.vpc,
        port: owner.port,
        protocol: elb.ApplicationProtocol.HTTP,
        targetType: elb.TargetType.IP,
        healthCheck: { path: owner.health, healthyHttpCodes: '200' },
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
      const host = { field: 'host-header', hostHeaderConfig: { values: [PREVIEW_HOST] } };
      if (owner.name === 'core') {
        const get = { field: 'http-request-method', httpRequestMethodConfig: { values: ['GET'] } };
        const exactReads = [
          { name: 'CorePreviewReads', priority: 612, paths: ['/api/me', '/api/clients', '/api/client-account-owners'] },
          { name: 'CorePreviewOwnerOptionsRead', priority: 615, paths: ['/api/client-account-owners/options'] },
        ];
        for (const read of exactReads) {
          new elb.CfnListenerRule(this, read.name, {
            listenerArn: bindings.listenerArn,
            priority: read.priority,
            conditions: [host, get, { field: 'path-pattern', pathPatternConfig: { values: read.paths } }],
            actions: [{ type: 'forward', targetGroupArn: target.targetGroupArn }],
          });
        }
        new elb.CfnListenerRule(this, 'CorePreviewClientDetailRead', {
          listenerArn: bindings.listenerArn,
          priority: 616,
          conditions: [host, get, {
            field: 'path-pattern',
            pathPatternConfig: { regexValues: [CORE_CLIENT_DETAIL_PATH] },
          }],
          actions: [{ type: 'forward', targetGroupArn: target.targetGroupArn }],
        });
        // Higher priorities 608-611 preserve Meri's held routes and the
        // frontend proxies. Unlisted /api requests never reach Core or the
        // listener's unknown default target.
        new elb.CfnListenerRule(this, 'RejectOtherPreviewApi', {
          listenerArn: bindings.listenerArn,
          priority: 617,
          conditions: [host, { field: 'path-pattern', pathPatternConfig: { values: ['/api', '/api/*'] } }],
          actions: [{
            type: 'fixed-response',
            fixedResponseConfig: {
              statusCode: '503',
              contentType: 'application/json',
              messageBody: '{"error":"PREVIEW_SERVICE_UNAVAILABLE"}',
            },
          }],
        });
      } else {
        new elb.CfnListenerRule(this, `${owner.name}Route`, {
          listenerArn: bindings.listenerArn,
          priority: 612 + index,
          conditions: [host, { field: 'path-pattern', pathPatternConfig: { values: [owner.path] } }],
          actions: [{ type: 'forward', targetGroupArn: target.targetGroupArn }],
        });
      }
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
