/** @cleanup-smoke noArgsExit=2 */
/** Read-only backend entry point: search exact/keyword/semantic, read an immutable extraction, or inspect FY26 coverage. */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { PrismaClient, type Prisma } from '@prisma/client';
import { getDefaultEmbeddingProvider } from '../src/embeddings/embedding-provider.factory.js';
import { BillTextService } from '../src/retrieval/bill-text.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { BillTextSearchRequest } from '../src/retrieval/bill-text-query.js';

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: { operation: { type: 'string' }, 'request-file': { type: 'string' } },
  });
  if (!['search', 'read', 'coverage'].includes(values.operation ?? ''))
    throw Error('OPERATION_MUST_BE_SEARCH_READ_OR_COVERAGE');
  if (values.operation !== 'coverage' && !values['request-file'])
    throw Error('REQUEST_FILE_REQUIRED');
  if (values.operation === 'coverage' && values['request-file'])
    throw Error('COVERAGE_DOES_NOT_ACCEPT_FILTERS');
  const raw = values['request-file'] ? readFileSync(values['request-file'], 'utf8') : '{}';
  if (raw.length > 16000) throw Error('REQUEST_FILE_TOO_LARGE');
  const request = JSON.parse(raw) as Record<string, unknown>;
  if (!request || Array.isArray(request) || typeof request !== 'object')
    throw Error('REQUEST_OBJECT_REQUIRED');
  if (!process.env.DATABASE_URL) throw Error('DATABASE_URL_REQUIRED');
  const db = new PrismaClient();
  try {
    const reader = {
      withSystem: <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) =>
        db.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
            await tx.$executeRawUnsafe("SET LOCAL app.bypass_rls='on'");
            await tx.$executeRawUnsafe("SET LOCAL statement_timeout='60s'");
            return callback(tx);
          },
          { timeout: 120000 },
        ),
    };
    const service = new BillTextService(reader as PrismaService, getDefaultEmbeddingProvider());
    const result =
      values.operation === 'coverage'
        ? await service.coverage()
        : values.operation === 'read'
          ? await service.read(request)
          : await service.search(request as BillTextSearchRequest);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await db.$disconnect();
  }
}
if (require.main === module) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(
      'Usage: verify-bill-text --operation search|read|coverage [--request-file request.json]. Requires DATABASE_URL. Transactions are read-only; semantic search invokes the configured embedding model.\nSearch JSON: ' +
        JSON.stringify({
          mode: 'keyword',
          query: '"exact phrase" words',
          jurisdictions: ['FL'],
          session: '2025',
          fiscalYear: 2026,
        }) +
        '\nExact: {"mode":"exact","billId":"FL-2025-HB1","section":"1"}. Read: use the returned identity billId/jurisdiction/session/revisionId/extractionId or {"cursor":"..."}. Date bounds: dateFrom inclusive, dateBefore exclusive, dateBasis published|introduced|action.',
    );
  } else if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL_REQUIRED; use --help');
    process.exitCode = 2;
  } else
    void main().catch((error) => {
      console.error(
        error instanceof Error && /^[A-Z_]+$/.test(error.message)
          ? error.message
          : 'BILL_TEXT_VERIFICATION_FAILED',
      );
      process.exitCode = 1;
    });
}
