#!/usr/bin/env node
/** Exercise the actual web CLIs while trapping writes, subprocesses, and network. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMP = path.resolve(os.tmpdir());
const scratch = mkdtempSync(path.join(TEMP, 'capiro-web-visual-cli-'));
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

function invoke(file, args, env = baseEnv, timeout = 5000) {
  return spawnSync(process.execPath, [
    '--import', trapUrl, path.join(ROOT, 'apps', 'web', 'scripts', file), ...args,
  ], { cwd: scratch, env, encoding: 'utf8', timeout, windowsHide: true });
}

function check(file, args, expectedExit, env = baseEnv) {
  const result = invoke(file, args, env);
  const label = `${file} ${args.join(' ') || '(noargs)'}`;
  assert.equal(result.error, undefined, `${label}: child process error`);
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
    "import { mkdir } from 'node:fs/promises'; await mkdir('forbidden');",
  ], { cwd: scratch, env: baseEnv, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(probe.error, undefined, 'trap probe spawn error');
  assert.notEqual(probe.status, 0, 'resource trap must reject a deliberate directory creation');
  assert.match(probe.stderr, /RESOURCE_ATTEMPT:fs\.promises\.mkdir/);
  assert.deepEqual(readdirSync(scratch), [], 'trap probe changed calling directory');
}

function checkExplicitMode(file, mode, env, marker) {
  const result = invoke(file, [mode], env, 30000);
  assert.equal(result.error, undefined, `${file} ${mode}: child process error`);
  assert.match(result.stderr, marker, `${file} ${mode}: did not reach its configured resource path`);
  assert.deepEqual(readdirSync(scratch), [], `${file} ${mode}: trap allowed a write`);
}

try {
  checkTrap();
  const phase1 = 'engagement-phase1-browser-parity.mjs';
  const lighthouse = 'lighthouse-pe-watch.mjs';
  const capture = 'vnext-visual-capture.mjs';
  const phase1Config = {
    ...baseEnv,
    ENGAGEMENT_PHASE1_EVIDENCE_DIR: path.join(scratch, 'phase1-evidence'),
    ENGAGEMENT_PHASE1_TOKEN_FILE: path.join(scratch, 'token'),
  };
  const lighthouseConfig = { ...baseEnv, PE_WATCH_URL: 'http://127.0.0.1:4188/pe' };

  for (const file of [phase1, lighthouse, capture]) {
    check(file, [], 2);
    check(file, ['--help'], 0);
    check(file, ['-h'], 0);
    check(file, ['--unknown'], 2);
  }
  for (const name of ['ENGAGEMENT_PHASE1_EVIDENCE_DIR', 'ENGAGEMENT_PHASE1_TOKEN_FILE']) {
    const env = { ...phase1Config };
    delete env[name];
    check(phase1, ['--run'], 2, env);
  }
  check(lighthouse, ['--run'], 2, { ...baseEnv, PE_WATCH_URL: '   ' });
  for (const [file, env] of [[phase1, phase1Config], [lighthouse, lighthouseConfig]]) {
    check(file, [], 2, env);
    check(file, ['--help'], 0, env);
    check(file, ['--unknown'], 2, env);
  }
  check(capture, ['--capture', '--unknown'], 2);

  checkExplicitMode(phase1, '--run', phase1Config, /RESOURCE_ATTEMPT:fs\.promises\.mkdir/);
  checkExplicitMode(capture, '--capture', baseEnv, /RESOURCE_ATTEMPT:fs\.promises\.mkdir/);

  const webPackage = JSON.parse(readFileSync(path.join(ROOT, 'apps', 'web', 'package.json'), 'utf8'));
  assert.equal(webPackage.scripts['lighthouse:pe-watch'],
    'node scripts/lighthouse-pe-watch.mjs --run', 'package Lighthouse command must opt into Chrome');
  assert.equal(webPackage.scripts['visual:vnext:capture'],
    'node scripts/vnext-visual-capture.mjs --capture', 'package capture command must opt into writes');
  console.log('Web visual CLI controls PASS: missing-config/noargs, help, unknown, write opt-in');
} finally {
  const resolved = path.resolve(scratch);
  assert.equal(path.dirname(resolved), TEMP, 'scratch cleanup escaped temporary root');
  rmSync(resolved, { recursive: true, force: true });
}
