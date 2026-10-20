import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ClientObjectiveDestinationError,
  requireClientObjectiveDestinationRevision,
  type TenantContext,
} from '@capiro/shared';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  discoverPermittedPlanClientIds,
  lockPlanClient,
  lockPlanTargets,
  presentPlanOfficeReferences,
  requirePlanActorAndGrant,
  validatePlanOfficeReferences,
} from './engagement-plan-access.js';
import {
  deriveReviewFreshness,
  planTransition,
  PlanRuleError,
  type CreatePlanInput,
  type CreateWaveInput,
  type PatchPlanInput,
  type PatchWaveInput,
  type PlanHistoryQuery,
  type PlanListQuery,
  type PlanObjectiveInput,
  type ReorderWavesInput,
  type ReviewPlanInput,
} from './engagement-plan.rules.js';
import {
  advancePlan,
  checkPlanVersion,
  findCreationReceipt,
  getPlan,
  getWaves,
  insertPlan,
  PLAN_COLUMNS,
  planClient,
  planConflict,
  recordCreationReceipt,
  recordPlanRevision,
  saveWave,
  type CreationReceipt,
  type ObjectiveBinding,
  type PlanRow,
  type PlanTx,
  type WaveRow,
} from './engagement-plan-store.js';

const same = isDeepStrictEqual;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
interface ListCursor {
  at: string;
  id: string;
  scope: string;
}

@Injectable()
export class EngagementPlansService {
  constructor(private readonly prisma: PrismaService) {}

