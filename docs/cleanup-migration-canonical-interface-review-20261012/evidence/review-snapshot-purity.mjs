import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const compiler = createRequire(import.meta.url)('typescript');
const source = readFileSync('apps/api/scripts/lib/pe-migration-guards.ts', 'utf8');
const helper = {};
vm.runInNewContext(compiler.transpileModule(source, {
  compilerOptions: { module: compiler.ModuleKind.CommonJS, target: compiler.ScriptTarget.ES2022 },
}).outputText, {
  exports: helper,
  require: (name) => { assert.equal(name, 'node:crypto'); return { createHash }; },
});
const original = ['scripts/entrypoint.sh', 'scripts/entrypoint-legacy.sh', 'scripts/entrypoint-dispatcher.inc']
  .map((path) => ({ path, source: readFileSync('apps/api/' + path, 'utf8') }));
const copy = () => original.map((snap) => ({ ...snap }));
const results = [];
function control(name, fn) { fn(); results.push({ name, passed: true }); }
for (const name of ['inspectApprovedManualMigrationEntrypoints', 'assertNoMigrationHistoryMutation']) {
  const check = helper[name];
  control(name + ': getter fields sampled once; subsequent calls revalidate', () => {
    const counts = original.map(() => ({ path: 0, source: 0 }));
    const snapshots = original.map((snap, index) => ({
      get path() { return ++counts[index].path === 1 ? snap.path : 'unreviewed.sh'; },
      get source() { return ++counts[index].source === 1 ? snap.source : 'node prisma migrate resolve --applied unreviewed\n'; },
    }));
    assert.equal(check(snapshots).ok, true);
    assert.deepEqual(counts, original.map(() => ({ path: 1, source: 1 })));
    assert.equal(check(snapshots).ok, false);
  });
  control(name + ': frozen input remains unchanged', () => {
    const snapshots = Object.freeze(copy().map(Object.freeze));
    assert.equal(check(snapshots).ok, true);
    assert.equal(JSON.stringify(snapshots), JSON.stringify(original));
  });
  control(name + ': rejected source and result mutation do not poison later checks', () => {
    const changed = copy();
    changed[0].source += '# changed\n';
    const bad = check(changed);
    assert.equal(bad.ok, false);
    bad.findings.splice(0);
    bad.ok = true;
    assert.equal(check(changed).ok, false);
    assert.equal(check(copy()).ok, true);
    assert.equal(check(changed).ok, false);
    assert.equal(check(copy()).ok, true);
  });
}
control('dedicated inspector refuses an empty envelope', () => assert.equal(helper.inspectApprovedManualMigrationEntrypoints([]).ok, false));
control('generic empty list retains original strict-scan semantics without attesting manual policy', () => assert.equal(helper.assertNoMigrationHistoryMutation([]).ok, true));
control('prototype-looking unknown path cannot grant an operator exception', () => {
  for (const path of ['__proto__', 'constructor', 'toString'])
    assert.equal(helper.assertNoMigrationHistoryMutation([{ path, source: original[0].source }]).ok, false);
});
const receipt = {
  source: 'a96af2e1161def587d4ed9b6b79be7e5ff042c5b',
  cases: results.length, results,
  claims: 'synchronous primitive capture and pure result/input behavior; not runtime operator concurrency exclusion',
  shellMutantsExecuted: false, nativeOperations: false,
};
writeFileSync(new URL('snapshot-purity-review.json', import.meta.url), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ cases: results.length, passed: results.length, source: receipt.source, nativeOperations: false }, null, 2));
