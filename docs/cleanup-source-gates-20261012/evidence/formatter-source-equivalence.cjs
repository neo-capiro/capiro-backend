const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const ts = require(path.join(root, 'node_modules/typescript'));
const before = '243248e726243c44bd4b9d24fd1ed220da18c56a';
const files = ['packages/shared/src/index.ts', 'packages/shared/src/workspace-saved-revision.ts'];
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function ast(source, filename) {
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  if (parsed.parseDiagnostics.length) throw Error(`Parse error: ${filename}`);
  function walk(node) {
    // Prettier can add expression parentheses without changing evaluation.
    if (ts.isParenthesizedExpression(node)) return walk(node.expression);
    const value = ts.isIdentifier(node) ? node.escapedText.toString()
      : ts.isLiteralExpression(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
        ? node.text : null;
    const children = []; ts.forEachChild(node, child => { children.push(walk(child)); });
    return [ts.SyntaxKind[node.kind], value, children];
  }
  return JSON.stringify(walk(parsed));
}
const receipts = files.map(filename => {
  const prior = execFileSync('git', ['show', `${before}:${filename}`], { cwd: root }).toString();
  const next = fs.readFileSync(path.join(root, filename), 'utf8');
  const priorAst = ast(prior, filename), nextAst = ast(next, filename);
  const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, removeComments: true };
  const priorJs = ts.transpileModule(prior, { compilerOptions, fileName: filename }).outputText;
  const nextJs = ts.transpileModule(next, { compilerOptions, fileName: filename }).outputText;
  const sameAst = priorAst === nextAst;
  const sameEmittedSemantics = ast(priorJs, filename+'.js') === ast(nextJs, filename+'.js');
  if (!sameAst || !sameEmittedSemantics) throw Error(`Semantic change: ${filename}`);
  return { path: filename, beforeSha256: hash(prior), afterSha256: hash(next),
    syntaxAndLiteralValuesEqual: sameAst, emittedJavaScriptSemanticsEqual: sameEmittedSemantics,
    emittedJavaScriptBytesEqual: priorJs === nextJs, canonicalAstSha256: hash(priorAst) };
});
console.log(JSON.stringify({ before, typescriptVersion: ts.version, receipts,
  preserved: 'Every TS node and literal/SQL/template value; only formatting and redundant parentheses ignored.',
  pass: true, nativeAcceptance: false }, null, 2));
