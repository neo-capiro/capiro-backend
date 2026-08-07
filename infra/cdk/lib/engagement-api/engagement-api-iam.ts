import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

import type { EngagementApiInfraConfig } from './engagement-api-config';
import { assertEngagementApiDeploymentDbBudget } from './engagement-api-db-budget';

/**
 * Least-privilege IAM and secret injection for the dark `engagement-api` task.
 *
 * Two principles, both enforced by tests rather than by review:
 *
 *   1. Only fields the shadow runtime genuinely needs at boot or on a safe read
 *      are injected. Provider keys and the Clerk webhook signing secret are
 *      omitted entirely — the runtime imports no Clerk WebhooksModule.
 *   2. The task cannot mutate anything: no S3 write, no send, no ECS or ELB
 *      call, no secret write, no PassRole. It cannot modify its own service or
 *      its own routing.
 */

/**
 * Secret fields injected into the container.
 *
 * `DB_*` are composed into DATABASE_URL by the image entrypoint, which is why
 * the parts are mapped individually instead of injecting the whole JSON blob.
 * CLERK_SECRET_KEY is required for authentication. The two encryption keys are
 * needed to READ existing rows — OAuth connection state and meeting notes are
 * stored encrypted, so safe read parity fails without them.
 *
 * DB_HOST/DB_PORT and DB_USER/DB_PASSWORD come from two DIFFERENT secrets, not
 * one. Live discovery (2.15, capiro-dev, 2026-08-06) against the main API's
 * actual task definition found it splits them the same way: a "master" secret
 * (host/port) and a separate "app" secret (username/password).
 */
export const ENGAGEMENT_API_SECRET_FIELDS = {
  fromDatabaseHostSecret: ['DB_HOST', 'DB_PORT'] as const,
  fromDatabaseAppSecret: ['DB_USER', 'DB_PASSWORD'] as const,
  wholeSecret: [
    'CLERK_SECRET_KEY',
    'OAUTH_TOKEN_ENCRYPTION_KEY',
    'NOTES_ENCRYPTION_KEY',
  ] as const,
} as const;

/** JSON keys inside the database host secret (host/port), in injection order. */
const DATABASE_HOST_SECRET_JSON_KEYS: Record<string, string> = {
  DB_HOST: 'host',
  DB_PORT: 'port',
};

/** JSON keys inside the database app secret (username/password). */
const DATABASE_APP_SECRET_JSON_KEYS: Record<string, string> = {
  DB_USER: 'username',
  DB_PASSWORD: 'password',
};

/** Each whole-secret field's own config ARN — no shared secret, no jsonKey. */
const WHOLE_SECRET_CONFIG_KEYS: Record<string, keyof EngagementApiInfraConfig> = {
  CLERK_SECRET_KEY: 'clerkSecretKeySecretArn',
  OAUTH_TOKEN_ENCRYPTION_KEY: 'oauthTokenEncryptionKeySecretArn',
  NOTES_ENCRYPTION_KEY: 'notesEncryptionKeySecretArn',
};

/**
 * Credentials the shadow service must NOT receive.
 *
 * Each is unreachable while ENGAGEMENT_EXTERNAL_ACTIONS=disabled, or belongs
 * to a module the shadow app does not import. Injecting one would only widen
 * blast radius.
 */
export const ENGAGEMENT_API_OMITTED_SECRETS = [
  'CLERK_WEBHOOK_SIGNING_SECRET',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'RECALL_API_KEY',
  'RECALL_WEBHOOK_SECRET',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CERT_PRIVATE_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'SAM_GOV_API_KEY',
  'AI_CREDENTIAL_ENCRYPTION_KEY',
] as const;

export interface EngagementApiRoles {
  executionRole: iam.IRole;
  taskRole: iam.IRole;
  secrets: Record<string, ecs.Secret>;
}

/**
 * Build the execution role, the task role, and the exact secret map.
 *
 * The execution role pulls the image, writes logs, and resolves only the
 * selected secrets. The task role holds read access to the buckets the
 * Directory and attachment read paths actually use.
 */
