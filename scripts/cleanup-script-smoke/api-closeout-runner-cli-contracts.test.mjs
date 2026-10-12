import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { deriveContract, MISSING_DATABASE_URL_SMOKE_CONTEXT } from './contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const apiRoot = path.join(root, 'apps/api');
const subjects = [
  'verify-engagement-phase1-runtime.ts',
  'verify-memory-phase3-review-inbox-closeout.ts',
];
const localDbEnv = {
  MEMORY_PHASE2_CLEAN_DATABASE_URL:
    'postgresql://local:local@127.0.0.1:1/capiro_memory_phase2_clean',
  MEMORY_PHASE2_UPGRADE_DATABASE_URL:
    'postgresql://local:local@127.0.0.1:1/capiro_memory_phase2_upgrade',
};
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
for (const key of ['writeFile', 'appendFile', 'mkdir', 'rm', 'rename', 'cp']) {
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

function invoke(file, args, extraEnv, expectedExit, expectedProbe) {
  const env = { ...process.env, TSX_DISABLE_CACHE: '1' };
  delete env.NODE_OPTIONS;
  delete env.DATABASE_URL;
  delete env.MEMORY_PHASE2_CLEAN_DATABASE_URL;
  delete env.MEMORY_PHASE2_UPGRADE_DATABASE_URL;
  Object.assign(env, extraEnv);
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--import', probeUrl, path.join(apiRoot, 'scripts', file), ...args],
    { cwd: apiRoot, env, encoding: 'utf8', timeout: 15000, windowsHide: true },
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

for (const file of subjects) {
  test(`${file} refuses accidental closeout before resource or database work`, () => {
    const rel = `apps/api/scripts/${file}`;
    const contract = deriveContract(
      readFileSync(path.join(root, rel), 'utf8'),
      rel,
      MISSING_DATABASE_URL_SMOKE_CONTEXT,
    );
    assert.equal(contract.noArgs.documented, true, contract.evidence);
    assert.equal(contract.noArgs.exit, 2, contract.evidence);
    assert.equal(contract.help.exit, 0, contract.evidence);
    const usage = `Usage: tsx scripts/${file} (--run | --help)\n`;
    const noargs = invoke(file, [], localDbEnv, 2, 'RESOURCE_PROBE:0:0:0');
    assert.equal(noargs.stdout, '');
    assert.equal(noargs.stderr, usage);
    const help = invoke(file, ['--help'], localDbEnv, 0, 'RESOURCE_PROBE:0:0:0');
    assert.equal(help.stdout, usage);
    assert.equal(help.stderr, '');
    for (const args of [['--unknown'], ['--run', '--unknown']]) {
      const unknown = invoke(file, args, localDbEnv, 2, 'RESOURCE_PROBE:0:0:0');
      assert.equal(unknown.stdout, '');
      assert.equal(unknown.stderr, usage);
    }
    invoke(file, ['--run'], localDbEnv, 73, 'RESOURCE_PROBE:0:0:1');
  });
}

test('Memory --run retains both disposable local database prerequisites', () => {
  const file = subjects[1];
  const missing = invoke(file, ['--run'], {}, 1, 'RESOURCE_PROBE:0:0:0');
  assert.match(missing.stderr, /MEMORY_PHASE2_CLEAN_DATABASE_URL is required\./u);
  const one = invoke(
    file,
    ['--run'],
    { MEMORY_PHASE2_CLEAN_DATABASE_URL: localDbEnv.MEMORY_PHASE2_CLEAN_DATABASE_URL },
    1,
    'RESOURCE_PROBE:0:0:0',
  );
  assert.match(one.stderr, /MEMORY_PHASE2_UPGRADE_DATABASE_URL is required\./u);
  const remote = invoke(
    file,
    ['--run'],
    { ...localDbEnv, MEMORY_PHASE2_CLEAN_DATABASE_URL: 'postgresql://host.invalid/not_disposable' },
    1,
    'RESOURCE_PROBE:0:0:0',
  );
  assert.match(remote.stderr, /must target a disposable local PostgreSQL database/u);
});

test('package, local wrapper, and operator commands still select the closeout', () => {
  const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  assert.match(
    scripts['verify:engagement-phase-1'],
    /scripts\/verify-engagement-phase1-runtime\.ts --run &&/u,
  );
  const wrapper = readFileSync(path.join(root, 'scripts/run-engagement-phase1-local.mjs'), 'utf8');
  assert.match(wrapper, /'scripts\/verify-engagement-phase1-runtime\.ts',\s*'--run'/u);
  for (const rel of [
    'docs/handoffs/memory-phase2-next-increment.md',
    'docs/handoffs/memory-admin-self-approval-release.md',
    'docs/qa/memory-admin-self-approval-policy.md',
  ]) {
    const command = readFileSync(path.join(root, rel), 'utf8');
    assert.match(command, /scripts\/verify-memory-phase3-review-inbox-closeout\.ts --run/u, rel);
  }
});
