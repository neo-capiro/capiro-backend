import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';

export type BudgetWatchTargetType = 'program' | 'pe' | 'project' | 'capability';
type Decision = 'acknowledged' | 'dismissed';

function requiredText(value: string, name: string, max: number): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > max) throw new BadRequestException(`${name} must be 1–${max} characters`);
  return trimmed;
}

/** A private, client-scoped ledger. No delivery, source fetching, or scheduler is started here. */
@Injectable()
export class DefenseBudgetClientWatchService {
  constructor(private readonly prisma: PrismaService) {}

  async subscribe(ctx: TenantContext, input: {
    clientId: string; targetType: BudgetWatchTargetType; targetKey: string; clientReason: string;
  }) {
    if (!(['program', 'pe', 'project', 'capability'] as string[]).includes(input.targetType)) {
      throw new BadRequestException('Unsupported watch target');
    }
    const targetKey = requiredText(input.targetKey, 'Target key', 160);
    const clientReason = requiredText(input.clientReason, 'Client reason', 2000);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertClient(tx, ctx.tenantId, input.clientId);
      const watch = await tx.defenseBudgetClientWatch.create({ data: {
        tenantId: ctx.tenantId, clientId: input.clientId, targetType: input.targetType,
        targetKey, clientReason, createdByUserId: ctx.userId,
      } });
      await tx.defenseBudgetClientWatchEvent.create({ data: {
        tenantId: ctx.tenantId, clientId: input.clientId, watchId: watch.id,
        eventType: 'subscribed', logicalEventKey: 'subscribed:initial', actorUserId: ctx.userId,
      } });
      return watch;
    });
  }

  async list(ctx: TenantContext, clientId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertClient(tx, ctx.tenantId, clientId);
      return tx.defenseBudgetClientWatch.findMany({
        where: { tenantId: ctx.tenantId, clientId },
        include: { events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
    });
  }

  async setSubscribed(ctx: TenantContext, input: { clientId: string; watchId: string; subscribed: boolean }) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertWatch(tx, ctx.tenantId, input.clientId, input.watchId);
      const latest = await tx.defenseBudgetClientWatchEvent.findFirst({
        where: { tenantId: ctx.tenantId, clientId: input.clientId, watchId: input.watchId,
          eventType: { in: ['subscribed', 'unsubscribed', 'resubscribed'] } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const active = latest?.eventType !== 'unsubscribed';
      if (active === input.subscribed) return latest;
      return tx.defenseBudgetClientWatchEvent.create({ data: {
        tenantId: ctx.tenantId, clientId: input.clientId, watchId: input.watchId,
        eventType: input.subscribed ? 'resubscribed' : 'unsubscribed',
        logicalEventKey: `subscription:${randomUUID()}`, actorUserId: ctx.userId,
      } });
    });
  }

  /** Called only after the caller has certified a material source change. */
  async recordMaterialUpdate(ctx: TenantContext, input: {
    clientId: string; watchId: string; logicalEventKey: string; materialReason: string;
    evidence?: Prisma.InputJsonValue;
  }) {
    const logicalEventKey = requiredText(input.logicalEventKey, 'Logical event key', 200);
    const materialReason = requiredText(input.materialReason, 'Material reason', 2000);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertWatch(tx, ctx.tenantId, input.clientId, input.watchId);
      const prior = await tx.defenseBudgetClientWatchEvent.findFirst({
        where: { tenantId: ctx.tenantId, clientId: input.clientId, watchId: input.watchId, logicalEventKey },
      });
      if (prior) {
        if (prior.eventType !== 'material_update') throw new ConflictException('Logical event key already used');
        return prior;
      }
      return tx.defenseBudgetClientWatchEvent.create({ data: {
        tenantId: ctx.tenantId, clientId: input.clientId, watchId: input.watchId,
        eventType: 'material_update', logicalEventKey, materialReason,
        ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
      } });
    });
  }

  async decide(ctx: TenantContext, input: {
    clientId: string; watchId: string; updateEventId: string; decision: Decision;
  }) {
    if (input.decision !== 'acknowledged' && input.decision !== 'dismissed') {
      throw new BadRequestException('Unsupported decision');
    }
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertWatch(tx, ctx.tenantId, input.clientId, input.watchId);
      const update = await tx.defenseBudgetClientWatchEvent.findFirst({ where: {
        id: input.updateEventId, tenantId: ctx.tenantId, clientId: input.clientId,
        watchId: input.watchId, eventType: 'material_update',
      } });
      if (!update) throw new NotFoundException('Watch update not found');
      const prior = await tx.defenseBudgetClientWatchEvent.findFirst({ where: {
        tenantId: ctx.tenantId, clientId: input.clientId, watchId: input.watchId,
        updateEventId: update.id, eventType: { in: ['acknowledged', 'dismissed'] },
      } });
      if (prior) {
        if (prior.eventType !== input.decision) throw new ConflictException('Watch update already decided');
        return prior;
      }
      return tx.defenseBudgetClientWatchEvent.create({ data: {
        tenantId: ctx.tenantId, clientId: input.clientId, watchId: input.watchId,
        updateEventId: update.id, eventType: input.decision,
        logicalEventKey: `${input.decision}:${update.id}`, actorUserId: ctx.userId,
      } });
    });
  }

  private async assertClient(tx: Prisma.TransactionClient, tenantId: string, clientId: string) {
    const client = await tx.client.findFirst({ where: { id: clientId, tenantId }, select: { id: true } });
    if (!client) throw new NotFoundException('Client not found');
  }

  private async assertWatch(tx: Prisma.TransactionClient, tenantId: string, clientId: string, watchId: string) {
    await this.assertClient(tx, tenantId, clientId);
    const watch = await tx.defenseBudgetClientWatch.findFirst({
      where: { id: watchId, tenantId, clientId }, select: { id: true },
    });
    if (!watch) throw new NotFoundException('Watch not found');
  }
}
