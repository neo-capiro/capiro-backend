#!/usr/bin/env node
/**
 * Phase 8 Session 10 — production schedule ownership, static gate.
 *
 * Asserts the structural guarantees a reviewer cannot check by reading:
 *
 *   1. The migration is additive, append-only in privilege (no DELETE granted
 *      to either role), and its id column uses dbgenerated, not @default(uuid()).
 *   2. The Prisma model mirrors the table exactly.
 *   3. The domain half (packages/defense-domain) contains no fiscal-year or
 *      calendar-year literal anywhere near due-ness — Session 10 must not
 *      reintroduce a "current year" assumption Session 7 deliberately avoided.
 *   4. The new defense-api surface stays dark: no @Cron/ScheduleModule/
 *      EventBridge/setInterval, no new HTTP route, no NVIDIA/GPU naming.
 *   5. When schedule product code changes, its frozen Session 7-9 primitives are BYTE-IDENTICAL
 *      to origin/main — the only permitted diff under budget-lifecycle/ is the
 *      module registration file itself plus the new schedule/ directory.
 *   6. The coordinator's runAdapter() call site supplies no fiscalYear/
 *      authorityTrack/cycleId, and neither it nor the schedule audit store
 *      references a lifecycle table directly — scheduling at the adapter
 *      level cannot collapse the (fiscalYear, authorityTrack) model, because
 *      the coordinator is structurally incapable of writing lifecycle data
 *      or overriding what runAdapter/the Session 7 controller decides.
 *   7. Gates, scripts and docs exist.
 *
 * Prohibition checks strip comments first. Session 7's closeout found this
 * the hard way — five checks failed on the doc comments asserting the very
 * thing they check — and Session 9 found a CRLF variant of the same bug: a
 * bare `/--.*$/`/`/\/\/.*$/` silently strips NOTHING on a CRLF checkout,
 * because `\r` is itself a line terminator a JS regex `.`/`$` will not cross.
 * Both strippers here normalise line endings FIRST, verbatim from Session 9.
 */
import { execSync, execFileSync } from 'node:child_process';
import { frozenScheduleProblems } from './verify-phase8-session10-change-scope.mjs';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function resolveRepoRoot(start = process.cwd()) {
  let current = start;
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

const root = resolveRepoRoot();
const failures = [];
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(root, relative));
const fail = (message) => failures.push(message);

const requireTokens = (relative, tokens, label) => {
  if (!exists(relative)) {
    fail(`Missing ${label}: ${relative}`);
    return null;
  }
  const content = read(relative);
  for (const token of tokens) {
    if (!content.includes(token)) fail(`${label} is missing required token: ${token}`);
  }
  return content;
};

// Load-bearing: see the file header. Verbatim from Session 9's verifier.
const normaliseEol = (content) => content.replace(/\r\n?/g, '\n');

const stripComments = (content) =>
  normaliseEol(content)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');

const stripSqlComments = (content) =>
  normaliseEol(content)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

// ── 1. Migration: additive, append-only privilege, dbgenerated id ──────────

const MIGRATION_DIR =
  'apps/api/prisma/migrations/20261211120000_phase8_session10_schedule_control_plane';
const migrationSql = requireTokens(
  `${MIGRATION_DIR}/migration.sql`,
  [
    'CREATE TABLE "defense_budget_schedule_tick"',
    'gen_random_uuid()',
    'dbst_outcome_chk',
    'dbst_outcome_failure_reason_chk',
    'dbst_partition_chk',
    'dbst_due_bounds_chk',
    'REVOKE ALL ON TABLE "defense_budget_schedule_tick" FROM PUBLIC',
    'GRANT SELECT ON TABLE "defense_budget_schedule_tick" TO "capiro_defense_serve"',
    'GRANT SELECT, INSERT, UPDATE ON TABLE "defense_budget_schedule_tick" TO "capiro_defense_job"',
  ],
  'Session 10 migration',
);

