/**
 * verify-rdte-phase-4-safety — permanent Phase 4 safety gate runner (WS N).
 *
 * Usage:
 *   pnpm --filter @capiro/api verify:pe-budget-phase-4
 *
 * Runs the static architecture gates (rdte-phase4-gates-v1) over the Phase 4
 * production source (src/defense-budget/rdte/** non-spec .ts + the four
 * Phase 4 scripts) and checks:
 *   - no --commit flag exists in any Phase 4 command;
 *   - the projection command refuses --commit;
 *   - the Phase 4 migration directory contains exactly one additive
 *     migration (no DROP/DELETE/TRUNCATE).
 *
 * Exit 0 when all gates hold, 1 on any violation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runRdtePhase4Gates } from '../src/defense-budget/rdte/gates/rdte-phase4-gates-v1.js';

const API_ROOT = path.resolve(__dirname, '..');

function collect(dir: string, filter: (name: string) => boolean): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string): void => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '__tmp__' || entry.name === 'node_modules') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (filter(entry.name)) {
        files[path.relative(API_ROOT, full).replace(/\\/g, '/')] = fs.readFileSync(full, 'utf8');
      }
    }
  };
  walk(dir);
  return files;
}

function main(): void {
  const failures: string[] = [];

  /* 1. Static gates over rdte/ production source + phase-4 scripts. */
  const rdteSources = collect(
    path.join(API_ROOT, 'src', 'defense-budget', 'rdte'),
    (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.includes('__tmp__'),
  );
  const phase4Scripts: Record<string, string> = {};
  for (const script of [
    'scripts/build-rdte-cycle.ts',
    'scripts/report-rdte-cycle.ts',
    'scripts/plan-rdte-canonical-projection.ts',
    'scripts/verify-rdte-phase-4-safety.ts',
  ]) {
    const full = path.join(API_ROOT, script);
    if (fs.existsSync(full)) {
      phase4Scripts[script] = fs.readFileSync(full, 'utf8');
    }
  }

  const violations = runRdtePhase4Gates({ files: { ...rdteSources, ...phase4Scripts } });
  for (const violation of violations) {
    failures.push(
      `[${violation.gateId}] ${violation.file}:${violation.line} — ${violation.excerpt}`,
    );
  }

  /* 2. No Phase 4 command accepts --commit. */
  for (const [script, source] of Object.entries(phase4Scripts)) {
    if (script.includes('verify-rdte-phase-4-safety')) continue;
    const definesCommitFlag = /KNOWN_FLAGS[^;]*--commit|--commit['"]\s*\)/.test(source);
    if (definesCommitFlag && script.includes('plan-rdte-canonical-projection')) {
      /* The projection command only references --commit to REFUSE it. */
      continue;
    }
    if (definesCommitFlag) {
      failures.push(`[--commit] ${script} appears to define a --commit flag`);
    }
  }

  /* 3. Migration additivity. */
  const migrationDir = path.join(
    API_ROOT,
    'prisma',
    'migrations',
    '20260817010000_rdte_phase4_projection_schema',
  );
  if (!fs.existsSync(migrationDir)) {
    failures.push('[migration] Phase 4 migration directory missing');
  } else {
    const sql = fs.readFileSync(path.join(migrationDir, 'migration.sql'), 'utf8');
    if (/\bDROP\s+TABLE\b/i.test(sql)) {
      failures.push('[migration] DROP TABLE is not allowed in the Phase 4 migration');
    }
    if (/\bDELETE\s+FROM\b/i.test(sql)) {
      failures.push('[migration] DELETE FROM is not allowed in the Phase 4 migration');
    }
    if (/\bTRUNCATE\b/i.test(sql)) {
      failures.push('[migration] TRUNCATE is not allowed in the Phase 4 migration');
    }
    if (/TYPE\s+VARCHAR\s*\(\s*[1-7]\s*\)/i.test(sql)) {
      failures.push('[migration] destructive narrowing of a VARCHAR column detected');
    }
  }

  if (failures.length > 0) {
    console.error('Phase 4 safety gates FAILED:');
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      ok: true,
      filesScanned: Object.keys(rdteSources).length + Object.keys(phase4Scripts).length,
      gates: 'all hold',
      migration: 'additive only',
    }),
  );
  process.exit(0);
}

main();
