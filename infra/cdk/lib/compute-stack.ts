import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import { commonTags, type EnvConfig } from './config';
import { ScheduledIngestionJobs } from './constructs/scheduled-ingestion-jobs';
import { INGESTION_JOBS } from './ingestion-schedule';
import type { SecretsStack } from './secrets-stack';
import type { AssetsStack } from './assets-stack';

export interface ComputeStackProps extends cdk.StackProps {
  cfg: EnvConfig;
  vpc: ec2.IVpc;
  albSecurityGroup: ec2.ISecurityGroup;
  serviceSecurityGroup: ec2.ISecurityGroup;
  dbCluster: rds.IDatabaseCluster;
  dbSecret: secretsmanager.ISecret;
  appDbSecret: secretsmanager.ISecret;
  databaseName: string;
  dataKey: kms.IKey;
  secretsStack: SecretsStack;
  certificate: acm.ICertificate;
  apexCertificate: acm.ICertificate;
  hostedZone: route53.IHostedZone;
  assetsStack: AssetsStack;
}

/**
 * ECS + ALB + ECR + WAF.
 *
 * One ALB serves both web and API via path-based routing on the same hostname:
 *   - Default action → web target group (nginx serving the SPA)
 *   - /api/* and /webhooks/* → API target group (NestJS)
 *
 * Routes for both `app.capiro.ai` and `*.app.capiro.ai` (tenant vanity URLs)
 * land at the same listener. The web container ignores the host header at
 * the nginx layer; the API middleware reads it for tenant resolution.
 *
 * Migrations are a separate task definition (`apiMigrateTaskDefinition`) the
 * operator runs explicitly via `aws ecs run-task` BEFORE rolling out a new
 * API image. Forward-only, expand-then-contract.
 */
