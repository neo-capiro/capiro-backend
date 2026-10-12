const assert = require('node:assert/strict'), fs = require('node:fs'), cp = require('node:child_process'), crypto = require('node:crypto'), ts = require('typescript');
const base = '802bbd0b2c510a44e46a9952d8127e7edc55aaaa', head = 'd3e0efacf59fb64361c612c01da5ae8a6f19e426';
const OUT = 'docs/cleanup-meri-local-dispatch-independent-review-20261012/evidence/';
const sourcePath = 'apps/api/src/meri/meri-tools.service.ts';
const old = cp.execFileSync('git', ['show', base + ':' + sourcePath], { encoding: 'utf8' }), current = fs.readFileSync(sourcePath, 'utf8');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const parse = s => ts.createSourceFile('owner.ts', s, ts.ScriptTarget.Latest, true);
function method(text) { const ast = parse(text), owner = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'MeriToolsService'); return { ast, method: owner.members.find(n => n.name?.getText(ast) === 'executeScoped') }; }
const b = method(old), a = method(current);
const oracle = JSON.parse(fs.readFileSync('docs/cleanup-meri-local-dispatch-conversion-20261012/evidence/before-dispatch-oracle.json', 'utf8'));
assert.equal(b.method.getText(b.ast), oracle.executeScoped);
assert.equal(hash(b.method.getText(b.ast)), 'a67ef2db537d518a176a734e7f0d89395e521122d731ab5e9da06bf243b71a41');
const strip = (s, value) => s.slice(0, value.method.body.getStart(value.ast)) + '<body>' + s.slice(value.method.body.end);
const addedImport = "import { executeMeriLocalDispatch, type MeriLocalDispatchRegistry } from './meri-local-dispatch.js';\n";
assert.equal(strip(current, a).replace(addedImport, ''), strip(old, b));
assert(a.method.modifiers.some(m => m.kind === ts.SyntaxKind.AsyncKeyword));
assert.equal(a.method.body.statements[0].getText(a.ast), b.method.body.statements[0].getText(b.ast));
assert.equal(a.method.body.statements[0].getText(a.ast), 'assertMeriToolRequestActive();');
const sw = b.method.body.statements.find(ts.isSwitchStatement), groups = new Map(); let pending = [];
for (const clause of sw.caseBlock.clauses) {
  if (ts.isCaseClause(clause)) pending.push(clause.expression.text);
  if (clause.statements.length) { for (const key of pending) groups.set(key, [...clause.statements]); pending = []; }
}
assert.equal(groups.size, 134);
let table, rp, legi;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(a.ast) === 'registry') table = node.initializer.expression;
  if (ts.isVariableDeclaration(node) && node.name.getText(a.ast) === 'researchPortfolio') rp = node.initializer;
  if (ts.isVariableDeclaration(node) && node.name.getText(a.ast) === 'legiwatch') legi = node.initializer;
  ts.forEachChild(node, visit);
} visit(a.method);
assert(ts.isObjectLiteralExpression(table));
assert.equal(rp.parameters[0].type.getText(a.ast), "Parameters<ResearchPortfolioMeriToolsService['execute']>[1]");
assert.equal(rp.body.statements[0].getText(a.ast), groups.get('get_research_portfolio')[0].getText(b.ast));
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const print = (node, sf) => printer.printNode(ts.EmitHint.Unspecified, node, sf);
let rps = 0;
for (const property of table.properties) {
  assert(ts.isPropertyAssignment(property)); const name = property.name.getText(a.ast), original = groups.get(name); assert(original);
  const fn = property.initializer;
  if (ts.isIdentifier(fn)) { assert.equal(fn.text, 'legiwatch'); assert.equal(print(legi.body, a.ast), print(original[0].expression, b.ast)); }
  else {
    assert(ts.isArrowFunction(fn)); assert(!fn.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)); assert.equal(fn.parameters.length, 0);
    if (ts.isCallExpression(fn.body) && fn.body.expression.getText(a.ast) === 'researchPortfolio') { assert.equal(fn.body.arguments[0].text, name); rps++; }
    else if (ts.isBlock(fn.body)) assert.deepEqual(fn.body.statements.map(n => print(n, a.ast)), original.map(n => print(n, b.ast)));
    else { assert.equal(original.length, 1); assert(ts.isReturnStatement(original[0])); assert.equal(print(fn.body, a.ast), print(original[0].expression, b.ast)); }
  }
}
assert.equal(rps, 19); assert.deepEqual(table.properties.map(p => p.name.getText(a.ast)), [...groups.keys()]);
const sharedPath = 'packages/shared/src/index.ts', shared = fs.readFileSync(sharedPath, 'utf8'), sharedAst = parse(shared); let registry;
function find(node) { if (ts.isVariableDeclaration(node) && node.name.getText(sharedAst) === 'MERI_CAPABILITY_REGISTRY') { let value = node.initializer; while (!ts.isArrayLiteralExpression(value)) value = value.expression; registry = value; } ts.forEachChild(node, find); } find(sharedAst);
const entries = registry.elements.map(e => Object.fromEntries(e.properties.filter(p => ts.isPropertyAssignment(p) && ['name', 'backend'].includes(p.name.getText(sharedAst))).map(p => [p.name.getText(sharedAst), p.initializer.text])));
const core = entries.filter(e => e.backend === 'meri').map(e => e.name), proxy = entries.filter(e => e.backend === 'federal_market').map(e => e.name);
assert.equal(core.length, 134); assert.equal(proxy.length, 5); assert.equal(entries.length, 139); assert.deepEqual([...groups.keys()].sort(), [...core].sort());
const protectedPaths = [sharedPath, 'packages/shared/package.json', 'apps/api/src/meri/governed-meri-tools.proxy.ts', 'apps/api/src/meri/meri.module.ts', 'apps/api/src/meri/meri-tool-request-control.ts', 'apps/api/src/meri/meri-rp-tool-transport.ts', 'apps/api/src/meri/meri-tools.registration.spec.ts', 'apps/api/src/meri/meri-tool-manifest.parity.spec.ts', 'scripts/strategy-time-boundaries.json'];
for (const p of protectedPaths) assert(fs.readFileSync(p).equals(cp.execFileSync('git', ['show', base + ':' + p])));
const result = { source: head, tree: cp.execFileSync('git', ['rev-parse', head + '^{tree}']).toString().trim(), base,
  originalSwitchSha256: hash(b.method.getText(b.ast)), originalMethodAndOracleExact: true,
  actualOriginalSwitchCases: [...groups.keys()], sharedCoreNames: core, sharedProxyNames: proxy,
  caseCallbacksExactOriginalExpressionsAndStatements: 134, researchPortfolioLazyLiteralCalls: 19,
  narrowerRpTypeUsesCanonicalExecuteParameter: true, originalRpReturnStatementByteExact: true,
  asyncAndFirstActiveAssertionExact: true, wholeServiceOutsideBodyAndOneImportByteExact: true,
  proxyModuleSharedRequestCancellationAuthorityAndTestsPreserved: protectedPaths,
  sourceRuntimeApplicationGraphImported: false, databaseProviderCalls: 0 };
fs.writeFileSync(OUT + 'source-proof.json', JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result, null, 2));
