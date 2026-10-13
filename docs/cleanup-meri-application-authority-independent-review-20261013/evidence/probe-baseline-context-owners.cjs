const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('/workspace/capirov2/node_modules/typescript/lib/typescript.js');
const head = '9db4e1cd5589a05e08fb88caa38a4ac44937def5';
const root = '/tmp/capirov2-cleanup-meri-local-dispatch-conversion';
const evidence = __dirname;
const identities = [];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function source(file) {
  const bytes = execFileSync('git', ['show', head + ':' + file], { cwd: root });
  const ast = ts.createSourceFile(file, bytes.toString(), ts.ScriptTarget.Latest, true);
  identities.push({ path: file, sourceSha256: sha(bytes), sourceBytes: bytes.length });
  return ast;
}
function named(ast, name, predicate) {
  let found;
  function walk(node) {
    if (predicate(node) && node.name?.getText(ast) === name) { assert(!found); found = node; }
    ts.forEachChild(node, walk);
  }
  walk(ast); assert(found, name);
  const text = found.getText(ast);
  identities.push({ path: ast.fileName, declaration: name, declarationSha256: sha(text), declarationBytes: Buffer.byteLength(text) });
  return text;
}
const meri = source('apps/api/src/meri/meri.service.ts');
const portfolio = source('apps/api/src/research-portfolios/research-portfolio-artifact-authority.ts');
const scope = source('apps/api/src/context/context-security-scope.service.ts');
const errors = source('apps/api/src/context/context.types.ts');
const input = `
${named(errors, 'ContextResolutionError', ts.isClassDeclaration)}
${named(portfolio, 'authorizeResearchPortfolioConversation', ts.isFunctionDeclaration)}
class BaselineMeriOwner {
${named(meri, 'ensureConversation', ts.isMethodDeclaration)}
${named(meri, 'ensureClientVisible', ts.isMethodDeclaration)}
}
${named(scope, 'ContextSecurityScopeService', ts.isClassDeclaration)}
${named(scope, 'requiredId', ts.isFunctionDeclaration)}
${named(scope, 'normalizeIds', ts.isFunctionDeclaration)}
${named(scope, 'dedupeGraphPartitions', ts.isFunctionDeclaration)}
${named(scope, 'stableJson', ts.isFunctionDeclaration)}
module.exports={BaselineMeriOwner,ContextSecurityScopeService};`;
class NotFoundException extends Error {}
class ForbiddenException extends Error {}
const blocked = () => { throw Error('EXTERNAL_PORT_REFUSED'); };
const sandbox = { module: { exports: {} }, exports: {}, Error, Object, JSON, Set, Map,
  Injectable: () => value => value, NotFoundException, ForbiddenException,
  MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY: 'researchPortfolioScope',
  validScope: blocked, loadAuthorizedResearchPortfolio: blocked,
  MAILBOX_PROVIDERS: ['microsoft_365', 'google_workspace', 'imap_caldav'],
  require: blocked, fetch: blocked, process: undefined, PrismaService: class {} };
