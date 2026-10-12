const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ts = require('/workspace/capirov2/node_modules/typescript');
const expect = require('/workspace/capirov2/node_modules/.pnpm/expect@29.7.0/node_modules/expect').expect;
const root = path.resolve(__dirname, '../../..');
const api = path.join(root, 'apps/api');
const specFile = path.join(api, 'scripts/lib/memory-admin-self-approval-contract.spec.ts');
const fixtureRoot = path.join(api, 'scripts/lib/__fixtures__/legacy-ui-contracts/src/components');
const originalSpec = fs.readFileSync(specFile, 'utf8');
const emitted = ts.transpileModule(originalSpec, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const originalEditor = fs.readFileSync(path.join(fixtureRoot, 'MemoryFileEditor.tsx.txt'), 'utf8');
const originalPanel = fs.readFileSync(path.join(fixtureRoot, 'PendingMemoryReviewPanel.tsx.txt'), 'utf8');
const chosen = 'removes the independent-approver claim from every active shared-memory UI surface';
function evaluate(overrides) {
  const cases = [];
  const mockedFs = { ...fs, readFileSync(file, encoding) {
    const resolved = path.resolve(file);
    assert.ok(!resolved.includes('/apps/web/') && !resolved.endsWith('/engagement/engagement.service.ts'));
    if (overrides.has(resolved)) { const value = overrides.get(resolved); return encoding ? value : Buffer.from(value); }
    return fs.readFileSync(file, encoding);
  } };
  const requireFake = name => {
    if (name === 'node:fs') return mockedFs;
    if (name === 'node:path') return path;
    if (name === 'typescript') return ts;
    if (name === '@jest/globals') return { describe: (_name, run) => run(), it: (name, run) => cases.push({ name, run }), expect };
    throw new Error('Unexpected contract collaborator: ' + name);
  };
  new Function('exports', 'require', 'process', emitted)({}, requireFake, { cwd: () => api });
  const selected = cases.filter(row => row.name === chosen);
  assert.equal(selected.length, 1);
  try { selected[0].run(); return { accepted: true }; } catch (error) { return { accepted: false, errorName: error.name, message: error.message }; }
}
const panelTree = ts.createSourceFile('panel.tsx', originalPanel, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const panel = panelTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'PendingMemoryReviewPanel');
const returned = panel.body.statements.find(node => ts.isReturnStatement(node));
assert.ok(returned?.expression);
const inertPanel = originalPanel.slice(0, returned.getStart(panelTree)) + 'const inertUnusedRender = () => ' + returned.expression.getText(panelTree) + ';\nreturn null;' + originalPanel.slice(returned.end);
function typeOnlySpecifier(text, file, module, name) {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imported = tree.statements.find(node => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === module);
  const entry = imported.importClause.namedBindings.elements.find(node => node.name.text === name);
  return text.slice(0, entry.getStart(tree)) + 'type ' + text.slice(entry.getStart(tree));
}
function deferredImport(text, file, module) {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imported = tree.statements.find(node => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === module);
  const start = imported.getStart(tree) + 'import '.length;
  const mutated = text.slice(0, start) + 'defer ' + text.slice(start);
  assert.equal(ts.createSourceFile(file, mutated, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX).parseDiagnostics.length, 0);
  return mutated;
}
const editorTree = ts.createSourceFile('editor.tsx', originalEditor, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = editorTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'MemoryFileEditor');
const mutationDecl = component.body.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => ts.isIdentifier(node.name) && node.name.text === 'saveMutation');
const mutationObject = mutationDecl.initializer.arguments[0];
const prefix = originalEditor.slice(0, mutationObject.end - 1);
const computedOverride = prefix + (prefix.trimEnd().endsWith(',') ? '' : ',') + "\n['on' + 'Success']: () => undefined,\n" + originalEditor.slice(mutationObject.end - 1);
assert.equal(ts.createSourceFile('editor.tsx', computedOverride, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX).parseDiagnostics.length, 0);
const corpus = [
  { name: 'canonical baseline', overrides: new Map(), expectAccepted: true },
  { name: 'type-only editor import disconnects runtime helper', overrides: new Map([[path.join(fixtureRoot, 'MemoryFileEditor.tsx.txt'), typeOnlySpecifier(originalEditor, 'editor.tsx', './memory-file-editor-shared.js', 'settingsMemorySuccessMessage')]]), expectAccepted: false },
  { name: 'type-only pending import disconnects runtime headline', overrides: new Map([[path.join(fixtureRoot, 'PendingMemoryReviewPanel.tsx.txt'), typeOnlySpecifier(originalPanel, 'panel.tsx', './pending-memory-review-shared.js', 'pendingReviewHeadline')]]), expectAccepted: false },
  { name: 'inert nested JSX holds marker while real panel returns null', overrides: new Map([[path.join(fixtureRoot, 'PendingMemoryReviewPanel.tsx.txt'), inertPanel]]), expectAccepted: false },
  { name: 'computed later onSuccess override disconnects preserved callback', overrides: new Map([[path.join(fixtureRoot, 'MemoryFileEditor.tsx.txt'), computedOverride]]), expectAccepted: false },
  { name: 'deferred editor import is not ordinary runtime binding', overrides: new Map([[path.join(fixtureRoot, 'MemoryFileEditor.tsx.txt'), deferredImport(originalEditor, 'editor.tsx', './memory-file-editor-shared.js')]]), expectAccepted: false },
  { name: 'deferred panel import is not ordinary runtime binding', overrides: new Map([[path.join(fixtureRoot, 'PendingMemoryReviewPanel.tsx.txt'), deferredImport(originalPanel, 'panel.tsx', './pending-memory-review-shared.js')]]), expectAccepted: false },
  { name: 'top-level assignment disconnects imported helper', overrides: new Map([[path.join(fixtureRoot, 'MemoryFileEditor.tsx.txt'), originalEditor + "\nsettingsMemorySuccessMessage = () => 'Saved';\n"]]), expectAccepted: false },
  { name: 'local helper shadow is refused', overrides: new Map([[path.join(fixtureRoot, 'MemoryFileEditor.tsx.txt'), originalEditor.replace('const saveMutation = useMutation', "const settingsMemorySuccessMessage = () => 'Saved';\n  const saveMutation = useMutation")]]), expectAccepted: false },
];
const results = corpus.map(row => {
  for (const [file, text] of row.overrides) assert.notEqual(text, fs.readFileSync(file, 'utf8'), row.name + ' mutation did not apply');
  const result = evaluate(row.overrides);
  return { name: row.name, expectedAccepted: row.expectAccepted, ...result, pass: result.accepted === row.expectAccepted, mutatedSourceExecuted: false };
});
const receipt = { source: '8048a314ecedc605f565f4650152b45b3454c07d', specSha256: crypto.createHash('sha256').update(originalSpec).digest('hex'), actualSelectedCase: chosen, results, sourceOverridesOpaqueOnly: true, frontendRuntimeExecuted: false, sqlExecuted: false };
fs.writeFileSync(path.join(__dirname, 'reader-opaque-overrides.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));
assert.ok(results.every(row => row.pass), 'Source-contract refusals escaped');
