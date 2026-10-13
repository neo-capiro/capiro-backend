import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as ts from 'typescript';

const root = resolve(__dirname, '../../..');
const directory = 'apps/intel-api/src/tracker';
// AFTER-only pins from immutable b17fb898 AST; runtime characterization remains separate.
const modules = [
  'tracker-board.service.ts',
  'tracker-board.contracts.ts',
  'tracker-board-read.contracts.ts',
  'tracker-board-presentation.ts',
  'tracker-board-cursors.ts',
  'tracker-board-state-support.ts',
  'tracker-board-queries.ts',
  'tracker-board-commands.ts',
  'tracker-board-topics.ts',
  'tracker-board-recommendations.ts',
  'tracker-client-board-read.ts',
  'tracker-tenant-board-read.ts',
];
const operations: Record<string, string[]> = {
  trackerBoardStateSupport:
    'stateStatusToBoardStage stateBoardStage stateStageLabel fetchMergedBills canonicalStatusFor isTerminalNegativeStateStatus displayNumFor alignStateStageFilter jurisdictionFor'.split(
      ' ',
    ),
  trackerBoardTopics: ['compiledTopics', 'compileTopicsForClients'],
  trackerBoardRecommendations: ['getRecommendations'],
  trackerClientBoardRead: ['getBoard'],
  trackerTenantBoardRead: ['getTenantBoard'],
  trackerBoardQueries: ['getTrackedStatus', 'getSummary', 'getPortfolioCounts', 'searchBills'],
  trackerBoardCommands:
    'trackCongressStage trackStateStage trackBill untrackBill updateBillContext recordFeedback feedbackSignal'.split(
      ' ',
    ),
};
const dataNames =
  'EMBED_CANDIDATE_FLOOR LEGIWATCH_STATE_FIT_FLOOR RECENT_CHANGE_DAYS DAY_MS BOARD_PAGE_SIZE BOARD_PAGE_SIZE_MAX ALLOWED_FEEDBACK_SIGNALS MATCH_QUALITY_REASONS'.split(
    ' ',
  );
const typeNames =
  'BoardFilters BoardQueryOpts BoardPage UpdateBillContextInput RecommendationItem BillSearchResult ChangeChip BoardCard BoardColumn'.split(
    ' ',
  );
