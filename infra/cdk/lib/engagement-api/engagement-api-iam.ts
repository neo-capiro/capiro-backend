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
 */
export const ENGAGEMENT_API_SECRET_FIELDS = {
  fromDatabaseSecret: ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'] as const,
  fromAppConfigSecret: [
    'CLERK_SECRET_KEY',
    'CLERK_WEBHOOK_SIGNING_SECRET',
    'OAUTH_TOKEN_ENCRYPTION_KEY',
    'NOTES_ENCRYPTION_KEY',
  ] as const,
} as const;

/** JSON keys inside the database secret, in injection order. */
const DATABASE_SECRET_JSON_KEYS: Record<string, string> = {
  DB_HOST: 'host',
  DB_PORT: 'port',
  DB_USER: 'username',
  DB_PASSWORD: 'password',
  DB_NAME: 'dbname',
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

/** IAM actions the task role may never hold. */
export const ENGAGEMENT_API_FORBIDDEN_ACTIONS = [
  's3:PutObject',
  's3:DeleteObject',
  's3:*',
  'ses:SendEmail',
  'ses:SendRawEmail',
  'ses:Send*',
  'ecs:UpdateService',
  'ecs:*',
  'elasticloadbalancing:ModifyRule',
  'elasticloadbalancing:CreateRule',
  'elasticloadbalancing:*',
  'iam:PassRole',
  'iam:*',
  'secretsmanager:PutSecretValue',
  'secretsmanager:UpdateSecret',
  'secretsmanager:*',
  'kms:Encrypt',
  'kms:*',
  '*',
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
  const databaseSecret = secretsmanager.Secret.fromSecretCompleteArn(
    scope,
    'DatabaseSecret',
    cfg.databaseSecretArn,
  );
  const appConfigSecret = secretsmanager.Secret.fromSecretCompleteArn(
    scope,
    'AppConfigSecret',
    cfg.appConfigSecretArn,
  );

  const secrets: Record<string, ecs.Secret> = {};
  for (const name of ENGAGEMENT_API_SECRET_FIELDS.fromDatabaseSecret) {
    const jsonKey = DATABASE_SECRET_JSON_KEYS[name];
    if (!jsonKey) throw new Error(`no JSON key mapped for ${name}`);
    secrets[name] = ecs.Secret.fromSecretsManager(databaseSecret, jsonKey);
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
