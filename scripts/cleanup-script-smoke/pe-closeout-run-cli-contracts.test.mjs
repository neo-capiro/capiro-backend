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
  { file: 'verify-pe-budget-phase-3-closeout.ts', includeContainers: true },
  { file: 'verify-pe-budget-phase-4-closeout.ts', includeContainers: true, nested: 'verify-pe-budget-phase-3-closeout.ts' },
  { file: 'verify-pe-budget-phase-5-closeout.ts', includeContainers: true, nested: 'verify-pe-budget-phase-4-closeout.ts' },
  { file: 'verify-pe-budget-phases-1-7-audit-repairs.ts', includeContainers: false, nested: 'verify-pe-budget-phase-3-closeout.ts' },
];

const probe = `
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
let files = 0, writes = 0, network = 0, children = 0;
const subject = process.env.CAPIRO_CLI_TARGET;
for (const name of ['existsSync', 'readFileSync', 'readdirSync', 'statSync', 'accessSync']) {
  const original = fs[name];
  fs[name] = function (...args) {
    if (new Error().stack?.includes(subject)) {
      files++;
      if (process.env.CAPIRO_FAKE_CHILD !== '1') throw new Error('forbidden subject file access');
    }
    return original.apply(this, args);
  };
}
for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'renameSync']) {
  fs[name] = () => { writes++; throw new Error('forbidden file mutation'); };
}
for (const name of ['writeFile', 'appendFile', 'mkdir', 'rm', 'rename']) {
  fs.promises[name] = () => { writes++; throw new Error('forbidden file mutation'); };
}
childProcess.spawnSync = (command, args) => {
  children++;
  if (process.env.CAPIRO_FAKE_CHILD === '1') {
    process.stderr.write('FAKE_CHILD:' + JSON.stringify({ command, args }) + '\\n');
    return { status: 77, error: undefined };
  }
  throw new Error('forbidden child process');
};
syncBuiltinESMExports();
net.Socket.prototype.connect = () => { network++; throw new Error('forbidden network'); };
http.request = () => { network++; throw new Error('forbidden network'); };
https.request = () => { network++; throw new Error('forbidden network'); };
globalThis.fetch = () => { network++; throw new Error('forbidden network'); };
process.on('exit', () => process.stderr.write('RESOURCE_PROBE:' + files + ':' + writes + ':' + network + ':' + children + '\\n'));
`;
const probeUrl = `data:text/javascript,${encodeURIComponent(probe)}`;

function invoke(subject, args, expectedExit, fakeChild = false) {
  const env = {
    ...process.env,
    TSX_DISABLE_CACHE: '1',
    CAPIRO_CLI_TARGET: subject.file,
    CAPIRO_FAKE_CHILD: fakeChild ? '1' : '0',
  };
  delete env.DATABASE_URL;
  delete env.NODE_OPTIONS;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--import', probeUrl, path.join(apiRoot, 'scripts', subject.file), ...args],
    { cwd: apiRoot, env, encoding: 'utf8', timeout: 15000 },
  );
  assert.equal(result.error, undefined, `${subject.file} ${args.join(' ')}: ${result.error}`);
  assert.equal(result.signal, null, `${subject.file} ${args.join(' ')}: signal`);
  assert.equal(result.status, expectedExit, `${subject.file} ${args.join(' ')}: ${result.stderr}`);
  const match = /RESOURCE_PROBE:(\d+):(\d+):(\d+):(\d+)\n/u.exec(result.stderr);
  assert.ok(match, `${subject.file}: missing resource audit: ${result.stderr}`);
  return {
    stdout: result.stdout,
    stderr: result.stderr.replace(match[0], ''),
    counts: match.slice(1).map(Number),
  };
}

for (const subject of cases) {
  test(`${subject.file} requires explicit run before any resource attempt`, () => {
    const rel = `apps/api/scripts/${subject.file}`;
    const contract = deriveContract(
      readFileSync(path.join(repoRoot, rel), 'utf8'),
      rel,
      MISSING_DATABASE_URL_SMOKE_CONTEXT,
    );
    assert.equal(contract.noArgs.documented, true, contract.evidence);
    assert.equal(contract.noArgs.exit, 2, contract.evidence);
    assert.equal(contract.help.exit, 0, contract.evidence);

    const usage = `Usage: tsx scripts/${subject.file} --run${subject.includeContainers ? ' [--include-containers]' : ''}\n`;
    for (const [args, exit, stdout, stderr] of [
      [[], 2, '', usage],
      [['--help'], 0, usage, ''],
      [['--unknown'], 2, '', `unknown argument(s): --unknown\n${usage}`],
      ...(subject.includeContainers ? [[['--include-containers'], 2, '', usage]] : []),
    ]) {
      const actual = invoke(subject, args, exit);
      assert.equal(actual.stdout, stdout);
      assert.equal(actual.stderr, stderr);
      assert.deepEqual(actual.counts, [0, 0, 0, 0], 'refusal/help attempts no file, write, network, or child');
    }

    const configured = invoke(subject, ['--run'], subject.file.includes('phase-3') || subject.file.includes('audit-repairs') ? 77 : 1, true);
    assert.equal(configured.counts[1], 0, 'configured path still makes no direct file mutation before first step');
    assert.equal(configured.counts[2], 0, 'configured path makes no network call before first step');
    assert.equal(configured.counts[3], 1, 'configured path reaches its first validation step');
    assert.match(configured.stderr, /FAKE_CHILD:/u);
    if (subject.nested) {
      const call = JSON.parse(/FAKE_CHILD:(\{[^\n]+\})\n/u.exec(configured.stderr)?.[1] ?? 'null');
      assert.ok(call.args.some((arg) => arg.endsWith(subject.nested)), `first validation step invokes expected nested closeout: ${JSON.stringify(call)}`);
      assert.ok(call.args.includes('--run'), 'nested closeout receives explicit --run');
      if (subject.includeContainers) {
        const withContainers = invoke(subject, ['--run', '--include-containers'], 1, true);
        const nestedCall = JSON.parse(/FAKE_CHILD:(\{[^\n]+\})\n/u.exec(withContainers.stderr)?.[1] ?? 'null');
        assert.ok(nestedCall.args.includes('--include-containers'), 'nested closeout retains container mode');
        assert.ok(nestedCall.args.includes('--run'), 'nested closeout retains explicit --run');
      } else {
        assert.ok(call.args.includes('--include-containers'), 'audit repairs always include container smoke');
      }
    }
  });
}
