import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import {
  createReaderPool,
  executeGatedStatement,
  readerConfigFromEnv,
  readPublishedSurface,
  translateDatabaseError,
  withReadOnlyTransaction,
  type PublishedRelation,
  type SqlResultColumn,
  type SqlResultRow,
} from './sql-reader-connection.js';
import { PRIVATE_RELATION_NAMES, SOURCE_SCHEMAS, SqlQueryError, type GatedSqlStatement } from './sql-statement-gate.js';

export const PRIVATE_SQL_VIEW_NAMES = PRIVATE_RELATION_NAMES;
const READER_ROLE = 'capiro_private_query_ro';
const SURFACE_TTL_MS = 300_000;

type Scope =
  | { readonly scopeKind: 'general'; readonly clientId: null }
  | { readonly scopeKind: 'client'; readonly clientId: string };
/** Internal input from the canonical current owner, never a model/HTTP authorization claim.
 * assertCurrent closes over that owner's admitted receipt and checks its current expect fields. */
export type PrivateSqlExecutionContext = Readonly<{
  tenantId: string;
  actorId: string;
  deadlineMs: number;
  assertCurrent(): Promise<void>;
}> &
  Scope;

const timeout = () => new SqlQueryError('QUERY_TIMEOUT', 'The private query exceeded its execution time limit. Narrow the query.');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Copy selectors before any await. This validates an internal contract; UUIDs do not establish authority. */
export function capturePrivateSqlContext(context: PrivateSqlExecutionContext): PrivateSqlExecutionContext {
  if (
    !context ||
    !uuid.test(context.tenantId) ||
    !uuid.test(context.actorId) ||
    !Number.isSafeInteger(context.deadlineMs) ||
    typeof context.assertCurrent !== 'function' ||
    !(
      (context.scopeKind === 'general' && context.clientId === null) ||
      (context.scopeKind === 'client' && typeof context.clientId === 'string' && uuid.test(context.clientId))
    )
  )
    throw new ForbiddenException('Private query access unavailable');
  const { tenantId, actorId, deadlineMs, assertCurrent, scopeKind, clientId } = context;
  return Object.freeze({ tenantId, actorId, deadlineMs, assertCurrent, scopeKind, clientId }) as PrivateSqlExecutionContext;
}

function remaining(context: PrivateSqlExecutionContext): number {
  const ms = context.deadlineMs - Date.now();
  if (ms <= 0) throw timeout();
  return ms;
}

/**
 * The client-record reader: `capiro_private_query_ro` over the meri_private
 * security-barrier views. The views read the transaction-local context
 * (app.current_tenant, app.current_user, app.meri_query_scope,
 * app.meri_query_client) that this service binds from the canonical current
 * owner before the model's statement runs; the reader cannot select
 * visible_clients or any base table. The gate refuses set_config in model SQL
 * because PostgreSQL lets any role set a custom GUC (see the integration spec).
 */
@Injectable()
export class PrivateSqlDbService {
  private pool: Pool | null = null;
  private surface: { at: number; relations: PublishedRelation[] } | null = null;

  private getPool(): Pool {
    if (this.pool) return this.pool;
    // No app, public analytics or promoter credential fallback. No connection is created at import.
    this.pool = createReaderPool(readerConfigFromEnv('PRIVATE_QUERY_DB', READER_ROLE, 'query_capiro_data'));
    return this.pool;
  }

  /** The published client-record surface under an admitted context. */
  async describe(context: PrivateSqlExecutionContext): Promise<PublishedRelation[]> {
    return (await this.runChecked(null, context)).surface;
  }

  /** Only gate-produced statements; context comes from the canonical current owner. */
  async runPrivateSql(
    gated: GatedSqlStatement,
    context: PrivateSqlExecutionContext,
  ): Promise<{ columns: SqlResultColumn[]; rows: SqlResultRow[]; surface: PublishedRelation[] }> {
    return this.runChecked(gated, context);
  }

  private async currentSurface(client: PoolClient): Promise<PublishedRelation[]> {
    if (this.surface && Date.now() - this.surface.at < SURFACE_TTL_MS) return this.surface.relations;
    const relations = await readPublishedSurface(client, SOURCE_SCHEMAS.client_records, 'authorized_client_records', PRIVATE_RELATION_NAMES);
    this.surface = { at: Date.now(), relations };
    return relations;
  }

  private async runChecked(
    gated: GatedSqlStatement | null,
    supplied: PrivateSqlExecutionContext,
  ): Promise<{ columns: SqlResultColumn[]; rows: SqlResultRow[]; surface: PublishedRelation[] }> {
    const context = capturePrivateSqlContext(supplied);
    remaining(context);
    await context.assertCurrent();
    let result: { columns: SqlResultColumn[]; rows: SqlResultRow[]; surface: PublishedRelation[] };
    try {
      result = await withReadOnlyTransaction(
        this.getPool(),
        {
          role: READER_ROLE,
          searchPath: SOURCE_SCHEMAS.client_records,
          statementTimeoutMs: Math.min(8000, remaining(context)),
          context: {
            bypassRlsOff: true,
            settings: {
              'app.current_tenant': context.tenantId,
              'app.current_user': context.actorId,
              'app.meri_query_scope': context.scopeKind,
              'app.meri_query_client': context.clientId ?? '',
            },
          },
        },
        async (client) => {
          const surface = await this.currentSurface(client);
          remaining(context);
          return gated ? { ...(await executeGatedStatement(client, gated)), surface } : { columns: [], rows: [], surface };
        },
      );
    } catch (error) {
      throw translateDatabaseError(error, gated, this.surface?.relations ?? []);
    }
    // Fresh owner observation after the read transaction, never its older MVCC snapshot.
    remaining(context);
    await context.assertCurrent();
    remaining(context);
    return result;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
