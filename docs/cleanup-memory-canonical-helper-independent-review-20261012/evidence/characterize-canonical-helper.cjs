const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ts = require('/workspace/capirov2/node_modules/typescript');
const root = path.resolve(__dirname, '../../..');
const source = '277053c8196dc1be4789c42ea304b0de0553fe00';
const file = 'apps/web/src/components/memory-file-editor-shared.ts';
const bytes = cp.execFileSync('git', ['show', source + ':' + file], { cwd: root });
const ast = ts.createSourceFile(file, bytes.toString(), ts.ScriptTarget.Latest, true);
assert.equal(ast.parseDiagnostics.length, 0);
for (const statement of ast.statements) if (ts.isImportDeclaration(statement)) assert.equal(statement.importClause?.isTypeOnly, true);
const emitted = ts.transpileModule(bytes.toString(), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exportsObject = {};
new Function('exports', 'require', emitted)(exportsObject, () => { throw new Error('Pure helper unexpectedly imported a runtime collaborator'); });
const helper = exportsObject.settingsMemorySuccessMessage;
assert.equal(typeof helper, 'function');
const cases = [
  ['pending shared proposal', { status: 'pending_review', candidateId: 'synthetic', activeItemUnchanged: true }, 'Submitted for approval'],
  ['immediate personal save', { ok: true, updatedAt: 'synthetic' }, 'Saved'],
  ['absent status', {}, 'Saved'],
  ['undefined status', { status: undefined }, 'Saved'],
  ['unrecognized runtime status', { status: 'not-canonical' }, 'Saved'],
  ['inherited status remains existing runtime behavior', Object.create({ status: 'pending_review' }), 'Submitted for approval'],
  ['null-prototype status', Object.assign(Object.create(null), { status: 'pending_review' }), 'Submitted for approval'],
];
const rows = [];
for (const [name, input, expected] of cases) { const actual = helper(input); assert.equal(actual, expected); rows.push({ name, expected, actual }); }
let reads = 0;
assert.equal(helper({ get status() { reads++; return 'pending_review'; } }), 'Submitted for approval');
assert.equal(reads, 1);
rows.push({ name: 'status getter read once', reads, actual: 'Submitted for approval' });
const sentinel = new Error('synthetic getter failure');
assert.throws(() => helper({ get status() { throw sentinel; } }), error => error === sentinel);
rows.push({ name: 'getter exception identity propagated in same realm', pass: true });
for (const value of [undefined, null]) {
  assert.throws(() => helper(value), TypeError);
  rows.push({ name: String(value) + ' preserves original TypeError', pass: true });
}
const result = { source, file, sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex'), compilerVersion: ts.version, emittedSha256: crypto.createHash('sha256').update(emitted).digest('hex'), hardcodedBeforeExpectations: true, cases: rows, runtimeImports: 0, frontendUiExecuted: false, authorityPolicyChanged: false, nativeDatabaseExecuted: false };
fs.writeFileSync(path.join(__dirname, 'canonical-helper-before.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ source, beforeCases: rows.length, allPass: true, runtimeImports: 0 }));
