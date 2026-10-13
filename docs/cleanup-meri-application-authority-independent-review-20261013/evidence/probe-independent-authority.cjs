const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('/workspace/capirov2/node_modules/typescript/lib/typescript.js');
const head = 'd5c121973438a29a65515496f395f4ad7568d006';
const root = '/tmp/capirov2-cleanup-meri-local-dispatch-conversion';
const identities = [];
function source(file) {
  const bytes = execFileSync('git', ['show', head + ':' + file], { cwd: root });
  identities.push({ path: file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  return bytes.toString();
}
const contractSource = source('apps/api/src/auth/application-authority.ts');
const clerkSource = source('apps/api/src/auth/clerk.service.ts');
const middlewareSource = source('apps/api/src/tenant/tenant-context.middleware.ts');
class Refused extends Error {}
const decorate = () => value => value;
const nest = { Injectable: decorate, Logger: class { log() {} warn() {} error() {} },
  BadRequestException: Refused, ForbiddenException: Refused, UnauthorizedException: Refused };
function load(code, ports, globals = {}) {
  const module = { exports: {} };
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, experimentalDecorators: true, esModuleInterop: true } }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, Object, Reflect, Array, JSON, Number,
    Promise, WeakMap, Map, Error, Date, ...globals, require(id) {
      if (Object.hasOwn(ports, id)) return ports[id]; throw Error('UNEXPECTED_RUNTIME_IMPORT:' + id);
    } }, { timeout: 1000 });
  return module.exports;
}
const contract = load(contractSource, { '@nestjs/common': nest, 'node:crypto': { createHash: crypto.createHash }, 'node:util': require('node:util') });
const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const targetId = '33333333-3333-4333-8333-333333333333';
function fixture(operator = false) {
  let now = 1000000, cleared = 0, timer;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const globals = { Date: Clock, setTimeout(fn) { timer = fn; return 1; }, clearTimeout() { cleared++; } };
  const events = [], writes = [];
  const raw = { sub: 'user_fixture', sid: 'sess_fixture', iss: 'https://clerk.synthetic.invalid', exp: 1100,
    capiro_tenant_id: tenantId, capiro_tenant_slug: 'tenant', o: { id: 'org_fixture', rol: 'member', slg: 'tenant' } };
  const session = { id: raw.sid, userId: raw.sub, status: 'active', createdAt: 900000, expireAt: 1300000, abandonAt: 1200000, actor: null };
  let sessionRead = async () => session;
  let verify = async () => raw;
  const forbiddenMutation = () => { throw Error('SESSION_MUTATION_REFUSED'); };
  const Clerk = load(clerkSource, { '@nestjs/common': nest, '@nestjs/config': {}, '@clerk/backend': {
    createClerkClient: () => ({ sessions: { getSession(id) { events.push('get:' + id); return sessionRead(id); },
      createSession: forbiddenMutation, refreshSession: forbiddenMutation, revokeSession: forbiddenMutation, getToken: forbiddenMutation } }),
    verifyToken(token) { events.push('verify:' + token); return verify(token); },
  } }, globals).ClerkService;
  const clerk = new Clerk({ get(key) { return key === 'CLERK_SECRET_KEY' ? 'synthetic-not-a-credential' : 'https://clerk.synthetic.invalid'; } });
  const user = { id: actorId, clerkUserId: raw.sub, lastSeenAt: new Date(1), updatedAt: new Date(1) };
  const tenant = { id: tenantId, slug: 'tenant', status: 'active', clerkOrgId: 'org_fixture' };
  const membership = { id: 'member_fixture', userId: actorId, tenantId, role: operator ? 'capiro_admin' : 'standard_user',
    status: 'active', updatedAt: new Date(2), tenant };
  const impersonation = { id: 'operator_fixture', actorUserId: actorId, tenantId: targetId,
    startedAt: new Date(1), expiresAt: new Date(1050000), endedAt: null,
    tenant: { id: targetId, slug: 'target', status: 'active', clerkOrgId: 'org_target' } };
  let userRead = async () => user, memberRead = async () => membership;
  const tx = { user: { findUnique: async () => user, findFirst: query => { events.push('user-current'); return userRead(query); },
    update: async () => { writes.push('original-last-seen'); return user; } },
    tenantMembership: { findMany: async () => [membership], findFirst: query => { events.push('member-current'); return memberRead(query); } },
    impersonationSession: { findFirst: async () => impersonation } };
  const Middleware = load(middlewareSource, { '@nestjs/common': nest, '@capiro/shared': { TENANT_HEADER: 'x-capiro-tenant', authDeniedEvent: () => ({}) },
    '../auth/clerk.service.js': {}, '../prisma/prisma.service.js': {}, '../auth/clerk-role.util.js': {},
    './tenant-context.store.js': {}, '../auth/application-authority.js': contract }, globals).TenantContextMiddleware;
  let selected;
  const store = { run(ctx, next) { selected = ctx; return next(); } };
  const prisma = { withSystem: async callback => callback(tx) };
  const frameworkMiddleware = new Middleware(clerk, prisma, store);
  const provider = new Middleware(clerk, prisma, store);
  const headers = { authorization: 'Bearer synthetic' };
  if (operator) headers['x-capiro-impersonate-tenant'] = 'target';
  const req = { path: '/api/clio/application-authority/identity', originalUrl: '/api/clio/application-authority/identity',
    headers, header(name) { return headers[name]; }, hostname: 'localhost' };
  const responseHeaders = {};
  return { clerk, provider, raw, session, user, membership, tenant, impersonation, events, writes, req,
    now: () => now, advance(amount) { now += amount; }, cleared: () => cleared, fireTimer() { assert(timer); timer(); },
    setSessionRead(next) { sessionRead = next; }, setUserRead(next) { userRead = next; }, setMemberRead(next) { memberRead = next; },
    setVerify(next) { verify = next; }, ctx: () => selected, responseHeaders,
    async authenticate() { await frameworkMiddleware.use(req, { setHeader(k, v) { responseHeaders[k] = v; } }, () => {}); return selected; },
    read() { return provider.readApplicationAuthority(req, selected); } };
}
const cases = [];
async function test(name, action) {
  try { await action(); cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, error: String(error.stack) }); }
}
(async () => {
  const wire = await import('file:///workspace/capiro-application-authority-wire-review-20261013/packages/contracts/action-authority-0.2/validate.mjs');
  await test('actual verified v2 native claims compose with distinct middleware/provider and minimal wire receipt', async () => {
    const f = fixture(); await f.authenticate(); const proof = await f.read();
    const receipt = contract.applicationAuthorityIdentityReceipt(proof, f.now());
    wire.assertAuthorityIdentityReceipt(JSON.parse(JSON.stringify(receipt)));
    assert.equal(receipt.principal.actorId, actorId); assert.equal(receipt.principal.tenantId, tenantId);
    assert.equal(receipt.expiresAtMs, 1100000); assert.equal(f.writes.length, 1);
    await proof.recheckCurrent(); assert.equal(f.writes.length, 1);
    assert.equal(f.responseHeaders['Cache-Control'], 'no-store');
  });
  await test('actual canonical issuer assertion refuses before any local owner query', async () => {
    const f = fixture(); f.raw.iss = 'https://wrong.synthetic.invalid';
    await assert.rejects(f.authenticate(), /Invalid session token/);
    assert.equal(f.events.some(x => x === 'user-current' || x.startsWith('get:')), false); assert.equal(f.writes.length, 0);
  });
  await test('native verifier failure is sanitized before current-owner work', async () => {
    const f = fixture(); f.setVerify(async () => { throw Error('PRIVATE_SIGNATURE_DETAIL'); });
    await assert.rejects(f.authenticate(), /Invalid session token/); assert.equal(f.writes.length, 0);
  });
  for (const [name, mutate] of [
    ['missing sid', c => delete c.sid], ['missing sub', c => delete c.sub], ['missing original exp', c => delete c.exp],
    ['fractional exp', c => c.exp = 1100.5], ['unsafe exp milliseconds', c => c.exp = Number.MAX_SAFE_INTEGER],
    ['original expiry exact current time', c => c.exp = 1000],
  ]) await test('session assertion refuses ' + name + ' without lookup', async () => {
    const f = fixture(); mutate(f.raw); await assert.rejects(f.clerk.assertActiveApplicationAuthoritySession(f.raw));
    assert.equal(f.events.length, 0);
  });
  for (const [name, key, value] of [
    ['null current session', null, null], ['mismatched native session', 'id', 'sess_other'], ['mismatched native user', 'userId', 'user_other'],
    ['pending session', 'status', 'pending'], ['abandoned session', 'status', 'abandoned'], ['replaced session', 'status', 'replaced'],
    ['string expiration', 'expireAt', '1300000'], ['null expiration', 'expireAt', null], ['fractional expiration', 'expireAt', 1300000.5],
    ['negative creation', 'createdAt', -1], ['unsafe abandonment', 'abandonAt', Number.MAX_SAFE_INTEGER + 1],
  ]) await test('session assertion refuses ' + name, async () => {
    const f = fixture(); if (key === null) f.setSessionRead(async () => null); else f.session[key] = value;
    await assert.rejects(f.clerk.assertActiveApplicationAuthoritySession(f.raw), /Application authority unavailable/);
    assert.deepEqual(f.events, ['get:sess_fixture']); assert.equal(f.cleared(), 1);
  });
  await test('current session and inactivity bounds each shorten original expiry', async () => {
    const f = fixture(); f.session.expireAt = 1040000;
    assert.equal((await f.clerk.assertActiveApplicationAuthoritySession(f.raw)).expiresAtMs, 1040000);
    f.session.abandonAt = 1030000;
    assert.equal((await f.clerk.assertActiveApplicationAuthoritySession(f.raw)).expiresAtMs, 1030000);
  });
  await test('original verified expiry is captured before asynchronous lookup and cannot be extended', async () => {
    const f = fixture(); f.setSessionRead(async () => { f.raw.exp = 10000; return f.session; });
    assert.equal((await f.clerk.assertActiveApplicationAuthoritySession(f.raw)).expiresAtMs, 1100000);
  });
  await test('original expiry crossed during lookup refuses rather than returning an already expired receipt', async () => {
    const f = fixture(); f.raw.exp = 1001; f.setSessionRead(async () => { f.advance(1000); return f.session; });
    await assert.rejects(f.clerk.assertActiveApplicationAuthoritySession(f.raw));
  });
  await test('absolute two-second cutoff refuses even if event-loop timeout has not fired', async () => {
    const f = fixture(); f.setSessionRead(async () => { f.advance(2000); return f.session; });
    await assert.rejects(f.clerk.assertActiveApplicationAuthoritySession(f.raw)); assert.equal(f.cleared(), 1);
  });
  await test('timed-out SDK late resolution cannot reopen the failed call', async () => {
    const f = fixture(); let resolveLate;
    f.setSessionRead(() => new Promise(resolve => { resolveLate = resolve; }));
    const pending = f.clerk.assertActiveApplicationAuthoritySession(f.raw); await Promise.resolve(); f.fireTimer();
    await assert.rejects(pending); resolveLate(f.session); await Promise.resolve(); assert.equal(f.cleared(), 1);
  });
  await test('fresh second lookup observes revocation with no positive session cache', async () => {
    const f = fixture(); await f.clerk.assertActiveApplicationAuthoritySession(f.raw); f.session.status = 'revoked';
    await assert.rejects(f.clerk.assertActiveApplicationAuthoritySession(f.raw)); assert.equal(f.events.length, 2);
  });
  for (const [name, mutate] of [
    ['origin membership replacement', f => f.membership.id = 'replacement'], ['origin membership tenant transfer', f => f.membership.tenantId = targetId],
    ['membership actor transfer', f => f.membership.userId = targetId], ['suspended member', f => f.membership.status = 'suspended'],
    ['disabled origin tenant', f => f.tenant.status = 'suspended'], ['current user mapping change', f => f.user.clerkUserId = 'user_other'],
  ]) await test('post-session local authority refuses ' + name, async () => {
    const f = fixture(); await f.authenticate(); f.setSessionRead(async () => { mutate(f); return f.session; });
    await assert.rejects(f.read()); assert.equal(f.writes.length, 1);
  });
  await test('activity cannot rotate identity but current membership version does', async () => {
    const f = fixture(); await f.authenticate(); const before = await f.read();
    f.user.lastSeenAt = new Date(999); f.user.updatedAt = new Date(999);
    f.session.lastActiveAt = 999; f.session.updatedAt = 999; f.session.latestActivity = { browser: 'synthetic' };
    const same = await f.read(); assert.equal(before.identityRevision, same.identityRevision);
    f.membership.updatedAt = new Date(3); assert.notEqual((await f.read()).identityRevision, before.identityRevision);
  });
  for (const [name, mutate] of [
    ['different selected operator ID', f => f.impersonation.id = 'different'], ['different target', f => f.impersonation.tenantId = tenantId],
    ['different actor', f => f.impersonation.actorUserId = targetId], ['operator ended', f => f.impersonation.endedAt = new Date(1)],
    ['target tenant disabled', f => f.impersonation.tenant.status = 'suspended'], ['operator expired', f => f.impersonation.expiresAt = new Date(999999)],
    ['origin operator role removed', f => f.membership.role = 'standard_user'],
  ]) await test('current selected operator authority refuses ' + name, async () => {
    const f = fixture(true); await f.authenticate(); mutate(f); await assert.rejects(f.read());
  });
  await test('final local callback closes operator end while keeping original native expiry', async () => {
    const f = fixture(true); await f.authenticate(); const proof = await f.read();
    assert.equal(proof.expiresAtMs, 1050000); f.impersonation.endedAt = new Date(1);
    await assert.rejects(proof.recheckCurrent());
  });
  const result = { sourceHead: head, sourceIdentities: identities, total: cases.length,
    passed: cases.filter(c => c.passed).length, failed: cases.filter(c => !c.passed), cases,
    scope: 'Actual frozen Clerk verifier/session assertion and distinct middleware/provider closures; signature/session/database ports mocked. No app/server/bootstrap, actual Clerk/Prisma/provider calls, credentials or Meri fixtures. Ordered point-in-time checks are not atomic Clerk/Postgres or an authority lease.' };
  const output = path.join(__dirname, '06-d5-independent-authority.json'); assert(!fs.existsSync(output)); fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ total: result.total, passed: result.passed, failed: result.failed }, null, 2)); assert.equal(result.failed.length, 0);
})().catch(error => { console.error(error); process.exitCode = 1; });
