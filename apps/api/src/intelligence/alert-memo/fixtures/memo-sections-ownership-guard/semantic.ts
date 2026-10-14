import { createHash } from 'node:crypto';
import * as ts from 'typescript';
import { originalMemoPins as pins } from './pins.js';

export interface MemoSources {
  canonical: string;
  memo: string;
  district: string;
}

type ServiceKey = 'memo' | 'district';
const ownerModule = './memo-sections.js';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

function insist(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function source(text: string, name: string): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
}

function services(sources: MemoSources): Array<[ServiceKey, ts.SourceFile]> {
  return [
    ['memo', source(sources.memo, 'alert-memo.service.ts')],
    ['district', source(sources.district, 'district-brief.service.ts')],
  ];
}

function ownerImports(ast: ts.SourceFile): ts.ImportDeclaration[] {
  return ast.statements.filter(
    (node): node is ts.ImportDeclaration =>
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === ownerModule,
  );
}

function isExported(node: ts.FunctionDeclaration | ts.InterfaceDeclaration): boolean {
  return !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

export function assertCanonicalOwner(sources: MemoSources): void {
  const ast = source(sources.canonical, 'memo-sections.ts');
  const types = ast.statements.filter(ts.isInterfaceDeclaration);
  const functions = ast.statements.filter(ts.isFunctionDeclaration);
  insist(ast.statements.length === 2, 'Canonical parser must have exactly its type and function');
  insist(types.length === 1 && types[0]!.name.text === 'GenSection', 'Canonical type is missing');
  const fn = functions[0];
  insist(
    functions.length === 1 && fn?.name?.text === 'parseSections',
    'Canonical parser is missing',
  );
  insist(isExported(fn) && isExported(types[0]!), 'Canonical declarations must be exported');
  insist(
    digest(fn.getText(ast).replace(/^export /, '')) === pins.parserDeclaration,
    'Canonical parser decisions or signature changed',
  );
  insist(
    digest(types[0]!.getText(ast).replace(/^export /, '')) === pins.sectionType,
    'Canonical section type changed',
  );
}

export function assertBothBindings(sources: MemoSources): void {
  for (const [key, ast] of services(sources)) {
    const imports = ownerImports(ast);
    insist(imports.length === 1, `${key}: canonical import is missing or duplicated`);
    const clause = imports[0]!.importClause;
    insist(clause && !clause.isTypeOnly && !clause.name, `${key}: canonical value import changed`);
    const bindings = clause.namedBindings;
    insist(bindings && ts.isNamedImports(bindings), `${key}: canonical named imports are missing`);
    insist(
      bindings.elements.every((item) => !item.propertyName),
      `${key}: parser alias introduced`,
    );
    const names = bindings.elements
      .map((item) => `${item.name.text}:${item.isTypeOnly ? 'type' : 'value'}`)
      .sort();
    insist(
      JSON.stringify(names) === JSON.stringify(['GenSection:type', 'parseSections:value']),
      `${key}: canonical parser and type adoption changed`,
    );
    insist(
      !ast.statements.some(
        (node) =>
          (ts.isFunctionDeclaration(node) && node.name?.text === 'parseSections') ||
          (ts.isInterfaceDeclaration(node) && node.name.text === 'GenSection'),
      ),
      `${key}: local parser or type returned`,
    );
  }
}

function parserCalls(ast: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'parseSections'
    )
      calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return calls;
}

export function assertGenerationPipelines(sources: MemoSources): void {
  for (const [key, ast] of services(sources)) {
    const calls = parserCalls(ast);
    insist(calls.length === 1, `${key}: original parser call is missing or duplicated`);
    const call = calls[0]!;
    insist(
      !call.questionDotToken &&
        !call.typeArguments?.length &&
        call.arguments.length === 1 &&
        call.arguments[0]!.getText(ast) === 'text',
      `${key}: original parser invocation changed`,
    );
    const parent = call.parent;
    insist(
      ts.isCallExpression(parent) &&
        ts.isIdentifier(parent.expression) &&
        parent.expression.text === 'verifyGrounded' &&
        !parent.questionDotToken &&
        !parent.typeArguments?.length &&
        parent.arguments.length === 2 &&
        parent.arguments[0] === call &&
        parent.arguments[1]!.getText(ast) === 'claims',
      `${key}: parser must precede the existing grounding policy`,
    );
    const owner = ast.statements.find(
      (node): node is ts.ClassDeclaration =>
        ts.isClassDeclaration(node) && node.name?.text === pins[key].className,
    );
    const generate = owner?.members.find(
      (node): node is ts.MethodDeclaration =>
        ts.isMethodDeclaration(node) && node.name.getText(ast) === 'generate',
    );
    insist(generate?.body, `${key}: existing generation method is missing`);
    insist(
      digest(generate.body.getText(ast)) === pins[key].generateBody,
      `${key}: generation behavior outside the parser adoption changed`,
    );
  }
}

export function assertRetainedDeclarations(sources: MemoSources): void {
  for (const [key, ast] of services(sources)) {
    const imports = new Set<ts.Statement>(ownerImports(ast));
    const retained = ast.statements.filter((node) => !imports.has(node));
    insist(
      retained.length === pins[key].retainedDeclarationCount &&
        digest(retained.map((node) => node.getText(ast)).join('\n')) ===
          pins[key].retainedDeclarations,
      `${key}: retained facades, exports, policies or a renamed parser clone changed`,
    );
  }
}
