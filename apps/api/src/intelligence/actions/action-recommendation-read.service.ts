import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { clientMemoryAllowed } from '../../memory/memory-wall.helpers.js';
import { validateTransition } from './action-transitions.js';
import type {
  ActionStatus,
  ActionType,
  AudienceMember,
  ConfidenceBands,
  DeadlineSource,
  EvidenceRef,
} from './action-recommendation.types.js';

/**
 * Step 3.2 — ActionRecommendation READ/WRITE service (plan §10 card, §19 workflow,
 * §12.4 board). The list/get/patch half of the action-card API; the GENERATOR half
 * lives in `action-recommendation.service.ts` (owned elsewhere) and is injected only
 * by the controller for the POST /generate route, NOT here.
 *
 * Every method is tenant-isolated through `prisma.withTenant(ctx.tenantId, ...)` so the
 * RLS policy on `action_recommendation` is the single source of truth for visibility.
 * Writes (status / owner) route status changes through the pure `validateTransition`
 * (§19 lifecycle) and emit an AuditLog inside the same tenant transaction, mirroring
 * `programs.service.resolveMatch`.
 *
 * Money convention: $ MILLIONS throughout (project-wide).
 */

/** Sort modes accepted by the list endpoint. */
export type ActionSort = 'deadline' | 'priority';

export interface ListActionsQuery {
  status?: ActionStatus;
  clientId?: string;
  sort?: ActionSort;
  page?: number;
  limit?: number;
}

/** The full action-card row returned to the web layer (matches ActionCardDto exactly). */
export interface ActionCard {
  id: string;
  districtKey?: string | null;
  clientId: string;
  clientName?: string;
  peCode: string | null;
  programId: string | null;
  deltaId: string | null;
  actionType: ActionType;
  issueTitle: string;
  whatChanged: string;
  whyItMatters: string;
  recommendedAction: string;
  targetAudience: AudienceMember[];
  suggestedArtifactType: string | null;
  deadline: string | null;
  deadlineSource: DeadlineSource | null;
  ownerUserId: string | null;
  priority: number;
  confidence: ConfidenceBands;
  uncertainty: string | null;
  evidence: EvidenceRef[];
  status: ActionStatus;
  dismissalReason: string | null;
  outcome: string | null;
  createdAt: string;
  updatedAt: string;
  linkedSourceProofs?: LinkedSourceProof[];
}

export interface LinkedSourceProof {
  owner: 'source_document';
  sourceRecordId: string;
  sourceVersion: string;
  contentSha256: string;
}

