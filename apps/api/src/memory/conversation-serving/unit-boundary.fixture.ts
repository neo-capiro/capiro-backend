import type { PrismaService } from '../../prisma/prisma.service.js';
import type { Prisma } from '@prisma/client';

/** Domain unit suites already replace their database with query-specific
 * doubles. Keep those assertions scoped to their domain rather than pretending
 * the doubles implement PostgreSQL locks/RLS. The actual serving wrapper,
 * migration, roles and native predicate are tested by transaction.postgres. */
export function withMemoryConversationRetention<T>(
  prisma: Pick<PrismaService, 'withTenant' | 'withTenantUser'>,
  tenantId: string,
  userId: string | null,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T> {
  if (options === undefined)
    return userId === null
      ? prisma.withTenant(tenantId, work)
      : prisma.withTenantUser(tenantId, userId, work);
  return userId === null
    ? prisma.withTenant(tenantId, work, options)
    : prisma.withTenantUser(tenantId, userId, work, options);
}
