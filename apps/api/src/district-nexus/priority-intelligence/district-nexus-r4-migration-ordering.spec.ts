/**
 * Regression guard for a real migration-history defect: the R4 migration
 * folder was authored with a placeholder future ("2028") timestamp — a
 * pattern several unrelated feature branches used concurrently during this
 * period to dodge timestamp collisions, intending to correct it before merge
 * — while a later, genuinely-dated 2026 follow-up migration
 * (`gsa_frpp_varchar_overflow_fix`) ALTERs a column R4's migration CREATEs.
 * Because Prisma's `migrate deploy` applies pending migrations in
 * lexicographic folder-name order, a fresh database ran the ALTER before the
 * CREATE and failed with `relation "gsa_real_property" does not exist`.
 * Production was unaffected only because R4 had already been applied (under
 * its old placeholder name) before the follow-up fix was ever authored.
 *
 * The fix is a pure rename to an honest, non-colliding timestamp reflecting
 * R4's real merge time (PR #1449, 2026-09-05T20:50:28Z) — content and
 * checksum are byte-identical (Prisma checksums migration.sql content, not
 * the folder name), so this changes ordering on a fresh database and
 * requires no code change to the migration itself. See
 * docs/runbooks/district-nexus-r4-migration-ledger-reconciliation.md for the
 * one-time, metadata-only ledger reconciliation this rename requires in any
 * environment (including production) that already has R4 applied under the
 * old folder name.
 */
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS_DIR = resolve(process.cwd(), 'prisma/migrations');
const R4_NAME = '20260905205000_district_nexus_release4_priority_intelligence';
const VARCHAR_FIX_NAME = '20260906010000_gsa_frpp_varchar_overflow_fix';
const OBSERVATION_KIND_NAME = '20260906020000_district_nexus_change_observation_kind';
const OLD_R4_NAME = '20280902010000_district_nexus_release4_priority_intelligence';

function allMigrationFolders(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

describe('District Nexus R4 migration ordering repair', () => {
  test('the R4 migration now sorts before the varchar-overflow fix it is a dependency of', () => {
    // Plain string comparison is exactly what Prisma's migrate engine uses to
    // order pending migrations — this IS the ordering check, not a proxy.
    expect(R4_NAME < VARCHAR_FIX_NAME).toBe(true);
  });

  test('the GSA baseline-classification migration, once present, sorts after both of its dependencies', () => {
    // This migration (PR #1491) doesn't exist yet on the migration-repair
    // branch alone — it lands when #1491 rebases onto this fix. Written
    // conditionally so the same spec is meaningful on both branches rather
    // than asserting something that isn't true yet.
    const folders = allMigrationFolders();
    if (!folders.includes(OBSERVATION_KIND_NAME)) return;
    expect(VARCHAR_FIX_NAME < OBSERVATION_KIND_NAME).toBe(true);
    expect(R4_NAME < OBSERVATION_KIND_NAME).toBe(true);
  });

  test('the old placeholder-timestamp R4 folder no longer exists (renamed, not duplicated)', () => {
    expect(allMigrationFolders()).not.toContain(OLD_R4_NAME);
  });

  test('the renamed R4 folder exists exactly once and every migration folder name is unique', () => {
    const folders = allMigrationFolders();
    expect(folders).toContain(R4_NAME);
    expect(new Set(folders).size).toBe(folders.length);
  });

  test('no other migration folder collides with the corrected R4 timestamp, and the observation-kind migration (once present) does not collide either', () => {
    const folders = allMigrationFolders();
    expect(folders.filter((f) => f === R4_NAME)).toHaveLength(1);
    const observationKindCount = folders.filter((f) => f === OBSERVATION_KIND_NAME).length;
    expect(observationKindCount).toBeLessThanOrEqual(1);
  });
});
