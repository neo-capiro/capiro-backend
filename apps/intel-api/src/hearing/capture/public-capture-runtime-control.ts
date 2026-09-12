import type { PrismaService } from '../../prisma/prisma.service.js';

/** The existing DB registry is observable by an already-running ECS task. */
export async function assertPublicCaptureRuntimeEnabled(prisma: PrismaService) {
  const rows = await prisma.$queryRaw<
    Array<{ enabled: boolean }>
  >`SELECT (enabled AND schedule_enabled) AS enabled
    FROM legiwatch_runtime_heartbeat WHERE job_key='capture-worker'`;
  if (!rows[0]?.enabled) throw Error('CAPTURE_RUNTIME_DISABLED');
}
