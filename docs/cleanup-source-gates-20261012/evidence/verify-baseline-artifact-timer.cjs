// Inert mechanism probe: execute only the unchanged baseline timer statement.
// Does not run a component, original test, real timer, download, or transport.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('/workspace/capirov2-cleanup-source-gates/node_modules/typescript');
const file = 'apps/web/src/components/chat/meri-artifact-download.ts';
const baseline = '4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace';
const repaired = 'a0947f47ff8146cd986dd23b5e95d489aba855cf';
const before = execFileSync('git', ['show', `${baseline}:${file}`]);
const after = execFileSync('git', ['show', `${repaired}:${file}`]);
assert.deepEqual(after, before);
const ast = ts.createSourceFile(file, before.toString(), ts.ScriptTarget.Latest, true);
const statements = [];
function walk(node) {
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(ast) === 'window.setTimeout' &&
      node.expression.arguments[1]?.getText(ast) === '30_000' &&
      node.expression.arguments[0].getText(ast).includes('URL.revokeObjectURL(url)')) {
    statements.push(node.getText(ast));
  }
  ts.forEachChild(node, walk);
}
walk(ast);
assert.equal(statements.length, 1);
let callback;
let delay;
const originalCalls = [];
const nextTestCalls = [];
const context = {
  url: 'blob:saved-pdf',
  URL: { revokeObjectURL: (value) => originalCalls.push(value) },
  window: { setTimeout: (fn, milliseconds) => { callback = fn; delay = milliseconds; } },
};
vm.runInNewContext(statements[0], context);
assert.equal(delay, 30_000);
assert.equal(typeof callback, 'function');
assert.deepEqual(originalCalls, []);
// Mirrors vi.restoreAllMocks/new vi.spyOn before the retained callback runs.
context.URL.revokeObjectURL = (value) => nextTestCalls.push(value);
callback();
assert.deepEqual(nextTestCalls, ['blob:saved-pdf']);
assert.deepEqual(originalCalls, []);
console.log(JSON.stringify({ baselineSource: baseline, candidateRuntime: repaired,
  sourcePath: file, sourceSha256: crypto.createHash('sha256').update(before).digest('hex'),
  exactBaselineBytes: true, extractedStatement: statements[0], delay,
  staleCallbackHitsNextSpy: true, nextTestCalls,
  mechanism: 'Unchanged deferred callback reads URL.revokeObjectURL when fired, after a later test replaces the spy.',
  limitation: 'Mechanism proof only; not an original failing test rerun or proof of OS scheduling cause.',
  originalCandidateFailureRetained: true, actualTimersOrNetworkOrDownloads: false }, null, 2));
