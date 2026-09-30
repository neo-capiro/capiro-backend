import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateResearchPortfolioSubscriptionDto,
  ResearchPortfolioChangeDto,
  ResearchPortfolioEventRecipientStateDto,
  ResearchPortfolioSubscriptionDto,
  ResearchPortfolioSubscriptionDeliveryDto,
  TenantContext,
  UpdateResearchPortfolioEventStateDto,
  UpdateResearchPortfolioSubscriptionDto,
} from '@capiro/shared';
import { clientMemoryAllowed, fetchDeniedClientIds } from '../memory/memory-wall.helpers.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { loadAuthorizedResearchPortfolio } from './research-portfolio-access.js';

const TARGET_KINDS = new Set([
  'portfolio',
  'program',
  'program_element',
  'project',
  'budget_line',
  'award',
  'client',
  'rule',
  'review',
]);
const CHANNELS = new Set(['in_app', 'email']);
const CADENCES = new Set(['immediate', 'daily', 'weekly']);

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);

export function containsExactIdentifier(value: unknown, identifier: string): boolean {
  if (value === identifier) return true;
  if (Array.isArray(value))
    return value.some((entry) => containsExactIdentifier(entry, identifier));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((entry) =>
      containsExactIdentifier(entry, identifier),
    );
  }
  return false;
}

@Injectable()
export class ResearchPortfolioChangesService {
  constructor(private readonly prisma: PrismaService) {}

