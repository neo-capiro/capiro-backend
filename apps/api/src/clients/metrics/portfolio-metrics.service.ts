import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * The portfolio pulse contract (`portfolio-recorded-baseline-v1`) the web
 * Overview reads from `GET clients/metrics`.
 *
 * Each group is either a complete recorded population or explicitly
 * unavailable. A group must never be reported as a number this service cannot
 * prove, and one unreadable group must not fail the whole read.
 */
export type PortfolioMetricCounts = {
  clients: { activeClients: number };
  objectives: { objectives: number; awaitingReview: number; ready: number };
  activity: {
    recordedActivities: number;
    overdueRequests: number;
    overdueCommitments: number;
  };
  billWatch: {
    activeClients: number;
    clientsWithWatches: number;
    clientBillWatches: number;
    distinctBills: number;
  };
};

type MetricGroup<K extends keyof PortfolioMetricCounts> =
  | {
      status: 'available';
      coverage: 'complete';
      counts: PortfolioMetricCounts[K];
    }
  | { status: 'unavailable' };

export type PortfolioMetricsResponse = {
  definition: 'portfolio-recorded-baseline-v1';
  tenantId: string;
  observedAt: string;
  activityWindow: { start: string; end: string; timezone: 'UTC' };
} & { [K in keyof PortfolioMetricCounts]: MetricGroup<K> };

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Objective states that exist in `client_objectives.status`. */
const AWAITING_REVIEW = new Set(['in_review']);
const READY = new Set(['ready']);

@Injectable()
export class PortfolioMetricsService {
  private readonly logger = new Logger(PortfolioMetricsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getMetrics(ctx: TenantContext): Promise<PortfolioMetricsResponse> {
    const end = new Date();
    const start = new Date(end.getTime() - WINDOW_MS);
    const groups = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      this.readGroups(tx, ctx.tenantId, start, end),
    );
    return {
      definition: 'portfolio-recorded-baseline-v1',
      tenantId: ctx.tenantId,
      observedAt: end.toISOString(),
      activityWindow: {
        start: start.toISOString(),
        end: end.toISOString(),
        timezone: 'UTC',
      },
      ...groups,
    };
  }

  private async readGroups(
    tx: Prisma.TransactionClient,
    tenantId: string,
    start: Date,
    end: Date,
  ): Promise<{
    clients: MetricGroup<'clients'>;
    objectives: MetricGroup<'objectives'>;
    activity: MetricGroup<'activity'>;
    billWatch: MetricGroup<'billWatch'>;
  }> {
    return {
      clients: await this.group('clients', () => this.clients(tx, tenantId)),
      objectives: await this.group('objectives', () =>
        this.objectives(tx, tenantId),
      ),
      activity: await this.group('activity', () =>
        this.activity(tx, tenantId, start, end),
      ),
      billWatch: await this.group('billWatch', () =>
        this.billWatch(tx, tenantId),
      ),
    };
  }

  private async group<K extends keyof PortfolioMetricCounts>(
    name: K,
    read: () => Promise<PortfolioMetricCounts[K]>,
  ): Promise<MetricGroup<K>> {
    try {
      return {
        status: 'available',
        coverage: 'complete',
        counts: await read(),
      };
    } catch (error) {
      this.logger.warn(
        `${name} metric unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { status: 'unavailable' };
    }
  }

  private async clients(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<PortfolioMetricCounts['clients']> {
    return {
      activeClients: await tx.client.count({
        where: { tenantId, status: 'active' },
      }),
    };
  }

  private async objectives(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<PortfolioMetricCounts['objectives']> {
    const rows = await tx.clientObjective.findMany({
      where: { tenantId, deletedAt: null },
      select: { status: true },
    });
    let awaitingReview = 0;
    let ready = 0;
    for (const row of rows) {
      if (AWAITING_REVIEW.has(row.status)) awaitingReview += 1;
      else if (READY.has(row.status)) ready += 1;
      // Any other saved state still counts in the total, never in a bucket it
      // cannot prove.
    }
    return { objectives: rows.length, awaitingReview, ready };
  }

  private async activity(
    tx: Prisma.TransactionClient,
    tenantId: string,
    start: Date,
    end: Date,
  ): Promise<PortfolioMetricCounts['activity']> {
    const [recordedActivities, overdueRequests, overdueCommitments] =
      await Promise.all([
        tx.clientActivity.count({
          where: { tenantId, occurredAt: { gte: start, lte: end } },
        }),
        tx.clientActivity.count({
          where: {
            tenantId,
            kind: 'request',
            settledAt: null,
            dueAt: { lt: end },
          },
        }),
        tx.clientActivity.count({
          where: {
            tenantId,
            kind: 'commitment',
            settledAt: null,
            dueAt: { lt: end },
          },
        }),
      ]);
    return { recordedActivities, overdueRequests, overdueCommitments };
  }

  /**
   * Saved bill watches are `tracked_bill` rows. Coverage counts active clients
   * only, so a watch left on an archived client cannot inflate the percentage
   * the pulse shows.
   */
  private async billWatch(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<PortfolioMetricCounts['billWatch']> {
    const active = await tx.client.findMany({
      where: { tenantId, status: 'active' },
      select: { id: true },
    });
    const activeIds = active.map((client) => client.id);
    const activeClients = activeIds.length;
    if (!activeClients)
      return {
        activeClients: 0,
        clientsWithWatches: 0,
        clientBillWatches: 0,
        distinctBills: 0,
      };
    const watches = await tx.trackedBill.findMany({
      where: { tenantId, clientId: { in: activeIds } },
      select: { clientId: true, billId: true },
    });
    return {
      activeClients,
      clientsWithWatches: new Set(watches.map((watch) => watch.clientId)).size,
      clientBillWatches: watches.length,
      distinctBills: new Set(watches.map((watch) => watch.billId)).size,
    };
  }
}
