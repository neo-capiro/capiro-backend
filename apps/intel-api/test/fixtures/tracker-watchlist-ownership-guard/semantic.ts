import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { originalPins } from './pins.js';
import { retainedWatchlistBodies, noDuplicateOriginalBodies } from './decomposition.js';

export const directory = 'apps/intel-api/src/tracker';
export const modules = [
  'tracker-watchlist.service.ts',
  'tracker-watchlist-read.ts',
  'tracker-watchlist-preferences.ts',
  'tracker-watchlist-compiled.ts',
  'tracker-watchlist.contracts.ts',
  'tracker-watchlist-input.ts',
  'tracker-watchlist-reconcile-head.ts',
  'tracker-watchlist-reconcile-topics.ts',
  'tracker-watchlist-reconcile-finish.ts',
  'tracker-watchlist-write.ts',
];
export const operations = {
  read: [
    'getWatchlist',
    'getSectorSuggestion',
    'resolveUserName',
    'getRevisions',
    'suggestedJurisdictions',
  ],
  write: ['putWatchlist'],
  preferences: ['getAlertPrefs', 'putAlertPrefs', 'markPhoneVerified'],
  compiled: ['getCompiled'],
};
export const guards = [
  'assertCanEditTargeting',
  'assertClientInTenant',
  'assertAlertInClient',
  'assertTenantMember',
  'assertPrefRowTenant',
];
export const dataNames = [
  'HEARING_TERMS_TOPIC_LABEL',
  'UUID_RE',
  'EXPECTED_VERSION_REQUIRED_FROM',
  'DEFAULT_TRIGGERS',
];
export const typeNames = [
  'TrackerTermInput',
  'TrackerTopicInput',
  'PutWatchlistInput',
  'WatchlistView',
  'WatchlistRevisionView',
  'PutAlertPrefsInput',
];
export function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
export function digest(value: unknown): string {
  return hash(JSON.stringify(value));
}
export function shape(node: ts.Node | undefined): unknown {
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
    operator:
      ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)
        ? ts.SyntaxKind[node.operator]
        : undefined,
    children,
  };
}
export function source(root: string, name: string) {
  const text = readFileSync(join(root, directory, name), 'utf8');
  return { text, ast: ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true) };
}
export function signature(node: ts.MethodDeclaration) {
  const first = node.parameters.findIndex((p) => p.initializer || p.dotDotDotToken);
  return {
    name: node.name.getText(),
    modifiers: node.modifiers?.map((m) => ts.SyntaxKind[m.kind]) ?? [],
    parameters: node.parameters.map(shape),
    returnType: shape(node.type),
    typeParameters: node.typeParameters?.map(shape) ?? [],
    optional: !!node.questionToken,
    generator: !!node.asteriskToken,
    arity: first < 0 ? node.parameters.length : first,
  };
}
export function facade(root: string) {
  const { text, ast } = source(root, modules[0]!);
  const owner = ast.statements.find(
    (node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === 'TrackerWatchlistService',
  );
  if (!owner) throw new Error('Missing Watchlist facade');
  return { text, ast, owner };
}
export function retainedRootContract(root: string): boolean {
  const { text, ast, owner } = facade(root),
    methods = owner.members.filter(ts.isMethodDeclaration);
  if (methods.length !== 15 || digest(methods.map(signature)) !== originalPins.headers)
    throw new Error('Original Watchlist method contract changed');
  const ctor = owner.members.find(ts.isConstructorDeclaration);
  const logger = owner.members.find(ts.isPropertyDeclaration);
  if (
    digest(shape(ctor)) !== originalPins.constructor ||
    digest(shape(logger)) !== originalPins.logger ||
    digest(ts.getDecorators(owner)?.map(shape) ?? []) !== originalPins.decorators
  )
    throw new Error('Original Watchlist constructor/logger changed');
  if (owner.members.filter((n) => !ts.isMethodDeclaration(n)).length !== 2)
    throw new Error('Watchlist facade added instance state');
  for (const name of guards) {
    const node = methods.find((n) => n.name.getText(ast) === name);
    if (
      !node ||
      hash(text.slice(node.getFullStart(), node.end)) !==
        originalPins.guardDeclarations[name as keyof typeof originalPins.guardDeclarations]
    )
      throw new Error('Original guard declaration/JSDoc changed: ' + name);
  }
  const data = ast.statements
    .filter(ts.isVariableStatement)
    .filter((n) =>
      n.declarationList.declarations.some((d) => dataNames.includes(d.name.getText(ast))),
    );
  if (digest(data.map(shape)) !== originalPins.data)
    throw new Error('Original module data/order changed');
  const helper = ast.statements.find(
    (n): n is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(n) && n.name?.text === 'isReservedTopicLabel',
  );
  if (digest(shape(helper)) !== originalPins.reservedHelper)
    throw new Error('Reserved-label helper changed');
  return true;
}
export function wrapperContract(root: string): boolean {
  const { ast, owner } = facade(root);
  for (const [binding, names] of Object.entries(operations)) {
    const child = source(root, 'tracker-watchlist-' + binding + '.ts').ast;
    const leaf = child.statements.find(ts.isClassDeclaration);
    if (!leaf) throw new Error('Missing concrete owner ' + binding);
    for (const name of names) {
      const method = owner.members
        .filter(ts.isMethodDeclaration)
        .find((n) => n.name.getText(ast) === name);
      const statement = method?.body?.statements[0];
      if (
        !method ||
        method.body?.statements.length !== 1 ||
        !statement ||
        !ts.isReturnStatement(statement) ||
        !statement.expression ||
        !ts.isCallExpression(statement.expression)
      )
        throw new Error('Missing Root forwarder ' + name);
      const call = statement.expression;
      if (
        !ts.isPropertyAccessExpression(call.expression) ||
        call.questionDotToken ||
        call.expression.questionDotToken ||
        call.expression.expression.getText(ast) !== binding ||
        call.expression.name.text !== name ||
        call.arguments[0]?.kind !== ts.SyntaxKind.ThisKeyword ||
        digest(call.arguments.slice(1).map(shape)) !==
          digest(method.parameters.map((p) => shape(p.name)))
      )
        throw new Error('Root receiver/argument routing changed ' + name);
      const target = leaf.members
        .filter(ts.isMethodDeclaration)
        .find((n) => n.name.getText(child) === name);
      if (
        !target ||
        target.parameters.length !== method.parameters.length + 1 ||
        target.parameters[0]?.name.getText(child) !== 'host' ||
        target.parameters[0]?.type?.getText(child) !== 'TrackerWatchlistService' ||
        target.parameters.some((p) => p.initializer) ||
        digest(target.parameters.slice(1).map((p) => shape(p.name))) !==
          digest(method.parameters.map((p) => shape(p.name))) ||
        target.parameters[0]?.modifiers
      )
        throw new Error('Owner host-first contract changed ' + name);
    }
  }
  return true;
}
export function moduleBudgets(root: string): boolean {
  const actual = readdirSync(join(root, directory)).filter(
    (name) =>
      /^tracker-watchlist[.-].*\.ts$/.test(name) &&
      name !== 'tracker-watchlist.controller.ts' &&
      !name.endsWith('.spec.ts'),
  );
  if (digest(actual.sort()) !== digest([...modules].sort()))
    throw new Error('Watchlist ownership modules changed');
  for (const name of modules) {
    const { text, ast } = source(root, name);
    if (text.split('\n').filter((line) => line.trim()).length >= 400)
      throw new Error('Watchlist file budget ' + name);
    const inspect = (node: ts.Node) => {
      if (ts.isFunctionLike(node) && 'body' in node && node.body) {
        const start = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line;
        if (ast.getLineAndCharacterOfPosition(node.end).line - start + 1 > 80)
          throw new Error('Watchlist function budget ' + name);
      }
      ts.forEachChild(node, inspect);
    };
    inspect(ast);
  }
  return true;
}

export function exportsAndPolicies(root: string): boolean {
  const { ast } = facade(root),
    runtime: string[] = [],
    types: string[] = [];
  for (const node of ast.statements) {
    if (ts.isExportDeclaration(node)) {
      if (
        !node.isTypeOnly ||
        !node.exportClause ||
        !ts.isNamedExports(node.exportClause) ||
        !node.moduleSpecifier ||
        !ts.isStringLiteral(node.moduleSpecifier) ||
        node.moduleSpecifier.text !== './tracker-watchlist.contracts.js'
      )
        throw new Error('Unexpected Watchlist type export');
      types.push(...node.exportClause.elements.map((n) => n.name.text));
    } else if (
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      if (ts.isVariableStatement(node))
        runtime.push(...node.declarationList.declarations.map((d) => d.name.getText(ast)));
      else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name)
        runtime.push(node.name.text);
      else throw new Error('Unexpected Watchlist runtime export');
    }
  }
  if (
    digest(types) !== digest(typeNames) ||
    digest(runtime) !==
      digest([
        'HEARING_TERMS_TOPIC_LABEL',
        'isReservedTopicLabel',
        'DEFAULT_TRIGGERS',
        'TrackerWatchlistService',
      ])
  )
    throw new Error('Original Watchlist export names changed');
  const interfaces = source(root, 'tracker-watchlist.contracts.ts')
    .ast.statements.filter(ts.isInterfaceDeclaration)
    .filter((n) => typeNames.includes(n.name.text));
  if (digest(interfaces.map(shape)) !== originalPins.publicTypes)
    throw new Error('Original interface contract changed');
  const declarations = ast.statements
    .filter(ts.isVariableStatement)
    .flatMap((n) => [...n.declarationList.declarations]);
  const original = declarations.filter((n) => dataNames.includes(n.name.getText(ast)));
  const owners = declarations.filter((n) => !dataNames.includes(n.name.getText(ast)));
  if (
    owners.length !== 4 ||
    digest(
      owners.map((n) => ({ name: n.name.getText(ast), initializer: shape(n.initializer) })),
    ) !== originalPins.ownerWiring
  )
    throw new Error('Concrete owner policy wiring changed');
  const lastData = Math.max(...original.map((n) => n.end));
  if (owners.some((n) => n.getStart(ast) < lastData))
    throw new Error('Owner allocation precedes original data');
  return true;
}
export function noCapturedRoot(root: string): boolean {
  for (const file of modules.slice(1)) {
    const { ast } = source(root, file);
    for (const node of ast.statements.filter(ts.isImportDeclaration)) {
      if (
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === './tracker-watchlist.service.js' &&
        !node.importClause?.isTypeOnly
      )
        throw new Error('Runtime Root import cycle ' + file);
    }
    const inspect = (node: ts.Node) => {
      if (
        ts.isConstructorDeclaration(node) &&
        node.parameters.some(
          (p) =>
            p.name.getText(ast) === 'host' || p.type?.getText(ast) === 'TrackerWatchlistService',
        )
      )
        throw new Error('Constructor-captured Root ' + file);
      if (ts.isPropertyDeclaration(node))
        throw new Error('Unexpected owner instance field ' + file);
      if (
        ts.isPropertyAccessExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ThisKeyword &&
        node.name.text === 'host'
      )
        throw new Error('Captured Root field ' + file);
      ts.forEachChild(node, inspect);
    };
    inspect(ast);
  }
  return true;
}

export function retainedWatchlistAsset(root: string): boolean {
  retainedRootContract(root);
  wrapperContract(root);
  exportsAndPolicies(root);
  noCapturedRoot(root);
  moduleBudgets(root);
  retainedWatchlistBodies(root);
  noDuplicateOriginalBodies(root);
  return true;
}