export function buildEngagementApiIam(
  scope: Construct,
  cfg: EngagementApiInfraConfig,
  taskDefinition: ecs.TaskDefinition,
): EngagementApiRoles {
  // Direct ServiceStack construction must enforce the same deployment-surge
  // budget as the root CDK app; unit tests instantiate this path directly.
  assertEngagementApiDeploymentDbBudget(cfg);

  const databaseHostSecret = secretsmanager.Secret.fromSecretCompleteArn(
    scope,
    'DatabaseHostSecret',
    cfg.databaseHostSecretArn,
  );
  const databaseAppSecret = secretsmanager.Secret.fromSecretCompleteArn(
    scope,
    'DatabaseAppSecret',
    cfg.databaseAppSecretArn,
  );

  // Preserve the reviewed config/provenance binding without granting or
  // injecting the value. This imported construct creates no CloudFormation
  // resource and no IAM permission.
  secretsmanager.Secret.fromSecretCompleteArn(
    scope,
    'CLERK_WEBHOOK_SIGNING_SECRETSecret',
    cfg.clerkWebhookSigningSecretArn,
  );

  const secrets: Record<string, ecs.Secret> = {};
  for (const name of ENGAGEMENT_API_SECRET_FIELDS.fromDatabaseHostSecret) {
    const jsonKey = DATABASE_HOST_SECRET_JSON_KEYS[name];
    if (!jsonKey) throw new Error(`no JSON key mapped for ${name}`);
    secrets[name] = ecs.Secret.fromSecretsManager(databaseHostSecret, jsonKey);
  }
  for (const name of ENGAGEMENT_API_SECRET_FIELDS.fromDatabaseAppSecret) {
    const jsonKey = DATABASE_APP_SECRET_JSON_KEYS[name];
    if (!jsonKey) throw new Error(`no JSON key mapped for ${name}`);
    secrets[name] = ecs.Secret.fromSecretsManager(databaseAppSecret, jsonKey);
  }
  for (const name of ENGAGEMENT_API_SECRET_FIELDS.wholeSecret) {
    const configKey = WHOLE_SECRET_CONFIG_KEYS[name];
    if (!configKey) throw new Error(`no config key mapped for ${name}`);
    const arn = cfg[configKey] as string;
    const secret = secretsmanager.Secret.fromSecretCompleteArn(scope, `${name}Secret`, arn);
    secrets[name] = ecs.Secret.fromSecretsManager(secret);
  }

  const executionRole = taskDefinition.obtainExecutionRole();
  const taskRole = taskDefinition.taskRole;

  // Decrypting the secrets requires the CMK that encrypts them. Scoped to the
  // exact configured keys; no wildcard, no key policy change.
  const dataKeys = cfg.kmsKeyArns.data.map((arn, index) =>
    kms.Key.fromKeyArn(scope, `DataKey${index}`, arn),
  );
  for (const key of dataKeys) {
    key.grantDecrypt(executionRole);
    key.grantDecrypt(taskRole);
  }

  // Read-only bucket access for the Directory snapshot and attachment reads.
  // Exact buckets from config; no wildcard bucket, no write action.
  const buckets = [
    cfg.bucketNames.assets,
    cfg.bucketNames.directory,
    cfg.bucketNames.attachments,
    ...cfg.bucketNames.otherReadOnly,
  ].filter((name): name is string => typeof name === 'string' && name.length > 0);

  if (buckets.length > 0) {
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'EngagementApiReadOnlyObjects',
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: buckets.map((name) => `arn:aws:s3:::${name}/*`),
      }),
    );
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'EngagementApiListBuckets',
        effect: iam.Effect.ALLOW,
        actions: ['s3:ListBucket'],
        resources: buckets.map((name) => `arn:aws:s3:::${name}`),
      }),
    );
  }

  // Belt and braces: an explicit deny that survives any future grant made by a
  // construct we add later. Deny always wins in IAM evaluation.
  taskRole.addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid: 'EngagementApiDenyMutationAndSend',
      effect: iam.Effect.DENY,
      actions: [
        's3:PutObject',
        's3:DeleteObject',
        's3:AbortMultipartUpload',
        'ses:SendEmail',
        'ses:SendRawEmail',
        'ses:SendTemplatedEmail',
        'ecs:UpdateService',
        'ecs:RegisterTaskDefinition',
        'elasticloadbalancing:CreateRule',
        'elasticloadbalancing:ModifyRule',
        'elasticloadbalancing:DeleteRule',
        'elasticloadbalancing:ModifyListener',
        'secretsmanager:PutSecretValue',
        'secretsmanager:UpdateSecret',
        'secretsmanager:DeleteSecret',
        'iam:PassRole',
        'kms:Encrypt',
        'kms:ReEncryptFrom',
        'kms:ReEncryptTo',
      ],
      resources: ['*'],
    }),
  );

  cdk.Tags.of(scope).add('capiro:iam-posture', 'least-privilege-shadow');

  return { executionRole, taskRole, secrets };
}