export interface ListActionsResult {
  data: ActionCard[];
  total: number;
  page: number;
  limit: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** Selected columns for a card row + the joined client name. */
const cardSelect = {
  id: true,
  districtKey: true,
  clientId: true,
  peCode: true,
  programId: true,
  deltaId: true,
  actionType: true,
  issueTitle: true,
  whatChanged: true,
  whyItMatters: true,
  recommendedAction: true,
  targetAudience: true,
  suggestedArtifactType: true,
  deadline: true,
  deadlineSource: true,
  ownerUserId: true,
  priority: true,
  confidence: true,
  uncertainty: true,
  evidence: true,
  status: true,
  dismissalReason: true,
  outcome: true,
  createdAt: true,
  updatedAt: true,
  client: { select: { name: true } },
} satisfies Prisma.ActionRecommendationSelect;

const sourceDocumentSelect = {
  id: true,
  sourceKey: true,
  fiscalYear: true,
  budgetCycle: true,
  component: true,
  documentType: true,
  title: true,
  sourceUrl: true,
  sha256: true,
  extractionMethod: true,
  extractionToolVersion: true,
  ingestedAt: true,
  supersededByDocumentId: true,
} satisfies Prisma.SourceDocumentSelect;

type SourceDocumentRow = Prisma.SourceDocumentGetPayload<{ select: typeof sourceDocumentSelect }>;

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

function sourceDocumentProof(row: SourceDocumentRow): LinkedSourceProof {
  return {
    owner: 'source_document',
    sourceRecordId: row.id,
    sourceVersion: row.ingestedAt.toISOString(),
    contentSha256: digest(row),
  };
}

function sourceDocumentIds(evidence: EvidenceRef[]): string[] {
  return [
    ...new Set(
      evidence
        .filter((ref) => ref.kind === 'source' && typeof ref.sourceDocumentId === 'string')
        .map((ref) => ref.sourceDocumentId!),
    ),
  ];
}

function authorizedEvidence(
  evidence: EvidenceRef[],
  documents: ReadonlyMap<string, SourceDocumentRow>,
): { evidence: EvidenceRef[]; complete: boolean; linkedSourceProofs: LinkedSourceProof[] } {
  let complete = true;
  const linked = new Map<string, LinkedSourceProof>();
  const projected: EvidenceRef[] = [];
  for (const ref of evidence) {
    if (ref.kind !== 'source') {
      projected.push(ref);
      continue;
    }
    const id = typeof ref.sourceDocumentId === 'string' ? ref.sourceDocumentId : null;
    const document = id ? documents.get(id) : null;
    if (!id || !document) {
      complete = false;
      continue;
    }
    if (ref.note !== undefined) complete = false;
    projected.push({
      kind: 'source',
      sourceDocumentId: id,
      ...(Number.isSafeInteger(ref.page) && Number(ref.page) > 0 ? { page: ref.page } : {}),
    });
    linked.set(id, sourceDocumentProof(document));
  }
  return { evidence: projected, complete, linkedSourceProofs: [...linked.values()] };
}

@Injectable()
export class ActionRecommendationReadService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List action cards for the caller's tenant, filtered + sorted + paginated.
   *
   * Default sort is `deadline` ASC with NULLs last, then `priority` DESC (most urgent
   * dated cards first, undated cards after, ties broken by priority). `sort=priority`
   * orders by priority DESC then deadline ASC nulls-last. RLS already constrains the
   * rows to the caller's tenant; the explicit `tenantId` predicate is belt-and-braces.
   */
  async list(ctx: TenantContext, query: ListActionsQuery): Promise<ListActionsResult> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = clampLimit(query.limit);
    const sort: ActionSort = query.sort === 'priority' ? 'priority' : 'deadline';

    const where: Prisma.ActionRecommendationWhereInput = { tenantId: ctx.tenantId };
    if (query.status) where.status = query.status;
    if (query.clientId) where.clientId = query.clientId;

