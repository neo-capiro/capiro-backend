import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export function adjacentImportProblems(source, filename = 'fixture.ts') {
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  if (file.parseDiagnostics.length) return ['TypeScript source could not be parsed'];
  const problems = [];
  function module(expression) {
    if (!expression || !ts.isStringLiteralLike(expression)) {
      problems.push('Computed module lookup cannot establish adjacent-runtime isolation');
    } else if (/meriv3/i.test(expression.text))
      problems.push(`Forbidden MeriV3 module: ${expression.text}`);
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) module(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      module(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      module(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return problems;
}

export function verifyAdjacentImports(root) {
  const problems = [];
  let files = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.tsx?$/.test(entry.name)) {
        files += 1;
        for (const issue of adjacentImportProblems(readFileSync(file, 'utf8'), file))
          problems.push(`${path.relative(root, file)}: ${issue}`);
      }
    }
  };
  for (const dir of ['apps/workspace/src', 'apps/api-strategy/src', 'apps/intel-api/src'])
    walk(path.join(root, dir));
  return { files, problems };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = verifyAdjacentImports(root);
  if (result.problems.length) {
    console.error(result.problems.join('\n'));
    process.exitCode = 1;
  } else console.log(`MERIV3_ADJACENT_IMPORT_BOUNDARY_PASS files=${result.files}`);
}