const helperOwners: Record<string, string> = {
  b64encode: 'tracker-board-cursors.ts',
  b64decode: 'tracker-board-cursors.ts',
  encodeBoardCursor: 'tracker-board-cursors.ts',
  encodeTenantBoardCursor: 'tracker-board-cursors.ts',
  billSearchPatterns: 'tracker-board-presentation.ts',
  summarizeTrackedRows: 'tracker-board-presentation.ts',
  stageLabelOf: 'tracker-board-presentation.ts',
  toRelevanceBill: 'tracker-board-presentation.ts',
};
const pins = {
  methodHeaders: '9d147fe146096e0b433c6fe520de0f1843bd90cb5c1dbf81fc6ce1a217183318',
  constructor: 'a3d2f3985f8cbe67e63a36b94a60517385df205bbe2a63322bf1727c96c6c316',
  decorators: 'f5044c9c1061c6786325435dd43856df9fd55e31abde2f7b5ce3c579e257f25b',
  publicTypes: '50e9ff1bd56115b43c24c34b78b64c7bc5b52e9b810006a2fb1181037342f55d',
  helpers: '4b2ded76aa0fc17335d13a61d085816941d23f0ebec82789cb064008e4d15cf7',
  originalData: 'deb83545b4976147bf9bdbca9bf3ab59f214de83313170999a7b38b4bd523ec3',
  moduleWiring: '596120b8195e9fea987edd8a880f75811d518696e09619487308e6d2508d589d',
  publicHelpers: 'f72ffd327953adc480d51cd40c116a8a9ee316141dccc2287d86b7763f90af8e',
  fixedAssets: '58e389ab750d87897f55220a7fb969ffa2d2de9c8168a2e852e48e50170970c6',
};
const fixedPaths = [
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

function hash(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function shape(node: ts.Node | undefined): unknown {
  if (!node) return null;
  const children: unknown[] = [];
  ts.forEachChild(node, (child) => {
    children.push(shape(child));
  });
  return {
    kind: ts.SyntaxKind[node.kind],
    value:
      ts.isIdentifier(node) || ts.isLiteralExpression(node) || ts.isTemplateLiteralToken(node)
        ? node.text
        : undefined,
    flags: ts.isVariableDeclarationList(node) ? node.flags & ts.NodeFlags.BlockScoped : undefined,
    children,
  };
}
const digest = (value: unknown): string => hash(JSON.stringify(value));
const className = (binding: string): string => binding[0]!.toUpperCase() + binding.slice(1);
function signature(node: ts.MethodDeclaration | ts.FunctionDeclaration) {
  const firstDefault = node.parameters.findIndex((p) => p.initializer || p.dotDotDotToken);
  return {
    name: node.name?.getText(),
    modifiers: node.modifiers?.map((mod) => ts.SyntaxKind[mod.kind]) ?? [],
    parameters: node.parameters.map(shape),
    returnType: shape(node.type),
    typeParameters: node.typeParameters?.map(shape) ?? [],
    optional: ts.isMethodDeclaration(node) && !!node.questionToken,
    generator: !!node.asteriskToken,
    arity: firstDefault < 0 ? node.parameters.length : firstDefault,
  };
}
function source(name: string) {
  const text = readFileSync(join(root, directory, name), 'utf8');
  return { text, ast: ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true) };
}
function facade() {
  const { ast } = source('tracker-board.service.ts');
  const owner = ast.statements.find(
    (n): n is ts.ClassDeclaration =>
      ts.isClassDeclaration(n) && n.name?.text === 'TrackerBoardService',
  );
  if (!owner) throw new Error('Missing TrackerBoardService');
  return { ast, owner };
}
function variables(ast: ts.SourceFile) {
  return ast.statements
    .filter(ts.isVariableStatement)
    .flatMap((n) => [...n.declarationList.declarations]);
}
function initializers(rows: readonly ts.VariableDeclaration[]) {
  return rows.map((row) => ({ name: row.name.getText(), initializer: shape(row.initializer) }));
}
function callable(ast: ts.SourceFile, name: string) {
  for (const n of ast.statements) {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) return n;
    if (ts.isVariableStatement(n)) {
      const d = n.declarationList.declarations.find(
        (v) => ts.isIdentifier(v.name) && v.name.text === name,
      );
      if (d?.initializer && ts.isArrowFunction(d.initializer)) return d.initializer;
    }
  }
  throw new Error('Missing canonical helper ' + name);
}

