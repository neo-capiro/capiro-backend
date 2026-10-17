import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

// This is a separate, held service. The drifted live ComputeStack and its
// production API service are not owned or updated by this composition.
export const FIRST_CHAT_CORE_SOURCE = '6542f5b089656b6d255465edd464d06c2a0b408f';
export const FIRST_CHAT_CORE_IMAGE_DIGEST =
  'sha256:722a483259ebb5e9162b9294c26895bafa890fcfee45dc927ff1d2ec35fa071b';
export const FIRST_CHAT_CORE_HOST = 'first-chat-preview.app-dev.capiro.ai';
export const FIRST_CHAT_CORE_GUARD_STACK_NAME = 'Capiro-Preview-First-Chat-Core-Guard';
export const FIRST_CHAT_CORE_GUARD_RULE_EXPORT =
  'Capiro-Preview-First-Chat-Core-Guard-RuleArn';
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
  // Attached ISSUED certificate covering this host:
  // arn:aws:acm:us-east-1:967807252336:certificate/70b04aad-4971-4bba-81a8-30da1b1d97b5.
  // The listener's default *.capiro.ai certificate does not cover this host.
  dbHost:
    'capiro-dev-data-auroracluster23d869c0-ltmz40k47ewv.cluster-csryw28ai752.us-east-1.rds.amazonaws.com',
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
  imageDigest: typeof FIRST_CHAT_CORE_IMAGE_DIGEST;
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
    record.imageDigest !== FIRST_CHAT_CORE_IMAGE_DIGEST
  ) {
    throw new Error('Exact PR48 source and qualified Core image digest required');
  }
  return record as unknown as FirstChatCoreImageBinding;
}

/** Independent, retained host guard. It must be complete before the service stack. */
export class FirstChatCoreGuardStack extends cdk.Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id, { env });
    const guard = new elb.CfnListenerRule(this, 'RejectOtherPreviewHostTraffic', {
      listenerArn: live.listenerArn,
      priority: 4,
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
    new cdk.CfnOutput(this, 'PreviewHostGuardRuleArn', {
      value: guard.ref,
      exportName: FIRST_CHAT_CORE_GUARD_RULE_EXPORT,
    });
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
    const appCredential = secrets.Secret.fromSecretAttributes(this, 'ExistingAppCredential', {
      secretCompleteArn: live.dbAppSecretArn,
    });
    const clerk = secrets.Secret.fromSecretAttributes(this, 'ExistingClerkCredential', {
      secretCompleteArn: live.clerkSecretArn,
    });
    const clerkWebhook = secrets.Secret.fromSecretAttributes(this, 'ExistingClerkWebhook', {
      secretCompleteArn: live.clerkWebhookSecretArn,
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
    serveExecutionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: [live.dataKeyArn, live.secretsKeyArn],
      conditions: {
        StringEquals: { 'kms:ViaService': 'secretsmanager.us-east-1.amazonaws.com' },
      },
    }));
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
      healthCheck: {
        command: ['CMD-SHELL', 'wget -q -O /dev/null http://127.0.0.1:4000/health || exit 1'],
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
      environment: {
        NODE_ENV: 'production',
        DATABASE_URL: '',
        DB_HOST: live.dbHost,
        DB_PORT: '5432',
        DB_NAME: 'capiro',
        CLERK_JWT_ISSUER: live.clerkIssuer,
        WEB_ORIGIN: 'https://portfolio-preview.app.capiro.ai',
        RELEASE_SHA: FIRST_CHAT_CORE_SOURCE,
        // PR48 boots the full AppModule. Explicitly disable its worker and
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
    const guardRuleArn = cdk.Fn.importValue(FIRST_CHAT_CORE_GUARD_RULE_EXPORT);
    // The imported export is a required TargetGroup property, not merely an
    // Output evaluated after provisioning. Both forwards reference this target.
    cdk.Tags.of(target).add('capiro:preview-guard-rule-arn', guardRuleArn);
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
    // per rule. Keep every POST path exact in two rules. The separately owned
    // host-only 404 guard prevents production /api/* fallback on this host.
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
    // This rule admits only the three browser reads in the reviewed frontend
    // source. Regex anchors exclude client descendants and all other methods.
    // It must rank ahead of the independently retained host-only 404 guard.
    new elb.CfnListenerRule(this, 'FirstChatReadsOnly', {
      listenerArn: live.listenerArn,
      priority: 3,
      conditions: [
        { field: 'host-header', hostHeaderConfig: { values: [FIRST_CHAT_CORE_HOST] } },
        {
          field: 'path-pattern',
          pathPatternConfig: {
            regexValues: [
              '^/api/me$',
              '^/api/clients$',
              '^/api/clients/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
            ],
          },
        },
        { field: 'http-request-method', httpRequestMethodConfig: { values: ['GET'] } },
      ],
      actions: [{ type: 'forward', targetGroupArn: target.targetGroupArn }],
    });
    // CloudFormation must resolve an export from the independently completed
    // guard stack. Its rule is not owned by this stack or removed on rollback.
    new cdk.CfnOutput(this, 'RequiredPreviewHostGuardRuleArn', {
      value: guardRuleArn,
    });
    // ECS registration requires the target group to be associated with the
    // listener before CreateService, even while desiredCount is zero.
    service.node.addDependency(firstChatPosts, membershipPost);

    new cdk.CfnOutput(this, 'CoreApiBaseUrl', {
      value: `https://${FIRST_CHAT_CORE_HOST}/api`,
    });
  }
}

/** Deterministic, import-safe source composition. Never deploys by itself. */
export function previewFirstChatCoreApplication(input: unknown, outdir: string) {
  const binding = firstChatCoreImageBinding(input);
  const app = new cdk.App({ outdir });
  const guard = new FirstChatCoreGuardStack(app, FIRST_CHAT_CORE_GUARD_STACK_NAME);
  const service = new FirstChatCoreServiceStack(app, 'Capiro-Preview-First-Chat-Core', binding);
  service.addStackDependency(guard);
  return { app, guard, service, binding };
}
