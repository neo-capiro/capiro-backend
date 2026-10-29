import { ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { readMemoryRetentionWitness, type MemoryRetentionWitness } from './witness.js';

const unavailable = () => new ServiceUnavailableException({ code: 'MEMORY_RETENTION_UNAVAILABLE' });

/** The ordinary tenant transaction remains the authorization owner. The SQL
 * policy uses this proof only for conversation-derived copies, takes canonical
 * retention exclusions and marks whether it used the proof. Unrelated approved
 * and surface memory stays usable when the external witness is unavailable.
 * All writes roll back if the final external position is unavailable/changed. */
export async function withMemoryConversationRetention<T>(
  prisma: Pick<PrismaService, 'withTenantUser' | 'withTenant'>,
  tenantId: string,
  userId: string | null,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { timeoutMs?: number; readWitness?: () => Promise<MemoryRetentionWitness | null> },
): Promise<T> {
  const read = options?.readWitness ?? readMemoryRetentionWitness;
  const before = await read();
  try {
    const guarded = async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT memory_conversation_serving_begin(${JSON.stringify(before)}::jsonb)`;
      const result = await work(tx);
      const rows = await tx.$queryRaw<Array<{ used: string | null }>>`
        SELECT current_setting('app.memory_retention_used',true) AS used`;
      if (rows.some((row) => row.used === 'on')) {
        const after = await read();
        if (
          before === null ||
          after === null ||
          before.sequence !== after.sequence ||
          before.entrySha256 !== after.entrySha256
        )
          throw unavailable();
        // Recheck the database after the external read while the transaction
        // still owns the canonical exclusions. This is also the commit guard.
        await tx.$executeRaw`SELECT memory_conversation_serving_verify()`;
      }
      return result;
    };
    const transactionOptions =
      options?.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs };
    if (transactionOptions === undefined)
      return await (userId === null
        ? prisma.withTenant(tenantId, guarded)
        : prisma.withTenantUser(tenantId, userId, guarded));
    return await (userId === null
      ? prisma.withTenant(tenantId, guarded, transactionOptions)
      : prisma.withTenantUser(tenantId, userId, guarded, transactionOptions));
  } catch (error) {
    if (error instanceof ServiceUnavailableException || String(error).includes('MEMORY_RETENTION_'))
      throw unavailable();
    throw error;
  }
}
