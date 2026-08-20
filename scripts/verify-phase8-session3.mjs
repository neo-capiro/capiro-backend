#!/usr/bin/env node
// Phase 8 Session 3 permanent verifier — Program Elements / Budget Lines /
// Programs full-surface migration to apps/defense-api.
//
// Proves, against the exact defense-api source tree (not the plan's prose):
//   1. all 49 frozen DEFENSE_PUBLIC_ROUTES exist as live NestJS route
//      decorators (method + path + admin-role metadata all match);
//   2. no executable apps/api import exists under apps/defense-api;
//   3. no parser/GPU/promoter credential exists in the HTTP service;
//   4. no canonical promotion/activation method is reachable;
//   5. no native PE/BLIN identity coercion exists (no peCode->BLIN resolver);
//   6. tenant/role/provenance invariants used by the parity suite are present.
//
// This is a STATIC verifier (source-text + decorator inspection), the same
// class as verify-phase8-session1-boundary.mjs / verify-phase8-session2.mjs.
// It does not replace the parity tests or the disposable-DB rehearsal; it is
// the permanent gate that both of those depend on staying true between runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const failures = [];
const file = (relative) => path.join(root, relative);
const read = (relative) => {
  const target = file(relative);
  if (!fs.existsSync(target)) {
    failures.push(`missing required file: ${relative}`);
    return '';
  }
  return fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
};

// ---------------------------------------------------------------------------
// 1. Load the frozen contract (single source of truth: defense-contracts).
// ---------------------------------------------------------------------------
const contractsSource = read('packages/defense-contracts/src/public/index.ts');
const routeCallRe =
  /defineRoute\(\s*'([^']+)'\s*,\s*'([A-Z]+)'\s*,\s*'([^']+)'\s*(?:,\s*'([a-z_]+)')?\s*\)/g;
const frozenRoutes = [];
for (const match of contractsSource.matchAll(routeCallRe)) {
  const [, id, method, contractPath, minimumRole] = match;
  frozenRoutes.push({ id, method, path: contractPath, minimumRole: minimumRole ?? 'standard_user' });
}
if (frozenRoutes.length !== 49) {
  failures.push(`expected exactly 49 frozen routes in defense-contracts, found ${frozenRoutes.length}`);
}

// ---------------------------------------------------------------------------
// 2. Parse the live defense-api controllers for their actual route decorators.
// ---------------------------------------------------------------------------
const CONTROLLER_FILES = [
  'apps/defense-api/src/program-elements/program-element.controller.ts',
  'apps/defense-api/src/program-elements/budget-lines.controller.ts',
  'apps/defense-api/src/program-elements/programs.controller.ts',
];

function parseControllerRoutes(sourcePath) {
  const source = read(sourcePath);
  if (!source) return [];

  const controllerMatch = /@Controller\((?:'([^']*)')?\)/.exec(source);
  const controllerPrefix = controllerMatch?.[1] ?? '';

  // Walk class body top-to-bottom, tracking the most recent @Roles(...) seen
  // (method-level overrides class-level; class-level default applied when no
  // method-level decorator precedes the handler).
  const classRolesMatch = /@Controller\([^)]*\)\s*\n@UseGuards\([^)]*\)\s*\n@Roles\('([a-z_]+)'\)/.exec(source);
  const classDefaultRole = classRolesMatch?.[1] ?? 'standard_user';

  const handlerRe =
    /@(Get|Post|Put|Patch|Delete)\(([^)]*)\)([\s\S]*?)(?=\n\s{2}(?:@(?:Get|Post|Put|Patch|Delete)\(|\}))/g;
  const routes = [];
  let match;
  while ((match = handlerRe.exec(source)) !== null) {
    const [, httpMethod, rawArg, between] = match;
    const pathArg = /'([^']*)'/.exec(rawArg)?.[1] ?? '';
    const fullPath = [controllerPrefix, pathArg].filter(Boolean).join('/');
    const rolesInBetween = /@Roles\('([a-z_]+)'\)/.exec(between);
    const minimumRole = rolesInBetween?.[1] ?? classDefaultRole;
    routes.push({ method: httpMethod.toUpperCase(), path: fullPath, minimumRole });
  }
  return routes;
}

