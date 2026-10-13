import { resolve } from 'node:path';
import * as ts from 'typescript';
import {
  actionNames,
  actionPaths,
  asset,
  canonicalBindings,
  declaredFunction,
  digest,
  functionBudgets,
  originalActionPins as pins,
  productionTrackerFiles,
  retainedComments,
  retainedDeclarations,
  shape,
  wrapperCalls,
} from './fixtures/tracker-action-guard/semantic.js';

const root = resolve(__dirname, '../../../..');
const rename = {
  classifyTrackerActionText: 'classifyChange',
  selectTrackerMaterialEvents: 'selectMaterialEvents',
  TrackerActionChange: 'ChangeClass',
  TrackerMaterialAction: 'ActionLike',
  TrackerMaterialEvent: 'MaterialEvent',
};
const canonical = () => asset(root, actionPaths.canonical);
const body = (source: ReturnType<typeof asset>, name: string) =>
  declaredFunction(source, name).body!.statements;
function header(fn: ts.FunctionDeclaration) {
  return shape(
    ts.factory.updateFunctionDeclaration(
      fn,
      fn.modifiers,
      fn.asteriskToken,
      fn.name,
      fn.typeParameters,
      fn.parameters,
      fn.type,
      undefined,
    ),
  );
}

it('keeps the canonical module dependency-free with only the three contracts and four real functions', () => {
  const source = canonical();
  const functions = source.ast.statements.filter(ts.isFunctionDeclaration);
  const types = source.ast.statements.filter(ts.isInterfaceDeclaration);
  expect(source.ast.statements).toHaveLength(7);
  expect(functions.map((fn) => fn.name?.text)).toEqual([
    'classifyTrackerActionText',
    'classifyHighPriorityAction',
    'classifyScheduledAndCommitteeAction',
    'selectTrackerMaterialEvents',
  ]);
  expect(digest(types.map((node) => shape(node)))).toBe(pins.canonicalTypes);
  expect(digest(functions.map(header))).toBe(pins.canonicalHeaders);
  expect(
    functions
      .filter((fn) => fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
      .map((fn) => fn.name?.text),
  ).toEqual(Object.values(actionNames));
});

it('retains all ten literal decisions in their original priority order and original normalization', () => {
  const source = canonical();
  const entry = body(source, 'classifyTrackerActionText');
  const high = body(source, 'classifyHighPriorityAction');
  const low = body(source, 'classifyScheduledAndCommitteeAction');
  expect(digest(entry.map((node) => shape(node)))).toBe(pins.classifierEntry);
  expect(high).toHaveLength(5);
  expect(low).toHaveLength(7);
  expect(digest(shape(high[high.length - 1]))).toBe(pins.highNull);
  expect(digest(shape(low[low.length - 1]))).toBe(pins.lowNull);
  const rules = [...high.slice(0, -1), ...low.slice(0, -1)];
  expect(rules.every(ts.isIfStatement)).toBe(true);
  expect(rules).toHaveLength(10);
  expect(digest(rules.map((node) => shape(node)))).toBe(pins.classifierRules);
  const originalStatements = [...entry.slice(0, 2), ...rules, low[low.length - 1]];
  expect(originalStatements).toHaveLength(13);
  expect(digest(originalStatements.map((node) => shape(node)))).toBe(pins.classifierStatements);
});

it('retains all seven selector statements including copied sorting, exact latest merge and earliest-type evidence', () => {
  const statements = body(canonical(), 'selectTrackerMaterialEvents');
  expect(statements).toHaveLength(7);
  expect(digest(statements.map((node) => shape(node, rename)))).toBe(pins.selectorStatements);
});

it('retains both original adapter headers, types, constants, unselected logic and comments with two direct shared calls', () => {
  for (const kind of ['api', 'intel'] as const) {
    const source = asset(root, actionPaths[kind]);
    expect(digest(retainedDeclarations(source))).toBe(pins[kind].declarations);
    expect(digest(retainedComments(source))).toBe(pins[kind].comments);
    expect(wrapperCalls(source)).toEqual([
      { name: 'classifyChange', target: 'classifyTrackerActionText', arity: 1 },
      { name: 'selectMaterialEvents', target: 'selectTrackerMaterialEvents', arity: 2 },
    ]);
    expect(canonicalBindings(source)).toEqual([...Object.values(actionNames)].sort());
  }
});

it('keeps the original seven API methods and five-DI constructor while retaining all twelve Intel public functions', () => {
  const api = asset(root, actionPaths.api);
  const owner = api.ast.statements.find(
    (node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === 'TrackerChangeDetectorService',
  );
  expect(owner).toBeDefined();
  expect(owner!.members.filter(ts.isMethodDeclaration)).toHaveLength(7);
  expect(owner!.members.find(ts.isConstructorDeclaration)?.parameters).toHaveLength(5);
  const intel = asset(root, actionPaths.intel);
  expect(intel.ast.statements.filter(ts.isFunctionDeclaration)).toHaveLength(12);
  expect(digest(retainedDeclarations(api))).toBe(pins.api.declarations);
  expect(digest(retainedDeclarations(intel))).toBe(pins.intel.declarations);
});

it('adds one canonical Shared barrel alias while preserving every original barrel statement and comment', () => {
  const source = asset(root, actionPaths.barrel);
  const exports = source.ast.statements.filter(
    (node): node is ts.ExportDeclaration =>
      ts.isExportDeclaration(node) &&
      !!node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === './tracker-action-change.js',
  );
  expect(exports).toHaveLength(1);
  expect(exports[0]!.isTypeOnly).toBe(false);
  const clause = exports[0]!.exportClause;
  if (clause) {
    if (!ts.isNamedExports(clause))
      throw new Error('Canonical barrel must use named or star exports');
    expect(
      clause.elements.filter((binding) => !binding.isTypeOnly).map((binding) => binding.name.text),
    ).toEqual(Object.values(actionNames));
    expect(
      clause.elements.filter((binding) => binding.isTypeOnly).map((binding) => binding.name.text),
    ).toEqual(['TrackerActionChange', 'TrackerMaterialAction', 'TrackerMaterialEvent']);
    expect(clause.elements.every((binding) => !binding.propertyName)).toBe(true);
  }
  expect(digest(retainedDeclarations(source, true))).toBe(pins.barrel.declarations);
  expect(digest(retainedComments(source))).toBe(pins.barrel.comments);
});

it('prevents new local classifier or selector copies in the finite Tracker and canonical ownership scope', () => {
  const seen: Record<string, string[]> = {};
  const names = new Set([
    ...Object.keys(actionNames),
    ...Object.values(actionNames),
    'classifyHighPriorityAction',
    'classifyScheduledAndCommitteeAction',
  ]);
  for (const path of productionTrackerFiles(root)) {
    const source = asset(root, path);
    const inspect = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text))
        (seen[node.name.text] ??= []).push(path);
      if (ts.isFunctionLike(node) && 'body' in node && node.body && ts.isBlock(node.body)) {
        const hash = digest(node.body.statements.map((statement) => shape(statement, rename)));
        if (hash === pins.classifierStatements)
          throw new Error('Copied original classifier body: ' + path);
        if (hash === pins.selectorStatements) expect(path).toBe(actionPaths.canonical);
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source.ast);
  }
  expect(seen.classifyChange?.sort()).toEqual([actionPaths.api, actionPaths.intel].sort());
  expect(seen.selectMaterialEvents?.sort()).toEqual([actionPaths.api, actionPaths.intel].sort());
  for (const name of [
    ...Object.values(actionNames),
    'classifyHighPriorityAction',
    'classifyScheduledAndCommitteeAction',
  ])
    expect(seen[name]).toEqual([actionPaths.canonical]);
});

