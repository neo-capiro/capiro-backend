/**
 * Engagement API Phase 1 — DB-free runtime verifier.
 *
 * Runs the Phase 1 test suite (runtime policy, route coverage, timer
 * containment, external boundaries, app module, bootstrap, health) and
 * the API build. Does NOT connect to a database, call AWS, call OAuth
 * providers, call Recall, call an LLM, or send mail.
 *
 * Usage:
 *   pnpm --filter @capiro/api verify:engagement-phase-1
 *
 * Exits 0 on success, 1 on failure.
 */
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const apiDir = __dirname;
const repoRoot = path.resolve(apiDir, '..', '..');

function run(label: string, command: string): void {
  console.log(`\n==> ${label}`);
  try {
    execSync(command, { cwd: apiDir, stdio: 'inherit' });
  } catch {
    console.error(`\n✗ ${label} FAILED`);
    process.exit(1);
  }
  console.log(`✓ ${label} passed`);
}

console.log('=== Engagement API Phase 1 — DB-free runtime verifier ===\n');

// 1. Phase 0 verifier (prerequisite).
run(
  'Phase 0 verifier',
  'pnpm run verify:engagement-phase-0',
);

// 2. Runtime policy + route coverage + timer containment + external
//    boundaries + app module + bootstrap + health + entrypoint tests.
run(
  'Phase 1 test suite (runtime contract + containment)',
  'pnpm run verify:engagement-phase-1',
);

// 3. API build — must produce both entrypoints.
run(
  'API build (nest build)',
  'pnpm run build',
);

// 4. Assert dist/engagement-main.js exists.
const engagementMain = path.join(apiDir, 'dist', 'engagement-main.js');
if (!fs.existsSync(engagementMain)) {
  console.error(`\n✗ dist/engagement-main.js not found after build`);
  process.exit(1);
}
console.log('✓ dist/engagement-main.js exists');

// 5. Assert dist/main.js exists (main API entrypoint must still build).
const mainJs = path.join(apiDir, 'dist', 'main.js');
if (!fs.existsSync(mainJs)) {
  console.error(`\n✗ dist/main.js not found after build`);
  process.exit(1);
}
console.log('✓ dist/main.js exists');

// 6. Assert no web routing / preview change.
//    The web API client must still point at the main API (:4000), not at
//    engagement-api (:4500). We do a static check: no VITE_ENGAGEMENT_API_URL
//    in any web source file.
try {
  const output = execSync(
    'grep -rn "VITE_ENGAGEMENT_API_URL" apps/web/src/ 2>/dev/null || true',
    { cwd: repoRoot, encoding: 'utf-8' },
  );
  if (output.trim()) {
    console.error('\n✗ VITE_ENGAGEMENT_API_URL found in web source — preview routing is a Phase 1 non-goal');
    process.exit(1);
  }
} catch {
  // grep found nothing — that's correct
}
console.log('✓ No web preview routing change detected');

console.log('\n=== Phase 1 DB-free verifier: ALL CHECKS PASSED ===');
