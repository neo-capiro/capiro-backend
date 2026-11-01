import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ReviewTransaction } from './client-profile-fill-review-store.js';

/** Existing standalone owners can also participate in one reviewed finding. */
export function withinFinding<T>(
  prisma: PrismaService,
  tenantId: string,
  scope: ReviewTransaction | undefined,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return scope ? write(scope.tx) : prisma.withTenant(tenantId, write);
}

export async function afterFindingCommit(
  scope: ReviewTransaction | undefined,
  effect: () => Promise<unknown>,
) {
  if (scope) scope.afterCommit.push(effect);
  else await effect();
}