it('bounds the canonical module, Intel utility, both wrappers and all three concrete guard assets without changing API service scope', () => {
  const bounded = [
    actionPaths.canonical,
    actionPaths.intel,
    'apps/api/src/tracker/tracker-action-ownership.contract.spec.ts',
    'apps/api/src/tracker/fixtures/tracker-action-guard/semantic.ts',
    'apps/intel-api/test/tracker-board-ownership.contract.spec.ts',
  ];
  for (const path of bounded) {
    const source = asset(root, path);
    expect(source.text.split('\n').filter((line) => line.trim()).length).toBeLessThan(400);
    expect(functionBudgets(source).every((lines) => lines <= 80)).toBe(true);
    expect(
      ts.transpileModule(source.text, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
        reportDiagnostics: true,
      }).diagnostics ?? [],
    ).toHaveLength(0);
  }
  for (const kind of ['api', 'intel'] as const) {
    const source = asset(root, actionPaths[kind]);
    for (const name of Object.keys(actionNames)) {
      const fn = declaredFunction(source, name);
      const start = source.ast.getLineAndCharacterOfPosition(fn.getStart(source.ast)).line;
      expect(source.ast.getLineAndCharacterOfPosition(fn.end).line - start + 1).toBeLessThanOrEqual(
        8,
      );
    }
  }
});