export class ComputeStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly apiRepo: ecr.IRepository;
  public readonly webRepo: ecr.IRepository;
  public readonly marketingRepo: ecr.IRepository;
  public readonly workspaceRepo: ecr.IRepository;
  public readonly alb: elb.ApplicationLoadBalancer;
  public readonly apiService: ecs.FargateService;
  public readonly webService: ecs.FargateService;
  public readonly marketingService: ecs.FargateService;
  public readonly workspaceService: ecs.FargateService;
  public readonly apiMigrateTaskDefinition: ecs.FargateTaskDefinition;
  public readonly apiBootstrapRolesTaskDefinition: ecs.FargateTaskDefinition;
  public readonly apiEmbedBackfillTaskDefinition: ecs.FargateTaskDefinition;
  public readonly workspaceMigrateTaskDefinition: ecs.FargateTaskDefinition;
  public readonly apiTargetGroup: elb.ApplicationTargetGroup;
  public readonly webTargetGroup: elb.ApplicationTargetGroup;
  public readonly marketingTargetGroup: elb.ApplicationTargetGroup;
  public readonly workspaceTargetGroup: elb.ApplicationTargetGroup;
  public readonly meriv2OrchestratorRepo: ecr.IRepository;
  public readonly meriv2OrchestratorService: ecs.FargateService;
  public readonly meriv2OrchestratorTargetGroup: elb.ApplicationTargetGroup;
  public readonly apiStrategyRepo: ecr.IRepository;
  public readonly apiStrategyService: ecs.FargateService;
  public readonly apiStrategyMigrateTaskDefinition: ecs.FargateTaskDefinition;
  public readonly apiStrategyTargetGroup: elb.ApplicationTargetGroup;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);
    const {
      cfg,
      vpc,
      albSecurityGroup,
      serviceSecurityGroup,
      dbCluster,
      dbSecret,
      appDbSecret,
      databaseName,
      dataKey,
      secretsStack,
      certificate,
      apexCertificate,
      hostedZone,
      assetsStack,
    } = props;

    Object.entries(commonTags(cfg)).forEach(([k, v]) => cdk.Tags.of(this).add(k, v));

    // ------------------------------------------------------------------ Cross-stack imports
    // Re-import secrets + KMS keys by ARN so CDK treats them as external to
    // this stack. Without this, helpers like `ecs.Secret.fromSecretsManager`
    // and `secret.grantRead` try to mutate the resource policy in the owning
    // stack, which would force a Data/Secrets → Compute dependency and create
    // a cycle.
    const dbSecretImported = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'ImportedDbSecret',
      dbSecret.secretArn,
    );
    const appDbSecretImported = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'ImportedAppDbSecret',
      appDbSecret.secretArn,
    );
    const clerkSecretKeyImported = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'ImportedClerkSecretKey',
      secretsStack.clerkSecretKey.secretArn,
    );
    const clerkWebhookImported = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'ImportedClerkWebhook',
      secretsStack.clerkWebhookSigningSecret.secretArn,
    );
    const clerkPubKeyImported = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'ImportedClerkPubKey',
      secretsStack.clerkPublishableKey.secretArn,
    );
    // Wire the REAL, operator-populated GovInfo key: capiro/<env>/govinfo_api_key
    // (default-KMS). NOTE: SecretsStack also defines a separate placeholder
    // (/capiro/<env>/govinfo/api-key = "REPLACE_ME", CMK-encrypted) that was never
    // populated — wiring that one in hands the containers a bogus key, so we
    // deliberately import the populated secret by name instead of secretsStack.govInfoApiKey.
    const govInfoApiKeyImported = secretsmanager.Secret.fromSecretNameV2(
      this,
      'ImportedGovInfoApiKey',
      `capiro/${cfg.envName}/govinfo_api_key`,
    );
    // LegiStorm directory-refresh key. Provisioned out-of-band (Phase 0) and
    // consumed ONLY by the scheduled sync task (apiSyncSecrets below); never by
    // the serve or migrate task defs. Imported by name like the GovInfo key so
    // ecs.Secret auto-grants the sync execution role at container-add time.
    const legistormApiKeyImported = secretsmanager.Secret.fromSecretNameV2(
      this,
      'ImportedLegistormApiKey',
      `capiro/${cfg.envName}/legistorm-api-key`,
    );
    // Census ACS API key (District Nexus Phase 0). Already provisioned
    // out-of-band as capiro/<env>/census_api_key (underscore, not hyphen —
    // matches the real secret name); consumed ONLY by the scheduled
    // sync-census task (apiSyncSecrets below), never by the serve or migrate
    // task defs. Imported by name like the LegiStorm key above so
    // ecs.Secret auto-grants the sync execution role at container-add time.
    const censusApiKeyImported = secretsmanager.Secret.fromSecretNameV2(
      this,
      'ImportedCensusApiKey',
      `capiro/${cfg.envName}/census_api_key`,
    );

    // Microsoft 365 Graph OAuth + token-at-rest crypto. These secrets are
    // provisioned out-of-band and imported by complete ARN when available. ECS
    // task secret injection requires complete ARNs for these slash-delimited
    // names; partial ARNs caused new API tasks to fail before startup.
    const microsoftClientIdSecret = importExternalSecret(
      this,
      'ImportedMicrosoftClientId',
      `capiro/${cfg.envName}/microsoft-client-id`,
      cfg.externalSecretArns?.microsoftClientId,
    );
    const microsoftTenantIdSecret = importExternalSecret(
      this,
      'ImportedMicrosoftTenantId',
      `capiro/${cfg.envName}/microsoft-tenant-id`,
      cfg.externalSecretArns?.microsoftTenantId,
    );
    const microsoftCertThumbprintSecret = importExternalSecret(
      this,
      'ImportedMicrosoftCertThumbprint',
      `capiro/${cfg.envName}/microsoft-cert-thumbprint`,
      cfg.externalSecretArns?.microsoftCertThumbprint,
    );
    const microsoftCertPrivateKeySecret = importExternalSecret(
      this,
      'ImportedMicrosoftCertPrivateKey',
      `capiro/${cfg.envName}/microsoft-cert-private-key`,
      cfg.externalSecretArns?.microsoftCertPrivateKey,
    );
    const oauthTokenEncryptionKeySecret = importExternalSecret(
      this,
      'ImportedOauthTokenEncryptionKey',
      `capiro/${cfg.envName}/oauth-token-encryption-key`,
      cfg.externalSecretArns?.oauthTokenEncryptionKey,
    );
    const oauthStateSecret = importExternalSecret(
      this,
      'ImportedOauthStateSecret',
      `capiro/${cfg.envName}/oauth-state-secret`,
      cfg.externalSecretArns?.oauthStateSecret,
    );
    const notesEncryptionKeySecret = importExternalSecret(
      this,
      'ImportedNotesEncryptionKey',
      `capiro/${cfg.envName}/notes-encryption-key`,
      cfg.externalSecretArns?.notesEncryptionKey,
    );
    // Dedicated AES key for per-tenant AI provider keys (tenant_ai_credentials).
    // Deliberately distinct from the notes/OAuth keys so a key compromise on
    // either side stays contained. Covered by the capiro/<env>/* exec-role grant.
    const aiCredentialEncryptionKeySecret = importExternalSecret(
      this,
      'ImportedAiCredentialEncryptionKey',
      `capiro/${cfg.envName}/ai-credential-encryption-key`,
      cfg.externalSecretArns?.aiCredentialEncryptionKey,
    );
    const openaiApiKeySecret = importExternalSecret(
      this,
      'ImportedOpenAiApiKey',
      `capiro/${cfg.envName}/openai-api-key`,
      cfg.externalSecretArns?.openaiApiKey,
    );
    const anthropicApiKeySecret = importExternalSecret(
      this,
      'ImportedAnthropicApiKey',
      `capiro/${cfg.envName}/anthropic-api-key`,
      cfg.externalSecretArns?.anthropicApiKey,
    );
    // SAM.gov API key for Step 33 DoD solicitation personnel sync
    // (sync-sam-personnel). Provisioned out-of-band at
    // capiro/<env>/sam-gov-api-key (no leading slash; covered by the existing
    // capiro/<env>/* exec-role grant). Consumed as SAM_GOV_API_KEY under the
    // migrate task def.
    const samGovApiKeySecret = importExternalSecret(
      this,
      'ImportedSamGovApiKey',
      `capiro/${cfg.envName}/sam-gov-api-key`,
      cfg.externalSecretArns?.samGovApiKey,
    );
    // Recall.ai meeting-notetaker bot (docs/plans/meeting-notetaker-bot-plan.md,
    // SERVE task only — dispatch + webhook processing both run there; migrations
    // never create bots). The webhook signing secret is GATED on its ARN being
    // present in config: it is created together with the Recall dashboard
    // webhook endpoint, and wiring a not-yet-existing secret would make every
    // new serve task fail to start ("unable to pull secrets" → rollback).
    const recallApiKeySecret = importExternalSecret(
      this,
      'ImportedRecallApiKey',
      `capiro/${cfg.envName}/recall-api-key`,
      cfg.externalSecretArns?.recallApiKey,
    );
    const recallWebhookSecret = cfg.externalSecretArns?.recallWebhookSecret
      ? importExternalSecret(
          this,
          'ImportedRecallWebhookSecret',
          `capiro/${cfg.envName}/recall-webhook-secret`,
          cfg.externalSecretArns.recallWebhookSecret,
        )
      : undefined;

    // Google Workspace OAuth (engagement Gmail/Calendar integration + the
    // onboarding IT-admin test-connect). Both live out-of-band today; see
    // config.ts externalSecretArns.googleClientId for provenance.
    const googleClientIdSecret = importExternalSecret(
      this,
      'ImportedGoogleClientId',
      `capiro/${cfg.envName}/GOOGLE_CLIENT_ID`,
      cfg.externalSecretArns?.googleClientId,
    );
    const googleClientSecretSecret = importExternalSecret(
      this,
      'ImportedGoogleClientSecret',
      `capiro/${cfg.envName}/GOOGLE_CLIENT_SECRET`,
      cfg.externalSecretArns?.googleClientSecret,
    );

    // ------------------------------------------------------------------ ECR
    // Repos are pre-created out-of-band so images can be pushed BEFORE the
    // first ComputeStack deploy (otherwise the Fargate service has no image
    // to pull on first boot). CDK imports the existing repos and references
    // their `:latest` tag for the task definitions.
    this.apiRepo = ecr.Repository.fromRepositoryName(this, 'ApiRepo', `capiro/${cfg.envName}/api`);
    this.webRepo = ecr.Repository.fromRepositoryName(this, 'WebRepo', `capiro/${cfg.envName}/web`);
    this.workspaceRepo = ecr.Repository.fromRepositoryName(
      this,
      'WorkspaceRepo',
      `capiro/${cfg.envName}/workspace`,
    );
    this.meriv2OrchestratorRepo = ecr.Repository.fromRepositoryName(
      this,
      'MeriV2OrchestratorRepo',
      `capiro/${cfg.envName}/meriv2-orchestrator`,
    );
    this.apiStrategyRepo = ecr.Repository.fromRepositoryName(
      this,
      'ApiStrategyRepo',
      `capiro/${cfg.envName}/api-strategy`,
    );

    // ------------------------------------------------------------------ ECS cluster
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: `capiro-${cfg.envName}`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      enableFargateCapacityProviders: true,
    });
    this.cluster.addDefaultCloudMapNamespace({
      name: `capiro-${cfg.envName}.local`,
      useForServiceConnect: false,
    });

    // Log groups are RETAIN even in dev, when an ECS service fails its first
    // deploy, CFN rolls back and would otherwise destroy the logs that explain
    // why. Keeping them lets us iterate without losing the failure trail.
    const apiLogGroup = new logs.LogGroup(this, 'ApiLogs', {
      logGroupName: `/capiro/${cfg.envName}/api`,
      retention: cfg.logRetentionDays as unknown as logs.RetentionDays,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // Security-event metric filters on the API log group.
    //
    // Until now the ONLY metric filter in this stack was bound to the sync-jobs
    // log group, so nothing the request path logged could become a CloudWatch
    // metric — a failed de-provisioning or an auth denial was invisible to
    // monitoring (SOC 2 CC7.2). These count the single-line JSON security
    // events emitted by IdentityOutboxService and the tenant guards.
    //
    // NOTE: to apply these to the LIVE stack use `aws logs put-metric-filter`,
    // NOT `cdk deploy Capiro-dev-Compute` — that stack holds dead-ALB values
    // for the app.capiro.ai records and a failed deploy's rollback reverts
    // production DNS (2026-07-25 incident).
    new logs.MetricFilter(this, 'IdentityDeprovisionFailedMetricFilter', {
      logGroup: apiLogGroup,
      metricNamespace: 'Capiro/Security',
      metricName: 'identity.deprovision_failed',
      filterPattern: logs.FilterPattern.literal(
        '{ $.security_event = "identity.deprovision_failed" }',
      ),
      metricValue: '$.count',
      defaultValue: 0,
    });
    new logs.MetricFilter(this, 'AuthDeniedMetricFilter', {
      logGroup: apiLogGroup,
      metricNamespace: 'Capiro/Security',
      metricName: 'auth.denied_count',
      filterPattern: logs.FilterPattern.literal('{ $.security_event = "auth.denied" }'),
      metricValue: '$.count',
      defaultValue: 0,
    });

    const webLogGroup = new logs.LogGroup(this, 'WebLogs', {
      logGroupName: `/capiro/${cfg.envName}/web`,
      retention: cfg.logRetentionDays as unknown as logs.RetentionDays,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const migrateLogGroup = new logs.LogGroup(this, 'ApiMigrateLogs', {
      logGroupName: `/capiro/${cfg.envName}/api-migrate`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cfg.protectFromDestroy ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    // Dedicated log group for the embed-backfill one-shot so a 3-hour LDA run
    // doesn't bury the rest of the api-migrate logs.
    const embedBackfillLogGroup = new logs.LogGroup(this, 'ApiEmbedBackfillLogs', {
      logGroupName: `/capiro/${cfg.envName}/api-embed-backfill`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cfg.protectFromDestroy ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ------------------------------------------------------------------ Task roles
    // Execution role: pulls images from ECR + writes logs + reads ECS-managed secrets.
    // Task role:      what the container code runs as. Grant least-privilege here.
    const apiTaskRole = new iam.Role(this, 'ApiTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Capiro API task role',
    });
    // The capiro.ai SES identity and DKIM Route 53 records are operationally
    // managed so we can preserve the verified identity across Compute stack
    // updates. The API only needs permission to send through those identities.
    const demoRequestDomainIdentityArn = `arn:aws:ses:${this.region}:${this.account}:identity/${cfg.rootDomain}`;

    // Grants below use explicit policy statements rather than `secret.grantRead()`
    // / `key.grantDecrypt()`. The convenience helpers mutate the *resource*
    // policy in the owning stack (Data, Secrets) to add the granted role's
    // ARN, which creates a cross-stack cyclic reference. Identity-only policy
    // statements keep the dependency direction one-way: Compute → Data, Compute
    // → Secrets.
    apiTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [
          dbSecretImported.secretArn,
          appDbSecretImported.secretArn,
          clerkSecretKeyImported.secretArn,
          clerkWebhookImported.secretArn,
          clerkPubKeyImported.secretArn,
          govInfoApiKeyImported.secretArn,
          // Trailing `*` (no preceding dash) matches both the bare name and
          // the auto-generated `-XXXXXX` version suffix Secrets Manager
          // appends to every secret ARN.
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/microsoft-client-id*`,
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/microsoft-tenant-id*`,
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/microsoft-cert-thumbprint*`,
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/microsoft-cert-private-key*`,
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/oauth-token-encryption-key*`,
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/oauth-state-secret*`,
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/notes-encryption-key*`,
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/openai-api-key*`,
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/anthropic-api-key*`,
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/recall-api-key*`,
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/recall-webhook-secret*`,
          // Google Workspace OAuth. UPPER_SNAKE names, unlike every microsoft-*
          // pattern above — see config.ts externalSecretArns.googleClientId.
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/GOOGLE_CLIENT_ID*`,
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/GOOGLE_CLIENT_SECRET*`,
        ],
      }),
    );
    apiTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:DescribeKey'],
        resources: [dataKey.keyArn, secretsStack.secretsKey.keyArn],
      }),
    );
    apiTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: [
          demoRequestDomainIdentityArn,
          `arn:aws:ses:${this.region}:${this.account}:identity/sales@capiro.ai`,
        ],
      }),
    );
    // Bedrock, embeddings pipeline (apps/api/scripts/embed-backfill.ts and
    // future on-write hooks) invokes Titan Text Embeddings v2. Scoped to that
    // specific foundation-model ARN so the role can't reach Claude or
    // other models even if a code path tried.
    apiTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
        ],
      }),
    );

    const webTaskRole = new iam.Role(this, 'WebTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Capiro Web task role',
    });
    // Web only needs to log + (if we add /healthz pinging) the basics.

    // ------------------------------------------------------------------ Task secret bundles
    // The API runs as `capiro_app` (least-privilege, no DDL). Migrations
    // continue to run as the master role because Prisma needs DDL.
    // host/port/dbname come from the master secret (same Aurora cluster);
    // only the username/password switch between the two tasks.
    const apiServeSecrets = {
      CLERK_SECRET_KEY: ecs.Secret.fromSecretsManager(clerkSecretKeyImported),
      CLERK_WEBHOOK_SIGNING_SECRET: ecs.Secret.fromSecretsManager(clerkWebhookImported),
      DB_HOST: ecs.Secret.fromSecretsManager(dbSecretImported, 'host'),
      DB_PORT: ecs.Secret.fromSecretsManager(dbSecretImported, 'port'),
      DB_USER: ecs.Secret.fromSecretsManager(appDbSecretImported, 'username'),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(appDbSecretImported, 'password'),
      MICROSOFT_CLIENT_ID: ecs.Secret.fromSecretsManager(microsoftClientIdSecret),
      MICROSOFT_TENANT_ID: ecs.Secret.fromSecretsManager(microsoftTenantIdSecret),
      MICROSOFT_CERT_THUMBPRINT: ecs.Secret.fromSecretsManager(microsoftCertThumbprintSecret),
      MICROSOFT_CERT_PRIVATE_KEY: ecs.Secret.fromSecretsManager(microsoftCertPrivateKeySecret),
      GOOGLE_CLIENT_ID: ecs.Secret.fromSecretsManager(googleClientIdSecret),
      GOOGLE_CLIENT_SECRET: ecs.Secret.fromSecretsManager(googleClientSecretSecret),
      OAUTH_TOKEN_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(oauthTokenEncryptionKeySecret),
      OAUTH_STATE_SECRET: ecs.Secret.fromSecretsManager(oauthStateSecret),
      NOTES_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(notesEncryptionKeySecret),
      AI_CREDENTIAL_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(aiCredentialEncryptionKeySecret),
      OPENAI_API_KEY: ecs.Secret.fromSecretsManager(openaiApiKeySecret),
      ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(anthropicApiKeySecret),
      GOVINFO_API_KEY: ecs.Secret.fromSecretsManager(govInfoApiKeyImported),
      // Meeting notetaker (serve only — see the import above for the gating).
      RECALL_API_KEY: ecs.Secret.fromSecretsManager(recallApiKeySecret),
      ...(recallWebhookSecret
        ? { RECALL_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(recallWebhookSecret) }
        : {}),
    };
    const apiMigrateSecrets = {
      CLERK_SECRET_KEY: ecs.Secret.fromSecretsManager(clerkSecretKeyImported),
      CLERK_WEBHOOK_SIGNING_SECRET: ecs.Secret.fromSecretsManager(clerkWebhookImported),
      DB_HOST: ecs.Secret.fromSecretsManager(dbSecretImported, 'host'),
      DB_PORT: ecs.Secret.fromSecretsManager(dbSecretImported, 'port'),
      DB_USER: ecs.Secret.fromSecretsManager(dbSecretImported, 'username'),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecretImported, 'password'),
      // GovInfo sync scripts (bills/reports/laws) run under the migrate task def.
      GOVINFO_API_KEY: ecs.Secret.fromSecretsManager(govInfoApiKeyImported),
      // Step 33 SAM.gov personnel sync (sync-sam-personnel) also runs here.
      SAM_GOV_API_KEY: ecs.Secret.fromSecretsManager(samGovApiKeySecret),
    };
    // Scheduled sync task secrets = migrate bundle + the LegiStorm key + the
    // Census key. Kept separate from apiServeSecrets so the long-lived
    // API/web tasks never receive LEGISTORM_API_KEY/CENSUS_API_KEY (only the
    // ephemeral sync task does).
    const apiSyncSecrets = {
      ...apiMigrateSecrets,
      LEGISTORM_API_KEY: ecs.Secret.fromSecretsManager(legistormApiKeyImported),
      CENSUS_API_KEY: ecs.Secret.fromSecretsManager(censusApiKeyImported),
    };

    const apiSharedEnv: Record<string, string> = {
      NODE_ENV: cfg.envName === 'dev' ? 'development' : 'production',
      LOG_LEVEL: 'info',
      API_PORT: '4000',
      API_BIND_HOST: '0.0.0.0',
      DB_NAME: databaseName,
      // CLERK_JWT_ISSUER is set per-env from config; absent during dev
      // bootstrap (before Clerk instance is created) so the API skips issuer
      // validation, acceptable until clerkJwtIssuer is filled in config.ts.
      ...(cfg.clerkJwtIssuer ? { CLERK_JWT_ISSUER: cfg.clerkJwtIssuer } : {}),
      WEB_ORIGIN: `https://${cfg.appHost},https://${cfg.wildcardHost.replace('*', 'acmelobby')}`,
      ASSETS_BUCKET: assetsStack.bucket.bucketName,
      AWS_REGION_DEFAULT: this.region,
      GOVINFO_CACHE_BUCKET: `capiro-govinfo-cache-${this.account}-${this.region}`,
      APP_SIGN_IN_URL: `https://${cfg.appHost}/sign-in`,
      MICROSOFT_REDIRECT_URI: `https://${cfg.appHost}/api/engagement/integrations/microsoft/callback`,
      MICROSOFT_GRAPH_NOTIFICATION_URL: `https://${cfg.appHost}/api/engagement/integrations/microsoft/notifications`,
      // Mirrors MICROSOFT_REDIRECT_URI above. Currently UNSET in the live task
      // def, so the API runs on the config.schema.ts prod default — correct for
      // app.capiro.ai, silently wrong for any other appHost (e.g. staging).
      GOOGLE_REDIRECT_URI: `https://${cfg.appHost}/api/engagement/integrations/google/callback`,
      // MeriV2 grounding subsystem — codified to match the LIVE prod task def
      // (these three are currently applied OUT-OF-BAND, so a cdk deploy would
      // silently DROP them and regress prod: MeriV2 would turn OFF and the Deep
      // Research auditor would fall back to its code-default 'off', un-enforcing
      // deliverable grounding). Code defaults: MERIV2_ENABLED off, MERI_AUDITOR_MODE
      // 'off'. Chat stays observe-only even under enforce (ADR-2); enforce only
      // gates the deliverable surfaces (research/outreach/alert-memo).
      // NOTE: the api task def carries OTHER out-of-band env too (billing/Stripe,
      // CLIO_SANDBOX_URL, outreach, notetaker, MCP OAuth redirect) that is NOT yet
      // codified here — see infra/cdk/DRIFT-FINDINGS.md. The Compute stack is in
      // UPDATE_ROLLBACK_FAILED and `cdk deploy` is frozen, so this block is
      // defensive for the eventual maintenance window, not a live-effective change.
      MERIV2_ENABLED: 'true',
      MERIV2_ORCHESTRATOR_URL: `https://${cfg.appHost}`,
      MERI_AUDITOR_MODE: 'enforce',
      // Learned-memory recall backing (Phase 1 SSOT cutover). Applied OUT-OF-BAND
      // on the live api task def and verified 2026-07-18; the code default is
      // 'clio' (config.schema.ts), so a cdk deploy WITHOUT this would silently
      // revert union→clio and re-expose the OpenAI-embeddings recall SPOF. 'union'
      // = clio ∪ the Titan-embedded memory_items projection (a provable superset;
      // projection failures fail-open to clio) — non-degrading and resilient to an
      // OpenAI outage. Per-tenant opt-out: clioFeatureFlags.meriMemoryRecallSource.
      MEMORY_RECALL_SOURCE: 'union',
      // Legislative Districts API base URL (WS-B, LegiStorm gaps/enrichment
      // plan) — explicit here so the sync task's env is self-documenting;
      // sync-legistorm-districts.ts ALSO hardcodes this exact value as its own
      // fallback, so an incomplete deploy of this line never sends a districts
      // request to the Congressional API's base URL instead. Same as the
      // MEMORY_RECALL_SOURCE block above: the Compute stack is in
      // UPDATE_ROLLBACK_FAILED and `cdk deploy` is frozen, so this line is
      // defensive for the eventual maintenance window, not a live-effective
      // change until then.
      LEGISTORM_DISTRICTS_BASE_URL: 'https://api.legistorm.com/v2.023.07/legislative_districts',
    };

    // Identity-policy-only grant on the API task role for the assets bucket.
    assetsStack.grantApiAccess(apiTaskRole);

    // Read-only access to the pre-existing Hill directory data bucket. The
    // DirectoryService gunzips JSON snapshots out of this bucket on demand;
    // the bucket itself is provisioned out-of-band (not owned by this CDK app).
    apiTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: ['arn:aws:s3:::updated-directory-967807252336-us-east-1/*'],
      }),
    );
    apiTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: ['arn:aws:s3:::updated-directory-967807252336-us-east-1'],
      }),
    );
    // Directory safe-refresh WRITE (Phase 3): the sync task publishes new immutable
    // snapshots + pointers. Scoped to snapshots/, pointers/, and LATEST.json ONLY —
    // NEVER overlays/ (Capiro-authored bios/press) — and PutObject ONLY, NEVER
    // DeleteObject, enforcing the plan's preservation contract in IAM. On the shared
    // apiTaskRole (mirrors the govinfo-cache write below); the serve task's code
    // never exercises this, and the critical no-overlay-write / no-delete guarantees
    // hold regardless of which task assumes the role.
    apiTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [
          'arn:aws:s3:::updated-directory-967807252336-us-east-1/UPDATED DIRECTORY/snapshots/*',
          'arn:aws:s3:::updated-directory-967807252336-us-east-1/UPDATED DIRECTORY/pointers/*',
          'arn:aws:s3:::updated-directory-967807252336-us-east-1/UPDATED DIRECTORY/LATEST.json',
        ],
      }),
    );

    // GovInfo PDF cache bucket (committee reports, public laws). GovInfoService
    // reads cached PDFs and writes fresh ones under pdfs/. Bucket is provisioned
    // out-of-band as capiro-govinfo-cache-<account>-<region>.
    const govInfoCacheBucketArn = `arn:aws:s3:::capiro-govinfo-cache-${this.account}-${this.region}`;
    apiTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: [`${govInfoCacheBucketArn}/*`],
      }),
    );

    // ------------------------------------------------------------------ API task definition + service
    const apiTaskDef = new ecs.FargateTaskDefinition(this, 'ApiTaskDef', {
      family: `capiro-${cfg.envName}-api`,
      cpu: cfg.apiCpu,
      memoryLimitMiB: cfg.apiMemoryMib,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskRole: apiTaskRole,
    });

    // The execution role (auto-created by FargateTaskDefinition) is what ECS
    // uses to fetch images, write logs, and resolve `secrets:` references at
    // task startup. For OWN-stack secrets, CDK auto-grants kms:Decrypt; for
    // IMPORTED secrets it cannot, so we add it explicitly. Without these the
    // task fails to start with "ResourceInitializationError: unable to pull
    // secrets" and ECS deployment-circuit-breaker rolls the service back.
    // ARN patterns for the out-of-band Microsoft, OAuth, and AI secrets. The trailing
    // `*` (no preceding dash) matches BOTH the bare name (which `fromSecretNameV2`
    // bakes into the task definition) AND the version-suffixed form Secrets
    // Manager appends to every secret ARN.
    const externalRuntimeSecretArnPatterns = [
      `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/microsoft-client-id*`,
      `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/microsoft-tenant-id*`,
      `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/microsoft-cert-thumbprint*`,
      `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/microsoft-cert-private-key*`,
      `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/oauth-token-encryption-key*`,
      `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/oauth-state-secret*`,
      `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/notes-encryption-key*`,
      `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/openai-api-key*`,
      `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/anthropic-api-key*`,
      // GovInfo key: the operator-populated secret is capiro/<env>/govinfo_api_key
      // (default-KMS). Match its versioned ARN form so the exec role can read it.
      `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/govinfo_api_key*`,
      // SAM.gov key provisioned out-of-band (capiro/<env>/sam-gov-api-key).
      `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/sam-gov-api-key*`,
      // Recall.ai meeting-notetaker secrets (serve task).
      `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/recall-api-key*`,
      `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/recall-webhook-secret*`,
      // Google Workspace OAuth. UPPER_SNAKE names — the lower-kebab patterns
      // above do NOT match these, and a mismatch means "unable to pull secrets"
      // and a circuit-breaker rollback on the next task start.
      `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/GOOGLE_CLIENT_ID*`,
      `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/GOOGLE_CLIENT_SECRET*`,
    ];

    grantSecretsAndKmsToExecutionRole(
      apiTaskDef,
      [
        dbSecretImported.secretArn,
        clerkSecretKeyImported.secretArn,
        clerkWebhookImported.secretArn,
        ...externalRuntimeSecretArnPatterns,
      ],
      [dataKey.keyArn, secretsStack.secretsKey.keyArn],
    );

    const apiContainer = apiTaskDef.addContainer('api', {
      image: ecs.ContainerImage.fromEcrRepository(this.apiRepo, 'latest'),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({ logGroup: apiLogGroup, streamPrefix: 'api' }),
      environment: apiSharedEnv,
      secrets: apiServeSecrets,
      readonlyRootFilesystem: true,
      // Container exposes 4000; ALB target group hits /health.
      portMappings: [{ containerPort: 4000, protocol: ecs.Protocol.TCP }],
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:4000/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    this.apiService = new ecs.FargateService(this, 'ApiService', {
      cluster: this.cluster,
      taskDefinition: apiTaskDef,
      serviceName: `capiro-${cfg.envName}-api`,
      desiredCount: cfg.apiDesiredCount,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [serviceSecurityGroup as ec2.SecurityGroup],
      assignPublicIp: false,
      enableExecuteCommand: cfg.envName !== 'prod', // prod uses session manager via separate path
      cloudMapOptions: { name: 'api' },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    const apiScaling = this.apiService.autoScaleTaskCount({
      minCapacity: cfg.apiDesiredCount,
      maxCapacity: cfg.apiMaxCount,
    });
    apiScaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 60,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(30),
    });

    // ------------------------------------------------------------------ Web task definition + service
    const webTaskDef = new ecs.FargateTaskDefinition(this, 'WebTaskDef', {
      family: `capiro-${cfg.envName}-web`,
      cpu: cfg.webCpu,
      memoryLimitMiB: cfg.webMemoryMib,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskRole: webTaskRole,
    });

    grantSecretsAndKmsToExecutionRole(
      webTaskDef,
      [clerkPubKeyImported.secretArn],
      [secretsStack.secretsKey.keyArn],
    );

    webTaskDef.addContainer('web', {
      image: ecs.ContainerImage.fromEcrRepository(this.webRepo, 'latest'),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({ logGroup: webLogGroup, streamPrefix: 'web' }),
      environment: {
        // Read by the web container's entrypoint to generate /runtime-config.js
        // at boot. Same image promotes through environments.
        APP_ENV: cfg.envName,
        API_BASE_URL: `https://${cfg.appHost}`,
        // District Nexus basemap (plan §4.4). OpenFreeMap Positron is key-free,
        // has no request limits and permits commercial use, so it is safe as a
        // shipped default. Declared here so the style can be repointed without
        // rebuilding the image. The web app falls back to this same URL when
        // the var is absent and never crashes the route on a style failure.
        MAP_STYLE_URL: 'https://tiles.openfreemap.org/styles/positron',
        MAP_STYLE_ATTRIBUTION: '© OpenStreetMap contributors',
      },
      secrets: {
        CLERK_PUBLISHABLE_KEY: ecs.Secret.fromSecretsManager(clerkPubKeyImported),
      },
      readonlyRootFilesystem: false, // nginx writes pid/temp files; locked down via tmpfs in Dockerfile
      portMappings: [{ containerPort: 8080, protocol: ecs.Protocol.TCP }],
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:8080/healthz || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(15),
      },
    });

    this.webService = new ecs.FargateService(this, 'WebService', {
      cluster: this.cluster,
      taskDefinition: webTaskDef,
      serviceName: `capiro-${cfg.envName}-web`,
      desiredCount: cfg.webDesiredCount,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [serviceSecurityGroup as ec2.SecurityGroup],
      assignPublicIp: false,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    const webScaling = this.webService.autoScaleTaskCount({
      minCapacity: cfg.webDesiredCount,
      maxCapacity: cfg.webMaxCount,
    });
    webScaling.scaleOnCpuUtilization('CpuScaling', { targetUtilizationPercent: 60 });

    // ------------------------------------------------------------------ Marketing task definition + service
    // Static landing page served by nginx at the apex `capiro.ai`. Same
    // hardening profile as the web container.
    const marketingLogGroup = new logs.LogGroup(this, 'MarketingLogs', {
      logGroupName: `/capiro/${cfg.envName}/marketing`,
      retention: cfg.logRetentionDays as unknown as logs.RetentionDays,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const marketingTaskRole = new iam.Role(this, 'MarketingTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Capiro marketing task role',
    });

    const marketingTaskDef = new ecs.FargateTaskDefinition(this, 'MarketingTaskDef', {
      family: `capiro-${cfg.envName}-marketing`,
      cpu: cfg.marketingCpu,
      memoryLimitMiB: cfg.marketingMemoryMib,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskRole: marketingTaskRole,
    });

    this.marketingRepo = ecr.Repository.fromRepositoryName(
      this,
      'MarketingRepo',
      `capiro/${cfg.envName}/marketing`,
    );

    marketingTaskDef.addContainer('marketing', {
      image: ecs.ContainerImage.fromEcrRepository(this.marketingRepo, 'latest'),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({ logGroup: marketingLogGroup, streamPrefix: 'marketing' }),
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

    this.marketingService = new ecs.FargateService(this, 'MarketingService', {
      cluster: this.cluster,
      taskDefinition: marketingTaskDef,
      serviceName: `capiro-${cfg.envName}-marketing`,
      desiredCount: cfg.marketingDesiredCount,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [serviceSecurityGroup as ec2.SecurityGroup],
      assignPublicIp: false,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    const marketingScaling = this.marketingService.autoScaleTaskCount({
      minCapacity: cfg.marketingDesiredCount,
      maxCapacity: cfg.marketingMaxCount,
    });
    marketingScaling.scaleOnCpuUtilization('MarketingCpuScaling', {
      targetUtilizationPercent: 60,
    });

    // ------------------------------------------------------------------ Workspace engine service
    // Standalone document-builder engine on its own ECR repo + Fargate service.
    // Reuses the SHARED Aurora cluster (owns only ws_* tables) and the SAME
    // Clerk JWT + AI provider secrets as the API. Routed via the ALB at
    // /workspace-api/* (listener rule below). Web SPA stays in the web service.
    const workspaceLogGroup = new logs.LogGroup(this, 'WorkspaceLogs', {
      logGroupName: `/capiro/${cfg.envName}/workspace`,
      retention: cfg.logRetentionDays as unknown as logs.RetentionDays,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const workspaceMigrateLogGroup = new logs.LogGroup(this, 'WorkspaceMigrateLogs', {
      logGroupName: `/capiro/${cfg.envName}/workspace-migrate`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cfg.protectFromDestroy ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    const workspaceTaskRole = new iam.Role(this, 'WorkspaceTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Capiro Workspace engine task role',
    });
    // Identity-only secret + KMS grants (same cycle-avoidance pattern as the
    // API task role). The engine reads the same Clerk + AI provider secrets.
    workspaceTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [
          dbSecretImported.secretArn,
          appDbSecretImported.secretArn,
          clerkSecretKeyImported.secretArn,
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/openai-api-key*`,
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/anthropic-api-key*`,
          aiCredentialEncryptionKeySecret.secretArn,
        ],
      }),
    );
    workspaceTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:DescribeKey'],
        resources: [dataKey.keyArn, secretsStack.secretsKey.keyArn],
      }),
    );

    // Serve secrets: app DB user (least-privilege, no DDL) + Clerk + AI keys.
    const workspaceServeSecrets = {
      CLERK_SECRET_KEY: ecs.Secret.fromSecretsManager(clerkSecretKeyImported),
      DB_HOST: ecs.Secret.fromSecretsManager(dbSecretImported, 'host'),
      DB_PORT: ecs.Secret.fromSecretsManager(dbSecretImported, 'port'),
      DB_USER: ecs.Secret.fromSecretsManager(appDbSecretImported, 'username'),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(appDbSecretImported, 'password'),
      OPENAI_API_KEY: ecs.Secret.fromSecretsManager(openaiApiKeySecret),
      ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(anthropicApiKeySecret),
      // Tenant-scoped AI keys: decrypt BYO Anthropic keys from
      // tenant_ai_credentials (same envelope scheme + key as the API).
      AI_CREDENTIAL_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(aiCredentialEncryptionKeySecret),
    };
    // Migrate secrets: master DB role (needs DDL for prisma migrate deploy).
    const workspaceMigrateSecrets = {
      DB_HOST: ecs.Secret.fromSecretsManager(dbSecretImported, 'host'),
      DB_PORT: ecs.Secret.fromSecretsManager(dbSecretImported, 'port'),
      DB_USER: ecs.Secret.fromSecretsManager(dbSecretImported, 'username'),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecretImported, 'password'),
    };
    const workspaceSharedEnv: Record<string, string> = {
      NODE_ENV: cfg.envName === 'dev' ? 'development' : 'production',
      LOG_LEVEL: 'info',
      WORKSPACE_PORT: '4200',
      WORKSPACE_MODEL: 'claude-sonnet-4-6',
      DB_NAME: databaseName,
      ...(cfg.clerkJwtIssuer ? { CLERK_JWT_ISSUER: cfg.clerkJwtIssuer } : {}),
      WEB_ORIGIN: `https://${cfg.appHost}`,
    };

    const workspaceTaskDef = new ecs.FargateTaskDefinition(this, 'WorkspaceTaskDef', {
      family: `capiro-${cfg.envName}-workspace`,
      cpu: cfg.workspaceCpu,
      memoryLimitMiB: cfg.workspaceMemoryMib,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskRole: workspaceTaskRole,
    });
    grantSecretsAndKmsToExecutionRole(
      workspaceTaskDef,
      [
        dbSecretImported.secretArn,
        appDbSecretImported.secretArn,
        clerkSecretKeyImported.secretArn,
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/openai-api-key*`,
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:capiro/${cfg.envName}/anthropic-api-key*`,
        aiCredentialEncryptionKeySecret.secretArn,
      ],
      [dataKey.keyArn, secretsStack.secretsKey.keyArn],
    );
    workspaceTaskDef.addContainer('workspace', {
      image: ecs.ContainerImage.fromEcrRepository(this.workspaceRepo, 'latest'),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({ logGroup: workspaceLogGroup, streamPrefix: 'workspace' }),
      environment: workspaceSharedEnv,
      secrets: workspaceServeSecrets,
      readonlyRootFilesystem: false,
      portMappings: [{ containerPort: 4200, protocol: ecs.Protocol.TCP }],
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:4200/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    this.workspaceService = new ecs.FargateService(this, 'WorkspaceService', {
      cluster: this.cluster,
      taskDefinition: workspaceTaskDef,
      serviceName: `capiro-${cfg.envName}-workspace`,
      desiredCount: cfg.workspaceDesiredCount,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [serviceSecurityGroup as ec2.SecurityGroup],
      assignPublicIp: false,
      enableExecuteCommand: cfg.envName !== 'prod',
      cloudMapOptions: { name: 'workspace' },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });
    const workspaceScaling = this.workspaceService.autoScaleTaskCount({
      minCapacity: cfg.workspaceDesiredCount,
      maxCapacity: cfg.workspaceMaxCount,
    });
    workspaceScaling.scaleOnCpuUtilization('WorkspaceCpuScaling', {
      targetUtilizationPercent: 60,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(30),
    });

    // ---------------------------------------------------------- MeriV2 orchestrator
    // Option B strangler-fig service on its own ECR repo + Fargate service.
    // Reuses the SHARED Aurora cluster (queries via api-delegation + a User
    // lookup; owns NO tables) and the SAME Clerk JWT secret as the API. Routed
    // via the ALB at /meri-api/* (listener rule below). Existing surfaces are
    // untouched (SC0.2); the meriv2.* feature flags ship OFF.
    const meriv2OrchestratorLogGroup = new logs.LogGroup(this, 'MeriV2OrchestratorLogs', {
      logGroupName: `/capiro/${cfg.envName}/meriv2-orchestrator`,
      retention: cfg.logRetentionDays as unknown as logs.RetentionDays,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const meriv2OrchestratorTaskRole = new iam.Role(this, 'MeriV2OrchestratorTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Capiro MeriV2 orchestrator task role',
    });
    // Least-privilege: Clerk (verify JWTs) + the app DB role (the MeriContext
    // user lookup; no DDL). No AI provider secrets — Phase-0 tools delegate to
    // the API, which holds those.
    meriv2OrchestratorTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [
          dbSecretImported.secretArn,
          appDbSecretImported.secretArn,
          clerkSecretKeyImported.secretArn,
        ],
      }),
    );
    meriv2OrchestratorTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:DescribeKey'],
        resources: [dataKey.keyArn, secretsStack.secretsKey.keyArn],
      }),
    );

    const meriv2OrchestratorServeSecrets = {
      CLERK_SECRET_KEY: ecs.Secret.fromSecretsManager(clerkSecretKeyImported),
      DB_HOST: ecs.Secret.fromSecretsManager(dbSecretImported, 'host'),
      DB_PORT: ecs.Secret.fromSecretsManager(dbSecretImported, 'port'),
      DB_USER: ecs.Secret.fromSecretsManager(appDbSecretImported, 'username'),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(appDbSecretImported, 'password'),
      // BYOK global fallback for the orchestrator's chat/hearing LLM calls
      // (RequestScopedLlmClient prefers the per-request tenant key and only falls
      // back to this). Previously wired ONLY on the hand-authored
      // meriv2-orchestrator-taskdef.with-anthropic.json — a `cdk deploy` would
      // otherwise ship the orchestrator keyless and 500 every LLM tool. (H2.)
      ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(anthropicApiKeySecret),
    };
    const meriv2OrchestratorSharedEnv: Record<string, string> = {
      NODE_ENV: cfg.envName === 'dev' ? 'development' : 'production',
      // main.ts reads MERIV2_LOG_LEVEL (LOG_LEVEL is inert here); 'log' = no debug
      // spam in prod, matching the live out-of-band task def.
      LOG_LEVEL: 'info',
      MERIV2_LOG_LEVEL: 'log',
      MERIV2_PORT: '4300',
      DB_NAME: databaseName,
      ...(cfg.clerkJwtIssuer ? { CLERK_JWT_ISSUER: cfg.clerkJwtIssuer } : {}),
      WEB_ORIGIN: `https://${cfg.appHost}`,
      // Phase-0 client-context delegation target (api /api/engagement/context/:id).
      MERIV2_API_BASE_URL: `https://${cfg.appHost}`,
      ANTHROPIC_MODEL: 'claude-sonnet-4-5',
      // Post-hoc grounding auditor. Matches the LIVE prod posture (both api and
      // orchestrator run 'enforce' as of 2026-07-14) so a cdk deploy does not
      // regress it — the code default is 'off', so OMITTING this here would
      // silently downgrade prod on the next deploy. Chat stays observe-only even
      // under enforce (auditDecisionFor returns deliver/repair for the chat
      // surface); enforce only gates the deliverable surfaces.
      MERI_AUDITOR_MODE: 'enforce',
    };

    const meriv2OrchestratorTaskDef = new ecs.FargateTaskDefinition(
      this,
      'MeriV2OrchestratorTaskDef',
      {
        family: `capiro-${cfg.envName}-meriv2-orchestrator`,
        cpu: cfg.meriv2OrchestratorCpu,
        memoryLimitMiB: cfg.meriv2OrchestratorMemoryMib,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
        taskRole: meriv2OrchestratorTaskRole,
      },
    );
    grantSecretsAndKmsToExecutionRole(
      meriv2OrchestratorTaskDef,
      [
        dbSecretImported.secretArn,
        appDbSecretImported.secretArn,
        clerkSecretKeyImported.secretArn,
        anthropicApiKeySecret.secretArn,
      ],
      [dataKey.keyArn, secretsStack.secretsKey.keyArn],
    );
    meriv2OrchestratorTaskDef.addContainer('meriv2-orchestrator', {
      image: ecs.ContainerImage.fromEcrRepository(this.meriv2OrchestratorRepo, 'latest'),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: meriv2OrchestratorLogGroup,
        streamPrefix: 'meriv2-orchestrator',
      }),
      environment: meriv2OrchestratorSharedEnv,
      secrets: meriv2OrchestratorServeSecrets,
      readonlyRootFilesystem: false,
      portMappings: [{ containerPort: 4300, protocol: ecs.Protocol.TCP }],
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:4300/meri-api/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    this.meriv2OrchestratorService = new ecs.FargateService(this, 'MeriV2OrchestratorService', {
      cluster: this.cluster,
      taskDefinition: meriv2OrchestratorTaskDef,
      serviceName: `capiro-${cfg.envName}-meriv2-orchestrator`,
      desiredCount: cfg.meriv2OrchestratorDesiredCount,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [serviceSecurityGroup as ec2.SecurityGroup],
      assignPublicIp: false,
      enableExecuteCommand: cfg.envName !== 'prod',
      cloudMapOptions: { name: 'meriv2-orchestrator' },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });
    const meriv2OrchestratorScaling = this.meriv2OrchestratorService.autoScaleTaskCount({
      minCapacity: cfg.meriv2OrchestratorDesiredCount,
      maxCapacity: cfg.meriv2OrchestratorMaxCount,
    });
    meriv2OrchestratorScaling.scaleOnCpuUtilization('MeriV2OrchestratorCpuScaling', {
      targetUtilizationPercent: 60,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(30),
    });

    // ---------------------------------------------------------- Strategy Planner API
    // Separate service (/strategy-api/*) that owns the sp_* tables in the SHARED
    // Aurora cluster and reuses the SAME Clerk JWT secret. Ships DARK behind the
    // per-tenant strategyPlanner.* flags (G1 = scaffold only; no feature routes
    // yet). Modeled on the MeriV2 orchestrator block above (shared DB/Clerk
    // secrets, no AI provider keys at Phase-1 scope — those arrive in G5).
    const apiStrategyLogGroup = new logs.LogGroup(this, 'ApiStrategyLogs', {
      logGroupName: `/capiro/${cfg.envName}/api-strategy`,
      retention: cfg.logRetentionDays as unknown as logs.RetentionDays,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const apiStrategyMigrateLogGroup = new logs.LogGroup(this, 'ApiStrategyMigrateLogs', {
      logGroupName: `/capiro/${cfg.envName}/api-strategy-migrate`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cfg.protectFromDestroy
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    const apiStrategyTaskRole = new iam.Role(this, 'ApiStrategyTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Capiro Strategy API task role',
    });
    apiStrategyTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [
          dbSecretImported.secretArn,
          appDbSecretImported.secretArn,
          clerkSecretKeyImported.secretArn,
        ],
      }),
    );
    apiStrategyTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:DescribeKey'],
        resources: [dataKey.keyArn, secretsStack.secretsKey.keyArn],
      }),
    );

    // Serve: app DB role (least-privilege) + host/port from the master secret.
    const apiStrategyServeSecrets = {
      CLERK_SECRET_KEY: ecs.Secret.fromSecretsManager(clerkSecretKeyImported),
      DB_HOST: ecs.Secret.fromSecretsManager(dbSecretImported, 'host'),
      DB_PORT: ecs.Secret.fromSecretsManager(dbSecretImported, 'port'),
      DB_USER: ecs.Secret.fromSecretsManager(appDbSecretImported, 'username'),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(appDbSecretImported, 'password'),
    };
    // Migrate: master role for DDL + RLS grants.
    const apiStrategyMigrateSecrets = {
      DB_HOST: ecs.Secret.fromSecretsManager(dbSecretImported, 'host'),
      DB_PORT: ecs.Secret.fromSecretsManager(dbSecretImported, 'port'),
      DB_USER: ecs.Secret.fromSecretsManager(dbSecretImported, 'username'),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecretImported, 'password'),
    };
    const apiStrategySharedEnv: Record<string, string> = {
      NODE_ENV: cfg.envName === 'dev' ? 'development' : 'production',
      LOG_LEVEL: 'info',
      STRATEGY_LOG_LEVEL: 'log',
      STRATEGY_PORT: '4400',
      DB_NAME: databaseName,
      ...(cfg.clerkJwtIssuer ? { CLERK_JWT_ISSUER: cfg.clerkJwtIssuer } : {}),
      WEB_ORIGIN: `https://${cfg.appHost}`,
    };

    const apiStrategyTaskDef = new ecs.FargateTaskDefinition(this, 'ApiStrategyTaskDef', {
      family: `capiro-${cfg.envName}-api-strategy`,
      cpu: cfg.apiStrategyCpu,
      memoryLimitMiB: cfg.apiStrategyMemoryMib,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskRole: apiStrategyTaskRole,
    });
    grantSecretsAndKmsToExecutionRole(
      apiStrategyTaskDef,
      [
        dbSecretImported.secretArn,
        appDbSecretImported.secretArn,
        clerkSecretKeyImported.secretArn,
      ],
      [dataKey.keyArn, secretsStack.secretsKey.keyArn],
    );
    apiStrategyTaskDef.addContainer('api-strategy', {
      image: ecs.ContainerImage.fromEcrRepository(this.apiStrategyRepo, 'latest'),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: apiStrategyLogGroup,
        streamPrefix: 'api-strategy',
      }),
      environment: apiStrategySharedEnv,
      secrets: apiStrategyServeSecrets,
      readonlyRootFilesystem: false,
      portMappings: [{ containerPort: 4400, protocol: ecs.Protocol.TCP }],
      healthCheck: {
        command: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:4400/strategy-api/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    this.apiStrategyService = new ecs.FargateService(this, 'ApiStrategyService', {
      cluster: this.cluster,
      taskDefinition: apiStrategyTaskDef,
      serviceName: `capiro-${cfg.envName}-api-strategy`,
      desiredCount: cfg.apiStrategyDesiredCount,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [serviceSecurityGroup as ec2.SecurityGroup],
      assignPublicIp: false,
      enableExecuteCommand: cfg.envName !== 'prod',
      cloudMapOptions: { name: 'api-strategy' },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });
    const apiStrategyScaling = this.apiStrategyService.autoScaleTaskCount({
      minCapacity: cfg.apiStrategyDesiredCount,
      maxCapacity: cfg.apiStrategyMaxCount,
    });
    apiStrategyScaling.scaleOnCpuUtilization('ApiStrategyCpuScaling', {
      targetUtilizationPercent: 60,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(30),
    });

    // Strategy API migrate task (run before rolling the service, like
    // api-migrate/workspace-migrate). The `migrate` verb runs prisma migrate
    // deploy against the sp_* migrations, then seeds the reference baseline.
    this.apiStrategyMigrateTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      'ApiStrategyMigrateTaskDef',
      {
        family: `capiro-${cfg.envName}-api-strategy-migrate`,
        cpu: 512,
        memoryLimitMiB: 1024,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
        taskRole: apiStrategyTaskRole,
      },
    );
    grantSecretsAndKmsToExecutionRole(
      this.apiStrategyMigrateTaskDefinition,
      [dbSecretImported.secretArn],
      [dataKey.keyArn, secretsStack.secretsKey.keyArn],
    );
    this.apiStrategyMigrateTaskDefinition.addContainer('api-strategy-migrate', {
      image: ecs.ContainerImage.fromEcrRepository(this.apiStrategyRepo, 'latest'),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: apiStrategyMigrateLogGroup,
        streamPrefix: 'api-strategy-migrate',
      }),
      command: ['migrate'],
      environment: { ...apiStrategySharedEnv, MIGRATE_ONLY: '1' },
      secrets: apiStrategyMigrateSecrets,
      readonlyRootFilesystem: false,
    });

    // Workspace migrate task (run before rolling the service, like api-migrate).
    this.workspaceMigrateTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      'WorkspaceMigrateTaskDef',
      {
        family: `capiro-${cfg.envName}-workspace-migrate`,
        cpu: 512,
        memoryLimitMiB: 1024,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
        taskRole: workspaceTaskRole,
      },
    );
    grantSecretsAndKmsToExecutionRole(
      this.workspaceMigrateTaskDefinition,
      [dbSecretImported.secretArn],
      [dataKey.keyArn, secretsStack.secretsKey.keyArn],
    );
    this.workspaceMigrateTaskDefinition.addContainer('workspace-migrate', {
      image: ecs.ContainerImage.fromEcrRepository(this.workspaceRepo, 'latest'),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: workspaceMigrateLogGroup,
        streamPrefix: 'workspace-migrate',
      }),
      command: ['migrate'],
      environment: { ...workspaceSharedEnv, MIGRATE_ONLY: '1' },
      secrets: workspaceMigrateSecrets,
      readonlyRootFilesystem: false,
    });

    // ------------------------------------------------------------------ Migration task (run manually before API rollout)
    this.apiMigrateTaskDefinition = new ecs.FargateTaskDefinition(this, 'ApiMigrateTaskDef', {
      family: `capiro-${cfg.envName}-api-migrate`,
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskRole: apiTaskRole,
    });
    grantSecretsAndKmsToExecutionRole(
      this.apiMigrateTaskDefinition,
      [
        dbSecretImported.secretArn,
        clerkSecretKeyImported.secretArn,
        clerkWebhookImported.secretArn,
        govInfoApiKeyImported.secretArn,
        samGovApiKeySecret.secretArn,
      ],
      [dataKey.keyArn, secretsStack.secretsKey.keyArn],
    );
    this.apiMigrateTaskDefinition.addContainer('api-migrate', {
      image: ecs.ContainerImage.fromEcrRepository(this.apiRepo, 'latest'),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({ logGroup: migrateLogGroup, streamPrefix: 'migrate' }),
      command: ['migrate'],
      environment: { ...apiSharedEnv, MIGRATE_ONLY: '1' },
      secrets: apiMigrateSecrets,
      readonlyRootFilesystem: false,
    });

    // -------------------------------------------------------- embed-backfill task
    // One-shot Fargate task that runs apps/api/scripts/embed-backfill.ts
    // against a chosen source. Container command is overridden per run
    // (e.g. `--overrides` on `aws ecs run-task` to pass `--source lda`),
    // so this single task definition serves all three backfills.
    //
    // Sized larger than migrate because:
    //  * Bedrock InvokeModel calls hold open HTTP connections (default
    //    concurrency 8 ⇒ ~8 in-flight requests + Prisma connections).
    //  * LDA backfill iterates 500K rows over ~3h, page-buffering ~500
    //    rows of source text at a time.
    // 1 vCPU / 2 GiB is comfortably above the working set.
    this.apiEmbedBackfillTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      'ApiEmbedBackfillTaskDef',
      {
        family: `capiro-${cfg.envName}-api-embed-backfill`,
        cpu: 1024,
        memoryLimitMiB: 2048,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
        taskRole: apiTaskRole,
      },
    );
    grantSecretsAndKmsToExecutionRole(
      this.apiEmbedBackfillTaskDefinition,
      [dbSecretImported.secretArn, appDbSecretImported.secretArn],
      [dataKey.keyArn],
    );
    this.apiEmbedBackfillTaskDefinition.addContainer('api-embed-backfill', {
      image: ecs.ContainerImage.fromEcrRepository(this.apiRepo, 'latest'),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: embedBackfillLogGroup,
        streamPrefix: 'embed-backfill',
      }),
      // Default command runs bills. Override at run-task time with e.g.
      // --overrides '{"containerOverrides":[{"name":"api-embed-backfill",
      //   "command":["embed-backfill","--source","lda","--since","2024-01-01"]}]}'
      command: ['embed-backfill', '--source', 'bills'],
      environment: apiSharedEnv,
      // The script connects via DATABASE_URL composed from DB_* secrets
      // (entrypoint.sh handles the URL-encoding). Bedrock auth is from the
      // task role, no API key needed.
      secrets: apiMigrateSecrets,
      readonlyRootFilesystem: false,
    });

    // ---------------------------------------------- embed-backfill DAILY schedule
    // Autonomous embeddings (Production Ingestion plan, Phase 1 Task 1.2).
    // EventBridge fires the embed-backfill task once daily with `--source all`.
    // The script is content-hash idempotent (unchanged text => no Bedrock call,
    // $0) and LDA uses a SyncRun watermark, so each run only embeds NEW/changed
    // rows. Runs at 13:00 UTC — AFTER the daily federal source syncs (06:00) and
    // derived emitters (10:00–11:00) per the schedule matrix, so the day's new
    // bills/capabilities are present before we embed them.
    //
    // Override the container command so the scheduled run does `--source all`
    // instead of the task def's default `--source bills`.
    const embedRule = new events.Rule(this, 'EmbedBackfillDailyRule', {
      ruleName: `capiro-${cfg.envName}-embed-backfill-daily`,
      description: 'Daily autonomous embeddings refresh (bills, lda, capabilities).',
      schedule: events.Schedule.cron({ minute: '0', hour: '13' }),
    });
    embedRule.addTarget(
      new eventsTargets.EcsTask({
        cluster: this.cluster,
        taskDefinition: this.apiEmbedBackfillTaskDefinition,
        taskCount: 1,
        subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [serviceSecurityGroup as ec2.SecurityGroup],
        // EventBridge retries the RunTask API call, not the workload; the task
        // itself is safe to re-run (idempotent). Drop failed invocations to a
        // dead-letter queue would be added in Phase 2 alongside the generic
        // ScheduledJob construct + alarms.
        containerOverrides: [
          {
            containerName: 'api-embed-backfill',
            command: ['embed-backfill', '--source', 'all'],
          },
        ],
      }),
    );

    // ------------------------------------------------- scheduled ingestion jobs
    // Production Ingestion plan, Phase 2. One shared "sync" Fargate task def
    // (API image) + one EventBridge rule per job in the schedule matrix, each
    // overriding the container command to the kebab job name wired in
    // entrypoint.sh. Daily/weekly/monthly cadence is encoded in
    // ingestion-schedule.ts. The scripts upsert + write SyncRun, so runs are
    // idempotent and observable.
    const syncJobsLogGroup = new logs.LogGroup(this, 'ApiSyncJobsLogs', {
      logGroupName: `/capiro/${cfg.envName}/api-sync-jobs`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cfg.protectFromDestroy ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    // Metric filter: turn the helper's `INGESTION_METRIC {...error_count...}`
    // stdout lines into a CloudWatch metric the Alarms stack watches. Zero
    // runtime AWS dependency in the scripts; matches the ProgramElementSync
    // pattern. Aggregate (no per-source dimension) so one alarm covers all jobs.
    new logs.MetricFilter(this, 'IngestionErrorMetricFilter', {
      logGroup: syncJobsLogGroup,
      metricNamespace: 'Capiro/Ingestion',
      metricName: 'ingestion.error_count',
      filterPattern: logs.FilterPattern.literal('{ $.error_count = * }'),
      metricValue: '$.error_count',
      defaultValue: 0,
    });
    const syncJobsTaskDef = new ecs.FargateTaskDefinition(this, 'ApiSyncJobsTaskDef', {
      family: `capiro-${cfg.envName}-api-sync-jobs`,
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskRole: apiTaskRole,
    });
    grantSecretsAndKmsToExecutionRole(
      syncJobsTaskDef,
      [dbSecretImported.secretArn, appDbSecretImported.secretArn],
      [dataKey.keyArn],
    );
    syncJobsTaskDef.addContainer('api-sync-jobs', {
      image: ecs.ContainerImage.fromEcrRepository(this.apiRepo, 'latest'),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: syncJobsLogGroup,
        streamPrefix: 'sync',
      }),
      // Default is a no-op help command; every scheduled rule overrides this
      // with its own job command (e.g. ['sync-congress']).
      command: ['serve'],
      environment: apiSharedEnv,
      // apiSyncSecrets adds LEGISTORM_API_KEY for sync-legistorm-directory; every
      // other injected secret matches the migrate bundle.
      secrets: apiSyncSecrets,
      readonlyRootFilesystem: false,
    });

    new ScheduledIngestionJobs(this, 'IngestionSchedules', {
      envName: cfg.envName,
      cluster: this.cluster,
      taskDefinition: syncJobsTaskDef,
      containerName: 'api-sync-jobs',
      securityGroup: serviceSecurityGroup,
      jobs: INGESTION_JOBS,
    });

    // -------------------------------------------------------- bootstrap-roles task
    // One-shot task that connects to Aurora as the master role and
    // ALTER ROLEs `capiro_app` to whatever password is currently in the
    // app secret. Run after every change to the app secret (rotation,
    // initial bootstrap). Identity grants are the same as the migrate
    // task, both need to talk to the DB.
    this.apiBootstrapRolesTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      'ApiBootstrapRolesTaskDef',
      {
        family: `capiro-${cfg.envName}-api-bootstrap-roles`,
        cpu: 256,
        memoryLimitMiB: 512,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
        taskRole: apiTaskRole,
      },
    );
    grantSecretsAndKmsToExecutionRole(
      this.apiBootstrapRolesTaskDefinition,
      [dbSecretImported.secretArn, appDbSecretImported.secretArn],
      [dataKey.keyArn],
    );
    this.apiBootstrapRolesTaskDefinition.addContainer('api-bootstrap-roles', {
      image: ecs.ContainerImage.fromEcrRepository(this.apiRepo, 'latest'),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: migrateLogGroup,
        streamPrefix: 'bootstrap-roles',
      }),
      command: ['bootstrap-roles'],
      environment: apiSharedEnv,
      // The bootstrap-roles script reads master + app credentials from env.
      // The container's entrypoint already composes DATABASE_URL from DB_*,
      // but bootstrap-roles uses MASTER_*/APP_* explicitly to keep the two
      // credentials clearly named.
      secrets: {
        DB_HOST: ecs.Secret.fromSecretsManager(dbSecretImported, 'host'),
        DB_PORT: ecs.Secret.fromSecretsManager(dbSecretImported, 'port'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecretImported, 'password'),
        DB_USER: ecs.Secret.fromSecretsManager(dbSecretImported, 'username'),
        MASTER_USER: ecs.Secret.fromSecretsManager(dbSecretImported, 'username'),
        MASTER_PASSWORD: ecs.Secret.fromSecretsManager(dbSecretImported, 'password'),
        APP_USER: ecs.Secret.fromSecretsManager(appDbSecretImported, 'username'),
        APP_PASSWORD: ecs.Secret.fromSecretsManager(appDbSecretImported, 'password'),
      },
      readonlyRootFilesystem: false,
    });

    // ------------------------------------------------------------------ ALB + listeners
    // ⚠️⚠️ PROD ROUTING DRIFT — READ BEFORE `cdk deploy Capiro-dev-Compute` ⚠️⚠️
    // -----------------------------------------------------------------------------
    // The live app (app.capiro.ai, the `Capiro-dev-*` lineage = REAL prod for the
    // core product) is NO LONGER served by THIS CDK-managed ALB. As of
    // 2026-06-27 the production topology is:
    //
    //   app.capiro.ai  (Route53 alias, zone Z085985135X6Q5QT98ZBK)
    //     └─► capiro-prod-alb  (capiro-prod-alb-57164953.us-east-1.elb.amazonaws.com)
    //          • UNMANAGED — no CloudFormation stack, NO tags, hand-created.
    //          • HTTPS:443 rules:
    //              /api/*  +  /webhooks/*   → capiro-prod-api-tg
    //              host capiro.ai           → capiro-prod-marketing-tg
    //              default                  → capiro-prod-web-tg
    //          • Backends = ECS cluster `capiro-dev` services
    //            (capiro-dev-api / -web / -marketing / -clio-sandbox).
    //
    // The CDK-managed ALB this construct creates (logical id `Alb`, formerly
    // app/Capiro-Alb16-PWSBu59pPfLj) was DELETED out-of-band. Because the stack
    // still references it, `Capiro-dev-Compute` is wedged in UPDATE_ROLLBACK_FAILED
    // and `cdk deploy` FAILS with "Load balancer ... not found". A naive deploy
    // does NOT touch live traffic (the manual capiro-prod-alb keeps serving), it
    // just errors. DO NOT assume this CDK ALB / its target groups / its listener
    // rules are what production uses — they are not.
    //
    // To wire the WORKSPACE engine into real prod, add a target group +
    // `/workspace-api/*` rule (priority < 20) to the MANUAL `capiro-prod-alb`
    // HTTPS:443 listener pointing at the workspace Fargate service — NOT here.
    // Reconciling the wedged stack (recreate ALB / continue-update-rollback /
    // import the manual ALB) is a separate supervised effort.
    // (Note added during the 2026-06-27 workspace deploy attempt.)
    // -----------------------------------------------------------------------------
    this.alb = new elb.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup as ec2.SecurityGroup,
      ipAddressType: elb.IpAddressType.IPV4,
      dropInvalidHeaderFields: true,
      deletionProtection: cfg.protectFromDestroy,
      // AI content-generation requests legitimately run 60-120s+ (non-streaming
      // model calls); at 60s the ALB dropped the connection mid-response → 504.
      // 300s covers all non-streaming generation and gives streaming flows
      // headroom between chunks. The API's Node keepAliveTimeout (305s, main.ts)
      // is set just above this to avoid 502 socket-reuse races.
      idleTimeout: cdk.Duration.seconds(300),
    });

    // HTTP -> HTTPS redirect.
    this.alb.addListener('HttpRedirect', {
      port: 80,
      protocol: elb.ApplicationProtocol.HTTP,
      defaultAction: elb.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    const httpsListener = this.alb.addListener('Https', {
      port: 443,
      protocol: elb.ApplicationProtocol.HTTPS,
      // Two certs on the listener: the app cert (app.capiro.ai + *.app.capiro.ai)
      // and the apex cert (capiro.ai + www). ALB picks the right one per
      // SNI handshake. Listed as L2 props so CDK creates the
      // ListenerCertificates association.
      certificates: [certificate, apexCertificate],
      sslPolicy: elb.SslPolicy.RECOMMENDED_TLS,
      defaultAction: elb.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Not found',
      }),
    });

    this.apiTargetGroup = new elb.ApplicationTargetGroup(this, 'ApiTargetGroup', {
      vpc,
      port: 4000,
      protocol: elb.ApplicationProtocol.HTTP,
      targetType: elb.TargetType.IP,
      targets: [this.apiService.loadBalancerTarget({ containerName: 'api', containerPort: 4000 })],
      healthCheck: {
        path: '/health',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        unhealthyThresholdCount: 3,
        healthyThresholdCount: 2,
      },
      deregistrationDelay: cdk.Duration.seconds(15),
      stickinessCookieDuration: cdk.Duration.minutes(5),
    });

    this.webTargetGroup = new elb.ApplicationTargetGroup(this, 'WebTargetGroup', {
      vpc,
      port: 8080,
      protocol: elb.ApplicationProtocol.HTTP,
      targetType: elb.TargetType.IP,
      targets: [this.webService.loadBalancerTarget({ containerName: 'web', containerPort: 8080 })],
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

    this.marketingTargetGroup = new elb.ApplicationTargetGroup(this, 'MarketingTargetGroup', {
      vpc,
      port: 8080,
      protocol: elb.ApplicationProtocol.HTTP,
      targetType: elb.TargetType.IP,
      targets: [
        this.marketingService.loadBalancerTarget({
          containerName: 'marketing',
          containerPort: 8080,
        }),
      ],
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

    this.workspaceTargetGroup = new elb.ApplicationTargetGroup(this, 'WorkspaceTargetGroup', {
      vpc,
      port: 4200,
      protocol: elb.ApplicationProtocol.HTTP,
      targetType: elb.TargetType.IP,
      targets: [
        this.workspaceService.loadBalancerTarget({
          containerName: 'workspace',
          containerPort: 4200,
        }),
      ],
      healthCheck: {
        path: '/health',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        unhealthyThresholdCount: 3,
        healthyThresholdCount: 2,
      },
      deregistrationDelay: cdk.Duration.seconds(15),
    });

    this.meriv2OrchestratorTargetGroup = new elb.ApplicationTargetGroup(
      this,
      'MeriV2OrchestratorTargetGroup',
      {
        vpc,
        port: 4300,
        protocol: elb.ApplicationProtocol.HTTP,
        targetType: elb.TargetType.IP,
        targets: [
          this.meriv2OrchestratorService.loadBalancerTarget({
            containerName: 'meriv2-orchestrator',
            containerPort: 4300,
          }),
        ],
        healthCheck: {
          path: '/meri-api/health',
          healthyHttpCodes: '200',
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
          unhealthyThresholdCount: 3,
          healthyThresholdCount: 2,
        },
        deregistrationDelay: cdk.Duration.seconds(15),
      },
    );

    this.apiStrategyTargetGroup = new elb.ApplicationTargetGroup(
      this,
      'ApiStrategyTargetGroup',
      {
        vpc,
        port: 4400,
        protocol: elb.ApplicationProtocol.HTTP,
        targetType: elb.TargetType.IP,
        targets: [
          this.apiStrategyService.loadBalancerTarget({
            containerName: 'api-strategy',
            containerPort: 4400,
          }),
        ],
        healthCheck: {
          path: '/strategy-api/health',
          healthyHttpCodes: '200',
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
          unhealthyThresholdCount: 3,
          healthyThresholdCount: 2,
        },
        deregistrationDelay: cdk.Duration.seconds(15),
      },
    );

    // Listener rules, ORDER MATTERS, lower priority wins.
    //   3  /api/*, /webhooks/*, /health (any host) → api  [must beat marketing host rule]
    //   5  apex (capiro.ai) → marketing
    //   20 app.capiro.ai + *.app.capiro.ai → web
    //   default → 404 (set on the listener itself)
    //
    // ApiPaths is priority 3 (not 5+) because in dev rootDomain === appHost
    // ('app-dev.capiro.ai'), so the Marketing host rule at priority 5 would
    // otherwise intercept /health and /api/* before the path rule could fire.
    httpsListener.addAction('ApiPaths', {
      priority: 3,
      conditions: [elb.ListenerCondition.pathPatterns(['/api/*', '/webhooks/*', '/health'])],
      action: elb.ListenerAction.forward([this.apiTargetGroup]),
    });
    // Workspace engine: /workspace-api/* → workspace service. Priority 10 sits
    // between ApiPaths (3) and WebDefault (20). The path is distinct from
    // /api/* (the API) and from /workspace/* (which stays a WEB SPA route).
    // ⚠️ This rule is added to the CDK-managed `Alb` — which is NOT what serves
    // live prod (see the PROD ROUTING DRIFT note at the ALB definition above).
    // Until the wedged stack is reconciled, the EFFECTIVE prod wiring for the
    // workspace must be added to the MANUAL `capiro-prod-alb` HTTPS:443 listener
    // (e.g. `aws elbv2 create-rule --priority 12 --conditions path-pattern
    // /workspace-api/* --actions forward capiro-prod-workspace-tg`).
    httpsListener.addAction('WorkspaceApi', {
      priority: 10,
      conditions: [elb.ListenerCondition.pathPatterns(['/workspace-api/*'])],
      action: elb.ListenerAction.forward([this.workspaceTargetGroup]),
    });
    // MeriV2 orchestrator: /meri-api/* → orchestrator service. Same PROD ROUTING
    // DRIFT caveat as the WorkspaceApi rule above: this attaches to the
    // CDK-managed `Alb`, which is NOT the live prod ALB. The EFFECTIVE prod rule
    // is added out-of-band to the MANUAL `capiro-prod-alb` HTTPS:443 listener —
    // codified in scripts/meri-alb-rules.sh + docs/runbooks/meri-alb-rule.md.
    // NOTE: on the LIVE prod ALB that rule is priority 13 → capiro-prod-meriv2-orch-tg
    // (verified 2026-07-14); /webhooks/* owns priority 15 there. The priority 15
    // used HERE is only valid on this (phantom) CDK ALB's ordering.
    httpsListener.addAction('MeriApi', {
      priority: 15,
      conditions: [elb.ListenerCondition.pathPatterns(['/meri-api/*'])],
      action: elb.ListenerAction.forward([this.meriv2OrchestratorTargetGroup]),
    });
    // Strategy Planner API: /strategy-api/* → api-strategy service. Distinct
    // from /api/* and /workspace-api/*. Priority 12 sits between WorkspaceApi
    // (10) and MeriApi (15) on this CDK ALB.
    // ⚠️ SAME PROD ROUTING DRIFT caveat as WorkspaceApi/MeriApi: this attaches to
    // the CDK-managed `Alb`, which is NOT the live prod ALB. The EFFECTIVE prod
    // rule must be added out-of-band to the MANUAL `capiro-prod-alb` HTTPS:443
    // listener (`aws elbv2 create-rule --priority <N> --conditions
    // path-pattern /strategy-api/* --actions forward capiro-prod-api-strategy-tg`).
    // On the live ALB workspace≈12, meriv2-orch=13, /webhooks/*=15 are taken —
    // pick a free priority < 20 (e.g. 14 or 16-19); the CDK number here is
    // independent of the real-ALB number.
    httpsListener.addAction('StrategyApi', {
      priority: 12,
      conditions: [elb.ListenerCondition.pathPatterns(['/strategy-api/*'])],
      action: elb.ListenerAction.forward([this.apiStrategyTargetGroup]),
    });
    if (cfg.rootDomain !== cfg.appHost) {
      httpsListener.addAction('Marketing', {
        priority: 5,
        conditions: [elb.ListenerCondition.hostHeaders([cfg.rootDomain, `www.${cfg.rootDomain}`])],
        action: elb.ListenerAction.forward([this.marketingTargetGroup]),
      });
    }
    httpsListener.addAction('WebDefault', {
      priority: 20,
      conditions: [elb.ListenerCondition.hostHeaders([cfg.appHost, cfg.wildcardHost])],
      action: elb.ListenerAction.forward([this.webTargetGroup]),
    });

    // ---------------------------------------------------------------- WAF
    const waf = new wafv2.CfnWebACL(this, 'WebAcl', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `capiro-${cfg.envName}-waf`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AWS-AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesCommonRuleSet' },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'CommonRuleSet',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWS-AWSManagedRulesKnownBadInputsRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'BadInputs',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWS-AWSManagedRulesAmazonIpReputationList',
          priority: 3,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesAmazonIpReputationList',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'IpReputation',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'PerIpRateLimit',
          priority: 10,
          action: { block: {} },
          statement: {
            rateBasedStatement: { limit: 2000, aggregateKeyType: 'IP' },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'PerIpRate',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });
    new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', {
      resourceArn: this.alb.loadBalancerArn,
      webAclArn: waf.attrArn,
    });

    // ---------------------------------------------------------------- DNS
    new route53.ARecord(this, 'AppAlias', {
      zone: hostedZone,
      recordName: cfg.appHost,
      target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(this.alb)),
    });
    // Wildcard alias for tenant vanity URLs ({slug}.app.capiro.ai).
    new route53.ARecord(this, 'AppWildcardAlias', {
      zone: hostedZone,
      recordName: cfg.wildcardHost,
      target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(this.alb)),
    });
    // Apex alias only when rootDomain differs from appHost (prod: capiro.ai vs
    // app.capiro.ai; dev: both equal app-dev.capiro.ai, so skip to avoid
    // duplicate Route53 record with AppAlias above).
    if (cfg.rootDomain !== cfg.appHost) {
      new route53.ARecord(this, 'ApexAlias', {
        zone: hostedZone,
        recordName: cfg.rootDomain,
        target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(this.alb)),
      });
      new route53.AaaaRecord(this, 'ApexAliasIpv6', {
        zone: hostedZone,
        recordName: cfg.rootDomain,
        target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(this.alb)),
      });
    }

    new cdk.CfnOutput(this, 'AlbDnsName', { value: this.alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'ApiRepoUri', { value: this.apiRepo.repositoryUri });
    new cdk.CfnOutput(this, 'WebRepoUri', { value: this.webRepo.repositoryUri });
    new cdk.CfnOutput(this, 'ApiServiceArn', { value: this.apiService.serviceArn });
    new cdk.CfnOutput(this, 'ApiMigrateTaskDefArn', {
      value: this.apiMigrateTaskDefinition.taskDefinitionArn,
    });
    new cdk.CfnOutput(this, 'ApiEmbedBackfillTaskDefArn', {
      value: this.apiEmbedBackfillTaskDefinition.taskDefinitionArn,
    });
  }
}

