import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreateStrategyDto, StrategyTypeValue } from './dto/create-strategy.dto.js';

/**
 * Strategy read + manual-create (G2). All access goes through withTenant /
 * withTenantUser (the query hook injects where.tenantId). Node CRUD, versions,
 * and the Meri assistant arrive in G3/G5.
 */
@Injectable()
export class StrategyService {
  constructor(private readonly prisma: PrismaService) {}

  /** Library list projection: active (non-archived) strategies, newest-edited first. */
  async list(tenantId: string) {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.spStrategy.findMany({
        where: { archivedAt: null },
        orderBy: [{ lastEditedAt: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          clientId: true,
          title: true,
          type: true,
          ownerUserId: true,
          createdByUserId: true,
          lastEditedByUserId: true,
          lastEditedAt: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { nodes: true } },
        },
      }),
    );
    return rows.map((r) => ({
      id: r.id,
      clientId: r.clientId,
      title: r.title,
      type: r.type,
      ownerUserId: r.ownerUserId,
      createdByUserId: r.createdByUserId,
      lastEditedByUserId: r.lastEditedByUserId,
      lastEditedAt: r.lastEditedAt,
      createdAt: r.createdAt,
      nodeCount: r._count.nodes,
    }));
  }

  /** Editor payload: strategy meta + its nodes + artifact back-links. */
  async byId(tenantId: string, id: string) {
    const strategy = await this.prisma.withTenant(tenantId, (tx) =>
      tx.spStrategy.findFirst({
        where: { id },
        include: {
          nodes: { orderBy: { startsOn: 'asc' } },
          artifacts: true,
        },
      }),
    );
    if (!strategy) {
      throw new NotFoundException('Strategy not found');
    }
    return strategy;
  }

  /** Manual create: empty strategy + an attributed activity-log row, in one tx. */
  async create(tenantId: string, clerkUserId: string, dto: CreateStrategyDto) {
    const owner = dto.ownerUserId?.trim() || clerkUserId;
    const title = deriveTitle(dto);
    const targetDate = parseTargetDate(dto.targetDate);

    return this.prisma.withTenantUser(tenantId, clerkUserId, async (tx) => {
      const strategy = await tx.spStrategy.create({
        data: {
          tenantId,
          clientId: dto.clientId,
          title,
          type: dto.type,
          goal: dto.goal?.trim() || null,
          meriContext: dto.meriContext?.trim() || null,
          targetDate,
          ownerUserId: owner,
          createdByUserId: clerkUserId,
          lastEditedByUserId: clerkUserId,
          lastEditedAt: new Date(),
        },
        include: { nodes: true, artifacts: true },
      });
      await tx.spActivityLog.create({
        data: {
          tenantId,
          actorUserId: clerkUserId,
          authorKind: 'person',
          action: 'strategy.created',
          entityType: 'strategy',
          entityId: strategy.id,
          after: { title: strategy.title, type: strategy.type, clientId: strategy.clientId },
        },
      });
      return strategy;
    });
  }
}

/**
 * Parse the optional YYYY-MM-DD deadline into a Date for the @db.Date column.
 * The DTO regex guarantees the shape, but calendar-impossible values that still
 * match the pattern (e.g. 2027-02-30) parse to an Invalid Date — reject those
 * rather than letting a NaN Date reach Prisma.
 */
function parseTargetDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException('targetDate is not a valid calendar date');
  }
  return d;
}

/** Manual create has no title field; derive one from the goal, else a default. */
function deriveTitle(dto: CreateStrategyDto): string {
  const explicit = dto.title?.trim();
  if (explicit) return explicit;
  const goal = dto.goal?.trim();
  if (goal) return goal.length > 120 ? `${goal.slice(0, 117)}…` : goal;
  return `${labelForType(dto.type)} strategy`;
}

function labelForType(type: StrategyTypeValue): string {
  const map: Record<StrategyTypeValue, string> = {
    appropriations: 'Appropriations',
    authorization: 'Authorization',
    regulatory: 'Regulatory / policy',
    coalition: 'Coalition / positioning',
    procurement: 'Contract / procurement',
    earmark: 'Grant / earmark',
  };
  return map[type];
}
