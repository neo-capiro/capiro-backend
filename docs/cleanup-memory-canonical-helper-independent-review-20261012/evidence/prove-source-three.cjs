const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ts = require('/workspace/capirov2/node_modules/typescript');
const root = path.resolve(__dirname, '../../..');
const base = '277053c8196dc1be4789c42ea304b0de0553fe00';
const source = '1f285e2a8c3d377c0e660eecb64e62ad30cc83bf';
const git = (...args) => cp.execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const prefix = 'apps/api/scripts/lib/__fixtures__/legacy-ui-contracts/src/components/';
const reader = 'apps/api/scripts/lib/memory-admin-self-approval-contract.spec.ts';
const wanted = [reader, prefix + 'memory-file-editor-shared.ts.txt', prefix + 'pending-memory-review-shared.ts.txt'].sort();
assert.deepEqual(git('diff', '--name-only', base, source, '--', ':!docs').toString().trim().split('\n').sort(), wanted);
const rows = [];
for (const file of ['memory-file-editor-shared.ts', 'pending-memory-review-shared.ts']) {
  const fixture = prefix + file + '.txt';
  const current = 'apps/web/src/components/' + file;
  const bytes = git('show', source + ':' + fixture);
  for (const ref of [base, source, '1e99f0921b207318c6d2abf03927b5c4daa5768b', '193703e34f2bedbb69d87d6a8ee303f65ab8dbda', '67fa9255b8a73f489d7a57c8fe270ed6d03fa016']) assert.ok(bytes.equals(git('show', ref + ':' + current)), current + ' ' + ref);
  rows.push({ fixture, canonicalCurrentSource: current, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), entry: git('ls-tree', source, '--', fixture).toString().trim() });
}
function cases(ref) {
  const text = git('show', ref + ':' + reader).toString();
  const tree = ts.createSourceFile('reader.ts', text, ts.ScriptTarget.Latest, true);
  assert.equal(tree.parseDiagnostics.length, 0);
  const rows = [];
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'it') {
      assert.ok(ts.isStringLiteral(node.arguments[0]));
      rows.push({ name: node.arguments[0].text, text: node.getText(tree) });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return rows;
}
const before = cases(base), after = cases(source);
assert.equal(before.length, 7); assert.deepEqual(after.map(row => row.name), before.map(row => row.name));
const changedName = 'removes the independent-approver claim from every active shared-memory UI surface';
for (let i = 0; i < before.length; i++) if (before[i].name !== changedName) assert.equal(after[i].text, before[i].text);
const oldCase = before.find(row => row.name === changedName).text;
const newCase = after.find(row => row.name === changedName).text;
for (const expression of ["expect(editor).not.toContain('Submitted for independent review');", "expect(pendingPanel).not.toContain('independent reviewer');", "expect(reviewInbox).toContain('authorized administrator or reviewer approves it');", "expect(reviewInbox).not.toContain('independent reviewer approves it');"]) assert.ok(oldCase.includes(expression) && newCase.includes(expression));
assert.ok(newCase.includes("expect(editorShared).toContain('Submitted for approval');") && newCase.includes("expect(pendingShared).toContain('Waiting for approval');"));
const apiPackage = JSON.parse(git('show', base + ':apps/api/package.json'));
assert.equal(apiPackage.devDependencies.typescript, '^5.5.4');
const entries = ref => new Map(git('ls-tree', '-rz', ref).toString().split('\0').filter(Boolean).map(row => { const [entry, file] = row.split('\t'); return [file, entry]; }));
const original = entries(base), next = entries(source);
let exactOutside = 0, schema = 0, oldDocs = 0;
for (const [file, entry] of original) {
  if (!wanted.includes(file)) { assert.equal(next.get(file), entry, file); exactOutside++; }
  if (file.startsWith('docs/')) oldDocs++;
  if (file.includes('/migrations/') || file.endsWith('/schema.prisma')) { assert.equal(next.get(file), entry); schema++; }
}
assert.ok(git('show', source + ':' + reader).equals(fs.readFileSync(path.join(root, reader))));
const result = { base, source, sourceTree: git('rev-parse', source + '^{tree}').toString().trim(), codePaths: wanted, fixtureBindings: rows, originalSevenCaseNamesUnchanged: true, otherSixCaseBodiesExact: true, oldFourWordCaseControlAssertionsExact: true, onlyTwoPositiveOwnerRelocations: true, addedFiniteOpaqueGrammarChecks: true, baselineEntriesOutsideThreeExact: exactOutside, oldDocsExact: oldDocs, schemaMigrationPredicatePathsExact: schema, dependencyChange: false, apiTypeScriptDeclared: '^5.5.4', cachedParserVersion: ts.version, frontendSourceChanged: false, backendAuthorityChanged: false, protectedReportingBodyReadByGitProof: false, sqlExecuted: false };
fs.writeFileSync(path.join(__dirname, 'SOURCE-THREE.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ source, sourceTree: result.sourceTree, threeCodePaths: wanted.length, fixtureBindings: rows.length, unchangedCases: 6, unchangedNames: 7, exactOutside, schema, oldDocs }));
