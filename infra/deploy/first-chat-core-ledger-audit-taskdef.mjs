// Render a fixed-purpose ECS task definition for source review only. This
// script does not register or run a task, contact AWS, or read a secret value.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const auditSourcePath = resolve(repoRoot, 'infra/deploy/first-chat-core-ledger-audit.cjs');
const caPath = resolve(repoRoot,
  'docs/meri/releases/2026-10-02/composed-eval-prerequisites/readback/rds-us-east-1-bundle.pem');
export const outputPath = resolve(repoRoot, '../first-chat-core-ledger-audit-taskdef.json');

const CA_SHA256 = '52ef9c903529fa3999e576fea1bd6ea3251c4b1cd229d2fa41c65b0ff7464c11';
const AUDIT_SOURCE_SHA256 = 'fde0281c023c0442eab667d59dc50746e46041cec24cddc3e8945542b52119de';
const SOURCE_SHA = '13d12a7d7bdbe0be021cb218dd4cf7690cc4420b';
const DB_HOST = 'capiro-dev-data-auroracluster23d869c0-ltmz40k47ewv.cluster-csryw28ai752.us-east-1.rds.amazonaws.com';
const REGION = 'us-east-1';
const ACCOUNT = '967807252336';
const APP_SECRET = `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:/capiro/dev/aurora/app-zNPtsU`;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function buildTaskDefinition() {
  const source = readFileSync(auditSourcePath, 'utf8');
  const ca = readFileSync(caPath, 'utf8');
  assert.equal(sha256(Buffer.from(source, 'utf8')), AUDIT_SOURCE_SHA256,
    'reviewed fixed audit source changed');
  assert.equal(sha256(Buffer.from(ca, 'utf8')), CA_SHA256,
    'reviewed RDS CA bundle changed');
  assert.ok(source.includes(`const SOURCE_SHA = '${SOURCE_SHA}';`),
    'fixed audit source no longer targets the pinned Core image');
  assert.ok(source.includes('argv.length !== 1'),
    'fixed audit source must reject ECS command overrides');

  return {
    family: 'capiro-preview-first-chat-core-ledger-audit',
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    cpu: '512',
    memory: '1024',
    runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
    executionRoleArn: `arn:aws:iam::${ACCOUNT}:role/Capiro-dev-Compute-ApiTaskDefExecutionRoleE6ABB053-YlEDKuUPHjLg`,
    containerDefinitions: [{
      name: 'first-chat-core-ledger-audit',
      image: `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/capiro/dev/api@sha256:d2f5a2a76c6c1dfc0bd5843df84cb1f36bb9c2bea7fafcb5819006c22ab6c5ae`,
      essential: true,
      entryPoint: ['node', '-e', source],
      command: [],
      readonlyRootFilesystem: true,
      environment: [
        { name: 'DB_HOST', value: DB_HOST },
        { name: 'DB_PORT', value: '5432' },
        { name: 'DB_NAME', value: 'capiro' },
        { name: 'NODE_OPTIONS', value: '' },
        { name: 'RDS_CA_PEM', value: ca },
      ],
      secrets: [
        { name: 'DB_USER', valueFrom: `${APP_SECRET}:username::` },
        { name: 'DB_PASSWORD', valueFrom: `${APP_SECRET}:password::` },
      ],
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': '/capiro/dev/api',
          'awslogs-region': REGION,
          'awslogs-stream-prefix': 'first-chat-ledger',
        },
      },
    }],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 2, 'renderer accepts no command or output overrides');
  const serialized = `${JSON.stringify(buildTaskDefinition(), null, 2)}\n`;
  try {
    assert.equal(readFileSync(outputPath, 'utf8'), serialized,
      'existing task definition differs; review before replacing it');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    writeFileSync(outputPath, serialized, { flag: 'wx' });
  }
  process.stdout.write(`${outputPath}\n`);
}
