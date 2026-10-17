'use strict';

// Source-only renderer. It emits a reviewable ECS task definition; it never
// contacts AWS, obtains credentials, starts a task, or executes a migration.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const IMAGE = '967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/preview-core@sha256:722a483259ebb5e9162b9294c26895bafa890fcfee45dc927ff1d2ec35fa071b';
const ROLE = 'arn:aws:iam::967807252336:role/capiro-preview-first-chat-core-receipt-execution';
const MASTER = 'arn:aws:secretsmanager:us-east-1:967807252336:secret:/capiro/dev/aurora/master-P4z1Vo';
const FAMILY = 'capiro-preview-first-chat-core-receipt-only';
const CA_SHA256 = '52ef9c903529fa3999e576fea1bd6ea3251c4b1cd229d2fa41c65b0ff7464c11';

function hash(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

function committedSource(name) {
  const repo = path.resolve(__dirname, '../../../..');
  const relative = `apps/api/scripts/receipt-only/${name}`;
  // Git blob bytes stay LF on Windows even when a worktree applies autocrlf.
  // Rendering an uncommitted or unstaged local edit is intentionally refused.
  const blob = execFileSync('git', [
    '-c', `safe.directory=${repo.replaceAll('\\', '/')}`,
    '-C', repo, 'show', `HEAD:${relative}`,
  ], { maxBuffer: 1024 * 1024 });
  const disk = fs.readFileSync(path.join(__dirname, name));
  assert.equal(disk.toString('utf8').replaceAll('\r\n', '\n'), blob.toString('utf8'), 'uncommitted runner source differs');
  return blob.toString('utf8');
}

function embedSource() {
  const verifier = committedSource('verify-bundle.cjs');
  const runner = committedSource('run.cjs');
  return `'use strict';\n` +
    `const verifierModule={exports:{}};\n` +
    `(function(module,exports,require){\n${verifier}\n})(verifierModule,verifierModule.exports,require);\n` +
    `const runnerModule={exports:{}};\n` +
    `const localRequire=(id)=>id==='./verify-bundle.cjs'?verifierModule.exports:require(id);\n` +
    `(function(module,exports,require){\n${runner}\n})(runnerModule,runnerModule.exports,localRequire);\n` +
    `runnerModule.exports.main().catch(()=>{process.stderr.write('HOLD: receipt-only migration failed or outcome uncertain; do not retry\\n');process.exitCode=1});\n`;
}

function render(readerTaskDefinition) {
  const env = readerTaskDefinition.containerDefinitions?.[0]?.environment || [];
  const ca = env.find(x => x.name === 'RDS_CA_PEM')?.value;
  assert.equal(hash(Buffer.from(ca || '', 'utf8')), CA_SHA256, 'reader CA bundle differs');
  const entry = embedSource();
  assert(Buffer.byteLength(entry, 'utf8') < 32768, 'fixed entrypoint exceeds reviewed bound');
  const taskDefinition = {
    family: FAMILY,
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    cpu: '512', memory: '1024',
    runtimePlatform: { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' },
    executionRoleArn: ROLE,
    containerDefinitions: [{
      name: 'first-chat-core-receipt-only', image: IMAGE, essential: true,
      entryPoint: ['node', '-e', entry], command: [],
      readonlyRootFilesystem: true,
      environment: [
        { name: 'RDS_CA_PEM', value: ca },
        { name: 'NODE_OPTIONS', value: '' },
      ],
      secrets: [
        { name: 'DB_USER', valueFrom: `${MASTER}:username::` },
        { name: 'DB_PASSWORD', valueFrom: `${MASTER}:password::` },
      ],
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': '/capiro/preview-first-chat/core-receipt-migrate',
          'awslogs-region': 'us-east-1',
          'awslogs-stream-prefix': 'receipt-only',
        },
      },
    }],
  };
  return { taskDefinition, entrySha256: hash(Buffer.from(entry)), entryBytes: Buffer.byteLength(entry) };
}

if (require.main === module) {
  try {
    assert.equal(process.argv.length, 4, 'usage: render-taskdef.cjs <saved-reader-taskdef.json> <output.json>');
    const reader = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const { taskDefinition, entrySha256, entryBytes } = render(reader);
    const encoded = JSON.stringify(taskDefinition, null, 2) + '\n';
    fs.writeFileSync(process.argv[3], encoded, { flag: 'wx' });
    process.stdout.write(`TASKDEF_SOURCE_ONLY sha256=${hash(Buffer.from(encoded))} entry_sha256=${entrySha256} entry_bytes=${entryBytes}\n`);
  } catch (error) {
    process.stderr.write(`BLOCK: task definition render failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { IMAGE, ROLE, MASTER, FAMILY, embedSource, render };
