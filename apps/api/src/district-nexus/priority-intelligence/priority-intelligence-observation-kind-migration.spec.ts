import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260906020000_district_nexus_change_observation_kind/migration.sql',
  ),
  'utf8',
);

describe('District Nexus change-ledger observation_kind migration', () => {
  test('column is additive: NOT NULL with a safe default, so every existing row is classified "change" with no data loss', () => {
    expect(migration).toMatch(
      /ADD COLUMN IF NOT EXISTS observation_kind varchar\(24\) NOT NULL DEFAULT 'change'/,
    );
  });

  test('vocabulary is constrained to exactly baseline|change', () => {
    expect(migration).toMatch(/CHECK \(observation_kind IN \('baseline', 'change'\)\)/);
  });

  test('adds a new index rather than modifying/dropping the existing district index', () => {
    expect(migration).toContain('district_nexus_change_district_kind_idx');
    expect(migration).toMatch(
      /district_nexus_change_district_kind_idx\s*\n\s*ON district_nexus_change \(state_code, district_code, observation_kind, observed_at DESC\)/,
    );
    // The original R4 index name must not appear as a DROP/ALTER target here.
    expect(migration).not.toMatch(/DROP INDEX[^;]*district_nexus_change_district_idx/i);
  });

  test('backfill targets rows by their real recorded sourceRunId, never a guessed date/count heuristic, and never deletes rows', () => {
    expect(migration).toMatch(/provenance ->> 'sourceRunId'/);
    expect(migration).toMatch(/UPDATE district_nexus_change/);
    expect(migration).not.toMatch(/DELETE FROM district_nexus_change/i);
    // Identifies the run from gsa_real_property_source_run itself (a real,
    // committed, non-dry-run, successful run) rather than a literal id/date.
    expect(migration).toMatch(/FROM gsa_real_property_source_run/);
    expect(migration).toMatch(/dry_run = false/);
    expect(migration).toMatch(/status IN \('success', 'success_with_errors'\)/);
  });
});
