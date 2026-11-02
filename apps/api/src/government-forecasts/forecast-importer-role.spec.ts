import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The importer role migration is checked against the code that uses it (no
 * database): every table the producer names is granted exactly the verbs the
 * producer issues against it, nothing destructive is granted, the one serial it
 * depends on is usable, no credential is in Git, and the role timeouts sit
 * around the producer's own 120 s Serializable transaction.
 */
const api = join(__dirname, '../..');
const migrations = join(api, 'prisma/migrations');
const role = readFileSync(join(migrations, '20281102110000_government_forecast_importer_role/migration.sql'), 'utf8');
const tables = readFileSync(join(migrations, '20281101120000_government_forecast_windows/migration.sql'), 'utf8');
const producer = readFileSync(join(__dirname, 'forecast-producer.ts'), 'utf8');
const ROLE = 'capiro_forecast_importer';
/** The migration's statements without its comment lines. */
const statements = role
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

const createdTables = [...tables.matchAll(/CREATE TABLE (government_forecast\w*)\s*\(/g)].map((m) => m[1]!);
const serials = [...tables.matchAll(/CREATE TABLE (government_forecast\w*)\s*\(\s*(\w+) bigserial/g)].map((m) => `${m[1]}_${m[2]}_seq`);

/** Verbs granted per table, from the one-table GRANT statements. */
function granted(): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const m of statements.matchAll(new RegExp(`GRANT ([A-Z, ]+) ON TABLE (\\w+) TO ${ROLE};`, 'g')))
    result.set(m[2]!, new Set(m[1]!.split(',').map((v) => v.trim())));
  return result;
}
/** Verbs the producer issues per table: INSERT INTO, UPDATE ... SET, SELECT for FROM/JOIN, UPDATE for FOR UPDATE, SELECT for ON CONFLICT. */
function issued(): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const add = (table: string, verb: string) => result.set(table, new Set([...(result.get(table) ?? []), verb]));
  for (const m of producer.matchAll(/INSERT INTO (government_forecast\w*)/g)) add(m[1]!, 'INSERT');
  for (const m of producer.matchAll(/UPDATE (government_forecast\w*) SET/g)) add(m[1]!, 'UPDATE');
  for (const m of producer.matchAll(/\b(?:FROM|JOIN) (government_forecast\w*)(?: \w+)?[^;`]*?FOR UPDATE/g)) add(m[1]!, 'UPDATE');
  for (const m of producer.matchAll(/\b(?:FROM|JOIN) (government_forecast\w*)/g)) add(m[1]!, 'SELECT');
  for (const m of producer.matchAll(/INSERT INTO (government_forecast\w*)[^;`]*?ON CONFLICT/g)) add(m[1]!, 'SELECT');
  return result;
}

describe('government forecast importer role', () => {
  it('is created NOLOGIN and idempotently, with no password or elevated attribute in Git', () => {
    expect(statements).toMatch(new RegExp(`IF NOT EXISTS \\(SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}'\\)`));
    expect(statements).toMatch(new RegExp(`CREATE ROLE ${ROLE} NOLOGIN;`));
    expect(statements).not.toMatch(/PASSWORD|\bLOGIN\b|SUPERUSER|CREATEDB|CREATEROLE|BYPASSRLS|REPLICATION/);
    // The documented Release step appears in a comment only.
    expect(role).toMatch(/ALTER ROLE capiro_forecast_importer LOGIN PASSWORD/);
  });

  it('grants each of the six tables exactly the verbs the producer issues against it, and nothing destructive', () => {
    expect(createdTables).toHaveLength(6);
    const grants = granted(), uses = issued();
    expect([...grants.keys()].sort()).toEqual([...createdTables].sort());
    expect([...uses.keys()].sort()).toEqual([...createdTables].sort());
    for (const table of createdTables) {
      expect([...grants.get(table)!].sort()).toEqual([...uses.get(table)!].sort());
      for (const verb of grants.get(table)!) expect(['SELECT', 'INSERT', 'UPDATE']).toContain(verb);
    }
    // The reviewed per-table shape (a full persistForecastSnapshot ran as the role with exactly these grants).
    expect([...grants.get('government_forecast_observation')!]).toEqual(['INSERT']);
    expect([...grants.get('government_forecast')!].sort()).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect([...grants.get('government_forecast_check')!].sort()).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(statements).not.toMatch(/GRANT (ALL|DELETE|TRUNCATE|REFERENCES|TRIGGER)/);
    expect(statements).toMatch(new RegExp(`REVOKE ALL ON TABLE[\\s\\S]*?FROM ${ROLE};`));
    const onTable = [...statements.matchAll(/ON TABLE([\s\S]*?)(?:TO|FROM) /g)].flatMap((m) => m[1]!.split(',').map((n) => n.trim()));
    for (const name of onTable) expect(createdTables).toContain(name);
    expect(producer).not.toMatch(/\b(DELETE|TRUNCATE)\b/);
    expect(producer).toMatch(/pg_advisory_xact_lock\(721111, 1\)/);
  });

  it('makes the one serial the producer depends on usable', () => {
    expect(serials).toEqual(['government_forecast_check_id_seq']);
    expect(statements).toContain(`GRANT USAGE, SELECT ON SEQUENCE government_forecast_check_id_seq TO ${ROLE};`);
    expect(producer).toMatch(/INSERT INTO government_forecast_check[\s\S]*?RETURNING id/);
  });

  it('sets role timeouts around the producer transaction: idle above 120 s, lock and statement bounded', () => {
    const seconds = (setting: string) => Number(new RegExp(`ALTER ROLE ${ROLE} SET ${setting} = '(\\d+)s';`).exec(statements)![1]);
    expect(producer).toMatch(/isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable, timeout: 120000/);
    expect(seconds('idle_in_transaction_session_timeout')).toBeGreaterThan(120);
    expect(seconds('lock_timeout')).toBeLessThanOrEqual(10);
    expect(seconds('statement_timeout')).toBeLessThanOrEqual(120);
    expect(statements).toContain(`GRANT CONNECT ON DATABASE capiro TO ${ROLE};`);
    expect(statements).toContain(`GRANT USAGE ON SCHEMA public TO ${ROLE};`);
  });
});