  async listChanges(
    ctx: TenantContext,
    portfolioId: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ items: readonly ResearchPortfolioChangeDto[]; nextCursor: string | null }> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const portfolio = await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'viewer');
      const deniedClientIds = await this.deniedClientIds(tx, ctx);
      const visible: any[] = [];
      let scanCursor = cursor;
      let exhausted = false;
      while (visible.length < limit + 1 && !exhausted) {
        const rows = await tx.researchPortfolioEvent.findMany({
          where: { tenantId: ctx.tenantId, portfolioId },
          include: { recipientStates: { where: { recipientUserId: ctx.userId }, take: 1 } },
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          ...(scanCursor ? { cursor: { id: scanCursor }, skip: 1 } : {}),
          take: 100,
        });
        visible.push(
          ...rows.filter((row: any) => !this.referencesDeniedClient(row.payload, deniedClientIds)),
        );
        exhausted = rows.length < 100;
        scanCursor = rows.at(-1)?.id ?? scanCursor;
      }
      const page = visible.slice(0, limit);
      return {
        items: page.map((row: any) => ({
          id: row.id,
          eventKind: row.eventKind,
          aggregateRevision: row.aggregateRevision,
          actorUserId: row.actorUserId,
          occurredAt: row.occurredAt.toISOString(),
          payload: row.payload as Readonly<Record<string, unknown>>,
          state: row.recipientStates[0] ? this.stateDto(row.recipientStates[0]) : null,
        })),
        nextCursor: visible.length > limit ? (page.at(-1)?.id ?? null) : null,
      };
    });
  }

  async listDeliveries(
    ctx: TenantContext,
    portfolioId: string,
  ): Promise<readonly ResearchPortfolioSubscriptionDeliveryDto[]> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const portfolio = await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'viewer');
      if (
        !(await tx.tenantMembership.findFirst({
          where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' },
          select: { id: true },
        }))
      )
        return [];
      const deniedClientIds = await this.deniedClientIds(tx, ctx);
      const rows = await tx.researchPortfolioSubscriptionDelivery.findMany({
        where: { tenantId: ctx.tenantId, portfolioId, recipientUserId: ctx.userId },
        include: { event: { select: { payload: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 500,
      });
      return rows
        .filter((row: any) => !this.referencesDeniedClient(row.event?.payload, deniedClientIds))
        .slice(0, 100)
        .map((row: any) => this.deliveryDto(row));
    });
  }

  async updateEventState(
    ctx: TenantContext,
    portfolioId: string,
    eventId: string,
    input: UpdateResearchPortfolioEventStateDto,
  ): Promise<ResearchPortfolioEventRecipientStateDto> {
    if (!['seen', 'acknowledged', 'dismissed', 'undo'].includes(input.action)) {
      throw new BadRequestException('Unsupported event state action');
    }
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const portfolio = await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'viewer');
      const deniedClientIds = await this.deniedClientIds(tx, ctx);
      const event = await tx.researchPortfolioEvent.findFirst({
        where: { id: eventId, portfolioId },
      });
      if (!event || this.referencesDeniedClient(event.payload, deniedClientIds)) {
        throw new NotFoundException('Research portfolio event not found');
      }
      const existing = await tx.researchPortfolioEventRecipientState.findUnique({
        where: {
          tenantId_eventId_recipientUserId: {
            tenantId: ctx.tenantId,
            eventId,
            recipientUserId: ctx.userId,
          },
        },
      });
      if (
        input.expectedRevision !== undefined &&
        (existing?.revision ?? 0) !== input.expectedRevision
      ) {
        throw new ConflictException('Event state revision is stale');
      }
      const now = new Date();
      const data =
        input.action === 'undo'
          ? { seenAt: null, acknowledgedAt: null, dismissedAt: null }
          : input.action === 'seen'
            ? { seenAt: now }
            : input.action === 'acknowledged'
              ? { seenAt: existing?.seenAt ?? now, acknowledgedAt: now, dismissedAt: null }
              : { seenAt: existing?.seenAt ?? now, dismissedAt: now };
      const row = existing
        ? await tx.researchPortfolioEventRecipientState.update({
            where: { id: existing.id },
            data: { ...data, revision: { increment: 1 } },
          })
        : await tx.researchPortfolioEventRecipientState.create({
            data: {
              tenantId: ctx.tenantId,
              portfolioId,
              eventId,
              recipientUserId: ctx.userId,
              ...data,
            },
          });
      return this.stateDto(row);
    });
  }

  async listSubscriptions(
    ctx: TenantContext,
    portfolioId: string,
  ): Promise<readonly ResearchPortfolioSubscriptionDto[]> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const portfolio = await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'viewer');
      const deniedClientIds = await this.deniedClientIds(tx, ctx);
      const rows = await tx.researchPortfolioSubscription.findMany({
        where: { tenantId: ctx.tenantId, portfolioId, subscriberUserId: ctx.userId },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      });
      return rows
        .filter((row: any) => row.targetKind !== 'client' || !deniedClientIds.has(row.targetId))
        .map((row: any) => this.subscriptionDto(row));
    });
  }

  async createSubscription(
    ctx: TenantContext,
    portfolioId: string,
    input: CreateResearchPortfolioSubscriptionDto,
  ): Promise<ResearchPortfolioSubscriptionDto> {
    this.validateSubscription(input);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const portfolio = await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'viewer');
      await this.assertTarget(tx, ctx.tenantId, portfolioId, input.targetKind, input.targetId);
      if (
        input.targetKind === 'client' &&
        !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, input.targetId))
      ) {
        throw new NotFoundException('Subscription target not found');
      }
      const existing = await tx.researchPortfolioSubscription.findFirst({
        where: {
          tenantId: ctx.tenantId,
          portfolioId,
          subscriberUserId: ctx.userId,
          targetKind: input.targetKind,
          targetId: input.targetId,
          channel: input.channel,
          cadence: input.cadence,
        },
      });
      if (existing) {
        const restored = existing.active
          ? existing
          : await tx.researchPortfolioSubscription.update({
              where: { id: existing.id },
              data: { active: true },
            });
        return this.subscriptionDto(restored);
      }
      const baseline = await tx.researchPortfolioEvent.findFirst({
        where: { tenantId: ctx.tenantId, portfolioId },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        select: { id: true, aggregateRevision: true, occurredAt: true },
      });
      const completedAt = new Date();
      const row = await tx.researchPortfolioSubscription.create({
        data: {
          tenantId: ctx.tenantId,
          portfolioId,
          subscriberUserId: ctx.userId,
          targetKind: input.targetKind,
          targetId: input.targetId,
          channel: input.channel,
          cadence: input.cadence,
          baselineEventId: baseline?.id ?? null,
          baselineRevision: baseline?.aggregateRevision ?? portfolio.revision,
          baselineCompletedAt: completedAt,
          checkpoint: {
            quietFirstBaseline: true,
            observedThrough: baseline?.occurredAt?.toISOString() ?? completedAt.toISOString(),
          },
        },
      });
      return this.subscriptionDto(row);
    });
  }

  async updateSubscription(
    ctx: TenantContext,
    portfolioId: string,
    subscriptionId: string,
    input: UpdateResearchPortfolioSubscriptionDto,
  ): Promise<ResearchPortfolioSubscriptionDto> {
    if (input.channel && !CHANNELS.has(input.channel))
      throw new BadRequestException('Unsupported subscription channel');
    if (input.cadence && !CADENCES.has(input.cadence))
      throw new BadRequestException('Unsupported subscription cadence');
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const portfolio = await loadAuthorizedResearchPortfolio(tx, ctx, portfolioId, 'viewer');
      const deniedClientIds = await this.deniedClientIds(tx, ctx);
      const existing = await tx.researchPortfolioSubscription.findFirst({
        where: { id: subscriptionId, portfolioId, subscriberUserId: ctx.userId },
      });
      if (
        !existing ||
        (existing.targetKind === 'client' && deniedClientIds.has(existing.targetId))
      ) {
        throw new NotFoundException('Research portfolio subscription not found');
      }
      const row = await tx.researchPortfolioSubscription.update({
        where: { id: existing.id },
        data: {
          ...(input.active === undefined ? {} : { active: input.active }),
          ...(input.channel ? { channel: input.channel } : {}),
          ...(input.cadence ? { cadence: input.cadence } : {}),
        },
      });
      return this.subscriptionDto(row);
    });
  }

  private validateSubscription(input: CreateResearchPortfolioSubscriptionDto): void {
    if (!TARGET_KINDS.has(input.targetKind))
      throw new BadRequestException('Unsupported subscription target kind');
    if (!input.targetId?.trim()) throw new BadRequestException('Subscription targetId is required');
    if (!CHANNELS.has(input.channel))
      throw new BadRequestException('Unsupported subscription channel');
    if (!CADENCES.has(input.cadence))
      throw new BadRequestException('Unsupported subscription cadence');
  }

  private async deniedClientIds(tx: any, ctx: TenantContext): Promise<ReadonlySet<string>> {
    // Historical client references remain private even after their portfolio link is removed.
    return new Set(await fetchDeniedClientIds(tx, ctx.tenantId, ctx.userId));
  }

  private referencesDeniedClient(payload: unknown, deniedClientIds: ReadonlySet<string>): boolean {
    for (const clientId of deniedClientIds) {
      if (containsExactIdentifier(payload, clientId)) return true;
    }
    return false;
  }

  private async assertTarget(
    tx: any,
    tenantId: string,
    portfolioId: string,
    kind: string,
    id: string,
  ) {
    if (kind === 'portfolio') {
      if (id !== portfolioId)
        throw new BadRequestException(
          'Portfolio subscription target must be the current portfolio',
        );
      return;
    }
    const exists =
      kind === 'client'
        ? await tx.researchPortfolioClientLink.findFirst({
            where: { tenantId, portfolioId, clientId: id },
            select: { id: true },
          })
        : kind === 'rule'
          ? await tx.researchPortfolioRuleVersion.findFirst({
              where: { tenantId, portfolioId, id },
              select: { id: true },
            })
          : kind === 'review'
            ? await tx.researchPortfolioReview.findFirst({
                where: { tenantId, portfolioId, id },
                select: { id: true },
              })
            : await tx.researchPortfolioMember.findFirst({
                where: { tenantId, portfolioId, targetKind: kind, targetId: id },
                select: { id: true },
              });
    if (!exists) throw new NotFoundException('Subscription target not found');
  }

  private stateDto(row: any): ResearchPortfolioEventRecipientStateDto {
    return {
      eventId: row.eventId,
      recipientUserId: row.recipientUserId,
      revision: row.revision,
      seenAt: iso(row.seenAt),
      acknowledgedAt: iso(row.acknowledgedAt),
      dismissedAt: iso(row.dismissedAt),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private subscriptionDto(row: any): ResearchPortfolioSubscriptionDto {
    return {
      id: row.id,
      portfolioId: row.portfolioId,
      subscriberUserId: row.subscriberUserId,
      targetKind: row.targetKind,
      targetId: row.targetId,
      channel: row.channel,
      cadence: row.cadence,
      active: row.active,
      baselineEventId: row.baselineEventId,
      baselineRevision: row.baselineRevision,
      baselineCompletedAt: row.baselineCompletedAt.toISOString(),
      checkpoint: row.checkpoint as Readonly<Record<string, unknown>>,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    } as ResearchPortfolioSubscriptionDto;
  }

  private deliveryDto(row: any): ResearchPortfolioSubscriptionDeliveryDto {
    return {
      id: row.id,
      subscriptionId: row.subscriptionId,
      eventId: row.eventId,
      recipientUserId: row.recipientUserId,
      channel: row.channel,
      status: row.status,
      attemptNumber: row.attemptNumber,
      checkpoint: row.checkpoint as Readonly<Record<string, unknown>>,
      receipt: row.receipt as Readonly<Record<string, unknown>>,
      errorCode: row.errorCode,
      createdAt: row.createdAt.toISOString(),
      completedAt: iso(row.completedAt),
    };
  }
}
