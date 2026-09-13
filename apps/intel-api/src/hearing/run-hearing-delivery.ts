import 'reflect-metadata';
import { hostname } from 'node:os';
import { PrismaService } from '../prisma/prisma.service.js';
import { Phase9RuntimeHeartbeat } from './phase9-runtime-heartbeat.js';
import { reportRuntime } from '../tracker/reports/report-runtime.js';

/** Selected new kinds use the existing leased dispatcher and runtime registry. */
async function main() {
  if (process.argv.length !== 2) throw Error('Usage: hearing-delivery');
  if (
    process.env.LEGIWATCH_HEARING_EMAIL_ENABLED !== 'true' &&
    process.env.LEGIWATCH_HEARING_SMS_ENABLED !== 'true' &&
    process.env.LEGIWATCH_HEARING_INBOX_ENABLED !== 'true' &&
    process.env.LEGIWATCH_RECORD_EMAIL_ENABLED !== 'true' &&
    process.env.LEGIWATCH_RECORD_SMS_ENABLED !== 'true' &&
    process.env.LEGIWATCH_RECORD_INBOX_ENABLED !== 'true'
  )
    throw Error('Hearing delivery is disabled');
  const prisma = new PrismaService();
  const heartbeat = new Phase9RuntimeHeartbeat(prisma, {
    jobKey: 'hearing-delivery-worker',
    workerId: 'hearing-delivery:' + hostname() + ':' + process.pid,
  });
  try {
    await heartbeat.begin();
    const { delivery } = reportRuntime(prisma);
    const scopes = await prisma.withSystem((tx) =>
      tx.featureFlag.findMany({
        where: {
          enabled: true,
          feature: {
            in: [
              'legiwatch_hearing_updates_v1',
              'legiwatch_hearing_recaps_v1',
              'legiwatch_record_delivery_v1',
            ],
          },
        },
        select: { tenantId: true, feature: true },
        orderBy: { tenantId: 'asc' },
        take: 100,
      }),
    );
    let attempted = 0,
      held = 0;
    for (const scope of scopes) {
      const ready = await prisma.$queryRaw<Array<{ enabled: boolean }>>`
        SELECT (enabled AND schedule_enabled) AS enabled FROM legiwatch_runtime_heartbeat WHERE job_key='hearing-delivery-worker'`;
      if (!ready[0]?.enabled) break;
      const result = await delivery.drain(
        scope.tenantId,
        25,
        new Date(),
        scope.feature === 'legiwatch_record_delivery_v1'
          ? 'record_brief'
          : scope.feature === 'legiwatch_hearing_updates_v1'
            ? 'live_update'
            : 'hearing_recap',
      );
      attempted += result.attempted;
      held += result.held;
      if (scope.feature === 'legiwatch_record_delivery_v1') {
        const corrections = await delivery.drain(
          scope.tenantId,
          25,
          new Date(),
          'record_correction',
        );
        attempted += corrections.attempted;
        held += corrections.held;
      }
      await heartbeat.beat({ attempted, held });
    }
    await heartbeat.succeed({ attempted, held });
    console.log(JSON.stringify({ event: 'hearing_delivery_pass', attempted, held }));
  } catch {
    await heartbeat.fail(new Error('Hearing delivery pass failed')).catch(() => undefined);
    process.exitCode = 1;
  } finally {
    heartbeat.stopTimer();
    await prisma.$disconnect();
  }
}
void main().catch(() => {
  console.error('Hearing delivery is unavailable; inspect runtime registration and channel gates.');
  process.exitCode = 1;
});
