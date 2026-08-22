import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * STATIC guard for the LegiWatch Live Hearings canonical-foundation migration
 * (20261120230000_legiwatch_live_hearings_foundation). Mirrors
 * assurance-migration-rls.spec.ts's approach: there is no database in this
 * checkout, so nothing here proves the SQL RUNS (that was verified manually
 * via a disposable Docker Postgres full-history replay). What this pins is
 * the set of properties that are easy to get wrong and easy to miss later:
 * the tenant tables shipping without FORCE RLS, the one-capture-per-hearing
 * invariant losing its UNIQUE constraint, or the global tables accidentally
 * picking up a tenant_id/RLS policy they must never have.
 */

const MIGRATION_DIR = '20261120230000_legiwatch_live_hearings_foundation';

function sql(): string {
  return readFileSync(
    join(__dirname, '../../prisma/migrations', MIGRATION_DIR, 'migration.sql'),
    'utf8',
  );
}

/** Strip SQL comments — the prose in this file quotes DDL and constraint names. */
function code(): string {
  return sql()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n\r]*/g, '');
}

const GLOBAL_TABLES = [
  'committee_source',
  'hearing_source_observation',
  'hearing_stream_candidate',
  'public_hearing_capture',
  'public_hearing_capture_attempt',
  'public_hearing_transcript_segment',
  'committee_site_update',
];

const TENANT_TABLES = ['hearing_subscription', 'hearing_auto_record_rule'];

describe('legiwatch live hearings foundation migration', () => {
  it('creates every new global table', () => {
    const text = code();
    for (const table of GLOBAL_TABLES) {
      expect(text).toContain(`CREATE TABLE "${table}" (`);
    }
  });

  it('creates every new tenant table', () => {
    const text = code();
    for (const table of TENANT_TABLES) {
      expect(text).toContain(`CREATE TABLE "${table}" (`);
    }
  });

  it('gives global tables NO tenant_id and NO RLS policy', () => {
    const text = code();
    for (const table of GLOBAL_TABLES) {
      const start = text.indexOf(`CREATE TABLE "${table}" (`);
      const end = text.indexOf('\n);', start);
      const body = text.slice(start, end);
      expect(body).not.toMatch(/"tenant_id"/);
    }
    for (const table of GLOBAL_TABLES) {
      expect(text).not.toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
    }
  });

  it('ENABLEs and FORCEs row level security on every tenant table, on the canonical policy', () => {
    const text = code();
    for (const table of TENANT_TABLES) {
      expect(text).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
      expect(text).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
      expect(text).toContain(`CREATE POLICY "${table}_isolation" ON "${table}"`);
    }
    // The canonical belt-and-suspenders form — not the older bare current_setting form.
    expect(text.match(/USING \(rls_bypass\(\) OR tenant_id = current_tenant_id\(\)\)/g)?.length).toBe(
      TENANT_TABLES.length,
    );
    expect(
      text.match(/WITH CHECK \(rls_bypass\(\) OR tenant_id = current_tenant_id\(\)\)/g)?.length,
    ).toBe(TENANT_TABLES.length);
  });

  it('gives every tenant table a cascading FK to tenants(id)', () => {
    const text = code();
    for (const table of TENANT_TABLES) {
      expect(text).toContain(
        `FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE`,
      );
    }
  });

  it('enforces exactly one canonical capture per hearing at the DB level', () => {
    const text = code();
    expect(text).toContain(
      'CREATE UNIQUE INDEX "public_hearing_capture_hearing_id_key" ON "public_hearing_capture" ("hearing_id");',
    );
  });

  it('keeps capture-attempt and transcript-segment history append-only via cascading FKs to public_hearing_capture', () => {
    const text = code();
    expect(text).toContain(
      'FOREIGN KEY ("capture_id") REFERENCES "public_hearing_capture"("id") ON DELETE CASCADE',
    );
    // Once for the attempt table, once for the transcript-segment table.
    expect(
      text.match(
        /FOREIGN KEY \("capture_id"\) REFERENCES "public_hearing_capture"\("id"\) ON DELETE CASCADE/g,
      )?.length,
    ).toBe(2);
  });

  it('gives the transcript segment table its idempotency key (capture_id, start_ms, end_ms)', () => {
    const text = code();
    expect(text).toContain(
      'CREATE UNIQUE INDEX "public_hearing_transcript_segment_capture_id_start_ms_end_ms_key" ON "public_hearing_transcript_segment" ("capture_id", "start_ms", "end_ms");',
    );
  });

  it('is additive to committee_hearing — only ADD COLUMN IF NOT EXISTS, never a data mutation', () => {
    const text = code();
    expect(text).toMatch(/ALTER TABLE "committee_hearing"[\s\S]*?ADD COLUMN IF NOT EXISTS/);
    expect(text).not.toMatch(/\bUPDATE\s+"?committee_hearing"?\s+SET\b/i);
  });

  it('is purely ADDITIVE overall — no DROP TABLE, no DROP COLUMN, no data mutation', () => {
    const text = code();
    expect(text).not.toMatch(/DROP\s+TABLE/i);
    expect(text).not.toMatch(/DROP\s+COLUMN/i);
    expect(text).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(text).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it('has every new table modelled in schema.prisma', () => {
    const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');
    for (const table of [...GLOBAL_TABLES, ...TENANT_TABLES]) {
      expect(schema).toContain(`@@map("${table}")`);
    }
  });
});
