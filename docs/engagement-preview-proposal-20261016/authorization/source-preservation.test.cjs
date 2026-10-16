// These tests execute no application code, HTTP, SQL, providers or auth services.
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  PINS, git, sha256, baselineSources, currentSources,
  preservationFindings, nonPacketChanges,
} = require('./source-preservation.cjs');

const baseline = baselineSources();
const CONTROLLER = 'apps/api/src/engagement/plans/engagement-plans.controller.ts';
const ACCESS = 'apps/api/src/engagement/plans/engagement-plan-access.ts';
const SERVICE = 'apps/api/src/engagement/plans/engagement-plans.service.ts';
const STORE = 'apps/api/src/engagement/plans/engagement-plan-store.ts';
const GUARD = 'apps/api/src/auth/roles.guard.ts';
const TENANT = 'apps/api/src/tenant/tenant-context.middleware.ts';

test('pin packet remains bound to exact 016e candidate', () => {
  assert.equal(PINS.baseCommit, '016e79b585c14f20d13669e13c987c01e3dd29dd');
  git('merge-base', '--is-ancestor', PINS.baseCommit, 'HEAD');
  assert.equal(new Set(PINS.files.map((pin) => pin.path)).size, PINS.files.length);
  assert.ok(PINS.files.length >= 20);
  for (const pin of PINS.files) {
    assert.equal(git('rev-parse', `${PINS.baseCommit}:${pin.path}`).trim(), pin.gitBlob, pin.path);
    assert.equal(sha256(baseline.get(pin.path)), pin.sha256, pin.path);
  }
});

test('every current pinned source equals reviewed candidate bytes after CRLF normalization', () => {
  assert.deepEqual(preservationFindings(currentSources()), []);
});

test('all tracked and untracked changes stay inside the inactive proposal packet', () => {
  assert.deepEqual(nonPacketChanges(), []);
});

