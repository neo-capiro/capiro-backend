#!/usr/bin/env node
/** Exercise directory/press CLI boundaries against their actual TS sources. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveContract, MISSING_DATABASE_URL_SMOKE_CONTEXT } from './contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const apiRoot = path.join(root, 'apps', 'api');
const tempRoot = path.resolve(os.tmpdir());
const scratch = mkdtempSync(path.join(tempRoot, 'capiro-directory-cli-'));
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
  ['import-dow-directory-v6.ts', '--import'],
  ['import-stanford-dow-directory.ts', '--import'],
  ['parse-dow-directory.ts', '--parse'],
  ['load-press-personnel-mentions.ts', '--dry-run'],
];

function invoke(file, args, configuredDatabase = false) {
  const env = { ...process.env, TSX_DISABLE_CACHE: '1' };
  delete env.NODE_OPTIONS;
  if (configuredDatabase) env.DATABASE_URL = 'postgresql://127.0.0.1:1/unused';
  else delete env.DATABASE_URL;
  return spawnSync(process.execPath, [
    '--import', 'tsx', '--import', trapUrl, path.join(apiRoot, 'scripts', file), ...args,
  ], { cwd: apiRoot, env, encoding: 'utf8', timeout: 10000, windowsHide: true });
}

function check(file, args, expectedExit, configuredDatabase = false) {
  const result = invoke(file, args, configuredDatabase);
  const label = `${file} ${args.join(' ') || '(noargs)'}`;
  assert.equal(result.error, undefined, `${label}: spawn error`);
  assert.equal(result.signal, null, `${label}: signalled`);
  assert.equal(result.status, expectedExit, `${label}: exit ${result.status}: ${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, /Usage:/, `${label}: missing usage`);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\n\s+at |file:\/\/\//u,
    `${label}: uncaught trace`);
  assert.match(result.stderr, /RESOURCE_PROBE:0:0/u,
    `${label}: write or network attempted`);
  assert.deepEqual(readdirSync(scratch), [], `${label}: changed private scratch`);
}

try {
  const probe = spawnSync(process.execPath, [
    '--import', trapUrl, '--input-type=module', '-e',
    "import { writeFileSync } from 'node:fs'; try { writeFileSync('forbidden', 'x'); } catch {}",
  ], { cwd: scratch, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.match(probe.stderr, /RESOURCE_PROBE:1:0/,
    'resource probe did not detect a caught write attempt');
  assert.deepEqual(readdirSync(scratch), [], 'probe changed private scratch');

  for (const [file, mode] of subjects) {
    const rel = `apps/api/scripts/${file}`;
    const contract = deriveContract(readFileSync(path.join(root, rel), 'utf8'), rel,
      MISSING_DATABASE_URL_SMOKE_CONTEXT);
    assert.equal(contract.noArgs.exit, 2, `${file}: native noargs contract`);
    assert.equal(contract.noArgs.documented, true, `${file}: native documentation`);
    assert.equal(contract.help.exit, 0, `${file}: native help contract`);
    check(file, [], 2);
    check(file, ['--help'], 0, true);
    check(file, ['--unknown'], 2, true);
    check(file, [mode, '--unknown'], 2, true);
  }

  const scripts = JSON.parse(readFileSync(path.join(apiRoot, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts['import:stanford-dow'], 'tsx scripts/import-stanford-dow-directory.ts --import');
  assert.equal(scripts['parse:dow-directory'], 'tsx scripts/parse-dow-directory.ts --parse');
  const dispatcher = readFileSync(path.join(apiRoot, 'scripts/entrypoint-dispatcher.inc'), 'utf8');
  assert.match(dispatcher, /import-dow-directory\) exec .*import-stanford-dow-directory\.ts --import/u);
  assert.match(dispatcher, /import-dow-directory-v6\) exec .*import-dow-directory-v6\.ts --import/u);
  console.log('API directory CLI controls PASS: noargs/help/unknown refuse writes and network; callers opt in');
} finally {
  const resolved = path.resolve(scratch);
  assert.equal(path.dirname(resolved), tempRoot, 'scratch cleanup escaped temporary root');
  rmSync(resolved, { recursive: true, force: true });
}