it('bounds all twelve discovered production modules and every complete nested function', () => {
  const actual = readdirSync(join(root, directory)).filter(
    (name) =>
      /^tracker-(board|client-board|tenant-board)[.-].*\.ts$/.test(name) &&
      !name.endsWith('.spec.ts') &&
      name !== 'tracker-board.controller.ts',
  );
  expect(actual.sort()).toEqual([...modules].sort());
  expect(modules).toHaveLength(12);
  for (const name of modules) {
    const { text, ast } = source(name);
    expect(text.split('\n').filter((line) => line.trim()).length).toBeLessThan(400);
    expect(
      ts.transpileModule(text, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
        reportDiagnostics: true,
      }).diagnostics ?? [],
    ).toHaveLength(0);
    const visit = (node: ts.Node) => {
      if (ts.isFunctionLike(node) && 'body' in node && node.body) {
        const start = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line;
        const end = ast.getLineAndCharacterOfPosition(node.end).line;
        expect(end - start + 1).toBeLessThanOrEqual(80);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
});

it('preserves all twenty-five original headers, defaults, modifiers and arities with the unchanged four-DI constructor', () => {
  const { owner } = facade();
  const methods = owner.members.filter(ts.isMethodDeclaration);
  expect(methods).toHaveLength(25);
  expect(digest(methods.map(signature))).toBe(pins.methodHeaders);
  const ctor = owner.members.find(ts.isConstructorDeclaration);
  expect(ctor?.parameters).toHaveLength(4);
  expect(digest(shape(ctor))).toBe(pins.constructor);
  expect(digest(ts.getDecorators(owner)?.map(shape) ?? [])).toBe(pins.decorators);
  expect(owner.members.filter((n) => !ts.isMethodDeclaration(n))).toEqual([ctor]);
});

it('preserves nine public type exports and five runtime exports with genuine canonical helper wrappers', () => {
  const { ast } = facade();
  const types: string[] = [],
    runtime: string[] = [];
  for (const n of ast.statements) {
    if (ts.isExportDeclaration(n)) {
      expect(n.isTypeOnly).toBe(true);
      expect(
        n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : null,
      ).toBe('./tracker-board.contracts.js');
      if (!n.exportClause || !ts.isNamedExports(n.exportClause))
        throw new Error('Types must be named exports');
      types.push(...n.exportClause.elements.map((e) => e.name.text));
    } else if (
      ts.canHaveModifiers(n) &&
      ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      if (ts.isVariableStatement(n))
        runtime.push(...n.declarationList.declarations.map((d) => d.name.getText(ast)));
      else if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name)
        runtime.push(n.name.text);
      else throw new Error('Unexpected facade export');
    }
  }
  expect(types).toEqual(typeNames);
  expect(runtime).toEqual([
    'EMBED_CANDIDATE_FLOOR',
    'LEGIWATCH_STATE_FIT_FLOOR',
    'billSearchPatterns',
    'summarizeTrackedRows',
    'TrackerBoardService',
  ]);
  const contracts = source('tracker-board.contracts.ts')
    .ast.statements.filter(ts.isInterfaceDeclaration)
    .filter((n) => typeNames.includes(n.name.text));
  expect(digest(contracts.map(shape))).toBe(pins.publicTypes);
  const helpers = ['billSearchPatterns', 'summarizeTrackedRows'].map((name) => callable(ast, name));
  if (!helpers.every(ts.isFunctionDeclaration)) throw new Error('Facade helpers must be functions');
  expect(digest(helpers.map(signature))).toBe(pins.publicHelpers);
  for (const fn of helpers) {
    const statement = fn.body?.statements[0];
    if (
      fn.body?.statements.length !== 1 ||
      !statement ||
      !ts.isReturnStatement(statement) ||
      !statement.expression ||
      !ts.isCallExpression(statement.expression)
    )
      throw new Error('Missing genuine helper wrapper');
    expect(shape(statement.expression.expression)).toEqual(
      shape(ts.factory.createIdentifier('canonical' + className(fn.name!.text))),
    );
    expect(statement.expression.arguments.map(shape)).toEqual(
      fn.parameters.map((p) => shape(p.name)),
    );
  }
});

it('keeps original data and environment initialization order before seven concrete module owners', () => {
  const { ast } = facade();
  const declarations = variables(ast);
  const original = declarations.filter((d) => dataNames.includes(d.name.getText(ast)));
  expect(original.map((d) => d.name.getText(ast))).toEqual(dataNames);
  expect(digest(initializers(original))).toBe(pins.originalData);
  const wiring = declarations.filter((d) => !dataNames.includes(d.name.getText(ast)));
  expect(wiring).toHaveLength(8);
  expect(digest(initializers(wiring))).toBe(pins.moduleWiring);
  const latestData = Math.max(...original.map((d) => d.end));
  const instances = wiring.filter((d) => d.initializer && ts.isNewExpression(d.initializer));
  expect(instances).toHaveLength(7);
  for (const d of instances) {
    if (!d.initializer || !ts.isNewExpression(d.initializer)) throw new Error('Missing owner');
    expect(d.getStart(ast)).toBeGreaterThan(latestData);
    expect(d.initializer.expression.getText(ast)).toBe(className(d.name.getText(ast)));
  }
});

it('passes the current Root receiver and original arguments to every real host-first owner operation', () => {
  const { owner, ast } = facade();
  const classes = modules.flatMap((file) =>
    source(file).ast.statements.filter(ts.isClassDeclaration),
  );
  for (const [binding, names] of Object.entries(operations)) {
    const leaf = classes.find((n) => n.name?.text === className(binding));
    if (!leaf) throw new Error('Missing concrete owner ' + binding);
    for (const name of names) {
      const method = owner.members
        .filter(ts.isMethodDeclaration)
        .find((m) => m.name.getText(ast) === name);
      const statement = method?.body?.statements[0];
      if (
        !method ||
        method.body?.statements.length !== 1 ||
        !statement ||
        !ts.isReturnStatement(statement) ||
        !statement.expression ||
        !ts.isCallExpression(statement.expression)
      )
        throw new Error('Missing delegate ' + name);
      const call = statement.expression;
      expect(shape(call.expression)).toEqual(
        shape(
          ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier(binding), name),
        ),
      );
      expect(call.arguments[0]?.kind).toBe(ts.SyntaxKind.ThisKeyword);
      expect(call.arguments.slice(1).map(shape)).toEqual(
        method.parameters.map((p) => shape(p.name)),
      );
      const target = leaf.members
        .filter(ts.isMethodDeclaration)
        .find((m) => m.name.getText() === name);
      expect(target?.parameters).toHaveLength(method.parameters.length + 1);
      const host = target?.parameters[0];
      expect(host?.name.getText()).toBe('host');
      expect(host?.initializer).toBeUndefined();
      expect(host?.modifiers).toBeUndefined();
      expect(host?.type?.getText()).toBe('TrackerBoardService');
    }
  }
});

