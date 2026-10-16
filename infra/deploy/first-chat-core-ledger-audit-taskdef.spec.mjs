import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildTaskDefinition } from './first-chat-core-ledger-audit-taskdef.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('fixed ledger task embeds reviewed code and CA without a task role or command surface', () => {
  const task = buildTaskDefinition();
  assert.deepEqual(Object.keys(task).sort(), [
    'containerDefinitions', 'cpu', 'executionRoleArn', 'family', 'memory',
    'networkMode', 'requiresCompatibilities', 'runtimePlatform',
  ]);
  assert.equal(task.family, 'capiro-preview-first-chat-core-ledger-audit');
  assert.equal(task.taskRoleArn, undefined);
  assert.equal(task.networkMode, 'awsvpc');
  assert.deepEqual(task.requiresCompatibilities, ['FARGATE']);
  assert.equal(task.cpu, '512');
  assert.equal(task.memory, '1024');
  assert.deepEqual(task.runtimePlatform, { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' });
  assert.equal(task.executionRoleArn,
    'arn:aws:iam::967807252336:role/Capiro-dev-Compute-ApiTaskDefExecutionRoleE6ABB053-YlEDKuUPHjLg');

  assert.equal(task.containerDefinitions.length, 1);
  const container = task.containerDefinitions[0];
  assert.deepEqual(Object.keys(container).sort(), [
    'command', 'entryPoint', 'environment', 'essential', 'image',
    'logConfiguration', 'name', 'readonlyRootFilesystem', 'secrets',
  ]);
  assert.equal(container.image,
    '967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api@sha256:d2f5a2a76c6c1dfc0bd5843df84cb1f36bb9c2bea7fafcb5819006c22ab6c5ae');
  assert.equal(container.essential, true);
  assert.equal(container.readonlyRootFilesystem, true);
  assert.deepEqual(container.entryPoint.slice(0, 2), ['node', '-e']);
  assert.equal(container.entryPoint[2], readFileSync(resolve(repoRoot,
    'infra/deploy/first-chat-core-ledger-audit.cjs'), 'utf8'));
  assert.deepEqual(container.command, []);
  assert.deepEqual(container.environment, [
    { name: 'DB_HOST', value: 'capiro-dev-data-auroracluster23d869c0-ltmz40k47ewv.cluster-csryw28ai752.us-east-1.rds.amazonaws.com' },
    { name: 'DB_PORT', value: '5432' },
    { name: 'DB_NAME', value: 'capiro' },
    { name: 'NODE_OPTIONS', value: '' },
    { name: 'RDS_CA_PEM', value: readFileSync(resolve(repoRoot,
      'docs/meri/releases/2026-10-02/composed-eval-prerequisites/readback/rds-us-east-1-bundle.pem'), 'utf8') },
  ]);
  assert.deepEqual(container.secrets, [
    { name: 'DB_USER', valueFrom: 'arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/aurora/app-zNPtsU:username::' },
    { name: 'DB_PASSWORD', valueFrom: 'arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/aurora/app-zNPtsU:password::' },
  ]);
  assert.deepEqual(container.logConfiguration, {
    logDriver: 'awslogs',
    options: {
      'awslogs-group': '/capiro/dev/api',
      'awslogs-region': 'us-east-1',
      'awslogs-stream-prefix': 'first-chat-ledger',
    },
  });
});
