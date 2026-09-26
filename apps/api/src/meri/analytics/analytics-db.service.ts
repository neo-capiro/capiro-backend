import { Injectable, Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import type { CompiledQuery } from './query-spec-compiler.js';

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

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.$disconnect();
    }
  }
}
