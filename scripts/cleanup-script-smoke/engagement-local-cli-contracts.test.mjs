import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { deriveContract, MISSING_DATABASE_URL_SMOKE_CONTEXT } from './contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const subjects = [
  'run-engagement-phase0-local.mjs',
  'run-engagement-phase1-local.mjs',
  'run-engagement-phase1-post-acceptance.mjs',
  'verify-engagement-phase1-background-final.mjs',
  'verify-engagement-phase1-local.mjs',
];
const probe = `
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
let writes = 0, network = 0, children = 0;
const deny = (kind) => {
  if (kind === 'write') writes++;
  else if (kind === 'network') network++;
  else children++;
  process.exit(kind === 'child' ? 73 : kind === 'write' ? 74 : 75);
};
const openSync = fs.openSync;
fs.openSync = (file, flags, ...rest) =>
  /[wax+]/.test(String(flags)) ? deny('write') : openSync(file, flags, ...rest);
for (const key of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'renameSync', 'cpSync']) {
  fs[key] = () => deny('write');
}
for (const key of ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rm', 'rename', 'cp']) {
  fs.promises[key] = () => deny('write');
}
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
  childProcess[key] = () => deny('child');
}
syncBuiltinESMExports();
net.Socket.prototype.connect = () => deny('network');
http.request = () => deny('network');
https.request = () => deny('network');
globalThis.fetch = () => deny('network');
process.on('exit', () => process.stderr.write('RESOURCE_PROBE:' + writes + ':' + network + ':' + children + '\\n'));
`;
const probeUrl = `data:text/javascript,${encodeURIComponent(probe)}`;

function invoke(file, args, expectedExit, expectedProbe, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_OPTIONS;
  delete env.DATABASE_URL;
  const result = spawnSync(
    process.execPath,
    ['--import', probeUrl, path.join(root, 'scripts', file), ...args],
    { cwd: root, env, encoding: 'utf8', timeout: 15_000, windowsHide: true },
  );
  assert.equal(result.error, undefined, `${file} ${args.join(' ')}: ${result.error}`);
  assert.equal(result.signal, null, `${file} ${args.join(' ')}: signal`);
  assert.equal(result.status, expectedExit, `${file} ${args.join(' ')}: ${result.stderr}`);
  assert.ok(result.stderr.endsWith(`${expectedProbe}\n`), `${file}: ${result.stderr}`);
  return {
    stdout: result.stdout,
    stderr: result.stderr.slice(0, -`${expectedProbe}\n`.length),
  };
}

test('Clerk token mint requires explicit mode before network or file access', () => {
  const file = 'mint-engagement-phase1-jwt.mjs';
  const rel = `scripts/${file}`;
  const contract = deriveContract(readFileSync(path.join(root, rel), 'utf8'), rel,
    MISSING_DATABASE_URL_SMOKE_CONTEXT);
  assert.equal(contract.noArgs.documented, true);
  assert.equal(contract.noArgs.exit, 2);
  assert.equal(contract.help.exit, 0);
  const env = {
    CLERK_SECRET_KEY: 'sk_cleanup_resource_probe',
    ENGAGEMENT_PHASE1_USER_CLERK_ID: 'user_cleanup_resource_probe',
    ENGAGEMENT_PHASE1_TOKEN_FILE: path.join(os.tmpdir(), 'capiro-cleanup-token-resource-probe'),
  };
  for (const [args, expected] of [[[], 2], [['--help'], 0], [['--unknown'], 2]]) {
    const result = invoke(file, args, expected, 'RESOURCE_PROBE:0:0:0', env);
    assert.match(result.stdout + result.stderr, /Usage:/);
  }
  invoke(file, ['--mint'], 75, 'RESOURCE_PROBE:0:1:0', env);
  for (const caller of ['run-engagement-phase1-local.mjs', 'run-engagement-phase1-post-acceptance.mjs']) {
    assert.match(readFileSync(path.join(root, 'scripts', caller), 'utf8'),
      /mint-engagement-phase1-jwt\.mjs'\)?(?:, '--mint'|\], '--mint')/u);
  }
});

for (const file of subjects) {
  test(`${file} requires an explicit run before any resource access`, () => {
    const rel = `scripts/${file}`;
    const source = readFileSync(path.join(root, rel), 'utf8');
    const contract = deriveContract(source, rel, MISSING_DATABASE_URL_SMOKE_CONTEXT);
    assert.equal(contract.noArgs.documented, true, contract.evidence);
    assert.equal(contract.noArgs.exit, 2, contract.evidence);
    assert.equal(contract.help.exit, 0, contract.evidence);

    const noargs = invoke(file, [], 2, 'RESOURCE_PROBE:0:0:0');
    assert.equal(noargs.stdout, '');
    assert.match(noargs.stderr, /^Usage: node scripts\//u);
    for (const args of [['--help'], ['--run', '--help']]) {
      const help = invoke(file, args, 0, 'RESOURCE_PROBE:0:0:0');
      assert.equal(help.stdout, noargs.stderr);
      assert.equal(help.stderr, '');
    }
    for (const args of [
      ['--unknown'],
      ['--run', '--unknown'],
      ['--run', '--sha'],
      ['--run', '--sha='],
      ['--sha', '0'.repeat(40)],
    ]) {
      const refusal = invoke(file, args, 2, 'RESOURCE_PROBE:0:0:0');
      assert.equal(refusal.stdout, '');
      assert.equal(refusal.stderr, noargs.stderr);
    }
    invoke(file, ['--run'], 73, 'RESOURCE_PROBE:0:0:1');
  });
}

test('package and nested callers retain explicit modes and forwarded proof arguments', () => {
  const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  assert.equal(
    scripts['verify:engagement-phase-0:browser'],
    'node scripts/run-engagement-phase0-local.mjs --run',
  );
  assert.equal(
    scripts['verify:engagement-phase-1:local'],
    'node scripts/verify-engagement-phase1-local.mjs --run',
  );
  const wrapper = readFileSync(path.join(root, 'scripts/verify-engagement-phase1-local.mjs'), 'utf8');
  for (const child of [
    'run-engagement-phase1-local.mjs',
    'run-engagement-phase1-post-acceptance.mjs',
    'verify-engagement-phase1-background-final.mjs',
  ]) {
    assert.match(wrapper, new RegExp(`${child.replace(/\./gu, '\\.')}'\\),\\s*'--run',\\s*\\.\\.\\.args`, 'u'));
  }
  const post = readFileSync(path.join(root, 'scripts/run-engagement-phase1-post-acceptance.mjs'), 'utf8');
  assert.match(post, /engagement-phase1-post-acceptance\.mjs'\), \.\.\.rawArgs\]/u);
  assert.match(
    readFileSync(path.join(root, 'docs/runbooks/engagement-phase0-local-acceptance.md'), 'utf8'),
    /node scripts\/run-engagement-phase0-local\.mjs --run --sha/u,
  );
});
