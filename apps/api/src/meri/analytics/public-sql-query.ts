import type { AnalyticsDbService } from './analytics-db.service.js';
import { describeEnvelope, queryEnvelope } from './sql-query-output.js';
import { gateSqlStatement, SqlQueryError } from './sql-statement-gate.js';

const version = '0.2.0' as const;
function failure(error: unknown, generatedAt: string) {
  const known = error instanceof SqlQueryError ? error : new SqlQueryError('SOURCE_UNAVAILABLE', 'Public data is currently unavailable.');
  return { version, generatedAt, ok: false as const, error: known.toEnvelope() };
}

/** The public surface as capiro_analytics_ro sees it in meri_public, with the migration's published metadata. */
export async function describeCapiroData(input: unknown, db: Pick<AnalyticsDbService, 'describePublic'>) {
  const generatedAt = new Date().toISOString();
  try {
    return describeEnvelope({ version, generatedAt }, input, await db.describePublic(), 'public');
  } catch (error) {
    return failure(error, generatedAt);
  }
}

/** Thin native-tool seam; the gate admits the statement and the dedicated analytics owner executes it. */
export async function queryCapiroData(input: unknown, db: Pick<AnalyticsDbService, 'runPublicSql'>) {
  const generatedAt = new Date().toISOString();
  try {
    const gated = gateSqlStatement(input, 'public');
    const fetched = await db.runPublicSql(gated);
    return queryEnvelope({ version, generatedAt }, gated, fetched, fetched.surface);
  } catch (error) {
    return failure(error, generatedAt);
  }
}
