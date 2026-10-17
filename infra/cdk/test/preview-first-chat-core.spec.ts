import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';
import {
  FIRST_CHAT_CORE_GUARD_RULE_EXPORT,
  FIRST_CHAT_CORE_HOST,
  FIRST_CHAT_CORE_IMAGE_DIGEST,
  FIRST_CHAT_CORE_SOURCE,
  firstChatCoreImageBinding,
  previewFirstChatCoreApplication,
} from '../lib/preview/first-chat-core';

const binding = {
  schemaVersion: 1,
  sourceHead: FIRST_CHAT_CORE_SOURCE,
  imageDigest: FIRST_CHAT_CORE_IMAGE_DIGEST,
};

test('requires the exact Core source and immutable image digest', () => {
  assert.deepEqual(firstChatCoreImageBinding(binding), binding);
  for (const invalid of [
    { ...binding, sourceHead: 'e50aed3c5b5cce58317b37de442482fa970842cb' },
    { ...binding, imageDigest: 'latest' },
    { ...binding, imageDigest: `sha256:${'A'.repeat(64)}` },
    { ...binding, imageDigest: `sha256:${'a'.repeat(64)}` },
    { ...binding, databaseUrl: 'postgres://unreviewed.invalid/capiro' },
    { ...binding, schemaVersion: 2 },
  ]) {
    assert.throws(() => firstChatCoreImageBinding(invalid));
  }
});

