import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

// AFTER-only semantic fixtures derived from immutable 1ecd4b71 originals.
export const actionPaths = {
  api: 'apps/api/src/tracker/tracker-change-detector.service.ts',
  intel: 'apps/intel-api/src/tracker/change-detector.util.ts',
  canonical: 'packages/shared/src/tracker-action-change.ts',
  barrel: 'packages/shared/src/index.ts',
} as const;
export const actionNames = {
  classifyChange: 'classifyTrackerActionText',
  selectMaterialEvents: 'selectTrackerMaterialEvents',
} as const;
export const originalActionPins = {
  api: {
    declarations: 'b1fd9acea493b04d36fa919a4d166c337c19e3f25bd44d9d2dc88979a33af905',
    comments: '433cfd10e9d41f2bf9d51a6a6f0f9b1f9251a41459be33ba6319a190812589e4',
  },
  intel: {
    declarations: '84745c3078c0c76db15fefd82509391a1a976d758bca770143a0777a00fac9df',
    comments: 'bed74dd46c72508c725d850ae96c2719137f85d87c2cbdb4c8984f740ac7c8f4',
  },
  barrel: {
    declarations: '1276c9abe859c65c0afca391edb730d6879317d24b1331018263031a3df99623',
    comments: 'dec43d3b8cc8ae8c15557f32955ab7ee0c9085d3a131e15a63479cd41568f897',
  },
  classifierStatements: 'ddcfbfd03e51e8a2a6c200b120ff04ca3ca1e8e50257262ec1d5745bd370af8f',
  classifierRules: 'bae33f1fd12935a867cead917e27992bb05b0a2bf5f242ab38cb95c258876496',
  selectorStatements: 'd401f38f6750e6dae46fdf0fe42b5c66f3aa7cd2a825e4bbf27b4fe86f245742',
  classifierEntry: 'e2d029eabacbce05cf99c9291e95f31a8ab2dec2f447f3ca43c8eb1ce6bf34ed',
  highNull: '752e41b6eeb00b4a79f1804ba191735b6cb26c7d68b6deabb1253c7fceab5614',
  lowNull: '752e41b6eeb00b4a79f1804ba191735b6cb26c7d68b6deabb1253c7fceab5614',
  canonicalHeaders: '7af329b57dcd8bfa1903402a12f378de0524f50a26f6bb7faee86d868b0bf3ed',
  canonicalTypes: '414be23f3e507dd56803efe0478cc713f41ebe1f4ec17d51ff4f0609e0982d9a',
} as const;
export const trackerBoardFixedPaths = [
  'apps/intel-api/src/tracker/tracker-board.controller.ts',
  'apps/intel-api/src/tracker/tracker-watchlist.controller.ts',
  'apps/intel-api/src/tracker/tracker-channel.controller.ts',
  'apps/intel-api/src/tracker/tracker.dto.ts',
  'apps/intel-api/src/tracker/tracker.module.ts',
  'apps/intel-api/src/tracker/tracker-owner.guard.ts',
  'apps/intel-api/src/sourcedata/source-data.repository.ts',
  'apps/intel-api/src/sourcedata/state-source-data.repository.ts',
  'apps/intel-api/src/prisma/prisma.service.ts',
  'apps/intel-api/src/tracker/tracker-watchlist.service.ts',
  'apps/intel-api/src/watchlist/watchlist-compiler.ts',
  'apps/intel-api/src/watchlist/term-routing.ts',
  'apps/intel-api/src/tracker/bill-fit.util.ts',
  'apps/intel-api/src/tracker/bill-stage.util.ts',
  'apps/intel-api/src/tracker/relevance.util.ts',
  'apps/intel-api/src/tracker/change-detector.util.ts',
  'apps/intel-api/src/tracker/new-match-detector.service.ts',
  'apps/intel-api/src/tasks/task-runner.ts',
  'apps/intel-api/src/tracker/tracker-board-state-stage.spec.ts',
  'apps/intel-api/src/tracker/tracker-tenant-scoping.spec.ts',
  'apps/intel-api/test/tracker-board-guards.spec.ts',
  'apps/intel-api/test/tracker-board-pagination.spec.ts',
  'apps/intel-api/test/tracker-board-highfit.spec.ts',
  'apps/intel-api/test/tracker-board-feedback.spec.ts',
  'apps/intel-api/test/bill-search.spec.ts',
  'apps/intel-api/test/bill-search-jurisdictions.spec.ts',
  'apps/intel-api/test/tracker-summary.spec.ts',
  'apps/intel-api/test/tracker-portfolio-counts.spec.ts',
  'apps/intel-api/test/tracker-dto-validation.spec.ts',
  'apps/intel-api/test/tracker-watchlist.spec.ts',
  'apps/intel-api/test/bill-fit.spec.ts',
  'apps/intel-api/test/bill-fit-routing.spec.ts',
  'apps/intel-api/test/bill-stage.spec.ts',
  'apps/intel-api/test/watchlist-compiler.spec.ts',
  'apps/intel-api/test/term-routing.spec.ts',
  'apps/intel-api/test/term-routing-perf.spec.ts',
  'apps/intel-api/test/watchlist-mapping.spec.ts',
  'apps/intel-api/test/watchlist-weighting.spec.ts',
  'apps/intel-api/test/task-runner.spec.ts',
  'apps/intel-api/test/new-match-detector.spec.ts',
];