    // Prisma emits `NULLS LAST` for a `{ sort, nulls }` ordering, giving us
    // deadline-first-with-undated-last in one query.
    const orderBy: Prisma.ActionRecommendationOrderByWithRelationInput[] =
      sort === 'priority'
        ? [{ priority: 'desc' }, { deadline: { sort: 'asc', nulls: 'last' } }]
        : [{ deadline: { sort: 'asc', nulls: 'last' } }, { priority: 'desc' }];

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.actionRecommendation.findMany({
          where,
          select: cardSelect,
          orderBy,
          skip: (page - 1) * limit,
          take: limit,
        }),
        tx.actionRecommendation.count({ where }),
      ]);
      return {
        data: rows.map(toCard),
        total,
        page,
        limit,
      };
    });
  }

  /** Canonical client-scoped Meri recommendation owner with current wall checks. */
  async readMeriActionItemsExact(
    ctx: TenantContext,
    query: ListActionsQuery & { clientId: string; actionItemId: string | null },
  ): Promise<
    ListActionsResult & {
      sourceStatus: 'healthy' | 'degraded';
      sourceReason: string | null;
    }
  > {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = clampLimit(query.limit);
    const sort: ActionSort = query.sort === 'priority' ? 'priority' : 'deadline';
    const where: Prisma.ActionRecommendationWhereInput = {
      tenantId: ctx.tenantId,
      clientId: query.clientId,
      ...(query.actionItemId ? { id: query.actionItemId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const orderBy: Prisma.ActionRecommendationOrderByWithRelationInput[] =
      sort === 'priority'
        ? [{ priority: 'desc' }, { deadline: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }]
        : [{ deadline: { sort: 'asc', nulls: 'last' } }, { priority: 'desc' }, { id: 'asc' }];

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const authorize = async () => {
        const client = await tx.client.findFirst({
          where: { id: query.clientId, tenantId: ctx.tenantId, status: { not: 'archived' } },
          select: { id: true },
        });
        if (!client || !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, query.clientId)))
          throw new NotFoundException('Client not found');
      };
      await authorize();
      const [candidates, initialTotal] = await Promise.all([
        tx.actionRecommendation.findMany({
          where,
          select: cardSelect,
          orderBy,
          skip: (page - 1) * limit,
          take: limit,
        }),
        tx.actionRecommendation.count({ where }),
      ]);
      const rows = [] as Array<
        (typeof candidates)[number] & { linkedSourceProofs?: LinkedSourceProof[] }
      >;
      let sourceChanged = false;
      for (const candidate of candidates) {
        const current = await tx.actionRecommendation.findFirst({
          where: { ...where, id: candidate.id },
          select: cardSelect,
        });
        await authorize();
        if (!current) {
          sourceChanged = true;
          continue;
        }
        if (digest(toCard(current)) !== digest(toCard(candidate))) sourceChanged = true;
        const ids = sourceDocumentIds((current.evidence as unknown as EvidenceRef[]) ?? []);
        let documents = new Map<string, SourceDocumentRow>();
        if (ids.length) {
          const sourceWhere: Prisma.SourceDocumentWhereInput = {
            id: { in: ids },
            supersededByDocumentId: null,
          };
          const initialSources = await tx.sourceDocument.findMany({
            where: sourceWhere,
            select: sourceDocumentSelect,
          });
          await authorize();
          const currentSources = await tx.sourceDocument.findMany({
            where: sourceWhere,
            select: sourceDocumentSelect,
          });
          await authorize();
          const initialProof = initialSources.map(sourceDocumentProof);
          const currentProof = currentSources.map(sourceDocumentProof);
          if (digest(initialProof) !== digest(currentProof)) sourceChanged = true;
          documents = new Map(currentSources.map((source) => [source.id, source]));
        }
        const projected = authorizedEvidence(
          (current.evidence as unknown as EvidenceRef[]) ?? [],
          documents,
        );
        if (!projected.complete) sourceChanged = true;
        rows.push({
          ...current,
          evidence: projected.evidence as unknown as Prisma.JsonArray,
          linkedSourceProofs: projected.linkedSourceProofs,
        });
      }
      const total = await tx.actionRecommendation.count({ where });
      if (total !== initialTotal) sourceChanged = true;
      await authorize();
      return {
        data: rows.map(toCard),
        total,
        page,
        limit,
        sourceStatus: sourceChanged ? 'degraded' : 'healthy',
        sourceReason: sourceChanged ? 'action_item_source_changed_during_read' : null,
      };
    });
  }

  /** Fetch a single card by id within the caller's tenant. 404 when not visible. */
  async getOne(ctx: TenantContext, id: string): Promise<ActionCard> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const row = await tx.actionRecommendation.findFirst({
        where: { id, tenantId: ctx.tenantId },
        select: cardSelect,
      });
      if (!row) throw new NotFoundException(`ActionRecommendation ${id} not found`);
      return toCard(row);
    });
  }

  /**
   * Change a card's workflow status (§19). Routes the proposed change through the pure
   * `validateTransition`; an illegal transition (or a dismiss without a reason) throws
   * 400 with the validator's own message. On success the new status — plus the dismissal
   * reason when dismissing — is persisted and an AuditLog (before/after) is written inside
   * the same tenant transaction.
   */
  async updateStatus(
    ctx: TenantContext,
    id: string,
    next: ActionStatus,
    dismissalReason?: string,
  ): Promise<ActionCard> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const current = await tx.actionRecommendation.findFirst({
        where: { id, tenantId: ctx.tenantId },
        select: { id: true, status: true, dismissalReason: true },
      });
      if (!current) throw new NotFoundException(`ActionRecommendation ${id} not found`);

      const result = validateTransition(current.status as ActionStatus, next, {
        dismissalReason,
      });
      if (!result.ok) throw new BadRequestException(result.error);

      // Tenant-scoped write (defence-in-depth on top of RLS + the findFirst above):
      // updateMany's `where` re-asserts the tenant, and a 0 count means the row
      // vanished/was-stolen between read and write — treat as NotFound, never a silent no-op.
      const { count } = await tx.actionRecommendation.updateMany({
        where: { id, tenantId: ctx.tenantId },
        data: {
          status: next,
          // Persist the reason only when dismissing; other transitions leave it as-is.
          ...(next === 'dismissed' ? { dismissalReason: dismissalReason ?? null } : {}),
        },
      });
      if (count !== 1) throw new NotFoundException(`ActionRecommendation ${id} not found`);

      const updated = await tx.actionRecommendation.findFirst({
        where: { id, tenantId: ctx.tenantId },
        select: cardSelect,
      });
      if (!updated) throw new NotFoundException(`ActionRecommendation ${id} not found`);

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'intelligence.action.status',
          entityType: 'action_recommendation',
          entityId: id,
          before: { status: current.status, dismissalReason: current.dismissalReason },
          after: { status: next, dismissalReason: updated.dismissalReason },
        },
      });

      return toCard(updated);
    });
  }

  /**
   * Assign or clear a card's owner. Persists `ownerUserId` (null clears it) and writes an
   * AuditLog (before/after) inside the tenant transaction.
   */
  async updateOwner(
    ctx: TenantContext,
    id: string,
    ownerUserId: string | null,
  ): Promise<ActionCard> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const current = await tx.actionRecommendation.findFirst({
        where: { id, tenantId: ctx.tenantId },
        select: { id: true, ownerUserId: true },
      });
      if (!current) throw new NotFoundException(`ActionRecommendation ${id} not found`);

      // Tenant-scoped write (defence-in-depth on top of RLS + the findFirst above).
      const { count } = await tx.actionRecommendation.updateMany({
        where: { id, tenantId: ctx.tenantId },
        data: { ownerUserId },
      });
      if (count !== 1) throw new NotFoundException(`ActionRecommendation ${id} not found`);

      const updated = await tx.actionRecommendation.findFirst({
        where: { id, tenantId: ctx.tenantId },
        select: cardSelect,
      });
      if (!updated) throw new NotFoundException(`ActionRecommendation ${id} not found`);

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'intelligence.action.owner',
          entityType: 'action_recommendation',
          entityId: id,
          before: { ownerUserId: current.ownerUserId },
          after: { ownerUserId },
        },
      });

      return toCard(updated);
    });
  }
}

