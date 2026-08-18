/**
 * OLD-vs-NEW parity: authorization, tenant scoping, and error behaviour.
 *
 * "Both returned HTTP 200" is explicitly not acceptance. This suite pins the three
 * things a route can get wrong without ever changing its happy-path body:
 *
 *  1. AUTH — which routes require capiro_admin, checked against apps/api's own
 *     controller decorators rather than against a list someone typed.
 *  2. TENANT — every tenant-scoped surface (watch, email pref, data issues,
 *     needs-attention) reads/writes inside a tenant transaction, and no global
 *     RLS-bypass exists.
 *  3. ERRORS — not-found / invalid-input / conflict / forbidden / duplicate-state /
 *     invalid-transition all still throw, with the same HTTP class.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const NEXT_PE_CONTROLLER = read('apps/defense-api/src/program-elements/program-element.controller.ts');
const NEXT_BL_CONTROLLER = read('apps/defense-api/src/program-elements/budget-lines.controller.ts');
const NEXT_PROGRAMS_CONTROLLER = read('apps/defense-api/src/program-elements/programs.controller.ts');
const NEXT_PE = read('apps/defense-api/src/program-elements/program-element-read.service.ts');
const NEXT_BL = read('apps/defense-api/src/program-elements/budget-lines-read.service.ts');
const NEXT_PROGRAMS = read('apps/defense-api/src/program-elements/programs.service.ts');
const NEXT_ISSUES = read('apps/defense-api/src/program-elements/program-element-data-issue.service.ts');
const CONTRACTS_SRC = read('packages/defense-contracts/src/public/index.ts');

const ALL_CONTROLLERS = [NEXT_PE_CONTROLLER, NEXT_BL_CONTROLLER, NEXT_PROGRAMS_CONTROLLER].join('\n');

// ---------------------------------------------------------------------------
// 1. Authorization
// ---------------------------------------------------------------------------

test('PARITY: every route the frozen contract marks capiro_admin is gated capiro_admin', () => {
  const routeRe =
    /defineRoute\(\s*'([^']+)'\s*,\s*'([A-Z]+)'\s*,\s*'([^']+)'\s*(?:,\s*'([a-z_]+)')?\s*\)/g;
  const adminRoutes: Array<{ id: string; method: string; path: string }> = [];
  const standardRoutes: Array<{ id: string; method: string; path: string }> = [];
  for (const m of CONTRACTS_SRC.matchAll(routeRe)) {
    const [, id, method, routePath, minimumRole] = m;
    (minimumRole === 'capiro_admin' ? adminRoutes : standardRoutes).push({
      id: id!,
      method: method!,
      path: routePath!,
    });
  }
  assert.ok(adminRoutes.length > 0, 'the frozen contract declares no admin routes — inventory is wrong');

  // Count method-level @Roles('capiro_admin') decorators across all controllers and
  // require one per admin route. Path/method identity is verified exhaustively by
  // scripts/verify-phase8-session3.mjs; this asserts the ROLE side specifically.
  const adminDecorators = ALL_CONTROLLERS.match(/@Roles\('capiro_admin'\)/g) ?? [];
  assert.equal(
    adminDecorators.length,
    adminRoutes.length,
    `frozen contract declares ${adminRoutes.length} capiro_admin routes but the controllers carry ${adminDecorators.length} @Roles('capiro_admin') decorators`,
  );

  // Class-level default must be standard_user, so a new handler cannot land
  // unauthenticated by omission.
  for (const [label, source] of [
    ['program-element', NEXT_PE_CONTROLLER],
    ['budget-lines', NEXT_BL_CONTROLLER],
    ['programs', NEXT_PROGRAMS_CONTROLLER],
  ] as const) {
    assert.match(
      source,
      /@Roles\('standard_user'\)/,
      `${label} controller has no class-level standard_user default`,
    );
  }
});

test('PARITY: every controller runs the full guard chain — session, membership, role', () => {
  for (const [label, source] of [
    ['program-element', NEXT_PE_CONTROLLER],
    ['budget-lines', NEXT_BL_CONTROLLER],
    ['programs', NEXT_PROGRAMS_CONTROLLER],
  ] as const) {
    const guards = /@UseGuards\(([^)]*)\)/.exec(source)?.[1] ?? '';
    for (const guard of ['TenantGuard', 'DefenseMemberResolverGuard', 'RolesGuard']) {
      assert.ok(guards.includes(guard), `${label} controller is missing ${guard}`);
    }
    // Order matters: a role check before membership resolution would read an
    // unresolved role.
    assert.ok(
      guards.indexOf('DefenseMemberResolverGuard') < guards.indexOf('RolesGuard'),
      `${label} controller resolves membership AFTER checking the role`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Tenant isolation
// ---------------------------------------------------------------------------

test('PARITY: every tenant-scoped surface operates inside a tenant transaction', () => {
  const TENANT_SCOPED: Array<[string, string, string]> = [
    ['watch write', NEXT_PE, 'setWatching'],
    ['email pref read', NEXT_PE, 'getPeAlertEmailPref'],
    ['email pref write', NEXT_PE, 'setPeAlertEmailPref'],
    ['needs-attention relevance', NEXT_PE, 'tenantRelevantPeCodes'],
    ['watchlist signals', NEXT_BL, 'getWatchSignals'],
    ['data issue create', NEXT_ISSUES, 'create'],
    ['data issue list (pe)', NEXT_ISSUES, 'listForPe'],
    ['data issue list (admin)', NEXT_ISSUES, 'listAdmin'],
    ['data issue resolve', NEXT_ISSUES, 'resolve'],
  ];
  for (const [label, source, method] of TENANT_SCOPED) {
    // Anchor on the DECLARATION. Searching for `${method}(` alone finds the first
    // CALL site, which for a private helper sits in another method entirely -- and
    // would then assert tenant scoping against the wrong body.
    let start = source.indexOf(`private async ${method}(`);
    if (start === -1) start = source.indexOf(`async ${method}(`);
    assert.notEqual(start, -1, `could not find ${label} (${method})`);
    const rest = source.slice(start);
    const nextMember = rest.search(/\n {2}(?:\/\*\*|async |private |public )/);
    const body = nextMember === -1 ? rest : rest.slice(0, nextMember);
    assert.match(
      body,
      /withTenant(?:Actor)?\(/,
      `${label} does not run inside withTenant/withTenantActor — tenant isolation is not enforced`,
    );
  }
});

test('PARITY: no generic RLS-bypass or system-query escape hatch exists', () => {
  // Scan CODE, not prose. `scripts/verify-phase8-session3.mjs` strips comments for
  // the same reason: a doc comment that explains why the governed admin function
  // confines app.bypass_rls to its own membership check is documentation, not an
  // escape hatch, and failing on it would push that explanation out of the source.
  for (const [label, source] of [
    ['program-element-read', NEXT_PE],
    ['budget-lines-read', NEXT_BL],
    ['programs', NEXT_PROGRAMS],
    ['data-issues', NEXT_ISSUES],
  ] as const) {
    const code = stripComments(source);
    assert.ok(!/app\.bypass_rls/.test(code), `${label} references app.bypass_rls in executable code`);
    assert.ok(!/\bwithSystem\b/.test(code), `${label} references withSystem in executable code`);
  }
});

/** Drop block and line comments so an assertion tests behaviour, not prose. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

test('PARITY: the mutating watch path writes an audit log for BOTH directions', () => {
  const body = NEXT_PE.slice(NEXT_PE.indexOf('async setWatching('), NEXT_PE.indexOf('async getPeAlertEmailPref('));
  const auditWrites = body.match(/auditLog\.create\(/g) ?? [];
  assert.equal(
    auditWrites.length,
    2,
    'watch on and watch off must each write an audit log (apps/api writes both)',
  );
});

// ---------------------------------------------------------------------------
// 3. Error behaviour
// ---------------------------------------------------------------------------

test('PARITY: every PE-scoped read 404s on an unknown Program Element', () => {
  const MUST_404 = [
    'getProgramElement',
    'getIntelligence',
    'getTimeline',
    'getBills',
    'getBillActions',
    'getContractors',
    'getProjects',
    'getProcurementLines',
    'getSources',
    'getRelatedProgramElements',
    'getBudgetPositions',
    'getPbComparison',
    'getDeltas',
    'setWatching',
  ];
  const missing: string[] = [];
  for (const method of MUST_404) {
    const start = NEXT_PE.indexOf(`async ${method}(`);
    assert.notEqual(start, -1, `could not find ${method}`);
    const rest = NEXT_PE.slice(start);
    const nextMember = rest.search(/\n {2}(?:\/\*\*|async |private |public )/);
    const body = nextMember === -1 ? rest : rest.slice(0, nextMember);
    if (!/NotFoundException/.test(body)) missing.push(method);
  }
  assert.deepEqual(missing, [], `these reads do not 404 on an unknown PE: ${missing.join(', ')}`);
});

test('PARITY: invalid input is refused at the service layer, not only by the HTTP DTO', () => {
  // A DTO protects the HTTP route. It does nothing for a direct service call, so the
  // audit's "unvalidated at the service layer" finding is a real hole, not a style
  // preference.
  for (const validator of [
    'normalizeFy',
    'normalizeFieldName',
    'normalizeSourceUrl',
    'normalizeResolutionNotes',
    'normalizeStatusFilter',
    'requireIssueType',
    'requireDescription',
  ]) {
    assert.ok(
      NEXT_ISSUES.includes(`private ${validator}(`),
      `data-issue service has no service-layer ${validator}`,
    );
  }
  // requirePeCode throws on empty/oversized codes rather than silently querying ''.
  const shared = read('apps/defense-api/src/program-elements/program-elements.shared.ts');
  assert.match(shared, /peCode is required/);
  assert.match(shared, /peCode is too long/);
});

test('PARITY: conflict / duplicate-state / invalid-transition all still throw', () => {
  // Watch: legacy tenant-key rollout conflict -> 409 with a stable code.
  assert.match(NEXT_PE, /ConflictException\(\{/);
  assert.match(NEXT_PE, /PE_WATCH_TENANT_KEY_ROLLOUT_PENDING/);

  // Reconciliation: already-resolved entry cannot be re-resolved.
  assert.match(NEXT_PE, /is already \$\{entry!\.status\}/);

  // Programs: curated seed protection, duplicate alias, last canonical alias,
  // already-merged program, identical merge ids.
  assert.match(NEXT_PROGRAMS, /Curated MDAP seed matches cannot be rejected\/quarantined/);
  assert.match(NEXT_PROGRAMS, /already exists on this program/);
  assert.match(NEXT_PROGRAMS, /last 'canonical' alias/);
  assert.match(NEXT_PROGRAMS, /is already merged/);
  assert.match(NEXT_PROGRAMS, /must differ/);

  // Data issues: re-resolving a closed issue is refused.
  assert.match(NEXT_ISSUES, /cannot be re-resolved/);
});

test('PARITY: resolveMatch is idempotent on a repeat of the same decision', () => {
  // apps/api explicitly allows re-resolving to the same status (it re-records who
  // confirmed it). The prior defense-api implementation required
  // status === 'candidate' and 400'd, so accept-then-accept failed.
  const body = NEXT_PROGRAMS.slice(
    NEXT_PROGRAMS.indexOf('async resolveMatch('),
    NEXT_PROGRAMS.indexOf('private assertAliasType('),
  );
  assert.ok(body.length > 100, 'could not slice resolveMatch');
  assert.ok(
    !/match\.status !== 'candidate'/.test(body),
    'resolveMatch still refuses any non-candidate row, breaking idempotent re-resolution',
  );
});

test('PARITY: the HTTP runtime holds no promoter / parser / GPU / DDL authority', () => {
  // Mirrors the permanent verifier, asserted here too so the parity gate alone
  // cannot pass on a build that quietly gained one of these.
  const ALL = [NEXT_PE, NEXT_BL, NEXT_PROGRAMS, NEXT_ISSUES, ALL_CONTROLLERS].join('\n');
  for (const [label, pattern] of [
    ['promoter role', /capiro_pe_promoter/],
    ['promoter env', /DEFENSE_PROMOTER_/],
    ['snapshot activation', /activateSnapshot|promoteSnapshot|promoteCanonical/i],
    ['active-snapshot write', /(INSERT\s+INTO|UPDATE)\s+"?defense_budget_active_snapshot"?/i],
    ['GPU credential', /GPU_[A-Z_]*CREDENTIAL/i],
    ['parser credential', /\bPARSER_[A-Z_]*KEY\b/],
    ['NVIDIA runtime', /nvidia|cuda/i],
    ['PE->BLIN coercion', /peCodeToBlin|resolveBlinFromPeCode|blinFromPeCode|peCodeToOmBli/i],
    ['DDL', /\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX|VIEW|MATERIALIZED)/i],
  ] as const) {
    assert.ok(!pattern.test(ALL), `the Session 3 HTTP surface references ${label}`);
  }

  // conference_probability is READ-only from the HTTP plane (GAI-25: a read must
  // never write). No grant exists either, so this is belt AND braces.
  const conf = read('apps/defense-api/src/program-elements/conference-probability-read.service.ts');
  assert.ok(
    !/INSERT\s+INTO\s+conference_probability/i.test(conf),
    'the conference forecast read path writes to conference_probability',
  );
  assert.ok(
    !/upsertPrediction\s*\(/.test(conf),
    'the persisting forecast branch leaked into the read service',
  );
});
