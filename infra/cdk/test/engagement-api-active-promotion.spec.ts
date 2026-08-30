/**
 * engagement-api active promotion — the opt-in path OUT of shadow posture.
 *
 * Every test here either (a) proves the shadow-default path is UNCHANGED by
 * this feature's existence, or (b) proves the promoted path renders EXACTLY
 * the five-control-plus-token active posture, the ten additional secrets, and
 * the scoped S3 write grant — nothing more, nothing partial.
 *
 * Run: pnpm --dir infra/cdk exec ts-node --prefer-ts-exts \
 *        test/engagement-api-active-promotion.spec.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import {
  collectConfigFailures,
  ENGAGEMENT_API_PROMOTION_ACKNOWLEDGEMENT,
  type EngagementApiActivePromotion,
  type EngagementApiInfraConfig,
} from '../lib/engagement-api/engagement-api-config';
import {
  ENGAGEMENT_API_ACTIVE_ONLY_SECRETS,
  ENGAGEMENT_API_OMITTED_SECRETS,
  buildEngagementApiIam,
} from '../lib/engagement-api/engagement-api-iam';
import {
  engagementApiTaskEnvironment,
  EngagementApiServiceStack,
} from '../lib/engagement-api/engagement-api-service-stack';

const CDK_ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(CDK_ROOT, 'fixtures/engagement-api.test.json');
const TARGET_GROUP_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/capiro-dev-engagement-api/3333';

const validPromotion = (): EngagementApiActivePromotion => ({
  acknowledgedRisk: ENGAGEMENT_API_PROMOTION_ACKNOWLEDGEMENT,
  callbackBaseUrl: 'https://engagement.test.capiro.invalid',
  secretArns: {
    microsoftClientId: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:ms-client-id-AAAAAA',
    microsoftTenantId: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:ms-tenant-id-BBBBBB',
    microsoftCertThumbprint:
      'arn:aws:secretsmanager:us-east-1:000000000000:secret:ms-cert-thumb-CCCCCC',
    microsoftCertPrivateKey:
      'arn:aws:secretsmanager:us-east-1:000000000000:secret:ms-cert-key-DDDDDD',
    googleClientId: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:google-client-id-EEEEEE',
    googleClientSecret:
      'arn:aws:secretsmanager:us-east-1:000000000000:secret:google-client-secret-FFFFFF',
    recallApiKey: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:recall-api-key-GGGGGG',
    recallWebhookSecret:
      'arn:aws:secretsmanager:us-east-1:000000000000:secret:recall-webhook-secret-HHHHHH',
    oauthStateSecret: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:oauth-state-IIIIII',
    aiCredentialEncryptionKey:
      'arn:aws:secretsmanager:us-east-1:000000000000:secret:ai-cred-key-JJJJJJ',
  },
});

const base = (): EngagementApiInfraConfig => {
  const cfg = JSON.parse(readFileSync(FIXTURE, 'utf8')) as EngagementApiInfraConfig;
  cfg.imageDigest = `sha256:${'ab'.repeat(32)}`;
  cfg.releaseSha = 'c'.repeat(40);
  return cfg;
};

function synth(cfg: EngagementApiInfraConfig): Template {
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
const actionsOf = (s: Statement): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action]);

function containerEnv(template: Template): Record<string, string> {
  const tasks = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
  const container = (tasks[0] as { Properties: Record<string, any> }).Properties
    .ContainerDefinitions[0];
  const entries = (container.Environment ?? []) as Array<{ Name: string; Value: string }>;
  return Object.fromEntries(entries.map((e) => [e.Name, e.Value]));
}

function containerSecrets(template: Template): Record<string, unknown> {
  const tasks = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
  const container = (tasks[0] as { Properties: Record<string, any> }).Properties
    .ContainerDefinitions[0];
  const entries = (container.Secrets ?? []) as Array<{ Name: string; ValueFrom: unknown }>;
  return Object.fromEntries(entries.map((e) => [e.Name, e.ValueFrom]));
}

// ─────────────────────────────────────────────────── engagementApiTaskEnvironment (unit)

test('absent activePromotion renders the exact same env as before this feature existed', () => {
  const cfg = base();
  const env = engagementApiTaskEnvironment(cfg);
  assert.equal(env.ENGAGEMENT_PROCESS_MODE, 'shadow');
  assert.equal(env.ENGAGEMENT_BACKGROUND_OWNER, 'disabled');
  assert.equal(env.ENGAGEMENT_EXTERNAL_ACTIONS, 'disabled');
  assert.equal(env.ENGAGEMENT_CALLBACKS_ENABLED, 'false');
  assert.equal(env.ENGAGEMENT_RECALL_WEBHOOK_ENABLED, 'false');
  assert.equal(env.ENGAGEMENT_API_PROMOTION_TOKEN, undefined);
  assert.equal(env.MICROSOFT_REDIRECT_URI, undefined);
  assert.equal(env.MICROSOFT_GRAPH_NOTIFICATION_URL, undefined);
  assert.equal(env.GOOGLE_REDIRECT_URI, undefined);
  assert.equal(env.ASSETS_BUCKET, undefined);
});

// Regression: PR #1297 granted this task's role s3:PutObject/DeleteObject on
// cfg.bucketNames.assets once promoted (engagement-api-iam.ts's
// EngagementApiActivePromotionWriteObjects statement), but
// engagementApiTaskEnvironment() never set ASSETS_BUCKET — the env var
// engagement.service.ts actually reads to find that bucket
// (`this.bucket = config.get('ASSETS_BUCKET', ...)`). The IAM grant existed
// with no way for the app to use it, so every attachment
// upload/confirm/extract/delete call on the promoted task 503'd with
// "ASSETS_BUCKET is not configured" — live-confirmed on capiro-dev
// 2026-08-30 (QA-01). This test would have caught it before merge.
test('activePromotion sets ASSETS_BUCKET to cfg.bucketNames.assets, matching the S3 write grant', () => {
  const cfg = base();
  cfg.activePromotion = validPromotion();
  const env = engagementApiTaskEnvironment(cfg);
  assert.equal(env.ASSETS_BUCKET, cfg.bucketNames.assets);
  assert.ok(env.ASSETS_BUCKET, 'ASSETS_BUCKET must be a non-empty bucket name once promoted');
});

test('activePromotion flips all five posture fields AND sets the promotion token', () => {
  const cfg = base();
  cfg.activePromotion = validPromotion();
  const env = engagementApiTaskEnvironment(cfg);
  assert.equal(env.ENGAGEMENT_PROCESS_MODE, 'active');
  assert.equal(env.ENGAGEMENT_BACKGROUND_OWNER, 'engagement-api');
  assert.equal(env.ENGAGEMENT_EXTERNAL_ACTIONS, 'enabled');
  assert.equal(env.ENGAGEMENT_CALLBACKS_ENABLED, 'true');
  assert.equal(env.ENGAGEMENT_RECALL_WEBHOOK_ENABLED, 'true');
  assert.equal(env.ENGAGEMENT_API_PROMOTION_TOKEN, ENGAGEMENT_API_PROMOTION_ACKNOWLEDGEMENT);
});

test('activePromotion points every OAuth callback/notification URL at callbackBaseUrl', () => {
  const cfg = base();
  cfg.activePromotion = validPromotion();
  const env = engagementApiTaskEnvironment(cfg);
  assert.equal(
    env.MICROSOFT_REDIRECT_URI,
    'https://engagement.test.capiro.invalid/api/engagement/integrations/microsoft/callback',
  );
  assert.equal(
    env.MICROSOFT_GRAPH_NOTIFICATION_URL,
    'https://engagement.test.capiro.invalid/api/engagement/integrations/microsoft/notifications',
  );
  assert.equal(
    env.GOOGLE_REDIRECT_URI,
    'https://engagement.test.capiro.invalid/api/engagement/integrations/google/callback',
  );
});

test('Outreach V3 env vars are unaffected by promotion either way', () => {
  const shadow = engagementApiTaskEnvironment(base());
  const promoted = { ...base(), activePromotion: validPromotion() };
  const active = engagementApiTaskEnvironment(promoted);
  for (const key of [
    'OUTREACH_V3_STATE_ENABLED',
    'OUTREACH_V3_GENERATION_ENABLED',
    'OUTREACH_V3_SEND_ENABLED',
    'ENGAGEMENT_GENERATION_GATEWAY',
    'ENGAGEMENT_VERSIONED_OUTREACH',
    'OUTREACH_V3_GENERATION_MODEL',
  ]) {
    assert.equal(shadow[key], active[key], `${key} must not change with promotion`);
  }
});

// ─────────────────────────────────────────────────── config validation (collectConfigFailures)

test('a config with no activePromotion key validates exactly as before', () => {
  const cfg = base();
  delete (cfg as Partial<EngagementApiInfraConfig>).activePromotion;
  const { failures } = collectConfigFailures(cfg);
  assert.deepEqual(failures, []);
});

test('activePromotion.acknowledgedRisk must be the EXACT string, not merely truthy', () => {
  const cfg = base();
  cfg.activePromotion = { ...validPromotion(), acknowledgedRisk: 'true' };
  const { failures, config } = collectConfigFailures(cfg);
  assert.ok(!config);
  assert.ok(failures.some((f) => /acknowledgedRisk/.test(f)));
});

test('activePromotion.callbackBaseUrl must be a valid https URL', () => {
  for (const bad of ['not-a-url', 'http://engagement.test.invalid', '']) {
    const cfg = base();
    cfg.activePromotion = { ...validPromotion(), callbackBaseUrl: bad };
    const { failures, config } = collectConfigFailures(cfg);
    assert.ok(!config, `expected ${JSON.stringify(bad)} to fail`);
    assert.ok(failures.some((f) => /callbackBaseUrl/.test(f)));
  }
});

test('every one of the ten secretArns fields is validated as a real secretsmanager ARN', () => {
  const fields = Object.keys(validPromotion().secretArns) as Array<
    keyof EngagementApiActivePromotion['secretArns']
  >;
  assert.equal(fields.length, 10);
  for (const field of fields) {
    const cfg = base();
    const promo = validPromotion();
    (promo.secretArns as Record<string, string>)[field] = 'not-an-arn';
    cfg.activePromotion = promo;
    const { failures, config } = collectConfigFailures(cfg);
    assert.ok(!config, `expected a malformed ${field} to fail validation`);
    assert.ok(failures.some((f) => f.includes(field)));
  }
});

test('a fully valid activePromotion block passes with zero failures', () => {
  const cfg = base();
  cfg.activePromotion = validPromotion();
  const { failures, config } = collectConfigFailures(cfg);
  assert.deepEqual(failures, []);
  assert.ok(config);
});

// ─────────────────────────────────────────────────── buildEngagementApiIam (defense in depth)

test('buildEngagementApiIam independently rejects a wrong acknowledgedRisk even bypassing collectConfigFailures', () => {
  const cfg = base();
  cfg.activePromotion = { ...validPromotion(), acknowledgedRisk: 'yes-please' };
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'Test');
  const taskDefinition = new (require('aws-cdk-lib/aws-ecs').FargateTaskDefinition)(
    stack,
    'Td',
    { family: 'test' },
  );
  assert.throws(
    () => buildEngagementApiIam(stack, cfg, taskDefinition),
    /acknowledgedRisk does not match/,
  );
});

// ─────────────────────────────────────────────────── synthesized template (integration)

test('shadow synth (no activePromotion) injects none of the ten active-only secrets', () => {
  const secrets = Object.keys(containerSecrets(synth(base())));
  for (const name of ENGAGEMENT_API_ACTIVE_ONLY_SECRETS) {
    assert.ok(!secrets.includes(name), `${name} must not be injected in shadow posture`);
  }
});

test('promoted synth injects exactly the ten active-only secrets, each from its own configured ARN', () => {
  const cfg = base();
  cfg.activePromotion = validPromotion();
  const secrets = containerSecrets(synth(cfg));
  const promo = validPromotion();
  const arnOf = (valueFrom: unknown) => String(valueFrom).split(':secret:')[1]?.split(':')[0];

  const expectedArnName = (arn: string) => arn.split(':secret:')[1]?.split(':')[0];

  assert.equal(arnOf(secrets.MICROSOFT_CLIENT_ID), expectedArnName(promo.secretArns.microsoftClientId));
  assert.equal(arnOf(secrets.MICROSOFT_TENANT_ID), expectedArnName(promo.secretArns.microsoftTenantId));
  assert.equal(
    arnOf(secrets.MICROSOFT_CERT_THUMBPRINT),
    expectedArnName(promo.secretArns.microsoftCertThumbprint),
  );
  assert.equal(
    arnOf(secrets.MICROSOFT_CERT_PRIVATE_KEY),
    expectedArnName(promo.secretArns.microsoftCertPrivateKey),
  );
  assert.equal(arnOf(secrets.GOOGLE_CLIENT_ID), expectedArnName(promo.secretArns.googleClientId));
  assert.equal(
    arnOf(secrets.GOOGLE_CLIENT_SECRET),
    expectedArnName(promo.secretArns.googleClientSecret),
  );
  assert.equal(arnOf(secrets.RECALL_API_KEY), expectedArnName(promo.secretArns.recallApiKey));
  assert.equal(
    arnOf(secrets.RECALL_WEBHOOK_SECRET),
    expectedArnName(promo.secretArns.recallWebhookSecret),
  );
  assert.equal(arnOf(secrets.OAUTH_STATE_SECRET), expectedArnName(promo.secretArns.oauthStateSecret));
  assert.equal(
    arnOf(secrets.AI_CREDENTIAL_ENCRYPTION_KEY),
    expectedArnName(promo.secretArns.aiCredentialEncryptionKey),
  );
});

test('shadow AND promoted synth both carry OPENAI_API_KEY and ANTHROPIC_API_KEY (unconditional, not promotion-gated)', () => {
  // Corrected 2026-08-26: these two were previously asserted omitted based on
  // stale reasoning. AiCredentialResolverService reads them as its global
  // BYOK fallback regardless of shadow/promoted runtime posture — see
  // engagement-api-iam.ts's ENGAGEMENT_API_SECRET_FIELDS comment for the full
  // call-path trace. Live discovery found both already granted on the
  // execution role in every historical TD revision.
  const shadowSecrets = Object.keys(containerSecrets(synth(base())));
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
    assert.ok(shadowSecrets.includes(name), `${name} must be present in shadow posture too`);
  }

  const promotedCfg = base();
  promotedCfg.activePromotion = validPromotion();
  const promotedSecrets = Object.keys(containerSecrets(synth(promotedCfg)));
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
    assert.ok(promotedSecrets.includes(name), `${name} must remain present after promotion`);
    assert.ok(!(ENGAGEMENT_API_OMITTED_SECRETS as readonly string[]).includes(name));
  }
});

test('promoted synth STILL omits SAM_GOV_API_KEY', () => {
  const cfg = base();
  cfg.activePromotion = validPromotion();
  const secrets = Object.keys(containerSecrets(synth(cfg)));
  assert.ok(!secrets.includes('SAM_GOV_API_KEY'), 'SAM_GOV_API_KEY must remain omitted even after promotion');
  assert.ok((ENGAGEMENT_API_OMITTED_SECRETS as readonly string[]).includes('SAM_GOV_API_KEY'));
});

test('promoted synth env carries the active posture end to end (full stack, not just the unit fn)', () => {
  const cfg = base();
  cfg.activePromotion = validPromotion();
  const env = containerEnv(synth(cfg));
  assert.equal(env.ENGAGEMENT_PROCESS_MODE, 'active');
  assert.equal(env.ENGAGEMENT_BACKGROUND_OWNER, 'engagement-api');
  assert.equal(env.ENGAGEMENT_EXTERNAL_ACTIONS, 'enabled');
  assert.equal(env.ENGAGEMENT_CALLBACKS_ENABLED, 'true');
  assert.equal(env.ENGAGEMENT_RECALL_WEBHOOK_ENABLED, 'true');
  assert.equal(env.ENGAGEMENT_API_PROMOTION_TOKEN, ENGAGEMENT_API_PROMOTION_ACKNOWLEDGEMENT);
});

// Regression (full stack): proves the S3 write IAM grant and the ASSETS_BUCKET
// env var the app needs to exercise that grant are never split — a promoted
// synth with a write allow but no bucket name (or vice versa) is exactly the
// live QA-01 bug (attachments/upload-url 503 "ASSETS_BUCKET is not
// configured" despite both ECS services reporting healthy).
test('promoted synth: ASSETS_BUCKET env var and the S3 write IAM grant are never split', () => {
  const cfg = base();
  cfg.activePromotion = validPromotion();
  const template = synth(cfg);

  const env = containerEnv(template);
  assert.equal(env.ASSETS_BUCKET, cfg.bucketNames.assets);

  const allowedWriteResources = allStatements(template)
    .filter((s) => s.Effect === 'Allow' && actionsOf(s).includes('s3:PutObject'))
    .flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]));
  const grantsWriteOnAssetsBucket = allowedWriteResources.some((r) =>
    JSON.stringify(r).includes(String(cfg.bucketNames.assets)),
  );
  assert.ok(
    grantsWriteOnAssetsBucket,
    'the promoted task role must hold s3:PutObject on the exact bucket ASSETS_BUCKET points at',
  );
});

test('shadow synth grants NO s3:PutObject/DeleteObject allow, and denies both (unchanged baseline)', () => {
  const allowed = allStatements(synth(base()))
    .filter((s) => s.Effect === 'Allow')
    .flatMap(actionsOf);
  assert.ok(!allowed.includes('s3:PutObject'));
  assert.ok(!allowed.includes('s3:DeleteObject'));
  const denied = allStatements(synth(base()))
    .filter((s) => s.Effect === 'Deny')
    .flatMap(actionsOf);
  assert.ok(denied.includes('s3:PutObject'));
  assert.ok(denied.includes('s3:DeleteObject'));
});

test('promoted synth grants s3:PutObject/DeleteObject scoped to assets+attachments only, and removes them from the deny list', () => {
  const cfg = base();
  cfg.activePromotion = validPromotion();
  const template = synth(cfg);
  const statements = allStatements(template);

  const allowWrite = statements.filter(
    (s) => s.Effect === 'Allow' && actionsOf(s).includes('s3:PutObject'),
  );
  assert.equal(allowWrite.length, 1, 'expected exactly one allow statement granting s3:PutObject');
  const resources = JSON.stringify(allowWrite[0]!.Resource);
  assert.match(resources, new RegExp(String(cfg.bucketNames.assets)));
  assert.match(resources, new RegExp(String(cfg.bucketNames.attachments)));
  // The read-only Directory bucket must NEVER be writable, promoted or not.
  assert.doesNotMatch(resources, new RegExp(String(cfg.bucketNames.directory)));

  const denied = statements.filter((s) => s.Effect === 'Deny').flatMap(actionsOf);
  assert.ok(!denied.includes('s3:PutObject'), 'PutObject must be removed from the deny list once promoted');
  assert.ok(!denied.includes('s3:DeleteObject'));
  // Every OTHER denial must remain absolute.
  for (const stillDenied of [
    'ses:SendEmail',
    'ecs:UpdateService',
    'elasticloadbalancing:CreateRule',
    'secretsmanager:PutSecretValue',
    'iam:PassRole',
    'kms:Encrypt',
  ]) {
    assert.ok(denied.includes(stillDenied), `${stillDenied} must remain denied after promotion`);
  }
});

test('promoted synth read-only bucket grants (GetObject/ListBucket) are unaffected — write is additive, not a replacement', () => {
  const cfg = base();
  cfg.activePromotion = validPromotion();
  const allowed = allStatements(synth(cfg))
    .filter((s) => s.Effect === 'Allow')
    .flatMap(actionsOf);
  assert.ok(allowed.includes('s3:GetObject'));
  assert.ok(allowed.includes('s3:ListBucket'));
});

test('the capiro:iam-posture tag reflects promotion', () => {
  const shadowTags = synth(base()).findResources('AWS::ECS::TaskDefinition');
  const shadowRendered = JSON.stringify(shadowTags);
  assert.match(shadowRendered, /least-privilege-shadow/);

  const cfg = base();
  cfg.activePromotion = validPromotion();
  const promotedRendered = JSON.stringify(synth(cfg).toJSON());
  assert.match(promotedRendered, /active-promotion-engagement-owner/);
});

test('no plaintext secret value appears anywhere in the promoted template either', () => {
  const cfg = base();
  cfg.activePromotion = validPromotion();
  const rendered = JSON.stringify(synth(cfg).toJSON());
  assert.doesNotMatch(rendered, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  assert.doesNotMatch(rendered, /\bsk_(live|test)_[A-Za-z0-9]/);
});
