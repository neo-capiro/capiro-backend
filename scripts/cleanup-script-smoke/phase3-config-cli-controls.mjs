#!/usr/bin/env node
/** Actual-source Phase 3 CLI controls with resource calls trapped before import. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratchRoot = path.resolve(os.tmpdir());
const scratch = mkdtempSync(path.join(scratchRoot, 'capiro-phase3-cli-'));
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
const baseEnv = Object.fromEntries(
  ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
);
const subjects = [
  { file: 'engagement-phase3-resilience.mjs', required: [
    'ENGAGEMENT_PHASE3_EVIDENCE_DIR', 'ENGAGEMENT_PHASE3_FIXTURE_FILE',
    'ENGAGEMENT_PHASE3_ADMIN_TOKEN_FILE', 'ENGAGEMENT_PHASE3_DB_CONTAINER',
  ] },
  { file: 'run-engagement-phase3-resilience.mjs', required: [
    'DATABASE_URL', 'ENGAGEMENT_PHASE3_EVIDENCE_DIR',
  ] },
  { file: 'verify-engagement-phase3-local-evidence.mjs', required: [
    'ENGAGEMENT_PHASE3_EVIDENCE_DIR', 'RELEASE_SHA',
  ] },
];

function checkTrap() {
  const probe = spawnSync(process.execPath, [
    '--import', trapUrl, '--input-type=module', '-e',
    "import { writeFile } from 'node:fs/promises'; await writeFile('forbidden', 'data');",
  ], { cwd: scratch, env: baseEnv, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(probe.error, undefined, 'resource trap probe spawn error');
  assert.notEqual(probe.status, 0, 'resource trap must reject a deliberate write attempt');
  assert.match(probe.stderr, /RESOURCE_ATTEMPT:fs\.promises\.writeFile/,
    'resource trap did not intercept fs/promises.writeFile');
  assert.deepEqual(readdirSync(scratch), [], 'resource trap probe wrote in calling directory');
}

function check(subject, args, env, expectedExit) {
  const result = spawnSync(process.execPath, ['--import', trapUrl, path.join(ROOT, 'scripts', subject.file), ...args], {
    cwd: scratch,
    env,
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  const label = `${subject.file} ${args.join(' ') || '(noargs)'}`;
  assert.equal(result.error, undefined, `${label}: spawn error`);
  assert.equal(result.signal, null, `${label}: signalled`);
  assert.equal(result.status, expectedExit, `${label}: exit ${result.status}: ${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, /Usage:/, `${label}: missing usage`);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /RESOURCE_ATTEMPT|\n\s+at /,
    `${label}: attempted a resource or emitted an uncaught stack`);
  assert.deepEqual(readdirSync(scratch), [], `${label}: wrote in calling directory`);
}

try {
  checkTrap();
  for (const subject of subjects) {
    check(subject, [], baseEnv, 2);
    check(subject, ['--help'], baseEnv, 0);
    check(subject, ['-h'], baseEnv, 0);
    check(subject, ['--unknown'], baseEnv, 2);
    for (const missing of subject.required) {
      const env = { ...baseEnv, ...Object.fromEntries(subject.required.map((name) => [name, 'fixture-value'])) };
      delete env[missing];
      check(subject, [], env, 2);
    }
    const configured = { ...baseEnv, ...Object.fromEntries(subject.required.map((name) => [name, 'fixture-value'])) };
    check(subject, ['--help'], configured, 0);
    check(subject, ['--unknown'], configured, 2);
  }
  console.log('Phase 3 CLI controls PASS: missing-config noargs, help, unknown, no resource attempts');
} finally {
  const resolved = path.resolve(scratch);
  assert.equal(path.dirname(resolved), scratchRoot, 'scratch cleanup escaped temporary root');
  rmSync(resolved, { recursive: true, force: true });
}
