#!/usr/bin/env node
/** Exercise the actual Meri evaluation CLIs under a resource-denying preload. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveContract, MISSING_DATABASE_URL_SMOKE_CONTEXT } from './contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const packageDir = path.join(root, 'packages', 'meriv2-core');
const tempRoot = path.resolve(os.tmpdir());
const scratch = mkdtempSync(path.join(tempRoot, 'capiro-meriv2-eval-cli-'));
const baseEnv = Object.fromEntries(
  ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
);
baseEnv.TSX_DISABLE_CACHE = '1';
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
  'syncBuiltinESMExports();',
].join('\n');
const trapUrl = `data:text/javascript,${encodeURIComponent(trapSource)}`;
const subjects = [
  ['jev-package2-eval.ts', '--write'],
  ['jev-package9-economics.ts', '--write'],
  ['jev-replay-eval.ts', '--write'],
  ['repair-replay-eval.ts', '--run'],
];

function invoke(file, args) {
  // The loader starts first; its own transform/cache setup is outside the CLI contract.
  // Disable that cache so a cold run cannot produce an unrelated write attempt.
  return spawnSync(process.execPath, [
    '--import', 'tsx', '--import', trapUrl, path.join(packageDir, 'scripts', file), ...args,
  ], { cwd: packageDir, env: baseEnv, encoding: 'utf8', timeout: 15000, windowsHide: true });
}

function check(file, args, exit) {
  const result = invoke(file, args);
  const label = `${file} ${args.join(' ') || '(noargs)'}`;
  assert.equal(result.error, undefined, `${label}: spawn error`);
  assert.equal(result.signal, null, `${label}: signalled`);
  assert.equal(result.status, exit, `${label}: unexpected exit ${result.status}: ${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, /Usage:/, `${label}: usage missing`);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /RESOURCE_ATTEMPT|\n\s+at /,
    `${label}: resource attempt or uncaught trace`);
  assert.deepEqual(readdirSync(scratch), [], `${label}: unexpected scratch write`);
}

try {
  const probe = spawnSync(process.execPath, [
    '--import', trapUrl, '--input-type=module', '-e',
    "import { writeFileSync } from 'node:fs'; writeFileSync('forbidden', 'data');",
  ], { cwd: scratch, env: baseEnv, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.notEqual(probe.status, 0, 'resource trap must reject a deliberate write');
  assert.match(probe.stderr, /RESOURCE_ATTEMPT:fs\.writeFileSync/);
  assert.deepEqual(readdirSync(scratch), [], 'trap probe changed scratch');

  for (const [file, mode] of subjects) {
    const rel = `packages/meriv2-core/scripts/${file}`;
    const contract = deriveContract(
      readFileSync(path.join(packageDir, 'scripts', file), 'utf8'),
      rel,
      MISSING_DATABASE_URL_SMOKE_CONTEXT,
    );
    assert.equal(contract.noArgs.exit, 2, `${file}: native smoke noargs contract`);
    assert.equal(contract.noArgs.documented, true, `${file}: native smoke documentation`);
    assert.equal(contract.help.exit, 0, `${file}: native smoke help contract`);
    check(file, [], 2);
    check(file, ['--help'], 0);
    check(file, ['-h'], 0);
    check(file, ['--unknown'], 2);
    check(file, [mode, '--unknown'], 2);
    const configured = invoke(file, [mode]);
    assert.equal(configured.error, undefined, `${file}: configured spawn error`);
    const expectedResource = file === 'repair-replay-eval.ts'
      ? /RESOURCE_ATTEMPT:child_process\.spawnSync/
      : /RESOURCE_ATTEMPT:fs\.mkdirSync/;
    assert.match(configured.stderr, expectedResource,
      `${file}: explicit mode did not reach its write or Jest subprocess`);
  }

  const aliases = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')).scripts;
  for (const [name, command] of [
    ['eval:jev-package2', 'tsx scripts/jev-package2-eval.ts --write'],
    ['eval:jev-package9-economics', 'tsx scripts/jev-package9-economics.ts --write'],
    ['eval:jev-replay', 'tsx scripts/jev-replay-eval.ts --write'],
    ['eval:repair-replay', 'tsx scripts/repair-replay-eval.ts --run'],
  ]) assert.equal(aliases[name], command, `${name}: package alias lost its explicit mode`);
  console.log('Meri evaluation CLI controls PASS: noargs/help/unknown refuse resources; explicit modes reach configured work');
} finally {
  const resolved = path.resolve(scratch);
  assert.equal(path.dirname(resolved), tempRoot, 'scratch cleanup escaped temporary root');
  rmSync(resolved, { recursive: true, force: true });
}
