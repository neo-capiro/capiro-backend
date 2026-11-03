import type { PrismaClient } from '@prisma/client';
import { withLegislativeWriter } from './legislative-writer.js';

/** Standard Congress sync and FY26 enrichment share one fenced provider/source writer. */
export function withFederalBillWriter<T>(
  prisma: PrismaClient,
  run: (writer: PrismaClient) => Promise<T>,
): Promise<T> {
  return withLegislativeWriter(prisma, ['congress-bills'], 'FEDERAL_WRITER', run);
}
