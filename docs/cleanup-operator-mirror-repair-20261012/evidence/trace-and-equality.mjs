import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const ts = createRequire('/workspace/capirov2/package.json')('typescript');
const root = process.cwd();
const base = '6a4b48e6286a270ab18c033eb4ccaf6f72f42c70';
const names = ['phase6-stage-cycle.ts', 'plan-defense-budget-promotion-v1.ts', 'status-defense-budget-promotion-v1.ts'];
const blobs = ['d9a82728dc01bd0b48a92580ab581b13ff19bec8', 'c5be25e428397dcf41c10a6cadba0bd6ca3ae2df', 'd36871ae5ce879f59b941f6ab5eb1c944ab0dec8'];
const oldBlobs = ['9bd1bb63da4397b35f347af2ea945b1bcb3c8df5', '94fef129178ecfd4c5118e6ae17a7bab5ac23e55', 'de5426ebfa605340f52334003f18ad691f1df2df'];
const git = (...args) => execFileSync('git', args, { cwd: root });
const read = (file) => readFileSync(path.join(root, file));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const imports = (file, text) => {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  assert.equal(sf.parseDiagnostics.length, 0, file);
  return sf.statements.filter(ts.isImportDeclaration).map((node) => ({ specifier: node.moduleSpecifier.text, declaration: node.getText(sf) }));
};
const pairs = names.map((name, index) => {
  const source = 'apps/api/scripts/' + name;
  const mirror = 'apps/defense-api/runtime-source/operators/' + name;
  const canonical = read(source);
  const actual = read(mirror);
  const frozen = git('show', base + ':' + source);
  assert(canonical.equals(frozen), 'canonical script changed: ' + source);
  assert.equal(git('rev-parse', base + ':' + source).toString().trim(), blobs[index]);
  assert.equal(git('rev-parse', base + ':' + mirror).toString().trim(), oldBlobs[index]);
  const sourceImports = imports(source, canonical.toString());
  const oldImports = imports(mirror, git('show', base + ':' + mirror).toString());
  const mirrorImports = imports(mirror, actual.toString());
  assert.deepEqual(sourceImports, oldImports, 'repair would add/change imports');
  assert.deepEqual(mirrorImports, oldImports, 'mirror import drift');
  const targets = sourceImports.filter(({ specifier }) => specifier.startsWith('.')).map(({ specifier }) => {
    const canonicalTarget = path.normalize(path.join(path.dirname(source), specifier)).replace(/\.js$/, '.ts');
    assert(canonicalTarget.startsWith('apps/api/src/defense-budget/'));
    const mirroredTarget = canonicalTarget.replace('apps/api/src/', 'apps/defense-api/runtime-source/');
    assert(read(canonicalTarget).equals(read(mirroredTarget)), 'unmirrored canonical dependency: ' + canonicalTarget);
    const verbatimRelativePath = path.normalize(path.join(path.dirname(mirror), specifier)).replace(/\.js$/, '.ts');
    return { specifier, canonicalTarget, mirroredTarget, sha256: sha(read(canonicalTarget)), verbatimRelativePath,
      qualification: 'Source-parity operator copies retain original imports. They are outside compiled/runtime image scope and are not relocated executable entrypoints.' };
  });
  return { source, mirror, canonicalBlob: blobs[index], originalMirrorBlob: oldBlobs[index], canonicalSha256: sha(canonical), mirrorSha256: sha(actual), equal: canonical.equals(actual), imports: sourceImports, targets };
});
const protectedPaths = ['apps/defense-api/runtime-source/README.md', 'apps/defense-api/tsconfig.json', 'apps/defense-api/nest-cli.json',
  'apps/defense-api/Dockerfile', 'apps/defense-api/package.json', 'apps/defense-api/src/runtime/phase1-7-runtime.manifest.ts',
  'apps/defense-api/src/runtime/phase1-7-runtime.adapters.ts', 'scripts/verify-phase8-session4.mjs'];
const protectedSources = protectedPaths.map((file) => {
  assert(read(file).equals(git('show', base + ':' + file)), 'containment source changed: ' + file);
  return { path: file, sha256: sha(read(file)), preserved: true };
});
const tree = git('rev-parse', base + ':apps/api/src/defense-budget').toString().trim();
assert.equal(tree, git('rev-parse', base + ':apps/defense-api/runtime-source/defense-budget').toString().trim());
const tsconfig = JSON.parse(read('apps/defense-api/tsconfig.json'));
assert.deepEqual(tsconfig.include, ['src/**/*.ts']);
assert.equal(tsconfig.compilerOptions.rootDir, 'src');
assert.equal(JSON.parse(read('apps/defense-api/nest-cli.json')).sourceRoot, 'src');
const docker = read('apps/defense-api/Dockerfile').toString();
assert(!docker.includes('runtime-source'));
const verifier = read('scripts/verify-phase8-session4.mjs').toString();
for (const pair of pairs) assert(verifier.includes(`['${pair.source}', '${pair.mirror}']`), 'missing mandatory blob pair');
assert(verifier.includes('read(source) !== read(mirror)'));
const result = { source: base, sourceTree: 'f14d6fa3f191645839414972063e1057fce557bf', pairs, unchangedDefenseBudgetTree: tree,
  protectedSources, directMappedTargets: pairs.reduce((n, pair) => n + pair.targets.length, 0), addedImports: 0,
  driftCount: pairs.filter((pair) => !pair.equal).length, actualSession4VerifierExecuted: false, productionModulesLoaded: false,
  providerDatabaseNativeDockerOperations: false };
const file = process.argv.includes('--baseline') ? 'baseline-three-drift-red.json' : 'repaired-trace-green.json';
writeFileSync(new URL(file, import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ file, driftCount: result.driftCount, directMappedTargets: result.directMappedTargets, addedImports: 0,
  unchangedDefenseBudgetTree: tree, canonicalAndContainmentSourcesPreserved: true, actualSession4VerifierExecuted: false }));
if (result.driftCount !== 0) process.exitCode = 1;
