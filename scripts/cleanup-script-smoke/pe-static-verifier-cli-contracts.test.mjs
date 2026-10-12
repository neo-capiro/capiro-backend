import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { deriveContract, MISSING_DATABASE_URL_SMOKE_CONTEXT } from './contract.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const apiRoot = path.join(repoRoot, 'apps/api');
const cases = [
  { file: 'verify-pe-phase-k.ts', checkOutput: (stdout) => assert.equal(stdout, 'PE_PHASE_K_OK\n') },
  {
    file: 'verify-pe-budget-phase6-safety.ts',
    checkOutput(stdout) {
      const report = JSON.parse(stdout);
      assert.equal(report.status, 'PASS');
      assert.equal(report.negativeControls, 24);
      assert.ok(report.architectureFilesScanned >= 49);
      assert.ok(report.projectionMigrationsScanned >= 4);
      assert.equal(report.canonicalWrites, false);
      assert.equal(report.paidParserDirectCalls, false);
      assert.equal(report.goldenLineKinds, 4);
      assert.equal(report.goldenStages, 9);
      assert.equal(report.goldenReviewCases, 5);
    },
  },
  {
    file: 'verify-rdte-phase-4-safety.ts',
    checkOutput(stdout) {
      const report = JSON.parse(stdout);
      assert.equal(report.ok, true);
      assert.ok(report.filesScanned >= 57);
      assert.equal(report.annualCommand, 'Phase 3 + Phase 2 + reconciliation + proof-bound projection');
      assert.equal(report.migrations, 'two additive forward migrations');
    },
  },
  {
    file: 'verify-pe-budget-phase-7-safety.ts',
    checkOutput(stdout) {
      assert.match(stdout, /^negative-control registry: 32 controls$/m);
      const scanned = /^architecture scan: (\d+) production files across 4 scopes$/m.exec(stdout);
      assert.ok(scanned && Number(scanned[1]) >= 257, 'Phase 7 architecture scan lost coverage');
      assert.match(stdout, /^promoter credential: confined to 5 files, 0 offender\(s\)$/m);
      assert.match(stdout, /^producer plans: plan \+ execute are bound to exact persisted eligibility inputs$/m);
      assert.match(stdout, /^legacy direct commits: 13 dollar loaders checked for in-script containment$/m);
      assert.match(stdout, /^entrypoint: execute\/rollback do not fall back to the serve DSN$/m);
      assert.match(stdout, /^documentation: 5 required documents present$/m);
      assert.match(stdout, /\nPhase 7 safety scan passed\n$/);
    },
  },
];

const probe = `
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
let writes = 0, network = 0, children = 0;
for (const key of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'renameSync', 'cpSync']) {
  fs[key] = () => { writes++; throw new Error('forbidden file mutation'); };
}
for (const key of ['writeFile', 'appendFile', 'mkdir', 'rm', 'rename', 'cp']) {
  fs.promises[key] = () => { writes++; throw new Error('forbidden file mutation'); };
}
for (const key of ['spawnSync', 'execFileSync', 'spawn', 'execFile']) {
  childProcess[key] = () => { children++; throw new Error('forbidden child process'); };
}
syncBuiltinESMExports();
net.Socket.prototype.connect = () => { network++; throw new Error('forbidden network'); };
http.request = () => { network++; throw new Error('forbidden network'); };
https.request = () => { network++; throw new Error('forbidden network'); };
globalThis.fetch = () => { network++; throw new Error('forbidden network'); };
process.on('exit', () => process.stderr.write('RESOURCE_PROBE:' + writes + ':' + network + ':' + children + '\\n'));
`;
const probeUrl = `data:text/javascript,${encodeURIComponent(probe)}`;

function invoke(file, args, expectedExit) {
  const env = { ...process.env, TSX_DISABLE_CACHE: '1' };
  delete env.DATABASE_URL;
  delete env.NODE_OPTIONS;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--import', probeUrl, path.join(apiRoot, 'scripts', file), ...args],
    { cwd: apiRoot, env, encoding: 'utf8', timeout: 15000 },
  );
  assert.equal(result.error, undefined, `${file} ${args.join(' ')}: ${result.error}`);
  assert.equal(result.signal, null, `${file} ${args.join(' ')}: signal`);
  assert.equal(result.status, expectedExit, `${file} ${args.join(' ')}: ${result.stderr}`);
  assert.match(result.stderr, /RESOURCE_PROBE:0:0:0\n/u, 'no writes, network, or children');
  return {
    stdout: result.stdout,
    stderr: result.stderr.replace('RESOURCE_PROBE:0:0:0\n', ''),
  };
}

for (const subject of cases) {
  test(`${subject.file} preserves its scan and refuses unused CLI modes before resources`, () => {
    const rel = `apps/api/scripts/${subject.file}`;
    const contract = deriveContract(
      readFileSync(path.join(repoRoot, rel), 'utf8'),
      rel,
      MISSING_DATABASE_URL_SMOKE_CONTEXT,
    );
    assert.equal(contract.noArgs.documented, true, contract.evidence);
    assert.equal(contract.noArgs.exit, 0, contract.evidence);
    assert.equal(contract.help.exit, 0, contract.evidence);

    const usage = `Usage: tsx scripts/${subject.file} [--help]\n`;
    const normal = invoke(subject.file, [], 0);
    assert.equal(normal.stderr, usage, 'noargs adds only the documented usage line');
    subject.checkOutput(normal.stdout);

    const help = invoke(subject.file, ['--help'], 0);
    assert.equal(help.stdout, usage);
    assert.equal(help.stderr, '');

    const unknown = invoke(subject.file, ['--unknown'], 2);
    assert.equal(unknown.stdout, '');
    assert.equal(unknown.stderr, `Unknown argument(s): --unknown\n${usage}`);
  });
}
