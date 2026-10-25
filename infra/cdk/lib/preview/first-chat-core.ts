import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { AssetsStack } from '../assets-stack';
import routes from './first-chat-core-routes.json';
import {
  PREVIEW_EDGE_CORE_TARGET_EXPORT,
  PREVIEW_MERI_CLIENT_GROUP_EXPORT,
  MERI_PREVIEW_CONTROL_ENVIRONMENT,
} from './first-chat-preview-edge';

// This is the separate preview service. The drifted live ComputeStack and its
// production API service are not owned or updated by this composition.
export interface FirstChatCoreImagePins {
  readonly sourceHead: string;
  readonly imageDigest: string;
}
/** Exact qualified API image. Operator changes do not rebuild or relabel it. */
export const FIRST_CHAT_CORE_IMAGE_PINS: FirstChatCoreImagePins = {
  sourceHead: 'd03a118192acd2b1ed2ef5698afb0ab8f2b36ae8',
  imageDigest: 'sha256:a1e35b1aeae40889b46c75df472ced83aebe54b8f78234bffef4192c9767e375',
};
export const FIRST_CHAT_CORE_HOST = 'first-chat-preview.app-dev.capiro.ai';
// Existing independent host guard. No priority relocation is part of this update.
export const FIRST_CHAT_CORE_GUARD_PRIORITY = 7;
export const FIRST_CHAT_CORE_GUARD_STACK_NAME = 'Capiro-Preview-First-Chat-Core-Guard';
export const FIRST_CHAT_CORE_GUARD_RULE_EXPORT = 'Capiro-Preview-First-Chat-Core-Guard-RuleArn';
export const FIRST_CHAT_ASSETS_STACK_NAME = 'Capiro-Portfolio-Preview-Assets';
const account = '967807252336';
const region = 'us-east-1';
const env = { account, region };
const imageRepoName = 'capiro/preview-core';

// Read-only AWS inventory, 2026-10-24. Recheck every identity before applying
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
  // Attached ISSUED certificate covering this host:
  // arn:aws:acm:us-east-1:967807252336:certificate/70b04aad-4971-4bba-81a8-30da1b1d97b5.
  // The listener's default *.capiro.ai certificate does not cover this host.
  dbHost: 'capiro-newstack-preview-clone.cluster-csryw28ai752.us-east-1.rds.amazonaws.com',
  dbAppSecretArn: `arn:aws:secretsmanager:${region}:${account}:secret:/capiro/dev/aurora/app-zNPtsU`,
  clerkSecretArn: `arn:aws:secretsmanager:${region}:${account}:secret:/capiro/dev/clerk/secret-key-FT67tM`,
  clerkWebhookSecretArn: `arn:aws:secretsmanager:${region}:${account}:secret:/capiro/dev/clerk/webhook-signing-secret-j4Lbkl`,
  dataKeyArn: `arn:aws:kms:${region}:${account}:key/efe8a18d-192e-4f30-8eea-b3f65ae7755e`,
  secretsKeyArn: `arn:aws:kms:${region}:${account}:key/f47b4c53-b9c0-4d91-ad57-4d882f87767e`,
  clerkIssuer: 'https://clerk.app.capiro.ai',
} as const;

/** Host and method restrictions remain independent of Core's canonical user,
 * tenant/member, conversation and client-wall authorization. */
export const FIRST_CHAT_CORE_POST_PATHS: readonly string[] = Object.freeze([...routes.post]);
export const FIRST_CHAT_CORE_GET_PATHS: readonly string[] = Object.freeze([...routes.get]);

