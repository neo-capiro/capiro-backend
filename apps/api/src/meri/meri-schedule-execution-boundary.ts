import type { Prisma } from '@prisma/client';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';

export type ScheduledTaskExecutionBoundary = 'runnable' | 'inactive' | 'wall_denied';

/**
 * Re-check the current task row and current actor/client ethical-wall authority
 * immediately before an unattended scheduled run. The due-task query is only a
 * snapshot; same-tenant client existence is not permission.
 */
export async function checkScheduledTaskExecutionBoundary(
  tx: Prisma.TransactionClient,
  task: { id: string; tenantId: string; ownerUserId: string },
): Promise<ScheduledTaskExecutionBoundary> {
  const current = await tx.clioScheduledTask.findFirst({
    where: {
      id: task.id,
      tenantId: task.tenantId,
      ownerUserId: task.ownerUserId,
      enabled: true,
    },
    select: { metadata: true },
  });
  if (!current) return 'inactive';

  const metadata = current.metadata && typeof current.metadata === 'object'
    && !Array.isArray(current.metadata)
    ? current.metadata as Record<string, unknown>
    : {};
  const clientId = typeof metadata.clientId === 'string' ? metadata.clientId : null;
  if (!clientId) return 'runnable';

  const client = await tx.client.findFirst({
    where: {
      id: clientId,
      tenantId: task.tenantId,
      status: { not: 'archived' },
    },
    select: { id: true },
  });
  if (!client) return 'wall_denied';

  return await clientMemoryAllowed(tx, task.tenantId, task.ownerUserId, clientId)
    ? 'runnable'
    : 'wall_denied';
}
