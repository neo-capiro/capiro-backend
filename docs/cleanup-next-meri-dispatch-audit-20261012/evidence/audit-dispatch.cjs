// Read-only TypeScript AST inventory. Never loads production modules or invokes tool owners.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const ts = require(process.argv[2]);
const root = path.resolve(__dirname, '../../..');
const frozenHead = '6a4b48e6286a270ab18c033eb4ccaf6f72f42c70';
const servicePath = 'apps/api/src/meri/meri-tools.service.ts';
const sharedPath = 'packages/shared/src/index.ts';
const git = (...args) => cp.execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function read(relative) {
  const text = fs.readFileSync(path.join(root, relative), 'utf8');
  const sf = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (sf.parseDiagnostics.length) throw new Error(`Parse errors in ${relative}`);
  return { text, sf };
}
const { text: service, sf } = read(servicePath);
const { sf: shared } = read(sharedPath);
const cls = sf.statements.find((n) => ts.isClassDeclaration(n) && n.name.text === 'MeriToolsService');
const method = cls.members.find((n) => n.name?.getText(sf) === 'executeScoped');
if (method.body.statements.length !== 2) throw new Error('Dispatch shape changed');
const guard = method.body.statements[0].getText(sf);
if (guard !== 'assertMeriToolRequestActive();') throw new Error('Dispatch activity boundary changed');
const switchNode = method.body.statements[1];
if (!ts.isSwitchStatement(switchNode) || switchNode.expression.getText(sf) !== 'name') throw new Error('Expected finite name switch');
const line = (node, source = sf) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
const calls = (node) => {
  const found = [];
  const visit = (n) => {
    if (ts.isCallExpression(n)) found.push({ target: n.expression.getText(sf), args: n.arguments.map((a) => a.getText(sf)), line: line(n) });
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
};
let pending = [];
const rows = [];
let defaultBody;
for (const clause of switchNode.caseBlock.clauses) {
  if (ts.isDefaultClause(clause)) {
    if (pending.length) throw new Error('Unexpected default fallthrough');
    defaultBody = clause.statements.map((n) => n.getText(sf)).join('\n');
    continue;
  }
  if (!ts.isStringLiteral(clause.expression)) throw new Error('Nonliteral tool name');
  pending.push({ name: clause.expression.text, caseLine: line(clause) });
  if (!clause.statements.length) continue;
  const body = clause.statements.map((n) => n.getText(sf)).join('\n');
  const group = pending.map((n) => n.name);
  for (const name of pending) rows.push({ ...name, bodyLine: line(clause.statements[0]), group, body, calls: calls(clause) });
  pending = [];
}
if (pending.length || defaultBody !== 'assertNever(name);') throw new Error('Dispatch default changed');
let registryDecl;
function findDecl(n) {
  if (ts.isVariableDeclaration(n) && n.name.getText(shared) === 'MERI_CAPABILITY_REGISTRY') registryDecl = n;
  ts.forEachChild(n, findDecl);
}
findDecl(shared);
let init = registryDecl.initializer;
while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
if (!ts.isArrayLiteralExpression(init)) throw new Error('Registry is no longer a finite literal');
const registry = init.elements.map((obj) => {
  const props = Object.fromEntries(obj.properties.filter(ts.isPropertyAssignment).map((n) => [n.name.getText(shared), n.initializer]));
  return { name: props.name.text, backend: props.backend.text, readOnly: props.readOnly.kind === ts.SyntaxKind.TrueKeyword, line: line(obj, shared), surfaces: props.surfaces.elements.map((n) => n.text) };
});
const core = registry.filter((n) => n.backend === 'meri');
const finiteNames = rows.map((n) => n.name);
const missing = core.filter((n) => !finiteNames.includes(n.name)).map((n) => n.name);
const extra = finiteNames.filter((name) => !core.some((n) => n.name === name));
if (new Set(finiteNames).size !== rows.length || missing.length || extra.length) throw new Error(`Registry mismatch: ${JSON.stringify({ missing, extra })}`);
const output = { frozenHead, frozenTree: git('rev-parse', `${frozenHead}^{tree}`), sourcePath: servicePath, guard, defaultBody, count: rows.length, coreRegistryCount: core.length, federalRegistryCount: registry.filter((n) => n.backend === 'federal_market').length, rows: rows.map((row) => ({ ...row, readOnly: core.find((n) => n.name === row.name).readOnly })) };
fs.writeFileSync(path.join(__dirname, 'dispatch-map.json'), JSON.stringify(output, null, 2) + '\n');
const md = ['# Frozen local dispatch map', '', `Source: \`${frozenHead}\`, \`${servicePath}\`. ${rows.length} literal cases; exact arguments and bodies are in dispatch-map.json.`, '', '| Tool | Case line | Terminal delegation (verbatim expression) | Side effect |', '| --- | ---: | --- | --- |'];
for (const row of output.rows) {
  const firstReturn = row.body.slice(row.body.indexOf('return ')).replace(/\s+/g, ' ');
  md.push(`| ${row.name} | ${row.caseLine} | \`${firstReturn.replaceAll('|', '\\|')}\` | ${row.readOnly ? 'readOnly' : 'write / side effect'} |`);
}
fs.writeFileSync(path.join(__dirname, 'DISPATCH-MAP.md'), md.join('\n') + '\n');
const paths = [servicePath, sharedPath, 'apps/api/src/meri/governed-meri-tools.proxy.ts', 'apps/api/src/meri/meri.module.ts', 'apps/api/src/meri/meri-tool-request-control.ts', 'apps/api/src/meri/meri-rp-tool-transport.ts', 'apps/api/src/meri/meri.service.ts', 'apps/api/src/meri/meri.controller.ts', 'apps/api/src/meri/meri-research.service.ts', 'apps/api/src/meri/meri-research-replay-authorization.ts', 'apps/api/src/meri/meri-action-proposal.service.ts', 'apps/api/src/meri/meri-v3-visual-analysis.service.ts', 'apps/api/src/meri/meri-tools.registration.spec.ts', 'apps/api/src/meri/meri-tool-manifest.parity.spec.ts', 'apps/api/src/meri/governed-meri-tools.proxy.spec.ts', 'apps/api/src/meri/governed-meri-tools.chart-scope.spec.ts', 'apps/api/src/meri/meri-tool-request-control.spec.ts', 'apps/api/src/meri/meri-tools.award-compatibility.spec.ts', 'apps/api/src/capabilities/capability-registry.ts', 'apps/api/src/capabilities/adapters/capability-tool-adapter.ts', 'docs/cleanup-source-gates-20261012/evidence/meri-catalog-baseline-classification.json', 'docs/cleanup-source-gates-20261012/evidence/meri-catalog-baseline.command.json', 'docs/cleanup-canonical-recovery-source-20261012/HANDOFF.md'];
const manifest = paths.map((relative) => {
  const bytes = fs.readFileSync(path.join(root, relative));
  const blob = git('hash-object', relative);
  const frozenBlob = git('rev-parse', `${frozenHead}:${relative}`);
  if (blob !== frozenBlob) throw new Error(`Audited source changed: ${relative}`);
  return { path: relative, blob, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, equalFrozen: true };
});
fs.writeFileSync(path.join(__dirname, 'source-manifest.json'), JSON.stringify({ frozenHead, files: manifest }, null, 2) + '\n');
fs.writeFileSync(path.join(__dirname, 'inventory-validation.json'), JSON.stringify({ frozenHead, check: 'read-only AST + frozen blob equality', serviceLines: service.split('\n').length - 1, literalCases: rows.length, uniqueCases: new Set(finiteNames).size, registryOwnerCounts: { meri: core.length, federal_market: registry.filter((n) => n.backend === 'federal_market').length }, missing, extra, executionArgCases: rows.filter((n) => n.body.includes('execution?')).map((n) => n.name), auditedSourceFiles: manifest.length, productionModulesLoaded: 0, toolOwnersInvoked: 0, nativeAcceptance: false }, null, 2) + '\n');
console.log(JSON.stringify({ literalCases: rows.length, coreRegistry: core.length, federalRegistry: registry.filter((n) => n.backend === 'federal_market').length, sourceFilesPreserved: manifest.length, nativeAcceptance: false }));
