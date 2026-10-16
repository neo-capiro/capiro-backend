import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';
import {
  FIRST_CHAT_CORE_HOST,
  FIRST_CHAT_CORE_SOURCE,
  firstChatCoreImageBinding,
  previewFirstChatCoreApplication,
} from '../lib/preview/first-chat-core';

const binding = {
  schemaVersion: 1,
  sourceHead: FIRST_CHAT_CORE_SOURCE,
  imageDigest: `sha256:${'a'.repeat(64)}`,
};

test('requires the exact Core source and immutable image digest', () => {
  assert.deepEqual(firstChatCoreImageBinding(binding), binding);
  for (const invalid of [
    { ...binding, sourceHead: 'e50aed3c5b5cce58317b37de442482fa970842cb' },
    { ...binding, imageDigest: 'latest' },
    { ...binding, imageDigest: `sha256:${'A'.repeat(64)}` },
    { ...binding, databaseUrl: 'postgres://unreviewed.invalid/capiro' },
    { ...binding, schemaVersion: 2 },
  ]) {
    assert.throws(() => firstChatCoreImageBinding(invalid));
  }
});

test('renders a held service with only four public POST paths and an unscheduled read-only migration task', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'capiro-first-chat-'));
  const tempRoot = fs.realpathSync(os.tmpdir());
  try {
  const { registry, service } = previewFirstChatCoreApplication(binding, output);
  const repo = Template.fromStack(registry).toJSON();
  const stack = Template.fromStack(service).toJSON();
  const resources = Object.values(stack.Resources) as any[];
  assert.equal(
    Object.values(repo.Resources).filter((r: any) => r.Type === 'AWS::ECR::Repository').length,
    1,
  );
  const tasks = resources.filter((r) => r.Type === 'AWS::ECS::TaskDefinition');
  assert.equal(tasks.length, 2);
  const containers = tasks.map((task) => task.Properties.ContainerDefinitions[0]);
  assert.deepEqual(containers.map((container) => container.Command).sort(), [
    ['migration-status'],
    ['serve'],
  ]);
  for (const container of containers) {
    assert.match(container.Image, /capiro\/preview-core@sha256:a{64}$/);
    const environment = Object.fromEntries(
      container.Environment.map((entry: any) => [entry.Name, entry.Value]),
    );
    assert.equal(environment.RELEASE_SHA, FIRST_CHAT_CORE_SOURCE);
  }
  const migrate = containers.find((container) => container.Name === 'migration');
  assert.deepEqual(migrate.Secrets.map((secret: any) => secret.Name).sort(), [
    'DB_PASSWORD',
    'DB_USER',
  ]);
  const serve = containers.find((container) => container.Name === 'core');
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

  const targets = resources.filter((r) => r.Type === 'AWS::ElasticLoadBalancingV2::TargetGroup');
  assert.equal(targets.length, 1);
  assert.equal(targets[0].Properties.HealthCheckPath, '/health');
  const rules = resources.filter((r) => r.Type === 'AWS::ElasticLoadBalancingV2::ListenerRule');
  assert.deepEqual(rules.map((rule) => rule.Properties.Priority).sort(), [1, 2, 3]);
  const allowed = rules.find((rule) => rule.Properties.Priority === 1);
  const path = allowed.Properties.Conditions.find((condition: any) => condition.Field === 'path-pattern');
  assert.deepEqual(path.PathPatternConfig.Values.sort(), [
    '/api/clio/application-authority/context',
    '/api/clio/application-authority/identity',
    '/api/clio/conversations/bootstrap',
  ]);
  assert.ok(path.PathPatternConfig.Values.every((value: string) => !value.includes('*')));
  const membership = rules.find((rule) => rule.Properties.Priority === 2);
  const membershipPath = membership.Properties.Conditions.find(
    (condition: any) => condition.Field === 'path-pattern',
  );
  assert.deepEqual(membershipPath.PathPatternConfig.Values, [
    '/api/clio/application-authority/membership',
  ]);
  for (const rule of [allowed, membership]) {
    const method = rule.Properties.Conditions.find(
      (condition: any) => condition.Field === 'http-request-method',
    );
    assert.deepEqual(method.HttpRequestMethodConfig.Values, ['POST']);
  }
  for (const rule of rules) {
    const host = rule.Properties.Conditions.find((condition: any) => condition.Field === 'host-header');
    assert.deepEqual(host.HostHeaderConfig.Values, [FIRST_CHAT_CORE_HOST]);
  }
  assert.equal(
    rules.find((rule) => rule.Properties.Priority === 3).Properties.Actions[0].FixedResponseConfig
      .StatusCode,
    '404',
  );
  } finally {
    const resolved = fs.realpathSync(output);
    assert.equal(fs.lstatSync(output).isSymbolicLink(), false);
    assert.ok(resolved.startsWith(`${tempRoot}${path.sep}`));
    fs.rmSync(resolved, { recursive: true });
  }
});