function importExternalSecret(
  scope: Construct,
  id: string,
  secretName: string,
  completeArn?: string,
): secretsmanager.ISecret {
  return completeArn
    ? secretsmanager.Secret.fromSecretCompleteArn(scope, id, completeArn)
    : secretsmanager.Secret.fromSecretNameV2(scope, id, secretName);
}

/**
 * Adds secretsmanager:GetSecretValue + DescribeSecret on the given secret
 * ARNs and kms:Decrypt on the KMS key ARNs to a Fargate task definition's
 * execution role. Necessary when the secrets are IMPORTED constructs (CDK
 * cannot auto-wire KMS perms across stacks for imports).
 */
function grantSecretsAndKmsToExecutionRole(
  taskDef: ecs.FargateTaskDefinition,
  secretArns: string[],
  kmsKeyArns: string[],
): void {
  // The execution role is created lazily by the L2, accessing it here forces
  // creation. Adding policies before any container is added is fine because
  // the role exists once the task definition is constructed.
  taskDef.addToExecutionRolePolicy(
    new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: secretArns,
    }),
  );
  taskDef.addToExecutionRolePolicy(
    new iam.PolicyStatement({
      actions: ['kms:Decrypt', 'kms:DescribeKey'],
      resources: kmsKeyArns,
    }),
  );
}
