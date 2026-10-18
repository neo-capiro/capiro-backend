import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';
import {
  FIRST_CHAT_CORE_GET_PATHS,
  FIRST_CHAT_CORE_GUARD_RULE_EXPORT,
  FIRST_CHAT_CORE_HOST,
  FIRST_CHAT_CORE_IMAGE_PINS,
  FIRST_CHAT_CORE_MERI_TOOLS,
  FIRST_CHAT_CORE_NATIVE_OPS_PATHS,
  FIRST_CHAT_CORE_NATIVE_OPS_PRIORITY,
  FIRST_CHAT_CORE_POST_PATHS,
  FIRST_CHAT_CORE_RETIRED_PR48,
  firstChatCoreImageBinding,
  previewFirstChatCoreApplication,
} from '../lib/preview/first-chat-core';
import meriTools from '../lib/preview/first-chat-core-meri-tools.json';
import routes from '../lib/preview/first-chat-core-routes.json';

// Synthetic qualified-image pins; the committed source pins stay null until the
// integrated image is built and scanned.
const pins = {
  sourceHead: '0123456789abcdef0123456789abcdef01234567',
  imageDigest: `sha256:${'b'.repeat(64)}`,
};
const secretArn = (name: string) => `arn:aws:secretsmanager:us-east-1:967807252336:secret:synthetic/${name}-AbC123`;
// Synthetic readback slot; the real one comes from the live listener readback
// checked by infra/routing corePreviewPacketRules.
const binding = {
  schemaVersion: 3,
  sourceHead: pins.sourceHead,
  imageDigest: pins.imageDigest,
  internalServiceSecretArn: secretArn('internal-service'),
  retainedTrust: null,
  listener: { guardPriority: 4 },
};
const trust = {
  issuer: 'capiro-core-retained',
  intelOrigin: 'https://intel.example.invalid',
  principalKeyId: 'retained-principal-1',
  principalPrivateKeySecretArn: secretArn('retained-principal'),
  probeKeyId: 'retained-probe-1',
  probePrivateKeySecretArn: secretArn('retained-probe'),
};

function render(input: unknown, assertions: (stacks: ReturnType<typeof previewFirstChatCoreApplication>) => void) {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'capiro-first-chat-'));
  const tempRoot = fs.realpathSync(os.tmpdir());
  try {
    assertions(previewFirstChatCoreApplication(input, output, pins));
  } finally {
    const resolved = fs.realpathSync(output);
    assert.equal(fs.lstatSync(output).isSymbolicLink(), false);
    assert.ok(resolved.startsWith(`${tempRoot}${path.sep}`));
    fs.rmSync(resolved, { recursive: true });
  }
}

const serveContainer = (service: any) => {
  const stack = Template.fromStack(service).toJSON();
  const task = (Object.values(stack.Resources) as any[]).find((r) => r.Type === 'AWS::ECS::TaskDefinition');
  return task.Properties.ContainerDefinitions[0];
};
const envOf = (container: any) => Object.fromEntries(container.Environment.map((entry: any) => [entry.Name, entry.Value]));

test('refuses to render until a qualified integrated image is pinned, and never PR48', () => {
  assert.equal(FIRST_CHAT_CORE_IMAGE_PINS, null);
  assert.throws(() => firstChatCoreImageBinding(binding), /No qualified integrated Core image/);
  assert.throws(() => firstChatCoreImageBinding({ ...binding, ...FIRST_CHAT_CORE_RETIRED_PR48 }, pins));
  assert.throws(() => firstChatCoreImageBinding({ schemaVersion: 1, ...FIRST_CHAT_CORE_RETIRED_PR48 }, FIRST_CHAT_CORE_RETIRED_PR48));
});