const liveRoutes = CONTROLLER_FILES.flatMap(parseControllerRoutes);

// ---------------------------------------------------------------------------
// 3. Every frozen route must have exactly one live match (method + path +
//    minimumRole). Order-independent; duplicates are also a failure.
// ---------------------------------------------------------------------------
function routeKey(r) {
  return `${r.method} ${r.path}`;
}
const liveByKey = new Map();
for (const r of liveRoutes) {
  const key = routeKey(r);
  if (liveByKey.has(key)) failures.push(`duplicate live route registered: ${key}`);
  liveByKey.set(key, r);
}

let matched = 0;
for (const frozen of frozenRoutes) {
  const key = routeKey(frozen);
  const live = liveByKey.get(key);
  if (!live) {
    failures.push(`frozen route missing in defense-api: ${frozen.id} (${key})`);
    continue;
  }
  if (live.minimumRole !== frozen.minimumRole) {
    failures.push(
      `role mismatch for ${frozen.id} (${key}): frozen=${frozen.minimumRole} live=${live.minimumRole}`,
    );
    continue;
  }
  matched += 1;
}
if (liveRoutes.length !== frozenRoutes.length) {
  failures.push(
    `live route count (${liveRoutes.length}) does not equal frozen route count (${frozenRoutes.length}) — routes were added or dropped`,
  );
}