if (migrationSql) {
  const strippedSql = stripSqlComments(migrationSql);
  if (/\bDELETE\b/i.test(strippedSql)) {
    // The word DELETE should not appear at all once this migration's own
    // explanatory SQL comments are stripped: this table is a run record with
    // no deletion path, matching defense_budget_watcher_run.
    fail('Session 10 migration must not grant or perform DELETE anywhere');
  }
}

// ── 2. Prisma model mirrors the table ───────────────────────────────────────

const schema = requireTokens(
  'apps/api/prisma/schema.prisma',
  [
    'model DefenseBudgetScheduleTick',
    '@@map("defense_budget_schedule_tick")',
    'dbgenerated("gen_random_uuid()")',
  ],
  'Prisma schema',
);
if (schema) {
  const modelMatch = schema.match(/model DefenseBudgetScheduleTick \{[\s\S]*?\n\}/);
  if (!modelMatch) {
    fail('DefenseBudgetScheduleTick model block could not be isolated in schema.prisma');
  } else if (/@default\(uuid\(\)\)/.test(modelMatch[0])) {
    fail(
      'DefenseBudgetScheduleTick.id drifts against the SQL default: uses @default(uuid()) not dbgenerated',
    );
  }
}

// ── 3. Domain: due-ness has no hidden "current year" ────────────────────────

const scheduleDomain = requireTokens(
  'packages/defense-domain/src/budget-lifecycle/schedule.ts',
  [
    'evaluateAdapterDue',
    'selectDueAdapters',
    'sanitizeScheduleFailureReason',
    'buildScheduleTickSummary',
  ],
  'Session 10 domain module',
);
if (scheduleDomain) {
  const strippedDomain = stripComments(scheduleDomain);
  if (/getFullYear|getUTCFullYear|CURRENT_FISCAL_YEAR|currentFiscalYear/.test(strippedDomain)) {
    fail(
      'schedule.ts must not read the calendar year at all: due-ness is (adapterId, nowIso) only',
    );
  }
  if (/\bFY\d{2,4}\b/.test(strippedDomain)) {
    fail('schedule.ts must not name a specific fiscal year');
  }
}
requireTokens(
  'packages/defense-domain/src/budget-lifecycle/index.ts',
  ["export * from './schedule.js';"],
  'defense-domain barrel',
);

// ── 4. defense-api: dark, no new route, no GPU/NVIDIA naming ────────────────

const S10_DEFENSE_API_FILES = [
  'apps/defense-api/src/budget-lifecycle/schedule/schedule-audit.port.ts',
  'apps/defense-api/src/budget-lifecycle/schedule/prisma-schedule-audit.store.ts',
  'apps/defense-api/src/budget-lifecycle/schedule/schedule-coordinator.service.ts',
  'apps/defense-api/src/budget-lifecycle/schedule/testing/schedule-test-doubles.ts',
  'apps/defense-api/src/budget-lifecycle/budget-lifecycle.module.ts',
];