// Deliberately mutate the actual immutable candidate source strings. The oracle
// is the reviewed byte pins, not a reimplementation of authorization decisions.
// These are source-preservation negatives: a rejection means drift was detected,
// not that a user/request was dynamically denied by Nest, Clerk or PostgreSQL.
const mutations = [
  ['controller role guard removed', CONTROLLER, '@UseGuards(RolesGuard)\n', ''],
  ['controller standard-user requirement removed', CONTROLLER, "@Roles('standard_user')\n", ''],
  ['a CurrentTenant injection removed', CONTROLLER, '@CurrentTenant() ctx: TenantContext', 'ctx: TenantContext'],
  ['CurrentTenant missing-context rejection bypassed', 'apps/api/src/tenant/current-tenant.decorator.ts', 'if (!req.tenantContext)', 'if (false)'],
  ['core middleware registration removed', 'apps/api/src/app.module.ts', '.apply(TenantContextMiddleware)', '.apply()'],
  ['engagement middleware registration removed', 'apps/api/src/engagement-api.app.module.ts', '.apply(TenantContextMiddleware)', '.apply()'],
  ['Clerk token verification removed', TENANT, 'claims = await this.clerk.verifySessionToken(token);', 'claims = {} as ClerkSessionClaims;'],
  ['Clerk issuer assertion removed', 'apps/api/src/auth/clerk.service.ts', 'this.assertIssuer(raw as Record<string, unknown>);', ''],
  ['tenant claim cross-check removed', TENANT, 'if (claimedTenantId && chosen.tenantId !== claimedTenantId)', 'if (false)'],
  ['missing-context role rejection bypassed', GUARD, 'if (!ctx)', 'if (false)'],
  ['unknown caller role rejection bypassed', GUARD, "if (typeof callerRank !== 'number')", 'if (false)'],
  ['role rank requirement bypassed', GUARD, 'if (callerRank < minRequiredRank)', 'if (false)'],
  ['client tenant predicate removed', ACCESS, 'WHERE tenant_id=$1::uuid AND id=$2::uuid', 'WHERE id=$2::uuid'],
  ['client archive predicate removed', ACCESS, "AND status::text<>'archived' FOR UPDATE", 'FOR UPDATE'],
  ['client lock removed', ACCESS, "AND status::text<>'archived' FOR UPDATE", "AND status::text<>'archived'"],
  ['current tenant active requirement removed', ACCESS, "AND t.status::text='active'", ''],
  ['current membership active requirement removed', ACCESS, "AND tm.status::text='active'", ''],
  ['current actor Clerk correlation removed', ACCESS, 'AND u.clerk_user_id=$3', ''],
  ['current actor minimum role bypassed', ACCESS, "if (typeof rank !== 'number' || rank < ROLE_RANK.standard_user) denied();", ''],
  ['actor share locks removed', ACCESS, 'FOR SHARE OF t, tm, u', ''],
  ['current actor recheck removed from aggregate authority helper', ACCESS, 'await requirePlanActor(tx, ctx);', ''],
  ['grant stability lock removed', ACCESS, 'AND user_id=$3::uuid FOR SHARE', 'AND user_id=$3::uuid'],
  ['canonical wall decision replaced by unconditional approval', ACCESS, 'return clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId);', 'return true;'],
  ['wall failure no longer denies aggregate access', ACCESS, 'if (!(await lockPlanGrantAndCheckWall(tx, ctx, id))) denied();', ''],
  ['empty discovery actor recheck removed', ACCESS, '// Even an empty discovery must reject a stale/mismatched authenticated actor.\n  await requirePlanActor(tx, ctx);', ''],
  ['selected inaccessible client allowed to broaden', ACCESS, 'if (selected && !ids.includes(selected)) denied();', ''],
  ['per-client wall recheck removed from discovery', ACCESS, 'if (await lockPlanGrantAndCheckWall(tx, ctx, row.id)) permitted.push(row.id);', 'permitted.push(row.id);'],
  ['list current authority discovery removed', SERVICE, 'const ids = await discoverPermittedPlanClientIds(tx, ctx, query.clientId);', 'const ids: string[] = [];'],
  ['list cursor actor binding removed', SERVICE, 'actor: ctx.userId,', ''],
  ['list SQL permitted-client predicate removed', SERVICE, 'AND client_id=ANY($2::uuid[])', ''],
  ['create current actor and wall gate removed', SERVICE, 'await requirePlanActorAndGrant(tx, ctx, input.clientId);', ''],
  ['withPlan current actor and wall gate removed', SERVICE, 'await requirePlanActorAndGrant(tx, ctx, clientId);', ''],
  ['withPlan target fence removed', SERVICE, '        await lockPlanTargets(tx, ctx);', ''],
  ['history aggregate authority wrapper replaced', SERVICE, 'history(ctx: TenantContext, id: string, query: PlanHistoryQuery) {\n    return this.withPlan(ctx, id, async (tx, plan) => {', 'history(ctx: TenantContext, id: string, query: PlanHistoryQuery) {\n    return this.prisma.withTenant(ctx.tenantId, async (tx) => {'],
  ['history client SQL predicate removed', SERVICE, 'AND client_id=$2::uuid AND plan_id=$3::uuid AND ($4::int', 'AND plan_id=$3::uuid AND ($4::int'],
  ['aggregate lookup tenant predicate removed', STORE, 'WHERE tenant_id=$1::uuid AND id=$2::uuid', 'WHERE id=$2::uuid'],
  ['canonical wall true-only result bypassed', 'packages/shared/src/client-memory-wall.ts', 'return rows[0]?.allowed === true;', 'return true;'],
  ['canonical wall actor grant correlation removed', 'packages/shared/src/client-memory-wall.ts', 'AND a.user_id = $3::uuid', ''],
  ['Clerk discovery grant actor correlation removed', 'apps/api/src/memory/memory-wall.helpers.ts', 'AND a.user_id=u.id', ''],
  ['tenant transaction setting removed', 'apps/api/src/prisma/prisma.service.ts', "await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;", ''],
];

for (const [name, file, original, replacement] of mutations) {
  test(`source preservation rejects: ${name}`, () => {
    const source = baseline.get(file);
    assert.ok(source.includes(original), `Mutation no longer applies: ${name}`);
    const changed = source.replace(original, replacement);
    assert.notEqual(changed, source, name);
    const mutated = new Map(baseline);
    mutated.set(file, changed);
    assert.deepEqual(preservationFindings(mutated), [`Pinned source drift: ${file}`]);
  });
}

test('source preservation fails closed on a missing pinned source', () => {
  const missing = new Map(baseline);
  missing.delete(CONTROLLER);
  assert.deepEqual(preservationFindings(missing), [`Missing source: ${CONTROLLER}`]);
});

test('source preservation does not silently ignore an additional source', () => {
  const added = new Map(baseline);
  added.set('apps/api/src/proposal-activation.ts', 'export const activate = true;');
  assert.deepEqual(preservationFindings(added), ['Unpinned source: apps/api/src/proposal-activation.ts']);
});
