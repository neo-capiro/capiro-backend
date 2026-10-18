import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import meriTools from './first-chat-core-meri-tools.json';
import routes from './first-chat-core-routes.json';

// This is a separate, held service. The drifted live ComputeStack and its
// production API service are not owned or updated by this composition.
export interface FirstChatCoreImagePins {
  readonly sourceHead: string;
  readonly imageDigest: string;
}
/** The qualified integrated image (built from capiro-backend PR #84 or its
 * successor, scanned and recorded). Null until that build exists: rendering
 * refuses rather than describing a task its image cannot serve. Set both values
 * together in the image-qualification commit. */
export const FIRST_CHAT_CORE_IMAGE_PINS: FirstChatCoreImagePins | null = null;
/** No longer accepted: PR48 predates native preview GETs, retained reads, the
 * tool allowlist and the service-identity binding this template now requires. */
export const FIRST_CHAT_CORE_RETIRED_PR48: FirstChatCoreImagePins = {
  sourceHead: '6542f5b089656b6d255465edd464d06c2a0b408f',
  imageDigest: 'sha256:722a483259ebb5e9162b9294c26895bafa890fcfee45dc927ff1d2ec35fa071b',
};
export const FIRST_CHAT_CORE_HOST = 'first-chat-preview.app-dev.capiro.ai';
// Reserved alongside Meri and the hand-managed rules in
// infra/routing/capiro-prod-alb-priorities.json. Neither rule is live merely
// because this source is rendered; the retained guard is deployed separately.
/** The retained guard's current (compact) priority. The packet gives this slot
 * to the native-operations POST rule and moves only the guard. */
export const FIRST_CHAT_CORE_COMPACT_GUARD_PRIORITY = 3;
/** ALB's highest rule priority. */
const MAX_LISTENER_PRIORITY = 50000;
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

/** Exact tool names Meri may execute on this task (dot's fixed inventory). The
 * listener forwards a bounded tool-name pattern; this task runs the
 * first-chat-preview profile, where Core requires this exact list at startup
 * and refuses any other name after native and service authentication. */
export const FIRST_CHAT_CORE_MERI_TOOLS: readonly string[] = Object.freeze([...meriTools.tools]);

/** Core paths Meri and Intel call on this host (route/method/authority packet in
 * docs/integration/CORE-INTEGRATION-LEDGER.md section 8), shared with the
 * offline first-match model through first-chat-core-routes.json. Each value is
 * at most 128 characters; ALB permits three per condition and five evaluations
 * per rule (host + method + three paths). */
export const FIRST_CHAT_CORE_POST_PATHS: readonly string[] = Object.freeze([...routes.post]);
export const FIRST_CHAT_CORE_GET_PATHS: readonly string[] = Object.freeze([...routes.get]);
/** Exact Core POSTs for P-INT-10 approvals, D016 #9 execution issuance, W8 memory receiving, the D31 artifact authority and the item 5 routines wires (A, B, C). */
export const FIRST_CHAT_CORE_NATIVE_OPS_PATHS: readonly string[] = Object.freeze([...routes.nativeOps]);
export const FIRST_CHAT_CORE_NATIVE_OPS_PRIORITY: number = routes.packet.nativeOps;

const SECRET_ARN = new RegExp(`^arn:aws:secretsmanager:${region}:${account}:secret:[A-Za-z0-9/_+=.@-]{1,512}-[A-Za-z0-9]{6}$`);
const PIN_TEXT = /^[\x21-\x7e]{1,256}$/;
/** The service identity is the dedicated preview secret, created in the packet (never the JWT secret). */
const INTERNAL_SERVICE_SECRET_ARN = new RegExp(`^arn:aws:secretsmanager:${region}:${account}:secret:meri/preview/core/internal-service-secret-[A-Za-z0-9]{6}$`);
const KMS_KEY_ARN = new RegExp(`^arn:aws:kms:${region}:${account}:key/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`);
const SIGNER_ISSUER = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/;
const SIGNER_KID = /^[A-Za-z0-9._-]{1,64}$/;
const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Retained-read trust for this task. Private keys arrive only as Secrets
 * Manager references; Core is the sole signer and Intel holds public keys. */
export interface FirstChatCoreRetainedTrustBinding {
  issuer: string;
  intelOrigin: string;
  principalKeyId: string;
  principalPrivateKeySecretArn: string;
  probeKeyId: string;
  probePrivateKeySecretArn: string;
}

/** Listener slot read back from the live listener, never assumed in source.
 * Occupancy and same-host precedence are verified offline against that
 * readback by infra/routing `corePreviewPacketRules` before rendering. */
export interface FirstChatCoreListenerBinding {
  guardPriority: number;
}

/** One Core KMS Ed25519 signing purpose (`ECC_NIST_EDWARDS25519`, pure Ed25519, RAW
 * `ED25519_SHA_512`), created in the packet; `publicKeyX` is its GetPublicKey readback. */
