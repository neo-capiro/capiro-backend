import type { PrismaService } from '../prisma/prisma.service.js';
import { BadRequestException } from '@nestjs/common';
import {
  ownMeetingWhere,
  clientAssociatedMeetingWhere,
} from '../engagement/engagement-access.helpers.js';
import { startOfQuarter } from './intelligence-portfolio-quarters.js';

export class IntelligencePortfolioSummary {
  constructor(private readonly prisma: PrismaService) {}

  async getPortfolioSummary(
    tenantId: string,
    userId: string,
    window?: { from?: string; to?: string },
  ) {
    const now = new Date();
    const quarterStart = startOfQuarter(now);

    // G1: meetings this week — same weekBounds logic the frontend used.
    const day = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() + (day === 0 ? -6 : 1 - day));
    monday.setHours(0, 0, 0, 0);
    const nextMonday = new Date(monday);
    nextMonday.setDate(monday.getDate() + 7);
    const from = window?.from ? new Date(window.from) : monday;
    const to = window?.to ? new Date(window.to) : nextMonday;
    if (
      !Number.isFinite(from.getTime()) ||
      !Number.isFinite(to.getTime()) ||
      to <= from ||
      to.getTime() - from.getTime() > 8 * 86400_000
    ) {
      throw new BadRequestException('A valid week window is required');
    }

    const [tenantScoped, regulationsTracked] = await this.readSummarySnapshot(
      tenantId,
      userId,
      from,
      to,
      now,
    );

    const { clients, mappings, meetingsThisWeek, billsTracked, activeStrategies } = tenantScoped;

    const tenantClientIds = new Set(clients.map((c) => c.id));
    const tenantLdaIds = mappings
      .filter((m) => tenantClientIds.has(m.clientId))
      .map((m) => Number(m.externalId))
      .filter((n) => Number.isFinite(n));

    const needAttention = clients.filter(
      (c) => c.profileStatus === 'PAUSED' || c.profileStatus === 'MONITORING',
    ).length;

    // LDA filings are a shared catalog keyed by LDA client id (not tenant RLS).
    const ldaSpendRows = tenantLdaIds.length
      ? await this.prisma.$queryRaw<Array<{ total: string | null }>>`
          SELECT COALESCE(SUM(income), 0)::text AS total
          FROM lda_filing
          WHERE client_id = ANY(${tenantLdaIds}::int[])
            AND dt_posted >= ${quarterStart}
        `
      : [{ total: '0' }];

    // LDA `income` is stored as Decimal dollars (not cents).
    const ldaSpendDollars = Number(ldaSpendRows[0]?.total ?? '0');

    return {
      activeClients: clients.length,
      needAttention,
      ldaSpendQtd: ldaSpendDollars,
      billsTracked,
      activeRegulations: regulationsTracked,
      meetingsThisWeek,
      activeStrategies: Number(activeStrategies[0]?.count ?? 0n),
    };
  }

  private readSummarySnapshot(tenantId: string, userId: string, from: Date, to: Date, now: Date) {
    return Promise.all([
      this.prisma.withTenant(tenantId, async (tx) => {
        const clients = await tx.client.findMany({
          where: { tenantId, status: { not: 'archived' } },
          select: {
            id: true,
            profileStatus: true,
            primaryContactEmail: true,
            people: { where: { tenantId }, select: { email: true } },
          },
        });
        const clientAssociations = clientAssociatedMeetingWhere(
          clients.map((client) => client.id),
          clients
            .flatMap((client) => [
              client.primaryContactEmail,
              ...client.people.map((person) => person.email),
            ])
            .filter((email): email is string => Boolean(email)),
        );
        const [mappings, meetingsThisWeek, billsTracked, activeStrategies] = await Promise.all([
          tx.clientIntelMapping.findMany({
            where: { confirmed: true, source: 'lda' },
            select: { clientId: true, externalId: true },
          }),
          tx.meeting.count({
            where: {
              tenantId,
              ...ownMeetingWhere(userId),
              startsAt: { gte: from, lt: to },
              AND: [clientAssociations],
              isInternal: false,
              status: { notIn: ['cancelled', 'canceled', 'deleted'] },
            },
          }),
          // Match Clients → Intelligence column (rollup uses trackedBill.groupBy).
          tx.trackedBill.count(),
          // sp_strategy is owned by api-strategy but lives in the same DB and
          // FORCE-RLS on tenant_id. Must use the tenant-scoped tx client.
          tx.$queryRaw<Array<{ count: bigint }>>`
              SELECT COUNT(*)::bigint AS count
              FROM sp_strategy
              WHERE tenant_id = ${tenantId}::uuid
                AND archived_at IS NULL
            `.catch(() => [{ count: 0n }]),
        ]);
        return { clients, mappings, meetingsThisWeek, billsTracked, activeStrategies };
      }),
      // Global FR catalog (not tenant-RLS); open proposed/final rules with a comment window.
      this.prisma.federalRegisterDocument.count({
        where: {
          type: { in: ['PROPOSED_RULE', 'RULE'] },
          commentEndDate: { gt: now },
        },
      }),
    ]);
  }
}