test('requires the exact pinned image, exact secret ARNs and fixed retained trust fields', () => {
  assert.deepEqual(firstChatCoreImageBinding(binding, pins), binding);
  assert.deepEqual(firstChatCoreImageBinding({ ...binding, retainedTrust: trust }, pins), { ...binding, retainedTrust: trust });
  const { retainedTrust: _omitted, ...withoutTrust } = binding;
  for (const invalid of [
    { ...binding, sourceHead: 'e50aed3c5b5cce58317b37de442482fa970842cb' },
    { ...binding, imageDigest: 'latest' },
    { ...binding, imageDigest: `sha256:${'B'.repeat(64)}` },
    { ...binding, imageDigest: `sha256:${'a'.repeat(64)}` },
    { ...binding, databaseUrl: 'postgres://unreviewed.invalid/capiro' },
    { ...binding, schemaVersion: 1 },
    { ...binding, schemaVersion: 2 },
    { ...binding, internalServiceSecretArn: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:other-AbC123' },
    { ...binding, internalServiceSecretArn: 'arn:aws:secretsmanager:us-west-2:967807252336:secret:other-AbC123' },
    { ...binding, internalServiceSecretArn: 'arn:aws:secretsmanager:us-east-1:967807252336:secret:partial' },
    { ...binding, internalServiceSecretArn: 'plain-text-secret-value' },
    withoutTrust,
    { ...binding, retainedTrust: { ...trust, intelOrigin: 'http://intel.example.invalid' } },
    { ...binding, retainedTrust: { ...trust, intelOrigin: 'https://intel.example.invalid/intel-api' } },
    { ...binding, retainedTrust: { ...trust, principalKeyId: 'has space' } },
    { ...binding, retainedTrust: { ...trust, probePrivateKeySecretArn: trust.principalPrivateKeySecretArn } },
    { ...binding, retainedTrust: { ...trust, principalPrivateKeyPem: '-----BEGIN PRIVATE KEY-----' } },
    (({ listener: _listener, ...rest }) => rest)(binding),
    { ...binding, listener: null },
    { ...binding, listener: {} },
    { ...binding, listener: { guardPriority: 4, rulePriority: 3 } },
    ...[undefined, null, '4', 4.5, 0, 2, FIRST_CHAT_CORE_NATIVE_OPS_PRIORITY, 50001].map((guardPriority) => ({
      ...binding, listener: { guardPriority },
    })),
  ]) {
    assert.throws(() => firstChatCoreImageBinding(invalid, pins), JSON.stringify(invalid).slice(0, 80));
  }
});

test('keeps the exact Meri tool list and every listener pattern within ALB limits', () => {
  assert.deepEqual([...FIRST_CHAT_CORE_MERI_TOOLS], meriTools.tools);
  assert.ok(FIRST_CHAT_CORE_MERI_TOOLS.length > 0);
  assert.ok(!FIRST_CHAT_CORE_MERI_TOOLS.includes('get_florida_budget_project'));
  for (const values of [FIRST_CHAT_CORE_POST_PATHS, FIRST_CHAT_CORE_GET_PATHS, FIRST_CHAT_CORE_NATIVE_OPS_PATHS]) {
    assert.ok(values.length <= 3);
    for (const value of values) {
      assert.ok(value.length <= 128, value);
      assert.ok(value.startsWith('^') && value.endsWith('$'), value);
      assert.ok(!value.includes('(?'), value);
    }
  }
});

test("uses dot's compact preview layout and records the bounded tool perimeter", () => {
  // dot #121 6246021908: existing P1 POST / P2 GET / P3 host404, no shared rule moves.
  assert.deepEqual(routes.priorities, { post: 1, get: 2, guard: 3 });
  // dot #121 6246253130: one exact Core POST rule at P3; only the guard moves,
  // to a slot read back from the listener (never fixed in source).
  assert.deepEqual(routes.packet, { nativeOps: 3, guard: 'readback' });
  assert.equal(FIRST_CHAT_CORE_NATIVE_OPS_PRIORITY, 3);
  assert.deepEqual([...FIRST_CHAT_CORE_NATIVE_OPS_PATHS], [
    '^/api/clio/(approvals/native/(record|decision|execution)|memory/(review/(submit|status)|read_target|find_by_key))$',
  ]);
  assert.deepEqual([...FIRST_CHAT_CORE_POST_PATHS], routes.post);
  assert.deepEqual([...FIRST_CHAT_CORE_GET_PATHS], routes.get);
  assert.equal(routes.post[2],
    '^/api/clio/(conversations/bootstrap|clients/check-ref|retained-reads/research-portfolio(-changes)?|tools/[a-z][a-z0-9_]{1,63})$');
  assert.equal(routes.post[2].length, 127);
  // Perimeter tradeoff: any syntactically valid tool name reaches Core; Core then
  // refuses names outside the mandatory preview MERI_TOOL_ALLOWLIST after auth.
  const third = new RegExp(routes.post[2]);
  assert.ok(third.test('/api/clio/tools/send_email'));
  assert.ok(!meriTools.tools.includes('send_email'));
  for (const name of meriTools.tools) assert.ok(third.test(`/api/clio/tools/${name}`), name);
});

test('renders the retained-trust variant with server-side signing-key secrets only', () => {
  render({ ...binding, retainedTrust: trust }, ({ service }) => {
    const serve = serveContainer(service);
    const env = envOf(serve);
    assert.equal(env.RETAINED_READS_ENABLED, 'true');
    assert.equal(env.RETAINED_TRUST_ISSUER, trust.issuer);
    assert.equal(env.RETAINED_CORE_ORIGIN, `https://${FIRST_CHAT_CORE_HOST}`);
    assert.equal(env.RETAINED_INTEL_ORIGIN, trust.intelOrigin);
    assert.equal(env.RETAINED_PRINCIPAL_KEY_ID, trust.principalKeyId);
    assert.equal(env.RETAINED_PROBE_KEY_ID, trust.probeKeyId);
    assert.ok(Object.keys(env).every((name) => !name.endsWith('_PEM') && name !== 'INTERNAL_SERVICE_SECRET'));
    assert.deepEqual(serve.Secrets.map((secret: any) => secret.Name).sort(), [
      'CLERK_SECRET_KEY', 'CLERK_WEBHOOK_SIGNING_SECRET', 'DB_PASSWORD', 'DB_USER',
      'INTERNAL_SERVICE_SECRET', 'RETAINED_PRINCIPAL_PRIVATE_KEY_PEM', 'RETAINED_PROBE_PRIVATE_KEY_PEM',
    ]);
    const byName = Object.fromEntries(serve.Secrets.map((secret: any) => [secret.Name, secret.ValueFrom]));
    assert.equal(byName.RETAINED_PRINCIPAL_PRIVATE_KEY_PEM, trust.principalPrivateKeySecretArn);
    assert.equal(byName.RETAINED_PROBE_PRIVATE_KEY_PEM, trust.probePrivateKeySecretArn);
    assert.equal(byName.INTERNAL_SERVICE_SECRET, binding.internalServiceSecretArn);
  });
});

test('renders the stable P1/P2 rules and the P3 native-operations rule before the readback-slot guard', () => {
  render(binding, ({ guard, service }) => {
  const guardStack = Template.fromStack(guard).toJSON();
  const guardResources = Object.values(guardStack.Resources) as any[];
  assert.equal(guardResources.length, 1);
  const guardRule = guardResources[0];
  assert.equal(guardRule.Type, 'AWS::ElasticLoadBalancingV2::ListenerRule');
  assert.equal(guardRule.DeletionPolicy, 'Retain');
  assert.equal(guardRule.UpdateReplacePolicy, 'Retain');
  assert.equal(guardRule.Properties.Priority, binding.listener.guardPriority);
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
    assert.equal(container.Image, `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/preview-core@${pins.imageDigest}`);
    const environment = Object.fromEntries(
      container.Environment.map((entry: any) => [entry.Name, entry.Value]),
    );
    assert.equal(environment.RELEASE_SHA, pins.sourceHead);
    assert.equal(environment.PREVIEW_NATIVE_GETS_ENABLED, 'true');
    assert.equal(environment.MERI_TOOL_ALLOWLIST, meriTools.tools.join(','));
    assert.equal(environment.MERI_TOOLS_REQUIRE_SERVICE_SECRET, 'true');
    assert.equal(environment.CORE_DEPLOYMENT_PROFILE, 'first-chat-preview');
    assert.equal(environment.RETAINED_READS_ENABLED, 'false');
    assert.ok(!Object.keys(environment).some((name) => name.startsWith('RETAINED_') && name !== 'RETAINED_READS_ENABLED'));
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
    'INTERNAL_SERVICE_SECRET',
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
    'FirstChatNativeOpsPostOnly',
    'FirstChatPostsOnly',
  ]);
  const rules = ruleEntries.map(([, rule]) => rule as any);
  assert.deepEqual(rules.map((rule) => rule.Properties.Priority).sort(), [1, 2, 3]);
  const nativeOps = stack.Resources.FirstChatNativeOpsPostOnly;
  assert.deepEqual(nativeOps.Properties.Conditions, [
    { Field: 'host-header', HostHeaderConfig: { Values: [FIRST_CHAT_CORE_HOST] } },
    { Field: 'path-pattern', PathPatternConfig: { RegexValues: [...FIRST_CHAT_CORE_NATIVE_OPS_PATHS] } },
    { Field: 'http-request-method', HttpRequestMethodConfig: { Values: ['POST'] } },
  ]);
  const nativePattern = new RegExp(FIRST_CHAT_CORE_NATIVE_OPS_PATHS[0]!);
  for (const opPath of [
    '/api/clio/approvals/native/record', '/api/clio/approvals/native/decision',
    '/api/clio/memory/review/submit', '/api/clio/memory/review/status',
    '/api/clio/memory/read_target', '/api/clio/memory/find_by_key',
  ]) assert.ok(nativePattern.test(opPath), opPath);
  for (const opPath of [
    '/api/clio/approvals/native/read', '/api/clio/memory/recent', '/api/clio/memory/review/submit/x',
    '/api/clio/memory/read_target/', '/api/clio/approvals/native/record?x=1',
  ]) assert.ok(!nativePattern.test(opPath), opPath);
  const allowed = stack.Resources.FirstChatPostsOnly;
  const path = allowed.Properties.Conditions.find((condition: any) => condition.Field === 'path-pattern');
  assert.deepEqual(path.PathPatternConfig, { RegexValues: [...FIRST_CHAT_CORE_POST_PATHS] });
  const postPatterns = path.PathPatternConfig.RegexValues.map((value: string) => new RegExp(value));
  const postMatches = (candidate: string) => postPatterns.some((pattern: RegExp) => pattern.test(candidate));
  for (const allowedPath of [
    '/api/clio/conversations/bootstrap',
    '/api/clio/application-authority/identity',
    '/api/clio/application-authority/context',
    '/api/clio/application-authority/membership',
    '/api/clio/application-authority/read-mode-observation',
    '/api/clio/clients/check-ref',
    '/api/clio/application-authority/retained-research-portfolio',
    '/api/clio/application-authority/retained-research-portfolio-changes',
    '/api/clio/application-authority/retained-florida-budget',
    '/api/clio/application-authority/retained-research-portfolio-principal',
    '/api/clio/application-authority/retained-research-portfolio-changes-principal',
    '/api/clio/application-authority/retained-florida-principal',
    '/api/clio/application-authority/retained-florida-current',
    '/api/clio/application-authority/retained-florida-native-current',
    '/api/clio/retained-reads/research-portfolio',
    '/api/clio/retained-reads/research-portfolio-changes',
    ...meriTools.tools.map((name: string) => `/api/clio/tools/${name}`),
  ]) {
    assert.ok(postMatches(allowedPath), allowedPath);
  }
  for (const rejectedPath of [
    '/api/clio/conversations',
    '/api/clio/conversations/bootstrap/extra',
    '/api/clio/application-authority/other',
    '/api/clio/application-authority/context/extra',
    '/api/clio/application-authority/identity/extra',
    '/api/clio/application-authority/membership/extra',
    '/api/clio/application-authority/retained-florida-budget-principal',
    '/api/clio/application-authority/retained-florida-native',
    '/api/clio/retained-reads/research-portfolio/extra',
    '/api/clio/tools',
    '/api/clio/tools/',
    '/api/clio/tools/Search_Federal',
    '/api/clio/tools/a/b',
    '/api/clio/approvals/check',
    '/api/internal/objective-workload-authority/decisions',
    '/intel-api/internal/legiwatch/retained-florida-budget',
    '/api/me',
  ]) {
    assert.equal(postMatches(rejectedPath), false, rejectedPath);
  }
  const postMethod = allowed.Properties.Conditions.find(
    (condition: any) => condition.Field === 'http-request-method',
  );
  assert.deepEqual(postMethod.HttpRequestMethodConfig.Values, ['POST']);
  const reads = stack.Resources.FirstChatMembershipPostOnly;
  const readPath = reads.Properties.Conditions.find(
    (condition: any) => condition.Field === 'path-pattern',
  );
  assert.deepEqual(readPath.PathPatternConfig, { RegexValues: [...FIRST_CHAT_CORE_GET_PATHS] });
  const readMethod = reads.Properties.Conditions.find(
    (condition: any) => condition.Field === 'http-request-method',
  );
  assert.deepEqual(readMethod.HttpRequestMethodConfig.Values, ['GET']);
  const readPatterns = readPath.PathPatternConfig.RegexValues.map((value: string) => new RegExp(value));
  for (const allowedPath of [
    '/api/me',
    '/api/clients',
    '/api/clients/123e4567-e89b-42d3-a456-426614174000',
    '/api/research-portfolios/123e4567-e89b-42d3-a456-426614174000',
    '/api/research-portfolios/123e4567-e89b-42d3-a456-426614174000/changes',
    '/api/research-portfolios/123e4567-e89b-42d3-a456-426614174000/reviews',
    '/api/research-portfolios/123e4567-e89b-42d3-a456-426614174000/annual-review',
    '/api/research-portfolios/123e4567-e89b-42d3-a456-426614174000/snapshots/123e4567-e89b-42d3-a456-426614174001',
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
    '/api/research-portfolios',
    '/api/research-portfolios/123e4567-e89b-42d3-a456-426614174000/snapshots',
    '/api/research-portfolios/123e4567-e89b-42d3-a456-426614174000/analytics',
    '/api/research-portfolios/not-a-uuid',
  ]) {
    assert.ok(readPatterns.every((pattern: RegExp) => !pattern.test(rejectedPath)), rejectedPath);
  }
  assert.ok(rules.every((rule) => rule.Properties.Actions.length === 1));
  assert.ok(rules.every((rule) => rule.Properties.Actions[0].Type === 'forward'));
  assert.deepEqual(
    rules.map((rule) => rule.Properties.Actions[0].TargetGroupArn),
    [1, 2, 3].map(() => ({ Ref: targetLogicalId })),
  );
  for (const rule of rules) {
    const host = rule.Properties.Conditions.find((condition: any) => condition.Field === 'host-header');
    assert.deepEqual(host.HostHeaderConfig.Values, [FIRST_CHAT_CORE_HOST]);
  }
  });
});
