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
  {
    file: 'lint-pe-scripts.ts',
    noArgsExit: 0,
    success: 'PE_LINT_SCRIPTS_OK\n',
    usage: 'Usage: tsx scripts/lint-pe-scripts.ts [--help]\n',
  },
  {
    file: 'verify-pe-migration-guards.ts',
    noArgsExit: 0,
    success: 'PE_MIGRATION_GUARDS_OK\n',
    usage:
      'Usage: tsx scripts/verify-pe-migration-guards.ts [--validate-generate] [--help]\n',
  },
  {
    file: 'verify-pe-phase-e-exact-sha.ts',
    noArgsExit: 0,
    loadersExpected: [
      'sync-comptroller-jbooks.ts',
      'sync-jbook-r2.ts',
      'sync-jbook-performers.ts',
      'parse-pdoc-army.ts',
      'load-pdoc-enrichment.ts',
      'load-om.ts',
      'load-om-op5.ts',
      'parse-hasc-sasc-reports.ts',
      'parse-defense-approps-reports.ts',
      'parse-ndaa-conference.ts',
      'parse-defense-approps-public-law.ts',
      'ingest-defense-budget-pdf.ts',
      'load-defense-budget-package.ts',
    ],
    usage: 'Usage: tsx scripts/verify-pe-phase-e-exact-sha.ts [--help]\n',
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

function invoke(file, args, expectedExit, sourceOverride) {
  const env = { ...process.env, TSX_DISABLE_CACHE: '1' };
  delete env.DATABASE_URL;
  delete env.NODE_OPTIONS;
  const overrideProbe = sourceOverride
    ? `
const originalRead = fs.readFileSync;
const overriddenPath = ${JSON.stringify(sourceOverride.path)};
const overriddenSource = ${JSON.stringify(sourceOverride.source)};
fs.readFileSync = (file, ...args) => {
  const normalized = String(file).replaceAll('\\\\', '/');
  if (normalized.endsWith('/' + overriddenPath)) {
    return args[0] === 'utf8' ? overriddenSource : Buffer.from(overriddenSource);
  }
  return originalRead(file, ...args);
};
syncBuiltinESMExports();
`
    : '';
  const actualProbeUrl = sourceOverride
    ? `data:text/javascript,${encodeURIComponent(probe + overrideProbe)}`
    : probeUrl;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--import', actualProbeUrl, path.join(apiRoot, 'scripts', file), ...args],
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
  test(`${subject.file} preserves its static gate and refuses unused CLI modes`, () => {
    const rel = `apps/api/scripts/${subject.file}`;
    const contract = deriveContract(
      readFileSync(path.join(repoRoot, rel), 'utf8'),
      rel,
      MISSING_DATABASE_URL_SMOKE_CONTEXT,
    );
    assert.equal(contract.noArgs.documented, true, contract.evidence);
    assert.equal(contract.noArgs.exit, subject.noArgsExit ?? 1, contract.evidence);
    assert.equal(contract.help.exit, 0, contract.evidence);

    const normal = invoke(subject.file, [], subject.noArgsExit ?? 1);
    assert.ok(normal.stderr.startsWith(subject.usage), 'usage precedes the gate result');
    assert.doesNotMatch(normal.stderr, /AssertionError|node:internal|\n\s+at /u,
      'CLI renders a failure without an uncaught stack');
    if (subject.success) {
      assert.equal(normal.stderr, subject.usage);
      assert.equal(normal.stdout, subject.success, 'canonical source protocol passes the strict gate');
    } else {
      assert.equal(normal.stderr, subject.usage);
      assert.deepEqual(JSON.parse(normal.stdout), {
        ok: true,
        loadersChecked: 13,
        loaders: subject.loadersExpected,
      }, 'strict inspection containment and every unchanged write loader pass');
    }

    const help = invoke(subject.file, ['--help'], 0);
    assert.equal(help.stdout, subject.usage);
    assert.equal(help.stderr, '');

    const unknown = invoke(subject.file, ['--unknown'], 2);
    assert.equal(unknown.stdout, '');
    assert.equal(unknown.stderr, `Unknown argument(s): --unknown\n${subject.usage}`);
  });
}

test('migration guard help and unknown refuse before optional Prisma subprocesses', () => {
  const file = 'verify-pe-migration-guards.ts';
  const usage = cases[1].usage;
  const help = invoke(file, ['--validate-generate', '--help'], 0);
  assert.equal(help.stdout, usage);
  assert.equal(help.stderr, '');
  const unknown = invoke(file, ['--validate-generate', '--unknown'], 2);
  assert.equal(unknown.stdout, '');
  assert.equal(unknown.stderr, `Unknown argument(s): --unknown\n${usage}`);
});

test('both migration CLIs refuse unreviewed raw source before success or optional Prisma', () => {
  const sourcePath = 'scripts/entrypoint.sh';
  const source = readFileSync(path.join(apiRoot, sourcePath), 'utf8');
  for (const variant of [
    `${source}\n# unreviewed source envelope drift\n`,
    `${source}\nnode ./node_modules/prisma/build/index.js migrate resolve --applied unsafe\n`,
    source.replace('    shift\n    if [ -z "${1:-}" ]; then',
      '    echo bypassed-shift\n    if [ -z "${1:-}" ]; then'),
  ]) {
    assert.notEqual(variant, source, 'each source mutation is present');
    for (const [file, args, prefix] of [
      ['lint-pe-scripts.ts', [], cases[0].usage + 'PE_LINT_SCRIPTS_FAILED: '],
      ['verify-pe-migration-guards.ts', ['--validate-generate'], 'PE_MIGRATION_GUARDS_FAILED: '],
    ]) {
      const result = invoke(file, args, 1, { path: sourcePath, source: variant });
      assert.equal(result.stdout, '', 'refused source emits no success marker');
      assert.ok(result.stderr.startsWith(prefix), 'guard renders the expected CLI failure');
      assert.match(result.stderr,
        /scripts\/entrypoint\.sh: raw LF-normalized source differs from the approved manual recovery envelope/u);
      assert.doesNotMatch(result.stderr, /_OK\b|RESOURCE_PROBE|AssertionError|node:internal|\n\s+at /u);
    }
  }
});
