#!/usr/bin/env node
/** Actual-source E2E CLI controls with subprocess, write, and network traps. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMP = path.resolve(os.tmpdir());
const scratch = mkdtempSync(path.join(TEMP, 'capiro-e2e-cli-'));
const baseEnv = Object.fromEntries(
  ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
);
const trapSource = [
  "import cp from 'node:child_process';",
  "import fs from 'node:fs';",
  "import fsp from 'node:fs/promises';",
  "import net from 'node:net';",
  "import http from 'node:http';",
  "import https from 'node:https';",
  "import { syncBuiltinESMExports } from 'node:module';",
  "const deny = (name) => () => { process.stderr.write('RESOURCE_ATTEMPT:' + name + '\\n'); throw new Error('RESOURCE_ATTEMPT:' + name); };",
  "for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) cp[name] = deny('child_process.' + name);",
  "for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync']) fs[name] = deny('fs.' + name);",
  "for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename']) fsp[name] = deny('fs.promises.' + name);",
  "for (const name of ['connect', 'createConnection', 'createServer']) net[name] = deny('net.' + name);",
  "for (const mod of [http, https]) for (const name of ['request', 'get', 'createServer']) mod[name] = deny('http.' + name);",
  "globalThis.fetch = deny('fetch');",
  "globalThis.WebSocket = class { constructor() { deny('WebSocket')(); } };",
  'syncBuiltinESMExports();',
].join('\n');
const trapUrl = `data:text/javascript,${encodeURIComponent(trapSource)}`;
const subjects = [
  ['capture-baselines.mjs', '--capture'],
  ['discover-route-content.mjs', '--discover'],
  ['repeat-zero-diff.mjs', '--repeat'],
  ['typecheck.mjs', '--check'],
];

function invoke(file, args, env = baseEnv) {
  return spawnSync(process.execPath, [
    '--import', trapUrl, path.join(ROOT, 'apps', 'e2e', 'scripts', file), ...args,
  ], { cwd: scratch, env, encoding: 'utf8', timeout: 5000, windowsHide: true });
}

function check(file, args, expectedExit, env = baseEnv) {
  const result = invoke(file, args, env);
  const label = `${file} ${args.join(' ') || '(noargs)'}`;
  assert.equal(result.error, undefined, `${label}: spawn error`);
  assert.equal(result.signal, null, `${label}: signalled`);
  assert.equal(result.status, expectedExit, `${label}: exit ${result.status}: ${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, /Usage:/, `${label}: missing usage`);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /RESOURCE_ATTEMPT|\n\s+at /,
    `${label}: resource attempt or uncaught stack`);
  assert.deepEqual(readdirSync(scratch), [], `${label}: calling directory changed`);
}

function checkTrap() {
  const probe = spawnSync(process.execPath, [
    '--import', trapUrl, '--input-type=module', '-e',
    "import { mkdirSync } from 'node:fs'; mkdirSync('forbidden');",
  ], { cwd: scratch, env: baseEnv, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(probe.error, undefined, 'trap probe spawn error');
  assert.notEqual(probe.status, 0, 'trap must reject a deliberate directory creation');
  assert.match(probe.stderr, /RESOURCE_ATTEMPT:fs\.mkdirSync/);
  assert.deepEqual(readdirSync(scratch), [], 'trap probe changed calling directory');
}

try {
  checkTrap();
  for (const [file, mode] of subjects) {
    check(file, [], 2);
    check(file, ['--help'], 0);
    check(file, ['-h'], 0);
    check(file, ['--unknown'], 2);
    check(file, [mode, '--unknown'], 2);
  }
  check('capture-baselines.mjs', ['--prune-old', 'invalid'], 2);
  check('typecheck.mjs', [], 2, { ...baseEnv, PLAYWRIGHT_RUNTIME_DIR: 'C:/dev' });

  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'apps', 'e2e', 'package.json'), 'utf8'));
  for (const [command, expected] of [
    ['routes:discover', 'node scripts/discover-route-content.mjs --discover'],
    ['capture', 'node scripts/capture-baselines.mjs --capture'],
    ['visual:repeat', 'node scripts/repeat-zero-diff.mjs --repeat'],
    ['typecheck', 'node scripts/typecheck.mjs --check'],
  ]) assert.equal(pkg.scripts[command], expected, `${command}: package caller mode`);
  console.log('E2E operation CLI controls PASS: noargs/help/unknown refuse before resources');
} finally {
  const resolved = path.resolve(scratch);
  assert.equal(path.dirname(resolved), TEMP, 'scratch cleanup escaped temporary root');
  rmSync(resolved, { recursive: true, force: true });
}
