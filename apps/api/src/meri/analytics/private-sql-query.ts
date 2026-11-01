import {
  capturePrivateSqlContext,
  type PrivateSqlDbService,
  type PrivateSqlExecutionContext,
} from './private-sql-db.service.js';
import { describeEnvelope, queryEnvelope } from './sql-query-output.js';
import { gateSqlStatement, SqlQueryError } from './sql-statement-gate.js';

type Db = Pick<PrivateSqlDbService, 'describe' | 'runPrivateSql'>;
const version = '0.3.0' as const;
export type ResearchSqlScope = Awaited<
  ReturnType<
    typeof import('../../research-portfolios/research-portfolio-sql-authority.js').readResearchPortfolioSqlScope
  >
>;
function sourceFor(context: PrivateSqlExecutionContext) {
  return context.scopeKind === 'research_portfolio' || context.scopeKind === 'classic_outreach'
    ? context.scopeKind
    : 'client_records';
}
function resultScope(context: PrivateSqlExecutionContext, research?: ResearchSqlScope) {
  if (context.scopeKind === 'research_portfolio') {
    if (
      !research ||
      research.kind !== 'research_portfolio' ||
      research.researchPortfolioId !== context.researchPortfolioId
    )
      throw new SqlQueryError('SOURCE_UNAVAILABLE', 'Research scope is unavailable.');
    return Object.freeze({ ...research });
  }
  return { kind: sourceFor(context), clientId: context.clientId };
}

function failure(error: unknown, generatedAt: string) {
  // Current-owner denial/cancellation is transport authority, never a successful empty SQL page.
  if (!(error instanceof SqlQueryError)) throw error;
  return { version, generatedAt, ok: false as const, error: error.toEnvelope() };
}

/** One immutable server composition over the private reader. Source chooses a fixed relation vocabulary, never a connection or authority. */
export function createPrivateSqlQueries(db: Db) {
  return Object.freeze({
    async describe(
      input: unknown,
      supplied: PrivateSqlExecutionContext,
      research?: ResearchSqlScope,
    ) {
      const context = capturePrivateSqlContext(supplied),
        generatedAt = new Date().toISOString();
      try {
        const head = { version, generatedAt, scope: resultScope(context, research) };
        return describeEnvelope(head, input, await db.describe(context), sourceFor(context));
      } catch (error) {
        return failure(error, generatedAt);
      }
    },
    async query(input: unknown, supplied: PrivateSqlExecutionContext, research?: ResearchSqlScope) {
      const context = capturePrivateSqlContext(supplied),
        generatedAt = new Date().toISOString();
      try {
        const scope = resultScope(context, research);
        const gated = gateSqlStatement(input, sourceFor(context));
        const fetched = await db.runPrivateSql(gated, context);
        const head = { version, generatedAt, scope };
        return queryEnvelope(head, gated, fetched, fetched.surface);
      } catch (error) {
        return failure(error, generatedAt);
      }
    },
  });
}