for (const file of S10_DEFENSE_API_FILES) {
  if (!exists(file)) {
    fail(`Missing Session 10 file: ${file}`);
    continue;
  }
  const content = stripComments(read(file));
  if (/@Cron\(|CronExpression|ScheduleModule|EventBridge|setInterval\(/.test(content)) {
    fail(
      `${file} installs an active schedule; Session 10 stays dark until an explicit deployment act`,
    );
  }
  if (/@Controller|@Get\(|@Post\(|@Put\(|@Patch\(|@Delete\(/.test(content)) {
    fail(`${file} declares an HTTP route; the Session 3 surface stays frozen at 49`);
  }
  if (/promote|activateSnapshot|DefenseBudgetPromotion/.test(content)) {
    fail(`${file} references snapshot promotion/activation`);
  }
  if (/sagemaker|nvidia|nemotron|cuda|gpu_?instance/i.test(content)) {
    fail(`${file} names a GPU provider; the Session 3 boundary forbids defense-api from doing so`);
  }
}

requireTokens(
  'apps/defense-api/src/budget-lifecycle/schedule/schedule-audit.port.ts',
  [
    'SCHEDULE_AUDIT_STORE',
    'interface ScheduleAuditStore',
    'loadAdapterScheduleStates',
    'recordScheduleTick',
  ],
  'ScheduleAuditStore port',
);

const moduleContent = read('apps/defense-api/src/budget-lifecycle/budget-lifecycle.module.ts');
if (!/ScheduleCoordinatorService/.test(moduleContent)) {
  fail('budget-lifecycle.module.ts does not register ScheduleCoordinatorService');
}
if (
  !/exports:\s*\[[^\]]*ScheduleCoordinatorService/.test(
    stripComments(moduleContent).replace(/\n/g, ' '),
  )
) {
  fail('ScheduleCoordinatorService must be exported from BudgetLifecycleModule');
}

// ── 5. The frozen Session 7-9 surface is untouched ──────────────────────────
//
// For schedule product changes, the only permitted diff under budget-lifecycle/ is the
// module registration file itself (expected to gain new providers — Session 8
// already did) and the new schedule/ directory. Every other file Session 10
// builds on (leases, cursors, the classifier, discovery) must be
// byte-identical, because this session was authorised to add an orchestration
// loop around those primitives, not to change them.

try {
  execSync('git rev-parse --verify origin/main', { cwd: root, stdio: 'ignore' });
  const diffOutput = execFileSync('git', ['diff', '--name-only', 'origin/main'], {
    cwd: root,
    encoding: 'utf8',
  });
  const changed = diffOutput.split(/\r?\n/).filter(Boolean);
  const changes = changed.map((file) => {
    if (file !== 'apps/api/prisma/schema.prisma') return { file };
    let before = null;
    try {
      before = execFileSync('git', ['show', `origin/main:${file}`], {
        cwd: root,
        encoding: 'utf8',
      });
    } catch {}
    return { file, before, after: exists(file) ? read(file) : null };
  });
  // Every current structural invariant above/below still runs. The frozen
  // attribution guard belongs to schedule product work; unrelated discovery
  // fixes are verified by their own gate. Mixed schedule/primitive edits fail.
  const unexpected = frozenScheduleProblems(changes);
  if (unexpected.length > 0) {
    fail(
      'Session 10 modified frozen Session 7-9 files outside budget-lifecycle.module.ts and schedule/: ' +
        unexpected.join(', '),
    );
  }
} catch (error) {
  fail(
    `Could not diff against origin/main to prove the frozen surface is untouched: ${error.message}`,
  );
}

// ── 6. runAdapter() delegation: the coordinator is FY/track-blind ──────────
//
// Merge-gate proof (requested before merging PR #1168): scheduling at the
// adapter level must not collapse the (fiscalYear, authorityTrack) model.
// Structural half — the coordinator's own call site never supplies, and
// therefore cannot override, a fiscal year or authority track; every
// lifecycle decision stays inside runAdapter/the Session 7 controller. The
// behavioural half (two non-adjacent FYs and two tracks genuinely advancing
// independently from one tick) is proven in
// schedule-coordinator.spec.ts's "lifecycle-effect independence" suite.

const coordinatorServicePath =
  'apps/defense-api/src/budget-lifecycle/schedule/schedule-coordinator.service.ts';
if (exists(coordinatorServicePath)) {
  const coordinatorSource = stripComments(read(coordinatorServicePath));
  const runAdapterCall = coordinatorSource.match(/this\.watcher\.runAdapter\(\{([\s\S]*?)\}\)/);
  if (!runAdapterCall) {
    fail(
      `${coordinatorServicePath} does not call this.watcher.runAdapter(...) — delegation cannot be proven`,
    );
  } else {
    const forbidden = [
      'fiscalYear',
      'authorityTrack',
      'cycleId',
      'expectedSourceId',
      'expectedSourceDedupKey',
    ];
    for (const key of forbidden) {
      if (new RegExp(`\\b${key}\\b`).test(runAdapterCall[1])) {
        fail(
          `${coordinatorServicePath}'s runAdapter() call site supplies "${key}" — the coordinator must ` +
            'stay FY/track-blind and delegate that decision entirely to runAdapter/the Session 7 controller',
        );
      }
    }
  }
  // The coordinator (and its audit store) must be structurally incapable of
  // writing lifecycle data itself — only Session 7's own store does that.
  const LIFECYCLE_TABLES = [
    'defense_budget_cycle',
    'defense_budget_expected_source',
    'defense_budget_source_observation',
    'defense_budget_ingestion_outbox',
  ];
  for (const table of LIFECYCLE_TABLES) {
    if (coordinatorSource.includes(table)) {
      fail(
        `${coordinatorServicePath} references ${table} directly; it must delegate all lifecycle writes to runAdapter`,
      );
    }
  }
}

const scheduleAuditStoreFiles = [
  'apps/defense-api/src/budget-lifecycle/schedule/schedule-audit.port.ts',
  'apps/defense-api/src/budget-lifecycle/schedule/prisma-schedule-audit.store.ts',
];
for (const file of scheduleAuditStoreFiles) {
  if (!exists(file)) continue;
  const content = read(file);
  for (const table of [
    'defense_budget_cycle',
    'defense_budget_expected_source',
    'defense_budget_source_observation',
    'defense_budget_ingestion_outbox',
  ]) {
    if (content.includes(table)) {
      fail(
        `${file} references ${table}; the schedule audit store must touch only watcher_adapter (read) and schedule_tick (write)`,
      );
    }
  }
}

// ── 7. Gates, scripts and docs exist ────────────────────────────────────────

requireTokens(
  'apps/defense-api/scripts/run-schedule-controller.mjs',
  [
    'PHASE8_SESSION10_TICK_AUTHORIZED',
    '--list-adapters',
    '--plan',
    '--tick',
    'SESSION10_PLAN_ONLY',
  ],
  'Session 10 governed command',
);
requireTokens(
  'scripts/test-phase8-session10-schedule-domain.mjs',
  ["require('../packages/defense-domain/dist/index.js')"],
  'Session 10 domain gate',
);
if (!exists('scripts/verify-phase8-session10-db.mjs'))
  fail('Missing scripts/verify-phase8-session10-db.mjs');
if (!exists('scripts/verify-phase8-session10-db.sh'))
  fail('Missing scripts/verify-phase8-session10-db.sh');
if (!exists('.github/workflows/phase8-session10-schedule-control-plane.yml')) {
  fail('Missing .github/workflows/phase8-session10-schedule-control-plane.yml');
}
if (!exists('docs/defense-budget/phase8-session10-schedule-design.md')) {
  fail('Missing docs/defense-budget/phase8-session10-schedule-design.md');
}
if (!exists('docs/defense-budget/phase8-session10-schedule-handoff.md')) {
  fail('Missing docs/defense-budget/phase8-session10-schedule-handoff.md');
}
if (!exists('docs/runbooks/defense-schedule-control-plane-v1.md')) {
  fail('Missing docs/runbooks/defense-schedule-control-plane-v1.md');
}

const rootPackageJson = read('package.json');
for (const script of [
  '"verify:phase8-session10"',
  '"verify:phase8-session10:db"',
  '"verify:phase8-session10:domain"',
  '"verify:phase8-session10:runtime"',
]) {
  if (!rootPackageJson.includes(script)) fail(`Root package.json is missing script ${script}`);
}

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error('SESSION10_SCHEDULE_CONTROL_PLANE_FAIL');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('SESSION10_SCHEDULE_CONTROL_PLANE_PASS');
