import type { PrismaClient } from '@prisma/client';
import { ALL_US_STATE_CODES } from '../external/legiscan/us-states.js';
import { withLegislativeWriter } from './legislative-writer.js';

/** State metadata/document writers retain their canonical per-state lease namespace. */
export async function withStateBillWriter<T>(
  prisma: PrismaClient,
  states: readonly string[],
  run: (writer: PrismaClient) => Promise<T>,
): Promise<T> {
  if (
    !states.length ||
    states.some((state) => !(ALL_US_STATE_CODES as readonly string[]).includes(state))
  )
    throw Error('STATE_WRITER_SCOPE_INVALID');
  return withLegislativeWriter(
    prisma,
    states.map((state) => 'state-bills:' + state),
    'STATE_WRITER',
    run,
  );
}
