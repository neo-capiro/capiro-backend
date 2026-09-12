import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';

/** The shared capability read follows the existing API/Intel rollout bridge.
 * Public facts are API-owned; this read exposes no folder or recipient data. */
export async function requireStateCalendar(prisma: PrismaService, tenantId: string): Promise<void> {
  const enabled = await prisma.withSystem(
    (tx) => tx.$queryRaw<Array<{ enabled: boolean }>>`
    SELECT enabled FROM intel_feature_flag
    WHERE feature='legiwatch_state_calendar_v1' AND tenant_id=${tenantId} AND enabled=true
  `,
  );
  if (!enabled[0]?.enabled)
    throw new ForbiddenException('State calendar is not enabled for this workspace');
}
