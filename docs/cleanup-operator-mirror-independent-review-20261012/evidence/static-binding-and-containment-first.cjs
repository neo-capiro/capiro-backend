const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('/workspace/capirov2/node_modules/typescript');
const base = '6a4b48e6286a270ab18c033eb4ccaf6f72f42c70';
const source = 'aaea904f9d16df38ef57bc1d668a2b06f8d0fd14';
const authorEvidence = '9736f1deb9f2154a9f29545a73c1be4e0494d77d';
const packet = 'docs/cleanup-operator-mirror-repair-20261012/';
const git = (...args) => execFileSync('git', args);
const read = (p) => fs.readFileSync(p);
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
const blob = (revision, file) => git('show', revision + ':' + file);
const gitTree = (revision, dir) => git('rev-parse', revision + ':' + dir).toString().trim();
const index = JSON.parse(blob(authorEvidence, packet + 'SHA256.json'));
assert.equal(index.files.length, 12);
assert.equal(new Set(index.files.map((r) => r.path)).size, 12);
for (const row of index.files) assert.equal(hash(blob(authorEvidence, row.path)), row.sha256, row.path);
const authorChanged = git('diff', '--name-only', source, authorEvidence).toString().trim().split('\n');
assert.equal(authorChanged.length, 13);
assert(authorChanged.every((p) => p.startsWith(packet)));
const names = ['phase6-stage-cycle.ts', 'plan-defense-budget-promotion-v1.ts', 'status-defense-budget-promotion-v1.ts'];
const dependencies = [];
const mutationChecks = [];
for (const name of names) {
  const original = 'apps/api/scripts/' + name;
  const mirror = 'apps/defense-api/runtime-source/operators/' + name;
  const canonical = blob(base, original);
  assert.deepEqual(read(original), canonical);
  assert.deepEqual(read(mirror), canonical);
  assert.deepEqual(blob(source, original), canonical);
  const sf = ts.createSourceFile(original, canonical.toString(), ts.ScriptTarget.Latest, true);
  const old = ts.createSourceFile(mirror, blob(base, mirror).toString(), ts.ScriptTarget.Latest, true);
  assert.equal(sf.parseDiagnostics.length, 0);
  const imports = sf.statements.filter(ts.isImportDeclaration);
  assert.deepEqual(imports.map((n) => n.getText(sf)), old.statements.filter(ts.isImportDeclaration).map((n) => n.getText(old)));
  const frozenEquality = (s, m) => s.equals(canonical) && m.equals(canonical);
  for (const [kind, s, m] of [
    ['old mirror', canonical, blob(base, mirror)],
    ['mirror one byte', canonical, Buffer.concat([canonical, Buffer.from('\n')])],
    ['both copies changed equally', Buffer.concat([canonical, Buffer.from('\n')]), Buffer.concat([canonical, Buffer.from('\n')])],
    ['line ending change', canonical, Buffer.from(canonical.toString().replace(/\n/g, '\r\n'))],
    ['new import', canonical, Buffer.concat([Buffer.from("import 'unreviewed';\n"), canonical])],
  ]) {
    assert.equal(frozenEquality(s, m), false);
    mutationChecks.push({ file: name, kind, rejected: true });
  }
  for (const imported of imports) {
    const specifier = imported.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;
    const target = path.normalize(path.join(path.dirname(original), specifier)).replace(/\.js$/, '.ts');
    const mapped = target.replace('apps/api/src/', 'apps/defense-api/runtime-source/');
    assert(target.startsWith('apps/api/src/defense-budget/'));
    assert.deepEqual(read(target), blob(base, target));
    assert.deepEqual(read(mapped), read(target));
    assert.deepEqual(blob(source, mapped), read(target));
    dependencies.push({ operator: name, specifier, canonicalTarget: target, mirrorTarget: mapped,
      sha256: hash(read(target)), unchangedAndByteEqual: true });
  }
}
assert.equal(dependencies.length, 8);
const protectedPaths = ['apps/defense-api/runtime-source/README.md', 'apps/defense-api/tsconfig.json',
  'apps/defense-api/nest-cli.json', 'apps/defense-api/Dockerfile', 'apps/defense-api/package.json',
  'apps/defense-api/src/runtime/phase1-7-runtime.manifest.ts', 'apps/defense-api/src/runtime/phase1-7-runtime.adapters.ts',
  'scripts/verify-phase8-session4.mjs'];
