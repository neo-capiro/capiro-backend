import { parseStrategyIntake, StrategyIntakeValidationError, type StrategyIntakeDraft } from '@capiro/shared/strategy-intake';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { ClientObjective, Prisma } from '@prisma/client';
import {
  requireClientObjectiveDestinationRevision,
  ClientObjectiveDestinationError,
  type TenantContext,
} from '@capiro/shared';
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
import { appendObjectiveReadyIntent } from './objective-work-intent.js';
import { reserveCanonicalObjectivePlan } from './objective-canonical-plan.js';

type ObjectiveRecord = ClientObjective & { strategyIntake?: StrategyIntakeDraft };

function presentObjective(record: ObjectiveRecord) {
  return {
    ...(record.strategyIntake !== undefined ? { strategyIntake: { ...record.strategyIntake } } : {}),
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
    try {
      return await requireClientObjectiveDestinationRevision(
        tx,
        ctx,
        normalizeObjectiveDestination(input),
      );
    } catch (error) {
      if (error instanceof ClientObjectiveDestinationError) {
        if (error.code === 'OBJECTIVE_VERSION_CONFLICT') this.conflict();
        if (error.code === 'OBJECTIVE_DESTINATION_INVALID')
          throw new BadRequestException('Invalid Objective destination binding');
        throw new NotFoundException('Objective destination not found');
      }
      throw error;
    }
  }

  async list(ctx: TenantContext, clientId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertClient(tx, ctx, clientId);
      const records = await tx.clientObjective.findMany({
        where: { tenantId: ctx.tenantId, clientId, deletedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      });
      await this.assertClient(tx, ctx, clientId);
      return (await this.withSavedIntakes(tx, ctx, records)).map(presentObjective);
    });
  }

  /** Current automatic context is a bounded sample, not the full Objective list. */
  async readContext(ctx: TenantContext, clientId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertClient(tx, ctx, clientId);
      const where = { tenantId: ctx.tenantId, clientId, deletedAt: null };
      const total = await tx.clientObjective.count({ where });
      const records = await tx.clientObjective.findMany({
        where, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: 3,
      });
      await this.assertClient(tx, ctx, clientId);
      return { status: total > records.length ? 'partial' : 'complete', total, items: (await this.withSavedIntakes(tx, ctx, records)).map(presentObjective) };
    });
  }

  async assertContextAccess(ctx: TenantContext, clientId: string): Promise<void> {
    await this.prisma.withTenant(ctx.tenantId, (tx) => this.assertClient(tx, ctx, clientId));
  }

  async get(ctx: TenantContext, clientId: string, id: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertClient(tx, ctx, clientId);
      return presentObjective(await this.findObjective(tx, ctx, clientId, id));
    });
  }

  async create(ctx: TenantContext, clientId: string, input: CreateObjectiveInput) {
    const strategyIntake = this.parseIntake(input.strategyIntake);
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
      const ownerUserId = strategyIntake !== undefined
        ? await this.intakeOwner(tx, ctx, clientId, strategyIntake, input.ownerUserId)
        : input.ownerUserId === undefined ? ctx.userId : input.ownerUserId;
      await this.assertOwner(tx, ctx, clientId, ownerUserId);
      const createRequestHash = createHash('sha256')
        .update(JSON.stringify({ ...fields, ownerUserId, ...(strategyIntake !== undefined ? { strategyIntake } : {}) }))
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
      if (inserted.count === 1) {
        const saved = { ...record, ...(strategyIntake !== undefined ? { strategyIntake } : {}) };
        await this.recordRevision(tx, ctx, saved, 'create');
        return presentObjective(saved);
      }
      return presentObjective((await this.withSavedIntakes(tx, ctx, [record]))[0]!);
    });
  }

  async update(
    ctx: TenantContext,
    clientId: string,
    id: string,
    expectedVersion: number,
    input: ObjectiveDraftInput,
  ) {
    const incomingIntake = this.parseIntake(input.strategyIntake);
    const fields = normalizeObjectiveFields(input);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.assertClient(tx, ctx, clientId);
      const current = await this.findObjective(tx, ctx, clientId, id, expectedVersion);
      const strategyIntake = incomingIntake === undefined ? current.strategyIntake : incomingIntake;
      const ownerUserId = strategyIntake !== undefined
        ? await this.intakeOwner(tx, ctx, clientId, strategyIntake, input.ownerUserId)
        : input.ownerUserId === undefined ? current.ownerUserId : input.ownerUserId;
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
        ownerUserId !== current.ownerUserId ||
        JSON.stringify(strategyIntake) !== JSON.stringify(current.strategyIntake);
      if (!changed) return presentObjective(current);
      const record = await this.writeVersion(tx, ctx, current, {
        ...fields,
        ownerUserId,
        status: 'draft',
        readyAt: null,
        reviewRequestedAt: null,
      });
      const saved = { ...record, ...(strategyIntake !== undefined ? { strategyIntake } : {}) };
      await this.recordRevision(tx, ctx, saved, 'edit');
      return presentObjective(saved);
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
      if (current.strategyIntake) {
        const owner = await this.intakeOwner(tx, ctx, clientId, current.strategyIntake);
        if (owner !== current.ownerUserId) throw new BadRequestException('Objective owner changed. Save the intake again.');
      }
      const status = action === 'confirm_ready' ? 'ready' : 'in_review';
      if (current.status === status) return presentObjective(current);
      const now = new Date();
      const record = await this.writeVersion(tx, ctx, current, {
        status,
        readyAt: status === 'ready' ? now : null,
        reviewRequestedAt: status === 'in_review' ? now : null,
      });
      const revision = await this.recordRevision(tx, ctx, record, action);
      if (action === 'confirm_ready') {
        // The Objective UPDATE is already held. Lock current authority before
        // touching intent/reservation; do not upgrade an earlier Objective SHARE
        // lock during simultaneous confirmations.
        const source = await this.requireDestinationRevisionWithinTx(tx, ctx, {
          clientId: record.clientId,
          objectiveId: record.id,
          objectiveVersion: record.version,
        });
        if (source.objectiveRevisionId !== revision.id)
          throw new Error('Objective confirmation revision mismatch');
        const intent = await appendObjectiveReadyIntent(tx, revision);
        await reserveCanonicalObjectivePlan(tx, revision, intent);
        await this.assertClient(tx, ctx, record.clientId);
      }
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

  private parseIntake(raw: unknown): StrategyIntakeDraft | undefined {
    if (raw === undefined) return undefined;
    try { return parseStrategyIntake(raw); }
    catch (error) {
      if (error instanceof StrategyIntakeValidationError)
        throw new BadRequestException({ code: 'STRATEGY_INTAKE_INVALID', field: error.field, message: error.message });
      throw error;
    }
  }

  private async intakeOwner(tx: Prisma.TransactionClient, ctx: TenantContext, clientId: string,
    intake: StrategyIntakeDraft, explicitOwner?: string | null): Promise<string | null> {
    const member = intake.ownerUserId === null ? null : await tx.tenantMembership.findFirst({
      where: { tenantId: ctx.tenantId, status: 'active', user: { clerkUserId: intake.ownerUserId } },
      select: { userId: true },
    });
    await this.assertClient(tx, ctx, clientId);
    if (intake.ownerUserId !== null && !member)
      throw new BadRequestException('Objective owner must be an active member of this tenant');
    const owner = member?.userId ?? null;
    if (explicitOwner !== undefined && explicitOwner !== owner)
      throw new BadRequestException('Objective owner must match the saved Strategy intake');
    return owner;
  }

  /** The matching revision alone owns answers. Never search an older revision for a fallback. */
  private async withSavedIntakes(tx: Prisma.TransactionClient, ctx: TenantContext,
    records: ClientObjective[]): Promise<ObjectiveRecord[]> {
    if (!records.length) return [];
    const revisions = await tx.clientObjectiveRevision.findMany({
      where: { tenantId: ctx.tenantId, OR: records.map(r => ({ clientId: r.clientId, objectiveId: r.id, version: r.version })) },
      select: { objectiveId: true, version: true, snapshot: true },
    });
    for (const clientId of new Set(records.map(r => r.clientId))) await this.assertClient(tx, ctx, clientId);
    return records.map(record => {
      const revision = revisions.find(r => r.objectiveId === record.id && r.version === record.version);
      const snapshot = revision?.snapshot as Record<string, unknown> | undefined;
      return { ...record, ...(snapshot && Object.hasOwn(snapshot, 'strategyIntake')
        ? { strategyIntake: this.parseIntake(snapshot.strategyIntake)! } : {}) };
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
    return (await this.withSavedIntakes(tx, ctx, [record]))[0]!;
  }

  private async writeVersion(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    current: ObjectiveRecord,
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
    return { ...record, ...(current.strategyIntake !== undefined ? { strategyIntake: current.strategyIntake } : {}) };
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
    record: ObjectiveRecord,
    operation: string,
  ) {
    await this.assertClient(tx, ctx, record.clientId);
    const revision = await tx.clientObjectiveRevision.create({
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
    return revision;
  }
}
