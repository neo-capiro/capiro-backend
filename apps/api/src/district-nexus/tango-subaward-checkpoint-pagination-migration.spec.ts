import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { UNFILTERED_SUBAWARD_SYNC_KEY } from '../external/tango/tango-subaward-sync-key.js';

/**
 * Text-contract spec for the R4 Tango checkpoint pagination migration
 * (20280908010000), mirroring the district-nexus-economic-migration.spec.ts
 * convention. Behavioral constraint rehearsal (every CHECK actually firing)
 * ran on a disposable Postgres during validation; this spec pins the durable
 * honesty rules so a future edit cannot silently drop them:
 *
 *  - the legacy 25-row checkpoint is PRESERVED, never reset or assumed:
 *    all three new columns are nullable and no data migration touches
 *    existing rows;
 *  - a known page size must carry a provenance source (proven vs
 *    operator-asserted), so a resume can never silently treat a guess as
 *    evidence;
 *  - the catalog total is an observed value written by the walk, never a
 *    hard-coded number.
 */
const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20280908010000_tango_subaward_checkpoint_pagination/migration.sql',
  ),
  'utf8',
);

describe('Tango subaward checkpoint pagination migration', () => {
  test('adds the pagination columns as nullable so the legacy checkpoint survives', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "page_size" INTEGER');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "page_size_source" VARCHAR(16)');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "total_reported" BIGINT');
    // No data migration may rewrite the existing 25-row in_progress checkpoint.
    expect(migration).not.toMatch(/UPDATE\s+"?tango_subaward_sync_checkpoint"?/i);
    expect(migration).not.toMatch(/DELETE\s+FROM\s+"?tango_subaward_sync_checkpoint"?/i);
  });

  test('bounds the walk page size to the provider-legal range', () => {
    expect(migration).toContain(
      'CHECK ("page_size" IS NULL OR ("page_size" >= 1 AND "page_size" <= 100))',
    );
  });

  test('restricts page-size provenance to the closed vocabulary', () => {
    expect(migration).toContain("'run_arg', 'checkpoint', 'resume_flag'");
  });

  test('a known page size must record how it was established', () => {
    expect(migration).toContain('CHECK ("page_size" IS NULL OR "page_size_source" IS NOT NULL)');
  });

  test('the unfiltered walk key derivation is pinned to the live checkpoint identity', () => {
    // The live 2026-09-08 first run wrote its checkpoint under this exact key
    // (subawards:f5ec11c7…, verified read-only on capiro-dev). Any change to the
    // derivation silently orphans that row and would restart the corpus walk.
    expect(UNFILTERED_SUBAWARD_SYNC_KEY).toBe('subawards:f5ec11c7c783f2fac683e42cb5b0a345');
  });

  test('the provider catalog total must be a non-negative observed count', () => {
    expect(migration).toContain('CHECK ("total_reported" IS NULL OR "total_reported" >= 0)');
  });
});
