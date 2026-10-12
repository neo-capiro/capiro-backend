import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ids = ['2', '3', '6', '7', '8', '9', '10', '11', '12-e2e'];
const trapSource = [
  "import cp from 'node:child_process';",
  "import { syncBuiltinESMExports } from 'node:module';",
  "cp.spawnSync = (command, args) => { process.stderr.write(`PHASE8_DB_CHILD:${command}:${args.join(',')}\\n`); return { status: 0 }; };",
  'syncBuiltinESMExports();',
].join('\n');
const trapUrl = `data:text/javascript,${encodeURIComponent(trapSource)}`;

function invoke(name, args) {
  return spawnSync(process.execPath, [
    '--import', trapUrl, path.join(root, 'scripts', name), ...args,
  ], { cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true });
}

for (const id of ids) {
  const name = `verify-phase8-session${id}-db.mjs`;
  test(`${name} requires an explicit disposable-DB run`, () => {
    for (const [args, expectedExit] of [[[], 2], [['--help'], 0], [['--unknown'], 2]]) {
      const result = invoke(name, args);
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, expectedExit, `${name} ${args}: ${result.stderr}`);
      assert.match(`${result.stdout}${result.stderr}`, /Usage:/);
      assert.doesNotMatch(result.stderr, /PHASE8_DB_CHILD:/, 'refusal started bash');
    }
    const run = invoke(name, ['--run']);
    assert.equal(run.error, undefined);
    assert.equal(run.signal, null);
    assert.equal(run.status, 0, `${name} --run: ${run.stderr}`);
    assert.match(run.stderr.replaceAll('\\', '/'),
      new RegExp(`PHASE8_DB_CHILD:bash:.*/verify-phase8-session${id}-db\\.sh`));
  });
}

test('package callers opt into the same wrappers', () => {
  const rootPackage = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const defensePackage = JSON.parse(readFileSync(path.join(root, 'apps/defense-api/package.json'), 'utf8'));
  for (const id of ids) {
    const key = id === '12-e2e' ? 'verify:phase8-session12:e2e:db' : `verify:phase8-session${id}:db`;
    assert.equal(rootPackage.scripts[key], `node scripts/verify-phase8-session${id}-db.mjs --run`);
  }
  for (const id of ['6', '7']) {
    assert.equal(defensePackage.scripts[`verify:session${id}:db`],
      `node ../../scripts/verify-phase8-session${id}-db.mjs --run`);
  }
});
