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
  'audit-pe-zero-request.ts',
  'diag-alert-coverage.ts',
  'diag-audit-append-only.ts',
  'diag-auditor-shadow.ts',
  'diag-blin-coverage.ts',
  'diag-blueprint-qa.ts',
  'diag-client-resolution.ts',
  'diag-clio-memory.ts',
  'diag-district-nexus-flag-state.ts',
  'diag-district-nexus-source-matrix.ts',
  'diag-engagement-campaigns.ts',
  'diag-facility-districts.ts',
  'diag-graph-coverage.ts',
  'diag-ingestion-health.ts',
  'diag-lda-identity.ts',
  'diag-mail-search-match.ts',
  'diag-memory-recall-parity.ts',
  'diag-outlook-sync.ts',
  'diag-outreach-usage.ts',
  'diag-pe-detail-coverage.ts',
  'diag-phantom-imports.ts',
  'diag-recall-recency.ts',
  'diag-state-crosswalk-coverage.ts',
  'diag-state-legislator-detail.ts',
  'diag-stale-directory.ts',
  'diag-tenant-config.ts',
  'export-master-lists.ts',
  'report-award-pe-coverage.ts',
  'report-bizdev-jev-shadow.ts',
  'report-meri-retrieval-v2.ts',
  'report-pe-attribution-gaps.ts',
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

function invoke(subject, args, expectedExit, databaseConfigured = false) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'capiro-diagnostic-cli-'));
  try {
    const env = { ...process.env, TSX_DISABLE_CACHE: '1' };
    delete env.NODE_OPTIONS;
    if (databaseConfigured) env.DATABASE_URL = 'postgresql://localhost/unused';
    else delete env.DATABASE_URL;
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
    assert.deepEqual(readdirSync(scratch), [], 'no files created in scratch');
  } finally {
    assert.equal(path.dirname(scratch), os.tmpdir());
    assert.match(path.basename(scratch), /^capiro-diagnostic-cli-/u);
    rmSync(scratch, { recursive: true, force: true });
  }
}

for (const subject of subjects) {
  test(`${subject} honors no-argument, help, and unsupported-option boundaries`, () => {
    const rel = `apps/api/scripts/${subject}`;
    const contract = deriveContract(
      readFileSync(path.join(repoRoot, rel), 'utf8'),
      rel,
      MISSING_DATABASE_URL_SMOKE_CONTEXT,
    );
    assert.equal(contract.noArgs.documented, true, contract.evidence);
    assert.equal(contract.noArgs.exit, 2, contract.evidence);
    assert.equal(contract.help.exit, 0, contract.evidence);
    invoke(subject, [], 2);
    invoke(subject, ['--help'], 0, true);
    invoke(subject, ['--unknown'], 2, true);
  });
}