it('uses Root type imports only in leaves and stores no constructor-captured Root', () => {
  for (const file of modules.slice(1)) {
    const { ast } = source(file);
    for (const n of ast.statements.filter(ts.isImportDeclaration)) {
      if (
        !ts.isStringLiteral(n.moduleSpecifier) ||
        n.moduleSpecifier.text !== './tracker-board.service.js'
      )
        continue;
      expect(n.importClause?.isTypeOnly).toBe(true);
    }
    const inspect = (node: ts.Node) => {
      if (ts.isConstructorDeclaration(node)) {
        for (const p of node.parameters) {
          expect(p.name.getText()).not.toBe('host');
          expect(p.type?.getText()).not.toBe('TrackerBoardService');
        }
      }
      if (ts.isPropertyDeclaration(node))
        throw new Error('Stateless owners cannot add captured fields');
      if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword)
        expect(node.name.text).not.toBe('host');
      if (
        ts.isElementAccessExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ThisKeyword &&
        ts.isStringLiteral(node.argumentExpression)
      )
        expect(node.argumentExpression.text).not.toBe('host');
      ts.forEachChild(node, inspect);
    };
    inspect(ast);
  }
});

it('keeps all eight original standalone helpers in their exact single canonical owners', () => {
  const records = Object.entries(helperOwners).map(([name, file]) => {
    const matches = modules.slice(1).filter((candidate) => {
      try {
        callable(source(candidate).ast, name);
        return true;
      } catch {
        return false;
      }
    });
    expect(matches).toEqual([file]);
    const helper = callable(source(file).ast, name);
    return {
      name,
      parameters: helper.parameters.map(shape),
      returnType: shape(helper.type),
      body: shape(helper.body),
    };
  });
  const globals = modules
    .slice(1)
    .flatMap((file) => variables(source(file).ast))
    .map((n) => n.name.getText())
    .sort();
  expect(globals).toEqual(['b64decode', 'b64encode', 'stageLabelOf', 'toRelevanceBill']);
  expect(records).toHaveLength(8);
  expect(digest(records)).toBe(pins.helpers);
});

it('retains positive controller, DTO, module, source, compiler, watchlist, worker and original-test identities', () => {
  const actual = fixedPaths.map((path) => ({ path, sha256: hash(readFileSync(join(root, path))) }));
  expect(actual).toHaveLength(40);
  expect(digest(actual)).toBe(pins.fixedAssets);
});
