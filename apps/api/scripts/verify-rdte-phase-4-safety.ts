/** Permanent Phase 4 architecture, command, and migration safety gate. */
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
      if (entry.isDirectory()) walk(full);
      else if (filter(entry.name)) {
        files[path.relative(API_ROOT, full).replace(/\\/g, '/')] = fs.readFileSync(full, 'utf8');
      }
    }
  };
  walk(dir);
  return files;
}

function requireText(
  failures: string[],
  file: string,
  source: string,
  text: string,
  label: string,
): void {
  if (!source.includes(text)) failures.push(`[${label}] ${file} is missing required invariant`);
}

function main(): void {
  const failures: string[] = [];
  const rdteSources = collect(
    path.join(API_ROOT, 'src', 'defense-budget', 'rdte'),
    (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'),
  );
  const phase4Scripts: Record<string, string> = {};
  for (const script of [
    'scripts/build-rdte-cycle.ts',
    'scripts/report-rdte-cycle.ts',
    'scripts/plan-rdte-canonical-projection.ts',
    'scripts/verify-rdte-phase-4-safety.ts',
  ]) {
    const full = path.join(API_ROOT, script);
    if (fs.existsSync(full)) phase4Scripts[script] = fs.readFileSync(full, 'utf8');
  }

  for (const violation of runRdtePhase4Gates({
    files: { ...rdteSources, ...phase4Scripts },
  })) {
    failures.push(
      `[${violation.gateId}] ${violation.file}:${violation.line} — ${violation.excerpt}`,
    );
  }

  const build = phase4Scripts['scripts/build-rdte-cycle.ts'] ?? '';
  requireText(
    failures,
    'scripts/build-rdte-cycle.ts',
    build,
    'new ParserRouterV1Service(',
    'phase3_router_required',
  );
  requireText(
    failures,
    'scripts/build-rdte-cycle.ts',
    build,
    'rdteVerificationRefFromResult',
    'phase2_result_required',
  );
  requireText(
    failures,
    'scripts/build-rdte-cycle.ts',
    build,
    '--max-paid-pages',
    'paid_cap_required',
  );
  for (const forbidden of [
    '--pages-dir',
    '--verifications',
    'fixture://',
    'ProgramElementWriterService',
  ]) {
    if (build.includes(forbidden)) {
      failures.push(`[annual_command] forbidden legacy/canonical token ${forbidden}`);
    }
  }

  const projection = phase4Scripts['scripts/plan-rdte-canonical-projection.ts'] ?? '';
  requireText(
    failures,
    'scripts/plan-rdte-canonical-projection.ts',
    projection,
    'planProofBoundRdteCanonicalProjection',
    'proof_bound_projection_required',
  );
  if (!projection.includes("process.argv.includes('--commit')")) {
    failures.push('[projection_command] --commit refusal is missing');
  }

  for (const directory of [
    '20260817010000_rdte_phase4_projection_schema',
    '20260818010000_rdte_phase4_closeout_constraints',
  ]) {
    const migration = path.join(API_ROOT, 'prisma', 'migrations', directory, 'migration.sql');
    if (!fs.existsSync(migration)) {
      failures.push(`[migration] ${directory} is missing`);
      continue;
    }
    const sql = fs.readFileSync(migration, 'utf8');
    for (const pattern of [/\bDROP\s+TABLE\b/i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i]) {
      if (pattern.test(sql)) failures.push(`[migration] destructive SQL in ${directory}`);
    }
  }
  const closeout = fs.readFileSync(
    path.join(
      API_ROOT,
      'prisma',
      'migrations',
      '20260818010000_rdte_phase4_closeout_constraints',
      'migration.sql',
    ),
    'utf8',
  );
  for (const required of [
    'program_element_project_budget_position_project_fkey',
    'program_element_project_budget_position_provenance_check',
    'program_element_milestone_schedule_period_shape_check',
    'program_element_milestone_schedule_period_provenance_check',
  ]) {
    if (!closeout.includes(required)) failures.push(`[migration] missing ${required}`);
  }

  if (failures.length > 0) {
    console.error('Phase 4 safety gates FAILED:');
    failures.forEach((failure) => console.error(`  ${failure}`));
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      ok: true,
      filesScanned: Object.keys(rdteSources).length + Object.keys(phase4Scripts).length,
      annualCommand: 'Phase 3 + Phase 2 + reconciliation + proof-bound projection',
      migrations: 'two additive forward migrations',
    }),
  );
}

main();