/** Clamp a requested page size into [1, MAX_LIMIT], defaulting to DEFAULT_LIMIT. */
function clampLimit(limit?: number): number {
  if (!limit || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

/** Map a selected row (with joined client) to the API ActionCard shape. */
function toCard(
  row: Prisma.ActionRecommendationGetPayload<{ select: typeof cardSelect }> & {
    linkedSourceProofs?: LinkedSourceProof[];
  },
): ActionCard {
  return {
    id: row.id,
    districtKey: row.districtKey,
    clientId: row.clientId,
    clientName: row.client?.name ?? undefined,
    peCode: row.peCode,
    programId: row.programId,
    deltaId: row.deltaId,
    actionType: row.actionType as ActionType,
    issueTitle: row.issueTitle,
    whatChanged: row.whatChanged,
    whyItMatters: row.whyItMatters,
    recommendedAction: row.recommendedAction,
    targetAudience: (row.targetAudience as unknown as AudienceMember[]) ?? [],
    suggestedArtifactType: row.suggestedArtifactType,
    deadline: row.deadline ? row.deadline.toISOString() : null,
    deadlineSource: (row.deadlineSource as DeadlineSource | null) ?? null,
    ownerUserId: row.ownerUserId,
    priority: row.priority,
    confidence: (row.confidence as unknown as ConfidenceBands) ?? {},
    uncertainty: row.uncertainty,
    evidence: (row.evidence as unknown as EvidenceRef[]) ?? [],
    status: row.status as ActionStatus,
    dismissalReason: row.dismissalReason,
    outcome: row.outcome,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.linkedSourceProofs ? { linkedSourceProofs: row.linkedSourceProofs } : {}),
  };
}
