import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as ts from 'typescript';
import {
  directory,
  digest,
  exportsAndPolicies,
  facade,
  guards,
  moduleBudgets,
  modules,
  noCapturedRoot,
  operations,
  retainedRootContract,
  source,
  wrapperContract,
} from './fixtures/tracker-watchlist-ownership-guard/semantic.js';
import {
  retainedWatchlistBodies,
  noDuplicateOriginalBodies,
} from './fixtures/tracker-watchlist-ownership-guard/decomposition.js';

const root = resolve(__dirname, '../../..');

it('bounds every discovered concrete Watchlist production module and every complete function', () => {
  expect(moduleBudgets(root)).toBe(true);
  expect(modules).toHaveLength(10);
});

it('preserves all fifteen original headers and the single-DI constructor and logger without new Root state', () => {
  expect(retainedRootContract(root)).toBe(true);
  const { owner } = facade(root);
  expect(owner.members.filter(ts.isMethodDeclaration)).toHaveLength(15);
  expect(owner.members.find(ts.isConstructorDeclaration)?.parameters).toHaveLength(1);
});

it('retains all five short original guard declarations including full JSDoc byte for byte', () => {
  expect(guards).toHaveLength(5);
  expect(retainedRootContract(root)).toBe(true);
});

it('preserves four runtime exports six contract bodies and original four data initializers before owner allocation', () => {
  expect(exportsAndPolicies(root)).toBe(true);
});

it('routes all ten remaining operations through the current Root receiver to exact host-first owners', () => {
  expect(wrapperContract(root)).toBe(true);
  expect(Object.values(operations).flat()).toHaveLength(10);
});

it('keeps all original operation decisions and transaction statements accounted in their canonical phase owners', () => {
  expect(retainedWatchlistBodies(root)).toBe(true);
});

it('keeps Root imports type-only in leaves with no constructor-captured Root', () => {
  expect(noCapturedRoot(root)).toBe(true);
});

it('prevents duplicate original operation implementations outside their concrete original ownership paths', () => {
  expect(noDuplicateOriginalBodies(root)).toBe(true);
  const methods: Record<string, string[]> = {};
  for (const file of modules) {
    const { ast } = source(root, file);
    for (const owner of ast.statements.filter(ts.isClassDeclaration)) {
      for (const method of owner.members.filter(ts.isMethodDeclaration))
        (methods[method.name.getText(ast)] ??= []).push(file);
    }
  }
  for (const name of guards) expect(methods[name]).toEqual(['tracker-watchlist.service.ts']);
  for (const [binding, names] of Object.entries(operations)) {
    for (const name of names)
      expect(methods[name]?.sort()).toEqual(
        ['tracker-watchlist.service.ts', 'tracker-watchlist-' + binding + '.ts'].sort(),
      );
  }
  expect(
    digest(
      Object.keys(methods)
        .filter((name) => guards.includes(name))
        .sort(),
    ),
  ).toBe(digest([...guards].sort()));
  expect(Object.keys(methods).sort()).toEqual(
    [...guards, ...Object.values(operations).flat(), 'coldView', 'presentTopics'].sort(),
  );
});

it('keeps every concrete guard source file below 400 nonblank lines and every function at most 80 physical lines', () => {
  const files = [
    'test/tracker-watchlist-ownership.contract.spec.ts',
    'test/fixtures/tracker-watchlist-ownership-guard/semantic.ts',
    'test/fixtures/tracker-watchlist-ownership-guard/decomposition.ts',
    'test/fixtures/tracker-watchlist-ownership-guard/pins.ts',
  ];
  for (const file of files) {
    const text = readFileSync(join(root, 'apps/intel-api', file), 'utf8');
    expect(text.split('\n').filter((line) => line.trim()).length).toBeLessThan(400);
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const inspect = (node: ts.Node) => {
      if (ts.isFunctionLike(node) && 'body' in node && node.body) {
        const start = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line;
        expect(ast.getLineAndCharacterOfPosition(node.end).line - start + 1).toBeLessThanOrEqual(
          80,
        );
      }
      ts.forEachChild(node, inspect);
    };
    inspect(ast);
  }
});
