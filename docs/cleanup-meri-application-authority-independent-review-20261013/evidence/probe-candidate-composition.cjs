const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const crypto = require('node:crypto');
const ts = require('/workspace/capirov2/node_modules/typescript/lib/typescript.js');
const head = process.argv[2];
const label = process.argv[3];
assert(/^[0-9a-f]{40}$/.test(head)); assert(/^[a-z0-9-]+$/.test(label));
const root = '/tmp/capirov2-cleanup-meri-local-dispatch-conversion';
const source = file => execFileSync('git', ['show', head + ':' + file], { cwd: root }).toString();
class Refused extends Error {}
const noopDecorator = () => value => value;
const nest = { Injectable: noopDecorator, Logger: class { log() {} warn() {} error() {} },
  ForbiddenException: Refused, UnauthorizedException: Refused, BadRequestException: Refused };
function load(code, ports) {
  const module = { exports: {} };
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, experimentalDecorators: true, esModuleInterop: true } });
  vm.runInNewContext(js.outputText, { module, exports: module.exports, Object, Reflect, Date, WeakMap,
    Promise, Number, Map, JSON, Array, Error, require(id) {
      if (Object.hasOwn(ports, id)) return ports[id];
      throw Error('UNEXPECTED_RUNTIME_IMPORT:' + id);
    } }, { timeout: 1000 });
  return module.exports;
}
const contract = load(source('apps/api/src/auth/application-authority.ts'), {
  '@nestjs/common': nest, 'node:crypto': { createHash: crypto.createHash }, 'node:util': require('node:util'),
});
const Middleware = load(source('apps/api/src/tenant/tenant-context.middleware.ts'), {
  '@nestjs/common': nest, '@capiro/shared': { TENANT_HEADER: 'x-capiro-tenant', authDeniedEvent: () => ({}) },
  '../auth/clerk.service.js': {}, '../prisma/prisma.service.js': {}, '../auth/clerk-role.util.js': {},
  './tenant-context.store.js': {}, '../auth/application-authority.js': contract,
}).TenantContextMiddleware;
const meriText = source('apps/api/src/meri/meri.service.ts');
const ast = ts.createSourceFile('meri.service.ts', meriText, ts.ScriptTarget.Latest, true);
const clazz = ast.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'MeriService');
const method = clazz.members.find(n => ts.isMethodDeclaration(n) && n.name.getText(ast) === 'applicationAuthorityIdentity');
assert(method);
const MethodOwner = load(`import { ForbiddenException } from '@nestjs/common';
import { assertApplicationAuthorityIdentityBody, applicationAuthorityIdentityReceipt } from './contract';
export class MethodOwner { ${method.getText(ast)} }`, { '@nestjs/common': nest, './contract': contract }).MethodOwner;
const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const user = { id: actorId, clerkUserId: 'user_fixture' };
const tenant = { id: tenantId, slug: 'tenant', status: 'active', clerkOrgId: 'org_fixture' };
const membership = { id: 'member_fixture', userId: actorId, tenantId, status: 'active', role: 'standard_user', updatedAt: new Date(1), tenant };
let onlineCalls = 0, selected;
const clerk = { verifySessionToken: async () => ({ sub: user.clerkUserId, sid: 'sess_fixture', iss: 'issuer', exp: Math.floor(Date.now() / 1000) + 60,
  capiro_tenant_id: tenantId, capiro_tenant_slug: tenant.slug, org_id: tenant.clerkOrgId }),
  assertActiveApplicationAuthoritySession: async () => { onlineCalls++; return {
    id: 'sess_fixture', userId: user.clerkUserId, status: 'active', createdAt: 1,
    expireAt: Date.now() + 100000, abandonAt: Date.now() + 90000, expiresAtMs: Date.now() + 50000, actor: null,
  }; } };
const tx = { user: { findUnique: async () => user, findFirst: async () => user, update: async () => user },
  tenantMembership: { findMany: async () => [membership], findFirst: async () => membership } };
