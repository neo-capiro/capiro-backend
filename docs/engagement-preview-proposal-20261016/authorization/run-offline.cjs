// Executes only the built-in Node static source tests; no app modules are loaded.
'use strict';

const { spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const testPath = 'docs/engagement-preview-proposal-20261016/authorization/source-preservation.test.cjs';
const args = ['--test', '--test-concurrency=1', '--test-reporter=tap', testPath];
const startedAt = new Date().toISOString();
const run = spawnSync(process.execPath, args, {
  cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
});
const report = (run.stdout ?? '') + (run.stderr ? `\n${run.stderr}` : '');
const summary = (label) => {
  const match = report.match(new RegExp(`^# ${label} (\\d+)$`, 'm'));
  return match ? Number(match[1]) : null;
};
writeFileSync(path.join(__dirname, 'offline-node.tap'), report);
const receipt = {
  mode: 'offline static source preservation only',
  baseCommit: '016e79b585c14f20d13669e13c987c01e3dd29dd',
  startedAt,
  completedAt: new Date().toISOString(),
  nodeVersion: process.version,
  platform: process.platform,
  architecture: process.arch,
  command: ['node', ...args].join(' '),
  concurrency: 1,
  exitCode: run.status,
  signal: run.signal,
  error: run.error ? String(run.error.message) : null,
  tests: summary('tests'),
  passed: summary('pass'),
  failed: summary('fail'),
  cancelled: summary('cancelled'),
  skipped: summary('skipped'),
  sourcePinCount: JSON.parse(readFileSync(path.join(__dirname, 'source-pins.json'), 'utf8')).files.length,
  sourcePinSha256: createHash('sha256').update(readFileSync(path.join(__dirname, 'source-pins.json'))).digest('hex'),
  reportSha256: createHash('sha256').update(report).digest('hex'),
  applicationAuthorizationExecuted: false,
  databaseSqlExecuted: false,
  liveHttpOrBrowserExecuted: false,
};
writeFileSync(path.join(__dirname, 'offline-node-results.json'), JSON.stringify(receipt, null, 2) + '\n');
process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
process.exitCode = run.status === 0 && !run.error ? 0 : 1;
