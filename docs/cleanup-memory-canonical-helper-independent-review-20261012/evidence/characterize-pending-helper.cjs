const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ts = require('/workspace/capirov2/node_modules/typescript');
const source = '277053c8196dc1be4789c42ea304b0de0553fe00';
const file = 'apps/web/src/components/pending-memory-review-shared.ts';
const root = path.resolve(__dirname, '../../..');
const bytes = cp.execFileSync('git', ['show', source + ':' + file], { cwd: root });
const ast = ts.createSourceFile(file, bytes.toString(), ts.ScriptTarget.Latest, true);
assert.equal(ast.parseDiagnostics.length, 0);
assert.equal(ast.statements.filter(statement => ts.isImportDeclaration(statement)).length, 0);
const emitted = ts.transpileModule(bytes.toString(), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const namespace = {};
new Function('exports', 'require', emitted)(namespace, () => { throw new Error('Pure helper unexpectedly imported runtime collaborator'); });
const helper = namespace.pendingReviewHeadline;
const cases = [
  ['blocked pending review', { status: 'pending_review', blocked: true }, 'Review blocked'],
  ['unblocked pending review', { status: 'pending_review', blocked: false }, 'Waiting for approval'],
  ['absent blocked flag', { status: 'pending_review' }, 'Waiting for approval'],
  ['inherited blocked flag remains existing runtime behavior', Object.create({ blocked: true }), 'Review blocked'],
  ['null-prototype unblocked input', Object.assign(Object.create(null), { blocked: false }), 'Waiting for approval'],
  ['truthy nonboolean remains existing runtime behavior', { blocked: 'false' }, 'Review blocked'],
];
const rows = [];
for (const [name, input, expected] of cases) { const actual = helper(input); assert.equal(actual, expected); rows.push({ name, expected, actual }); }
let reads = 0;
assert.equal(helper({ get blocked() { reads++; return true; } }), 'Review blocked');
assert.equal(reads, 1); rows.push({ name: 'blocked getter read once', reads, actual: 'Review blocked' });
const sentinel = new Error('synthetic blocked getter failure');
assert.throws(() => helper({ get blocked() { throw sentinel; } }), error => error === sentinel);
rows.push({ name: 'blocked getter exception identity preserved in same realm', pass: true });
for (const value of [undefined, null]) { assert.throws(() => helper(value), TypeError); rows.push({ name: String(value) + ' preserves original TypeError', pass: true }); }
const result = { source, file, sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex'), compilerVersion: ts.version, emittedSha256: crypto.createHash('sha256').update(emitted).digest('hex'), hardcodedBeforeExpectations: true, cases: rows, runtimeImports: 0, frontendUiExecuted: false, authorityPolicyChanged: false, nativeDatabaseExecuted: false };
fs.writeFileSync(path.join(__dirname, 'pending-helper-before.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ source, beforeCases: rows.length, allPass: true, runtimeImports: 0 }));