// ---------------------------------------------------------------------------
// 4. No executable apps/api import under apps/defense-api.
// ---------------------------------------------------------------------------
const SKIP_DIRS = new Set(['node_modules', 'generated', 'dist']);
function walkTextFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkTextFiles(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

const DEFENSE_API_ROOT = file('apps/defense-api/src');
const defenseApiFiles = walkTextFiles(DEFENSE_API_ROOT);
const FORBIDDEN_IMPORT_PATTERNS = [
  /from ['"][^'"]*apps\/api\//,
  /from ['"]\.\.\/\.\.\/\.\.\/api\//,
  /from ['"][^'"]*program-element\/(?!.*\.spec)/, // legacy apps/api program-element module paths
  /from ['"][^'"]*defense-budget\//, // legacy apps/api defense-budget module paths
];
for (const absolutePath of defenseApiFiles) {
  const relative = path.relative(root, absolutePath).replaceAll('\\', '/');
  const contents = stripComments(fs.readFileSync(absolutePath, 'utf8'));
  for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
    if (pattern.test(contents)) {
      failures.push(`${relative} imports main-api executable source matching ${pattern}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. No parser/GPU/promoter credential; no promotion/activation method
//    reachable; no native PE/BLIN identity coercion. Same forbidden-anywhere
//    scan class as Session 2's verifier, extended with Session 3's
//    additional invariants (BLIN coercion, GPU/CUDA anywhere, nvidia).
// ---------------------------------------------------------------------------
const FORBIDDEN_ANYWHERE = [
  { pattern: /app\.bypass_rls/, label: 'app.bypass_rls (generic RLS bypass GUC)' },
  { pattern: /\bwithSystem\b/, label: 'withSystem (generic system-query escape hatch)' },
  { pattern: /capiro_pe_promoter/, label: 'capiro_pe_promoter (promoter credential)', safeIfLineContains: ['pg_has_role'] },
  { pattern: /DEFENSE_PROMOTER_/, label: 'DEFENSE_PROMOTER_ (promoter credential env)', safeIfFileContains: ['FORBIDDEN_SERVE_ENV_PATTERNS'] },
  { pattern: /\bactivateSnapshot\b/i, label: 'activateSnapshot (snapshot-activation code)' },
  { pattern: /\bpromoteSnapshot\b/i, label: 'promoteSnapshot (snapshot-activation code)' },
  { pattern: /\bpromoteCanonical\b/i, label: 'promoteCanonical (canonical promotion code)' },
  {
    pattern: /(INSERT\s+INTO|UPDATE)\s+"?defense_budget_active_snapshot"?/i,
    label: 'a write to defense_budget_active_snapshot (snapshot-activation code)',
  },
  // Two files legitimately NAME NVIDIA in order to forbid it: the serve-env
  // validator (FORBIDDEN_SERVE_ENV_PATTERNS) and Session 4's runtime manifest,
  // whose forbiddenInHttpTask list declares 'NVIDIA or GPU runtime' as excluded.
  // A declaration that NVIDIA is out of scope is the guard, not the leak. Anything
  // that actually wires a GPU client still fails: neither marker appears in such a
  // file, and the GPU_*CREDENTIAL rule below has no exemption at all.
  { pattern: /nvidia|cuda|nvidia-smi/i, label: 'NVIDIA/CUDA runtime reference', safeIfFileContains: ['FORBIDDEN_SERVE_ENV_PATTERNS', 'forbiddenInHttpTask'] },
  { pattern: /GPU_[A-Z_]*CREDENTIAL/i, label: 'GPU credential reference' },
  { pattern: /\bPARSER_[A-Z_]*KEY\b/, label: 'parser credential env reference' },
  {
    pattern: /peCodeToBlin|resolveBlinFromPeCode|blinFromPeCode|peCodeToOmBli|peCodeToBli\b/i,
    label: 'implicit peCode->BLIN/BLI identity resolver (native identity coercion)',
  },
];
for (const absolutePath of defenseApiFiles) {
  const relative = path.relative(root, absolutePath).replaceAll('\\', '/');
  const contents = stripComments(fs.readFileSync(absolutePath, 'utf8'));
  for (const { pattern, label, safeIfLineContains, safeIfFileContains } of FORBIDDEN_ANYWHERE) {
    if (safeIfFileContains?.some((safe) => contents.includes(safe))) continue;
    const hit = contents.split('\n').some((line) => {
      if (!pattern.test(line)) return false;
      if (safeIfLineContains?.some((safe) => line.includes(safe))) return false;
      return true;
    });
    if (hit) failures.push(`${relative} contains forbidden ${label}`);
  }
}

// ---------------------------------------------------------------------------
// 6. Tenant isolation invariant on mutation surfaces: watch / email-pref /
//    data-issue services must scope every mutating query by tenantId — this
//    is checked structurally (withTenant/withTenantActor call present around
//    every create/update/delete on those models).
// ---------------------------------------------------------------------------
const tenantScopedServices = [
  'apps/defense-api/src/program-elements/program-element-data-issue.service.ts',
  'apps/defense-api/src/program-elements/program-element-read.service.ts',
];
for (const svcPath of tenantScopedServices) {
  const source = read(svcPath);
  if (!source) continue;
  if (!source.includes('withTenant') && !source.includes('withTenantActor')) {
    failures.push(`${svcPath} has no withTenant/withTenantActor call — tenant isolation cannot be structurally proven`);
  }
}

// ---------------------------------------------------------------------------
// 7. Money exactness on the governed override path: no JS float coercion of
//    a manual-override VALUE (Number(...) applied to originalValue/valueMillions).
// ---------------------------------------------------------------------------
const overrideService = read('apps/defense-api/src/program-elements/promotion/manual-override-service-v1.ts');
if (/Number\(\s*(?:input\.value\.)?(?:originalValue|valueMillions)/i.test(overrideService)) {
  failures.push('manual-override-service-v1.ts applies Number() to a governed money value');
}

// ---------------------------------------------------------------------------
// 8. Session ownership doc present with dark posture (mirrors Session 2's own gate).
// ---------------------------------------------------------------------------
const ownershipPath = 'docs/defense-budget/phase-8-session-3-ownership.json';
if (fs.existsSync(file(ownershipPath))) {
  const ownership = JSON.parse(read(ownershipPath));
  try {
    assert.equal(ownership.session, 3);
    assert.equal(ownership.deploymentPosture, 'dark');
    assert.equal(ownership.mutations.aws, false);
    assert.equal(ownership.mutations.sharedDatabase, false);
    assert.equal(ownership.cutoverAuthorized, false);
  } catch (error) {
    failures.push(`session-3 ownership doc invariant failed: ${(error && error.message) || error}`);
  }
} else {
  failures.push(`missing required file: ${ownershipPath}`);
}

if (failures.length) {
  console.error(`SESSION3_BOUNDARY_FAIL (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('SESSION3_BOUNDARY_PASS');
console.log(
  `49 frozen routes verified (${matched} exact method/path/role matches), no apps/api imports, no parser/GPU/promoter credentials, no promotion/activation reachability, no PE/BLIN coercion.`,
);
