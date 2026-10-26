import { Injectable, Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import type { CompiledQuery } from './query-spec-compiler.js';
import { PublicSqlError, type CompiledPublicSql } from './sql-query-compiler.js';
import { publicSqlRelation } from './public-sql-registry.js';
import { normalizeSqlRow as normalizePublicSqlRow } from './sql-query-output.js';
export { normalizeSqlRow as normalizePublicSqlRow } from './sql-query-output.js';

// Fixed owner check, independent of configured username. Never use caller-authored SQL here.
const PUBLIC_SQL_ROLE_CHECK = `SELECT (
  current_user = 'capiro_analytics_ro' AND session_user = 'capiro_analytics_ro'
  AND current_setting('transaction_read_only') = 'on'
  AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole
  AND NOT r.rolcreatedb AND NOT r.rolreplication
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid)
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database d WHERE d.datdba = r.oid)
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner = r.oid)
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner = r.oid)
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT IN ('pg_catalog','information_schema')
    AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
    AND (pg_catalog.has_table_privilege(current_user, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR pg_catalog.has_any_column_privilege(current_user, c.oid, 'INSERT,UPDATE,REFERENCES'))
  )
) AS allowed FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;

/**
 * Raw `$queryRawUnsafe` rows carry driver types the rest of the tool
 * pipeline cannot serialize: COUNT(*) is a BigInt (JSON.stringify throws on
 * it), SUM/AVG and Decimal(18,2) columns are Prisma.Decimal, timestamps are
 * Date. Flatten all three to JSON-safe primitives once, here, so the model
 * and the audit log both see plain numbers/strings.
 */
export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = normalizeValue(value);
  }
  return out;
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (Prisma.Decimal.isDecimal(value)) {
    const asNumber = (value as Prisma.Decimal).toNumber();
    return Number.isFinite(asNumber) ? asNumber : (value as Prisma.Decimal).toString();
  }
  if (Array.isArray(value)) return value.map(normalizeValue);
  return value;
}

/**
 * Executes compiled analytics queries as `capiro_analytics_ro` — a
 * SELECT-only role scoped to the global-dataset-registry allowlist, never as
 * `capiro_app`. Modeled on the existing `capiro_pe_promoter` pattern
 * (`apps/api/scripts/execute-defense-budget-promotion-v1.ts`): a second
 * `PrismaClient` pointed at its own `*_DATABASE_URL`, with a hardcoded
 * "never fall back to DATABASE_URL" rule so this can't silently start
 * running analytics queries as the main app role.
 *
 * Two independent, DB-enforced ceilings apply regardless of anything this
 * class does: `capiro_analytics_ro` has `statement_timeout`/`lock_timeout`
 * set at the role level (see the role-creation migration), and it holds
 * SELECT-only grants on exactly the registry's allowlisted tables. The
 * `SET LOCAL statement_timeout` below is defense-in-depth on top of that,
 * mirroring the pattern already used in `meri.service.ts`/`meri-tools.service.ts`
 * elsewhere in this file's own module (a `$transaction` timeoutMs budget
 * does not cancel a query already dispatched to Postgres — the server-side
 * `SET LOCAL` is the real kill switch).
 */
@Injectable()
export class AnalyticsDbService {
  private readonly logger = new Logger(AnalyticsDbService.name);
  private client: PrismaClient | null = null;

  /**
   * Composes the analytics connection string from its own discrete
   * ANALYTICS_DB_* env vars — never from DATABASE_URL/DB_* (the main
   * capiro_app connection) and never from PROMOTER_* (a write-capable role
   * for a different capability entirely). Mirrors
   * `apps/api/scripts/lib/pe-compose-database-url.js`'s format and its
   * refusal to build a URL from a masked "***" password placeholder.
   */
  private composeUrl(): string {
    const host = process.env.ANALYTICS_DB_HOST;
    const port = process.env.ANALYTICS_DB_PORT;
    const user = process.env.ANALYTICS_DB_USER;
    const password = process.env.ANALYTICS_DB_PASSWORD;
    const name = process.env.ANALYTICS_DB_NAME;
    const missing = ['ANALYTICS_DB_HOST', 'ANALYTICS_DB_PORT', 'ANALYTICS_DB_USER', 'ANALYTICS_DB_PASSWORD', 'ANALYTICS_DB_NAME'].filter(
      (k) => !process.env[k],
    );
    if (missing.length > 0) {
      throw new Error(
        `query_global_data requires ${missing.join(', ')}; this path never falls back to DATABASE_URL or any other credential.`,
      );
    }
    if (password === '***') {
      throw new Error('Refusing to build ANALYTICS_DB_PASSWORD from a masked placeholder.');
    }
    // Aurora forces TLS (rds.force_ssl=1), so `require` is the only sane
    // production value; the override exists solely so an integration test can
    // point this at a plain local Postgres container.
    const sslmode = process.env.ANALYTICS_DB_SSLMODE ?? 'require';
    if (!/^[a-z-]+$/.test(sslmode)) {
      throw new Error(`Refusing unusual ANALYTICS_DB_SSLMODE value: ${sslmode}`);
    }
    return `postgresql://${user}:${encodeURIComponent(password as string)}@${host}:${port}/${name}?schema=public&sslmode=${sslmode}&connection_limit=3`;
  }

  private getClient(): PrismaClient {
    if (this.client) return this.client;
    this.client = new PrismaClient({ datasources: { db: { url: this.composeUrl() } } });
    return this.client;
  }

  /**
   * Runs a compiled query and returns plain rows. Never call with anything
   * other than the output of `compileQuerySpec` — the SQL text here is
   * trusted only because that compiler already validated every identifier
   * against the dataset registry.
   */
  async run(compiled: CompiledQuery, timeoutMs = 8_000): Promise<Record<string, unknown>[]> {
    const client = this.getClient();
    const statementTimeoutSql = `SET LOCAL statement_timeout = '${Math.max(1, Math.floor(timeoutMs))}ms'`;

    const rows = await client.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(statementTimeoutSql);
        return tx.$queryRawUnsafe<Record<string, unknown>[]>(compiled.sql, ...compiled.params);
      },
      { timeout: timeoutMs + 2_000 },
    );
    return rows.map(normalizeRow);
  }

  /** Only compiler-produced SQL, using this owner's dedicated public reader connection. */
  async runPublicSql(compiled: CompiledPublicSql): Promise<Record<string, string | boolean | null>[]> {
    try {
      const client = this.getClient();
      const rows = await client.$transaction(async (tx) => {
        // READ ONLY must precede the first query. All settings are fixed, never model-controlled.
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$executeRawUnsafe('SET LOCAL search_path = pg_catalog');
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '8000ms'");
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1000ms'");
        await tx.$executeRawUnsafe("SET LOCAL idle_in_transaction_session_timeout = '10000ms'");
        await tx.$executeRawUnsafe("SET LOCAL timezone = 'UTC'");
        const role = await tx.$queryRawUnsafe<{ allowed: boolean }[]>(PUBLIC_SQL_ROLE_CHECK);
        if (role.length !== 1 || role[0]?.allowed !== true) throw new PublicSqlError('SOURCE_UNAVAILABLE', 'The public reader role is unavailable.');
        for (const name of compiled.relationsUsed) {
          const relation = publicSqlRelation(name);
          if (!relation) throw new PublicSqlError('SOURCE_UNAVAILABLE', 'A published relation is unavailable.');
          const grant = await tx.$queryRawUnsafe<{ allowed: boolean | null }[]>(
            'SELECT pg_catalog.has_table_privilege(current_user, pg_catalog.to_regclass($1), \'SELECT\') AS allowed', `public.${relation.table}`);
          if (grant.length !== 1 || grant[0]?.allowed !== true) throw new PublicSqlError('SOURCE_UNAVAILABLE', 'A published relation or its read grant is unavailable.');
        }
        return tx.$queryRawUnsafe<Record<string, unknown>[]>(compiled.sql, ...compiled.params);
      }, { timeout: 10000, maxWait: 2000 });
      return rows.map((row) => normalizePublicSqlRow(row, compiled.columns));
    } catch (error) {
      if (error instanceof PublicSqlError) throw error;
      // Driver details may contain SQL/connection information. Only fixed public errors cross this boundary.
      const code = (error as { code?: unknown; meta?: { code?: unknown } } | null)?.code;
      const dbCode = (error as { meta?: { code?: unknown } } | null)?.meta?.code;
      if (code === 'P2028' || ['57014', '55P03'].includes(String(dbCode ?? code)))
        throw new PublicSqlError('QUERY_TIMEOUT', 'The public query exceeded its execution time limit. Narrow the query.');
      if (['42803', '42804', '42883', '22P02', '22003', '22007', '22008', '22023'].includes(String(dbCode ?? code)))
        throw new PublicSqlError('INVALID_QUERY', 'Check field and parameter types, supported aggregates, and GROUP BY fields.');
      throw new PublicSqlError('SOURCE_UNAVAILABLE', 'Public data is currently unavailable.');
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.$disconnect();
    }
  }
}
