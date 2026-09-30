#!/usr/bin/env node
'use strict';

// Discovery only. No test execution, dependency installation or database calls.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');

if (process.argv.length === 3 && process.argv[2] === '--help') {
  console.log('Usage: node verify-api-shard-union.cjs --output-dir <owned-evidence-directory>');
  console.log('Uses installed Jest to verify a four-shard exact union; executes no tests.');
  process.exit(0);
}
if (process.argv.length !== 4 || process.argv[2] !== '--output-dir') {
  console.error('An explicit --output-dir is required. Use --help for usage.');
  process.exit(2);
}

const root = path.resolve(__dirname, '../../../../../');
const api = path.join(root, 'apps/api');
const output = path.resolve(process.argv[3]);
if (JSON.parse(fs.readFileSync(path.join(api, 'package.json'), 'utf8')).name !== '@capiro/api') {
  throw new Error('Expected the @capiro/api package in this checkout.');
}
fs.mkdirSync(output, { recursive: true });
const jest = path.resolve(
  path.dirname(require.resolve('jest', { paths: [api] })),
  '../bin/jest.js',
);
const sourceSha = cp
  .execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  })
  .trim();

function discover(shard) {
  const args = [
    jest,
    '--listTests',
    '--json',
    '--runInBand',
    '--cacheDirectory',
    path.join(output, `jest-discovery-cache-${shard || 'all'}`),
  ];
  if (shard) args.push(`--shard=${shard}/4`);
  const child = cp.spawnSync(process.execPath, args, {
    cwd: api,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=6144' },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (child.error || child.signal || child.status !== 0) {
    throw new Error(
      `Jest discovery ${shard || 'all'} failed: status=${child.status}, signal=${child.signal}, error=${child.error?.message || 'none'}`,
    );
  }
  return JSON.parse(child.stdout)
    .map((file) => {
      const relative = path.relative(api, file).split(path.sep).join('/');
      if (relative.startsWith('../') || path.isAbsolute(relative)) {
        throw new Error('Jest returned a test outside apps/api.');
      }
      return relative;
    })
    .sort();
}

const all = discover(0);
const shards = [1, 2, 3, 4].map(discover);
const combined = shards.flat();
const union = [...new Set(combined)].sort();
const result = {
  sourceSha,
  nodeVersion: process.version,
  executedTests: false,
  allCount: all.length,
  shardCounts: shards.map((shard) => shard.length),
  duplicateCount: combined.length - union.length,
  exactUnion: JSON.stringify(union) === JSON.stringify(all),
  listSha256: crypto.createHash('sha256').update(JSON.stringify(all)).digest('hex'),
  all,
  shards,
};
fs.writeFileSync(path.join(output, 'api-shard-union.json'), `${JSON.stringify(result, null, 2)}\n`);
const { all: omittedAll, shards: omittedShards, ...summary } = result;
console.log(JSON.stringify(summary, null, 2));
if (!all.length || result.duplicateCount || !result.exactUnion) process.exit(1);
