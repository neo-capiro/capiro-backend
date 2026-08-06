/**
 * engagement-api IAM and secret minimization.
 *
 * Run: pnpm --dir infra/cdk exec ts-node --prefer-ts-exts test/engagement-api-least-privilege.spec.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { type EngagementApiInfraConfig } from '../lib/engagement-api/engagement-api-config';
import {
  ENGAGEMENT_API_OMITTED_SECRETS,
  ENGAGEMENT_API_SECRET_FIELDS,
} from '../lib/engagement-api/engagement-api-iam';
import { EngagementApiServiceStack } from '../lib/engagement-api/engagement-api-service-stack';

const CDK_ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(CDK_ROOT, 'fixtures/engagement-api.test.json');
const TARGET_GROUP_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/capiro-dev-engagement-api/3333';

const base = (): EngagementApiInfraConfig => {
  const cfg = JSON.parse(readFileSync(FIXTURE, 'utf8')) as EngagementApiInfraConfig;
  cfg.imageDigest = `sha256:${'ab'.repeat(32)}`;
  cfg.releaseSha = 'c'.repeat(40);
  return cfg;
};

function synth(cfg: EngagementApiInfraConfig = base()): Template {
  const app = new cdk.App();
  return Template.fromStack(
    new EngagementApiServiceStack(app, 'Capiro-dev-EngagementApiService', {
      cfg,
      env: { account: cfg.accountId, region: cfg.region },
      targetGroupArn: TARGET_GROUP_ARN,
    }),
  );
}

interface Statement {
  Effect: 'Allow' | 'Deny';
  Action: string | string[];
  Resource?: unknown;
  Sid?: string;
}

/** Every policy statement in the template, flattened. */
function allStatements(template: Template): Statement[] {
  const out: Statement[] = [];
  for (const kind of ['AWS::IAM::Policy', 'AWS::IAM::Role']) {
    for (const resource of Object.values(template.findResources(kind))) {
      const properties = (resource as { Properties: Record<string, any> }).Properties;
      const documents = [
        properties.PolicyDocument,
        ...(properties.Policies ?? []).map((p: { PolicyDocument: unknown }) => p.PolicyDocument),
      ].filter(Boolean);
      for (const document of documents) {
        for (const statement of (document as { Statement?: Statement[] }).Statement ?? []) {
          out.push(statement);
        }
      }
    }
  }
  return out;
}

const actionsOf = (statement: Statement): string[] =>
  Array.isArray(statement.Action) ? statement.Action : [statement.Action];

const allowActions = (template: Template): string[] =>
  allStatements(template)
    .filter((s) => s.Effect === 'Allow')
    .flatMap(actionsOf);

function containerSecrets(template: Template): Record<string, unknown> {
  const tasks = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
  const task = tasks[0];
  assert.ok(task);
  const containers = (task as { Properties: Record<string, any> }).Properties
    .ContainerDefinitions as Array<Record<string, any>>;
  const container = containers[0];
  assert.ok(container);
  const entries = (container.Secrets ?? []) as Array<{ Name: string; ValueFrom: unknown }>;
  return Object.fromEntries(entries.map((e) => [e.Name, e.ValueFrom]));
}

// ───────────────────────────────────────────────────────────────── secrets

test('exactly the boot-required and safe-read fields are injected', () => {
  const injected = Object.keys(containerSecrets(synth())).sort();
  const expected = [
    ...ENGAGEMENT_API_SECRET_FIELDS.fromDatabaseHostSecret,
    ...ENGAGEMENT_API_SECRET_FIELDS.fromDatabaseAppSecret,
    ...ENGAGEMENT_API_SECRET_FIELDS.wholeSecret,
  ].sort();
  assert.deepEqual(injected, expected);
});

test('DB_HOST/DB_PORT and DB_USER/DB_PASSWORD resolve from two DIFFERENT secrets', () => {
  // Live discovery (2.15, capiro-dev) found the main API's own task splits
  // these across a "master" secret (host/port) and an "app" secret
  // (username/password) — not one secret with all four fields.
  const secrets = containerSecrets(synth());
  // A rendered ValueFrom is "<arn-prefix>:secret:<name>:<jsonKey>::" — compare
  // only <name>. The prefix is shared by every secret in this account, and
  // DB_HOST vs DB_PORT differ only in <jsonKey> despite sharing one secret.
  const arnOf = (valueFrom: unknown) => String(valueFrom).split(':secret:')[1]?.split(':')[0];
  assert.equal(arnOf(secrets.DB_HOST), arnOf(secrets.DB_PORT));
  assert.equal(arnOf(secrets.DB_USER), arnOf(secrets.DB_PASSWORD));
  assert.notEqual(arnOf(secrets.DB_HOST), arnOf(secrets.DB_USER));
});

