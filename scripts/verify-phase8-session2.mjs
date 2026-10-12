#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=0 helpExit=0 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const usage =
  'Usage: node scripts/verify-phase8-session2.mjs (no arguments runs the existing verifier)';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(usage);
  process.exit(0);
}
if (args.length !== 0) {
  console.error(usage);
  process.exit(2);
}
console.error(usage);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

const required = [
  'apps/defense-api/package.json',
  'apps/defense-api/Dockerfile',
  'apps/defense-api/prisma/schema.prisma',
  'apps/defense-api/prisma/defense-model-subset.json',
  'apps/defense-api/scripts/entrypoint.sh',
  'apps/defense-api/src/main.ts',
  'apps/defense-api/src/app.module.ts',
  'apps/defense-api/src/health/readiness-policy.ts',
  'apps/defense-api/src/health/health.controller.ts',
  'apps/defense-api/src/health/health.service.ts',
  'apps/defense-api/src/internal-auth/internal-auth-core.ts',
  'apps/defense-api/src/internal-auth/internal-auth.guard.ts',
  'apps/api/prisma/migrations/20261120200000_phase8_defense_runtime_roles/migration.sql',
  'docs/defense-budget/phase-8-session-2-ownership.json',
  'docs/handoffs/phase-8-defense-api-session-2-handoff.md',
];
for (const relative of required) read(relative);

const pkg = JSON.parse(read('apps/defense-api/package.json'));
for (const dependency of [
  '@capiro/auth',
  '@capiro/defense-contracts',
  '@capiro/defense-domain',
  '@capiro/defense-client',
]) {
  assert.equal(pkg.dependencies?.[dependency], 'workspace:*', `${dependency} must be workspace:*`);
}

const main = read('apps/defense-api/src/main.ts');
for (const token of [
  "setGlobalPrefix('api'",
  'enableShutdownHooks()',
  'bodyParser: false',
  'captureRawBody',
  'forbidNonWhitelisted: true',
  'DEFENSE_HTTP_BODY_LIMIT',
  'assertDefenseServeEnvironment()',
]) {
  if (!main.includes(token)) failures.push(`main.ts missing ${token}`);
}

const policy = read('apps/defense-api/src/health/readiness-policy.ts');
if (!policy.includes("signals.cutoverMode === 'dark'")) {
  failures.push('dark readiness mode does not explicitly tolerate absent snapshot');
}
if (!policy.includes("domainAvailability === 'available'")) {
  failures.push('strict readiness does not require domain availability');
}

const health = read('apps/defense-api/src/health/health.service.ts');
for (const token of [
  'pg_has_role',
  'defense_budget_active_snapshot',
  'database_role_unauthorized',
]) {
  if (!health.includes(token) && !policy.includes(token)) {
    failures.push(`readiness boundary missing ${token}`);
  }
}

const internalCore = read('apps/defense-api/src/internal-auth/internal-auth-core.ts');
for (const token of [
  'timingSafeEqual',
  'createHmac',
  'contentSha256',
  'pathWithQuery',
  'timestamp_outside_window',
]) {
  if (!internalCore.includes(token)) failures.push(`internal auth missing ${token}`);
}

const guard = read('apps/defense-api/src/internal-auth/internal-auth.guard.ts');
for (const token of [
  'DEFENSE_INTERNAL_SERVICE_ALLOWLIST',
  'DEFENSE_INTERNAL_SERVICE_KEYS_JSON',
  'Internal request replayed',
  'body digest mismatch',
]) {
  if (!guard.includes(token)) failures.push(`internal guard missing ${token}`);
}

const entrypoint = read('apps/defense-api/scripts/entrypoint.sh');
for (const refused of ['migrate', 'promote', 'activate', 'parse', 'benchmark']) {
  if (!entrypoint.includes(refused)) failures.push(`entrypoint does not refuse ${refused}`);
}
if (!entrypoint.includes('dist/config/validate-cli.js'))
  failures.push('entrypoint validate-config does not use canonical validation');
if (!/case "\$mode"/.test(entrypoint)) failures.push('entrypoint has no bounded mode switch');

const dockerfile = read('apps/defense-api/Dockerfile');
for (const token of ['public.ecr.aws/docker/library/node:', 'USER capiro', 'dumb-init']) {
  if (!dockerfile.includes(token)) failures.push(`Dockerfile missing ${token}`);
}
for (const forbidden of ['nvidia/cuda', 'nvidia-smi', 'promote-snapshot']) {
  if (dockerfile.toLowerCase().includes(forbidden)) {
    failures.push(`Dockerfile contains forbidden serve dependency ${forbidden}`);
  }
}