test('renders two stable listener rules for four POSTs and three GETs before the retained guard', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'capiro-first-chat-'));
  const tempRoot = fs.realpathSync(os.tmpdir());
  try {
  const { guard, service } = previewFirstChatCoreApplication(binding, output);
  const guardStack = Template.fromStack(guard).toJSON();
  const guardResources = Object.values(guardStack.Resources) as any[];
  assert.equal(guardResources.length, 1);
  const guardRule = guardResources[0];
  assert.equal(guardRule.Type, 'AWS::ElasticLoadBalancingV2::ListenerRule');
  assert.equal(guardRule.DeletionPolicy, 'Retain');
  assert.equal(guardRule.UpdateReplacePolicy, 'Retain');
  assert.equal(guardRule.Properties.Priority, 3);
  assert.deepEqual(guardRule.Properties.Conditions, [
    { Field: 'host-header', HostHeaderConfig: { Values: [FIRST_CHAT_CORE_HOST] } },
  ]);
  assert.deepEqual(guardRule.Properties.Actions, [{
    Type: 'fixed-response',
    FixedResponseConfig: {
      StatusCode: '404',
      ContentType: 'application/json',
      MessageBody: '{"error":"PREVIEW_ROUTE_NOT_FOUND"}',
    },
  }]);
  assert.equal(guardStack.Outputs.PreviewHostGuardRuleArn.Export.Name, FIRST_CHAT_CORE_GUARD_RULE_EXPORT);
  assert.deepEqual(guardStack.Outputs.PreviewHostGuardRuleArn.Value, { Ref: 'RejectOtherPreviewHostTraffic' });
  const stack = Template.fromStack(service).toJSON();
  assert.deepEqual(stack.Outputs.RequiredPreviewHostGuardRuleArn.Value, {
    'Fn::ImportValue': FIRST_CHAT_CORE_GUARD_RULE_EXPORT,
  });
  const resources = Object.values(stack.Resources) as any[];
  assert.equal(
    resources.filter((r) => r.Type === 'AWS::ECR::Repository').length,
    0,
  );
  const tasks = resources.filter((r) => r.Type === 'AWS::ECS::TaskDefinition');
  assert.equal(tasks.length, 1);
  const containers = tasks.map((task) => task.Properties.ContainerDefinitions[0]);
  assert.deepEqual(containers.map((container) => container.Command), [['serve']]);
  for (const container of containers) {
    assert.equal(container.Image, `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/preview-core@${FIRST_CHAT_CORE_IMAGE_DIGEST}`);
    const environment = Object.fromEntries(
      container.Environment.map((entry: any) => [entry.Name, entry.Value]),
    );
    assert.equal(environment.RELEASE_SHA, FIRST_CHAT_CORE_SOURCE);
  }
  const serve = containers.find((container) => container.Name === 'core');
  assert.deepEqual(serve.HealthCheck, {
    Command: ['CMD-SHELL', 'wget -q -O /dev/null http://127.0.0.1:4000/health || exit 1'],
    Interval: 15,
    Timeout: 5,
    Retries: 3,
    StartPeriod: 60,
  });
  assert.deepEqual(serve.Secrets.map((secret: any) => secret.Name).sort(), [
    'CLERK_SECRET_KEY',
    'CLERK_WEBHOOK_SIGNING_SECRET',
    'DB_PASSWORD',
    'DB_USER',
  ]);
  const serveEnv = Object.fromEntries(
    serve.Environment.map((entry: any) => [entry.Name, entry.Value]),
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(serveEnv).filter(([name]) =>
      [
        'CAPIRO_SERVICE_NAME',
        'ENGAGEMENT_PROCESS_MODE',
        'ENGAGEMENT_BACKGROUND_OWNER',
        'ENGAGEMENT_EXTERNAL_ACTIONS',
        'ENGAGEMENT_CALLBACKS_ENABLED',
        'ENGAGEMENT_RECALL_WEBHOOK_ENABLED',
        'CLIENT_PROFILE_FILL_WORKER_ENABLED',
        'CLIENT_PROFILE_FILL_COMPLETION_WORKER_ENABLED',
        'MERI_JOB_SWEEPER_ENABLED',
        'RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED',
        'NEWSLETTER_REVIEW_EMAIL_ENABLED',
        'NEWSLETTER_INVITATION_EMAIL_ENABLED',
      ].includes(name))),
    {
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
  );
  const services = resources.filter((r) => r.Type === 'AWS::ECS::Service');
  assert.equal(services.length, 1);
  assert.equal(services[0].Properties.DesiredCount, 0);
  assert.ok(services[0].DependsOn.some((id: string) => id.startsWith('FirstChatPostsOnly')));
  assert.ok(services[0].DependsOn.some((id: string) => id.startsWith('FirstChatMembershipPostOnly')));
  assert.equal(resources.filter((r) => r.Type === 'AWS::Events::Rule').length, 0);
  assert.equal(resources.filter((r) => r.Type === 'AWS::RDS::DBCluster').length, 0);
  assert.equal(resources.filter((r) => r.Type === 'AWS::SecretsManager::Secret').length, 0);
  assert.doesNotMatch(JSON.stringify(stack), /\/capiro\/dev\/aurora\/master-/);
  const executionPolicy = resources.find((r) => r.Type === 'AWS::IAM::Policy');
  const decryptStatements = executionPolicy.Properties.PolicyDocument.Statement.filter(
    (statement: any) => statement.Action === 'kms:Decrypt',
  );
  assert.equal(decryptStatements.length, 1);
  assert.deepEqual([...decryptStatements[0].Resource].sort(), [
    'arn:aws:kms:us-east-1:967807252336:key/efe8a18d-192e-4f30-8eea-b3f65ae7755e',
    'arn:aws:kms:us-east-1:967807252336:key/f47b4c53-b9c0-4d91-ad57-4d882f87767e',
  ]);
  assert.deepEqual(decryptStatements[0].Condition, {
    StringEquals: { 'kms:ViaService': 'secretsmanager.us-east-1.amazonaws.com' },
  });

  const targets = resources.filter((r) => r.Type === 'AWS::ElasticLoadBalancingV2::TargetGroup');
  assert.equal(targets.length, 1);
  assert.equal(targets[0].Properties.HealthCheckPath, '/health');
  const targetLogicalId = Object.entries(stack.Resources).find(
    ([, resource]: [string, any]) => resource.Type === 'AWS::ElasticLoadBalancingV2::TargetGroup',
  )?.[0];
  assert.ok(targetLogicalId);
  assert.deepEqual(
    targets[0].Properties.Tags.find((tag: any) => tag.Key === 'capiro:preview-guard-rule-arn'),
    { Key: 'capiro:preview-guard-rule-arn', Value: { 'Fn::ImportValue': FIRST_CHAT_CORE_GUARD_RULE_EXPORT } },
  );
  const ruleEntries = Object.entries(stack.Resources).filter(
    ([, resource]: [string, any]) => resource.Type === 'AWS::ElasticLoadBalancingV2::ListenerRule',
  );
  assert.deepEqual(ruleEntries.map(([id]) => id).sort(), [
    'FirstChatMembershipPostOnly',
    'FirstChatPostsOnly',
  ]);
  const rules = ruleEntries.map(([, rule]) => rule as any);
  assert.deepEqual(rules.map((rule) => rule.Properties.Priority).sort(), [1, 2]);
  const allowed = stack.Resources.FirstChatPostsOnly;
  const path = allowed.Properties.Conditions.find((condition: any) => condition.Field === 'path-pattern');
  assert.deepEqual(path.PathPatternConfig, {
    RegexValues: ['^/api/clio/(conversations/bootstrap|application-authority/(identity|context|membership))$'],
  });
  const postPattern = new RegExp(path.PathPatternConfig.RegexValues[0]);
  for (const allowedPath of [
    '/api/clio/conversations/bootstrap',
    '/api/clio/application-authority/identity',
    '/api/clio/application-authority/context',
    '/api/clio/application-authority/membership',
  ]) {
    assert.ok(postPattern.test(allowedPath), allowedPath);
  }
  for (const rejectedPath of [
    '/api/clio/conversations',
    '/api/clio/conversations/bootstrap/extra',
    '/api/clio/application-authority/other',
    '/api/clio/application-authority/context/extra',
    '/api/clio/application-authority/identity/extra',
    '/api/clio/application-authority/membership/extra',
    '/api/me',
  ]) {
    assert.equal(postPattern.test(rejectedPath), false, rejectedPath);
  }
  const postMethod = allowed.Properties.Conditions.find(
    (condition: any) => condition.Field === 'http-request-method',
  );
  assert.deepEqual(postMethod.HttpRequestMethodConfig.Values, ['POST']);
  const reads = stack.Resources.FirstChatMembershipPostOnly;
  const readPath = reads.Properties.Conditions.find(
    (condition: any) => condition.Field === 'path-pattern',
  );
  assert.deepEqual(readPath.PathPatternConfig, {
    RegexValues: [
      '^/api/me$',
      '^/api/clients$',
      '^/api/clients/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    ],
  });
  const readMethod = reads.Properties.Conditions.find(
    (condition: any) => condition.Field === 'http-request-method',
  );
  assert.deepEqual(readMethod.HttpRequestMethodConfig.Values, ['GET']);
  const readPatterns = readPath.PathPatternConfig.RegexValues.map((value: string) => new RegExp(value));
  for (const allowedPath of [
    '/api/me',
    '/api/clients',
    '/api/clients/123e4567-e89b-42d3-a456-426614174000',
  ]) {
    assert.ok(readPatterns.some((pattern: RegExp) => pattern.test(allowedPath)), allowedPath);
  }
  for (const rejectedPath of [
    '/api/health',
    '/health',
    '/api/clients/',
    '/api/clients/not-a-uuid',
    '/api/clients/123e4567-e89b-42d3-a456-426614174000/history',
    '/api/clio/application-authority/identity',
    '/api/conversations/history',
    '/api/me/extra',
  ]) {
    assert.ok(readPatterns.every((pattern: RegExp) => !pattern.test(rejectedPath)), rejectedPath);
  }
  assert.ok(rules.every((rule) => rule.Properties.Actions.length === 1));
  assert.ok(rules.every((rule) => rule.Properties.Actions[0].Type === 'forward'));
  assert.deepEqual(
    rules.map((rule) => rule.Properties.Actions[0].TargetGroupArn),
    [1, 2].map(() => ({ Ref: targetLogicalId })),
  );
  for (const rule of rules) {
    const host = rule.Properties.Conditions.find((condition: any) => condition.Field === 'host-header');
    assert.deepEqual(host.HostHeaderConfig.Values, [FIRST_CHAT_CORE_HOST]);
  }
  } finally {
    const resolved = fs.realpathSync(output);
    assert.equal(fs.lstatSync(output).isSymbolicLink(), false);
    assert.ok(resolved.startsWith(`${tempRoot}${path.sep}`));
    fs.rmSync(resolved, { recursive: true });
  }
});
