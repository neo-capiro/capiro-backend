import { PRIVATE_SQL_ROLE_CHECK } from './private-sql-admission.js';
import { privateSqlNormalizationRuntimeAdmitted } from './private-sql-normalization-runtime.js';
import { describePrivateSqlDomains } from './private-sql-domain-metadata.js';
import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
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
import {
  PRIVATE_RELATION_NAMES,
  SOURCE_RELATIONS,
  SOURCE_SCHEMAS,
  SqlQueryError,
  type GatedSqlStatement,
} from './sql-statement-gate.js';

export const PRIVATE_SQL_VIEW_NAMES = PRIVATE_RELATION_NAMES;
const READER_ROLE = 'capiro_private_query_ro';

type Scope =
  | { readonly scopeKind: 'general'; readonly clientId: null }
  | { readonly scopeKind: 'client'; readonly clientId: string }
  | {
      readonly scopeKind: 'research_portfolio';
      readonly clientId: null;
      readonly researchPortfolioId: string;
    }
  | {
      readonly scopeKind: 'classic_outreach';
      readonly clientId: string | null;
      readonly classicOutreachIds: readonly string[];
    };
/** Internal input from the canonical current owner, never a model/HTTP authorization claim.
 * assertCurrent closes over that owner's admitted receipt and checks its current expect fields. */
export type PrivateSqlExecutionContext = Readonly<{
  tenantId: string;
  actorId: string;
  deadlineMs: number;
  assertCurrent(): Promise<void>;
}> &
  Scope;

const unavailable = () =>
  new SqlQueryError('SOURCE_UNAVAILABLE', 'Private data is currently unavailable.');
const timeout = () =>
  new SqlQueryError(
    'QUERY_TIMEOUT',
    'The private query exceeded its execution time limit. Narrow the query.',
  );
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Copy selectors before any await. This validates an internal contract; UUIDs do not establish authority. */
export function capturePrivateSqlContext(
  context: PrivateSqlExecutionContext,
): PrivateSqlExecutionContext {
  if (!context) throw new ForbiddenException('Private query access unavailable');
  const { tenantId, actorId, deadlineMs, assertCurrent, scopeKind, clientId } = context;
  const selectors = context as PrivateSqlExecutionContext & {
    researchPortfolioId?: unknown;
    classicOutreachIds?: unknown;
  };
  const portfolioId = selectors.researchPortfolioId;
  const ids = selectors.classicOutreachIds;
  const canonicalUuid = (value: unknown): value is string =>
    typeof value === 'string' && uuid.test(value);
  const validScope =
    (scopeKind === 'general' &&
      clientId === null &&
      portfolioId === undefined &&
      ids === undefined) ||
    (scopeKind === 'client' &&
      canonicalUuid(clientId) &&
      portfolioId === undefined &&
      ids === undefined) ||
    (scopeKind === 'research_portfolio' &&
      clientId === null &&
      canonicalUuid(portfolioId) &&
      ids === undefined) ||
    (scopeKind === 'classic_outreach' &&
      (clientId === null || canonicalUuid(clientId)) &&
      portfolioId === undefined &&
      Array.isArray(ids) &&
      ids.length <= 100 &&
      Array.from(ids).every(canonicalUuid) &&
      new Set(ids).size === ids.length);
  if (
    !canonicalUuid(tenantId) ||
    !canonicalUuid(actorId) ||
    !Number.isSafeInteger(deadlineMs) ||
    typeof assertCurrent !== 'function' ||
    !validScope
  )
    throw new ForbiddenException('Private query access unavailable');
  const common = { tenantId, actorId, deadlineMs, assertCurrent };
  if (scopeKind === 'research_portfolio')
    return Object.freeze({
      ...common,
      scopeKind,
      clientId: null,
      researchPortfolioId: portfolioId as string,
    });
  if (scopeKind === 'classic_outreach')
    return Object.freeze({
      ...common,
      scopeKind,
      clientId,
      classicOutreachIds: Object.freeze([...(ids as string[])]),
    });
  return Object.freeze({ ...common, scopeKind, clientId }) as PrivateSqlExecutionContext;
}

function remaining(context: PrivateSqlExecutionContext): number {
  const ms = context.deadlineMs - Date.now();
  if (ms <= 0) throw timeout();
  return ms;
}

/**
 * The private-domain reader: `capiro_private_query_ro` over the meri_private
 * security-barrier views. The views read the transaction-local context
 * (app.current_tenant, app.current_user, app.meri_query_scope,
 * app.meri_query_client, app.meri_query_portfolio, app.meri_query_classic_ids)
 * that this service binds from the canonical current
 * owner before the model's statement runs; the reader cannot select
 * visible_clients or any base table. The gate refuses set_config in model SQL
 * because PostgreSQL lets any role set a custom GUC (see the integration spec).
 */
@Injectable()
export class PrivateSqlDbService {
  private pool: Pool | null = null;

  private getPool(): Pool {
    if (this.pool) return this.pool;
    // No app, public analytics or promoter credential fallback. No connection is created at import.
    this.pool = createReaderPool(
      readerConfigFromEnv('PRIVATE_QUERY_DB', READER_ROLE, 'query_capiro_data'),
    );
    return this.pool;
  }

  /** The published source surface under an admitted context. */
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

  private async runChecked(
    gated: GatedSqlStatement | null,
    supplied: PrivateSqlExecutionContext,
  ): Promise<{ columns: SqlResultColumn[]; rows: SqlResultRow[]; surface: PublishedRelation[] }> {
    const context = capturePrivateSqlContext(supplied);
    const source =
      context.scopeKind === 'research_portfolio' || context.scopeKind === 'classic_outreach'
        ? context.scopeKind
        : 'client_records';
    if (gated && gated.source !== source) throw unavailable();
    remaining(context);
    if (!privateSqlNormalizationRuntimeAdmitted()) throw unavailable();
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
              'app.meri_query_portfolio':
                context.scopeKind === 'research_portfolio' ? context.researchPortfolioId : '',
              'app.meri_query_classic_ids':
                context.scopeKind === 'classic_outreach'
                  ? context.classicOutreachIds.join(',')
                  : '',
            },
          },
        },
        async (client) => {
          const admission = await client.query<{ allowed: boolean }>(PRIVATE_SQL_ROLE_CHECK);
          if (admission.rows.length !== 1 || admission.rows[0]?.allowed !== true)
            throw unavailable();
          const observed = await readPublishedSurface(
            client,
            SOURCE_SCHEMAS[source],
            'authorized_' + source,
            SOURCE_RELATIONS[source],
          );
          const scoped = observed.filter((relation) =>
            SOURCE_RELATIONS[source].includes(relation.name),
          );
          if (scoped.length !== SOURCE_RELATIONS[source].length) throw unavailable();
          const surface = describePrivateSqlDomains(scoped);
          remaining(context);
          return gated
            ? { ...(await executeGatedStatement(client, gated)), surface }
            : { columns: [], rows: [], surface };
        },
      );
    } catch (error) {
      throw translateDatabaseError(error, gated, []);
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