const protectedSources = protectedPaths.map((p) => {
  assert.deepEqual(read(p), blob(base, p));
  assert.deepEqual(read(p), blob(source, p));
  return { path: p, sha256: hash(read(p)), unchanged: true };
});
assert.deepEqual(JSON.parse(read('apps/defense-api/tsconfig.json')).include, ['src/**/*.ts']);
assert.equal(JSON.parse(read('apps/defense-api/tsconfig.json')).compilerOptions.rootDir, 'src');
assert.equal(JSON.parse(read('apps/defense-api/nest-cli.json')).sourceRoot, 'src');
const docker = read('apps/defense-api/Dockerfile').toString();
assert(!docker.includes('runtime-source'));
assert(docker.includes('COPY apps/defense-api/src apps/defense-api/src'));
assert(docker.includes('/workspace/apps/defense-api/dist'));
const verifier = read('scripts/verify-phase8-session4.mjs').toString();
for (const name of names) assert(verifier.includes("['apps/api/scripts/" + name + "', 'apps/defense-api/runtime-source/operators/" + name + "']"));
assert(verifier.includes('read(source) !== read(mirror)'));
const tree = gitTree(source, 'apps/api/src/defense-budget');
assert.equal(tree, '49a033881715fb1102e8941c9895664f585efae2');
assert.equal(tree, gitTree(base, 'apps/api/src/defense-budget'));
assert.equal(tree, gitTree(source, 'apps/defense-api/runtime-source/defense-budget'));
assert.equal(gitTree(base, 'apps/defense-api/src'), gitTree(source, 'apps/defense-api/src'));
const manifest = read('apps/defense-api/src/runtime/phase1-7-runtime.manifest.ts').toString();
const historicalManifestTree = /defenseBudget: \{[\s\S]*?gitTreeSha: '([a-f0-9]{40})'/.exec(manifest)[1];
assert.equal(historicalManifestTree, 'dba0990b9506e4079a9cc44c4892b063f1260d04');
assert.notEqual(historicalManifestTree, tree);
const srcFiles = git('ls-tree', '-r', '--name-only', source, '--', 'apps/defense-api/src').toString().trim().split('\n').filter((p) => p.endsWith('.ts'));
const staticOperatorReferences = [];
for (const file of srcFiles) {
  const sf = ts.createSourceFile(file, read(file).toString(), ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    // Inspect string literals in import/export/require/import() operands and
    // other literal references; fixture roots are allowed, operator paths are absent.
    if (ts.isStringLiteral(node) && (node.text.includes('runtime-source/operators') || names.some((name) => node.text.includes(name)))) staticOperatorReferences.push({ file, value: node.text });
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
assert.equal(staticOperatorReferences.length, 0);
assert.deepEqual(read('docs/cleanup-operator-mirror-independent-review-20261012/evidence/author-inert-operator-source.test.mjs'), blob(authorEvidence, packet + 'evidence/inert-operator-source.test.mjs'));
const firstLog = blob(authorEvidence, packet + 'evidence/inert-operator-source-first.log').toString();
assert(firstLog.includes('# fail 1'));
console.log(JSON.stringify({ base, source, sourceTree: '41b8827051bac6d2c1ef4650798c8cdc330d5353',
  authorEvidence, authorEvidenceTree: git('rev-parse', authorEvidence + '^{tree}').toString().trim(),
  authorDocOnlyPaths: authorChanged.length, authorPacketHashesVerified: index.files.length,
  protectedSources, dependencies, directLocalTargets: dependencies.length,
  exactSourceMutationRefusals: mutationChecks, unchangedDefenseBudgetSourceAndMirrorTree: tree,
  unchangedCompiledDefenseSrcTree: gitTree(source, 'apps/defense-api/src'),
  compiledSrcTsFilesInspected: srcFiles.length, staticOperatorLiteralReferences: staticOperatorReferences,
  historicalManifestTree, historicalManifestMatchesActualTree: false,
  inheritedManifestQualification: 'Unchanged descriptor is older than actual source/mirror trees; no manifest provenance reconciliation is claimed by this three-mirror repair.',
  mirrorResolutionQualification: 'Verbatim ../src imports are archived source-parity paths, not standalone relocated operators. Mirrors are outside src include/sourceRoot and Docker COPY.',
  authorInitialFailedFixtureBytesPreserved: true,
  actualSession4VerifierOrProductionDependenciesOrNativeOperationsExecuted: false,
}, null, 2));
