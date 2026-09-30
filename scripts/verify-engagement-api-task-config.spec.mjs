import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { providerSecretProblems } from './lib/engagement-api-required-provider-secrets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(
  fs.readFileSync(path.join(root, 'infra/cdk/fixtures/engagement-api.test.json')),
);
const valid = [
  { Name: 'OPENAI_API_KEY', ValueFrom: cfg.openaiApiKeySecretArn },
  { Name: 'ANTHROPIC_API_KEY', ValueFrom: cfg.anthropicApiKeySecretArn },
];
test('current exact provider bindings pass in template and ECS forms', () => {
  assert.deepEqual(providerSecretProblems(valid, cfg), []);
  assert.deepEqual(
    providerSecretProblems(
      valid.map(({ Name, ValueFrom }) => ({ name: Name, valueFrom: ValueFrom })),
      cfg,
    ),
    [],
  );
});
for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
  test(`${name} missing or duplicated fails`, () => {
    assert.ok(
      providerSecretProblems(
        valid.filter((s) => s.Name !== name),
        cfg,
      ).length,
    );
    assert.ok(providerSecretProblems([...valid, valid.find((s) => s.Name === name)], cfg).length);
  });
  test(`${name} wrong or field-scoped binding fails`, () => {
    for (const value of [
      'arn:aws:secretsmanager:us-east-1:000000000000:secret:other-ABCDEF',
      valid.find((s) => s.Name === name).ValueFrom + ':key::',
      { Ref: 'SomeSecret' },
    ])
      assert.ok(
        providerSecretProblems(
          valid.map((s) => (s.Name === name ? { ...s, ValueFrom: value } : s)),
          cfg,
        ).length,
      );
  });
}
test('wildcard, foreign account/region, missing and field-scoped config ARNs fail', () => {
  for (const value of [
    undefined,
    cfg.openaiApiKeySecretArn + '*',
    cfg.openaiApiKeySecretArn + ':key::',
    cfg.openaiApiKeySecretArn.replace('us-east-1', 'us-west-2'),
    cfg.openaiApiKeySecretArn.replace('000000000000', '111111111111'),
  ])
    assert.ok(providerSecretProblems(valid, { ...cfg, openaiApiKeySecretArn: value }).length);
});

const source = JSON.parse(
  fs.readFileSync(
    path.join(root, 'scripts/fixtures/engagement-phase2-template/service.template.json'),
  ),
);
const task = (doc) =>
  Object.values(doc.Resources).find((r) => r.Type === 'AWS::ECS::TaskDefinition').Properties;
function verify(template, label) {
  const dir = path.join(root, '.artifacts', 'engagement-task-config-regressions');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, label + '.json');
  fs.writeFileSync(file, JSON.stringify(template));
  return spawnSync(
    process.execPath,
    [
      path.join(root, 'scripts/verify-engagement-api-task-config.mjs'),
      '--template',
      file,
      '--config',
      path.join(root, 'infra/cdk/fixtures/engagement-api.test.json'),
    ],
    { encoding: 'utf8' },
  );
}
test('current synthetic service template passes full verifier without modifying the source', () => {
  const previous = JSON.stringify(source),
    result = verify(source, 'valid');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ENGAGEMENT_API_TASK_CONFIG_HARDENED_VERIFIED/);
  assert.equal(JSON.stringify(source), previous);
});
const mutations = {
  'unexpected-prototype-name': (c) => {
    c.Secrets.push({ Name: 'constructor', ValueFrom: cfg.openaiApiKeySecretArn });
  },
  'missing-provider': (c) => {
    c.Secrets = c.Secrets.filter((s) => s.Name !== 'OPENAI_API_KEY');
  },
  'wrong-provider-arn': (c) => {
    c.Secrets.find((s) => s.Name === 'ANTHROPIC_API_KEY').ValueFrom = cfg.openaiApiKeySecretArn;
  },
  'duplicate-provider': (c) => {
    c.Secrets.push({ ...c.Secrets.find((s) => s.Name === 'OPENAI_API_KEY') });
  },
  'retired-webhook': (c) => {
    c.Secrets.push({
      Name: 'CLERK_WEBHOOK_SIGNING_SECRET',
      ValueFrom: cfg.clerkWebhookSigningSecretArn,
    });
  },
  'external-credential': (c) => {
    c.Secrets.push({ Name: 'RECALL_API_KEY', ValueFrom: cfg.openaiApiKeySecretArn });
  },
  'plaintext-provider': (c) => {
    c.Environment.push({ Name: 'OPENAI_API_KEY', Value: 'sk_test_dummy' });
  },
  'external-actions': (c) => {
    c.Environment.find((e) => e.Name === 'ENGAGEMENT_EXTERNAL_ACTIONS').Value = 'enabled';
  },
  'mutable-image': (c) => {
    c.Image = 'example:latest';
  },
  'wrong-owner': (c) => {
    c.Environment.find((e) => e.Name === 'ENGAGEMENT_BACKGROUND_OWNER').Value = 'engagement-api';
  },
};
for (const [label, mutate] of Object.entries(mutations))
  test(`full verifier rejects ${label}`, () => {
    const template = structuredClone(source);
    mutate(task(template).ContainerDefinitions[0]);
    const result = verify(template, label);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
  });
