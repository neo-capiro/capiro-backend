import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The importer role migration is checked against the code that uses it (no
 * database): every table the producer names is granted, only the verbs it
 * issues are granted, the one serial it depends on is usable, and the role
 * timeouts sit around the producer's own 120 s Serializable transaction.
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
/** The tables one GRANT names, normalized. */
function grantedTables(verbs: string): string[] {
  const match = new RegExp(`GRANT ${verbs} ON TABLE([\\s\\S]*?)TO ${ROLE};`).exec(role);
  if (!match) return [];
  return match[1]!.split(',').map((name) => name.trim()).filter(Boolean);
}

describe('government forecast importer role', () => {
  it('is a LOGIN role created idempotently with an unusable placeholder password and no elevated attribute', () => {
    expect(role).toMatch(new RegExp(`IF NOT EXISTS \\(SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}'\\)`));
    expect(role).toMatch(new RegExp(`CREATE ROLE ${ROLE} LOGIN PASSWORD 'placeholder-[a-z-]+'`));
    expect(statements).not.toMatch(/SUPERUSER|CREATEDB|CREATEROLE|BYPASSRLS|REPLICATION/);
  });

  it('grants exactly SELECT, INSERT and UPDATE on all six forecast tables and nothing destructive', () => {
    expect(createdTables).toHaveLength(6);
    expect(grantedTables('SELECT, INSERT, UPDATE').sort()).toEqual([...createdTables].sort());
    expect(statements).not.toMatch(/GRANT (ALL|DELETE|TRUNCATE|REFERENCES|TRIGGER)/);
    expect(role).toMatch(new RegExp(`REVOKE ALL ON TABLE[\\s\\S]*?FROM ${ROLE};`));
    // No grant on any relation outside the six (schema usage and database connect excepted).
    const onTable = [...role.matchAll(/ON TABLE([\s\S]*?)(?:TO|FROM) /g)].flatMap((m) => m[1]!.split(',').map((n) => n.trim()));
    for (const name of onTable) expect(createdTables).toContain(name);
  });

  it('covers every table and verb the producer issues', () => {
    const named = new Set([...producer.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+(government_forecast\w*)/g)].map((m) => m[1]!));
    expect([...named].sort()).toEqual([...createdTables].sort());
    expect(producer).not.toMatch(/\b(DELETE|TRUNCATE)\b/);
    expect(producer).toMatch(/pg_advisory_xact_lock\(721111, 1\)/);
  });

  it('makes the one serial the producer depends on usable', () => {
    expect(serials).toEqual(['government_forecast_check_id_seq']);
    expect(role).toContain(`GRANT USAGE, SELECT ON SEQUENCE government_forecast_check_id_seq TO ${ROLE};`);
    expect(producer).toMatch(/INSERT INTO government_forecast_check[\s\S]*?RETURNING id/);
  });

  it('sets role timeouts around the producer transaction: idle above 120 s, lock and statement bounded', () => {
    const seconds = (setting: string) => Number(new RegExp(`ALTER ROLE ${ROLE} SET ${setting} = '(\\d+)s';`).exec(role)![1]);
    expect(producer).toMatch(/isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable, timeout: 120000/);
    expect(seconds('idle_in_transaction_session_timeout')).toBeGreaterThan(120);
    expect(seconds('lock_timeout')).toBeLessThanOrEqual(10);
    expect(seconds('statement_timeout')).toBeLessThanOrEqual(120);
    expect(role).toContain(`GRANT CONNECT ON DATABASE capiro TO ${ROLE};`);
    expect(role).toContain(`GRANT USAGE ON SCHEMA public TO ${ROLE};`);
  });
});
