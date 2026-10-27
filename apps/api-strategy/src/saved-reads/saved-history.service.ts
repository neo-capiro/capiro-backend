import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ClientObjectiveDestinationError, requireClientObjectiveAccess } from '@capiro/shared';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SAVED_READ_PAGE_SIZE, type SavedOwnerPage, type SavedReadRequest } from './saved-reads.js';

/** Owner-local saved state. No run/chat/artifact bodies or arbitrary activity JSON. */
@Injectable()
export class SavedHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async read(
    ctx: AuthTenantContext,
    request: SavedReadRequest,
    after?: string,
  ): Promise<SavedOwnerPage> {
    return this.prisma.withTenantUser(
      ctx.tenantId,
      ctx.clerkUserId,
      async (tx) => {
        if (request.kind === 'objective_versions') {
          const binding = { clientId: request.clientId, objectiveId: request.objectiveId! };
          try {
            await requireClientObjectiveAccess(tx, ctx, binding);
          } catch (error) {
            if (error instanceof ClientObjectiveDestinationError)
              throw new NotFoundException('Objective not found');
            throw error;
          }
          if (after) {
            const cursor = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM client_objective_revisions WHERE tenant_id=${ctx.tenantId}::uuid
              AND client_id=${request.clientId}::uuid AND objective_id=${request.objectiveId}::uuid AND id=${after}::uuid`;
            if (cursor.length !== 1)
              throw new BadRequestException('Unknown saved Objective cursor');
          }
          const rows = await tx.$queryRaw<Array<Record<string, unknown> & { id: string }>>`
          SELECT id,client_id AS "clientId",objective_id AS "objectiveId",version,operation,
            actor_user_id AS "actorUserId",snapshot,created_at AS "createdAt"
          FROM client_objective_revisions WHERE tenant_id=${ctx.tenantId}::uuid
            AND client_id=${request.clientId}::uuid AND objective_id=${request.objectiveId}::uuid
            AND (${after ?? null}::uuid IS NULL OR id>${after ?? null}::uuid)
          ORDER BY id ASC LIMIT 101`;
          return this.page(rows);
        }
        const strategy = await tx.spStrategy.findFirst({
          where: { tenantId: ctx.tenantId, id: request.strategyId!, clientId: request.clientId },
          select: { id: true },
        });
        if (!strategy) throw new NotFoundException('Strategy not found');
        if (request.kind === 'strategy_versions') {
          const where = { tenantId: ctx.tenantId, strategyId: strategy.id };
          if (
            after &&
            !(await tx.spVersion.findFirst({
              where: { ...where, id: after },
              select: { id: true },
            }))
          )
            throw new BadRequestException('Unknown saved Strategy cursor');
          return this.page(
            await tx.spVersion.findMany({
              where: { ...where, ...(after ? { id: { gt: after } } : {}) },
              orderBy: { id: 'asc' },
              take: 101,
              select: {
                id: true,
                strategyId: true,
                snapshot: true,
                authorKind: true,
                authorUserId: true,
                note: true,
                restoredFromVersionId: true,
                coalescible: true,
                createdAt: true,
              },
            }),
          );
        }
        if (request.kind !== 'strategy_activity')
          throw new BadRequestException('Invalid saved history kind');
        const where = { tenantId: ctx.tenantId, entityType: 'strategy', entityId: strategy.id };
        if (
          after &&
          !(await tx.spActivityLog.findFirst({
            where: { ...where, id: after },
            select: { id: true },
          }))
        )
          throw new BadRequestException('Unknown saved activity cursor');
        return this.page(
          await tx.spActivityLog.findMany({
            where: { ...where, ...(after ? { id: { gt: after } } : {}) },
            orderBy: { id: 'asc' },
            take: 101,
            select: {
              id: true,
              actorUserId: true,
              authorKind: true,
              action: true,
              entityType: true,
              entityId: true,
              occurredAt: true,
            },
          }),
        );
      },
      { timeoutMs: 10_000 },
    );
  }

  private page(rows: Array<Record<string, unknown> & { id: string }>): SavedOwnerPage {
    return {
      items: rows.slice(0, SAVED_READ_PAGE_SIZE),
      nextCursor: rows.length > SAVED_READ_PAGE_SIZE ? rows[SAVED_READ_PAGE_SIZE - 1]!.id : null,
    };
  }
}
