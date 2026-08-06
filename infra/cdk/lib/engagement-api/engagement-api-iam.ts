import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

import type { EngagementApiInfraConfig } from './engagement-api-config';

/**
 * Least-privilege IAM and secret injection for the dark `engagement-api` task.
 *
 * Two principles, both enforced by tests rather than by review:
 *
 *   1. Only fields the shadow runtime genuinely needs at boot or on a safe read
 *      are injected. Provider keys are omitted entirely — the runtime policy
 *      disables every path that would use them, so shipping them would grant
 *      reach the service is forbidden to exercise.
 *   2. The task cannot mutate anything: no S3 write, no send, no ECS or ELB
 *      call, no secret write, no PassRole. It cannot modify its own service or
 *      its own routing.
 */

/**
 * Secret fields injected into the container.
 *
 * `DB_*` are composed into DATABASE_URL by the image entrypoint, which is why
 * the parts are mapped individually instead of injecting the whole JSON blob.
 * CLERK_SECRET_KEY and CLERK_WEBHOOK_SIGNING_SECRET are the only two values the
 * API config schema hard-requires. The two encryption keys are needed to READ
 * existing rows — OAuth connection state and meeting notes are stored
 * encrypted, so safe read parity fails without them.
 *
 * DB_HOST/DB_PORT and DB_USER/DB_PASSWORD come from two DIFFERENT secrets, not
 * one. Live discovery (2.15, capiro-dev, 2026-08-06) against the main API's
 * actual task definition found it splits them the same way: a "master" secret
 * (host/port) and a separate "app" secret (username/password) —
 * /capiro/<env>/aurora/master and /capiro/<env>/aurora/app. DB_NAME is not a
 * secret at all there; it's a literal env var (see engagementApiTaskEnvironment).
 * The single-secret shape this contract originally assumed did not match.
 */
export const ENGAGEMENT_API_SECRET_FIELDS = {
  fromDatabaseHostSecret: ['DB_HOST', 'DB_PORT'] as const,
  fromDatabaseAppSecret: ['DB_USER', 'DB_PASSWORD'] as const,
  fromAppConfigSecret: [
    'CLERK_SECRET_KEY',
    'CLERK_WEBHOOK_SIGNING_SECRET',
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

/**
 * Provider credentials the shadow service must NOT receive.
 *
 * Each is unreachable while ENGAGEMENT_EXTERNAL_ACTIONS=disabled, so injecting
 * one would only widen blast radius. Named explicitly so the omission is a
 * decision with a test, not an oversight.
 */
export const ENGAGEMENT_API_OMITTED_SECRETS = [
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
 * The execution role pulls the image, writes logs, and resolves the two
 * secrets. The task role holds only read access to the buckets the Directory
 * and attachment read paths actually use.
 */
export function buildEngagementApiIam(
  scope: Construct,
  cfg: EngagementApiInfraConfig,
  taskDefinition: ecs.TaskDefinition,
): EngagementApiRoles {
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
  const appConfigSecret = secretsmanager.Secret.fromSecretCompleteArn(
    scope,
    'AppConfigSecret',
    cfg.appConfigSecretArn,
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
  for (const name of ENGAGEMENT_API_SECRET_FIELDS.fromAppConfigSecret) {
    // Field-scoped, never the whole JSON document.
    secrets[name] = ecs.Secret.fromSecretsManager(appConfigSecret, name);
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
