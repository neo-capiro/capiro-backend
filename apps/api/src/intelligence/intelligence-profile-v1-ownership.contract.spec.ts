import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const ownerFiles = [
  'client-profile-v1.ts',
  'client-profile-v1.shared.ts',
  'client-profile-v1-sources.ts',
  'client-profile-v1-snapshot.ts',
  'client-profile-v1-legislative.ts',
  'client-profile-v1-regulatory.ts',
  'client-profile-v1-relationships.ts',
  'client-profile-v1-presentation.ts',
];
const nonblankLines = (source: string) => source.split('\n').filter((line) => line.trim()).length;

test('profile-v1 owners remain bounded files and complete functions', () => {
  for (const filename of ownerFiles) {
    const source = readFileSync(join(__dirname, filename), 'utf8');
    expect({ filename, oversized: nonblankLines(source) >= 400 }).toEqual({
      filename,
      oversized: false,
    });
    const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isConstructorDeclaration(node) ||
          ts.isArrowFunction(node) ||
          ts.isFunctionExpression(node)) &&
        node.body
      ) {
        expect({ filename, oversized: nonblankLines(node.getText(ast)) > 80 }).toEqual({
          filename,
          oversized: false,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
});

test('selected profile implementation bodies stay owned outside the Intelligence facade', () => {
  const source = readFileSync(join(__dirname, 'intelligence.service.ts'), 'utf8');
  const ast = ts.createSourceFile('intelligence.service.ts', source, ts.ScriptTarget.Latest, true);
  const service = ast.statements.find(
    (node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === 'IntelligenceService',
  );
  if (!service) throw new Error('Intelligence facade must remain present');
  for (const name of [
    'asFinite',
    'asFiniteOrNull',
    'asIsoOrNull',
    'normalizeProfileV1Sections',
    'buildRegulatoryLifecycle',
    'getClientProfileV1WithinBillDeadline',
  ]) {
    const method = service.members.find(
      (node): node is ts.MethodDeclaration =>
        ts.isMethodDeclaration(node) && node.name.getText(ast) === name,
    );
    expect(method?.body?.statements).toHaveLength(1);
    expect(method?.body?.statements[0]?.kind).toBe(ts.SyntaxKind.ReturnStatement);
  }
});
