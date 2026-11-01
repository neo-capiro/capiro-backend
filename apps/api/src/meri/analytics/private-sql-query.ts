import { capturePrivateSqlContext, type PrivateSqlDbService, type PrivateSqlExecutionContext } from './private-sql-db.service.js';
import { describeEnvelope, queryEnvelope } from './sql-query-output.js';
import { gateSqlStatement, SqlQueryError } from './sql-statement-gate.js';

type Db = Pick<PrivateSqlDbService, 'describe' | 'runPrivateSql'>;
const version = '0.3.0' as const;

function failure(error: unknown, generatedAt: string) {
  // Current-owner denial/cancellation is transport authority, never a successful empty SQL page.
  if (!(error instanceof SqlQueryError)) throw error;
  return { version, generatedAt, ok: false as const, error: error.toEnvelope() };
}

/** One immutable server composition over the client-record reader. There is no request-selected connection or registry. */
export function createPrivateSqlQueries(db: Db) {
  return Object.freeze({
    async describe(input: unknown, supplied: PrivateSqlExecutionContext) {
      const context = capturePrivateSqlContext(supplied),
        generatedAt = new Date().toISOString();
      try {
        const head = { version, generatedAt, scope: { kind: 'client_records' as const, clientId: context.clientId } };
        return describeEnvelope(head, input, await db.describe(context), 'client_records');
      } catch (error) {
        return failure(error, generatedAt);
      }
    },
    async query(input: unknown, supplied: PrivateSqlExecutionContext) {
      const context = capturePrivateSqlContext(supplied),
        generatedAt = new Date().toISOString();
      try {
        const gated = gateSqlStatement(input, 'client_records');
        const fetched = await db.runPrivateSql(gated, context);
        const head = { version, generatedAt, scope: { kind: 'client_records' as const, clientId: context.clientId } };
        return queryEnvelope(head, gated, fetched, fetched.surface);
      } catch (error) {
        return failure(error, generatedAt);
      }
    },
  });
}
