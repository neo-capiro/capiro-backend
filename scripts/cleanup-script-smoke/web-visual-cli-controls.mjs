#!/usr/bin/env node
/** Exercise sealed historical CLI bodies with inert dependency/resource ports. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readVisualCliInput, readRelocatedPhase1CliInput } from '../../tests/support/legacy-web/visual-cli-inputs/inputs.mjs';

const TEMP = path.resolve(os.tmpdir());
// Validate every required immutable operand before creating temporary fixtures.
const cliInputs = new Map([
  ['engagement-phase1-browser-parity.mjs', readRelocatedPhase1CliInput()],
  ['lighthouse-pe-watch.mjs', readVisualCliInput('lighthouse-pe-watch.mjs.txt')],
  ['vnext-visual-capture.mjs', readVisualCliInput('vnext-visual-capture.mjs.txt')],
]);
const webPackage = JSON.parse(readVisualCliInput('package.json').toString('utf8'));
const inputDirectory = mkdtempSync(path.join(TEMP, 'capiro-web-visual-inputs-'));
for (const [name, bytes] of cliInputs) writeFileSync(path.join(inputDirectory, name), bytes);
const scratch = mkdtempSync(path.join(TEMP, 'capiro-web-visual-cli-'));
const baseEnv = Object.fromEntries(
  ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
);
// Browser packages are deliberately not installed or resolved. Their inert
// ports allow the unchanged explicit-mode code to reach its first resource
// request, where the original write/network/process trap still refuses it.
const portSource = "const refuse=()=>{process.stderr.write('RESOURCE_ATTEMPT:browser-package\\n');throw Error('RESOURCE_ATTEMPT:browser-package');};export const launch=refuse;export default refuse;";
const portUrl = `data:text/javascript,${encodeURIComponent(portSource)}`;
const loaderSource = `export async function resolve(specifier,context,nextResolve){if(['chrome-launcher','lighthouse'].includes(specifier))return {url:${JSON.stringify(portUrl)},shortCircuit:true};return nextResolve(specifier,context);}`;
const loaderUrl = `data:text/javascript,${encodeURIComponent(loaderSource)}`;
const trapSource = [
  "import cp from 'node:child_process';",
  "import fs from 'node:fs';",
  "import fsp from 'node:fs/promises';",
  "import net from 'node:net';",
  "import http from 'node:http';",
  "import https from 'node:https';",
  "import Module, { register, syncBuiltinESMExports } from 'node:module';",
  "const deny = (name) => () => { process.stderr.write('RESOURCE_ATTEMPT:' + name + '\\n'); throw new Error('RESOURCE_ATTEMPT:' + name); };",
  `register(${JSON.stringify(loaderUrl)});`,
  "const originalLoad=Module._load;Module._load=function(name,...args){if(name==='chrome-launcher')return {launch:deny('chrome-launcher.launch')};if(name==='lighthouse')return deny('lighthouse');return originalLoad.call(this,name,...args);};",
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
    '--max-old-space-size=64', '--import', trapUrl, path.join(inputDirectory, file), ...args,
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
    '--max-old-space-size=64', '--import', trapUrl, '--input-type=module', '-e',
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

  console.log('Historical Web visual CLI runtime controls COMPLETE: 25 inert scenarios; browser/performance acceptance not performed');
  const packageFailures = [];
  // Both original assertions execute once. The exact historical package lacks
  // these flags; record both failures without rewriting its archived bytes.
  for (const [identity, assertion] of [
    ['package Lighthouse command must opt into Chrome', () => {
      assert.equal(webPackage.scripts['lighthouse:pe-watch'],
        'node scripts/lighthouse-pe-watch.mjs --run', 'package Lighthouse command must opt into Chrome');
    }],
    ['package capture command must opt into writes', () => {
      assert.equal(webPackage.scripts['visual:vnext:capture'],
        'node scripts/vnext-visual-capture.mjs --capture', 'package capture command must opt into writes');
    }],
  ]) {
    try { assertion(); } catch (error) { packageFailures.push({ identity, error }); }
  }
  if (packageFailures.length) {
    console.error('HISTORICAL_WEB_VISUAL_PACKAGE_ASSERTIONS_FAILED ' + JSON.stringify(packageFailures.map(({ identity, error }) => ({
      identity, actual: error.actual, expected: error.expected, sourceCommit: '4e0c189c5d0522098be1c4916a033bb681d11c0b',
    }))));
    throw new AggregateError(packageFailures.map(({ error }) => error), 'Historical Web package opt-in assertions remain failing; current backend acceptance is separate');
  }
  console.log('Web visual CLI controls PASS: missing-config/noargs, help, unknown, write opt-in');
} finally {
  const resolved = path.resolve(scratch);
  assert.equal(path.dirname(resolved), TEMP, 'scratch cleanup escaped temporary root');
  rmSync(resolved, { recursive: true, force: true });
  const resolvedInputs = path.resolve(inputDirectory);
  assert.equal(path.dirname(resolvedInputs), TEMP, 'input cleanup escaped temporary root');
  rmSync(resolvedInputs, { recursive: true, force: true });
}
