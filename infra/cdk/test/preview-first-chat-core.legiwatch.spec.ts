import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { firstChatCoreLegiwatchConfiguration, LEGIWATCH_SOURCE_SECRET_NAMES } from '../lib/preview/first-chat-core-legiwatch';
import { main } from '../bin/preview-first-chat-core';
import { completeExternalSecretArn, legiwatchAgentEnvironment, loadConfig } from '../lib/config';
import * as cdk from 'aws-cdk-lib';
import { FIRST_CHAT_CORE_LIVE } from '../lib/preview/first-chat-core';

const secretArns = Object.fromEntries(LEGIWATCH_SOURCE_SECRET_NAMES.map((name) => [
  name, `arn:aws:secretsmanager:us-east-1:967807252336:secret:synthetic/${name}-ABC123`,
]));
const binding = { provider: 'bedrock', model: 'synthetic-reviewed-model', secretArns, kmsKeyArns: [] };

test('preview overlays keep Census ingestion-only and never embed key values or launch settings', () => {
  const overlay = firstChatCoreLegiwatchConfiguration(binding);
  assert.deepEqual(Object.keys(overlay).sort(), ['serve', 'syncWorker']);
  assert.equal(overlay.serve.secrets.some(({ name }) => name === 'CENSUS_API_KEY'), false);
  assert.equal(overlay.syncWorker.secrets.some(({ name }) => name === 'CENSUS_API_KEY'), true);
  for (const task of [overlay.serve, overlay.syncWorker]) {
    assert.deepEqual(Object.keys(task).sort(), ['environment', 'executionRolePolicy', 'secrets']);
    assert.deepEqual(task.environment, [
      { name: 'LEGIWATCH_AGENT_PROVIDER', value: 'bedrock' },
      { name: 'LEGIWATCH_AGENT_MODEL', value: binding.model },
    ]);
    assert.deepEqual(task.executionRolePolicy.Statement[0]!.Resource, task.secrets.map(({ valueFrom }) => valueFrom));
    assert.equal(task.secrets.some(({ name }) => name === 'ANTHROPIC_API_KEY'), false);
  }
});

test('explicit Anthropic configuration adds the referenced key and scoped KMS grants to both tasks', () => {
  const keyArn = 'arn:aws:kms:us-east-1:967807252336:key/00000000-0000-4000-8000-000000000001';
  const overlay = firstChatCoreLegiwatchConfiguration({ ...binding, provider: 'anthropic',
    secretArns: { ...secretArns, ANTHROPIC_API_KEY: 'arn:aws:secretsmanager:us-east-1:967807252336:secret:synthetic/claude-ABC123' },
    kmsKeyArns: [keyArn],
  });
  for (const task of [overlay.serve, overlay.syncWorker]) {
    assert.equal(task.secrets.some(({ name }) => name === 'ANTHROPIC_API_KEY'), true);
    assert.deepEqual(task.executionRolePolicy.Statement[1]!.Resource, [keyArn]);
    assert.deepEqual((task.executionRolePolicy.Statement[1]!.Condition as any).StringEquals['kms:EncryptionContext:SecretARN'],
      task.secrets.map(({ valueFrom }) => valueFrom));
  }
});

