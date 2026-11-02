import { Injectable, Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import type { Pool } from 'pg';
import type { CompiledQuery } from './query-spec-compiler.js';
import {
  createReaderPool,
  executeGatedStatement,
  readerConfigFromEnv,
  readerUrl,
  readPublishedSurface,
  translateDatabaseError,
  withReadOnlyTransaction,
  type PublishedRelation,
  type ReaderConnectionConfig,
  type SqlResultColumn,
  type SqlResultRow,
} from './sql-reader-connection.js';
import { PUBLIC_RELATION_NAMES, SOURCE_SCHEMAS, type GatedSqlStatement } from './sql-statement-gate.js';

const READER_ROLE = 'capiro_analytics_ro';
const SURFACE_TTL_MS = 300_000;

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
 * The public reader: `capiro_analytics_ro`, never `capiro_app`. Two tools use
 * it. query_global_data still compiles a QuerySpec over the raw global tables
 * through Prisma (`run`). query_capiro_data passes the model's gated SELECT
 * through the shared read-only transport (`runPublicSql`) with
 * search_path=meri_public, where the role's grants on the published views
 * decide what exists; `describePublic` reads that surface from pg_catalog.
 *
 * The role-level `statement_timeout`/`lock_timeout` from the role-creation
 * migration hold even if application code has a bug; the SET LOCAL values
 * below are the per-transaction values the gate documents to the model.
 */
@Injectable()
export class AnalyticsDbService {
  private readonly logger = new Logger(AnalyticsDbService.name);
  private client: PrismaClient | null = null;
  private pool: Pool | null = null;
  private surface: { at: number; relations: PublishedRelation[] } | null = null;

  /** Composed only from ANALYTICS_DB_*; never DATABASE_URL/DB_* (capiro_app) or PROMOTER_* (a write role). */
  private config(): ReaderConnectionConfig {
    return readerConfigFromEnv('ANALYTICS_DB', READER_ROLE, 'query_capiro_data/query_global_data');
  }

  private getClient(): PrismaClient {
    if (this.client) return this.client;
    this.client = new PrismaClient({ datasources: { db: { url: readerUrl(this.config(), 'public') } } });
    return this.client;
  }

  private getPool(): Pool {
    if (this.pool) return this.pool;
    this.pool = createReaderPool(this.config());
    return this.pool;
  }

  /**
   * Runs a compiled QuerySpec and returns plain rows. Never call with anything
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

  private async currentSurface(client: Parameters<typeof readPublishedSurface>[0]): Promise<PublishedRelation[]> {
    if (this.surface && Date.now() - this.surface.at < SURFACE_TTL_MS) return this.surface.relations;
    const relations = await readPublishedSurface(client, SOURCE_SCHEMAS.public, 'ingested_public_records', PUBLIC_RELATION_NAMES);
    this.surface = { at: Date.now(), relations };
    return relations;
  }

  private async transaction<T>(work: (client: Parameters<typeof readPublishedSurface>[0], surface: PublishedRelation[]) => Promise<T>): Promise<T> {
    let pool: Pool;
    try {
      pool = this.getPool();
    } catch (error) {
      this.logger.error(`public reader unavailable: ${error instanceof Error ? error.message : String(error)}`);
      throw translateDatabaseError(error, null, []);
    }
    return withReadOnlyTransaction(pool, { role: READER_ROLE, searchPath: SOURCE_SCHEMAS.public, statementTimeoutMs: 8000 }, async (client) =>
      work(client, await this.currentSurface(client)),
    );
  }

  /** The surface as capiro_analytics_ro sees it (cached briefly; grants change only by migration). */
  async describePublic(): Promise<PublishedRelation[]> {
    try {
      return await this.transaction(async (_client, surface) => surface);
    } catch (error) {
      throw translateDatabaseError(error, null, this.surface?.relations ?? []);
    }
  }

  /** Only gate-produced statements, on this owner's dedicated public reader connection. */
  async runPublicSql(gated: GatedSqlStatement): Promise<{ columns: SqlResultColumn[]; rows: SqlResultRow[]; surface: PublishedRelation[] }> {
    try {
      return await this.transaction(async (client, surface) => ({ ...(await executeGatedStatement(client, gated)), surface }));
    } catch (error) {
      throw translateDatabaseError(error, gated, this.surface?.relations ?? []);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) await this.client.$disconnect();
    if (this.pool) await this.pool.end();
  }
}
