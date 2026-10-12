#!/usr/bin/env node
/** Exercise verifier CLI preflight against the actual TS entrypoints. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveContract, MISSING_DATABASE_URL_SMOKE_CONTEXT } from './contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const apiRoot = path.join(root, 'apps', 'api');
const trapSource = [
  "import fs from 'node:fs';",
  "import fsp from 'node:fs/promises';",
  "import net from 'node:net';",
  "import http from 'node:http';",
  "import https from 'node:https';",
  "import { syncBuiltinESMExports } from 'node:module';",
  'let writes = 0; let network = 0;',
  "const write = () => { writes++; throw new Error('forbidden file mutation'); };",
  "const connect = () => { network++; throw new Error('forbidden network'); };",
  "for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'renameSync', 'cpSync']) fs[name] = write;",
  "for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'rename', 'cp']) fsp[name] = write;",
  'net.Socket.prototype.connect = connect;',
  "for (const mod of [http, https]) for (const name of ['request', 'get']) mod[name] = connect;",
  'globalThis.fetch = connect;',
  "process.on('exit', () => process.stderr.write('RESOURCE_PROBE:' + writes + ':' + network + '\\n'));",
  'syncBuiltinESMExports();',
].join('\n');
const trapUrl = `data:text/javascript,${encodeURIComponent(trapSource)}`;
const subjects = [
  'verify-canonical-backfill-checkpoint-resume.ts',
  'verify-defense-budget-packages.ts',
  'verify-krisp-notetaker-db.ts',
];

function invoke(file, args, databaseUrl = undefined) {
  const env = { ...process.env, TSX_DISABLE_CACHE: '1' };
  delete env.NODE_OPTIONS;
  if (databaseUrl === undefined) delete env.DATABASE_URL;
  else env.DATABASE_URL = databaseUrl;
  return spawnSync(process.execPath, [
    '--import', 'tsx', '--import', trapUrl, path.join(apiRoot, 'scripts', file), ...args,
  ], { cwd: apiRoot, env, encoding: 'utf8', timeout: 15000, windowsHide: true });
}

function check(file, args, expectedExit, databaseUrl = undefined) {
  const result = invoke(file, args, databaseUrl);
  const label = `${file} ${args.join(' ') || '(noargs)'}`;
  assert.equal(result.error, undefined, `${label}: spawn error`);
  assert.equal(result.signal, null, `${label}: signalled`);
  assert.equal(result.status, expectedExit, `${label}: exit ${result.status}: ${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, /Usage:/, `${label}: missing usage`);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\n\s+at |file:\/\//u,
    `${label}: uncaught trace`);
  assert.match(result.stderr, /RESOURCE_PROBE:0:0/u,
    `${label}: write or network attempted`);
}

const probe = spawnSync(process.execPath, [
  '--import', trapUrl, '--input-type=module', '-e',
  "import { writeFileSync } from 'node:fs'; try { writeFileSync('forbidden', 'x'); } catch {}",
], { cwd: apiRoot, encoding: 'utf8', timeout: 5000, windowsHide: true });
assert.match(probe.stderr, /RESOURCE_PROBE:1:0/u,
  'resource probe did not detect a caught write attempt');

for (const file of subjects) {
  const rel = `apps/api/scripts/${file}`;
  const contract = deriveContract(readFileSync(path.join(root, rel), 'utf8'), rel,
    MISSING_DATABASE_URL_SMOKE_CONTEXT);
  assert.equal(contract.noArgs.exit, 2, `${file}: native noargs contract`);
  assert.equal(contract.noArgs.documented, true, `${file}: native documentation`);
  assert.equal(contract.help.exit, 0, `${file}: native help contract`);
  check(file, [], 2);
  check(file, ['--help'], 0, 'postgresql://127.0.0.1:1/unused');
  check(file, ['--unknown'], 2, 'postgresql://127.0.0.1:1/unused');
  check(file, ['--verify', '--unknown'], 2, 'postgresql://127.0.0.1:1/unused');
}

const krisp = invoke('verify-krisp-notetaker-db.ts', ['--verify']);
assert.equal(krisp.error, undefined, 'Krisp configured gate: spawn error');
assert.equal(krisp.signal, null, 'Krisp configured gate: signalled');
assert.equal(krisp.status, 0, `Krisp configured gate: exit ${krisp.status}: ${krisp.stderr}`);
assert.equal(krisp.stdout.trim(),
  'PASS: pilot flag scope, settings preservation, per-user/tenant RLS, duplicate prevention, and connection deletion.',
  'Krisp configured gate output changed');
assert.match(krisp.stderr, /RESOURCE_PROBE:0:0/u,
  'Krisp embedded gate attempted file mutation or network');

const scripts = JSON.parse(readFileSync(path.join(apiRoot, 'package.json'), 'utf8')).scripts;
assert.equal(scripts['verify:defense-budget-packages'],
  'tsx scripts/verify-defense-budget-packages.ts --verify');
const dispatcher = readFileSync(path.join(apiRoot, 'scripts/entrypoint-dispatcher.inc'), 'utf8');
assert.match(dispatcher,
  /verify-defense-budget-packages\) shift; exec .*verify-defense-budget-packages\.ts --verify "\$@"/u);
assert.match(readFileSync(path.join(root, 'docs/plans/krisp-notetaker-pilot.md'), 'utf8'),
  /verify-krisp-notetaker-db\.ts --verify/u);
assert.match(readFileSync(path.join(root, '.github/workflows/knowledge-phase5-ci.yml'), 'utf8'),
  /run: pnpm --filter @capiro\/api exec tsx scripts\/verify-canonical-backfill-checkpoint-resume\.ts --verify/u);
console.log('API verifier CLI controls PASS: noargs/help/unknown refuse writes and network; live callers opt in');