test('the four whole-secret fields each resolve from a distinct secret, with no jsonKey', () => {
  // Live discovery (2.15, capiro-dev) found CLERK_SECRET_KEY,
  // CLERK_WEBHOOK_SIGNING_SECRET, OAUTH_TOKEN_ENCRYPTION_KEY and
  // NOTES_ENCRYPTION_KEY are each their OWN flat-string secret on the main
  // API's task — confirmed by the absence of a ":<field>::" suffix, unlike
  // the two DB secrets. Injected whole here, not field-scoped.
  const secrets = containerSecrets(synth());
  const fields = [
    'CLERK_SECRET_KEY',
    'CLERK_WEBHOOK_SIGNING_SECRET',
    'OAUTH_TOKEN_ENCRYPTION_KEY',
    'NOTES_ENCRYPTION_KEY',
  ] as const;
  const arnOf = (valueFrom: unknown) => String(valueFrom).split(':secret:')[1]?.split(':')[0];
  const withoutJsonKey = (valueFrom: unknown) => !/:secret:[^:]+:[^:]+::$/.test(String(valueFrom));

  const names = fields.map((f) => arnOf(secrets[f]));
  assert.equal(new Set(names).size, 4, `expected 4 distinct secrets, got ${names.join(', ')}`);
  for (const field of fields) {
    assert.ok(withoutJsonKey(secrets[field]), `${field} must reference the whole secret, no jsonKey`);
  }
});

test('NC-2.7-B no provider or LLM key is injected', () => {
  const injected = Object.keys(containerSecrets(synth()));
  for (const omitted of ENGAGEMENT_API_OMITTED_SECRETS) {
    assert.ok(!injected.includes(omitted), `${omitted} must not be injected into a shadow task`);
  }
});

test('multi-field secrets (DB) are mapped field by field, never as a whole JSON document', () => {
  // Only the two DB secrets actually hold several named JSON fields each —
  // that's the case where injecting the whole document would leak the
  // sibling field. The four wholeSecret fields are flat strings with no
  // field to select; asserted separately below.
  const secrets = containerSecrets(synth());
  const multiFieldNames = [
    ...ENGAGEMENT_API_SECRET_FIELDS.fromDatabaseHostSecret,
    ...ENGAGEMENT_API_SECRET_FIELDS.fromDatabaseAppSecret,
  ];
  for (const name of multiFieldNames) {
    const rendered = JSON.stringify(secrets[name]);
    assert.match(
      rendered,
      /secret:.*:[A-Za-z_]+::/,
      `${name} does not resolve a specific JSON field: ${rendered}`,
    );
  }
});

