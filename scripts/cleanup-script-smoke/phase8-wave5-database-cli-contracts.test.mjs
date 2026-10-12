import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { deriveContract, MISSING_DATABASE_URL_SMOKE_CONTEXT } from './contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const subjects = [
  'verify-phase8-session11-integration.mjs',
  'verify-phase8-session12-e2e.mjs',
  'wave5-database-qualification.mjs',
];
const probe = `
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import Module, { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import childProcess from 'node:child_process';
let writes = 0, network = 0, children = 0, modules = 0;
const deny = (kind) => {
  if (kind === 'write') writes++;
  else if (kind === 'network') network++;
  else if (kind === 'child') children++;
  else modules++;
  process.exit({ write: 74, network: 75, child: 73, module: 76 }[kind]);
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (path.isAbsolute(request) || request === 'pg') return deny('module');
  return originalLoad.call(this, request, parent, isMain);
};
const originalOpen = fs.openSync;
fs.openSync = (file, flags, ...rest) =>
  /[wax+]/.test(String(flags)) ? deny('write') : originalOpen(file, flags, ...rest);
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
process.on('exit', () => process.stderr.write('RESOURCE_PROBE:' + writes + ':' + network + ':' + children + ':' + modules + '\\n'));
`;
const probeUrl = `data:text/javascript,${encodeURIComponent(probe)}`;

function invoke(file, args, expectedExit, expectedProbe) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.DATABASE_URL;
  delete env.ADMIN_DATABASE_URL;
  delete env.SERVE_DATABASE_URL;
  delete env.JOB_DATABASE_URL;
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

for (const file of subjects) {
  test(`${file} refuses accidental database work before loading dependencies`, () => {
    const rel = `scripts/${file}`;
    const contract = deriveContract(
      readFileSync(path.join(root, rel), 'utf8'),
      rel,
      MISSING_DATABASE_URL_SMOKE_CONTEXT,
    );
    assert.equal(contract.noArgs.documented, true, contract.evidence);
    assert.equal(contract.noArgs.exit, 2, contract.evidence);
    assert.equal(contract.help.exit, 0, contract.evidence);
    const noargs = invoke(file, [], 2, 'RESOURCE_PROBE:0:0:0:0');
    assert.equal(noargs.stdout, '');
    assert.match(noargs.stderr, /^Usage: node scripts\//u);
    const help = invoke(file, ['--help'], 0, 'RESOURCE_PROBE:0:0:0:0');
    assert.equal(help.stdout, noargs.stderr);
    assert.equal(help.stderr, '');
    for (const args of [['--unknown'], ['--run', '--unknown'], ['--run', '--help']]) {
      const refusal = invoke(file, args, 2, 'RESOURCE_PROBE:0:0:0:0');
      assert.equal(refusal.stdout, '');
      assert.equal(refusal.stderr, noargs.stderr);
    }
    invoke(file, ['--run'], 76, 'RESOURCE_PROBE:0:0:0:1');
  });
}

test('disposable rehearsal and package callers explicitly select database proofs', () => {
  const packageScripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  assert.equal(
    packageScripts['verify:phase8-session12:e2e'],
    'node scripts/verify-phase8-session12-e2e.mjs --run',
  );
  for (const [shell, subject] of [
    ['verify-phase8-session11-db.sh', 'verify-phase8-session11-integration.mjs'],
    ['verify-phase8-session12-e2e-db.sh', 'verify-phase8-session12-e2e.mjs'],
  ]) {
    const source = readFileSync(path.join(root, 'scripts', shell), 'utf8');
    assert.ok(source.includes(`node "$REPO_ROOT/scripts/${subject}" --run`), shell);
  }
  const handoff = readFileSync(
    path.join(root, 'docs/defense-budget/phase8-session12-e2e-closeout-handoff.md'),
    'utf8',
  );
  assert.match(handoff, /node scripts\/verify-phase8-session12-e2e\.mjs --run/u);
});
