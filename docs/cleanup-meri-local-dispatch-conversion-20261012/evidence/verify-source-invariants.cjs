// Read-only AST/blob comparison. Never imports or evaluates the application graph.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ts = require(process.argv[2]);
const root = path.resolve(__dirname, '../../..');
const base = '802bbd0b2c510a44e46a9952d8127e7edc55aaaa';
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const before = (p) => cp.execFileSync('git', ['show', `${base}:${p}`], { cwd: root, encoding: 'utf8', maxBuffer: 4000000 });
const sourcePath = 'apps/api/src/meri/meri-tools.service.ts';
const old = before(sourcePath), current = read(sourcePath);
function parse(s) { return ts.createSourceFile('source.ts', s, ts.ScriptTarget.Latest, true); }
function ownerMethod(s, methodName) {
  const sf = parse(s); const cls = sf.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'MeriToolsService');
  const method = cls.members.find(n => n.name?.getText(sf) === methodName); return { sf, method };
}
const o = ownerMethod(old, 'executeScoped'), n = ownerMethod(current, 'executeScoped');
const newImport = "import { executeMeriLocalDispatch, type MeriLocalDispatchRegistry } from './meri-local-dispatch.js';\n";
assert(current.includes(newImport));
const stripBody = (s, a) => s.slice(0, a.method.body.getStart(a.sf)) + '<dispatch-body>' + s.slice(a.method.body.end);
assert.equal(stripBody(current, n).replace(newImport, ''), stripBody(old, o));
const oracle = JSON.parse(read('docs/cleanup-meri-local-dispatch-conversion-20261012/evidence/before-dispatch-oracle.json'));
assert.equal(o.method.getText(o.sf), oracle.executeScoped);
assert.equal(oracle.outsideMethodSha256, hash(stripBody(old, o)));
assert.equal(oracle.sourceSha256, hash(old));
let table, researchStatement;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(n.sf) === 'registry') table = node.initializer.expression;
  if (ts.isVariableDeclaration(node) && node.name.getText(n.sf) === 'researchPortfolio') researchStatement = node.initializer.body.statements[0].getText(n.sf);
  ts.forEachChild(node, visit);
} visit(n.method);
assert.equal(researchStatement, oracle.groups[0].statements);
const actualNames = table.properties.map(p => p.name.getText(n.sf));
assert.deepEqual(actualNames, oracle.groups.flatMap(g => g.names));
const sharedPath = 'packages/shared/src/index.ts'; const shared = read(sharedPath); const sharedAST = parse(shared);
let registry;
function findRegistry(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(sharedAST) === 'MERI_CAPABILITY_REGISTRY') {
    let value = node.initializer; while (!ts.isArrayLiteralExpression(value)) value = value.expression; registry = value;
  } ts.forEachChild(node, findRegistry);
} findRegistry(sharedAST);
const capabilities = registry.elements.map(e => Object.fromEntries(e.properties.filter(p => ts.isPropertyAssignment(p) && ['name', 'backend'].includes(p.name.getText(sharedAST))).map(p => [p.name.getText(sharedAST), p.initializer.text])));
const core = capabilities.filter(c => c.backend === 'meri').map(c => c.name);
const proxy = capabilities.filter(c => c.backend === 'federal_market').map(c => c.name);
assert.equal(core.length, 134); assert.equal(proxy.length, 5); assert.deepEqual([...actualNames].sort(), core.sort());
assert.equal(new Set([...core, ...proxy]).size, 139);
assert(!proxy.some(p => actualNames.includes(p)));
const preserved = [
  sharedPath, 'packages/shared/package.json',
  'apps/api/src/meri/governed-meri-tools.proxy.ts', 'apps/api/src/meri/meri.module.ts',
  'apps/api/src/meri/meri-tool-request-control.ts', 'apps/api/src/meri/meri-rp-tool-transport.ts',
  'apps/api/src/meri/meri-tools.registration.spec.ts', 'apps/api/src/meri/meri-tool-manifest.parity.spec.ts',
  'docs/cleanup-source-gates-20261012/evidence/meri-catalog-baseline.json',
  'docs/cleanup-source-gates-20261012/evidence/meri-catalog-baseline.command.json',
  'docs/cleanup-source-gates-20261012/evidence/meri-catalog-baseline-classification.json',
];
const preservedBlobs = preserved.map(p => {
  const original = before(p), selected = read(p); assert.equal(selected, original, p);
  return { path: p, gitBlob: cp.execFileSync('git', ['rev-parse', `${base}:${p}`], {cwd:root,encoding:'utf8'}).trim(), sha256: hash(selected) };
});
const helperPath = 'apps/api/src/meri/meri-local-dispatch.ts';
const helper = read(helperPath); const helperAST = parse(helper);
assert(helperAST.statements.filter(ts.isImportDeclaration).every(i => i.importClause?.isTypeOnly));
assert.equal(helperAST.statements.filter(ts.isFunctionDeclaration).length, 1);
console.log(JSON.stringify({ base, baseTree: cp.execFileSync('git',['rev-parse',`${base}^{tree}`],{cwd:root,encoding:'utf8'}).trim(),
  sourcePath, originalServiceBlob: oracle.sourceBlob, originalServiceSha256: hash(old),
  outsideBodySha256: hash(stripBody(old,o)), frozenSwitchSha256: hash(oracle.executeScoped),
  currentMethodSha256: hash(n.method.getText(n.sf)), researchReturnByteEqual: true,
  helperRuntimeImports: 0, coreCount: core.length, coreNames: actualNames, proxyCount:proxy.length, proxyNames: proxy,
  preservedBlobs, result: 'PASS source structure and byte preservation only' }, null, 2));