const schema = read('apps/defense-api/prisma/schema.prisma');
if (!schema.includes('output          = "../generated/prisma-client"')) {
  failures.push('defense-api must use a custom generated Prisma client');
}
if (fs.existsSync(file('apps/defense-api/prisma/migrations'))) {
  failures.push('defense-api must not own an independent migration ledger');
}

const migration = read(
  'apps/api/prisma/migrations/20261120200000_phase8_defense_runtime_roles/migration.sql',
);
for (const token of [
  'capiro_defense_serve',
  'capiro_defense_job',
  'NOLOGIN',
  'NOBYPASSRLS',
  'GRANT SELECT ON TABLE defense_budget_active_snapshot TO capiro_defense_serve',
]) {
  if (!migration.includes(token)) failures.push(`role migration missing ${token}`);
}
for (const role of ['capiro_defense_serve', 'capiro_defense_job']) {
  const definition = new RegExp(`CREATE ROLE ${role}([\\s\\S]*?);`, 'i').exec(migration)?.[1] ?? '';
  if (!definition.includes('NOLOGIN') || !definition.includes('NOBYPASSRLS')) {
    failures.push(`${role} is not explicitly NOLOGIN and NOBYPASSRLS`);
  }
  const withoutNoForms = definition.replaceAll('NOLOGIN', '').replaceAll('NOBYPASSRLS', '');
  if (/\sLOGIN\b/i.test(withoutNoForms) || /\sBYPASSRLS\b/i.test(withoutNoForms)) {
    failures.push(`${role} contains a positive LOGIN/BYPASSRLS grant`);
  }
}
if (/GRANT\s+(?:INSERT|UPDATE|DELETE)[^;]*defense_budget_active_snapshot/i.test(migration)) {
  failures.push('role migration grants active-snapshot mutation');
}

const allDefenseSource = fs
  .readdirSync(file('apps/defense-api/src'), { recursive: true })
  .filter((name) => typeof name === 'string' && name.endsWith('.ts'))
  .map((name) => read(path.join('apps/defense-api/src', name)))
  .join('\n');
