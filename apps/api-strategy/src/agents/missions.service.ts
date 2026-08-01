import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import { assertMissionTransition } from './run-state.js';
import { Prisma, type SpMissionState } from '../../generated/prisma-client/index.js';
import type { CreateMissionDto, UpdateMissionDto } from './dto/agents.dto.js';

/**
 * Standing agent missions (Stage C). Missions start as draft and must be
 * activated (PATCH state through MISSION_TRANSITIONS) before a run can be
 * created. Every mutation runs in ONE withTenantUser tx so the write + the
 * audit row (and its outbox event) commit atomically.
 */
@Injectable()
export class MissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly versioning: VersioningService,
  ) {}

  async create(tenantId: string, userId: string, dto: CreateMissionDto) {
    return this.prisma.withTenantUser(tenantId, userId, async (tx) => {
      // Tenant-scoped existence check (the query hook injects tenantId) — a
      // mission may not point at another tenant's / a nonexistent strategy.
      if (dto.strategyId) {
        const strat = await tx.spStrategy.findFirst({
          where: { id: dto.strategyId },
          select: { id: true },
        });
        if (!strat) throw new BadRequestException('Unknown strategy for this tenant');
      }
      // clientId is a cross-schema reference (no FK, no Prisma model in this
      // schema) — validate it belongs to the caller's tenant exactly like
      // StrategyService.create. The tx GUC (app.current_tenant, set by
      // withTenantUser) scopes the clients RLS; the explicit tenant_id
      // predicate is defense-in-depth.
      if (dto.clientId) {
        const clientRows = await tx.$queryRaw<Array<{ ok: number }>>`
          SELECT 1 AS ok FROM clients WHERE id = ${dto.clientId}::uuid AND tenant_id = ${tenantId}::uuid LIMIT 1`;
        if (clientRows.length === 0) {
          throw new BadRequestException('Unknown client for this tenant');
        }
      }
      const mission = await tx.spAgentMission.create({
        data: {
          tenantId,
          strategyId: dto.strategyId ?? null,
          clientId: dto.clientId ?? null,
          name: dto.name,
          description: dto.description ?? null,
          state: 'draft',
          cadence: dto.cadence ?? null,
          createdByUserId: userId,
        },
      });
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: userId,
        authorKind: 'person',
        action: 'mission.created',
        entityType: 'mission',
        entityId: mission.id,
        after: { name: mission.name, strategyId: mission.strategyId, cadence: mission.cadence },
      });
      return mission;
    });
  }

  async list(tenantId: string, opts: { strategyId?: string } = {}) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.spAgentMission.findMany({
        where: opts.strategyId ? { strategyId: opts.strategyId } : {},
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
  }

  async get(tenantId: string, id: string) {
    const mission = await this.prisma.withTenant(tenantId, (tx) =>
      tx.spAgentMission.findFirst({ where: { id } }),
    );
    if (!mission) throw new NotFoundException('Mission not found');
    return mission;
  }

  async update(tenantId: string, userId: string, id: string, dto: UpdateMissionDto) {
    return this.prisma.withTenantUser(tenantId, userId, async (tx) => {
      const mission = await tx.spAgentMission.findFirst({ where: { id } });
      if (!mission) throw new NotFoundException('Mission not found');

      const data: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const set = (key: string, value: unknown, prev: unknown) => {
        data[key] = value;
        before[key] = prev;
        after[key] = value;
      };

      // Same-state PATCH is a no-op (not a transition); a real change must be
      // a legal MISSION_TRANSITIONS move.
      if (dto.state !== undefined && dto.state !== mission.state) {
        try {
          assertMissionTransition(mission.state, dto.state);
        } catch (err) {
          throw new BadRequestException((err as Error).message);
        }
        set('state', dto.state as SpMissionState, mission.state);
      }
      if (dto.name !== undefined) set('name', dto.name, mission.name);
      if (dto.description !== undefined) set('description', dto.description, mission.description);
      // Present-and-null clears cadence (manual-only mission).
      if (dto.cadence !== undefined) set('cadence', dto.cadence, mission.cadence);
      if (dto.nextRunAt !== undefined) {
        if (dto.nextRunAt === null) {
          set('nextRunAt', null, mission.nextRunAt);
        } else {
          const parsed = new Date(dto.nextRunAt);
          if (Number.isNaN(parsed.getTime())) {
            throw new BadRequestException('nextRunAt must be an ISO date-time string');
          }
          set('nextRunAt', parsed, mission.nextRunAt);
        }
      }

      if (Object.keys(data).length === 0) return mission;

      data.updatedByUserId = userId;
      // State-guarded write: the transition above was validated against the
      // state READ earlier in this tx, so require that state to still hold at
      // UPDATE time. Without it, two concurrent PATCHes both reading 'active'
      // could commit in sequence and a later 'paused' would silently overwrite
      // a terminal 'completed'. A mismatch matches zero rows (P2025) => 409.
      const stateGuarded = data.state !== undefined;
      let updated;
      try {
        updated = await tx.spAgentMission.update({
          where: stateGuarded ? { id, state: mission.state } : { id },
          data,
        });
      } catch (err) {
        if (
          stateGuarded &&
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2025'
        ) {
          throw new ConflictException('mission state changed concurrently — re-read and retry');
        }
        throw err;
      }
      await this.versioning.logActivity(tx, {
        tenantId,
        actorUserId: userId,
        authorKind: 'person',
        action: 'mission.updated',
        entityType: 'mission',
        entityId: id,
        before,
        after,
      });
      return updated;
    });
  }
}
