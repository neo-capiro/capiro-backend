const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ts = require('/workspace/capirov2/node_modules/typescript/lib/typescript.js');
const head = process.argv[2], label = process.argv[3];
assert(/^[0-9a-f]{40}$/.test(head)); assert(/^[a-z0-9-]+$/.test(label));
const root = '/tmp/capirov2-cleanup-meri-local-dispatch-conversion';
const source = file => execFileSync('git', ['show', head + ':' + file], { cwd: root }).toString();
class Refused extends Error {}
function load(code, ports) {
  const module = { exports: {} }; const output = ts.transpileModule(code, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true,
  } }).outputText;
  vm.runInNewContext(output, { module, exports: module.exports, Object, Set, Map, Reflect, JSON, Array,
    Date, Error, require(id) { assert(Object.hasOwn(ports, id), id); return ports[id]; } }, { timeout: 1000 });
  return module.exports;
}
const prismaAst = ts.createSourceFile('prisma.service.ts', source('apps/api/src/prisma/prisma.service.ts'), ts.ScriptTarget.Latest, true);
const hook = prismaAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name.text === 'applyTenantScope');
const ops = prismaAst.statements.find(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(prismaAst) === 'WHERE_BEARING_OPS'));
assert(hook && ops);
const { applyTenantScope } = load(ops.getText(prismaAst) + '\n' + hook.getText(prismaAst), {});
const { ContextSecurityScopeService } = load(source('apps/api/src/context/context-security-scope.service.ts'), {
  '@nestjs/common': { Injectable: () => value => value, ForbiddenException: Refused },
  '../prisma/prisma.service.js': {}, './context.types.js': { ContextResolutionError: Refused },
});
const tenantA = '11111111-1111-4111-8111-111111111111', tenantB = '22222222-2222-4222-8222-222222222222';
const actor = '33333333-3333-4333-8333-333333333333', clientId = '44444444-4444-4444-8444-444444444444';
// Tiny domain-independent Prisma where evaluator for these inert rows. It
// evaluates the actual query's keys, not a copied authorization decision.
function matches(row, where) {
  return Object.entries(where ?? {}).every(([key, expected]) => {
    if (key === 'OR') return expected.some(branch => matches(row, branch));
    if (expected && typeof expected === 'object') {
      if (Object.hasOwn(expected, 'in')) return expected.in.includes(row[key]);
      if (Object.hasOwn(expected, 'not')) return row[key] !== expected.not;
      if (Object.hasOwn(expected, 'some')) return row[key].some(child => matches(child, expected.some));
    }
    return row[key] === expected;
  });
}
async function attempt(name, grantTenant, wall, expectedAllowed) {
  const grant = { id: 'grant_fixture', tenantId: grantTenant, clientId, userId: actor, createdAt: new Date(1) };
  const row = { id: clientId, tenantId: tenantA, status: 'active', memoryWall: wall, memoryAccessGrants: [grant] };
  const queries = [];
  const tx = { client: {
    findMany: async args => {
      const actual = applyTenantScope({ tenantId: tenantA }, 'Client', 'findMany', args, new Set(['Client', 'ClientMemoryAccess']));
      queries.push({ kind: 'canonical', args: actual }); return matches(row, actual.where) ? [{ id: row.id }] : [];
    },
    findFirst: async args => {
      const actual = applyTenantScope({ tenantId: tenantA }, 'Client', 'findFirst', args, new Set(['Client', 'ClientMemoryAccess']));
      queries.push({ kind: 'facts', args: actual });
      if (!matches(row, actual.where)) return null;
      return { ...row, memoryAccessGrants: row.memoryAccessGrants.filter(g => matches(g, actual.select.memoryAccessGrants.where)) };
    },
  } };
  const owner = new ContextSecurityScopeService({ withTenant: async (id, callback) => { assert.equal(id, tenantA); return callback(tx); } });
  let facts, error;
  try { facts = await owner.resolve({ tenantId: tenantA, actorUserId: actor, securityScope: { authorizedClientIds: [clientId], authorizedMailboxConnectionIds: [] } }); }
  catch (caught) { error = String(caught.message); }
  const allowed = error === undefined;
  return { name, expectedAllowed, allowed, passed: allowed === expectedAllowed, facts, error, queries };
}
(async () => {
  const cases = [
    await attempt('walled same-tenant actor grant remains allowed', tenantA, true, true),
    await attempt('walled foreign-tenant actor grant must not authorize selected tenant client', tenantB, true, false),
    await attempt('unwalled same-tenant client remains allowed without matching grant', tenantB, false, true),
  ];
  const result = { sourceHead: head, total: cases.length, passed: cases.filter(c => c.passed).length,
    failed: cases.filter(c => !c.passed), cases,
    scope: 'Actual EXISTING public context resolver and actual applyTenantScope function, same three synthetic relational inputs. Models bypassed DB RLS as current PrismaService documents; no native SQL, Prisma, app or provider execution. Separate source FK fields permit inconsistent tenant/client grant rows; no assertion these rows exist in production.' };
  const out = path.join(__dirname, label + '.json'); assert(!fs.existsSync(out)); fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2)); process.exitCode = result.failed.length ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