const prisma = { withSystem: async callback => callback(tx) };
const store = { run(context, next) { selected = context; return next(); } };
const provider = new Middleware(clerk, prisma, store);
const middleware = new Middleware(clerk, prisma, store);
const req = { path: '/api/clio/application-authority/identity', originalUrl: '/api/clio/application-authority/identity',
  headers: { authorization: 'Bearer synthetic' }, header(name) { return this.headers[name]; }, hostname: 'localhost' };
const serverHeaders = {};
const cases = [];
async function probe(name, action) {
  try { await action(); cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, error: String(error.stack) }); }
}
(async () => {
  // Pure Nest metadata registration only: no NestFactory, HTTP host or modules.
  const cachedRequire = createRequire('/tmp/capirov2-cleanup-meri-reviewed-runtime-conversion/apps/api/package.json');
  cachedRequire('reflect-metadata');
  const { MiddlewareContainer } = cachedRequire('@nestjs/core/middleware/container.js');
  const providerWrapper = { instance: provider };
  const moduleRef = { middlewares: new Map(), providers: new Map([[Middleware, providerWrapper]]) };
  const container = new MiddlewareContainer({ getModuleByKey: () => moduleRef });
  container.insertConfig([{ middleware: Middleware, forRoutes: [] }], 'AppModule');
  const middlewareWrapper = container.getMiddlewareCollection('AppModule').get(Middleware);
  assert.notEqual(middlewareWrapper, providerWrapper);
  assert.equal(middlewareWrapper.metatype, Middleware);
  assert.notEqual(provider, middleware);
  await middleware.use(req, { setHeader(k, v) { serverHeaders[k] = v; } }, () => {});
  assert.equal(req.tenantContext, selected);
  const sameInstanceOwner = new MethodOwner(); sameInstanceOwner.applicationAuthorityTenant = middleware;
  await probe('control same authenticated middleware instance produces valid identity receipt', async () => {
    const value = await sameInstanceOwner.applicationAuthorityIdentity(selected, req, {});
    assert.deepEqual(JSON.parse(JSON.stringify(value.principal)), { tenantId, actorId });
  });
  const actualProviderOwner = new MethodOwner(); actualProviderOwner.applicationAuthorityTenant = provider;
  await probe('separate Nest provider instance must consume framework middleware request provenance', async () => {
    const before = onlineCalls;
    const value = await actualProviderOwner.applicationAuthorityIdentity(selected, req, {});
    assert.deepEqual(JSON.parse(JSON.stringify(value.principal)), { tenantId, actorId }); assert.equal(onlineCalls, before + 1);
  });
  const wire = await import('file:///workspace/capiro-application-authority-wire-review-20261013/packages/contracts/action-authority-0.2/validate.mjs');
  const validContext = { identitySha256: 'a'.repeat(64), conversationId: tenantId, clientId: actorId };
  for (const [name, create, reference, candidate] of [
    ['identity proxy', () => new Proxy({}, {}), wire.assertAuthorityIdentityRequest, contract.assertApplicationAuthorityIdentityBody],
    ['context proxy', () => new Proxy({ ...validContext }, {}), wire.assertAuthorityContextRequest, contract.parseApplicationAuthorityContextBody],
  ]) await probe('same pinned wire refuses ' + name, async () => {
    assert.throws(() => reference(create())); assert.throws(() => candidate(create()));
  });
  const result = { sourceHead: head, sourceTree: execFileSync('git', ['rev-parse', head + '^{tree}'], { cwd: root }).toString().trim(),
    total: cases.length, passed: cases.filter(c => c.passed).length, failed: cases.filter(c => !c.passed), cases,
    sameProviderAndMiddlewareWrapper: false, onlineCalls, serverHeaders,
    scope: 'Actual frozen owner methods and actual cached Nest middleware registration with synthetic container/dependencies. No app bootstrap, listening HTTP server, live Clerk, Prisma/database, provider or Meri fixtures.' };
  const output = path.join(__dirname, label + '.json'); assert(!fs.existsSync(output)); fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2)); process.exitCode = result.failed.length ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
