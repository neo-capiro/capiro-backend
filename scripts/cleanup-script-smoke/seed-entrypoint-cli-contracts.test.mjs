import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { deriveContract, MISSING_DATABASE_URL_SMOKE_CONTEXT } from './contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const subjects = [
  ['apps/api-strategy/src/seed.ts', 'apps/api-strategy'],
  ['apps/api/scripts/bootstrap-roles.ts', 'apps/api'],
  ['apps/api/scripts/prepopulate-all.ts', 'apps/api'],
  ['apps/api/scripts/seed-engagement-phase0-browser-fixtures.ts', 'apps/api'],
  ['apps/api/scripts/seed-meriv2-phase19-browser-fixtures.ts', 'apps/api'],
  ['apps/api/scripts/seed-program-element-fixtures.ts', 'apps/api'],
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

function invoke(relative, cwd, args, expectedExit) {
  const env = {
    ...process.env,
    TSX_DISABLE_CACHE: '1',
    DATABASE_URL: 'postgresql://cli_probe:cli_probe@127.0.0.1:1/capiro_cli_probe',
    DB_HOST: '127.0.0.1',
    DB_PORT: '1',
    DB_NAME: 'capiro_cli_probe',
    MASTER_USER: 'cli_probe',
    MASTER_PASSWORD: 'cli_probe',
    APP_USER: 'cli_probe',
    APP_PASSWORD: 'cli_probe',
    ENGAGEMENT_PHASE0_CLERK_ORG_ID: 'org_cli_probe',
    ENGAGEMENT_PHASE0_USER_CLERK_ID: 'user_cli_probe',
    ENGAGEMENT_PHASE0_USER_EMAIL: 'cli-probe@example.invalid',
    ENGAGEMENT_PHASE0_FIXTURE_FILE: path.join(root, '.artifacts', 'cli-probe.json'),
    PHASE19_CLERK_ORG_ID: 'org_cli_probe',
  };
  delete env.NODE_OPTIONS;
  const file = path.join(root, relative);
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--import', probeUrl, file, ...args],
    { cwd: path.join(root, cwd), env, encoding: 'utf8', timeout: 15_000, windowsHide: true },
  );
  assert.equal(result.error, undefined, `${relative} ${args.join(' ')}: ${result.error}`);
  assert.equal(result.signal, null, `${relative} ${args.join(' ')}: signal`);
  assert.equal(result.status, expectedExit, `${relative} ${args.join(' ')}: ${result.stderr}`);
  assert.ok(result.stderr.endsWith('RESOURCE_PROBE:0:0:0\n'), `${relative}: ${result.stderr}`);
  return {
    stdout: result.stdout,
    stderr: result.stderr.slice(0, -'RESOURCE_PROBE:0:0:0\n'.length),
  };
}

for (const [relative, cwd] of subjects) {
  test(`${relative} refuses accidental seeding before any resource access`, () => {
    const contract = deriveContract(
      readFileSync(path.join(root, relative), 'utf8'),
      relative,
      MISSING_DATABASE_URL_SMOKE_CONTEXT,
    );
    assert.equal(contract.noArgs.documented, true, contract.evidence);
    assert.equal(contract.noArgs.exit, 2, contract.evidence);
    assert.equal(contract.help.exit, 0, contract.evidence);
    const noargs = invoke(relative, cwd, [], 2);
    assert.equal(noargs.stdout, '');
    assert.match(noargs.stderr, /^Usage: /u);
    for (const args of [['--help'], ['--run', '--help']]) {
      const help = invoke(relative, cwd, args, 0);
      assert.equal(help.stdout, noargs.stderr);
      assert.equal(help.stderr, '');
    }
    for (const args of [['--unknown'], ['--run', '--unknown']]) {
      const refusal = invoke(relative, cwd, args, 2);
      assert.equal(refusal.stdout, '');
      assert.equal(refusal.stderr, noargs.stderr);
    }
  });
}

test('all package, entrypoint, workflow, and nested seed callers select --run', () => {
  const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
  const strategyPackage = JSON.parse(read('apps/api-strategy/package.json'));
  assert.equal(strategyPackage.scripts.seed, 'tsx src/seed.ts --run');
  assert.equal((read('apps/api-strategy/scripts/entrypoint.sh').match(/exec node dist\/seed\.js --run/gu) ?? []).length, 2);
  const apiPackage = JSON.parse(read('apps/api/package.json'));
  assert.equal(apiPackage.scripts['seed:program-element'], 'tsx scripts/seed-program-element-fixtures.ts --run');
  const dispatcher = read('apps/api/scripts/entrypoint-dispatcher.inc');
  assert.match(dispatcher, /scripts\/bootstrap-roles\.ts --run "\$@"/u);
  assert.match(dispatcher, /scripts\/prepopulate-all\.ts --run "\$@"/u);
  for (const file of [
    'scripts/run-engagement-phase0-local.mjs',
    'scripts/run-engagement-phase1-local.mjs',
    'scripts/run-engagement-phase1-post-acceptance.mjs',
  ]) {
    assert.match(read(file), /'scripts\/seed-engagement-phase0-browser-fixtures\.ts',\s*'--run'/u, file);
  }
  assert.match(
    read('.github/workflows/meriv2-phase19-browser-acceptance.yml'),
    /tsx scripts\/seed-meriv2-phase19-browser-fixtures\.ts --run/u,
  );
});
