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
const subjects = [
  ['bind-engagement-phase3-auth-fixtures.ts', 1],
  ['engagement-phase1-assert-sole-membership.ts', 1],
  ['engagement-phase0-side-effect-verify.ts', 0],
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

function invoke(subject, args, expectedExit, configuredDatabase = false) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'capiro-api-legacy-cli-'));
  try {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    env.TSX_DISABLE_CACHE = '1';
    if (configuredDatabase) env.DATABASE_URL = 'postgresql://localhost/unused';
    else delete env.DATABASE_URL;
    delete env.ENGAGEMENT_PHASE3_ADMIN_CLERK_USER_ID;
    delete env.ENGAGEMENT_PHASE1_USER_CLERK_ID;
    delete env.ENGAGEMENT_PHASE0_USER_CLERK_ID;
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--import', probeUrl, path.join(apiRoot, 'scripts', subject), ...args],
      { cwd: apiRoot, env, encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(result.error, undefined, `${subject} ${args.join(' ')}: ${result.error}`);
    assert.equal(result.signal, null, `${subject} ${args.join(' ')} signal`);
    assert.equal(result.status, expectedExit, `${subject} ${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stdout + result.stderr, /Usage:/u);
    assert.doesNotMatch(result.stderr, /\n\s+at |file:\/\/\//u, 'no uncaught error trace');
    assert.match(result.stderr, /RESOURCE_PROBE:0:0/u, 'no file mutation or network call');
    assert.deepEqual(readdirSync(scratch), [], 'no files created in the scratch directory');
  } finally {
    assert.equal(path.dirname(scratch), os.tmpdir());
    assert.match(path.basename(scratch), /^capiro-api-legacy-cli-/u);
    rmSync(scratch, { recursive: true, force: true });
  }
}

for (const [subject, noArgsExit] of subjects) {
  test(`${subject} declares and honors safe no-argument and help contracts`, () => {
    const rel = `apps/api/scripts/${subject}`;
    const contract = deriveContract(
      readFileSync(path.join(repoRoot, rel), 'utf8'),
      rel,
      MISSING_DATABASE_URL_SMOKE_CONTEXT,
    );
    assert.equal(contract.noArgs.documented, true, contract.evidence);
    assert.equal(contract.noArgs.exit, noArgsExit, contract.evidence);
    assert.equal(contract.help.exit, 0, contract.evidence);
    invoke(subject, [], noArgsExit);
    invoke(subject, ['--help'], 0, true);
    invoke(subject, ['--unknown'], 2, true);
  });
}