export interface FirstChatCoreSignerBinding {
  issuer: string;
  kid: string;
  keyArn: string;
  publicKeyX: string;
}

/** D016-A item 3: the run profile is configuration the packet supplies (the default
 * integration profile is 20 turns, 900 s, $2), never a hard-coded ceiling in source. */
export interface FirstChatCoreProfileBinding {
  executionMaxTurns: number;
  executionMaxRuntimeSeconds: number;
  executionMaxCostMicrousd: number;
  routineMaxCostMicrousd: number;
  routineMaxRuntimeSeconds: number;
}

export interface FirstChatCoreImageBinding {
  schemaVersion: 5;
  sourceHead: string;
  imageDigest: string;
  /** Server-side service identity: exactly the `meri/preview/core/internal-service-secret` secret. */
  internalServiceSecretArn: string;
  /** null keeps retained reads disabled (every retained route 503). */
  retainedTrust: FirstChatCoreRetainedTrustBinding | null;
  listener: FirstChatCoreListenerBinding;
  /** The preview tenant: governed memory lifecycle enforced for it only (D016). */
  previewTenantId: string;
  profile: FirstChatCoreProfileBinding;
  /** Each null keeps its routes at 503 (execution issuance/receipt, routine cancel proof, routine firing grant,
   * v5: option B read delegation tokens). */
  signers: {
    execution: FirstChatCoreSignerBinding | null;
    routineCancel: FirstChatCoreSignerBinding | null;
    routineFire: FirstChatCoreSignerBinding | null;
    readDelegation: FirstChatCoreSignerBinding | null;
  };
}

function signerPin(value: unknown, label: string): FirstChatCoreSignerBinding | null {
  if (value === null) return null;
  const s = exactKeys(value, ['issuer', 'kid', 'keyArn', 'publicKeyX'], label);
  if (typeof s.issuer !== 'string' || !SIGNER_ISSUER.test(s.issuer) || typeof s.kid !== 'string' || !SIGNER_KID.test(s.kid) ||
      typeof s.keyArn !== 'string' || !KMS_KEY_ARN.test(s.keyArn) || typeof s.publicKeyX !== 'string' || !B64URL_32.test(s.publicKeyX)) {
    throw new Error(`${label}: exact issuer, kid, KMS key ARN and public key required`);
  }
  return s as unknown as FirstChatCoreSignerBinding;
}

function guardPriority(value: unknown): number {
  if (
    typeof value !== 'number' || !Number.isSafeInteger(value) ||
    value <= FIRST_CHAT_CORE_NATIVE_OPS_PRIORITY || value > MAX_LISTENER_PRIORITY
  ) {
    throw new Error('Readback-verified guard priority after the native-operations rule required');
  }
  return value;
}