for (const forbiddenImport of [
  /from ['"][^'"]*apps\/api\//,
  /from ['"][^'"]*program-element\//,
  /from ['"][^'"]*defense-budget\//,
]) {
  if (forbiddenImport.test(allDefenseSource)) {
    failures.push(`defense-api imports main-api executable source: ${forbiddenImport}`);
  }
}

// Repo-wide guard: none of these strings may appear anywhere under
// apps/defense-api's shipped source. A generic RLS bypass, a promoter
// credential, or snapshot-activation code inside the dark HTTP boundary
// would silently re-create the exact escape hatch Session 2 was built to
// close, so this scans every non-test text file in the tree rather than a
// fixed file list.
//
// Excluded, deliberately:
//   - *.spec.ts: tests legitimately build fixtures (inserting a row into
//     defense_budget_active_snapshot to set up a scenario) and assert
//     negatives (that a role CANNOT do something); neither ships to
//     production.
//   - *.md: documentation (RUNBOOK.md, README.md) legitimately names what
//     was removed and why (e.g. "no withSystem()"); scrubbing docs of the
//     exact term they are explaining the absence of would make them worse,
//     not safer.
//   - comments: this file's own prose about what was removed and why
//     (e.g. "no withSystem()/app.bypass_rls escape hatch here") would
//     otherwise trip the same check it is explaining the absence of.
//   - a line containing pg_has_role/FORBIDDEN: the legitimate uses of
//     "capiro_pe_promoter" and "DEFENSE_PROMOTER_" in this codebase are a
//     membership check that must return false (health.service.ts) and a
//     forbidden-pattern definition that must reject the string
//     (defense-config.validation.ts) -- both are the guard, not the leak.
const DEFENSE_API_ROOT = file('apps/defense-api');
const FORBIDDEN_ANYWHERE = [
  { pattern: /app\.bypass_rls/, label: 'app.bypass_rls (generic RLS bypass GUC)' },
  { pattern: /\bwithSystem\b/, label: 'withSystem (generic system-query escape hatch)' },
  {
    pattern: /capiro_pe_promoter/,
    label: 'capiro_pe_promoter (promoter credential)',
    safeIfLineContains: ['pg_has_role'],
  },
  {
    pattern: /DEFENSE_PROMOTER_/,
    label: 'DEFENSE_PROMOTER_ (promoter credential env)',
    safeIfFileContains: ['FORBIDDEN_SERVE_ENV_PATTERNS'],
  },
  { pattern: /\bactivateSnapshot\b/i, label: 'activateSnapshot (snapshot-activation code)' },
  { pattern: /\bpromoteSnapshot\b/i, label: 'promoteSnapshot (snapshot-activation code)' },
  {
    pattern: /(INSERT\s+INTO|UPDATE)\s+"?defense_budget_active_snapshot"?/i,
    label: 'a write to defense_budget_active_snapshot (snapshot-activation code)',
  },
];
// `runtime-source` is Session 4's byte-identical mirror of apps/api slices, kept
// for the replay gate's tree comparison. It is not executable defense-api code:
// never compiled, never imported, never shipped -- each asserted explicitly after
// the scan, so this exclusion cannot silently become a hole.
const SKIP_DIRS = new Set(['node_modules', 'generated', 'dist', 'runtime-source']);
function walkTextFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkTextFiles(path.join(dir, entry.name), out);
    } else if (entry.isFile() && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.md')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').replace(/--.*$/, ''))
    .join('\n');
}
if (fs.existsSync(DEFENSE_API_ROOT)) {
  for (const absolutePath of walkTextFiles(DEFENSE_API_ROOT)) {
    const relative = path.relative(root, absolutePath).replaceAll('\\', '/');
    const contents = stripComments(fs.readFileSync(absolutePath, 'utf8'));
    for (const { pattern, label, safeIfLineContains, safeIfFileContains } of FORBIDDEN_ANYWHERE) {
      if (safeIfFileContains?.some((safe) => contents.includes(safe))) continue;
      const hit = contents.split('\n').some((line) => {
        if (!pattern.test(line)) return false;
        if (safeIfLineContains?.some((safe) => line.includes(safe))) return false;
        return true;
      });
      if (hit) {
        failures.push(`${relative} contains forbidden ${label}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The Session 4 trusted-source MIRROR is excluded from the executable scan
// above -- but ONLY because the three properties that make it inert are
// asserted here. Without these assertions the exclusion would be a hole.
//
// `apps/defense-api/runtime-source/` is a byte-identical copy of slices of
// `apps/api/src`, and it exists solely so Session 4's replay gate can
// byte-compare the retained and moved trees. It therefore legitimately contains
// `capiro_pe_promoter`, `withSystem` and `app.bypass_rls` -- those strings are
// properties of the mirrored main-API source, not of the defense-api runtime.
//
// It is only safe to exclude it while all three hold:
//   1. it is never compiled (outside the tsconfig include),
//   2. nothing under src/ imports from it, so it cannot execute, and
//   3. it is never copied into the final image.
// If any of those changes, the exclusion stops being sound and this fails.
const MIRROR_DIR = 'apps/defense-api/runtime-source';
if (fs.existsSync(file(MIRROR_DIR))) {
  // 1. Never compiled.
  const defenseTsconfig = JSON.parse(
    read('apps/defense-api/tsconfig.json').replace(/^\s*\/\/.*$/gm, ''),
  );
  const includes = defenseTsconfig.include ?? [];
  if (!includes.every((pattern) => pattern.startsWith('src/'))) {
    failures.push(
      `apps/defense-api/tsconfig.json include (${includes.join(', ')}) may compile ${MIRROR_DIR}; the trusted-source mirror must never be compiled`,
    );
  }

  // 2. Unreachable from executable code.
  const srcRoot = file('apps/defense-api/src');
  if (fs.existsSync(srcRoot)) {
    for (const absolutePath of walkTextFiles(srcRoot)) {
      const relative = path.relative(root, absolutePath).replaceAll('\\', '/');
      const contents = stripComments(fs.readFileSync(absolutePath, 'utf8'));
      if (
        /from\s+['"][^'"]*runtime-source\//.test(contents) ||
        /require\(\s*['"][^'"]*runtime-source\//.test(contents)
      ) {
        failures.push(
          `${relative} imports from ${MIRROR_DIR}; the trusted-source mirror must stay unreachable from executable code`,
        );
      }
    }
  }

  // 3. Never shipped.
  const dockerfile = read('apps/defense-api/Dockerfile');
  const runtimeStageStart = dockerfile.indexOf(' AS runtime');
  const runtimeStage = runtimeStageStart >= 0 ? dockerfile.slice(runtimeStageStart) : dockerfile;
  if (runtimeStage.includes('runtime-source')) {
    failures.push(
      `the final defense-api image copies ${MIRROR_DIR}; the trusted-source mirror must never ship`,
    );
  }
}

const ownership = JSON.parse(read('docs/defense-budget/phase-8-session-2-ownership.json'));
assert.equal(ownership.session, 2);
assert.equal(ownership.deploymentPosture, 'dark');
assert.equal(ownership.mutations.aws, false);
assert.equal(ownership.mutations.sharedDatabase, false);
assert.equal(ownership.cutoverAuthorized, false);

if (failures.length) {
  console.error(`SESSION2_BOUNDARY_FAIL (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('SESSION2_BOUNDARY_PASS');
console.log('dark scaffold, safe readiness, internal auth, and additive role boundary verified');