export interface FirstChatCoreImageBinding {
  schemaVersion: 9;
  sourceHead: string;
  imageDigest: string;
  internalServiceSecretArn: string;
  internalServiceSecretVersionId: string;
  listener: { guardPriority: 7 };
  deployment: { databaseHost: string; desiredCount: 1 };
  assets: { tenantIds: string[] };
  ownerMemory: { tenantId: string };
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} object required`);
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new Error(`${label}: exact fields required`);
  }
  return record;
}

function guardedPriority(value: number): number {
  if (value !== FIRST_CHAT_CORE_GUARD_PRIORITY)
    throw new Error('Existing preview guard priority 7 required');
  return value;
}

export function firstChatCoreImageBinding(
  input: unknown,
  pins: FirstChatCoreImagePins | null = FIRST_CHAT_CORE_IMAGE_PINS,
): FirstChatCoreImageBinding {
  const record = exactKeys(
    input,
    [
      'schemaVersion',
      'sourceHead',
      'imageDigest',
      'internalServiceSecretArn',
      'internalServiceSecretVersionId',
      'listener',
      'deployment',
      'assets',
      'ownerMemory',
    ],
    'First-chat image binding',
  );
  if (
    !pins ||
    record.schemaVersion !== 9 ||
    !/^[0-9a-f]{40}$/.test(pins.sourceHead) ||
    !/^sha256:[0-9a-f]{64}$/.test(pins.imageDigest) ||
    record.sourceHead !== pins.sourceHead ||
    record.imageDigest !== pins.imageDigest
  ) {
    throw new Error('Exact qualified Core source and image digest required');
  }
  if (
    record.internalServiceSecretArn !==
      `arn:aws:secretsmanager:${region}:${account}:secret:capiro/dev/internal-service-secret-6cEZG4` ||
    typeof record.internalServiceSecretVersionId !== 'string' ||
    !/^[A-Za-z0-9-]{32,64}$/.test(record.internalServiceSecretVersionId)
  ) {
    throw new Error('Existing canonical internal service secret and immutable version required');
  }
  const listener = exactKeys(record.listener, ['guardPriority'], 'Listener');
  if (listener.guardPriority !== FIRST_CHAT_CORE_GUARD_PRIORITY)
    throw new Error('Existing preview guard priority 7 required');
  const deployment = exactKeys(record.deployment, ['databaseHost', 'desiredCount'], 'Deployment');
  if (deployment.databaseHost !== live.dbHost || deployment.desiredCount !== 1)
    throw new Error('Persistent preview clone and desired count 1 required');
  const assets = exactKeys(record.assets, ['tenantIds'], 'Assets');
  if (
    !Array.isArray(assets.tenantIds) ||
    assets.tenantIds.length < 1 ||
    assets.tenantIds.length > 2 ||
    assets.tenantIds.some(
      (id) =>
        typeof id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id),
    ) ||
    new Set(assets.tenantIds).size !== assets.tenantIds.length
  )
    throw new Error('One or two distinct explicit preview tenant identifiers required');
  const ownerMemory = exactKeys(record.ownerMemory, ['tenantId'], 'Owner memory');
  if (typeof ownerMemory.tenantId !== 'string' || !assets.tenantIds.includes(ownerMemory.tenantId))
    throw new Error('One explicitly bound preview tenant required for owner memory');
  return record as unknown as FirstChatCoreImageBinding;
}

/** Existing independent guard retained across service updates and rollback. */
export class FirstChatCoreGuardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, priority: number) {
    super(scope, id, {
      env,
      description:
        'Existing retained preview host guard; preserve priority 7 while updating the independent Core service.',
    });
    this.templateOptions.metadata = {
      AWSToolsMetrics: { AWSAgentToolkit: 'aws-cloudformation@3' },
    };
    const guard = new elb.CfnListenerRule(this, 'RejectOtherPreviewHostTraffic', {
      listenerArn: live.listenerArn,
      priority: guardedPriority(priority),
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
    // A failed later service stack, guard-stack rollback, or stack deletion
    // must not remove the rule and expose this live hostname to production.
    guard.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;
    guard.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.RETAIN;
    guard.addMetadata('com.aws.cloudformation.Context', {
      why: 'Prevents unallocated preview traffic from falling through to shared production rules.',
      must: 'Preserve priority 7, host, response, logical identity and exported ARN across service rollback.',
    });
    new cdk.CfnOutput(this, 'PreviewHostGuardRuleArn', {
      value: guard.ref,
      exportName: FIRST_CHAT_CORE_GUARD_RULE_EXPORT,
    });
  }
}

export class FirstChatCoreServiceStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    binding: FirstChatCoreImageBinding,
    assets: AssetsStack,
  ) {
    super(scope, id, {
      env,
      description:
        'Qualified Core API on the persistent preview clone; preserves existing resource identities and host-scoped routing.',
    });
    this.templateOptions.metadata = {
      AWSToolsMetrics: { AWSAgentToolkit: 'aws-cloudformation@3' },
    };
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
    const repository = ecr.Repository.fromRepositoryName(
      this,
      'PreviewCoreRepository',
      imageRepoName,
    );
    const appCredential = secrets.Secret.fromSecretAttributes(this, 'ExistingAppCredential', {
      secretCompleteArn: live.dbAppSecretArn,
    });
    const clerk = secrets.Secret.fromSecretAttributes(this, 'ExistingClerkCredential', {
      secretCompleteArn: live.clerkSecretArn,
    });
    const clerkWebhook = secrets.Secret.fromSecretAttributes(this, 'ExistingClerkWebhook', {
      secretCompleteArn: live.clerkWebhookSecretArn,
    });
    const serviceIdentity = secrets.Secret.fromSecretCompleteArn(
      this,
      'InternalServiceSecret',
      binding.internalServiceSecretArn,
    );
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
    serviceIdentity.grantRead(serveExecutionRole);
    serveExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: [live.dataKeyArn, live.secretsKeyArn],
        conditions: {
          StringEquals: { 'kms:ViaService': 'secretsmanager.us-east-1.amazonaws.com' },
        },
      }),
    );
    // Let this existing construct own its task role: preserves ServeTaskTaskRoleD6B44EC7.
    const serveTask = new ecs.FargateTaskDefinition(this, 'ServeTask', {
      family: 'capiro-preview-first-chat-core',
      cpu: 1024,
      memoryLimitMiB: 2048,
      executionRole: serveExecutionRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    // Ordinary Files uses presigned POST, Head/GetObject and reviewed deletion.
    // Core retains actor/client/wall enforcement; IAM confines its storage owner.
    const attachmentPrefixes = binding.assets.tenantIds.map(
      (tenantId) => `tenants/${tenantId}/engagement/*`,
    );
    serveTask.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: attachmentPrefixes.map((prefix) => assets.bucket.arnForObjects(prefix)),
      }),
    );
    // Missing keys can return HEAD 403. The canonical deletion helper uses an
    // exact-key ListObjectsV2 fallback; this condition scopes that LIST request.
    serveTask.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [assets.bucket.bucketArn],
        conditions: { StringLike: { 's3:prefix': attachmentPrefixes } },
      }),
    );
    serveTask.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: [assets.key.keyArn],
        conditions: { StringEquals: { 'kms:ViaService': `s3.${region}.amazonaws.com` } },
      }),
    );
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
      healthCheck: {
        command: ['CMD-SHELL', 'wget -q -O /dev/null http://127.0.0.1:4000/health || exit 1'],
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
      environment: {
        ...MERI_PREVIEW_CONTROL_ENVIRONMENT,
        NODE_ENV: 'production',
        DATABASE_URL: '',
        DB_HOST: live.dbHost,
        DB_PORT: '5432',
        DB_NAME: 'capiro',
        CLERK_JWT_ISSUER: live.clerkIssuer,
        WEB_ORIGIN: 'https://portfolio-preview.app.capiro.ai',
        ASSETS_BUCKET: assets.bucket.bucketName,
        MEMORY_GOVERNANCE_LIFECYCLE: 'enforce',
        MEMORY_GOVERNANCE_TENANTS: binding.ownerMemory.tenantId,
        // Hearing-file authorization must consult the preview Intel owner on
        // the same clone, including its current access-lock metadata.
        TRACKER_APP_BASE_URL: `https://${FIRST_CHAT_CORE_HOST}`,
        RELEASE_SHA: binding.sourceHead,
        // Standard Core authorization; the additional service identity is mandatory.
        CORE_DEPLOYMENT_PROFILE: 'standard',
        PREVIEW_NATIVE_GETS_ENABLED: 'true',
        MERI_TOOLS_REQUIRE_SERVICE_SECRET: 'true',
        // The image boots the full AppModule. Explicitly disable its worker and
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
        INTERNAL_SERVICE_SECRET: ecs.Secret.fromSecretsManagerVersion(serviceIdentity, {
          versionId: binding.internalServiceSecretVersionId,
        }),
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
    const guardRuleArn = cdk.Fn.importValue(FIRST_CHAT_CORE_GUARD_RULE_EXPORT);
    // The imported export is a required TargetGroup property, not merely an
    // Output evaluated after provisioning. Both forwards reference this target.
    cdk.Tags.of(target).add('capiro:preview-guard-rule-arn', guardRuleArn);
    const service = new ecs.FargateService(this, 'HeldCoreService', {
      cluster,
      taskDefinition: serveTask,
      serviceName: 'capiro-preview-first-chat-core',
      desiredCount: binding.deployment.desiredCount,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [
        apiGroup,
        ec2.SecurityGroup.fromSecurityGroupId(
          this,
          'PreviewMeriClientIdentity',
          cdk.Fn.importValue(PREVIEW_MERI_CLIENT_GROUP_EXPORT),
          { mutable: false },
        ),
      ],
      circuitBreaker: { rollback: true },
    });
    service.attachToApplicationTargetGroup(target);
    // Keep the shared-listener target while adding the dedicated preview edge.
    // Its independent stack must exist before this service update; DNS is last.
    service.attachToApplicationTargetGroup(
      elb.ApplicationTargetGroup.fromTargetGroupAttributes(this, 'PreviewEdgeCoreTarget', {
        targetGroupArn: cdk.Fn.importValue(PREVIEW_EDGE_CORE_TARGET_EXPORT),
      }),
    );

    // Preserve the two live rule identities. Host + POST + two path expressions
    // consumes four match evaluations; Strategy/Workspace/Intel and guard stay untouched.
    const firstChatPosts = new elb.CfnListenerRule(this, 'FirstChatPostsOnly', {
      listenerArn: live.listenerArn,
      priority: 1,
      conditions: [
        { field: 'host-header', hostHeaderConfig: { values: [FIRST_CHAT_CORE_HOST] } },
        {
          field: 'path-pattern',
          pathPatternConfig: {
            regexValues: [...FIRST_CHAT_CORE_POST_PATHS],
          },
        },
        { field: 'http-request-method', httpRequestMethodConfig: { values: ['POST'] } },
      ],
      actions: [{ type: 'forward', targetGroupArn: target.targetGroupArn }],
    });
    // This logical ID previously carried membership POST. Its ID remains
    // stable while priority 2 now admits only the native GET reads.
    const browserReads = new elb.CfnListenerRule(this, 'FirstChatMembershipPostOnly', {
      listenerArn: live.listenerArn,
      priority: 2,
      conditions: [
        { field: 'host-header', hostHeaderConfig: { values: [FIRST_CHAT_CORE_HOST] } },
        {
          field: 'path-pattern',
          pathPatternConfig: {
            values: [...FIRST_CHAT_CORE_GET_PATHS],
          },
        },
        { field: 'http-request-method', httpRequestMethodConfig: { values: ['GET', 'HEAD'] } },
      ],
      actions: [{ type: 'forward', targetGroupArn: target.targetGroupArn }],
    });
    // CloudFormation must resolve an export from the independently completed
    // guard stack. Its rule is not owned by this stack or removed on rollback.
    new cdk.CfnOutput(this, 'RequiredPreviewHostGuardRuleArn', {
      value: guardRuleArn,
    });
    // ECS registration requires the target group to be associated with the
    // listener before CreateService.
    service.node.addDependency(firstChatPosts, browserReads);

    new cdk.CfnOutput(this, 'CoreApiBaseUrl', {
      value: `https://${FIRST_CHAT_CORE_HOST}/api`,
    });
    for (const resource of this.node.findAll()) {
      if (
        resource instanceof cdk.CfnResource &&
        [
          'AWS::IAM::Policy',
          'AWS::ECS::TaskDefinition',
          'AWS::ECS::Service',
          'AWS::ElasticLoadBalancingV2::ListenerRule',
        ].includes(resource.cfnResourceType)
      )
        resource.addMetadata('com.aws.cloudformation.Context', {
          why: 'Existing preview Core resource; updates the qualified API while preserving the live stack boundary.',
          must: 'Preserve logical identity, existing guard export, shared network and other listener rules. No migrations during service startup.',
        });
    }
  }
}

/** Deterministic, import-safe source composition. Never deploys by itself. */
export function previewFirstChatCoreApplication(
  input: unknown,
  outdir: string,
  pins: FirstChatCoreImagePins | null = FIRST_CHAT_CORE_IMAGE_PINS,
) {
  const binding = firstChatCoreImageBinding(input, pins);
  const app = new cdk.App({ outdir });
  const assets = new AssetsStack(app, FIRST_CHAT_ASSETS_STACK_NAME, {
    env,
    terminationProtection: true,
    cfg: {
      envName: 'preview',
      appHost: 'portfolio-preview.app.capiro.ai',
      rootDomain: 'portfolio-preview.app.capiro.ai',
      protectFromDestroy: true,
    },
  });
  const guard = new FirstChatCoreGuardStack(
    app,
    FIRST_CHAT_CORE_GUARD_STACK_NAME,
    binding.listener.guardPriority,
  );
  const service = new FirstChatCoreServiceStack(
    app,
    'Capiro-Preview-First-Chat-Core',
    binding,
    assets,
  );
  service.addStackDependency(guard);
  return { app, guard, service, assets, binding };
}
