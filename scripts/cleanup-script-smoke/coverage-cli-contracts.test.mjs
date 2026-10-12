import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { deriveContract, MISSING_DATABASE_URL_SMOKE_CONTEXT } from './contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const rel = 'scripts/cleanup-gates/coverage.mjs';
const subject = path.join(root, rel);
const probe = `
import fs from 'node:fs';
import child from 'node:child_process';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
let attempts = 0;
for (const name of ['writeFileSync', 'mkdirSync', 'rmSync', 'copyFileSync']) {
  fs[name] = () => { attempts++; throw new Error('forbidden file mutation'); };
}
for (const name of ['spawnSync', 'execSync', 'execFileSync', 'spawn', 'execFile']) {
  child[name] = () => { attempts++; throw new Error('forbidden child process'); };
}
syncBuiltinESMExports();
net.Socket.prototype.connect = () => { attempts++; throw new Error('forbidden network'); };
process.on('exit', () => process.stderr.write('COVERAGE_RESOURCE_ATTEMPTS:' + attempts + '\\n'));
`;
const probeUrl = `data:text/javascript,${encodeURIComponent(probe)}`;

function invoke(args, expectedExit) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, ['--import', probeUrl, subject, ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null);
  assert.equal(result.status, expectedExit, result.stderr);
  assert.match(result.stderr, /COVERAGE_RESOURCE_ATTEMPTS:0\n/u);
  const stderr = result.stderr.replace('COVERAGE_RESOURCE_ATTEMPTS:0\n', '');
  assert.match(result.stdout + stderr, /Usage: node scripts\/cleanup-gates\/coverage\.mjs/u);
  return { stdout: result.stdout, stderr };
}

test('coverage driver refuses bare noargs before any work and preserves package mode', () => {
  const contract = deriveContract(
    readFileSync(subject, 'utf8'), rel, MISSING_DATABASE_URL_SMOKE_CONTEXT,
  );
  assert.equal(contract.noArgs.documented, true, contract.evidence);
  assert.equal(contract.noArgs.exit, 2, contract.evidence);
  assert.equal(contract.help.exit, 0, contract.evidence);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['coverage:cleanup1'], 'node scripts/cleanup-gates/coverage.mjs --measure');

  const noargs = invoke([], 2);
  assert.equal(noargs.stdout, '');
  assert.match(noargs.stderr, /^Usage:/u);
  const help = invoke(['--help'], 0);
  assert.equal(help.stderr, '');
  assert.match(help.stdout, /^Usage:/u);
  const unknown = invoke(['--unknown'], 2);
  assert.equal(unknown.stdout, '');
  assert.match(unknown.stderr, /^error: unknown option: --unknown\nUsage:/u);
});
