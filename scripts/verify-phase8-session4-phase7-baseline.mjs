#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=2 */
// Phase 8 Session 4 — narrow deterministic baseline for `apps/api typecheck:phase7`.
//
// WHY THIS EXISTS, rather than a waiver.
//
// `pnpm --filter @capiro/api typecheck:phase7` does not pass on this branch. It also
// does not pass on clean `origin/main`. Reproduced in a separate worktree at
// origin/main (abcfd88a9, prepared identically: pnpm install --frozen-lockfile,
// @capiro/api prisma:generate, and shared/auth/meriv2-core/defense-* built), the
// failure is the SAME 4 errors, same files, same lines, same symbols -- byte-identical
// after normalizing the absolute path prefix.
//
// Waiving it as "pre-existing" would have been unfalsifiable. Instead the exact
// baseline is encoded below, and this gate FAILS if the real error set ever differs
// from it -- in either direction. A new Phase 8 error is caught. So is a fifth
// unrelated error. So is someone fixing these four and leaving the baseline stale.
//
// All four are TS4053 in the ENGAGEMENT module: a public controller method returns a
// type declared but not exported from its service. Nothing to do with Phase 8 or the
// defense-budget runtime, and no file under src/engagement is touched by this branch.
// Fixing them means exporting those interfaces from the engagement services, which is
// an engagement-module change and does not belong in a Phase 8 consolidation.
//
// Usage:
//   pnpm --filter @capiro/api typecheck:phase7 > /tmp/p7.log 2>&1 || true
//   node scripts/verify-phase8-session4-phase7-baseline.mjs /tmp/p7.log
import fs from 'node:fs';
import process from 'node:process';

/**
 * The accepted baseline, path-normalized. Recorded from clean origin/main
 * (abcfd88a9) and confirmed identical on the Session 4 restack.
 */
const BASELINE = [
  "src/engagement/google/google-integration-actions.controller.ts(42,3): error TS4053: Return type of public method from exported class has or is using name 'SyncResult' from external module \"apps/api/src/engagement/google/google-sync.service\" but cannot be named.",
  "src/engagement/microsoft/microsoft-integration-actions.controller.ts(104,3): error TS4053: Return type of public method from exported class has or is using name 'MicrosoftSubscriptionState' from external module \"apps/api/src/engagement/microsoft/microsoft-graph-sync.service\" but cannot be named.",
  "src/engagement/microsoft/microsoft-integration-actions.controller.ts(68,3): error TS4053: Return type of public method from exported class has or is using name 'SyncResult' from external module \"apps/api/src/engagement/microsoft/microsoft-graph-sync.service\" but cannot be named.",
  "src/engagement/microsoft/microsoft-integration-actions.controller.ts(90,3): error TS4053: Return type of public method from exported class has or is using name 'SyncStats' from external module \"apps/api/src/engagement/microsoft/microsoft-graph-sync.service\" but cannot be named.",
];

/** Strip the absolute worktree prefix so two checkouts compare equal. */
function normalize(line) {
  return line.replace(/[A-Za-z]:[/\\][^"]*?[/\\]apps[/\\]api[/\\]/g, 'apps/api/').replace(/\\/g, '/');
}

const logPath = process.argv[2];
if (!logPath || !fs.existsSync(logPath)) {
  console.error('usage: verify-phase8-session4-phase7-baseline.mjs <typecheck-phase7-output>');
  console.error('  (run the typecheck first, redirecting stdout+stderr to that file)');
  process.exit(2);
}

const actual = fs
  .readFileSync(logPath, 'utf8')
  .split('\n')
  .filter((line) => /error TS\d+/.test(line))
  .map((line) => normalize(line.trim()))
  .sort();

const baseline = [...BASELINE].sort();
const unexpected = actual.filter((line) => !baseline.includes(line));
const missing = baseline.filter((line) => !actual.includes(line));

if (unexpected.length === 0 && missing.length === 0) {
  console.log('PHASE7_TYPECHECK_BASELINE_MATCH');
  console.log(
    `${actual.length} pre-existing TS4053 engagement-module errors, identical to clean origin/main. No Phase 8 regression.`,
  );
  process.exit(0);
}

console.error('PHASE7_TYPECHECK_BASELINE_DRIFT');
if (unexpected.length) {
  console.error(`\n${unexpected.length} error(s) NOT in the baseline — treat as a regression until proven otherwise:`);
  for (const line of unexpected) console.error(`  + ${line}`);
}
if (missing.length) {
  console.error(
    `\n${missing.length} baseline error(s) no longer reproduce. If they were fixed, delete them from BASELINE in this file:`,
  );
  for (const line of missing) console.error(`  - ${line}`);
}
process.exit(1);