const originalIntelIntro =
  '/**\n * Pure change classification (Phase 3, plan \u00a76.3) \u2014 ported VERBATIM from\n * apps/api/src/tracker/tracker-change-detector.service.ts (`classifyChange`,\n * `selectMaterialEvents`) so the shadow detector byte-matches legacy for the\n * Phase 5 parity gate. No side effects, no DB \u2014 unit-testable in isolation.\n';
const canonicalIntelIntro =
  '/**\n * Action classification and event selection delegate to one canonical Shared\n * owner, retaining the original API/Intel policy, outputs and Phase 5 parity.\n * Intel-only derived/state event policy remains local. No side effects or DB.\n';

export interface SourceAsset {
  text: string;
  ast: ts.SourceFile;
}
export function asset(root: string, relative: string): SourceAsset {
  const text = readFileSync(join(root, relative), 'utf8');
  return { text, ast: ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true) };
}
export function shape(node: ts.Node | undefined, names: Record<string, string> = {}): unknown {
  if (!node) return null;
  const children: unknown[] = [];
  ts.forEachChild(node, (child) => {
    children.push(shape(child, names));
  });
  return {
    kind: ts.SyntaxKind[node.kind],
    value: ts.isIdentifier(node)
      ? (names[node.text] ?? node.text)
      : ts.isLiteralExpression(node) || ts.isTemplateLiteralToken(node)
        ? node.text
        : undefined,
    flags: ts.isVariableDeclarationList(node) ? node.flags & ts.NodeFlags.BlockScoped : undefined,
    operator:
      ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)
        ? ts.SyntaxKind[node.operator]
        : undefined,
    children,
  };
}
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function declaredFunction(source: SourceAsset, name: string): ts.FunctionDeclaration {
  const fn = source.ast.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (!fn?.body) throw new Error('Missing function ' + name);
  return fn;
}
function withoutCanonicalBindings(node: ts.ImportDeclaration): ts.ImportDeclaration | undefined {
  if (!ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== '@capiro/shared')
    return node;
  const bindings = node.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return node;
  const kept = bindings.elements.filter(
    (binding) =>
      !Object.values(actionNames).includes(
        binding.name.text as (typeof actionNames)[keyof typeof actionNames],
      ),
  );
  if (kept.length === bindings.elements.length) return node;
  if (!kept.length && !node.importClause?.name) return undefined;
  return ts.factory.updateImportDeclaration(
    node,
    node.modifiers,
    ts.factory.updateImportClause(
      node.importClause!,
      node.importClause!.isTypeOnly,
      node.importClause!.name,
      ts.factory.updateNamedImports(bindings, kept),
    ),
    node.moduleSpecifier,
    node.attributes,
  );
}
export function retainedDeclarations(source: SourceAsset, removeBarrelExport = false): unknown[] {
  const records: unknown[] = [];
  for (const original of source.ast.statements) {
    let node: ts.Node | undefined = original;
    if (
      removeBarrelExport &&
      ts.isExportDeclaration(original) &&
      ts.isStringLiteral(original.moduleSpecifier ?? ts.factory.createNull()) &&
      (original.moduleSpecifier as ts.StringLiteral).text === './tracker-action-change.js'
    )
      continue;
    if (ts.isImportDeclaration(original)) node = withoutCanonicalBindings(original);
    if (
      ts.isFunctionDeclaration(original) &&
      original.name &&
      Object.hasOwn(actionNames, original.name.text)
    )
      node = ts.factory.updateFunctionDeclaration(
        original,
        original.modifiers,
        original.asteriskToken,
        original.name,
        original.typeParameters,
        original.parameters,
        original.type,
        undefined,
      );
    if (node) records.push(shape(node));
  }
  return records;
}
export function retainedComments(source: SourceAsset): string[] {
  const ranges = new Map<number, ts.CommentRange>();
  const collect = (rows: ts.CommentRange[] | undefined) => {
    for (const row of rows ?? []) ranges.set(row.pos, row);
  };
  const visit = (node: ts.Node) => {
    collect(ts.getLeadingCommentRanges(source.text, node.pos));
    collect(ts.getTrailingCommentRanges(source.text, node.end));
    if (ts.isFunctionDeclaration(node) && node.name && Object.hasOwn(actionNames, node.name.text)) {
      for (const child of node.getChildren(source.ast)) if (child !== node.body) visit(child);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source.ast);
  return [...ranges.values()]
    .sort((a, b) => a.pos - b.pos)
    .map((row) => {
      const text = source.text.slice(row.pos, row.end);
      return source.ast.fileName.endsWith(actionPaths.intel) && text.startsWith(canonicalIntelIntro)
        ? originalIntelIntro + text.slice(canonicalIntelIntro.length)
        : text;
    });
}
export function wrapperCalls(source: SourceAsset): unknown[] {
  return Object.entries(actionNames).map(([name, target]) => {
    const fn = declaredFunction(source, name);
    const statement = fn.body!.statements[0];
    if (
      fn.body!.statements.length !== 1 ||
      !statement ||
      !ts.isReturnStatement(statement) ||
      !statement.expression ||
      !ts.isCallExpression(statement.expression)
    )
      throw new Error('Missing genuine action wrapper ' + name);
    const call = statement.expression;
    if (
      !ts.isIdentifier(call.expression) ||
      call.expression.text !== target ||
      digest(call.arguments.map((arg) => shape(arg))) !==
        digest(fn.parameters.map((p) => shape(p.name)))
    )
      throw new Error('Action wrapper changed target or arguments ' + name);
    return { name, target, arity: fn.parameters.length };
  });
}
export function canonicalBindings(source: SourceAsset): string[] {
  const found: string[] = [];
  for (const node of source.ast.statements.filter(ts.isImportDeclaration)) {
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      if (
        !Object.values(actionNames).includes(
          binding.name.text as (typeof actionNames)[keyof typeof actionNames],
        )
      )
        continue;
      if (
        !ts.isStringLiteral(node.moduleSpecifier) ||
        node.moduleSpecifier.text !== '@capiro/shared' ||
        node.importClause?.isTypeOnly ||
        binding.isTypeOnly ||
        binding.propertyName
      )
        throw new Error('Canonical action import changed authority');
      found.push(binding.name.text);
    }
  }
  return found.sort();
}
export function retainedIntelActionAsset(root: string): boolean {
  const source = asset(root, actionPaths.intel);
  const pin = originalActionPins.intel;
  if (
    digest(retainedDeclarations(source)) !== pin.declarations ||
    digest(retainedComments(source)) !== pin.comments
  )
    throw new Error('Intel unselected source drift');
  wrapperCalls(source);
  if (digest(canonicalBindings(source)) !== digest(Object.values(actionNames).sort()))
    throw new Error('Missing Intel canonical action imports');
  return true;
}
export function functionBudgets(source: SourceAsset): number[] {
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node) && 'body' in node && node.body) {
      const start = source.ast.getLineAndCharacterOfPosition(node.getStart(source.ast)).line;
      lines.push(source.ast.getLineAndCharacterOfPosition(node.end).line - start + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source.ast);
  return lines;
}
export function productionTrackerFiles(root: string): string[] {
  const paths: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== 'fixtures') walk(join(directory, entry.name));
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts'))
        paths.push(join(directory, entry.name));
    }
  };
  walk('apps/api/src/tracker');
  walk('apps/intel-api/src/tracker');
  return [...paths, actionPaths.canonical];
}
