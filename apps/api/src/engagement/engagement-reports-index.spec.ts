/**
 * Reports overview 503 (reports-503-01) — the sentAt predicate that had no
 * index.
 *
 * `reportOverview()` filters the caller's synced mail with
 *   OR: [{ sentAt: {gte, lt} }, { receivedAt: {gte, lt} }]
 * The receivedAt branch was served by `mail_messages_tenant_received_idx`
 * (tenant_id, received_at). The sentAt branch had NO index at all, so Postgres
 * degraded the whole disjunction to a sequential scan of mail_messages for
 * the tenant — a wide table (body_text, raw jsonb) — which on production row
 * volumes pushed the request past `withTenant`'s 5000 ms interactive-
 * transaction timeout and surfaced as the 503 "database is temporarily busy"
 * via P2024/P2028 in PrismaClientExceptionFilter.
 *
 * The behavioural proof (an EXPLAIN showing the index plan, and the latency
 * drop) lives in production, which this suite cannot touch. What this cheap
 * always-on gate CAN pin is that the serving index exists in BOTH places that
 * matter: the Prisma schema (so every fresh database gets it and Prisma's
 * own index list matches) and the migration (so deployed databases get it).
 * Deleting either is a test failure rather than a silent return to the
 * seq-scan plan.
 *
 * This follows the canonical-promotion-schema-v1.spec.ts pattern: assert
 * exact SQL identifiers against schema.prisma + migration.sql, normalized
 * to LF (no `eol=lf` rule for .prisma/.sql in .gitattributes, so a Windows
 * checkout reads CRLF back).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from '@jest/globals';

const MIGRATION_DIR = '20260919010000_mail_messages_tenant_sent_idx';

// Normalized to LF: schema.prisma and migration.sql have no eol=lf rule in
// .gitattributes, so a Windows checkout reads them back as CRLF.
const schemaPrisma = readFileSync(
  join(__dirname, '..', '..', 'prisma', 'schema.prisma'),
  'utf8',
).replace(/\r\n/g, '\n');

const migrationSql = readFileSync(
  join(__dirname, '..', '..', 'prisma', 'migrations', MIGRATION_DIR, 'migration.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

// SQL line comments stripped, so prose containing the identifier cannot
// false-positive a migration assertion.
const migrationSqlWithoutComments = migrationSql
  .split('\n')
  .map((line) => line.replace(/--.*/, ''))
  .join('\n');

describe('reports-503-01 — mail_messages sentAt serving index', () => {
  test('schema.prisma declares the (tenantId, sentAt) index on MailMessage', () => {
    // Mirrors the existing receivedAt sibling index
    // (`@@index([tenantId, receivedAt], map: "mail_messages_tenant_received_idx")`).
    expect(schemaPrisma).toContain(
      '@@index([tenantId, sentAt], map: "mail_messages_tenant_sent_idx")',
    );
  });

  test('the schema-level MailMessage index block matches the migration exactly', () => {
    // The migration is the deployed artifact; the schema is what fresh
    // databases and prisma generate see. If these drift, one environment is
    // on the slow plan. Extract the CREATE INDEX statement and compare its
    // column tuple to the schema's.
    expect(migrationSqlWithoutComments).toContain(
      'CREATE INDEX IF NOT EXISTS "mail_messages_tenant_sent_idx"',
    );
    expect(migrationSqlWithoutComments).toContain(
      'ON "mail_messages" ("tenant_id", "sent_at")',
    );
  });

  test('the migration documents the CONCURRENTLY out-of-band runbook for production', () => {
    // Per the repo convention for indexes on live tables
    // (20261120230100_federal_award_identity_indexes): Prisma wraps each
    // migration in a transaction, and CREATE INDEX CONCURRENTLY cannot run
    // inside one, so the migration ships a plain CREATE INDEX IF NOT EXISTS
    // and the production runbook pre-creates the index with CONCURRENTLY so
    // the statement is a no-op. A CONCURRENTLY build that FAILS leaves an
    // INVALID index and IF NOT EXISTS checks name existence, not validity —
    // the migration header must tell the operator to verify indisvalid.
    expect(migrationSql).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
    expect(migrationSql).toMatch(/indisvalid/);
  });
});
