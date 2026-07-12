/**
 * Generate Meri proactive alerts on a schedule (replaces the per-message
 * in-stream scan that previously ran generateProactiveAlerts() after every
 * chat reply). Scans every ACTIVE tenant for:
 *
 *   1. Upcoming meetings (next 48h) that have no prep notes.
 *   2. Active clients with no meeting/engagement in 30+ days.
 *
 * and writes clio_proactive_alert rows (status=pending) that the Meri bell +
 * "Scheduled briefings" banner surface via GET /api/clio/alerts. Dedupes per
 * (tenant, sourceType, sourceId) against BOTH pending AND dismissed ('read')
 * rows, so a dismissed alert stays dismissed instead of resurrecting on the
 * next run while the underlying condition still holds.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/emit-clio-alerts.ts
 *
 * Intended cadence: every 30-60 min via the existing scheduled-task runner
 * (same mechanism as sync-* / emit-bill-alerts). No schema changes — mirrors
 * MeriService.generateProactiveAlerts but runs standalone (no Nest DI) and
 * iterates all tenants. Reads meeting/client/clio_proactive_alert.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
dotenvConfig();

const prisma = new PrismaClient();

const MEETING_PREP_WINDOW_MS = 48 * 60 * 60 * 1000;
const STALE_CLIENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const PER_TENANT_TAKE = 5;

async function generateForTenant(tenantId: string): Promise<number> {
  let created = 0;

  // 1. Upcoming meetings without prep (next 48 hours).
  const now = new Date();
  const horizon = new Date(now.getTime() + MEETING_PREP_WINDOW_MS);
  const upcomingMeetings = await prisma.meeting.findMany({
    where: {
      tenantId,
      startsAt: { gte: now, lte: horizon },
      preps: { none: {} },
    },
    select: {
      id: true,
      subject: true,
      startsAt: true,
      clientId: true,
      client: { select: { name: true } },
    },
    take: PER_TENANT_TAKE,
  });

  for (const meeting of upcomingMeetings) {
    const exists = await prisma.clioProactiveAlert.findFirst({
      // pending OR read: a dismissed alert must not resurrect on the next run.
      where: {
        tenantId,
        sourceType: 'meeting_prep',
        sourceId: meeting.id,
        status: { in: ['pending', 'read'] },
      },
      select: { id: true },
    });
    if (exists) continue;
    await prisma.clioProactiveAlert.create({
      data: {
        tenantId,
        clientId: meeting.clientId,
        alertType: 'meeting_prep_needed',
        title: `Meeting prep needed: ${meeting.subject}`,
        body: `Your meeting "${meeting.subject}"${meeting.client?.name ? ` with ${meeting.client.name}` : ''} is in less than 48 hours and has no prep notes. Ask Meri to create a meeting brief.`,
        priority: 'high',
        sourceType: 'meeting_prep',
        sourceId: meeting.id,
        metadata: { meetingId: meeting.id, startsAt: meeting.startsAt.toISOString() },
      },
    });
    created++;
  }

  // 2. Active clients with no recent engagement (30+ days).
  const staleSince = new Date(now.getTime() - STALE_CLIENT_WINDOW_MS);
  const staleClients = await prisma.client.findMany({
    where: {
      tenantId,
      status: 'active',
      meetings: { none: { startsAt: { gte: staleSince } } },
    },
    select: { id: true, name: true },
    take: PER_TENANT_TAKE,
  });

  for (const client of staleClients) {
    const exists = await prisma.clioProactiveAlert.findFirst({
      // pending OR read: a dismissed alert must not resurrect on the next run.
      where: {
        tenantId,
        sourceType: 'stale_client',
        sourceId: client.id,
        status: { in: ['pending', 'read'] },
      },
      select: { id: true },
    });
    if (exists) continue;
    await prisma.clioProactiveAlert.create({
      data: {
        tenantId,
        clientId: client.id,
        alertType: 'client_activity',
        title: `No recent activity: ${client.name}`,
        body: `${client.name} hasn't had a meeting or engagement in over 30 days. Consider scheduling a check-in.`,
        priority: 'normal',
        sourceType: 'stale_client',
        sourceId: client.id,
        metadata: {},
      },
    });
    created++;
  }

  return created;
}

async function main(): Promise<void> {
  const tenants = await prisma.tenant.findMany({
    where: { status: 'active' },
    select: { id: true, slug: true },
  });
  console.log(`[emit-clio-alerts] scanning ${tenants.length} active tenant(s)`);

  let totalCreated = 0;
  for (const tenant of tenants) {
    try {
      const n = await generateForTenant(tenant.id);
      totalCreated += n;
      if (n > 0) console.log(`[emit-clio-alerts] ${tenant.slug}: created ${n} alert(s)`);
    } catch (err) {
      // One tenant's failure must not abort the rest of the run.
      console.error(`[emit-clio-alerts] ${tenant.slug}: FAILED: ${(err as Error).message}`);
    }
  }

  console.log(
    `[emit-clio-alerts] done. Created ${totalCreated} new alert(s) across ${tenants.length} tenant(s).`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