test('no plaintext secret value appears anywhere in the template', () => {
  const rendered = JSON.stringify(synth().toJSON());
  assert.doesNotMatch(rendered, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  assert.doesNotMatch(rendered, /\bsk_(live|test)_[A-Za-z0-9]/);
  assert.doesNotMatch(rendered, /"(DB_PASSWORD|CLERK_SECRET_KEY)"\s*:\s*"[^"]{8,}"/);
});

test('prototype hashes stay nonsecret environment values, not secrets', () => {
  const secrets = Object.keys(containerSecrets(synth()));
  assert.ok(!secrets.includes('OUTREACH_V3_PROTOTYPE_SHA256'));
  assert.ok(!secrets.includes('OUTREACH_V3_UI_CONTRACT_SHA256'));
});

// ──────────────────────────────────────────────────────────── least privilege

test('NC-2.7-A no allow statement grants S3 write or a wildcard S3 action', () => {
  for (const action of allowActions(synth())) {
    assert.ok(!/^s3:(Put|Delete|Abort|Restore)/.test(action), `task may not ${action}`);
    assert.notEqual(action, 's3:*');
  }
});

test('no allow statement grants a send permission', () => {
  for (const action of allowActions(synth())) {
    assert.ok(!/^ses:/i.test(action), `task may not ${action}`);
    assert.ok(!/^sns:Publish$/i.test(action), `task may not ${action}`);
  }
});

test('NC-2.7-C no allow statement can mutate routing, the service, or IAM', () => {
  for (const action of allowActions(synth())) {
    assert.ok(!/^elasticloadbalancing:/i.test(action), `task may not ${action}`);
    assert.ok(!/^ecs:(Update|Create|Delete|Register)/i.test(action), `task may not ${action}`);
    assert.ok(!/^iam:/i.test(action), `task may not ${action}`);
    assert.ok(!/^secretsmanager:(Put|Update|Delete|Create)/i.test(action), `task may not ${action}`);
  }
});

test('an explicit deny covers mutation and send even if a later grant appears', () => {
  const denies = allStatements(synth()).filter((s) => s.Effect === 'Deny');
  assert.ok(denies.length > 0, 'no explicit deny statement');
  const denied = denies.flatMap(actionsOf);
  for (const action of [
    's3:PutObject',
    's3:DeleteObject',
    'ses:SendEmail',
    'ecs:UpdateService',
    'elasticloadbalancing:CreateRule',
    'elasticloadbalancing:ModifyRule',
    'secretsmanager:PutSecretValue',
    'iam:PassRole',
    'kms:Encrypt',
  ]) {
    assert.ok(denied.includes(action), `explicit deny is missing ${action}`);
  }
});

test('no allow statement uses a bare wildcard resource on a data action', () => {
  const offenders = allStatements(synth())
    .filter((s) => s.Effect === 'Allow')
    .filter((s) => JSON.stringify(s.Resource) === '"*"')
    .flatMap(actionsOf)
    // CloudWatch Logs and ECR auth genuinely have no resource-level ARN.
    .filter((a) => !/^(logs:(CreateLogStream|PutLogEvents|CreateLogGroup)|ecr:GetAuthorizationToken)$/.test(a));
  assert.deepEqual(offenders, [], `wildcard-resource allow statements: ${offenders.join(', ')}`);
});

test('bucket access is read-only and scoped to the configured buckets', () => {
  const cfg = base();
  const statements = allStatements(synth(cfg)).filter((s) => s.Effect === 'Allow');
  const s3Statements = statements.filter((s) => actionsOf(s).some((a) => a.startsWith('s3:')));
  assert.ok(s3Statements.length > 0, 'expected read-only bucket access');

  const resources = JSON.stringify(s3Statements.map((s) => s.Resource));
  for (const bucket of [cfg.bucketNames.assets, cfg.bucketNames.directory]) {
    assert.match(resources, new RegExp(String(bucket)));
  }
  assert.doesNotMatch(resources, /arn:aws:s3:::\*/, 'wildcard bucket ARN');
});

test('the execution role can pull the image and write logs', () => {
  const actions = allowActions(synth());
  assert.ok(actions.some((a) => /^ecr:(BatchGetImage|GetDownloadUrlForLayer)$/.test(a)));
  assert.ok(actions.some((a) => a === 'ecr:GetAuthorizationToken'));
  assert.ok(actions.some((a) => /^logs:(CreateLogStream|PutLogEvents)$/.test(a)));
});

test('KMS decrypt is scoped to the configured keys, and encrypt is never allowed', () => {
  const cfg = base();
  const statements = allStatements(synth(cfg)).filter((s) => s.Effect === 'Allow');
  const kmsStatements = statements.filter((s) => actionsOf(s).some((a) => a.startsWith('kms:')));
  assert.ok(kmsStatements.length > 0, 'expected kms:Decrypt for encrypted secrets and data');

  for (const statement of kmsStatements) {
    for (const action of actionsOf(statement)) {
      assert.ok(
        /^kms:(Decrypt|DescribeKey|GenerateDataKey\*?)$/.test(action),
        `unexpected KMS action ${action}`,
      );
      assert.notEqual(action, 'kms:*');
    }
    assert.notEqual(JSON.stringify(statement.Resource), '"*"', 'KMS grant must name exact keys');
  }
});

test('application-enforced protections are not weakened by IAM', () => {
  // Tenant, client, target and ethical-wall checks live in the application.
  // IAM must not hand the task a way around the database it reads through.
  for (const action of allowActions(synth())) {
    assert.ok(!/^rds-data:/i.test(action), `task may not ${action}`);
    assert.ok(!/^rds:(Modify|Delete|Create|Restore)/i.test(action), `task may not ${action}`);
    assert.ok(!/^dynamodb:/i.test(action), `task may not ${action}`);
  }
});

test('the task role and execution role are distinct', () => {
  const roles = Object.keys(synth().findResources('AWS::IAM::Role'));
  assert.ok(roles.length >= 2, `expected separate execution and task roles, found ${roles.length}`);
});
