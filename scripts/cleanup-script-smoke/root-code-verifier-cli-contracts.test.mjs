import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { deriveContract, MISSING_DATABASE_URL_SMOKE_CONTEXT } from './contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cases = [
  {
    file: 'verify-engagement-phase3-code.mjs',
    packageCommand: 'verify:engagement-phase-3',
  },
  {
    file: 'verify-outreach-v3-phase6-code.mjs',
    packageCommand: 'verify:outreach-v3-phase-6',
  },
  {
    file: 'verify-outreach-v3-templates-code.mjs',
    packageCommand: 'verify:outreach-v3-templates',
  },
  { file: 'verify-outreach-v3-phase4-6-combined.mjs' },
];
const probe = `
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
let writes = 0, network = 0, children = 0;
const deny = (kind) => {
  if (kind === 'write') writes++;
  else if (kind === 'network') network++;
  else children++;
  process.exit(kind === 'child' ? 73 : kind === 'write' ? 74 : 75);
};
const openSync = fs.openSync;
fs.openSync = (file, flags, ...rest) =>
  /[wax+]/.test(String(flags)) ? deny('write') : openSync(file, flags, ...rest);
for (const key of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'renameSync', 'cpSync']) {
  fs[key] = () => deny('write');
}
for (const key of ['writeFile', 'appendFile', 'mkdir', 'rm', 'rename', 'cp']) {
  fs.promises[key] = () => deny('write');
}
for (const key of ['spawnSync', 'execFileSync', 'spawn', 'execFile']) {
  childProcess[key] = () => deny('child');
}
syncBuiltinESMExports();
net.Socket.prototype.connect = () => deny('network');
http.request = () => deny('network');
https.request = () => deny('network');
globalThis.fetch = () => deny('network');
process.on('exit', () => process.stderr.write('RESOURCE_PROBE:' + writes + ':' + network + ':' + children + '\\n'));
`;
const probeUrl = `data:text/javascript,${encodeURIComponent(probe)}`;

function invoke(file, args, expectedExit, expectedProbe) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.NODE_OPTIONS;
  const result = spawnSync(
    process.execPath,
    ['--import', probeUrl, path.join(root, 'scripts', file), ...args],
    { cwd: root, env, encoding: 'utf8', timeout: 15000, windowsHide: true },
  );
  assert.equal(result.error, undefined, `${file} ${args.join(' ')}: ${result.error}`);
  assert.equal(result.signal, null, `${file} ${args.join(' ')}: signal`);
  assert.equal(result.status, expectedExit, `${file} ${args.join(' ')}: ${result.stderr}`);
  assert.ok(result.stderr.endsWith(`${expectedProbe}\n`), `${file}: ${result.stderr}`);
  return {
    stdout: result.stdout,
    stderr: result.stderr.slice(0, -`${expectedProbe}\n`.length),
  };
}

for (const subject of cases) {
  test(`${subject.file} refuses accidental execution and retains its configured gate`, () => {
    const relative = `scripts/${subject.file}`;
    const contract = deriveContract(
      readFileSync(path.join(root, relative), 'utf8'),
      relative,
      MISSING_DATABASE_URL_SMOKE_CONTEXT,
    );
    assert.equal(contract.noArgs.documented, true, contract.evidence);
    assert.equal(contract.noArgs.exit, 2, contract.evidence);
    assert.equal(contract.help.exit, 0, contract.evidence);

    const combined = !subject.packageCommand;
    const usage = combined
      ? `Usage: node scripts/${subject.file} (--run | --sha <head> | --help)\n`
      : `Usage: node scripts/${subject.file} (--run | --help)\n`;
    const noargs = invoke(subject.file, [], 2, 'RESOURCE_PROBE:0:0:0');
    assert.equal(noargs.stdout, '');
    assert.equal(noargs.stderr, usage);
    const help = invoke(subject.file, ['--help'], 0, 'RESOURCE_PROBE:0:0:0');
    assert.equal(help.stdout, usage);
    assert.equal(help.stderr, '');
    for (const args of [['--unknown'], ['--run', '--unknown']]) {
      const unknown = invoke(subject.file, args, 2, 'RESOURCE_PROBE:0:0:0');
      assert.equal(unknown.stdout, '');
      assert.equal(unknown.stderr, usage);
    }

    invoke(subject.file, ['--run'], 73, 'RESOURCE_PROBE:0:0:1');
    if (combined) {
      for (const args of [['--sha'], ['--sha', '--help'], ['--sha', 'deadbeef', '--unknown']]) {
        const invalid = invoke(subject.file, args, 2, 'RESOURCE_PROBE:0:0:0');
        assert.equal(invalid.stderr, usage);
      }
      invoke(subject.file, ['--sha', 'deadbeef'], 73, 'RESOURCE_PROBE:0:0:1');
    }
  });
}

test('existing package and combined callers select the explicit execution modes', () => {
  const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  for (const subject of cases.filter((item) => item.packageCommand)) {
    assert.equal(
      scripts[subject.packageCommand],
      `node scripts/${subject.file} --run`,
      subject.packageCommand,
    );
  }
  const combined = readFileSync(
    path.join(root, 'scripts/verify-outreach-v3-phase4-6-combined.mjs'),
    'utf8',
  );
  assert.match(combined, /'scripts\/verify-outreach-v3-phase6-code\.mjs', '--run'/u);
  const workflow = readFileSync(
    path.join(root, '.github/workflows/outreach-v3-phase4-6-combined.yml'),
    'utf8',
  );
  assert.match(workflow, /verify-outreach-v3-phase4-6-combined\.mjs --sha /u);
});
