import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const ts = require('/workspace/capirov2/node_modules/typescript');
const root = path.resolve(import.meta.dirname, '../../../..');
const [before, after] = process.argv.slice(2);
assert.ok(before && after, 'requires exact before/after Git commits');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trimEnd();
const at = (ref, file) => execFileSync('git', ['show', `${ref}:${file}`], { cwd: root, encoding: 'utf8' });
const paths = ['packages/shared/src/index.ts', 'packages/shared/src/workspace-saved-revision.ts'];
const changed = git('diff', '--name-only', before, after, '--', ':!docs').split('\n').filter(Boolean);
assert.deepEqual(changed.sort(), [...paths].sort(), 'runtime delta must be exactly the two formatter files');
function astSemantics(node) {
  if (ts.isParenthesizedExpression(node)) return astSemantics(node.expression);
  const children = [];
  ts.forEachChild(node, child => { children.push(astSemantics(child)); });
  const result = { kind: ts.SyntaxKind[node.kind], children };
  if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)
      || ts.isBigIntLiteral(node) || node.kind === ts.SyntaxKind.RegularExpressionLiteral
      || node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle
      || node.kind === ts.SyntaxKind.TemplateTail) && typeof node.text === 'string') result.text = node.text;
  if (typeof node.escapedText === 'string') result.escapedText = node.escapedText;
  return result;
}
const hash = text => createHash('sha256').update(text).digest('hex');
const files = paths.map(file => {
  const old = at(before, file);
  const current = at(after, file);
  const oldAst = ts.createSourceFile(file, old, ts.ScriptTarget.Latest, true);
  const newAst = ts.createSourceFile(file, current, ts.ScriptTarget.Latest, true);
  assert.deepEqual(oldAst.parseDiagnostics, []);
  assert.deepEqual(newAst.parseDiagnostics, []);
  const originalSemantics = JSON.stringify(astSemantics(oldAst));
  const formattedSemantics = JSON.stringify(astSemantics(newAst));
  assert.equal(formattedSemantics, originalSemantics, `${file}: AST semantics changed`);
  const compile = source => ts.transpileModule(source, { fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true, removeComments: true, sourceMap: false, declaration: false } }).outputText;
  const originalJavaScript = compile(old);
  const formattedJavaScript = compile(current);
  const oldJsAst = ts.createSourceFile(file + '.js', originalJavaScript, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const newJsAst = ts.createSourceFile(file + '.js', formattedJavaScript, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const originalJavaScriptSemantics = JSON.stringify(astSemantics(oldJsAst));
  const formattedJavaScriptSemantics = JSON.stringify(astSemantics(newJsAst));
  assert.equal(formattedJavaScriptSemantics, originalJavaScriptSemantics, `${file}: emitted JS semantics changed`);
  return { file, beforeBlob: git('rev-parse', `${before}:${file}`), afterBlob: git('rev-parse', `${after}:${file}`),
    beforeSourceHash: hash(old), afterSourceHash: hash(current), semanticASTHash: hash(originalSemantics),
    emittedJavaScriptSemanticHash: hash(originalJavaScriptSemantics), semanticASTIdentical: true,
    emittedJavaScriptSemanticsIdentical: true, emittedJavaScriptBytesIdentical: formattedJavaScript === originalJavaScript };
});
console.log(JSON.stringify({ before, beforeTree: git('rev-parse', `${before}^{tree}`), after,
  afterTree: git('rev-parse', `${after}^{tree}`), changedRuntimePaths: changed,
  typescriptVersion: ts.version, files, sourceOnly: true, databaseProviderExecution: false }, null, 2));
