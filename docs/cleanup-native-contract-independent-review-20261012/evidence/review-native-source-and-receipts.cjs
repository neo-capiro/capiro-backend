'use strict';
// Independent source/evidence controls only. No driver or application import.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const ts = require('/workspace/capirov2/node_modules/typescript');
const root = path.resolve(__dirname, '../../..');
const packet = 'docs/cleanup-native-contract-prerequisites-20261012';
const pin = '3c28ed933722ce896d6ba421236219001bea9ae5';
const sourcePin = 'b9dceb71e42d4e520760125d070542362dbaacdf';
const productPin = '277053c8196dc1be4789c42ea304b0de0553fe00';
const git = (...args) => cp.execFileSync('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
const blob = (p, head = pin) => git('show', `${head}:${p}`);
const text = (p) => blob(`${packet}/${p}`).toString();
const json = (p) => JSON.parse(text(p));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const evidenceBindings = json('SHA256SUMS-NATIVE-PG.json');
for (const row of evidenceBindings.entries) {
  const b = blob(`${packet}/${row.path}`);
  assert.equal(b.length, row.bytes);
  assert.equal(sha(b), row.sha256);
}
const source = json('source-bindings.json');
assert.equal(source.sourceHead, productPin);
assert.equal(source.entries.length, 59);
for (const row of source.entries) {
  assert(!row.path.endsWith('/engagement.service.ts'), 'Protected source is not part of this loader');
  const b = blob(row.path, productPin);
  assert.equal(b.length, row.bytes);
  assert.equal(sha(b), row.sha256);
  assert.equal(git('rev-parse', `${productPin}:${row.path}`).toString().trim(), row.gitBlob);
  assert.equal(git('rev-parse', `HEAD:${row.path}`).toString().trim(), row.gitBlob);
}
const harnessPaths = ['canonical-loader.cjs', 'fixture-assembly.cjs', 'native-contract-harness.cjs', 'native-contract-harness.test.cjs', 'parent-fixture.sql', 'source-bindings.json'];
for (const p of harnessPaths) assert.deepEqual(blob(`${packet}/${p}`), blob(`${packet}/${p}`, sourcePin));
const run = json('evidence/native-run-attempt-0.json');
const receipt = json('evidence/NATIVE-PG-ACCEPTANCE-RECEIPT.json');
const command = json('evidence/06-native-run-attempt-0.json');
const cleanup = json('evidence/AFTER-CLEANUP-TARGET.json');
const sourceText = text('native-contract-harness.cjs');
const ast = ts.createSourceFile('native-contract-harness.cjs', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
assert.equal(ast.parseDiagnostics.length, 0);
const records = [];
let connectNode;
function visit(n) {
  if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'record') {
    assert(ts.isStringLiteral(n.arguments[0])); records.push(n.arguments[0].text);
  }
  if (ts.isFunctionDeclaration(n) && n.name?.text === 'connect') { assert(!connectNode); connectNode = n; }
  ts.forEachChild(n, visit);
}
visit(ast);
assert.equal(records.length, 11);
assert.deepEqual(run.results.map((r) => r.name), records);
assert(run.results.every((r) => r.status === 'PASS'));
assert.equal(run.passed, 11); assert.equal(run.failed, 0);
assert.deepEqual(receipt.results, run.results);
assert.equal(command.exitCode, 0); assert.equal(command.signal, null); assert.equal(command.error, null);
assert.deepEqual(text('evidence/06-native-run-attempt-0.log').trim().split('\n'), records.map((s) => `PASS ${s}`));
assert.equal(run.loadedCanonicalFiles.length, 19);
assert.equal(new Set(run.loadedCanonicalFiles).size, 19);
assert(run.loadedCanonicalFiles.every((p) => source.entries.some((r) => r.path === p)));
for (const k of ['nativePrisma', 'fullMigrationReplay', 'productionRoleHardening']) assert.equal(run[k], false);
assert.equal(cleanup.cleanupVerified, true);
assert.deepEqual(cleanup.ownedSchemaRemaining, []); assert.deepEqual(cleanup.ownedRolesRemaining, []);
assert.deepEqual(cleanup.otherHarnessSessions, []); assert.equal(cleanup.publicTables, 0);
for (const k of Object.keys(run.target).filter((s) => !['port', 'socketDirectory'].includes(s))) assert.equal(cleanup.target[k], run.target[k]);
const cleanAst = ts.createSourceFile('cleanup.cjs', text('evidence/after-cleanup-probe.cjs'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const cleanupSql = [];
function sqlVisit(n) {
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'query') {
    assert(ts.isStringLiteral(n.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(n.arguments[0]));
    cleanupSql.push(n.arguments[0].text);
  }
  ts.forEachChild(n, sqlVisit);
}
sqlVisit(cleanAst);
assert.equal(cleanupSql.length, 5); assert(cleanupSql.every((s) => s.startsWith('SELECT ')));
// Historical wrapper misclassification is retained, not silently interpreted.
assert.equal(json('evidence/07-after-cleanup-probe.json').noDatabaseRun, true);
assert(receipt.metadataErratum.includes('FIVE read-only SQL SELECTs'));

const controls = [];
const passed = (name) => controls.push({ name, status: 'PASS' });
let driverLoads = 0, ownerLoads = 0;
const fakeFs = { realpathSync: (v) => v, existsSync: () => false, readFileSync: () => { throw new Error('Unexpected filesystem read'); } };
const exported = { exports: {} };
const sandbox = {
  module: exported, exports: exported.exports, console: { log() {}, error() {} },
  process: { argv: [], exitCode: undefined },
  require: (name) => {
    if (name === 'node:fs') return fakeFs;
    if (name === 'node:path') return path;
    if (name === 'node:assert/strict') return assert;
    if (name === 'node:crypto') return crypto;
    if (name === './canonical-loader.cjs') return {
      apiRequire() { driverLoads++; throw new Error('Driver refused'); },
      verifyBindings() { throw new Error('Unexpected source load'); },
      loadCanonical() { ownerLoads++; throw new Error('Owner refused'); },
    };
    if (name === './fixture-assembly.cjs') return { assembleFixture() { throw new Error('Fixture refused'); } };
    throw new Error(`Unexpected import ${name}`);
  },
  __dirname: path.join(root, packet),
};
vm.runInNewContext(sourceText, sandbox, { filename: 'frozen-native-contract-harness.cjs' });
const h = exported.exports;
const target = h.TARGET;
const valid = { ...target, version: 'PostgreSQL 16.15 synthetic control', publicTables: 0 };
assert.equal(h.validateTarget(valid), target); passed('exact target accepted without driver');
for (const [key, value] of [
  ['dataDirectory', '/tmp/foreign'], ['user', 'foreign'], ['database', 'foreign'],
  ['systemIdentifier', '0'], ['listenAddresses', '*'], ['inetServerAddr', '127.0.0.1'],
  ['version', 'PostgreSQL 17.0'], ['publicTables', 1], ['publicTables', '0'],
]) { assert.throws(() => h.validateTarget({ ...valid, [key]: value })); passed(`target mismatch refused: ${key}/${String(value)}`); }
for (const key of ['password', 'connectionString', 'url']) { assert.throws(() => h.validateTarget({ ...valid, [key]: 'inert' })); passed(`credential input refused: ${key}`); }
for (const value of [null, [], undefined]) { assert.throws(() => h.validateTarget(value)); passed(`missing/nonobject target refused: ${String(value)}`); }
fakeFs.realpathSync = (v) => v === target.socketDirectory ? '/tmp/foreign' : v;
assert.throws(() => h.validateTarget(valid)); passed('symlinked socket refused');
fakeFs.realpathSync = (v) => v === target.dataDirectory ? '/tmp/foreign' : v;
assert.throws(() => h.validateTarget(valid)); passed('symlinked data directory refused');
fakeFs.realpathSync = (v) => v;
// Test the exact nested connect function with an inert Client, never node-pg.
const connectText = connectNode.getText(ast);
async function connectionControl(mismatch) {
  const queries = [];
  let options;
  class FakeClient {
    constructor(o) { options = o; }
    async connect() {}
    async query(s) {
      queries.push(s);
      return { rows: [{ ...target, ...(mismatch ? { [mismatch]: mismatch === 'inetServerAddr' ? '127.0.0.1' : 'wrong' } : {}) }] };
    }
  }
  const fn = new Function('Client', 'TARGET', 'open', 'SCHEMA', 'assert', `return (${connectText});`)(FakeClient, target, new Set(), run.schema, assert);
  if (mismatch) { await assert.rejects(() => fn('inert')); assert.equal(queries.length, 1); }
  else { await fn('inert'); assert.equal(queries.length, 2); assert(queries[1].startsWith('SET statement_timeout')); }
  assert.equal(options.host, target.socketDirectory); assert.equal(options.port, 5432);
  assert.equal(options.password, ''); assert.equal(options.ssl, false);
  assert.equal(options.connectionTimeoutMillis, 3000); assert.equal(options.query_timeout, 15000);
  passed(`exact connect identity guard: ${mismatch ?? 'canonical'}`);
}
async function main() {
  for (const key of [undefined, 'dataDirectory', 'listenAddresses', 'inetServerAddr', 'user', 'database', 'systemIdentifier']) await connectionControl(key);
  for (const args of [[], ['--help'], ['--unknown'], ['--run'], ['--run', '--run'], ['--plan', '--run'], ['--run', '--verified-target', 'unused', '--output', '/tmp/foreign.json']]) {
    await assert.rejects(() => h.main(args)); passed(`CLI refusal before imports: ${JSON.stringify(args)}`);
  }
  fakeFs.existsSync = () => true;
  await assert.rejects(() => h.main(['--run', '--verified-target', 'unused', '--output', path.join(root, packet, 'evidence/existing.json')]));
  passed('existing evidence output refused before target read');
  assert.equal(driverLoads, 0); assert.equal(ownerLoads, 0);
  const queries = [];
  const tx = h.adapter({ query: async (sql, values) => { queries.push({ sql, values }); return { rows: [], rowCount: 1 }; } });
  const hostile = "literal ' ; DROP TABLE never_executed";
  await tx.$queryRaw`SELECT ${hostile}::text,${7}`;
  assert.equal(queries[0].sql, 'SELECT $1::text,$2'); assert.deepEqual(Array.from(queries[0].values), [hostile, 7]);
  assert.equal(await tx.$executeRaw`UPDATE inert SET n=${1}`, 1); passed('exact tagged adapter uses parameters/rowCount');
  await assert.rejects(() => tx.client.findFirst({ where: { id: 'x' }, select: { id: true } }));
  await assert.rejects(() => tx.syncRun.findFirst({ where: { source: 'x', tenantId: 'x' }, orderBy: { startedAt: 'desc' }, select: {} }));
  passed('projection adapter rejects unsupported owner arguments');
  const output = {
    harnessSource: sourcePin, harnessTree: git('rev-parse', `${sourcePin}^{tree}`).toString().trim(),
    nativeEvidence: pin, nativeEvidenceTree: git('rev-parse', `${pin}^{tree}`).toString().trim(),
    productSource: productPin, independentControls: controls, passed: controls.length, failed: 0,
    nativeGroupsReviewed: records, nativeGroups: 11, nativeExitCode: 0, loadedCanonicalFiles: run.loadedCanonicalFiles,
    evidenceHashesVerified: evidenceBindings.entries.length, sourceHashesVerified: source.entries.length,
    sourceEqualAtMemoryReview: true, harnessSixFilesEqualFrozenSource: true,
    cleanupSelectCount: cleanupSql.length, cleanupStateZero: true,
    databaseDriverLoadedByReviewer: false, databaseOrSqlExecutedByReviewer: false,
    applicationOwnersExecutedByReviewer: false, actualPrismaAcceptance: false,
    limitations: [
      'Reported native run is author/root execution; no independent database replay.',
      'Deadlock writer repeats canonical SQL order; actual ClientsService method is not loaded.',
      'Fixture grants/minimal parents are prerequisites, not deployed Workspace RLS or grants.',
      'Strict synthetic NOLOGIN role differs from current deployed table-owner membership.',
      'Rich case qualifies account-invitation subset and five policy-presence flags only.',
      'Additional CASE-MATRIX rows/subcases and actual Prisma/full migrations remain open.',
    ],
  };
  fs.writeFileSync(path.join(__dirname, 'SOURCE-AND-RESULT-REVIEW.json'), JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify({ passed: output.passed, failed: 0, evidenceHashes: output.evidenceHashesVerified, sourceHashes: output.sourceHashesVerified, nativeGroups: 11, reviewerSql: false }));
}
main().catch((e) => { console.error(e.stack); process.exitCode = 1; });
