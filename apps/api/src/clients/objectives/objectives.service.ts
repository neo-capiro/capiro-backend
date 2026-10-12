import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { ClientObjective, Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { clientMemoryAllowed } from '../../memory/memory-wall.helpers.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  normalizeObjectiveFields,
  objectiveReadiness,
  requireObjectiveReady,
  type CreateObjectiveInput,
  type ObjectiveDraftInput,
  type ObjectiveFields,
  type ObjectiveTransition,
} from './objective-rules.js';
import {
  normalizeObjectiveDestination,
  type ObjectiveDestinationQueryDto,
  type ObjectiveRevisionBinding,
} from './objective-destination.js';

function presentObjective(record: ClientObjective) {
  return {
    id: record.id,
    clientId: record.clientId,
    requestId: record.clientRequestId,
    outcome: record.outcome,
    governmentProblem: record.governmentProblem,
    askType: record.askType,
    minimumWin: record.minimumWin,
    limits: record.limits,
    ownerUserId: record.ownerUserId,
    status: record.status,
    version: record.version,
    readyAt: record.readyAt?.toISOString() ?? null,
    reviewRequestedAt: record.reviewRequestedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    readiness: objectiveReadiness(record),
  };
}

@Injectable()
export class ClientObjectivesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Destination owners call this inside their own resource transaction. */
  async requireDestinationRevisionWithinTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    input: ObjectiveDestinationQueryDto,
  ): Promise<ObjectiveRevisionBinding> {
    const binding = normalizeObjectiveDestination(input);
    // Lock the actual current authority, including the grant that a DELETE
    // revokes. A trusted request context alone is insufficient after revocation.
    const scope = await tx.$queryRaw<Array<{ memoryWall: boolean }>>`
      SELECT c.memory_wall AS "memoryWall"
      FROM tenants t
      JOIN tenant_memberships m ON m.tenant_id=t.id
      JOIN users u ON u.id=m.user_id
      JOIN clients c ON c.tenant_id=t.id
      WHERE t.id=${ctx.tenantId}::uuid AND t.status::text='active'
        AND m.user_id=${ctx.userId}::uuid AND m.status::text='active'
        AND m.role::text IN ('standard_user','user_admin','capiro_admin')
        AND u.clerk_user_id=${ctx.clerkUserId}
        AND c.id=${binding.clientId}::uuid AND c.status::text<>'archived'
      FOR SHARE OF t,m,u,c
    `;
    if (!scope[0]) throw new NotFoundException('Objective destination not found');
    if (scope[0].memoryWall) {
      const grants = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM client_memory_access
        WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${binding.clientId}::uuid
          AND user_id=${ctx.userId}::uuid FOR SHARE
      `;
      if (!grants[0]) throw new NotFoundException('Objective destination not found');
    }
    const objectives = await tx.$queryRaw<Array<{ version: number }>>`
      SELECT version FROM client_objectives
      WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${binding.clientId}::uuid
        AND id=${binding.objectiveId}::uuid AND deleted_at IS NULL FOR SHARE
    `;
    if (!objectives[0]) throw new NotFoundException('Objective destination not found');
    if (objectives[0].version !== binding.objectiveVersion) this.conflict();
    const revisions = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM client_objective_revisions
      WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${binding.clientId}::uuid
        AND objective_id=${binding.objectiveId}::uuid AND version=${binding.objectiveVersion}
    `;
    if (!revisions[0]) throw new NotFoundException('Objective destination not found');
    return { ...binding, objectiveRevisionId: revisions[0].id };
  }

  async list(ctx: TenantContext, clientId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertClient(tx, ctx, clientId);
      const records = await tx.clientObjective.findMany({
        where: { tenantId: ctx.tenantId, clientId, deletedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      });
      await this.assertClient(tx, ctx, clientId);
      return records.map(presentObjective);
    });
  }

  async get(ctx: TenantContext, clientId: string, id: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertClient(tx, ctx, clientId);
      return presentObjective(await this.findObjective(tx, ctx, clientId, id));
    });
  }

  async create(ctx: TenantContext, clientId: string, input: CreateObjectiveInput) {
    const fields = {
      outcome: '',
      governmentProblem: '',
      askType: null,
      minimumWin: '',
      limits: '',
      ...normalizeObjectiveFields(input),
    };
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertClient(tx, ctx, clientId);
      const ownerUserId = input.ownerUserId === undefined ? ctx.userId : input.ownerUserId;
      await this.assertOwner(tx, ctx, clientId, ownerUserId);
      const createRequestHash = createHash('sha256')
        .update(JSON.stringify({ ...fields, ownerUserId }))
        .digest('hex');
      await this.assertClient(tx, ctx, clientId);
      const inserted = await tx.clientObjective.createMany({
        data: {
          id: randomUUID(),
          tenantId: ctx.tenantId,
          clientId,
          createdByUserId: ctx.userId,
          ownerUserId,
          ...fields,
          clientRequestId: input.requestId,
          createRequestHash,
        },
        skipDuplicates: true,
      });
      await this.assertClient(tx, ctx, clientId);
      const record = await tx.clientObjective.findFirstOrThrow({
        where: { tenantId: ctx.tenantId, clientId, clientRequestId: input.requestId },
      });
      await this.assertClient(tx, ctx, clientId);
      if (record.createRequestHash !== createRequestHash || record.deletedAt !== null) {
        throw new ConflictException({
          code: 'OBJECTIVE_CREATE_REQUEST_CONFLICT',
          message:
            'This draft request was already used. Reload the Objective or start a new draft.',
        });
      }
      if (inserted.count === 1) await this.recordRevision(tx, ctx, record, 'create');
      return presentObjective(record);
    });
  }

  async update(
    ctx: TenantContext,
    clientId: string,
    id: string,
    expectedVersion: number,
    input: ObjectiveDraftInput,
  ) {
    const fields = normalizeObjectiveFields(input);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertClient(tx, ctx, clientId);
      const current = await this.findObjective(tx, ctx, clientId, id, expectedVersion);
      const ownerUserId = input.ownerUserId === undefined ? current.ownerUserId : input.ownerUserId;
      if (ownerUserId !== current.ownerUserId)
        await this.assertOwner(tx, ctx, clientId, ownerUserId);
      const fieldKeys: (keyof ObjectiveFields)[] = [
        'outcome',
        'governmentProblem',
        'askType',
        'minimumWin',
        'limits',
      ];
      const changed =
        fieldKeys.some((key) => fields[key] !== undefined && current[key] !== fields[key]) ||
        ownerUserId !== current.ownerUserId;
      if (!changed) return presentObjective(current);
      const record = await this.writeVersion(tx, ctx, current, {
        ...fields,
        ownerUserId,
        status: 'draft',
        readyAt: null,
        reviewRequestedAt: null,
      });
      await this.recordRevision(tx, ctx, record, 'edit');
      return presentObjective(record);
    });
  }

  async transition(
    ctx: TenantContext,
    clientId: string,
    id: string,
    expectedVersion: number,
    action: ObjectiveTransition,
  ) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertClient(tx, ctx, clientId);
      const current = await this.findObjective(tx, ctx, clientId, id, expectedVersion);
      requireObjectiveReady(current);
      const status = action === 'confirm_ready' ? 'ready' : 'in_review';
      if (current.status === status) return presentObjective(current);
      const now = new Date();
      const record = await this.writeVersion(tx, ctx, current, {
        status,
        readyAt: status === 'ready' ? now : null,
        reviewRequestedAt: status === 'in_review' ? now : null,
      });
      await this.recordRevision(tx, ctx, record, action);
      return presentObjective(record);
    });
  }

  async remove(ctx: TenantContext, clientId: string, id: string, expectedVersion: number) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertClient(tx, ctx, clientId);
      const current = await this.findObjective(tx, ctx, clientId, id, expectedVersion);
      const record = await this.writeVersion(tx, ctx, current, { deletedAt: new Date() });
      await this.recordRevision(tx, ctx, record, 'delete');
      return { id, deleted: true, version: record.version };
    });
  }

  private async assertClient(tx: Prisma.TransactionClient, ctx: TenantContext, clientId: string) {
    const client = await tx.client.findFirst({
      where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } },
      select: { id: true },
    });
    if (!client || !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId))) {
      throw new NotFoundException('Client not found');
    }
  }

  private async assertOwner(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    clientId: string,
    userId: string | null,
  ) {
    if (userId === null) return;
    const member = await tx.tenantMembership.findFirst({
      where: { tenantId: ctx.tenantId, userId, status: 'active' },
      select: { id: true },
    });
    await this.assertClient(tx, ctx, clientId);
    if (!member)
      throw new BadRequestException('Objective owner must be an active member of this tenant');
  }

  private async findObjective(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    clientId: string,
    id: string,
    version?: number,
  ) {
    const record = await tx.clientObjective.findFirst({
      where: { id, tenantId: ctx.tenantId, clientId, deletedAt: null },
    });
    await this.assertClient(tx, ctx, clientId);
    if (!record) throw new NotFoundException('Objective not found');
    if (version !== undefined && record.version !== version) this.conflict();
    return record;
  }

  private async writeVersion(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    current: ClientObjective,
    data: Prisma.ClientObjectiveUpdateManyMutationInput,
  ) {
    await this.assertClient(tx, ctx, current.clientId);
    const result = await tx.clientObjective.updateMany({
      where: {
        id: current.id,
        tenantId: ctx.tenantId,
        clientId: current.clientId,
        version: current.version,
        deletedAt: null,
      },
      data: { ...data, version: { increment: 1 } },
    });
    await this.assertClient(tx, ctx, current.clientId);
    if (result.count !== 1) this.conflict();
    const record = await tx.clientObjective.findFirst({
      where: { id: current.id, tenantId: ctx.tenantId, clientId: current.clientId },
    });
    await this.assertClient(tx, ctx, current.clientId);
    if (!record) throw new NotFoundException('Objective not found');
    return record;
  }

  private conflict(): never {
    throw new ConflictException({
      code: 'OBJECTIVE_VERSION_CONFLICT',
      message: 'Objective changed. Reload it before saving.',
    });
  }

  private async recordRevision(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    record: ClientObjective,
    operation: string,
  ) {
    await this.assertClient(tx, ctx, record.clientId);
    await tx.clientObjectiveRevision.create({
      data: {
        tenantId: ctx.tenantId,
        clientId: record.clientId,
        objectiveId: record.id,
        version: record.version,
        actorUserId: ctx.userId,
        operation,
        snapshot: {
          ...presentObjective(record),
          deletedAt: record.deletedAt?.toISOString() ?? null,
        },
      },
    });
    await this.assertClient(tx, ctx, record.clientId);
  }
}
