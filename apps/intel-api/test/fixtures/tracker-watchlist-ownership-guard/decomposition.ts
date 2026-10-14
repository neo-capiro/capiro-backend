import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { bodyPins, phaseWiringPin } from './pins.js';

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
interface Parsed {
  text: string;
  ast: ts.SourceFile;
}
function parse(root: string, file: string): Parsed {
  const text = readFileSync(join(root, 'apps/intel-api/src/tracker', file), 'utf8');
  return { text, ast: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true) };
}
function method(source: Parsed, name: string): ts.MethodDeclaration {
  const owner = source.ast.statements.find(ts.isClassDeclaration);
  const node = owner?.members.find(
    (n): n is ts.MethodDeclaration =>
      ts.isMethodDeclaration(n) && n.name.getText(source.ast) === name,
  );
  if (!node?.body) throw new Error('Missing operation ' + name);
  return node;
}
function func(source: Parsed, name: string): ts.FunctionDeclaration {
  const node = source.ast.statements.find(
    (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name,
  );
  if (!node?.body) throw new Error('Missing phase ' + name);
  return node;
}
function reverse(node: ts.Node): ts.Node {
  return ts.transform(node, [
    (context) => (root) => {
      const visit = (n: ts.Node): ts.Node => {
        if (
          ts.isElementAccessExpression(n) &&
          !n.questionDotToken &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === 'host' &&
          ts.isStringLiteral(n.argumentExpression)
        )
          return ts.factory.createPropertyAccessExpression(
            ts.factory.createThis(),
            n.argumentExpression.text,
          );
        if (
          ts.isCallExpression(n) &&
          !n.questionDotToken &&
          n.arguments.length === 0 &&
          !n.typeArguments?.length &&
          ts.isPropertyAccessExpression(n.expression) &&
          !n.expression.questionDotToken
        ) {
          const text = n.expression.getText();
          if (text === 'this.defaults') return ts.factory.createIdentifier('DEFAULT_TRIGGERS');
          if (text === 'this.policy.hearingLabel' || text === 'policy.hearingLabel')
            return ts.factory.createIdentifier('HEARING_TERMS_TOPIC_LABEL');
        }
        if (ts.isPropertyAccessExpression(n)) {
          const text = n.getText();
          if (text === 'this.policy.uuid') return ts.factory.createIdentifier('UUID_RE');
          if (text === 'policy.requiredFrom')
            return ts.factory.createIdentifier('EXPECTED_VERSION_REQUIRED_FROM');
          if (text === 'policy.reservedLabel')
            return ts.factory.createIdentifier('isReservedTopicLabel');
        }
        return ts.visitEachChild(n, visit, context);
      };
      return ts.visitNode(root, visit) as ts.Node;
    },
  ]).transformed[0]!;
}
function strings(nodes: readonly ts.Node[], source: Parsed, undo = true): string[] {
  return nodes.map((node) =>
    printer.printNode(ts.EmitHint.Unspecified, undo ? reverse(node) : node, source.ast),
  );
}
function shape(node: ts.Node): unknown {
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
function decisions(nodes: readonly ts.Node[]): unknown[] {
  // Nodes retain their own source's tokens even when phase statements are composed.
  return nodes.map((node) => shape(reverse(node)));
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function check(name: keyof typeof bodyPins, nodes: readonly ts.Node[], source: Parsed): void {
  if (digest(decisions(nodes)) !== bodyPins[name])
    throw new Error('Original decisions changed: ' + String(name) + ' in ' + source.ast.fileName);
}
type PhaseFiles = Record<'read' | 'write' | 'input' | 'head' | 'topics' | 'finish', Parsed>;
function checkRead(read: Parsed): void {
  const rb = [...method(read, 'getWatchlist').body!.statements];
  const cold = method(read, 'coldView').body!.statements,
    present = method(read, 'presentTopics').body!.statements;
  const coldIf = rb[2];
  if (!coldIf || !ts.isIfStatement(coldIf) || !ts.isBlock(coldIf.thenStatement))
    throw new Error('Cold branch shape');
  if (cold.length !== 1 || coldIf.thenStatement.statements.length !== 3)
    throw new Error('Cold branch statement accounting');
  rb[2] = ts.factory.updateIfStatement(
    coldIf,
    coldIf.expression,
    ts.factory.createBlock([...coldIf.thenStatement.statements.slice(0, 2), cold[0]!], true),
    undefined,
  );
  rb.splice(6, 1, ...present.slice(0, -1));
  check('getWatchlist', rb, read);
}
function reconstructTransaction(files: PhaseFiles) {
  const { write, head, topics, finish } = files;
  const wb = [...method(write, 'putWatchlist').body!.statements];
  const txStatement = wb[5];
  if (
    !txStatement ||
    !ts.isExpressionStatement(txStatement) ||
    !ts.isAwaitExpression(txStatement.expression) ||
    !ts.isCallExpression(txStatement.expression.expression)
  )
    throw new Error('Single awaited tenant transaction');
  const call = txStatement.expression.expression,
    callback = call.arguments[1];
  if (!callback || !ts.isArrowFunction(callback) || !ts.isBlock(callback.body))
    throw new Error('Tenant callback shape');
  const tx = [...callback.body.statements];
  const version = func(head, 'validateWatchlistVersion').body!.statements;
  const upsert = func(head, 'upsertWatchlistHead').body!.statements;
  if (
    upsert.length !== 2 ||
    !upsert[1] ||
    !ts.isReturnStatement(upsert[1]) ||
    !upsert[1].expression ||
    !ts.isCallExpression(upsert[1].expression) ||
    upsert[1].expression.expression.getText(head.ast) !== 'tx.watchlist.upsert'
  )
    throw new Error('Head write missing or unreachable');
  const topicIndex = func(head, 'indexWatchlistTopics').body!.statements;
  const termIndex = func(head, 'indexWatchlistTerms').body!.statements;
  const reserved = func(topics, 'rejectReservedTopics').body!.statements;
  const renamed = func(topics, 'renameWatchlistTopics').body!.statements;
  const upserted = func(topics, 'upsertWatchlistTopics').body!.statements;
  const finished = func(finish, 'finishWatchlistReconcile').body!.statements;
  const fs = finished.slice(1, -1),
    goneStatement = fs[3];
  if (!goneStatement || !ts.isVariableStatement(goneStatement))
    throw new Error('Removed-label projection shape');
  const gone = goneStatement.declarationList.declarations[0];
  if (!gone?.initializer) throw new Error('Removed-label initializer');
  fs[3] = ts.factory.createExpressionStatement(
    ts.factory.createAssignment(ts.factory.createIdentifier('goneLabels'), gone.initializer),
  );
  const reconstructedTx = [
    tx[0]!,
    ...version.slice(1, -1),
    ts.factory.createExpressionStatement(ts.factory.createAwaitExpression(upsert[1].expression)),
    tx[3]!,
    ...topicIndex.slice(0, -1),
    tx[5]!,
    ...termIndex.slice(0, -1),
    ...reserved.slice(1),
    ...renamed.slice(1, -1),
    ...upserted.slice(1),
    ...fs,
  ];
  check('putTransaction', reconstructedTx, write);
  return { wb, call, callback, reconstructedTx };
}
function checkWrite(files: PhaseFiles, contracts: Parsed): void {
  const { write, input } = files;
  const { wb, call, callback, reconstructedTx } = reconstructTransaction(files);
  const normal = func(input, 'normalizeWatchlistInput').body!.statements;
  const incoming = func(input, 'normalizeIncomingTopics').body!.statements;
  const originalIncoming = contracts.ast.statements.find(
    (n): n is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(n) && n.name.text === 'IncomingTopic',
  );
  if (!originalIncoming) throw new Error('Original local incoming type missing');
  const local = ts.factory.updateInterfaceDeclaration(
    originalIncoming,
    undefined,
    originalIncoming.name,
    originalIncoming.typeParameters,
    originalIncoming.heritageClauses,
    originalIncoming.members,
  );
  const expandedCall = ts.factory.updateCallExpression(call, call.expression, undefined, [
    call.arguments[0]!,
    ts.factory.updateArrowFunction(
      callback,
      callback.modifiers,
      callback.typeParameters,
      callback.parameters,
      callback.type,
      callback.equalsGreaterThanToken,
      ts.factory.createBlock(reconstructedTx, true),
    ),
  ]);
  check(
    'putWatchlist',
    [
      ...wb.slice(0, 2),
      ...normal.slice(0, 6),
      local,
      ...incoming.slice(0, -1),
      wb[4]!,
      ts.factory.createExpressionStatement(ts.factory.createAwaitExpression(expandedCall)),
      ...wb.slice(6),
    ],
    write,
  );
}
export function retainedWatchlistBodies(root: string): boolean {
  const read = parse(root, 'tracker-watchlist-read.ts'),
    write = parse(root, 'tracker-watchlist-write.ts');
  const input = parse(root, 'tracker-watchlist-input.ts'),
    head = parse(root, 'tracker-watchlist-reconcile-head.ts');
  const topics = parse(root, 'tracker-watchlist-reconcile-topics.ts'),
    finish = parse(root, 'tracker-watchlist-reconcile-finish.ts');
  const contracts = parse(root, 'tracker-watchlist.contracts.ts');
  const files = { read, write, input, head, topics, finish };
  checkRead(read);
  checkWrite(files, contracts);
  checkWiring(files);
  for (const name of [
    'getSectorSuggestion',
    'resolveUserName',
    'getRevisions',
    'suggestedJurisdictions',
  ] as const)
    check(name, method(read, name).body!.statements, read);
  const prefs = parse(root, 'tracker-watchlist-preferences.ts');
  for (const name of ['getAlertPrefs', 'putAlertPrefs', 'markPhoneVerified'] as const)
    check(name, method(prefs, name).body!.statements, prefs);
  const compiled = parse(root, 'tracker-watchlist-compiled.ts');
  check('getCompiled', method(compiled, 'getCompiled').body!.statements, compiled);
  return true;
}
function checkWiring(
  files: Record<'read' | 'write' | 'input' | 'head' | 'topics' | 'finish', Parsed>,
): void {
  const { read, write, input, head, topics, finish } = files;
  const rb = method(read, 'getWatchlist').body!.statements;
  const wb = method(write, 'putWatchlist').body!.statements;
  const cold = rb[2] as ts.IfStatement;
  const call = (wb[5] as ts.ExpressionStatement).expression as ts.AwaitExpression;
  const tx = ((call.expression as ts.CallExpression).arguments[1] as ts.ArrowFunction)
    .body as ts.Block;
  const bodies = {
    readCalls: strings(
      [
        (cold.thenStatement as ts.Block).statements[2]!,
        rb[6]!,
        method(read, 'presentTopics').body!.statements.at(-1)!,
      ],
      read,
      false,
    ),
    writeCalls: strings(wb.slice(2, 4), write, false),
    transactionCalls: strings(tx.statements, write, false),
    inputReturn: strings(
      func(input, 'normalizeWatchlistInput').body!.statements.slice(6),
      input,
      false,
    ),
    incomingReturn: strings(
      func(input, 'normalizeIncomingTopics').body!.statements.slice(-1),
      input,
      false,
    ),
    headFrames: ['validateWatchlistVersion', 'upsertWatchlistHead'].map((name) =>
      strings(func(head, name).body!.statements.slice(0, 1), head, false),
    ),
    versionReturn: strings(
      func(head, 'validateWatchlistVersion').body!.statements.slice(-1),
      head,
      false,
    ),
    indexReturns: ['indexWatchlistTopics', 'indexWatchlistTerms'].map((name) =>
      strings(func(head, name).body!.statements.slice(-1), head, false),
    ),
    topicFrames: ['rejectReservedTopics', 'renameWatchlistTopics', 'upsertWatchlistTopics'].map(
      (name) => strings(func(topics, name).body!.statements.slice(0, 1), topics, false),
    ),
    renameReturn: strings(
      func(topics, 'renameWatchlistTopics').body!.statements.slice(-1),
      topics,
      false,
    ),
    finishFrame: strings(
      [
        func(finish, 'finishWatchlistReconcile').body!.statements[0]!,
        func(finish, 'finishWatchlistReconcile').body!.statements.at(-1)!,
      ],
      finish,
      false,
    ),
  };
  const phaseHeaders = phaseSignatures(files);
  if (digest({ bodies, phaseHeaders }) !== phaseWiringPin)
    throw new Error('Actual phase calls or binding frames changed');
}

export function noDuplicateOriginalBodies(root: string): boolean {
  const owners: Record<string, string> = {
    getWatchlist: 'read',
    getSectorSuggestion: 'read',
    resolveUserName: 'read',
    getRevisions: 'read',
    suggestedJurisdictions: 'read',
    putWatchlist: 'write',
    getAlertPrefs: 'preferences',
    putAlertPrefs: 'preferences',
    markPhoneVerified: 'preferences',
    getCompiled: 'compiled',
    assertCanEditTargeting: 'service',
    assertClientInTenant: 'service',
    assertAlertInClient: 'service',
    assertTenantMember: 'service',
    assertPrefRowTenant: 'service',
  };
  const files = [
    'service',
    'read',
    'write',
    'preferences',
    'compiled',
    'input',
    'reconcile-head',
    'reconcile-topics',
    'reconcile-finish',
  ];
  for (const owner of files) {
    const source = parse(
      root,
      owner === 'service' ? 'tracker-watchlist.service.ts' : 'tracker-watchlist-' + owner + '.ts',
    );
    const inspect = (node: ts.Node) => {
      if (ts.isFunctionLike(node) && 'body' in node && node.body && ts.isBlock(node.body)) {
        const value = digest(decisions(node.body.statements));
        for (const [name, hash] of Object.entries(bodyPins)) {
          if (value !== hash) continue;
          const named =
            'name' in node && node.name && ts.isIdentifier(node.name) ? node.name.text : null;
          if (named !== name || owners[name] !== owner)
            throw new Error('Duplicate original implementation ' + name);
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source.ast);
  }
  return true;
}

function phaseSignatures(files: PhaseFiles): string[] {
  return Object.values(files).flatMap((source) => {
    const declarations = source.ast.statements.filter(ts.isFunctionDeclaration);
    return declarations.map((node) =>
      printer.printNode(
        ts.EmitHint.Unspecified,
        ts.factory.updateFunctionDeclaration(
          node,
          node.modifiers,
          node.asteriskToken,
          node.name,
          node.typeParameters,
          node.parameters,
          node.type,
          undefined,
        ),
        source.ast,
      ),
    );
  });
}
