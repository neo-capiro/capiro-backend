import { describe, expect, it } from '@jest/globals';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 6 §4 / §8 — migration safety, checkable without a database.
 *
 * The phase asks for a clean-database migrate and a migrate from the prior
 * production head. Neither can run here: this repo has no local Postgres in the
 * PR path (test/tenant-isolation.int-spec.ts self-skips for exactly that
 * reason), and the only reachable database is production. What CAN be verified
 * statically is the property those runs would be checking — that the rollout's
 * migrations are ordered, forward-only and ADDITIVE, so that
 *
 *   · applying them to a clean database and to a production head at the prior
 *     migration both produce the same schema (no migration depends on data or
 *     on a state only one of those paths reaches), and
 *   · rolling the APPLICATION back without rolling the schema back is safe —
 *     which is precisely the rollback plan (§8): "new chat/dismissal/change-set
 *     columns remain additive", "do not drop chat/dismissal data in an
 *     emergency application rollback".
 *
 * A destructive statement in any of these files would break that guarantee
 * silently, so this test fails the build instead.
 */

/** Jest runs with the app package as cwd; the monorepo root is the fallback so
 *  a run launched from there still finds the files. */
const MIGRATIONS_DIR = [
  join(process.cwd(), 'prisma', 'migrations'),
  join(process.cwd(), 'apps', 'api-strategy', 'prisma', 'migrations'),
].find((p) => existsSync(p))!;

/** The migrations this prototype rollout added (Phases 2 and 3). */
const ROLLOUT_MIGRATIONS = ['20260727000000_sp_strategy_chat_message', '20260727010000_sp_watch_consistency'];

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => statSync(join(MIGRATIONS_DIR, name)).isDirectory())
    .sort();
}

function sqlOf(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
}

/**
 * Executable SQL only. Every migration in this app documents its manual
 * rollback as a `-- ROLLBACK` comment block containing the DROP statements that
 * would reverse it; those lines are documentation, not DDL, and must not be
 * read as destructive.
 */
function executableSql(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

const DESTRUCTIVE: Array<[string, RegExp]> = [
  ['DROP TABLE', /\bDROP\s+TABLE\b/i],
  ['DROP COLUMN', /\bDROP\s+COLUMN\b/i],
  ['DROP SCHEMA', /\bDROP\s+SCHEMA\b/i],
  ['DROP TYPE', /\bDROP\s+TYPE\b/i],
  ['TRUNCATE', /\bTRUNCATE\b/i],
  ['DELETE FROM', /\bDELETE\s+FROM\b/i],
  ['RENAME', /\bRENAME\b/i],
  // A column added NOT NULL without a default fails outright on a non-empty
  // production table — the classic "worked on a clean database" migration.
  ['ADD COLUMN … NOT NULL without DEFAULT', /ADD\s+COLUMN\s+"[^"]+"\s+[A-Z0-9()\s]+NOT\s+NULL(?![^,;]*DEFAULT)/i],
  ['SET NOT NULL', /\bSET\s+NOT\s+NULL\b/i],
];

describe('Phase 6 §4 — strategy migrations are ordered, additive and reversible-by-not-reversing', () => {
  it('every migration directory is a unique, strictly increasing timestamp', () => {
    const names = migrationNames();
    expect(names.length).toBeGreaterThan(0);
    const stamps = names.map((n) => {
      expect(n).toMatch(/^\d{14}_[a-z0-9_]+$/);
      return n.slice(0, 14);
    });
    expect(new Set(stamps).size).toBe(stamps.length);
    expect([...stamps].sort()).toEqual(stamps);
  });

  it('this rollout’s migrations are present, in order, and last', () => {
    const names = migrationNames();
    for (const m of ROLLOUT_MIGRATIONS) expect(names).toContain(m);
    expect(names.slice(-ROLLOUT_MIGRATIONS.length)).toEqual(ROLLOUT_MIGRATIONS);
  });

  it.each(ROLLOUT_MIGRATIONS)('%s contains no destructive statement', (name) => {
    const sql = executableSql(sqlOf(name));
    const found = DESTRUCTIVE.filter(([, re]) => re.test(sql)).map(([label]) => label);
    expect(found).toEqual([]);
  });

  it.each(ROLLOUT_MIGRATIONS)('%s documents its manual rollback', (name) => {
    expect(sqlOf(name)).toMatch(/--\s*ROLLBACK/);
  });

  it.each(ROLLOUT_MIGRATIONS)('%s puts every tenant-scoped table it creates behind RLS', (name) => {
    const sql = sqlOf(name);
    const created = [...sql.matchAll(/CREATE TABLE "([a-z0-9_]+)"\s*\(([\s\S]*?)\n\);/g)];
    for (const [, table, body] of created) {
      if (!/"tenant_id"/.test(body!)) continue;
      expect(sql).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(sql).toMatch(new RegExp(`CREATE POLICY "${table}_isolation" ON "${table}"`));
    }
  });

  it('the whole migration history stays additive — an application rollback never needs a schema rollback', () => {
    const offenders = migrationNames()
      .map((name) => {
        const sql = executableSql(sqlOf(name));
        const hits = DESTRUCTIVE.filter(([, re]) => re.test(sql)).map(([label]) => label);
        return hits.length ? `${name}: ${hits.join(', ')}` : null;
      })
      .filter((x): x is string => x !== null);
    expect(offenders).toEqual([]);
  });
});
