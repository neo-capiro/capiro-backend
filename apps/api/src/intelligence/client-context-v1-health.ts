import type { PrismaService } from '../prisma/prisma.service.js';
import { EngagementTaskStatus } from '@prisma/client';

export class ClientContextV1Health {
  constructor(private readonly prisma: PrismaService) {}

  async computeEngagementHealth(clientId: string, tenantId: string) {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    const [
      meetings,
      emails,
      tasksCompleted,
      debriefs,
      outreachSent,
      priorMeetings,
      priorEmails,
      priorTasks,
      priorDebriefs,
      priorOutreach,
    ] = await this.readEngagementCounts(clientId, tenantId, sevenDaysAgo, fourteenDaysAgo);

    const expectedWeeklyPace = 100;
    const score = Math.min(
      100,
      Math.round(
        ((meetings * 15 + emails * 2 + tasksCompleted * 10 + debriefs * 20 + outreachSent * 5) /
          expectedWeeklyPace) *
          100,
      ),
    );
    const priorScore = Math.min(
      100,
      Math.round(
        ((priorMeetings * 15 +
          priorEmails * 2 +
          priorTasks * 10 +
          priorDebriefs * 20 +
          priorOutreach * 5) /
          expectedWeeklyPace) *
          100,
      ),
    );

    const trend: 'improving' | 'stable' | 'declining' =
      score > priorScore + 5 ? 'improving' : score < priorScore - 5 ? 'declining' : 'stable';

    return {
      score,
      breakdown: { meetings, emails, tasksCompleted, debriefs, outreachSent },
      trend,
      period: '7d',
    };
  }

  private readEngagementCounts(
    clientId: string,
    tenantId: string,
    sevenDaysAgo: Date,
    fourteenDaysAgo: Date,
  ) {
    const meetingWhere: Record<string, unknown> = { clientId, startsAt: { gte: sevenDaysAgo } };

    const mailWhere: Record<string, unknown> = { clientId, lastMessageAt: { gte: sevenDaysAgo } };

    const taskWhere: Record<string, unknown> = {
      clientId,
      status: EngagementTaskStatus.done,
      updatedAt: { gte: sevenDaysAgo },
    };

    const debriefWhere: Record<string, unknown> = { clientId, createdAt: { gte: sevenDaysAgo } };

    const outreachWhere: Record<string, unknown> = { clientId, sentAt: { gte: sevenDaysAgo } };

    const priorMeetingWhere: Record<string, unknown> = {
      clientId,
      startsAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo },
    };

    const priorMailWhere: Record<string, unknown> = {
      clientId,
      lastMessageAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo },
    };

    const priorTaskWhere: Record<string, unknown> = {
      clientId,
      status: EngagementTaskStatus.done,
      updatedAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo },
    };

    const priorDebriefWhere: Record<string, unknown> = {
      clientId,
      createdAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo },
    };

    const priorOutreachWhere: Record<string, unknown> = {
      clientId,
      sentAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo },
    };

    return Promise.all([
      this.prisma.withTenant(tenantId, (tx) => tx.meeting.count({ where: meetingWhere })),
      this.prisma.withTenant(tenantId, (tx) => tx.mailThread.count({ where: mailWhere })),
      this.prisma.withTenant(tenantId, (tx) => tx.engagementTask.count({ where: taskWhere })),
      this.prisma.withTenant(tenantId, (tx) => tx.meetingDebrief.count({ where: debriefWhere })),
      this.prisma.withTenant(tenantId, (tx) => tx.outreachRecord.count({ where: outreachWhere })),
      this.prisma.withTenant(tenantId, (tx) => tx.meeting.count({ where: priorMeetingWhere })),
      this.prisma.withTenant(tenantId, (tx) => tx.mailThread.count({ where: priorMailWhere })),
      this.prisma.withTenant(tenantId, (tx) => tx.engagementTask.count({ where: priorTaskWhere })),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.meetingDebrief.count({ where: priorDebriefWhere }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.outreachRecord.count({ where: priorOutreachWhere }),
      ),
    ]);
  }
}
