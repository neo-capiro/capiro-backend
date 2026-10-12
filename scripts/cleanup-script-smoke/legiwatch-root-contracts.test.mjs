import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { deriveContract, MISSING_DATABASE_URL_SMOKE_CONTEXT } from './contract.mjs';

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const subjects = [
  ['assert-test-summary.mjs', 2],
  ['legiwatch-phase2-runtime-plan.mjs', 1],
  ...[3, 4, 5, 6, 7, 8].map((phase) => [`legiwatch-phase${phase}-qualification.mjs`, 1]),
];
const resourceProbe = `
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
let writes = 0;
let network = 0;
for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'renameSync', 'cpSync']) {
  fs[name] = () => { writes++; throw new Error('forbidden file mutation'); };
}
for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'rename', 'cp']) {
  fs.promises[name] = () => { writes++; throw new Error('forbidden file mutation'); };
}
net.Socket.prototype.connect = () => { network++; throw new Error('forbidden network'); };
http.request = () => { network++; throw new Error('forbidden network'); };
https.request = () => { network++; throw new Error('forbidden network'); };
globalThis.fetch = () => { network++; throw new Error('forbidden network'); };
process.on('exit', () => process.stderr.write('RESOURCE_PROBE:' + writes + ':' + network + '\\n'));
`;
const probeUrl = `data:text/javascript,${encodeURIComponent(resourceProbe)}`;

function invoke(script, args, status, configuredDatabase = false) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'capiro-legiwatch-cli-'));
  try {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    if (configuredDatabase) env.DATABASE_URL = 'postgresql://localhost/unused';
    else delete env.DATABASE_URL;
    for (const phase of [4, 5, 6, 7, 8]) {
      env[`LEGIWATCH_PHASE${phase}_TEST_DATABASE`] = 'disposable';
    }
    env.LEGIWATCH_RECORDING_TEST_DATABASE = 'disposable';
    const result = spawnSync(
      process.execPath,
      ['--import', probeUrl, path.join(scriptsDir, script), ...args],
      {
        cwd: scratch,
        env,
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    assert.equal(result.error, undefined, `${script} ${args.join(' ')}: ${result.error}`);
    assert.equal(result.signal, null, `${script} ${args.join(' ')} signal`);
    assert.equal(result.status, status, `${script} ${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stdout + result.stderr, /usage:/iu);
    assert.doesNotMatch(result.stderr, /\n\s+at |file:\/\/\//u, 'no uncaught error trace');
    assert.match(result.stderr, /RESOURCE_PROBE:0:0/u, 'no file mutation or network call');
    assert.deepEqual(readdirSync(scratch), [], 'no files created in the working directory');
  } finally {
    assert.equal(path.dirname(scratch), os.tmpdir());
    assert.match(path.basename(scratch), /^capiro-legiwatch-cli-/u);
    rmSync(scratch, { recursive: true, force: true });
  }
}

for (const [script, noArgsExit] of subjects) {
  test(`${script} declares and honors safe no-argument and help contracts`, () => {
    const source = readFileSync(path.join(scriptsDir, script), 'utf8');
    const contract = deriveContract(
      source,
      `scripts/${script}`,
      MISSING_DATABASE_URL_SMOKE_CONTEXT,
    );
    assert.equal(contract.noArgs.documented, true, contract.evidence);
    assert.equal(contract.noArgs.exit, noArgsExit, contract.evidence);
    assert.equal(contract.help.supported, true, contract.evidence);
    assert.equal(contract.help.exit, 0, contract.evidence);
    invoke(script, [], noArgsExit);
    invoke(script, ['--help'], 0, true);
  });
}

test('qualification scripts refuse unexpected arguments before configured database work', () => {
  for (const [script] of subjects.slice(2)) invoke(script, ['--unknown'], 2, true);
});

test('runtime plan refuses unknown options before reading AWS snapshots', () => {
  invoke('legiwatch-phase2-runtime-plan.mjs', ['--unknown'], 2);
});

test('summary gate rejects an invalid floor before reading a summary', () => {
  invoke('assert-test-summary.mjs', ['missing.json', 'label', 'NaN', '1'], 2);
});
