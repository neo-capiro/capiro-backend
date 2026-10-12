const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ts = require('/workspace/capirov2/node_modules/typescript');
const expect = require('/workspace/capirov2/apps/api/node_modules/expect').expect;
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
const corpus = [
  { name: 'canonical baseline', overrides: new Map(), expectAccepted: true },
  { name: 'type-only editor import disconnects runtime helper', overrides: new Map([[path.join(fixtureRoot, 'MemoryFileEditor.tsx.txt'), originalEditor.replace("import {\n  type MemoryFileDef,", "import type {\n  type MemoryFileDef,")]]), expectAccepted: false },
  { name: 'type-only pending import disconnects runtime headline', overrides: new Map([[path.join(fixtureRoot, 'PendingMemoryReviewPanel.tsx.txt'), originalPanel.replace('import {\n  activeMemoryReviewExplanation,', 'import type {\n  activeMemoryReviewExplanation,')]]), expectAccepted: false },
  { name: 'inert nested JSX holds marker while real panel returns null', overrides: new Map([[path.join(fixtureRoot, 'PendingMemoryReviewPanel.tsx.txt'), inertPanel]]), expectAccepted: false },
];
const results = corpus.map(row => {
  for (const [file, text] of row.overrides) assert.notEqual(text, fs.readFileSync(file, 'utf8'), row.name + ' mutation did not apply');
  const result = evaluate(row.overrides);
  return { name: row.name, expectedAccepted: row.expectAccepted, ...result, pass: result.accepted === row.expectAccepted, mutatedSourceExecuted: false };
});
const receipt = { source: '2322ed5f9d467e83eaa49b331921f981dc342eaf', specSha256: crypto.createHash('sha256').update(originalSpec).digest('hex'), actualSelectedCase: chosen, results, sourceOverridesOpaqueOnly: true, frontendRuntimeExecuted: false, sqlExecuted: false };
fs.writeFileSync(path.join(__dirname, 'reader-opaque-overrides.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));
assert.ok(results.every(row => row.pass), 'Source-contract refusals escaped');
