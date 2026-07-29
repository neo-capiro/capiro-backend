import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Static rehearsal for `20260811040000_memory_index_outbox_subject`.
 *
 * `migration-table-names.spec.ts` proves an `ALTER TABLE` names a real TABLE
 * (the 2026-07-28 `"client"` vs `clients` class). It says nothing about the
 * COLUMN an `ALTER COLUMN` names, and nothing about whether a CHECK references
 * columns that exist. Both are `prisma migrate deploy` hard failures, and a
 * failed migration blocks every migration after it — which is how Gate E's
 * unapplied migrations turned into a live 500.
 *
 * No throwaway PostgreSQL is available in this environment, so this is the
 * strongest check that can be made offline: every column this migration touches
 * must have been created by an EARLIER migration, and the constraint it adds must
 * only reference such columns. A live replay is still required before the
 * migration is applied to any real database (closeout §11) — this narrows the
 * failure modes, it does not replace the rehearsal.
 */

const MIGRATIONS_DIR = join(__dirname, '../../prisma/migrations');
const THIS_MIGRATION = '20260811040000_memory_index_outbox_subject';
const TABLE = 'memory_cleanup_outbox';

function migrationDirsUpTo(name: string): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .filter((d) => d < name);
}

function sqlOf(dir: string): string {
  try {
    return readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8');
  } catch {
    return '';
  }
}

/** Columns the migration history has created on `memory_cleanup_outbox`. */
function columnsCreatedBefore(): Set<string> {
  const cols = new Set<string>();
  for (const dir of migrationDirsUpTo(THIS_MIGRATION)) {
    const sql = sqlOf(dir);
    // CREATE TABLE ... ( <body> ) — take the column names at line starts.
    const create = new RegExp(
      `CREATE TABLE(?:\\s+IF NOT EXISTS)?\\s+"?${TABLE}"?\\s*\\(([\\s\\S]*?)\\n\\);`,
      'i',
    ).exec(sql);
    if (create) {
      for (const line of create[1]!.split('\n')) {
        const m = /^\s*"?([a-z_][a-z0-9_]*)"?\s+[a-z]/i.exec(line);
        if (m && !/^(constraint|primary|unique|check|foreign)$/i.test(m[1]!)) cols.add(m[1]!);
      }
    }
    // Later ADD COLUMNs.
    const addRe = new RegExp(
      `ALTER TABLE\\s+"?${TABLE}"?[\\s\\S]*?ADD COLUMN(?:\\s+IF NOT EXISTS)?\\s+"?([a-z_][a-z0-9_]*)"?`,
      'gi',
    );
    let a: RegExpExecArray | null;
    while ((a = addRe.exec(sql))) cols.add(a[1]!);
  }
  return cols;
}

describe('20260811040000_memory_index_outbox_subject is applicable', () => {
  const sql = sqlOf(THIS_MIGRATION);
  const existing = columnsCreatedBefore();

  it('reads its own migration file', () => {
    expect(sql.length).toBeGreaterThan(0);
    // Sanity: the harness actually found the table's history, so an empty
    // `existing` set below would be a real finding rather than a broken parser.
    expect(existing.size).toBeGreaterThan(5);
  });

  it('only ALTERs columns an earlier migration created', () => {
    const re = /ALTER COLUMN\s+"?([a-z_][a-z0-9_]*)"?/gi;
    const touched: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql))) touched.push(m[1]!);

    expect(touched).toContain('memory_item_id');
    for (const col of touched) {
      expect(existing.has(col)).toBe(true);
    }
  });

  it('adds a CHECK that references only existing columns', () => {
    const check = /ADD CONSTRAINT\s+([a-z_]+)\s+CHECK\s*\(([\s\S]*?)\)\s*;/i.exec(sql);
    expect(check).not.toBeNull();
    expect(check![1]).toBe('memory_cleanup_subject_present_check');

    const referenced = (check![2]!.match(/[a-z_][a-z0-9_]*/gi) ?? []).filter(
      (t) => !/^(IS|NOT|NULL|OR|AND|TRUE|FALSE)$/i.test(t),
    );
    expect(referenced.sort()).toEqual(['clio_memory_id', 'memory_item_id']);
    for (const col of referenced) expect(existing.has(col)).toBe(true);
  });

  it('drops the constraint before adding it, so a re-run is safe', () => {
    // prisma migrate deploy runs a migration once, but the entrypoint chain can
    // retry a failed deploy; ADD CONSTRAINT is not idempotent on its own.
    const drop = sql.indexOf('DROP CONSTRAINT IF EXISTS memory_cleanup_subject_present_check');
    const add = sql.indexOf('ADD CONSTRAINT memory_cleanup_subject_present_check');
    expect(drop).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(drop);
  });

  it('guards the new index with IF NOT EXISTS', () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS memory_cleanup_outbox_clio_pending_idx/);
  });

  it('keeps every COMMENT to a single string literal', () => {
    // Adjacent literals separated by a newline DO concatenate in PostgreSQL, but
    // depending on that makes validity a function of whitespace, and a syntax
    // error here blocks every later migration.
    for (const stmt of sql.split(';')) {
      if (!/COMMENT ON/i.test(stmt)) continue;
      const literals = stmt.match(/'(?:[^']|'')*'/g) ?? [];
      expect(literals.length).toBe(1);
    }
  });

  it('is additive: it does not drop a column, table or constraint it did not add', () => {
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
    // The only DROP CONSTRAINT permitted is the idempotency guard for the very
    // constraint this migration adds.
    const drops = sql.match(/DROP CONSTRAINT(?:\s+IF EXISTS)?\s+([a-z_]+)/gi) ?? [];
    for (const d of drops) expect(d).toMatch(/memory_cleanup_subject_present_check/);
  });
});
