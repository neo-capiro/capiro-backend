import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * REGRESSION GUARD for the wrong-table-name migration class (2026-07-28).
 *
 * `20260809010000_client_applicant_types` merged as
 * `ALTER TABLE "client" ADD COLUMN IF NOT EXISTS "applicant_types" ...`, but the
 * table is `clients` — `model Client` carries `@@map("clients")`. Two things made
 * that worse than a typo:
 *
 *   1. `IF NOT EXISTS` guards the COLUMN, not the TABLE, so there is no
 *      silent-skip path — `prisma migrate deploy` fails outright with
 *      `relation "client" does not exist`, and a failed migration blocks every
 *      later one.
 *   2. The Prisma schema had already been updated, so the generated client
 *      selects `applicant_types` on every `clients` read. Deploying the image
 *      before a (working) migration would 500 every client query, for every
 *      tenant.
 *
 * Neither `pnpm typecheck` nor any runtime test sees inside migration SQL, so
 * this is a static check: every table an `ALTER TABLE` names must be a table
 * this repository has actually created, or one the current schema maps to.
 *
 * Measured when introduced: 131 distinct ALTER targets across the full migration
 * history, 0 orphans once the bug above was fixed. This guard is not noisy.
 */

const MIGRATIONS_DIR = join(__dirname, '../../prisma/migrations');
const SCHEMA_PATH = join(__dirname, '../../prisma/schema.prisma');

/**
 * SQL comments routinely quote DDL — including this very bug — so scanning them
 * produces false positives.
 *
 * `[^\n\r]` rather than `.*$`: these files are CRLF, and `\r` is a regex line
 * terminator in JS, so `.` will not cross it and a non-multiline `$` will not
 * match before it. `/--.*$/` therefore strips *nothing* in this repo.
 */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n\r]*/g, '');
}

function migrationFiles(): { name: string; sql: string }[] {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, path: join(MIGRATIONS_DIR, e.name, 'migration.sql') }))
    .filter((e) => existsSync(e.path))
    .map((e) => ({ name: e.name, sql: stripSqlComments(readFileSync(e.path, 'utf8')) }));
}

/** Every table name this repo's own migrations bring into existence. */
function tablesCreatedByHistory(files: { sql: string }[]): Set<string> {
  const out = new Set<string>();
  for (const { sql } of files) {
    for (const m of sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi,
    )) {
      if (m[1]) out.add(m[1]);
    }
    // A renamed table is a legitimate later ALTER target.
    for (const m of sql.matchAll(/RENAME\s+TO\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi)) {
      if (m[1]) out.add(m[1]);
    }
  }
  return out;
}

/** Table names the current Prisma schema maps to (`@@map`, else the model name). */
function tablesInSchema(): Set<string> {
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  const out = new Set<string>();
  for (const m of schema.matchAll(/@@map\("([^"]+)"\)/g)) if (m[1]) out.add(m[1]);
  for (const m of schema.matchAll(/\nmodel\s+(\w+)\s*\{/g)) if (m[1]) out.add(m[1]);
  return out;
}

describe('migration SQL references real tables', () => {
  const files = migrationFiles();

  it('finds migrations to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('every ALTER TABLE names a table this repo creates or the schema maps', () => {
    const known = new Set([...tablesCreatedByHistory(files), ...tablesInSchema()]);

    const orphans: string[] = [];
    for (const { name, sql } of files) {
      for (const m of sql.matchAll(
        /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi,
      )) {
        const table = m[1];
        if (!table || known.has(table)) continue;
        const hint = known.has(`${table}s`)
          ? ` — did you mean "${table}s"? (check the model's @@map)`
          : '';
        orphans.push(`${name}: ALTER TABLE "${table}"${hint}`);
      }
    }

    expect(orphans).toEqual([]);
  });
});
