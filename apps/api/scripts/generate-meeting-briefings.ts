/**
 * Scheduled proactive meeting briefings (P2-8).
 *
 * For every active tenant, finds meetings entering the lookahead window (default
 * 7 days) and, per user (meeting creator), writes a "prep" briefing into the
 * in-app inbox (clio_proactive_alert) listing their newly-upcoming meetings.
 * Uses the pure selectMeetingBriefings helper for the daily-delta windowing so
 * the same meeting isn't re-briefed every day, and dedupes per (tenant, user,
 * day). Runs standalone (no Nest DI) like emit-clio-alerts / sync-*.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/generate-meeting-briefings.ts
 *
 * Intended cadence: once daily via the scheduled-task runner. Delivery is the
 * in-app inbox today; email delivery (SES + per-user address) is a follow-up.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  formatBriefingDigest,
  selectMeetingBriefings,
  type UpcomingMeeting,
} from '../src/meri/meri-briefing-schedule.helpers.js';
dotenvConfig();

const prisma = new PrismaClient();
const LOOKAHEAD_DAYS = Number(process.env.CLIO_BRIEFING_LOOKAHEAD_DAYS ?? '7');
const DAY_MS = 24 * 60 * 60 * 1000;

async function generateForTenant(tenantId: string, now: Date): Promise<number> {
  const horizon = new Date(now.getTime() + LOOKAHEAD_DAYS * DAY_MS);
  const meetings = await prisma.meeting.findMany({
    where: {
      tenantId,
      startsAt: { gte: now, lte: horizon },
      createdByUserId: { not: null },
    },
    select: {
      id: true,
      subject: true,
      startsAt: true,
      clientId: true,
      createdByUserId: true,
      client: { select: { name: true } },
    },
  });

  const upcoming: UpcomingMeeting[] = meetings.map((m) => ({
    id: m.id,
    userId: m.createdByUserId as string,
    clientId: m.clientId,
    clientName: m.client?.name ?? null,
    title: m.subject,
    startsAt: m.startsAt,
  }));

  // Daily delta: only meetings that newly entered the window since ~yesterday.
  const plans = selectMeetingBriefings(upcoming, {
    now,
    lookaheadDays: LOOKAHEAD_DAYS,
    lastRunAt: new Date(now.getTime() - DAY_MS),
  });

  const today = now.toISOString().slice(0, 10);
  let created = 0;
  for (const plan of plans) {
    const sourceId = `${plan.userId}:${today}`;
    const exists = await prisma.clioProactiveAlert.findFirst({
      where: { tenantId, sourceType: 'meeting_briefing', sourceId, status: 'pending' },
      select: { id: true },
    });
    if (exists) continue;
    const count = plan.meetings.length;
    await prisma.clioProactiveAlert.create({
      data: {
        tenantId,
        clientId: plan.meetings[0]?.clientId ?? null,
        // GAI-13: a meeting briefing is that user's PERSONAL digest — set the
        // owner column so the owner-aware RLS policy shows it only to them (not
        // to every user in the tenant). This script runs as capiro_master
        // (bypasses FORCE RLS on write); the column is what the serve-path read
        // filters on.
        ownerUserId: plan.userId,
        alertType: 'meeting_briefing',
        title: `Prep: ${count} upcoming meeting${count === 1 ? '' : 's'}`,
        body: formatBriefingDigest(plan),
        priority: 'normal',
        sourceType: 'meeting_briefing',
        sourceId,
        metadata: { userId: plan.userId, meetingIds: plan.meetings.map((m) => m.id) },
      },
    });
    created++;
  }
  return created;
}

async function main(): Promise<void> {
  const now = new Date();
  const tenants = await prisma.tenant.findMany({
    where: { status: 'active' },
    select: { id: true, slug: true },
  });
  console.log(`[generate-meeting-briefings] scanning ${tenants.length} active tenant(s)`);

  let total = 0;
  for (const tenant of tenants) {
    try {
      const n = await generateForTenant(tenant.id, now);
      total += n;
      if (n > 0)
        console.log(`[generate-meeting-briefings] ${tenant.slug}: created ${n} briefing(s)`);
    } catch (err) {
      console.error(
        `[generate-meeting-briefings] ${tenant.slug}: FAILED: ${(err as Error).message}`,
      );
    }
  }
  console.log(`[generate-meeting-briefings] done. Created ${total} briefing(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