  async list(ctx: TenantContext, query: PlanListQuery) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await lockPlanTargets(tx, ctx);
      const ids = await discoverPermittedPlanClientIds(tx, ctx, query.clientId);
      const scope = hash({
        tenant: ctx.tenantId,
        actor: ctx.userId,
        ids,
        client: query.clientId ?? null,
      });
      const cursor = this.cursor(query.cursor, scope);
      const rows = ids.length
        ? await tx.$queryRawUnsafe<Array<PlanRow & { cursorAt: string }>>(
            `SELECT ${PLAN_COLUMNS},to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt"
         FROM engagement_plans WHERE tenant_id=$1::uuid AND client_id=ANY($2::uuid[])
         AND ($3::timestamptz IS NULL OR (created_at,id)>($3::timestamptz,$4::uuid))
         ORDER BY created_at,id LIMIT $5`,
            ctx.tenantId,
            ids,
            cursor?.at ?? null,
            cursor?.id ?? null,
            query.limit + 1,
          )
        : [];
      const hasMore = rows.length > query.limit;
      const page = rows.slice(0, query.limit);
      const checkedAt = new Date();
      const summaryIds = query.clientId
        ? [query.clientId]
        : [...new Set(page.map((row) => row.clientId))].sort();
      const summaries = await this.summaries(tx, ctx, summaryIds, page, checkedAt);
      const items = [];
      for (const row of page) items.push(await this.present(tx, ctx, row, checkedAt));
      const last = page.at(-1);
      return {
        items,
        summaries,
        pagination: {
          hasMore,
          nextCursor:
            hasMore && last
              ? Buffer.from(JSON.stringify({ at: last.cursorAt, id: last.id, scope })).toString(
                  'base64url',
                )
              : null,
        },
        completeness: {
          read: 'complete' as const,
          page: hasMore ? ('partial' as const) : ('complete' as const),
          summaryCoverage: query.clientId
            ? ('selected_client' as const)
            : ('returned_clients' as const),
        },
      };
    });
  }

  get(ctx: TenantContext, id: string) {
    return this.withPlan(ctx, id, async (tx, plan) => this.present(tx, ctx, plan));
  }

  create(ctx: TenantContext, input: CreatePlanInput) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await lockPlanTargets(tx, ctx);
      await lockPlanClient(tx, ctx, input.clientId);
      await requirePlanActorAndGrant(tx, ctx, input.clientId);
      const requestHash = hash(input);
      const prior = await findCreationReceipt(
        tx,
        ctx,
        input.clientId,
        'create_plan',
        input.requestId,
        requestHash,
      );
      if (prior) return this.reconciled(tx, ctx, prior);
      await validatePlanOfficeReferences(tx, ctx, input.clientId, input.officeReferences);
      const objectiveBinding = await this.objective(tx, ctx, input.clientId, input.objective);
      const plan = await insertPlan(tx, ctx, { ...input, id: randomUUID(), objectiveBinding });
      const receipt: CreationReceipt = {
        operation: 'create_plan',
        planId: plan.id,
        clientId: plan.clientId,
        planVersion: 1,
        requestId: input.requestId,
      };
      await recordCreationReceipt(tx, ctx, receipt, requestHash);
      await recordPlanRevision(tx, ctx, plan, 'create_plan');
      return { receipt, reconciled: false, aggregate: await this.present(tx, ctx, plan) };
    });
  }

  patch(ctx: TenantContext, id: string, input: PatchPlanInput) {
    return this.withPlan(ctx, id, async (tx, current) => {
      checkPlanVersion(current, input.expectedPlanVersion);
      if (input.action) {
        let lifecycle;
        try {
          lifecycle = planTransition(current.lifecycle, input.action);
        } catch (error) {
          this.ruleError(error);
        }
        if (lifecycle === current.lifecycle) return this.present(tx, ctx, current);
        const next = await advancePlan(tx, ctx, current, { lifecycle });
        await recordPlanRevision(tx, ctx, next, input.action);
        return this.present(tx, ctx, next);
      }
      this.requireEditable(current);
      const refs = input.officeReferences ?? current.officeReferences;
      if (input.officeReferences) {
        await validatePlanOfficeReferences(tx, ctx, current.clientId, refs);
        const allowed = new Set(refs.map((ref) => ref.targetId));
        if (
          (await getWaves(tx, current)).some((wave) =>
            wave.officeTargetIds.some((target) => !allowed.has(target)),
          )
        )
          planConflict(
            'PLAN_OFFICE_REFERENCE_IN_USE',
            'Remove wave office references before removing them from the plan.',
          );
      }
      const binding =
        input.objective === undefined
          ? current.objectiveBinding
          : await this.objective(tx, ctx, current.clientId, input.objective);
      const changes = {
        title: input.title ?? current.title,
        officeReferences: refs,
        objectiveBinding: binding,
      };
      if (
        changes.title === current.title &&
        same(refs, current.officeReferences) &&
        same(binding, current.objectiveBinding)
      )
        return this.present(tx, ctx, current);
      const next = await advancePlan(tx, ctx, current, changes);
      await recordPlanRevision(tx, ctx, next, 'edit_plan');
      return this.present(tx, ctx, next);
    });
  }

  createWave(ctx: TenantContext, id: string, input: CreateWaveInput) {
    return this.withPlan(ctx, id, async (tx, current) => {
      const requestHash = hash({ planId: current.id, ...input });
      const prior = await findCreationReceipt(
        tx,
        ctx,
        current.clientId,
        'create_wave',
        input.requestId,
        requestHash,
      );
      if (prior) return this.reconciled(tx, ctx, prior);
      checkPlanVersion(current, input.expectedPlanVersion);
      this.requireEditable(current);
      await this.waveOffices(tx, ctx, current, input.officeTargetIds);
      const waves = await getWaves(tx, current);
      const position = waves.length ? Math.max(...waves.map((wave) => wave.position)) + 1 : 0;
      if (position > 2_147_483_647)
        planConflict('PLAN_WAVE_ORDER_LIMIT', 'Wave order limit reached.');
      const now = new Date();
      const wave: WaveRow = {
        id: randomUUID(),
        tenantId: ctx.tenantId,
        clientId: current.clientId,
        planId: current.id,
        title: input.title,
        position,
        formatLabel: input.formatLabel,
        window: input.window,
        officeTargetIds: input.officeTargetIds,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      const next = await advancePlan(tx, ctx, current);
      await saveWave(tx, next, wave, true);
      const receipt: CreationReceipt = {
        operation: 'create_wave',
        planId: current.id,
        clientId: current.clientId,
        waveId: wave.id,
        planVersion: next.version,
        requestId: input.requestId,
      };
      await recordCreationReceipt(tx, ctx, receipt, requestHash);
      await recordPlanRevision(tx, ctx, next, 'create_wave');
      return { receipt, reconciled: false, aggregate: await this.present(tx, ctx, next) };
    });
  }

  patchWave(ctx: TenantContext, id: string, waveId: string, input: PatchWaveInput) {
    return this.withPlan(ctx, id, async (tx, current) => {
      checkPlanVersion(current, input.expectedPlanVersion);
      this.requireEditable(current);
      const wave = (await getWaves(tx, current)).find((row) => row.id === waveId.toLowerCase());
      if (!wave) throw new NotFoundException('Wave not found');
      if (input.action) {
        const archive = input.action === 'archive';
        if (archive === (wave.archivedAt !== null)) return this.present(tx, ctx, current);
        wave.archivedAt = archive ? new Date() : null;
      } else {
        if (wave.archivedAt)
          planConflict('PLAN_INVALID_LIFECYCLE', 'Restore this wave before editing it.');
        if (input.officeTargetIds) await this.waveOffices(tx, ctx, current, input.officeTargetIds);
        const before = json(wave);
        if (input.title !== undefined) wave.title = input.title;
        if (input.formatLabel !== undefined) wave.formatLabel = input.formatLabel;
        if (input.window !== undefined) wave.window = input.window;
        if (input.officeTargetIds !== undefined) wave.officeTargetIds = input.officeTargetIds;
        if (same(before, json(wave))) return this.present(tx, ctx, current);
      }
      const next = await advancePlan(tx, ctx, current);
      await saveWave(tx, next, wave);
      await recordPlanRevision(tx, ctx, next, input.action ? `${input.action}_wave` : 'edit_wave');
      return this.present(tx, ctx, next);
    });
  }

  reorder(ctx: TenantContext, id: string, input: ReorderWavesInput) {
    return this.withPlan(ctx, id, async (tx, current) => {
      checkPlanVersion(current, input.expectedPlanVersion);
      this.requireEditable(current);
      const waves = (await getWaves(tx, current)).filter((wave) => !wave.archivedAt);
      const byId = new Map(waves.map((wave) => [wave.id, wave]));
      if (
        input.waveIds.length !== waves.length ||
        input.waveIds.some((waveId) => !byId.has(waveId))
      )
        throw new BadRequestException({
          code: 'PLAN_INPUT_INVALID',
          message: 'Supply every current unarchived wave exactly once.',
        });
      if (input.waveIds.every((waveId, index) => waves[index]?.id === waveId))
        return this.present(tx, ctx, current);
      const next = await advancePlan(tx, ctx, current);
      for (let position = 0; position < input.waveIds.length; position++) {
        const wave = byId.get(input.waveIds[position]!)!;
        await saveWave(tx, next, { ...wave, position });
      }
      await recordPlanRevision(tx, ctx, next, 'reorder_waves');
      return this.present(tx, ctx, next);
    });
  }

  review(ctx: TenantContext, id: string, input: ReviewPlanInput) {
    return this.withPlan(ctx, id, async (tx, current) => {
      checkPlanVersion(current, input.expectedPlanVersion);
      this.requireEditable(current);
      const now = new Date();
      const due = new Date(input.reviewDueAt);
      if (!Number.isFinite(due.getTime()) || due <= now)
        throw new BadRequestException({
          code: 'PLAN_INPUT_INVALID',
          message: 'Review deadline must still be in the future.',
        });
      const next = await advancePlan(tx, ctx, current, {
        reviewedPlanVersion: current.version + 1,
        reviewedAt: now,
        reviewDueAt: due,
        reviewedByUserId: ctx.userId,
      });
      await recordPlanRevision(tx, ctx, next, 'review_plan');
      return this.present(tx, ctx, next);
    });
  }

  history(ctx: TenantContext, id: string, query: PlanHistoryQuery) {
    return this.withPlan(ctx, id, async (tx, plan) => {
      const rows = await tx.$queryRawUnsafe<
        Array<{
          version: number;
          operation: string;
          actorUserId: string;
          createdAt: Date;
          snapshot: { officeReferences: PlanRow['officeReferences'] };
        }>
      >(
        `SELECT version,operation,actor_user_id::text AS "actorUserId",created_at AS "createdAt",snapshot FROM engagement_plan_revisions
         WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND plan_id=$3::uuid AND ($4::int IS NULL OR version<$4)
         ORDER BY version DESC LIMIT $5`,
        ctx.tenantId,
        plan.clientId,
        id,
        query.beforeVersion ?? null,
        query.limit + 1,
      );
      const hasMore = rows.length > query.limit;
      const items = [];
      for (const row of rows.slice(0, query.limit))
        items.push({
          ...row,
          snapshot: {
            ...row.snapshot,
            officeReferences: await presentPlanOfficeReferences(
              tx,
              ctx,
              plan.clientId,
              row.snapshot.officeReferences,
            ),
          },
        });
      return {
        planId: plan.id,
        clientId: plan.clientId,
        planVersion: plan.version,
        items,
        pagination: { hasMore, beforeVersion: hasMore ? (items.at(-1)?.version ?? null) : null },
        completeness: hasMore ? 'partial' : 'complete',
      };
    });
  }

  private async withPlan<T>(
    ctx: TenantContext,
    id: string,
    run: (tx: PlanTx, plan: PlanRow) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.withTenant(ctx.tenantId, async (tx) => {
        await lockPlanTargets(tx, ctx);
        const clientId = await planClient(tx, ctx, id);
        await lockPlanClient(tx, ctx, clientId);
        await requirePlanActorAndGrant(tx, ctx, clientId);
        const plan = await getPlan(tx, ctx, id, clientId, true);
        return run(tx, plan);
      });
    } catch (error) {
      if (error instanceof NotFoundException) throw new NotFoundException('Plan not found');
      throw error;
    }
  }
  private async present(tx: PlanTx, ctx: TenantContext, plan: PlanRow, checkedAt = new Date()) {
    const waves = await getWaves(tx, plan);
    const refs = await presentPlanOfficeReferences(tx, ctx, plan.clientId, plan.officeReferences);
    const {
      tenantId: _tenant,
      cursorAt: _cursor,
      ...fields
    } = plan as PlanRow & { cursorAt?: string };
    return {
      ...fields,
      officeReferences: refs,
      review: {
        ...deriveReviewFreshness(plan, checkedAt),
        meaning: 'explicitly_reviewed_version' as const,
      },
      waves: waves.map(({ tenantId: _waveTenant, ...wave }) => ({
        ...wave,
        planVersion: plan.version,
        unavailableOfficeTargetIds: wave.officeTargetIds.filter(
          (id) => !refs.some((ref) => ref.targetId === id && ref.available),
        ),
      })),
    };
  }
  private async reconciled(tx: PlanTx, ctx: TenantContext, receipt: CreationReceipt) {
    const plan = await getPlan(tx, ctx, receipt.planId, receipt.clientId, true);
    return { receipt, reconciled: true, aggregate: await this.present(tx, ctx, plan) };
  }
  private requireEditable(plan: PlanRow): void {
    if (plan.lifecycle === 'archived')
      planConflict('PLAN_INVALID_LIFECYCLE', 'Restore this plan before editing it.');
  }
  private ruleError(error: unknown): never {
    if (error instanceof PlanRuleError)
      throw new ConflictException({ code: error.code, message: error.message });
    throw error;
  }
  private async objective(
    tx: PlanTx,
    ctx: TenantContext,
    clientId: string,
    input: PlanObjectiveInput | null,
  ): Promise<ObjectiveBinding | null> {
    if (!input) return null;
    try {
      return await requireClientObjectiveDestinationRevision(tx, ctx, { clientId, ...input });
    } catch (error) {
      if (error instanceof ClientObjectiveDestinationError) {
        if (error.code === 'OBJECTIVE_VERSION_CONFLICT')
          planConflict(
            'PLAN_OBJECTIVE_VERSION_CONFLICT',
            'Objective changed. Reload its revision.',
          );
        if (error.code === 'OBJECTIVE_DESTINATION_INVALID')
          throw new BadRequestException('Invalid Objective binding');
        throw new NotFoundException('Objective not found');
      }
      throw error;
    }
  }
  private async waveOffices(tx: PlanTx, ctx: TenantContext, plan: PlanRow, ids: string[]) {
    const refs = ids.map((id) => plan.officeReferences.find((ref) => ref.targetId === id));
    if (refs.some((ref) => !ref))
      throw new BadRequestException({
        code: 'PLAN_INPUT_INVALID',
        message: 'Wave offices must belong to this plan.',
      });
    await validatePlanOfficeReferences(tx, ctx, plan.clientId, refs as PlanRow['officeReferences']);
  }
  private cursor(raw: string | undefined, scope: string): ListCursor | null {
    if (!raw) return null;
    let parsed: ListCursor;
    try {
      if (Buffer.from(raw, 'base64url').toString('base64url') !== raw) throw new Error();
      parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as ListCursor;
      if (
        Object.keys(parsed).sort().join() !== 'at,id,scope' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed.at) ||
        parsed.at.startsWith('0000') ||
        !Number.isFinite(Date.parse(parsed.at)) ||
        new Date(parsed.at).toISOString() !== `${parsed.at.slice(0, 23)}Z` ||
        !uuidPattern.test(parsed.id) ||
        typeof parsed.scope !== 'string' ||
        !/^[a-f0-9]{64}$/.test(parsed.scope)
      )
        throw new Error();
    } catch {
      throw new BadRequestException({
        code: 'PLAN_INPUT_INVALID',
        message: 'Invalid plan cursor.',
      });
    }
    if (parsed.scope !== scope)
      planConflict('PLAN_SCOPE_CHANGED', 'Permitted client scope changed. Reload the list.');
    return parsed;
  }
  private async summaries(
    tx: PlanTx,
    ctx: TenantContext,
    ids: string[],
    page: PlanRow[],
    checkedAt: Date,
  ) {
    if (!ids.length) return [];
    const rows = await tx.$queryRawUnsafe<
      Array<{ clientId: string; total: bigint; active: bigint; archived: bigint; draft: bigint }>
    >(
      `SELECT client_id::text AS "clientId",count(*) AS total,count(*) FILTER(WHERE lifecycle='active') AS active,
       count(*) FILTER(WHERE lifecycle='archived') AS archived,count(*) FILTER(WHERE lifecycle='draft') AS draft
       FROM engagement_plans WHERE tenant_id=$1::uuid AND client_id=ANY($2::uuid[]) GROUP BY client_id`,
      ctx.tenantId,
      ids,
    );
    return ids.map((clientId) => {
      const row = rows.find((item) => item.clientId === clientId);
      return {
        clientId,
        totalPlans: Number(row?.total ?? 0),
        activePlans: Number(row?.active ?? 0),
        archivedPlans: Number(row?.archived ?? 0),
        draftPlans: Number(row?.draft ?? 0),
        planIdsOnPage: page.filter((plan) => plan.clientId === clientId).map((plan) => plan.id),
        complete: true,
        checkedAt: checkedAt.toISOString(),
      };
    });
  }
}
