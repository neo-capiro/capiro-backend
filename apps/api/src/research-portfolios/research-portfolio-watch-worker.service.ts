import {
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { fetchDeniedClientIds, clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import { loadAuthorizedResearchPortfolio } from './research-portfolio-access.js';
import { containsExactIdentifier } from './research-portfolio-changes.service.js';

type Tx = Prisma.TransactionClient;
type Identity = { id: string; tenantId: string; portfolioId: string; subscriberUserId: string };
type DeliveryState = {
  version: 1;
  cursorRevision: number;
  cursorEventId: string | null;
  nextDueAt: string;
  claimedAt?: string;
  lastCompletedAt?: string;
  lastErrorCode?: string;
  blockedDeliveryIds?: string[];
};
type Claim = {
  identity: Identity;
  fence: number;
  checkpoint: Record<string, unknown>;
  state: DeliveryState;
};
const LIMIT = 100,
  LEASE_MS = 60_000;
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function interval(cadence: string): number | null {
  return cadence === 'immediate'
    ? 0
    : cadence === 'daily'
      ? 86_400_000
      : cadence === 'weekly'
        ? 604_800_000
        : null;
}

/** Sole owner of RP subscription lease/checkpoint and append-only delivery writes. No external transports. */
@Injectable()
export class ResearchPortfolioWatchWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ResearchPortfolioWatchWorkerService.name);
  private readonly owner = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private tenantCursor: string | null = null;
  private readonly subscriptionCursors = new Map<string, string>();
  constructor(private readonly prisma: PrismaService) {}
  onModuleInit(): void {
    if (process.env.RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED !== 'true') return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) =>
        this.logger.warn(
          `RP watch tick failed: ${error instanceof Error ? error.name : 'unknown'}`,
        ),
      );
    }, 60_000);
    this.timer.unref();
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = new Date()): Promise<void> {
    if (process.env.RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED !== 'true' || this.busy) return;
    this.busy = true;
    try {
      // Global discovery reads tenant identities only. Every subscription/event read below has an explicit tenant.
      const tenants = await this.prisma.tenant.findMany({
        where: {
          status: 'active',
          ...(this.tenantCursor ? { id: { gt: this.tenantCursor } } : {}),
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: LIMIT,
      });
      for (const tenant of tenants) {
        try {
          const result = await this.runTenant(tenant.id, now);
          if (result.unknown || result.blocked)
            this.logger.warn(
              `RP watch batch has ${result.unknown} unknown and ${result.blocked} blocked outcomes`,
            );
        } catch {
          this.logger.warn('RP watch tenant batch failed; fenced leases remain recoverable');
        }
      }
      this.tenantCursor = tenants.length === LIMIT ? (tenants.at(-1)?.id ?? null) : null;
    } finally {
      this.busy = false;
    }
  }

  async runTenant(
    tenantId: string,
    now = new Date(),
  ): Promise<{
    inspected: number;
    completed: number;
    withheld: number;
    unknown: number;
    blocked: number;
  }> {
    const summary = { inspected: 0, completed: 0, withheld: 0, unknown: 0, blocked: 0 };
    if (process.env.RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED !== 'true') return summary;
    if (
      !(await this.prisma.tenant.findFirst({
        where: { id: tenantId, status: 'active' },
        select: { id: true },
      }))
    )
      return summary;
    const cursor = this.subscriptionCursors.get(tenantId);
    // Discovery intentionally excludes target/checkpoint/payload, including under the tenant-scoped transaction.
    const identities = await this.prisma.withTenant(tenantId, (tx) =>
      tx.researchPortfolioSubscription.findMany({
        where: { tenantId, active: true, ...(cursor ? { id: { gt: cursor } } : {}) },
        select: { id: true, tenantId: true, portfolioId: true, subscriberUserId: true },
        orderBy: { id: 'asc' },
        take: LIMIT,
      }),
    );
    const batchWallStart = Date.now();
    const currentTime = () => new Date(now.getTime() + Date.now() - batchWallStart);
    for (const identity of identities) {
      summary.inspected++;
      try {
        const claim = await this.claim(identity, currentTime());
        if (claim === 'withheld') {
          summary.withheld++;
          continue;
        }
        if (!claim) continue;
        const outcome = await this.processClaim(claim, currentTime());
        if (outcome === 'withheld') summary.withheld++;
        else if (outcome === 'blocked') summary.blocked++;
        else summary.completed++;
      } catch {
        summary.unknown++;
      }
    }
    if (identities.length === LIMIT) {
      const last = identities.at(-1);
      if (last) this.subscriptionCursors.set(tenantId, last.id);
    } else this.subscriptionCursors.delete(tenantId);
    return summary;
  }

  private context(identity: Identity): TenantContext {
    return {
      tenantId: identity.tenantId,
      tenantSlug: 'research-portfolio-watch-worker',
      userId: identity.subscriberUserId,
      clerkUserId: 'internal-recipient-worker',
      role: 'standard_user',
    };
  }
  private async authorized(tx: Tx, identity: Identity, lock: boolean): Promise<boolean> {
    if (lock) {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "research_portfolios" WHERE "tenant_id" = ${identity.tenantId}::uuid AND "id" = ${identity.portfolioId}::uuid FOR SHARE`,
      );
      const members = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT "id" FROM "tenant_memberships" WHERE "tenant_id" = ${identity.tenantId}::uuid AND "user_id" = ${identity.subscriberUserId}::uuid AND "status" = 'active' FOR SHARE`,
      );
      if (!members.length) return false;
    } else if (
      !(await tx.tenantMembership.findFirst({
        where: { tenantId: identity.tenantId, userId: identity.subscriberUserId, status: 'active' },
        select: { id: true },
      }))
    )
      return false;
    try {
      const portfolio = await loadAuthorizedResearchPortfolio(
        tx,
        this.context(identity),
        identity.portfolioId,
        'viewer',
      );
      return portfolio.lifecycle === 'active';
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException) return false;
      throw error;
    }
  }
  private state(row: any, now: Date): DeliveryState | null {
    const ms = interval(row.cadence);
    if (ms === null) throw new Error('Unsupported RP watch cadence');
    const previous = object(object(row.checkpoint).watchDelivery);
    const valid =
      previous.version === 1 &&
      Number.isSafeInteger(previous.cursorRevision) &&
      typeof previous.cursorRevision === 'number' &&
      previous.cursorRevision >= row.baselineRevision &&
      (previous.cursorEventId === null || typeof previous.cursorEventId === 'string') &&
      typeof previous.nextDueAt === 'string' &&
      Number.isFinite(Date.parse(previous.nextDueAt));
    if (Object.keys(previous).length && !valid)
      throw new Error('Unsupported or invalid durable RP watch checkpoint');
    const state: DeliveryState = valid
      ? (previous as unknown as DeliveryState)
      : {
          version: 1,
          cursorRevision: row.baselineRevision,
          cursorEventId: null,
          nextDueAt: new Date(row.baselineCompletedAt.getTime() + ms).toISOString(),
        };
    return Date.parse(state.nextDueAt) <= now.getTime() ? state : null;
  }
  private async claim(identity: Identity, now: Date): Promise<Claim | 'withheld' | null> {
    return this.prisma.withTenantUser(identity.tenantId, identity.subscriberUserId, async (tx) => {
      if (!(await this.authorized(tx, identity, false))) return 'withheld';
      const row = await tx.researchPortfolioSubscription.findFirst({
        where: {
          id: identity.id,
          tenantId: identity.tenantId,
          portfolioId: identity.portfolioId,
          subscriberUserId: identity.subscriberUserId,
          active: true,
        },
      });
      if (!row || (row.leaseUntil && row.leaseUntil > now)) return null;
      const state = this.state(row, now);
      if (!state) return null;
      const checkpoint = {
        ...object(row.checkpoint),
        watchDelivery: { ...state, claimedAt: now.toISOString() },
      };
      const claimed = await tx.researchPortfolioSubscription.updateMany({
        where: {
          id: row.id,
          tenantId: identity.tenantId,
          subscriberUserId: identity.subscriberUserId,
          active: true,
          leaseFence: row.leaseFence,
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
        },
        data: {
          leaseOwner: this.owner,
          leaseUntil: new Date(now.getTime() + LEASE_MS),
          leaseFence: { increment: 1 },
          checkpoint: checkpoint as Prisma.InputJsonObject,
        },
      });
      return claimed.count === 1
        ? { identity, fence: row.leaseFence + 1, checkpoint, state }
        : null;
    });
  }

  private async processClaim(
    claim: Claim,
    now: Date,
  ): Promise<'completed' | 'withheld' | 'blocked'> {
    const { identity, fence } = claim;
    const wallStart = Date.now(),
      currentTime = () => new Date(now.getTime() + Date.now() - wallStart);
    try {
      if (process.env.RESEARCH_PORTFOLIO_WATCH_DELIVERY_ENABLED !== 'true') {
        await this.prisma.withTenantUser(identity.tenantId, identity.subscriberUserId, (tx) =>
          tx.researchPortfolioSubscription.updateMany({
            where: {
              id: identity.id,
              tenantId: identity.tenantId,
              leaseOwner: this.owner,
              leaseFence: fence,
            },
            data: { leaseOwner: null, leaseUntil: null },
          }),
        );
        return 'withheld';
      }
      return await this.prisma.withTenantUser(
        identity.tenantId,
        identity.subscriberUserId,
        async (tx) => {
          if (!(await this.authorized(tx, identity, true))) {
            await tx.researchPortfolioSubscription.updateMany({
              where: {
                id: identity.id,
                tenantId: identity.tenantId,
                leaseOwner: this.owner,
                leaseFence: fence,
              },
              data: { leaseOwner: null, leaseUntil: null },
            });
            return 'withheld';
          }
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "research_portfolio_subscriptions" WHERE "tenant_id" = ${identity.tenantId}::uuid AND "id" = ${identity.id}::uuid FOR UPDATE`,
          );
          const row = await tx.researchPortfolioSubscription.findFirst({
            where: {
              id: identity.id,
              tenantId: identity.tenantId,
              subscriberUserId: identity.subscriberUserId,
              active: true,
              leaseOwner: this.owner,
              leaseFence: fence,
              leaseUntil: { gt: now },
            },
          });
          if (!row) throw new Error('RP watch lease fence lost');
          const denied = new Set(
            await fetchDeniedClientIds(tx, identity.tenantId, identity.subscriberUserId),
          );
          if (
            row.targetKind === 'client' &&
            !(await clientMemoryAllowed(
              tx,
              identity.tenantId,
              identity.subscriberUserId,
              row.targetId,
            ))
          ) {
            await this.finish(
              tx,
              claim,
              {
                ...claim.state,
                nextDueAt: new Date(now.getTime() + LEASE_MS).toISOString(),
                lastErrorCode: 'client_access_withheld',
              },
              currentTime(),
            );
            return 'withheld';
          }
          const state = claim.state;
          const events = await tx.researchPortfolioEvent.findMany({
            where: {
              tenantId: identity.tenantId,
              portfolioId: identity.portfolioId,
              occurredAt: { lte: now },
              OR: [
                { aggregateRevision: { gt: state.cursorRevision } },
                ...(state.cursorEventId
                  ? [{ aggregateRevision: state.cursorRevision, id: { gt: state.cursorEventId } }]
                  : []),
              ],
            },
            orderBy: [{ aggregateRevision: 'asc' }, { id: 'asc' }],
            take: LIMIT + 1,
          });
          const batch = events.slice(0, LIMIT);
          const existing = await tx.researchPortfolioSubscriptionDelivery.findMany({
            where: {
              tenantId: identity.tenantId,
              subscriptionId: identity.id,
              recipientUserId: identity.subscriberUserId,
              channel: row.channel,
              eventId: { in: batch.map((event) => event.id) },
            },
            select: { id: true, eventId: true, status: true },
          });
          const unresolved = existing.filter(
            (receipt) => receipt.status === 'queued' || receipt.status === 'outcome_unknown',
          );
          if (unresolved.length) {
            await this.finish(
              tx,
              claim,
              {
                ...state,
                nextDueAt: new Date(now.getTime() + LEASE_MS).toISOString(),
                lastErrorCode: 'immutable_delivery_needs_reconciliation',
                blockedDeliveryIds: unresolved.map((receipt) => receipt.id),
              },
              currentTime(),
            );
            return 'blocked';
          }
          const deliveries: Prisma.ResearchPortfolioSubscriptionDeliveryCreateManyInput[] = [];
          for (const event of batch) {
            if (
              !(row.targetKind === 'portfolio'
                ? row.targetId === identity.portfolioId
                : containsExactIdentifier(event.payload, row.targetId))
            )
              continue;
            const withheld = [...denied].some((clientId) =>
              containsExactIdentifier(event.payload, clientId),
            );
            deliveries.push({
              tenantId: identity.tenantId,
              portfolioId: identity.portfolioId,
              subscriptionId: identity.id,
              eventId: event.id,
              recipientUserId: identity.subscriberUserId,
              channel: row.channel,
              status: withheld ? 'withheld' : row.channel === 'in_app' ? 'delivered' : 'partial',
              checkpoint: {
                leaseFence: fence,
                baselineRevision: row.baselineRevision,
                aggregateRevision: event.aggregateRevision,
                cadence: row.cadence,
                dueAt: state.nextDueAt,
                quietFirstBaseline: true,
                accessRecheckedAt: now.toISOString(),
              },
              receipt: withheld
                ? { withheld: true, reason: 'client_access_revoked' }
                : row.channel === 'in_app'
                  ? {
                      surface: 'research_portfolio_change_feed',
                      eventId: event.id,
                      cadence: row.cadence,
                    }
                  : {
                      configured: false,
                      reason: 'Email delivery is not configured for Research Portfolios',
                    },
              errorCode: withheld
                ? 'client_access_revoked'
                : row.channel === 'email'
                  ? 'email_delivery_not_configured'
                  : null,
              completedAt: now,
            });
          }
          if (deliveries.length)
            await tx.researchPortfolioSubscriptionDelivery.createMany({
              data: deliveries,
              skipDuplicates: true,
            });
          const last = batch.at(-1),
            ms = interval(row.cadence) ?? LEASE_MS;
          await this.finish(
            tx,
            claim,
            {
              version: 1,
              cursorRevision: last?.aggregateRevision ?? state.cursorRevision,
              cursorEventId: last?.id ?? state.cursorEventId,
              nextDueAt: new Date(
                events.length > LIMIT ? now.getTime() : now.getTime() + ms,
              ).toISOString(),
              lastCompletedAt: now.toISOString(),
            },
            currentTime(),
          );
          return 'completed';
        },
      );
    } catch (error) {
      // Receipt inserts and cursor advancement rolled back together; retain the durable prior cursor for recovery.
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String(error.code).slice(0, 64)
          : 'unknown_processing_failure';
      await this.prisma.withTenantUser(identity.tenantId, identity.subscriberUserId, (tx) =>
        tx.researchPortfolioSubscription.updateMany({
          where: {
            id: identity.id,
            tenantId: identity.tenantId,
            leaseOwner: this.owner,
            leaseFence: fence,
          },
          data: {
            leaseOwner: null,
            leaseUntil: new Date(now.getTime() + LEASE_MS),
            checkpoint: {
              ...claim.checkpoint,
              watchDelivery: { ...claim.state, lastErrorCode: code },
            } as unknown as Prisma.InputJsonObject,
          },
        }),
      );
      throw error;
    }
  }
  private async finish(tx: Tx, claim: Claim, state: DeliveryState, now: Date): Promise<void> {
    const result = await tx.researchPortfolioSubscription.updateMany({
      where: {
        id: claim.identity.id,
        tenantId: claim.identity.tenantId,
        subscriberUserId: claim.identity.subscriberUserId,
        active: true,
        leaseOwner: this.owner,
        leaseFence: claim.fence,
        leaseUntil: { gt: now },
      },
      data: {
        leaseOwner: null,
        leaseUntil: null,
        checkpoint: {
          ...claim.checkpoint,
          watchDelivery: state,
        } as unknown as Prisma.InputJsonObject,
      },
    });
    if (result.count !== 1) throw new Error('RP watch completion fence lost');
  }
}
