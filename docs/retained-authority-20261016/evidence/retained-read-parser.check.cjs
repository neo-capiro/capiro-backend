// Small source-owner check; no Jest, DB, provider, credentials or installed trust.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict'), { createRequire } = require('node:module');
const task = path.resolve(__dirname, '..'), source = path.join(task, 'backend-retained-authority');
const dependencyRequire = createRequire(path.join(task, 'implementation-runtime/workspace/apps/api/package.json'));
const ts = dependencyRequire('typescript');
const jcsPath = path.resolve(task, '../task-4/meri-greenfield/node_modules/canonicalize/lib/canonicalize.js');
const jcsModule = require(jcsPath), canonicalize = typeof jcsModule === 'function' ? jcsModule : jcsModule.default;
assert.equal(typeof canonicalize, 'function');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hashes = {}, cache = new Map();
function load(relative) {
  if (cache.has(relative)) return cache.get(relative).exports;
  const bytes = fs.readFileSync(path.join(source, relative)); hashes[relative] = sha(bytes);
  const compiled = ts.transpileModule(bytes.toString('utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } });
  const module = { exports: {} }; cache.set(relative, module);
  const localRequire = id => {
    if (id === 'node:crypto' || id === 'node:util') return require(id);
    if (id === './core-retained-authority-probe.js') return load('packages/shared/src/core-retained-authority-probe.ts');
    throw new Error('Unexpected import ' + id);
  };
  new Function('require', 'module', 'exports', compiled.outputText)(localRequire, module, module.exports);
  return module.exports;
}
const owner = load('packages/shared/src/core-retained-read-request.ts');
const p = '11111111-1111-4111-8111-111111111111', c = '22222222-2222-4222-8222-222222222222';
const client = 'abcdefab-cdef-4abc-8def-abcdefabcdef', folder = '44444444-4444-4444-8444-444444444444';
function rp() { return { schemaVersion: 1, request: {}, context: {
  binding: { tenantId: 'claimed-tenant', actorId: 'claimed-actor', conversationId: c, runId: c, attemptId: c, workerId: c, writerFence: 1 },
  subject: { kind: 'entity', entityType: 'research-portfolio', entityIds: [p], tenantId: 'claimed-tenant', actorId: 'claimed-actor',
    authorizationDecisionId: c, policyRevision: 'policy', scopes: [{ tenantId: 'claimed-tenant', kind: 'public', resourceId: 'public', policyRevision: 'policy' }], rosterVersionId: null },
} }; }
function fl() { return { schemaVersion: 1, request: {}, context: { asOf: '2026-10-16T00:00:00.000Z',
  effectiveScope: { jurisdiction: 'FL', sessionKey: '', folderId: null, clientId: null }, clientResolution: null } }; }
const parse = (operation, body, issuer = false, provider = canonicalize) => owner.parseRetainedReadBody(operation, body, { issuer }, provider);
const results = [];
function check(name, run) { try { run(); results.push({ name, pass: true }); } catch (error) { results.push({ name, pass: false, error: error.message }); } }
function refuses(operation, body, status = 400, provider = canonicalize) { assert.throws(() => parse(operation, body, false, provider), error => error.status === status); }
check('RP Detail normalized and all three real-JCS digests', () => {
  const value = parse('get_research_portfolio', rp()); assert.deepEqual(value.normalizedArgs, { conversationId: c, portfolioId: p });
  assert.deepEqual(value.digests, { rawRequestSha256: sha(canonicalize(value.request)), normalizedArgsSha256: sha(canonicalize(value.normalizedArgs)), normalizationContextSha256: sha(canonicalize(value.context)) });
  assert(Object.isFrozen(value.context.subject.scopes[0]));
});
check('RP Changes trims cursor and defaults limit25', () => { const body = rp(); body.request.cursor = '  event  '; assert.deepEqual(parse('get_research_portfolio_changes', body).normalizedArgs, { conversationId: c, portfolioId: p, cursor: 'event', limit: 25 }); });
check('Florida defaults preserve empty session/nulls', () => { assert.deepEqual(parse('get_florida_budget_project', fl()).normalizedArgs, { q: '', fiscalYear: '2026-27', projectId: '', offset: 0, sessionKey: '', folderId: null, clientId: null }); });
check('Florida named client resolution and frozen offset conversion', () => {
  const body = fl(); body.request = { clientId: '  Name  ', folderId: folder, sessionKey: '  session  ', q: 'x'.repeat(201), offset: '0x10' };
  body.context.effectiveScope = { jurisdiction: 'FL', sessionKey: '  session  ', folderId: folder, clientId: client }; body.context.clientResolution = { selector: 'Name', clientId: client };
  const value = parse('get_florida_budget_project', body); assert.equal(value.normalizedArgs.clientId, client); assert.equal(value.normalizedArgs.offset, 16); assert.equal(value.normalizedArgs.q.length, 200); assert.equal(value.selector.clientSelector, 'Name');
});
check('Real-JCS Unicode string without byte substitution', () => { const body = rp(); body.context.subject.scopes[0].resourceId = 'public🚀'; const value = parse('get_research_portfolio', body); assert.equal(value.digests.normalizationContextSha256, sha(canonicalize(value.context))); });
check('Issuer preserves exact original expiry', () => { const body = rp(); body.originalExpiresAtMs = 1234; assert.equal(parse('get_research_portfolio', body, true).originalExpiresAtMs, 1234); });
check('Getter rejected without invocation', () => { const body = rp(); let calls = 0; Object.defineProperty(body.request, 'conversationId', { enumerable: true, get() { calls++; return c; } }); refuses('get_research_portfolio', body); assert.equal(calls, 0); });
check('Proxy rejected without traps', () => { let calls = 0; const body = new Proxy(rp(), { ownKeys() { calls++; return []; } }); refuses('get_research_portfolio', body); assert.equal(calls, 0); });
check('Subject scope policy mismatch rejected', () => { const body = rp(); body.context.subject.scopes[0].policyRevision = 'other'; refuses('get_research_portfolio', body); });
check('Explicit Florida null request fields accepted', () => { const body = fl(); body.request = { q: null, fiscalYear: null, projectId: null, offset: null, sessionKey: null, folderId: null, clientId: null }; assert.equal(parse('get_florida_budget_project', body).normalizedArgs.sessionKey, ''); });
check('Missing context null rejected', () => { const body = fl(); delete body.context.clientResolution; refuses('get_florida_budget_project', body); });
check('Native nonUUID folder unavailable without widening', () => { const body = fl(); body.request.folderId = 'native-folder'; body.context.effectiveScope.folderId = 'native-folder'; refuses('get_florida_budget_project', body, 503); });
check('Body above2MiB rejected before encoder', () => { const body = fl(); body.request.q = 'x'.repeat(2097153); let calls = 0; refuses('get_florida_budget_project', body, 400, () => { calls++; return '{}'; }); assert.equal(calls, 0); });
for (const [name, provider] of [['empty', () => ''], ['detached empty object', () => '{}'], ['malformed JSON', () => '{'], ['raw invalid Unicode', () => '"\ud800"'], ['throwing', () => { throw new Error('unavailable'); }], ['changed value', () => 'null']]) {
  check('Provider ' + name + ' returns503', () => refuses('get_research_portfolio', rp(), 503, provider));
}
for (const duplicate of ['portfolioId', '\\u0070ortfolioId']) check('Provider duplicate key ' + duplicate + ' returns503', () => {
  const provider = value => value && typeof value === 'object' && Object.hasOwn(value, 'portfolioId')
    ? `{"conversationId":"${c}","portfolioId":"${p}","${duplicate}":"${p}"}` : canonicalize(value);
  refuses('get_research_portfolio', rp(), 503, provider);
});
check('Raw invalid Unicode is400 before provider', () => { const body = rp(); body.context.subject.scopes[0].resourceId = '\ud800'; refuses('get_research_portfolio', body); });
const receipt = { check: 'pure shared parser using actual readonly JCS', maxOldSpaceMb: 128, scriptSha256: sha(fs.readFileSync(__filename)), jcsPath,
  jcsSha256: sha(fs.readFileSync(jcsPath)), jcsVersion: JSON.parse(fs.readFileSync(path.join(path.dirname(jcsPath), '../package.json'), 'utf8')).version,
  sourceHashes: hashes, total: results.length, passed: results.filter(row => row.pass).length, failed: results.filter(row => !row.pass).length, results };
const destination = path.join(__dirname, 'retained-read-parser.pure.receipt.json'); fs.writeFileSync(destination, JSON.stringify(receipt, null, 2) + '\n');
process.stdout.write(JSON.stringify({ total: receipt.total, passed: receipt.passed, failed: receipt.failed, receipt: destination, receiptSha256: sha(fs.readFileSync(destination)), scriptSha256: receipt.scriptSha256, failures: results.filter(row => !row.pass) }) + '\n');
if (receipt.failed) process.exitCode = 1;
