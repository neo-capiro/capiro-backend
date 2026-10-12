import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { deriveContract, MISSING_DATABASE_URL_SMOKE_CONTEXT } from './contract.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const apiRoot = path.join(repoRoot, 'apps/api');
const cases = [
  {
    file: 'verify-defense-budget-extraction-v1.ts',
    exit: 4,
    noArgsStderr: 'Missing --manifest\nUsage: verify-defense-budget-extraction-v1 --manifest FILE --document KEY --artifact FILE --source-document-id UUID [--reference-file FILE] [--expected-source-sha256 SHA] [--expected-artifact-sha256 SHA] [--persist-audit]\n',
    unknownStderr: 'Unknown flag: --unknown\n',
  },
  {
    file: 'verify-defense-budget-non-rdte.ts',
    exit: 5,
    noArgsStderr: 'missing --manifest\nUsage: verify-defense-budget-non-rdte --manifest FILE --artifact-map FILE --verification-jobs FILE --out-dir DIR [--family FAMILY] [--persist-audit]\n',
    unknownStderr: 'unknown flag --unknown\n',
  },
  {
    file: 'verify-defense-budget-rdte.ts',
    exit: 5,
    noArgsStderr: 'missing --manifest\nUsage: verify-defense-budget-rdte --manifest FILE --artifact-map FILE --verification-jobs FILE --out-dir DIR [--persist-audit]\n',
    unknownStderr: 'unknown flag --unknown\n',
  },
];
const resourceProbe = `
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
let writes = 0;
let network = 0;
let children = 0;
for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'renameSync', 'cpSync']) {
  fs[name] = () => { writes++; throw new Error('forbidden file mutation'); };
}
for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'rename', 'cp']) {
  fs.promises[name] = () => { writes++; throw new Error('forbidden file mutation'); };
}
for (const name of ['spawnSync', 'execFileSync', 'spawn', 'execFile']) {
  childProcess[name] = () => { children++; throw new Error('forbidden child process'); };
}
syncBuiltinESMExports();
net.Socket.prototype.connect = () => { network++; throw new Error('forbidden network'); };
http.request = () => { network++; throw new Error('forbidden network'); };
https.request = () => { network++; throw new Error('forbidden network'); };
globalThis.fetch = () => { network++; throw new Error('forbidden network'); };
process.on('exit', () => process.stderr.write('RESOURCE_PROBE:' + writes + ':' + network + ':' + children + '\\n'));
`;
const probeUrl = `data:text/javascript,${encodeURIComponent(resourceProbe)}`;

function invoke(file, args, expectedExit, expectedStderr = null) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'capiro-defense-budget-cli-'));
  try {
    const env = { ...process.env, TSX_DISABLE_CACHE: '1', DATABASE_URL: 'postgresql://localhost/unused' };
    delete env.NODE_OPTIONS;
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--import', probeUrl, path.join(apiRoot, 'scripts', file), ...args],
      { cwd: apiRoot, env, encoding: 'utf8', timeout: 15000 },
    );
    assert.equal(result.error, undefined, `${file} ${args.join(' ')}: ${result.error}`);
    assert.equal(result.signal, null, `${file} ${args.join(' ')} signal`);
    assert.equal(result.status, expectedExit, `${file} ${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, /RESOURCE_PROBE:0:0:0\n/u, 'no writes, network, or child process');
    const stderr = result.stderr.replace('RESOURCE_PROBE:0:0:0\n', '');
    if (expectedStderr !== null) {
      assert.equal(result.stdout, '', 'no stdout for rejected invocation');
      assert.equal(stderr, expectedStderr, 'expected rejection stderr');
      if (args.length === 0) assert.match(stderr, /\nUsage: /u, 'no-argument invocation prints usage');
    } else {
      assert.equal(stderr, '', 'help emits no stderr');
      assert.match(result.stdout, /^Usage: /u);
    }
    assert.deepEqual(readdirSync(scratch), [], 'no files created in scratch');
  } finally {
    assert.equal(path.dirname(scratch), os.tmpdir());
    assert.match(path.basename(scratch), /^capiro-defense-budget-cli-/u);
    rmSync(scratch, { recursive: true, force: true });
  }
}

for (const subject of cases) {
  test(`${subject.file} keeps rejection contracts and has resource-free help`, () => {
    const rel = `apps/api/scripts/${subject.file}`;
    const contract = deriveContract(
      readFileSync(path.join(repoRoot, rel), 'utf8'),
      rel,
      MISSING_DATABASE_URL_SMOKE_CONTEXT,
    );
    assert.equal(contract.noArgs.documented, true, contract.evidence);
    assert.equal(contract.noArgs.exit, subject.exit, contract.evidence);
    assert.equal(contract.help.exit, 0, contract.evidence);
    invoke(subject.file, [], subject.exit, subject.noArgsStderr);
    invoke(subject.file, ['--unknown'], subject.exit, subject.unknownStderr);
    invoke(subject.file, ['--help'], 0);
  });
}