// The constant is loaded from its canonical declaration rather than guessed.
const scopeSource = source('apps/api/src/research-portfolios/research-portfolio-meri-scope.service.ts');
const constant = named(scopeSource, 'MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY', ts.isVariableDeclaration);
const constantJs = ts.transpileModule('const ' + constant + '; module.exports=MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const constantBox = { module: { exports: {} } }; vm.runInNewContext(constantJs, constantBox, { timeout: 1000 });
sandbox.MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY = constantBox.module.exports;
const js = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true, emitDecoratorMetadata: false } }).outputText;
vm.runInNewContext(js, sandbox, { timeout: 1000 });
const { BaselineMeriOwner, ContextSecurityScopeService } = sandbox.module.exports;
const ctx = { tenantId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', clerkUserId: 'user_fixture', role: 'user' };
const conversationId = '33333333-3333-4333-8333-333333333333';
const clientId = '44444444-4444-4444-8444-444444444444';
const cases = [];
async function test(name, action) {
  try { await action(); cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, error: String(error.stack) }); }
}
function owner(row, clientRow) {
  const calls = [];
  const tx = {
    clioConversation: { findFirst: async query => {
      calls.push({ owner: 'conversation', query });
      if (!row || Object.entries(query.where).some(([key, value]) => row[key] !== value)) return null;
      return row;
    } },
    client: { findFirst: async query => {
      calls.push({ owner: 'client', query });
      if (!clientRow || clientRow.id !== query.where.id || clientRow.tenantId !== query.where.tenantId || clientRow.status === query.where.status.not) return null;
      return clientRow;
    } },
    $executeRaw: blocked,
  };
  const instance = new BaselineMeriOwner();
  instance.prisma = { withTenant: async (tenantId, callback) => { assert.equal(tenantId, ctx.tenantId); return callback(tx); } };
  return { instance, calls };
}
const activeRow = () => ({ id: conversationId, tenantId: ctx.tenantId, userId: ctx.userId, clientId, archivedAt: null, metadata: {} });
(async () => {
  await test('active canonical conversation binds tenant,user,id and archivedAt:null', async () => {
    const o = owner(activeRow()); assert.equal((await o.instance.ensureConversation(ctx, conversationId)).id, conversationId);
    assert.deepEqual(JSON.parse(JSON.stringify(o.calls[0].query.where)), { id: conversationId, tenantId: ctx.tenantId, userId: ctx.userId, archivedAt: null });
  });
  for (const [name, patch] of [['cross-tenant', { tenantId: clientId }], ['other-user', { userId: clientId }], ['archived', { archivedAt: new Date(1) }], ['other-id', { id: clientId }]]) {
    await test('active canonical conversation refuses ' + name, async () => {
      const o = owner({ ...activeRow(), ...patch });
      await assert.rejects(o.instance.ensureConversation(ctx, conversationId), NotFoundException);
    });
  }
  await test('active canonical conversation refuses absent row', async () => {
    await assert.rejects(owner(null).instance.ensureConversation(ctx, conversationId), NotFoundException);
  });
  await test('canonical portfolio owner refuses a client-bound portfolio row before external access', async () => {
    const row = activeRow(); row.metadata[sandbox.MERI_RESEARCH_PORTFOLIO_SCOPE_METADATA_KEY] = {};
    await assert.rejects(owner(row).instance.ensureConversation(ctx, conversationId), NotFoundException);
  });
  await test('ordinary null-client conversation remains baseline-readable without granting new bridge authority', async () => {
    const row = { ...activeRow(), clientId: null };
    assert.equal((await owner(row).instance.ensureConversation(ctx, conversationId)).clientId, null);
  });
  const activeClient = () => ({ id: clientId, tenantId: ctx.tenantId, status: 'active' });
  await test('canonical client visibility binds tenant and nonarchived status', async () => {
    const o = owner(null, activeClient()); await o.instance.ensureClientVisible(ctx, clientId);
    assert.deepEqual(JSON.parse(JSON.stringify(o.calls[0].query.where)), { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } });
  });
  for (const [name, patch] of [['other-tenant', { tenantId: clientId }], ['archived', { status: 'archived' }]]) {
    await test('canonical client visibility refuses ' + name, async () => {
      await assert.rejects(owner(null, { ...activeClient(), ...patch }).instance.ensureClientVisible(ctx, clientId), NotFoundException);
    });
  }
  function wall(returned) {
    const calls = []; const instance = new ContextSecurityScopeService({ withTenant: async (tenantId, callback) => {
      assert.equal(tenantId, ctx.tenantId);
      return callback({ client: { findMany: async query => { calls.push(query); return returned; } }, integrationConnection: { findMany: blocked } });
    } });
    return { instance, calls };
  }
  const request = { tenantId: ctx.tenantId, actorUserId: ctx.userId, securityScope: { authorizedClientIds: [clientId], authorizedMailboxConnectionIds: [], graphPartitions: [], allowGlobalPublic: false, allowExternalResearch: false } };
  await test('canonical ethical-wall resolver keeps caller list as upper bound and current actor grant predicate', async () => {
    const w = wall([{ id: clientId }]); const result = await w.instance.resolve(request);
    assert.deepEqual(JSON.parse(JSON.stringify(w.calls[0].where)), { id: { in: [clientId] }, OR: [{ memoryWall: false }, { memoryAccessGrants: { some: { userId: ctx.userId } } }] });
    assert.deepEqual(JSON.parse(JSON.stringify(result.authorizedClientIds)), [clientId]);
    assert.equal(result.allowGlobalPublic, false); assert.equal(result.allowExternalResearch, false);
    assert.equal(result.authorizedMailboxConnectionIds.length, 0);
  });
  await test('canonical ethical-wall resolver refuses missing requested current authority', async () => {
    await assert.rejects(wall([]).instance.resolve(request), error => error.code === 'requested_client_scope_not_fully_authorized');
  });
  await test('empty client upper bound does not query or become all-clients', async () => {
    const w = wall([{ id: clientId }]); const result = await w.instance.resolve({ ...request, securityScope: { ...request.securityScope, authorizedClientIds: [] } });
    assert.equal(result.authorizedClientIds.length, 0); assert.equal(w.calls.length, 0);
  });
  const result = { sourceHead: head, sourceIdentities: identities, total: cases.length, passed: cases.filter(c => c.passed).length, failed: cases.filter(c => !c.passed), cases,
    scope: 'Actual baseline private method/declaration execution with synthetic ports. No module bootstrap, native RLS, Prisma, Clerk, provider or live authority acceptance. Canonical wall resolver tenant isolation relies on existing withTenant behavior; no database enforcement claim.' };
  const output = path.join(evidence, 'baseline-context-owners.json'); assert(!fs.existsSync(output)); fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ total: result.total, passed: result.passed, failed: result.failed }, null, 2)); assert.equal(result.failed.length, 0);
})().catch(error => { console.error(error); process.exitCode = 1; });
