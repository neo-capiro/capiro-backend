#!/usr/bin/env node
/** Actual-source Phase 8 corpus/replay CLI boundaries; no publisher fetches. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveContract, MISSING_DATABASE_URL_SMOKE_CONTEXT } from './contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tempRoot = path.resolve(os.tmpdir());
const scratch = mkdtempSync(path.join(tempRoot, 'capiro-phase8-corpus-cli-'));
const env = Object.fromEntries(
  ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
);
env.PHASE8_SESSION6_WORKDIR = path.join(scratch, 'session6');
env.PHASE8_SESSION7_WORKDIR = path.join(scratch, 'session7');
env.PHASE8_SESSION7_PREPARED_CORPUS = path.join(scratch, 'prepared-corpus.json');
const trapSource = [
  "import fs from 'node:fs';",
  "import fsp from 'node:fs/promises';",
  "import cp from 'node:child_process';",
  "import net from 'node:net';",
  "import http from 'node:http';",
  "import https from 'node:https';",
  "import { syncBuiltinESMExports } from 'node:module';",
  "const deny = (name) => () => { process.stderr.write('RESOURCE_ATTEMPT:' + name + '\\n'); throw new Error('RESOURCE_ATTEMPT:' + name); };",
  "for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync']) fs[name] = deny('fs.' + name);",
  "for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'rename']) fsp[name] = deny('fs.promises.' + name);",
  "for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) cp[name] = deny('child_process.' + name);",
  "for (const name of ['connect', 'createConnection']) net[name] = deny('net.' + name);",
  "for (const mod of [http, https]) for (const name of ['request', 'get']) mod[name] = deny('http.' + name);",
  "globalThis.fetch = deny('fetch');",
  'syncBuiltinESMExports();',
].join('\n');
const trapUrl = `data:text/javascript,${encodeURIComponent(trapSource)}`;
const subjects = [
  ['prepare-phase8-session6-federal-funding-corpus.mjs', '--prepare'],
  ['prepare-phase8-session7-lifecycle-corpus.mjs', '--prepare'],
  ['phase8-session7-lifecycle-replay.mjs', '--run'],
];

function invoke(file, args) {
  return spawnSync(process.execPath, [
    '--import', trapUrl, path.join(root, 'scripts', file), ...args,
  ], { cwd: scratch, env, encoding: 'utf8', timeout: 5000, windowsHide: true });
}

function check(file, args, expectedExit) {
  const result = invoke(file, args);
  const label = `${file} ${args.join(' ') || '(noargs)'}`;
  assert.equal(result.error, undefined, `${label}: spawn error`);
  assert.equal(result.signal, null, `${label}: signalled`);
  assert.equal(result.status, expectedExit, `${label}: exit ${result.status}: ${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, /Usage:/, `${label}: missing usage`);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /RESOURCE_ATTEMPT|\n\s+at /,
    `${label}: resource attempt or uncaught trace`);
  assert.deepEqual(readdirSync(scratch), [], `${label}: changed scratch`);
}

try {
  const probe = spawnSync(process.execPath, [
    '--import', trapUrl, '--input-type=module', '-e',
    "import { mkdir } from 'node:fs/promises'; await mkdir('forbidden');",
  ], { cwd: scratch, env, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.notEqual(probe.status, 0, 'trap must reject a deliberate write');
  assert.match(probe.stderr, /RESOURCE_ATTEMPT:fs\.promises\.mkdir/);
  assert.deepEqual(readdirSync(scratch), [], 'trap probe changed scratch');

  for (const [file, mode] of subjects) {
    const rel = `scripts/${file}`;
    const contract = deriveContract(readFileSync(path.join(root, rel), 'utf8'), rel,
      MISSING_DATABASE_URL_SMOKE_CONTEXT);
    assert.equal(contract.noArgs.exit, 2, `${file}: native noargs contract`);
    assert.equal(contract.noArgs.documented, true, `${file}: documented contract`);
    assert.equal(contract.help.exit, 0, `${file}: native help contract`);
    check(file, [], 2);
    check(file, ['--help'], 0);
    check(file, ['-h'], 0);
    check(file, ['--unknown'], 2);
    check(file, [mode, '--unknown'], 2);
  }
  for (const file of subjects.slice(0, 2).map(([name]) => name)) {
    const configured = invoke(file, ['--prepare']);
    assert.match(configured.stderr, /RESOURCE_ATTEMPT:fs\.promises\.mkdir/,
      `${file}: explicit mode did not reach preparation`);
  }
  check('phase8-session7-lifecycle-replay.mjs', ['--out'], 2);

  const rootScripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  const apiScripts = JSON.parse(readFileSync(path.join(root, 'apps/defense-api/package.json'), 'utf8')).scripts;
  for (const [scripts, name, command] of [
    [rootScripts, 'prepare:phase8-session6:corpus', 'node scripts/prepare-phase8-session6-federal-funding-corpus.mjs --prepare'],
    [rootScripts, 'prepare:phase8-session7:corpus', 'node scripts/prepare-phase8-session7-lifecycle-corpus.mjs --prepare'],
    [rootScripts, 'verify:phase8-session7:replay', 'node scripts/phase8-session7-lifecycle-replay.mjs --run --out docs/defense-budget/phase8-session7-lifecycle-replay-evidence.json'],
    [apiScripts, 'prepare:session6:federal-funding', 'node ../../scripts/prepare-phase8-session6-federal-funding-corpus.mjs --prepare'],
    [apiScripts, 'prepare:session7:corpus', 'node ../../scripts/prepare-phase8-session7-lifecycle-corpus.mjs --prepare'],
  ]) assert.equal(scripts[name], command, `${name}: missing explicit mode`);
  console.log('Phase 8 corpus CLI controls PASS: noargs/help/unknown refuse resources; prepare modes reach work');
} finally {
  const resolved = path.resolve(scratch);
  assert.equal(path.dirname(resolved), tempRoot, 'scratch cleanup escaped temporary root');
  rmSync(resolved, { recursive: true, force: true });
}
