const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ts = require('C:/dev/main/meri-c1-20261002/apps/api/node_modules/typescript');
const root = __dirname;
const prepared = JSON.parse(fs.readFileSync(path.join(root, 'preparation.json'), 'utf8'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const rows = prepared.files.map(file => {
  const before = fs.readFileSync(file.base, 'utf8');
  const after = fs.readFileSync(file.source, 'utf8');
  assert.equal(hash(before), file.baseSha256);
  assert.equal(hash(after), file.sha256);
  assert.equal(hash(fs.readFileSync(path.join('C:/dev/main/meri-c1-20261002', file.path))), file.baseSha256);
  const compile = text => ts.transpileModule(text, {
    fileName: file.path,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.Node16, removeComments: true, sourceMap: false },
    reportDiagnostics: true,
  });
  const a = compile(before), b = compile(after);
  assert.deepEqual(a.diagnostics, []);
  assert.deepEqual(b.diagnostics, []);
  assert.equal(a.outputText, b.outputText, 'The type repair must not change runtime statements or assertions');
  return { ...file, emittedJavaScriptSha256: hash(a.outputText), runtimeByteEquivalent: true, syntaxDiagnostics: 0, repositorySourceUnchanged: true };
});
const result = { status: 'PASS', files: rows, semanticTypecheck: 'NOT_RUN_UNTIL_CAPTURE_TERMINAL', testsExecuted: false, scope: 'TypeScript transpilation byte equality, not Jest or full semantic typechecking.' };
fs.writeFileSync(path.join(root, 'runtime-equivalence.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: result.status, files: rows.length, byteEquivalent: true }));