function exactKeys(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} object required`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join('|') !== [...keys].sort().join('|')) throw new Error(`${label} fields are fixed`);
  return record;
}

function httpsOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** No arbitrary resource, credential, image tag, or environment override. The
 * image must equal the pinned qualified build; secrets are exact ARNs in this
 * account and region. */
export function firstChatCoreImageBinding(
  input: unknown,
  pins: FirstChatCoreImagePins | null = FIRST_CHAT_CORE_IMAGE_PINS,
): FirstChatCoreImageBinding {
  const record = exactKeys(input,
    ['schemaVersion', 'sourceHead', 'imageDigest', 'internalServiceSecretArn', 'retainedTrust', 'listener',
      'previewTenantId', 'profile', 'signers'],
    'First-chat image binding');
  if (!pins) throw new Error('No qualified integrated Core image is pinned yet');
  if (
    record.schemaVersion !== 5 ||
    !/^[0-9a-f]{40}$/.test(pins.sourceHead) || !/^sha256:[0-9a-f]{64}$/.test(pins.imageDigest) ||
    record.sourceHead !== pins.sourceHead ||
    record.imageDigest !== pins.imageDigest
  ) {
    throw new Error('Exact qualified Core source and image digest required');
  }
  if (typeof record.internalServiceSecretArn !== 'string' || !SECRET_ARN.test(record.internalServiceSecretArn) ||
      !INTERNAL_SERVICE_SECRET_ARN.test(record.internalServiceSecretArn)) {
    throw new Error('Exact meri/preview/core/internal-service-secret ARN required');
  }
  if (typeof record.previewTenantId !== 'string' || !UUID.test(record.previewTenantId)) throw new Error('Preview tenant UUID required');
  const profile = exactKeys(record.profile, ['executionMaxTurns', 'executionMaxRuntimeSeconds', 'executionMaxCostMicrousd',
    'routineMaxCostMicrousd', 'routineMaxRuntimeSeconds'], 'Profile');
  if (Object.values(profile).some((v) => typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1)) throw new Error('Profile values must be positive integers');
  const signers = exactKeys(record.signers, ['execution', 'routineCancel', 'routineFire', 'readDelegation'], 'Signers');
  const pinned = [signerPin(signers.execution, 'Execution signer'), signerPin(signers.routineCancel, 'Routine cancel signer'),
    signerPin(signers.routineFire, 'Routine fire signer'), signerPin(signers.readDelegation, 'Read delegation signer')]
    .filter((s): s is FirstChatCoreSignerBinding => s !== null);
  // One key per purpose: Meri pins the purposes apart.
  if (new Set(pinned.map((s) => s.keyArn)).size !== pinned.length || new Set(pinned.map((s) => s.kid)).size !== pinned.length) {
    throw new Error('Each signing purpose needs its own KMS key and kid');
  }
  if (record.retainedTrust !== null) {
    const trust = exactKeys(record.retainedTrust, ['issuer', 'intelOrigin', 'principalKeyId',
      'principalPrivateKeySecretArn', 'probeKeyId', 'probePrivateKeySecretArn'], 'Retained trust');
    if (
      ![trust.issuer, trust.principalKeyId, trust.probeKeyId].every((text) => typeof text === 'string' && PIN_TEXT.test(text)) ||
      !httpsOrigin(trust.intelOrigin) ||
      ![trust.principalPrivateKeySecretArn, trust.probePrivateKeySecretArn].every((arn) => typeof arn === 'string' && SECRET_ARN.test(arn)) ||
      trust.principalPrivateKeySecretArn === trust.probePrivateKeySecretArn
    ) {
      throw new Error('Exact retained trust pins required');
    }
  }
  guardPriority(exactKeys(record.listener, ['guardPriority'], 'Listener').guardPriority);
  return record as unknown as FirstChatCoreImageBinding;
}

/** Independent, retained host guard. It must be complete before the service
 * stack: its update frees the native-operations slot before that rule exists. */
export class FirstChatCoreGuardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, priority: number) {
    super(scope, id, { env });
    const guard = new elb.CfnListenerRule(this, 'RejectOtherPreviewHostTraffic', {
      listenerArn: live.listenerArn,
      priority: guardPriority(priority),
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
    const serviceIdentity = secrets.Secret.fromSecretCompleteArn(
      this, 'InternalServiceSecret', binding.internalServiceSecretArn,
    );
    const trust = binding.retainedTrust;
    const principalKey = trust && secrets.Secret.fromSecretCompleteArn(
      this, 'RetainedPrincipalSigningKey', trust.principalPrivateKeySecretArn,
    );
    const probeKey = trust && secrets.Secret.fromSecretCompleteArn(
      this, 'RetainedProbeSigningKey', trust.probePrivateKeySecretArn,
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
    principalKey?.grantRead(serveExecutionRole);
    probeKey?.grantRead(serveExecutionRole);
    serveExecutionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: [live.dataKeyArn, live.secretsKeyArn],
      conditions: {
        StringEquals: { 'kms:ViaService': 'secretsmanager.us-east-1.amazonaws.com' },
      },
    }));
    // The application's own role: only kms:Sign, pure Ed25519 over RAW messages,
    // on exactly the configured signing keys.
    const serveTaskRole = new iam.Role(this, 'ServeTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    const signerEntries: Array<[string, FirstChatCoreSignerBinding | null]> = [
      ['MERI_EXECUTION_SIGNER', binding.signers.execution],
      ['MERI_ROUTINE_CANCEL_SIGNER', binding.signers.routineCancel],
      ['MERI_ROUTINE_FIRE_SIGNER', binding.signers.routineFire],
      ['MERI_READ_DELEGATION_SIGNER', binding.signers.readDelegation],
    ];
    const signerKeyArns = signerEntries.flatMap(([, s]) => (s ? [s.keyArn] : []));
    if (signerKeyArns.length) {
      serveTaskRole.addToPolicy(new iam.PolicyStatement({
        actions: ['kms:Sign'],
        resources: signerKeyArns,
        conditions: { StringEquals: { 'kms:SigningAlgorithm': 'ED25519_SHA_512', 'kms:MessageType': 'RAW' } },
      }));
    }
    const signerEnvironment = Object.fromEntries(signerEntries.flatMap(([prefix, s]) => (s ? [
      [`${prefix}_ISSUER`, s.issuer], [`${prefix}_KID`, s.kid], [`${prefix}_KMS_KEY_ARN`, s.keyArn], [`${prefix}_PUBLIC_KEY_X`, s.publicKeyX],
    ] : [])));
    const serveTask = new ecs.FargateTaskDefinition(this, 'ServeTask', {
      family: 'capiro-preview-first-chat-core',
      cpu: 1024,
      memoryLimitMiB: 2048,
      executionRole: serveExecutionRole,
      taskRole: serveTaskRole,
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
        RELEASE_SHA: binding.sourceHead,
        // Preview profile: Core refuses to start without an exact non-empty
        // MERI_TOOL_ALLOWLIST and refuses unlisted tools at the route.
        CORE_DEPLOYMENT_PROFILE: 'first-chat-preview',
        // Native-session preview GETs, the exact Meri tool set and enforced
        // service identity on tools/read-mode (server-side secret only).
        PREVIEW_NATIVE_GETS_ENABLED: 'true',
        MERI_TOOL_ALLOWLIST: FIRST_CHAT_CORE_MERI_TOOLS.join(','),
        MERI_TOOLS_REQUIRE_SERVICE_SECRET: 'true',
        // D016: governed memory lifecycle for the preview tenant only.
        MEMORY_GOVERNANCE_LIFECYCLE: 'enforce',
        MEMORY_GOVERNANCE_TENANTS: binding.previewTenantId,
        // D016-A item 3: the packet's run profile as configured platform maxima.
        MERI_EXECUTION_MAX_TURNS: String(binding.profile.executionMaxTurns),
        MERI_EXECUTION_MAX_RUNTIME_SECONDS: String(binding.profile.executionMaxRuntimeSeconds),
        MERI_EXECUTION_MAX_COST_MICROUSD: String(binding.profile.executionMaxCostMicrousd),
        MERI_ROUTINE_MAX_COST_MICROUSD: String(binding.profile.routineMaxCostMicrousd),
        MERI_ROUTINE_MAX_RUNTIME_SECONDS: String(binding.profile.routineMaxRuntimeSeconds),
        ...signerEnvironment,
        ...(trust
          ? {
              RETAINED_READS_ENABLED: 'true',
              RETAINED_TRUST_ISSUER: trust.issuer,
              RETAINED_CORE_ORIGIN: `https://${FIRST_CHAT_CORE_HOST}`,
              RETAINED_INTEL_ORIGIN: trust.intelOrigin,
              RETAINED_PRINCIPAL_KEY_ID: trust.principalKeyId,
              RETAINED_PROBE_KEY_ID: trust.probeKeyId,
            }
          : { RETAINED_READS_ENABLED: 'false' }),
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
        INTERNAL_SERVICE_SECRET: ecs.Secret.fromSecretsManager(serviceIdentity),
        ...(principalKey && probeKey
          ? {
              RETAINED_PRINCIPAL_PRIVATE_KEY_PEM: ecs.Secret.fromSecretsManager(principalKey),
              RETAINED_PROBE_PRIVATE_KEY_PEM: ecs.Secret.fromSecretsManager(probeKey),
            }
          : {}),
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
    // per rule, and 128 characters per pattern. Priority 1 holds every Meri and
    // Intel POST (tools by a bounded name pattern), priority 2 the native GETs,
    // priority 3 the exact approval and memory POSTs. Only the retained
    // host-only 404 guard moved, to the readback-verified slot; no shared rule
    // moves.
    // Preserve both existing listener rule logical IDs so an in-place update
    // remains possible if this stack owns the physical rules. Confirm that
    // ownership from the current template before any application. Intel routes
    // are not served here: Meri and Core reach Intel at RETAINED_INTEL_ORIGIN
    // through the existing Intel rule.
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
            regexValues: [...FIRST_CHAT_CORE_GET_PATHS],
          },
        },
        { field: 'http-request-method', httpRequestMethodConfig: { values: ['GET'] } },
      ],
      actions: [{ type: 'forward', targetGroupArn: target.targetGroupArn }],
    });
    const nativeOps = new elb.CfnListenerRule(this, 'FirstChatNativeOpsPostOnly', {
      listenerArn: live.listenerArn,
      priority: FIRST_CHAT_CORE_NATIVE_OPS_PRIORITY,
      conditions: [
        { field: 'host-header', hostHeaderConfig: { values: [FIRST_CHAT_CORE_HOST] } },
        {
          field: 'path-pattern',
          pathPatternConfig: {
            regexValues: [...FIRST_CHAT_CORE_NATIVE_OPS_PATHS],
          },
        },
        { field: 'http-request-method', httpRequestMethodConfig: { values: ['POST'] } },
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
    service.node.addDependency(firstChatPosts, browserReads, nativeOps);

    new cdk.CfnOutput(this, 'CoreApiBaseUrl', {
      value: `https://${FIRST_CHAT_CORE_HOST}/api`,
    });
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
  const guard = new FirstChatCoreGuardStack(app, FIRST_CHAT_CORE_GUARD_STACK_NAME, binding.listener.guardPriority);
  const service = new FirstChatCoreServiceStack(app, 'Capiro-Preview-First-Chat-Core', binding);
  service.addStackDependency(guard);
  return { app, guard, service, binding };
}
