import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Regression test for the 2026-08-24 Advocacy History production canary
 * defect: `client_profile_fill_finding_source_check` (added/updated in
 * 20261015010000 / 20261120210000 / 20261219010000) never included the
 * seven `source` values the completion workflow
 * (client-profile-fill-completion.service.ts, shipped in migration
 * 20271231030000_client_profile_fill_completion) writes via `addFinding`.
 * completion_audit runs unconditionally on every Fill run, so this was a
 * silent production defect failing every completion-workflow run's final
 * audit step, not just the advocacy_history path.
 *
 * This spec is a PARSER against the frozen constraint source and the real
 * service call sites, not a hardcoded value list -- it will keep catching
 * this exact drift class if a future PR adds an eighth `addFinding` source
 * without a matching constraint update, the same way the sibling
 * `client_profile_fill_finding_kind_check` drift class is guarded.
 */
describe('client_profile_fill_finding_source_check stays in sync with addFinding call sites', () => {
  const service = readFileSync(
    resolve(process.cwd(), 'src/clients/client-profile-fill-completion.service.ts'),
    'utf8',
  );

  // Every migration that has ever touched this constraint, in migration order.
  // The LATEST one wins (Postgres DROP+ADD), so only its value list matters --
  // but we read all of them so a future migration is easy to append here too.
  const migrationFiles = [
    'prisma/migrations/20261015010000_client_profile_fill_with_meri/migration.sql',
    'prisma/migrations/20261120210000_client_profile_fill_capability_document/migration.sql',
    'prisma/migrations/20261219010000_client_profile_fill_bill_recommendation/migration.sql',
    'prisma/migrations/20271231080000_fix_client_profile_fill_finding_source_check/migration.sql',
    'prisma/migrations/20280101020000_outcome_event_regulatory_correlation/migration.sql',
  ];
  const migrations = migrationFiles.map((f) => readFileSync(resolve(process.cwd(), f), 'utf8'));
  const latestMigration: string = migrations[migrations.length - 1]!;

  function extractConstraintValues(sql: string, constraintName: string): string[] | null {
    const re = new RegExp(
      `ADD CONSTRAINT ${constraintName}[\\s\\S]*?CHECK \\(source IN \\(([\\s\\S]*?)\\)\\)`,
    );
    const match = sql.match(re);
    if (!match || match[1] === undefined) return null;
    const body = match[1];
    return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  }

  function extractAddFindingSources(src: string): string[] {
    // Every `source: '<value>'` literal passed directly into an addFinding(...) call
    // in this service (evidence-item `source:` labels are prose strings inside
    // `evidence: [...]` arrays and are deliberately excluded by requiring the
    // snake_case-only value shape).
    const matches = [...src.matchAll(/source:\s*'([a-z_]+)'/g)];
    return [...new Set(matches.map((m) => m[1]!))];
  }

  it('the latest migration defines the source-check constraint', () => {
    const values = extractConstraintValues(latestMigration, 'client_profile_fill_finding_source_check');
    expect(values).not.toBeNull();
    expect(values!.length).toBeGreaterThan(0);
  });

  it('every addFinding source literal the completion service writes is allowed by the latest constraint', () => {
    const allowed = new Set(
      extractConstraintValues(latestMigration, 'client_profile_fill_finding_source_check') ?? [],
    );
    const written = extractAddFindingSources(service);
    const missing = written.filter((s) => !allowed.has(s));
    expect(missing).toEqual([]);
  });

  it('pins the exact seven completion-workflow source values found missing by the 2026-08-24 canary', () => {
    // Locks in the specific regression, in addition to the general drift check above.
    const allowed = new Set(
      extractConstraintValues(latestMigration, 'client_profile_fill_finding_source_check') ?? [],
    );
    for (const value of [
      'advocacy_history',
      'completion_audit',
      'district_nexus',
      'facility_resolution',
      'federal_market',
      'lifecycle_outcomes',
      'reconciliation',
    ]) {
      expect(allowed.has(value)).toBe(true);
    }
  });

  it('preserves every pre-existing allowed value from prior migrations (no accidental narrowing)', () => {
    const allowed = new Set(
      extractConstraintValues(latestMigration, 'client_profile_fill_finding_source_check') ?? [],
    );
    for (const value of [
      'public_web',
      'website',
      'synced_email',
      'sam_gov',
      'lda',
      'program_elements',
      'client_document',
      'bill_tracker',
    ]) {
      expect(allowed.has(value)).toBe(true);
    }
  });
});
