// Execute only the inspected pure guard and actual verifyMigrationGuard function.
// Shell text is data. No entrypoint, Prisma, subprocess, provider or module bootstrap.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('/workspace/capirov2/node_modules/typescript');
const repo = path.resolve(__dirname, '../../..');
const allowedPaths = ['scripts/entrypoint.sh', 'scripts/entrypoint-legacy.sh', 'scripts/entrypoint-dispatcher.inc'];
const snapshots = allowedPaths.map((p) => ({ path: p, source: fs.readFileSync(path.join(repo, 'apps/api', p), 'utf8') }));
const sourceHead = 'a96af2e1161def587d4ed9b6b79be7e5ff042c5b';
const sourceTree = '88a1aea62dbaaf4a8aa82086caa7c9aea511d8d7';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function pureGuard(source) {
  const result = { exports: {} };
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, {
    exports: result.exports, module: result,
    require(id) { assert.equal(id, 'node:crypto'); return crypto; },
  }, { timeout: 1000 });
  return result.exports;
}
function migrationFunction(source) {
  const ast = ts.createSourceFile('verify-pe-phase-a-safety.ts', source, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'verifyMigrationGuard');
  assert(fn);
  return fn.getText(ast);
}
function probe(fnSource, guard, sources) {
  let reads = 0;
  try {
    const code = ts.transpileModule(fnSource + '\nverifyMigrationGuard();', {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(code, {
      assert, assertNoMigrationHistoryMutation: guard.assertNoMigrationHistoryMutation,
      apiFile(p) {
        assert(allowedPaths.includes(p));
        reads += 1;
        return sources.find((s) => s.path === p).source;
      },
    }, { timeout: 1000 });
    return { accepted: true, snapshotReads: reads };
  } catch (e) {
    return { accepted: false, snapshotReads: reads, error: String(e.message || e) };
  }
}
const originalGuardSource = fs.readFileSync(path.join(__dirname, 'original-pe-migration-guards.ts'), 'utf8');
const originalPhaseSource = fs.readFileSync(path.join(__dirname, 'original-verify-pe-phase-a-safety.ts'), 'utf8');
const currentGuardSource = fs.readFileSync(path.join(repo, 'apps/api/scripts/lib/pe-migration-guards.ts'), 'utf8');
const currentPhaseSource = fs.readFileSync(path.join(repo, 'apps/api/scripts/verify-pe-phase-a-safety.ts'), 'utf8');
const before = pureGuard(originalGuardSource);
const after = pureGuard(currentGuardSource);
const beforeFn = migrationFunction(originalPhaseSource);
const afterFn = migrationFunction(currentPhaseSource);
const baseline = before.assertNoMigrationHistoryMutation(snapshots);
const current = after.assertNoMigrationHistoryMutation(snapshots);
assert.equal(baseline.ok, false);
assert.equal(current.ok, true);
const changes = [
  ['extra resolve inside a recognized operator arm', (s) => s.replace(
    '  migrate-resolve-applied)\n    shift',
    '  migrate-resolve-applied)\n    node ./node_modules/prisma/build/index.js migrate resolve --applied unexpected\n    shift')],
  ['obfuscated automatic resolve outside the operator arms', (s) => s.replace(
    '  migrate)\n',
    '  migrate)\n    eval "node ./node_modules/prisma/build/index.js migrate re""solve --applied unexpected"\n')],
];
const results = changes.map(([name, edit]) => {
  const mutated = snapshots.map((s) => ({ ...s, source: s.path === 'scripts/entrypoint.sh' ? edit(s.source) : s.source }));
  assert.notEqual(mutated[0].source, snapshots[0].source);
  const original = probe(beforeFn, before, mutated);
  const corrected = probe(afterFn, after, mutated);
  assert.equal(original.accepted, true, 'original substring/removal grammar must demonstrate the RED');
  assert.equal(corrected.accepted, false, 'closed canonical source must refuse');
  return { name, original, corrected, shellExecuted: false };
});
const actualPhaseA = probe(afterFn, after, snapshots);
assert.equal(actualPhaseA.accepted, true);
console.log(JSON.stringify({
  sourceHead, sourceTree, exactGuardSha256: sha(currentGuardSource),
  exactPhaseASha256: sha(currentPhaseSource), baselineHead: 'd70bb9724cf06dfee4863037d295942a9624b7ac',
  originalStrictCanonicalTrioRefusal: baseline, correctedCanonicalTrio: current,
  originalPhaseASourceConfinementReds: results, correctedActualPhaseAFunction: actualPhaseA,
  sourceTextsReadOnly: true, shellSourceExecuted: false, subprocessesInvoked: false,
  providerCalls: false, prismaCalled: false, nativeAcceptance: false,
}, null, 2));