const refresh = {
  sourceHead: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}`,
  clusterArn: 'arn:aws:ecs:us-east-1:967807252336:cluster/capiro-dev',
  invocationRoleArn: 'arn:aws:iam::967807252336:role/synthetic-preview-events',
  subnetIds: ['subnet-1234567890abcdef0'], securityGroupIds: ['sg-1234567890abcdef0'],
  taskDefinition: {
    family: 'capiro-preview-legiwatch-impact',
    taskDefinitionArn: 'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-preview-legiwatch-impact:1',
    runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
    cpu: '512', memory: '1024', networkMode: 'awsvpc', requiresCompatibilities: ['FARGATE'],
    taskRoleArn: 'arn:aws:iam::967807252336:role/synthetic-preview-task',
    executionRoleArn: 'arn:aws:iam::967807252336:role/synthetic-preview-execution',
    containerDefinitions: [{
      name: 'api', essential: true,
      image: `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/preview-core@sha256:${'b'.repeat(64)}`,
      environment: Object.entries({
        DB_HOST: FIRST_CHAT_CORE_LIVE.dbHost, DB_PORT: '5432', DB_NAME: 'capiro', RELEASE_SHA: 'a'.repeat(40),
        LEGIWATCH_AGENT_PROVIDER: binding.provider, LEGIWATCH_AGENT_MODEL: binding.model,
      }).map(([name, value]) => ({ name, value })),
      secrets: [
        ...Object.entries(secretArns).map(([name, valueFrom]) => ({ name, valueFrom })),
        { name: 'DB_USER', valueFrom: `${FIRST_CHAT_CORE_LIVE.dbAppSecretArn}:username::` },
        { name: 'DB_PASSWORD', valueFrom: `${FIRST_CHAT_CORE_LIVE.dbAppSecretArn}:password::` },
      ],
    }],
  },
};

test('refresh renderer emits executable canary, disabled schedule, and exact-role invocation requests', () => {
  const plan = firstChatCoreLegiwatchConfiguration({ ...binding, refresh }).refresh!;
  assert.equal(plan.putRuleRequest.State, 'DISABLED');
  assert.equal(plan.putRuleRequest.ScheduleExpression, 'rate(15 minutes)');
  const target = plan.putTargetsRequest.Targets[0]!;
  assert.equal(target.EcsParameters.TaskDefinitionArn, refresh.taskDefinition.taskDefinitionArn);
  assert.equal(target.EcsParameters.NetworkConfiguration.awsvpcConfiguration.AssignPublicIp, 'DISABLED');
  assert.deepEqual(target.RetryPolicy, { MaximumEventAgeInSeconds: 900, MaximumRetryAttempts: 0 });
  assert.deepEqual(JSON.parse(target.Input), plan.runTaskRequest.overrides);
  assert.deepEqual(plan.runTaskRequest.overrides.containerOverrides[0]!.command,
    ['refresh-legiwatch-impact', '--limit', '10', '--discovery-limit', '100']);
  assert.deepEqual(plan.runTaskRequest.overrides.containerOverrides[0]!.environment,
    [{ name: 'LEGIWATCH_IMPACT_REFRESH_TIMEOUT_MS', value: '240000' }]);
  const grants = JSON.parse(plan.putInvocationRolePolicyRequest.PolicyDocument).Statement;
  assert.equal(grants[0].Resource, refresh.taskDefinition.taskDefinitionArn);
  assert.deepEqual(grants[1].Resource, [refresh.taskDefinition.taskRoleArn, refresh.taskDefinition.executionRoleArn]);
  assert.equal(plan.enableRuleRequest.Name, plan.putRuleRequest.Name);
});

test('refresh refuses non-preview, unpinned, oversized or mismatched registered task metadata', () => {
  const changeTask = (changes: Record<string, unknown>) => ({ ...refresh, taskDefinition: { ...refresh.taskDefinition, ...changes } });
  const changeContainer = (changes: Record<string, unknown>) => changeTask({ containerDefinitions: [{ ...refresh.taskDefinition.containerDefinitions[0], ...changes }] });
  const environment = refresh.taskDefinition.containerDefinitions[0]!.environment;
  for (const bad of [
    { ...refresh, clusterArn: refresh.clusterArn.replace('capiro-dev', 'other') },
    { ...refresh, invocationRoleArn: '*' },
    { ...refresh, imageDigest: 'latest' },
    { ...refresh, sourceHead: 'short' },
    changeTask({ family: 'capiro-dev-api' }),
    changeTask({ cpu: '1024' }), changeTask({ memory: '2048' }),
    changeTask({ runtimePlatform: { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' } }),
    changeContainer({ image: 'public.ecr.aws/node:latest' }), changeContainer({ entryPoint: ['sh'] }),
    changeContainer({ environment: environment.map((entry) => entry.name === 'DB_HOST' ? { ...entry, value: 'live.example.test' } : entry) }),
    changeContainer({ environment: environment.map((entry) => entry.name === 'LEGIWATCH_AGENT_MODEL' ? { ...entry, value: 'other' } : entry) }),
    changeContainer({ secrets: [...refresh.taskDefinition.containerDefinitions[0]!.secrets,
      { name: 'DB_HOST', valueFrom: secretArns.GOVINFO_API_KEY }] }),
  ]) assert.throws(() => firstChatCoreLegiwatchConfiguration({ ...binding, refresh: bad }));
});

test('configuration rejects ambiguous credentials, missing bindings and unsupported provider settings', () => {
  for (const bad of [null, { ...binding, enabled: true }, { ...binding, provider: 'other' },
    { ...binding, model: ' ' }, { ...binding, provider: 'anthropic' },
    { ...binding, kmsKeyArns: ['*'] }, { ...binding, secretArns: { ...secretArns, CENSUS_API_KEY: 'plaintext' } },
    { ...binding, secretArns: { ...secretArns, CENSUS_API_KEY: secretArns.CENSUS_API_KEY!.replace('967807252336', '123456789012') } },
    { ...binding, secretArns: { ...secretArns, CENSUS_API_KEY: `${secretArns.CENSUS_API_KEY}:key::` } }])
    assert.throws(() => firstChatCoreLegiwatchConfiguration(bad));
  assert.throws(() => legiwatchAgentEnvironment({ legiwatchAgentProvider: 'anthropic' }));
  assert.deepEqual(legiwatchAgentEnvironment({}), { LEGIWATCH_AGENT_PROVIDER: 'bedrock' });
  assert.throws(() => completeExternalSecretArn('partial', { account: '967807252336', region: 'us-east-1' }, 'source'));
});

test('CDK context binds explicit source ARNs and never derives missing source names', () => {
  const config = loadConfig(new cdk.App({ context: {
    account: '967807252336', region: 'us-east-1',
    congressApiKeyArn: secretArns.CONGRESS_API_KEY, regulationsGovApiKeyArn: secretArns.REGULATIONS_GOV_API_KEY,
    legiwatchAgentProvider: 'anthropic', legiwatchAgentModel: 'synthetic-reviewed-model',
  } }));
  assert.equal(config.externalSecretArns?.congressApiKey, secretArns.CONGRESS_API_KEY);
  assert.equal(config.externalSecretArns?.regulationsGovApiKey, secretArns.REGULATIONS_GOV_API_KEY);
  assert.throws(() => loadConfig(new cdk.App({ context: { account: '967807252336', congressApiKeyArn: 'guessed-name' } })));
});

test('CLI renders a fresh overlay offline and refuses overwrites or invalid bindings', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legiwatch-overlay-'));
  try {
    const input = path.join(directory, 'binding.json');
    const output = path.join(directory, 'overlay.json');
    fs.writeFileSync(input, JSON.stringify(binding));
    assert.equal(main(['--render-legiwatch', input, output]), 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), firstChatCoreLegiwatchConfiguration(binding));
    assert.equal(main(['--render-legiwatch', input, output]), 2);
    fs.writeFileSync(input, JSON.stringify({ ...binding, provider: 'anthropic' }));
    assert.equal(main(['--render-legiwatch', input, path.join(directory, 'invalid.json')]), 2);
    assert.equal(fs.existsSync(path.join(directory, 'invalid.json')), false);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});
