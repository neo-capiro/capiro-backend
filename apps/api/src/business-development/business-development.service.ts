import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import { fingerprintName } from '../intelligence/entity-resolution.service.js';
import { ClientsService } from '../clients/clients.service.js';
import { EntityResolutionService } from '../intelligence/entity-resolution.service.js';
import { ClientPrepopulationService } from '../intelligence/client-prepopulation.service.js';
import { SamEntityEnrichmentService } from '../intelligence/sam-entity.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BIZDEV_JEV_REVIEW_HOOK, type BizDevJevReviewHook } from './bizdev-jev.service.js';
import { Inject, Optional } from '@nestjs/common';
import type { BizDevStage } from './business-development.dto.js';

/**
 * Transaction-scoped advisory lock keyed by (tenant, canonical entity) —
 * Postgres pg_advisory_xact_lock on two signed 32-bit hash keys derived from
 * the two UUIDs. Used to
 * serialize confirmed-prospect create and identity resolution so two
 * concurrent requests can NEVER both pass the find-then-create gap (the DB
 * partial unique remains the last-resort backstop). The lock is released
 * automatically when the transaction commits/rolls back.
 */
async function lockTenantCanonical(
  tx: Prisma.TransactionClient,
  tenantId: string,
  canonicalEntityId: string,
): Promise<void> {
  const key = hashTenantCanonical(tenantId, canonicalEntityId);
  // PostgreSQL exposes pg_advisory_xact_lock(bigint) and
  // pg_advisory_xact_lock(integer, integer), but no (bigint, bigint)
  // overload. Keep both values in the signed int32 range and select the
  // two-key overload explicitly.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key.hi}::integer, ${key.lo}::integer)`;
}

/** FNV-1a based 128-bit split of (tenantId, canonicalEntityId). */
function hashTenantCanonical(
  tenantId: string,
  canonicalEntityId: string,
): { hi: number; lo: number } {
  const combined = `${tenantId}:${canonicalEntityId}`;
  let hi = 0x811c9dc5;
  let lo = 0x811c9dc5;
  for (let i = 0; i < combined.length; i += 1) {
    const c = combined.charCodeAt(i);
    hi = (hi ^ c) >>> 0;
    hi = Math.imul(hi, 0x01000193) >>> 0;
    lo = (lo ^ ((c << 3) | (c >>> 5))) >>> 0;
    lo = Math.imul(lo, 0x01000193) >>> 0;
  }
  return { hi: hi | 0, lo: lo | 0 };
}

/** Normalize a domain/website string for advisory hint matching: lowercase,
 * strip scheme/path/www prefix. Advisory-only (tenant-scoped, never persisted
 * to shared canonical rows). */
export function normalizeDomainHint(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  s =
    s
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .split('/')[0]
      ?.split('?')[0] ?? '';
  s = s.replace(/^www\./, '');
  return s || null;
}

/**
 * Business Development Phase 1 — a firm's private prospect pipeline.
 *
 * ── Invariants this service enforces on EVERY query ──────────────────────────
 * 1. Every request uses EXPLICIT `tenantId` predicates inside
 *    `prisma.withTenant`. The database RLS (FORCE + isolation policies on all
 *    three tables) is defense in depth ONLY: the runtime app role can bypass
 *    RLS, so the explicit predicate is the real isolation boundary.
 * 2. Guessed ids / cross-tenant ids all return the SAME safe
 *    NotFoundException('Prospect not found') — indistinguishable from a
 *    nonexistent row, so id-enumeration leaks nothing.
 * 3. Owner changes validate an ACTIVE TenantMembership of the same tenant
 *    inside the same transaction as the mutation.
 * 4. A confirmed canonical-organization prospect is unique per (tenant,
 *    canonical entity) INCLUDING dismissed rows (DB partial unique); the
 *    create path RESTORES the dismissed duplicate instead of failing.
 *    Unresolved (manual) prospects have NO name uniqueness — two same-name
 *    research records coexist by design.
 * 5. Conversion is a single transaction: claim the prospect (atomic
 *    compare-and-set on linkedClientId), link-or-create the client, write the
 *    activity + audit rows, and roll back together. Enrichment
 *    (entity-resolution / prepopulation / SAM) is scheduled only AFTER the
 *    outer transaction commits, and never for a simple link-existing.
 * 6. Setting stage `won` NEVER converts — conversion is its own operation.
 * 7. Private data (note bodies, conflict reasons, hypotheses) never leaves
 *    the tenant; nothing is written to shared canonical rows.
 */

const PROSPECT_NOT_FOUND = 'Prospect not found';
/** Bounded result sizes for lookups/autocomplete. */
const MAX_SEARCH_LIMIT_DEFAULT = 10;
const MAX_SEARCH_LIMIT_CAP = 25;

const prospectSelect = {
  id: true,
  tenantId: true,
  canonicalEntityId: true,
  displayName: true,
  domain: true,
  website: true,
  description: true,
  serviceHypothesis: true,
  geography: true,
  ownerUserId: true,
  stage: true,
  status: true,
  dismissedAt: true,
  conflictExcluded: true,
  conflictReason: true,
  nextAction: true,
  nextActionDueAt: true,
  linkedClientId: true,
  convertedAt: true,
  watchRequested: true,
  createdByUserId: true,
  createdAt: true,
  updatedAt: true,
  canonicalEntity: {
    select: { id: true, canonicalName: true, normalizedName: true, entityType: true },
  },
  linkedClient: { select: { id: true, name: true, status: true } },
} satisfies Prisma.BusinessDevelopmentProspectSelect;

const duplicateHintSelect = {
  id: true,
  displayName: true,
  domain: true,
  website: true,
  canonicalEntityId: true,
  stage: true,
  status: true,
  linkedClientId: true,
  ownerUserId: true,
  updatedAt: true,
} satisfies Prisma.BusinessDevelopmentProspectSelect;

type ProspectRow = Prisma.BusinessDevelopmentProspectGetPayload<{
  select: typeof prospectSelect;
}>;

export interface ProspectListResult {
  prospects: ProspectRow[];
  counts: {
    /** Rows in the current active/dismissed/all scope after all filters. */
    visible: number;
    /** Active + dismissed rows after the non-status filters (tab badges). */
    total: number;
    active: number;
    dismissed: number;
    byStage: Record<string, number>;
  };
}

@Injectable()
export class BusinessDevelopmentService {
  private readonly logger = new Logger(BusinessDevelopmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clients: ClientsService,
    private readonly entityResolution: EntityResolutionService,
    private readonly prepopulation: ClientPrepopulationService,
    private readonly samEntity: SamEntityEnrichmentService,
    /** Phase 3 — optional Jev review-metadata hook (best-effort, never in-transaction). */
    @Optional() @Inject(BIZDEV_JEV_REVIEW_HOOK)
    private readonly jevReview?: BizDevJevReviewHook,
  ) {}

  // ── reads ────────────────────────────────────────────────────────────────

  async list(
    ctx: TenantContext,
    query: {
      status?: 'active' | 'dismissed' | 'all';
      stage?: BizDevStage;
      includeDismissed?: boolean;
      ownerId?: string;
      conflictExcluded?: boolean;
      linkedClient?: boolean;
      search?: string;
      limit?: number;
    } = {},
  ): Promise<ProspectListResult> {
    // Status slice: active (default), dismissed, or all. includeDismissed is
    // the legacy alias for all.
    const status = query.status ?? (query.includeDismissed ? 'all' : 'active');

    // Non-status filters apply identically to the rows AND the counts so the
    // count chips always match the list the user is looking at.
    const nonStatus: Prisma.BusinessDevelopmentProspectWhereInput = {
      tenantId: ctx.tenantId,
    };
    if (query.stage) nonStatus.stage = query.stage;
    if (query.ownerId) nonStatus.ownerUserId = query.ownerId;
    if (query.conflictExcluded !== undefined) nonStatus.conflictExcluded = query.conflictExcluded;
    if (query.linkedClient !== undefined)
      nonStatus.linkedClientId = query.linkedClient === true ? { not: null } : null;
    if (query.search?.trim()) {
      nonStatus.displayName = { contains: query.search.trim(), mode: 'insensitive' };
    }

    const where: Prisma.BusinessDevelopmentProspectWhereInput = {
      ...nonStatus,
    };
    if (status === 'active') where.status = 'active';
    else if (status === 'dismissed') where.status = 'dismissed';
    const limit = Math.min(query.limit ?? MAX_SEARCH_LIMIT_CAP * 4, 200);

    const activeWhere: Prisma.BusinessDevelopmentProspectWhereInput = {
      ...nonStatus,
      status: 'active',
    };
    const dismissedWhere: Prisma.BusinessDevelopmentProspectWhereInput = {
      ...nonStatus,
      status: 'dismissed',
    };

    const [prospects, visibleCounts, activeCount, dismissedCount] = await this.prisma.withTenant(
      ctx.tenantId,
      async (tx) => {
        const prospects = await tx.businessDevelopmentProspect.findMany({
          where,
          orderBy: { updatedAt: 'desc' },
          take: limit,
          select: prospectSelect,
        });
        const [totalByStage, active, dismissed] = await Promise.all([
          tx.businessDevelopmentProspect.groupBy({
            by: ['stage'],
            where,
            _count: { _all: true },
          }),
          tx.businessDevelopmentProspect.count({ where: activeWhere }),
          tx.businessDevelopmentProspect.count({ where: dismissedWhere }),
        ]);
        return [prospects, totalByStage, active, dismissed] as const;
      },
    );

    const byStage: Record<string, number> = {};
    let visible = 0;
    for (const g of visibleCounts) {
      byStage[g.stage] = g._count._all;
      visible += g._count._all;
    }
    return {
      prospects,
      counts: {
        visible,
        total: activeCount + dismissedCount,
        active: activeCount,
        dismissed: dismissedCount,
        byStage,
      },
    };
  }

  async get(ctx: TenantContext, id: string): Promise<ProspectRow> {
    return this.findOwned(ctx, id);
  }

  /** Ordered activity/history for a prospect (oldest → newest). */
  async history(ctx: TenantContext, id: string) {
    await this.findOwned(ctx, id);
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.businessDevelopmentProspectActivity.findMany({
        // tenantId predicate is redundant with prospectId here only because
        // the prospect was already verified tenant-owned; keep it explicit
        // anyway (invariant 1).
        where: { tenantId: ctx.tenantId, prospectId: id },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  // ── create ───────────────────────────────────────────────────────────────

  /**
   * Create a prospect. Two modes:
   * - `canonicalEntityId` absent → unresolved MANUAL prospect (displayName
   *   required, no name uniqueness — duplicates coexist).
   * - `canonicalEntityId` present → confirmed canonical-organization prospect.
   *   The canonical entity is validated visible-under-identity-rules in the
   *   same transaction. A prior prospect for the same (tenant, canonical) —
   *   INCLUDING a dismissed one — is a duplicate: we open/RESTORE it instead
   *   of creating a second row.
   */
  async create(
    ctx: TenantContext,
    input: {
      canonicalEntityId?: string;
      displayName: string;
      domain?: string;
      website?: string;
      description?: string;
      serviceHypothesis?: string;
      geography?: string;
      ownerUserId?: string;
      stage?: BizDevStage;
    },
  ): Promise<ProspectRow> {
    const displayName = input.displayName?.trim();
    if (!displayName) throw new BadRequestException('displayName is required');

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // The EFFECTIVE owner (explicit or the acting user) must be an ACTIVE
      // member of this tenant, validated in the same transaction as the
      // insert. Explicit-null owners are an update-only concept.
      await this.assertActiveMember(tx, ctx.tenantId, input.ownerUserId ?? ctx.userId);

      if (input.canonicalEntityId) {
        // Validate the canonical entity under the identity rules: global
        // public rows are shared; tenant-private rows are visible only to
        // their owning tenant. A merged-away row is not confirmable.
        const canonical = await this.findVisibleCanonicalOrganizationTx(
          tx,
          ctx.tenantId,
          input.canonicalEntityId,
        );
        if (!canonical) throw new NotFoundException('Canonical entity not found');

        // Serialize (tenant, canonical) create: acquire the transaction-
        // scoped advisory lock BEFORE the duplicate find so a concurrent
        // create for the same confirmed org cannot slip through the
        // find-then-create gap. (The DB partial unique is the backstop.)
        await lockTenantCanonical(tx, ctx.tenantId, input.canonicalEntityId);

        // Same-firm duplicate for the SAME confirmed canonical entity: open
        // or restore the existing prospect instead of a second row.
        const existing = await tx.businessDevelopmentProspect.findFirst({
          where: { tenantId: ctx.tenantId, canonicalEntityId: input.canonicalEntityId },
          select: prospectSelect,
        });
        if (existing && existing.status === 'active') {
          // Active duplicate: return it UNCHANGED — a second create request
          // must never overwrite the active record (idempotent open).
          return existing;
        }
        if (existing) {
          // Dismissed duplicate: restore it (with a restore activity + audit)
          // rather than creating a second row the partial unique would reject.
          const restored = await tx.businessDevelopmentProspect.update({
            where: { id: existing.id },
            data: {
              // Restore a dismissed duplicate; refresh surface details.
              status: 'active',
              dismissedAt: null,
              displayName,
              domain: input.domain ?? existing.domain,
              website: input.website ?? existing.website,
              description: input.description ?? existing.description,
              serviceHypothesis: input.serviceHypothesis ?? existing.serviceHypothesis,
              geography: input.geography ?? existing.geography,
              ownerUserId: input.ownerUserId ?? existing.ownerUserId,
              canonicalEntityId: input.canonicalEntityId,
            },
            select: prospectSelect,
          });
          await this.activity(
            tx,
            ctx,
            restored.id,
            'restore',
            'Re-opened as a duplicate of an existing confirmed prospect',
            {
              before: { status: existing.status, stage: existing.stage },
              after: { status: restored.status, stage: restored.stage },
            },
          );
          await this.audit(
            tx,
            ctx,
            'bizdev.prospect.restore',
            'business_development_prospect',
            restored.id,
            { status: existing.status },
            { status: restored.status, source: 'confirmed_duplicate_create' },
          );
          return restored;
        }

        const created = await tx.businessDevelopmentProspect.create({
          data: {
            tenantId: ctx.tenantId,
            canonicalEntityId: input.canonicalEntityId,
            displayName,
            stage: input.stage ?? 'researching',
            domain: input.domain ?? null,
            website: input.website ?? null,
            description: input.description ?? null,
            serviceHypothesis: input.serviceHypothesis ?? null,
            geography: input.geography ?? null,
            ownerUserId: input.ownerUserId ?? ctx.userId,
            createdByUserId: ctx.userId,
          },
          select: prospectSelect,
        });
        await this.activity(tx, ctx, created.id, 'identity', 'Confirmed canonical organization', {
          after: { canonicalEntityId: input.canonicalEntityId },
        });
        await this.audit(
          tx,
          ctx,
          'bizdev.prospect.create',
          'business_development_prospect',
          created.id,
          null,
          {
            canonicalEntityId: input.canonicalEntityId,
            displayName,
          },
        );
        return created;
      }

      // Manual unresolved prospect — no name/domain uniqueness by design.
      const created = await tx.businessDevelopmentProspect.create({
        data: {
          tenantId: ctx.tenantId,
          displayName,
          domain: input.domain ?? null,
          website: input.website ?? null,
          description: input.description ?? null,
          serviceHypothesis: input.serviceHypothesis ?? null,
          geography: input.geography ?? null,
          ownerUserId: input.ownerUserId ?? ctx.userId,
          stage: input.stage ?? 'researching',
          createdByUserId: ctx.userId,
        },
        select: prospectSelect,
      });
      await this.audit(
        tx,
        ctx,
        'bizdev.prospect.create',
        'business_development_prospect',
        created.id,
        null,
        {
          displayName,
          unresolved: true,
          stage: input.stage ?? 'researching',
        },
      );
      return created;
    });
  }

  // ── duplicate hints (no mutation) ────────────────────────────────────────

  /**
   * Same-firm duplicate hints for a manual prospect: other ACTIVE prospects
   * of this tenant whose display name fingerprint-matches. Uses the SAME
   * fingerprintName as entity resolution — no canonical merge, no global
   * writeback, purely advisory.
   */
  async duplicateHints(ctx: TenantContext, id: string) {
    const prospect = await this.findOwned(ctx, id);
    return {
      hints: await this.findDuplicateHints(ctx, {
        displayName: prospect.displayName,
        domain: prospect.domain,
        website: prospect.website,
        canonicalEntityId: prospect.canonicalEntityId,
        excludeId: id,
      }),
    };
  }

  /**
   * Advisory duplicate check before create. This is deliberately tenant-only
   * and read-only: unresolved records may still be saved separately after the
   * user reviews the hints, while an exact confirmed identity should be opened
   * or restored instead of silently duplicated.
   */
  async previewDuplicateHints(
    ctx: TenantContext,
    input: {
      displayName: string;
      domain?: string;
      website?: string;
      canonicalEntityId?: string;
    },
  ) {
    const displayName = input.displayName?.trim();
    if (!displayName) throw new BadRequestException('displayName is required');
    return {
      hints: await this.findDuplicateHints(ctx, {
        displayName,
        domain: input.domain,
        website: input.website,
        canonicalEntityId: input.canonicalEntityId,
      }),
    };
  }

  // ── update ───────────────────────────────────────────────────────────────

  async update(
    ctx: TenantContext,
    id: string,
    input: {
      displayName?: string;
      domain?: string;
      website?: string;
      description?: string;
      serviceHypothesis?: string;
      geography?: string;
      ownerUserId?: string | null;
      stage?: BizDevStage;
      nextAction?: string | null;
      nextActionDueAt?: string | null;
      watchRequested?: boolean;
    },
  ): Promise<ProspectRow> {
    if (input.displayName !== undefined && !input.displayName.trim()) {
      throw new BadRequestException('displayName cannot be blank');
    }
    if (input.nextActionDueAt !== undefined && input.nextActionDueAt !== null) {
      const due = new Date(input.nextActionDueAt);
      if (Number.isNaN(due.getTime())) {
        throw new BadRequestException('nextActionDueAt must be a valid ISO date');
      }
    }
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const before = await this.findOwnedTx(tx, ctx.tenantId, id);

      // Owner change: validate ACTIVE membership of THIS tenant in the same
      // transaction as the mutation (a null owner is "unassigned", allowed).
      if (input.ownerUserId !== undefined && input.ownerUserId !== null) {
        await this.assertActiveMember(tx, ctx.tenantId, input.ownerUserId);
      }

      const data: Prisma.BusinessDevelopmentProspectUpdateInput = {};
      if (input.displayName !== undefined) data.displayName = input.displayName.trim();
      if (input.domain !== undefined) data.domain = input.domain;
      if (input.website !== undefined) data.website = input.website;
      if (input.description !== undefined) data.description = input.description;
      if (input.serviceHypothesis !== undefined) data.serviceHypothesis = input.serviceHypothesis;
      if (input.geography !== undefined) data.geography = input.geography;
      if (input.nextAction !== undefined) data.nextAction = input.nextAction;
      if (input.nextActionDueAt !== undefined) {
        // Nullable clearing: explicit null clears the due date.
        data.nextActionDueAt =
          input.nextActionDueAt === null ? null : new Date(input.nextActionDueAt);
      }
      if (input.watchRequested !== undefined) data.watchRequested = input.watchRequested;
      if (input.ownerUserId !== undefined) {
        // Scalar column (no User relation by design — plain UUID): set
        // directly; null means "unassigned".
        data.ownerUserId = input.ownerUserId;
      }

      // Stage Won alone NEVER converts (invariant 6): the stage column moves,
      // linkedClientId/convertedAt are untouched here.
      if (input.stage !== undefined && input.stage !== before.stage) {
        data.stage = input.stage;
      }

      const after = await tx.businessDevelopmentProspect.update({
        where: { id },
        data,
        select: prospectSelect,
      });

      if (input.watchRequested !== undefined && input.watchRequested !== before.watchRequested) {
        await this.activity(
          tx,
          ctx,
          id,
          'watch',
          input.watchRequested ? 'Watch requested' : 'Watch request cleared',
          {
            before: { watchRequested: before.watchRequested },
            after: { watchRequested: after.watchRequested },
          },
        );
        await this.audit(
          tx,
          ctx,
          'bizdev.prospect.watch',
          'business_development_prospect',
          id,
          {
            watchRequested: before.watchRequested,
          },
          { watchRequested: after.watchRequested },
        );
      }

      if (input.stage !== undefined && input.stage !== before.stage) {
        await this.activity(tx, ctx, id, 'stage', `Stage ${before.stage} → ${input.stage}`, {
          before: { stage: before.stage },
          after: { stage: input.stage },
        });
        await this.audit(
          tx,
          ctx,
          'bizdev.prospect.stage',
          'business_development_prospect',
          id,
          {
            stage: before.stage,
          },
          { stage: input.stage },
        );
      }
      if (input.ownerUserId !== undefined && input.ownerUserId !== before.ownerUserId) {
        await this.activity(tx, ctx, id, 'owner', 'Owner changed', {
          before: { ownerUserId: before.ownerUserId },
          after: { ownerUserId: input.ownerUserId ?? null },
        });
        await this.audit(
          tx,
          ctx,
          'bizdev.prospect.owner',
          'business_development_prospect',
          id,
          {
            ownerUserId: before.ownerUserId,
          },
          { ownerUserId: input.ownerUserId ?? null },
        );
      }
      return after;
    });
  }

  /** Add a private note; returns the ordered activity list for the prospect. */
  async addNote(ctx: TenantContext, id: string, body: string) {
    const note = body?.trim();
    if (!note) throw new BadRequestException('Note body is required');
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.findOwnedTx(tx, ctx.tenantId, id);
      await tx.businessDevelopmentProspectActivity.create({
        data: {
          tenantId: ctx.tenantId,
          prospectId: id,
          actorUserId: ctx.userId,
          kind: 'note',
          body: note,
        },
      });
      return tx.businessDevelopmentProspectActivity.findMany({
        where: { tenantId: ctx.tenantId, prospectId: id },
        orderBy: { createdAt: 'asc' },
      });
    });
  }

  // ── conflict / exclusion (admin-only writes at the controller) ───────────

  async updateConflict(
    ctx: TenantContext,
    id: string,
    input: { conflictExcluded: boolean; conflictReason?: string },
  ): Promise<ProspectRow> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const before = await this.findOwnedTx(tx, ctx.tenantId, id);
      // The reason is only meaningful when excluding; clear it otherwise so a
      // stale sensitive reason never lingers on a re-included prospect.
      const after = await tx.businessDevelopmentProspect.update({
        where: { id },
        data: {
          conflictExcluded: input.conflictExcluded,
          conflictReason: input.conflictExcluded ? (input.conflictReason ?? null) : null,
        },
        select: prospectSelect,
      });
      await this.activity(
        tx,
        ctx,
        id,
        'conflict',
        input.conflictExcluded ? 'Marked conflict / excluded' : 'Conflict exclusion cleared',
        {
          before: { conflictExcluded: before.conflictExcluded },
          after: { conflictExcluded: after.conflictExcluded },
        },
      );
      await this.audit(
        tx,
        ctx,
        'bizdev.prospect.conflict',
        'business_development_prospect',
        id,
        {
          conflictExcluded: before.conflictExcluded,
        },
        { conflictExcluded: after.conflictExcluded },
      );
      return after;
    });
  }

  // ── dismiss / restore ────────────────────────────────────────────────────

  async dismiss(ctx: TenantContext, id: string, reason?: string): Promise<ProspectRow> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const before = await this.findOwnedTx(tx, ctx.tenantId, id);
      if (before.status === 'dismissed') return before;
      const after = await tx.businessDevelopmentProspect.update({
        where: { id },
        data: { status: 'dismissed', dismissedAt: new Date() },
        select: prospectSelect,
      });
      await this.activity(tx, ctx, id, 'dismiss', reason?.trim() || 'Dismissed', {
        before: { status: before.status },
        after: { status: after.status },
      });
      await this.audit(
        tx,
        ctx,
        'bizdev.prospect.dismiss',
        'business_development_prospect',
        id,
        {
          status: before.status,
        },
        { status: after.status },
      );
      return after;
    });
  }

  async restore(ctx: TenantContext, id: string): Promise<ProspectRow> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const before = await this.findOwnedTx(tx, ctx.tenantId, id);
      if (before.status === 'active') return before;
      const after = await tx.businessDevelopmentProspect.update({
        where: { id },
        data: { status: 'active', dismissedAt: null },
        select: prospectSelect,
      });
      await this.activity(tx, ctx, id, 'restore', 'Restored', {
        before: { status: before.status },
        after: { status: after.status },
      });
      await this.audit(
        tx,
        ctx,
        'bizdev.prospect.restore',
        'business_development_prospect',
        id,
        {
          status: before.status,
        },
        { status: after.status },
      );
      return after;
    });
  }

  // ── preferences ──────────────────────────────────────────────────────────

  /** Readable by any member. */
  async getPreferences(ctx: TenantContext) {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.businessDevelopmentPreference.findFirst({ where: { tenantId: ctx.tenantId } }),
    );
  }

  /** Writable only by user_admin / capiro_admin (controller-level @Roles). */
  async savePreferences(
    ctx: TenantContext,
    input: {
      practiceServiceAreas?: string[];
      agenciesIssues?: string[];
      geographies?: string[];
    },
  ) {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.businessDevelopmentPreference.upsert({
        where: { tenantId: ctx.tenantId },
        create: {
          tenantId: ctx.tenantId,
          practiceServiceAreas: input.practiceServiceAreas ?? [],
          agenciesIssues: input.agenciesIssues ?? [],
          geographies: input.geographies ?? [],
        },
        update: {
          practiceServiceAreas: input.practiceServiceAreas ?? [],
          agenciesIssues: input.agenciesIssues ?? [],
          geographies: input.geographies ?? [],
        },
      }),
    );
  }

  // ── owner options ────────────────────────────────────────────────────────

  /** Active members of THIS tenant only — owner assignment options. */
  async memberOptions(ctx: TenantContext) {
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.tenantMembership.findMany({
        where: { tenantId: ctx.tenantId, status: 'active' },
        select: {
          userId: true,
          user: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return {
      members: rows
        .filter((r) => r.user)
        .map((r) => ({
          id: r.user!.id,
          firstName: r.user!.firstName,
          lastName: r.user!.lastName,
          email: r.user!.email,
        })),
    };
  }

  // ── bounded lookups ─────────────────────────────────────────────────────

  /**
   * Canonical organization search, bounded, limited to records visible under
   * the existing identity rules: global_public rows (shared registry) plus
   * THIS tenant's tenant_private rows. No cross-tenant leak: another firm's
   * private rows are invisible here even though the app role bypasses RLS.
   */
  async searchCanonicalOrganizations(ctx: TenantContext, q: string, limit?: number) {
    const term = q?.trim();
    if (!term) return { results: [] };
    const take = Math.min(limit ?? MAX_SEARCH_LIMIT_DEFAULT, MAX_SEARCH_LIMIT_CAP);
    // CanonicalEntity is a mixed-scope table (global_public rows have
    // tenant_id NULL). PrismaService's generic tenant extension scopes every
    // model that has a tenantId field, which would silently add
    // tenant_id=<current tenant> and hide every global_public organization.
    // Parameterized SQL keeps the intended visibility rule explicit and
    // reviewable while remaining inside the tenant transaction.
    const rows = await this.prisma.withTenant(
      ctx.tenantId,
      (tx) =>
        tx.$queryRaw<
          Array<{
            id: string;
            canonicalName: string;
            normalizedName: string;
            identityScope: string;
            tenantId: string | null;
          }>
        >`SELECT
          "id",
          "canonical_name" AS "canonicalName",
          "normalized_name" AS "normalizedName",
          "identity_scope" AS "identityScope",
          "tenant_id" AS "tenantId"
        FROM "canonical_entities"
        WHERE "merged_into_entity_id" IS NULL
          AND "status" = 'active'
          AND "entity_type" = 'organization'
          AND ("identity_scope" = 'global_public' OR "tenant_id" = ${ctx.tenantId}::uuid)
          AND (
            "canonical_name" ILIKE ${`%${term}%`}
            OR "normalized_name" LIKE ${`%${term.toLowerCase()}%`}
          )
        ORDER BY "canonical_name" ASC
        LIMIT ${take}`,
    );
    return { results: rows };
  }

  /** Client candidate lookup, limited to this tenant, active (non-archived). */
  async searchClients(ctx: TenantContext, q: string, limit?: number) {
    const term = q?.trim();
    if (!term) return { results: [] };
    const take = Math.min(limit ?? MAX_SEARCH_LIMIT_DEFAULT, MAX_SEARCH_LIMIT_CAP);
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findMany({
        where: {
          tenantId: ctx.tenantId,
          status: { not: 'archived' },
          name: { contains: term, mode: 'insensitive' },
        },
        select: { id: true, name: true, canonicalEntityId: true },
        orderBy: { name: 'asc' },
        take,
      }),
    );
    return { results: rows };
  }

  // ── conversion: transactional, atomic, idempotent link-or-convert ────────

  /**
   * Convert (link or create a client for) a prospect. ONE transaction:
   *
   * 1. Row lock: `SELECT … FOR UPDATE` (id AND tenantId) on the prospect row
   *    is acquired BEFORE any client resolution/creation, so two concurrent
   *    conversions of the same prospect serialize; the loser re-reads under
   *    the lock and returns the actual same-tenant linked client without
   *    creating anything (idempotent retry, no orphan client).
   * 2. Link target, resolved IN ORDER inside the same transaction:
   *    a. explicit `existingClientId` → validated same-tenant, non-archived;
   *    b. an exact confirmed canonical client for this tenant
   *       (clients.canonical_entity_id partial unique) → link it;
   *    c. otherwise create exactly ONE client via ClientsService
   *       .createInTransaction (authoritative slot entitlement included).
   *       A slot is consumed only when a client row is actually created; a
   *       link-existing path never touches billing.
   * 3. Activity + audit rows are written in the same transaction.
   * 4. Enrichment (entity-resolution / prepopulation / SAM) is scheduled
   *    AFTER commit, only when a client was CREATED — never for
   *    link-existing. Failure there never rolls back the conversion.
   *
   * The prospect row and all its activity survive conversion (conversion is
   * only column updates on the prospect).
   */
  async convert(
    ctx: TenantContext,
    id: string,
    input: { existingClientId?: string; clientWebsite?: string; clientDescription?: string } = {},
  ): Promise<{ prospect: ProspectRow; client: { id: string; name: string }; created: boolean }> {
    const outcome = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // 1. ROW LOCK FIRST, before resolving/creating any client: SELECT … FOR
      //    UPDATE on the tenant-owned prospect serializes concurrent
      //    conversions of the same prospect. Both id and tenantId are in the
      //    predicate — a guessed/cross-tenant id locks/returns nothing.
      await tx.$queryRaw`SELECT "id" FROM "business_development_prospects"
        WHERE "id" = ${id}::uuid AND "tenant_id" = ${ctx.tenantId}::uuid
        FOR UPDATE`;

      // 2. Re-read under the lock. If another caller already linked it, return
      //    the ACTUAL same-tenant linked client — create nothing, orphan
      //    nothing. (Guessed ids hit the identical safe 404 here.)
      const current = await this.findOwnedTx(tx, ctx.tenantId, id);
      if (current.linkedClientId && current.convertedAt) {
        const linked = await tx.client.findFirst({
          where: { id: current.linkedClientId, tenantId: ctx.tenantId },
          select: { id: true, name: true },
        });
        if (linked) {
          return {
            clientId: linked.id,
            clientName: linked.name,
            created: false,
            ldaRegistrantId: null,
            alreadyLinked: true as const,
          };
        }
      }

      // 3. Resolve the link target (existing/confirmed/create), all inside
      //    this same transaction so any failure (bad client id, cross-tenant
      //    client, slot limit, unique violation) rolls back EVERYTHING — no
      //    orphan client can commit.
      let clientId: string;
      let clientName: string;
      let selectedClientCanonicalEntityId: string | null = null;
      let created = false;
      let ldaRegistrantId: number | null = null;

      if (input.existingClientId) {
        const existing = await tx.client.findFirst({
          where: {
            id: input.existingClientId,
            tenantId: ctx.tenantId,
            status: { not: 'archived' },
          },
          select: { id: true, name: true, canonicalEntityId: true },
        });
        if (!existing) throw new NotFoundException('Client not found');
        clientId = existing.id;
        clientName = existing.name;
        selectedClientCanonicalEntityId = existing.canonicalEntityId;
      } else if (current.canonicalEntityId) {
        // Exact confirmed canonical client for this tenant → link it.
        const confirmed = await tx.client.findFirst({
          where: { tenantId: ctx.tenantId, canonicalEntityId: current.canonicalEntityId },
          select: { id: true, name: true },
        });
        if (confirmed) {
          clientId = confirmed.id;
          clientName = confirmed.name;
        } else {
          // Create exactly one client inside this transaction; roll back
          // client + link together on any failure. The partial unique on
          // (tenant, canonical) makes the insert duplicate-safe.
          const { client, ldaRegistrantId: registrant } = await this.clients.createInTransaction(
            ctx,
            tx,
            {
              name: current.displayName,
              website: input.clientWebsite ?? current.website ?? undefined,
              description: input.clientDescription ?? current.description ?? undefined,
              canonicalEntityId: current.canonicalEntityId,
            },
          );
          clientId = client.id;
          clientName = client.name;
          created = true;
          ldaRegistrantId = registrant;
        }
      } else {
        // Unresolved manual prospect: creating a client is fine (the firm
        // explicitly asked to convert), but NO canonical link is stamped —
        // a manual prospect never creates canonical identity.
        const { client, ldaRegistrantId: registrant } = await this.clients.createInTransaction(
          ctx,
          tx,
          {
            name: current.displayName,
            website: input.clientWebsite ?? current.website ?? undefined,
            description: input.clientDescription ?? current.description ?? undefined,
          },
        );
        clientId = client.id;
        clientName = client.name;
        created = true;
        ldaRegistrantId = registrant;
      }

      // 4. Serialize claims on the selected client as well as claims on this
      //    prospect. Two different prospects can be converted concurrently;
      //    without this tenant-qualified row lock they could both observe no
      //    existing link and the loser would receive a raw partial-unique
      //    error. After the lock, the explicit duplicate lookup below always
      //    yields the actionable same-tenant review conflict instead.
      await tx.$queryRaw`SELECT "id" FROM "clients"
        WHERE "id" = ${clientId}::uuid AND "tenant_id" = ${ctx.tenantId}::uuid
        FOR UPDATE`;

      // An explicit existing-client selection is also an explicit identity
      // decision when the prospect is confirmed. Never link it to a client
      // already confirmed as some other organization; and when the selected
      // client is still unconfirmed, stamp the reviewed canonical identity so
      // future exact conversions find it instead of creating a duplicate.
      if (input.existingClientId && current.canonicalEntityId) {
        if (
          selectedClientCanonicalEntityId &&
          selectedClientCanonicalEntityId !== current.canonicalEntityId
        ) {
          throw new ConflictException({
            code: 'BIZDEV_CLIENT_IDENTITY_CONFLICT',
            message:
              'The selected client is confirmed as a different organization. Choose the matching client or review its identity first.',
          });
        }

        const exactClient = await tx.client.findFirst({
          where: {
            tenantId: ctx.tenantId,
            canonicalEntityId: current.canonicalEntityId,
          },
          select: { id: true, name: true },
        });
        if (exactClient && exactClient.id !== clientId) {
          throw new ConflictException({
            code: 'BIZDEV_CANONICAL_CLIENT_EXISTS',
            message:
              'A different client in your firm already has this confirmed organization identity. Link that client instead.',
            clientId: exactClient.id,
          });
        }
        if (!selectedClientCanonicalEntityId) {
          await tx.client.update({
            where: { id: clientId },
            data: { canonicalEntityId: current.canonicalEntityId },
          });
        }
      }

      // 5. Same-tenant duplicate-prospect guard: if the client we are about
      //    to link is ALREADY linked to a DIFFERENT prospect of this tenant,
      //    return a specific same-tenant review conflict instead of letting
      //    the DB partial unique surface a raw error. (Guessed ids 404'd
      //    above; this is an explicit, user-actionable conflict.)
      const otherProspect = await tx.businessDevelopmentProspect.findFirst({
        where: { tenantId: ctx.tenantId, linkedClientId: clientId, id: { not: id } },
        select: { id: true, status: true },
      });
      if (otherProspect) {
        throw new ConflictException({
          code: 'BIZDEV_CLIENT_ALREADY_LINKED',
          message:
            'This client is already linked to another prospect of your firm. Open that prospect instead, or choose a different client.',
          prospectId: otherProspect.id,
          prospectStatus: otherProspect.status,
        });
      }

      // 6. Claim the locked row: the FOR UPDATE lock means at most ONE caller
      //    can be here per prospect at a time, so this plain update is safe.
      await tx.businessDevelopmentProspect.update({
        where: { id },
        data: {
          linkedClientId: clientId,
          convertedAt: new Date(),
          status: 'active',
          dismissedAt: null,
        },
        select: prospectSelect,
      });

      await this.activity(tx, ctx, id, 'convert', `Converted/linked to client ${clientName}`, {
        after: { linkedClientId: clientId, created },
      });
      await this.audit(
        tx,
        ctx,
        'bizdev.prospect.convert',
        'business_development_prospect',
        id,
        {
          linkedClientId: null,
        },
        { linkedClientId: clientId, created },
      );

      return { clientId, clientName, created, ldaRegistrantId, alreadyLinked: false as const };
    });

    if (outcome.alreadyLinked) {
      const prospect2 = await this.findOwned(ctx, id);
      return {
        prospect: prospect2,
        client: { id: outcome.clientId, name: outcome.clientName },
        created: false,
      };
    }

    // AFTER commit: schedule enrichment, only for a CREATED client — never for
    // link-existing. The real ldaRegistrantId from the transaction outcome is
    // passed to the resolution call (registrant-anchored matching), matching
    // ClientsService.create's behavior.
    if (outcome.created) {
      void this.entityResolution
        .resolveClient(outcome.clientId, ctx.tenantId, outcome.clientName, {
          ldaRegistrantId: outcome.ldaRegistrantId,
          clientUei: null,
        })
        .then(() => this.prepopulation.prepopulate(ctx.tenantId, outcome.clientId))
        .catch((e: unknown) =>
          this.logger.warn(
            `post-conversion resolution failed for client ${outcome.clientId}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      void this.samEntity
        .enrichGovIds(ctx.tenantId, outcome.clientId)
        .catch((e: unknown) =>
          this.logger.warn(
            `post-conversion gov-id enrichment failed for client ${outcome.clientId}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
    }

    const prospectAfter = await this.findOwned(ctx, id);
    return {
      prospect: prospectAfter,
      client: { id: outcome.clientId, name: outcome.clientName },
      created: outcome.created,
    };
  }

  // ── identity resolution for an unresolved prospect ──────────────────────

  /**
   * Confirm the canonical organization identity of a previously UNRESOLVED
   * prospect. The prospect KEEPS its id and full history (never a silent
   * merge); we only stamp canonicalEntityId, serialize (tenant, canonical)
   * via the advisory lock, and emit an `identity` activity + AuditLog. No
   * global organization is ever created or merged here.
   *
   * If another same-tenant prospect already owns that canonical identity we
   * return a STRUCTURED same-tenant duplicate-review response (its prospect
   * id/status) so the UI can open/restore it — never a raw unique error and
   * never a silent history merge.
   */
  async resolveIdentity(
    ctx: TenantContext,
    id: string,
    input: { canonicalEntityId: string },
  ): Promise<
    | { outcome: 'resolved'; prospect: ProspectRow }
    | {
        outcome: 'duplicate';
        duplicate: {
          prospectId: string;
          status: 'active' | 'dismissed';
          displayName: string;
          linkedClientId: string | null;
        };
      }
  > {
    const result = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const before = await this.findOwnedTx(tx, ctx.tenantId, id);

      // Already confirmed identity → idempotent no-op (private marker; the
      // public response below is identical to the changed outcome).
      if (before.canonicalEntityId === input.canonicalEntityId) {
        return { outcome: 'resolved' as const, prospect: before, identityChanged: false };
      }

      // Validate the canonical entity under the identity rules in this same
      // transaction: global_public rows are shared; tenant-private rows are
      // visible only to their owning tenant; merged-away rows are not
      // confirmable. We NEVER create a canonical organization here.
      const canonical = await this.findVisibleCanonicalOrganizationTx(
        tx,
        ctx.tenantId,
        input.canonicalEntityId,
      );
      if (!canonical) throw new NotFoundException('Canonical entity not found');

      // Serialize (tenant, canonical) so a concurrent resolve/create pair
      // can't both claim the identity (DB partial unique is the backstop).
      await lockTenantCanonical(tx, ctx.tenantId, input.canonicalEntityId);

      const owner = await tx.businessDevelopmentProspect.findFirst({
        where: { tenantId: ctx.tenantId, canonicalEntityId: input.canonicalEntityId },
        select: {
          id: true,
          status: true,
          displayName: true,
          linkedClientId: true,
        },
      });
      if (owner && owner.id !== id) {
        // Structured duplicate-review response: UI opens/restores the owning
        // prospect; histories are never merged.
        return {
          outcome: 'duplicate' as const,
          duplicate: {
            prospectId: owner.id,
            status: owner.status as 'active' | 'dismissed',
            displayName: owner.displayName,
            linkedClientId: owner.linkedClientId,
          },
        };
      }

      const after = await tx.businessDevelopmentProspect.update({
        where: { id },
        data: { canonicalEntityId: input.canonicalEntityId },
        select: prospectSelect,
      });
      await this.activity(
        tx,
        ctx,
        id,
        'identity',
        `Identity confirmed: ${canonical.canonicalName}`,
        {
          before: { canonicalEntityId: before.canonicalEntityId },
          after: { canonicalEntityId: input.canonicalEntityId },
        },
      );
      await this.audit(
        tx,
        ctx,
        'bizdev.prospect.identity',
        'business_development_prospect',
        id,
        {
          canonicalEntityId: before.canonicalEntityId,
        },
        { canonicalEntityId: input.canonicalEntityId },
      );
      return { outcome: 'resolved' as const, prospect: after, identityChanged: true };
    });

    // Phase 3: fire the review hook only when the transaction genuinely
    // CHANGED the identity (private identityChanged marker — true only on
    // the real update path). The idempotent already-resolved no-op and the
    // duplicate-review outcome both skip it. The marker is stripped here;
    // the public response shape is identical to Phase 1. Post-commit and
    // best-effort: a hook failure can never fail the resolution.
    const { identityChanged, outcome, ...rest } = result as {
      identityChanged?: boolean;
      outcome: 'resolved' | 'duplicate';
      [key: string]: unknown;
    };
    const publicResult =
      outcome === 'resolved'
        ? { outcome, prospect: (rest as { prospect: ProspectRow }).prospect }
        : { outcome, duplicate: (rest as { duplicate: unknown }).duplicate };
    void identityChanged;
    if (identityChanged && this.jevReview) {
      void this.jevReview
        .recordIdentityReviewOutcome({
          tenantId: ctx.tenantId,
          prospectId: id,
          resolvedCanonicalEntityId: input.canonicalEntityId,
          userId: ctx.userId ?? null,
        })
        .catch(() => undefined);
    }
    return publicResult as typeof result;
  }

  // ── shared helpers ──────────────────────────────────────────────────────

  private async findDuplicateHints(
    ctx: TenantContext,
    input: {
      displayName: string;
      domain?: string | null;
      website?: string | null;
      canonicalEntityId?: string | null;
      excludeId?: string;
    },
  ) {
    const fingerprint = fingerprintName(input.displayName);
    const domain = normalizeDomainHint(input.domain ?? input.website ?? null);
    if (!fingerprint && !domain && !input.canonicalEntityId) return [];

    const candidates = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.businessDevelopmentProspect.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
        },
        select: duplicateHintSelect,
        orderBy: { updatedAt: 'desc' },
        take: 200,
      }),
    );

    return candidates.filter((candidate) => {
      if (input.canonicalEntityId && candidate.canonicalEntityId === input.canonicalEntityId) {
        return true;
      }
      if (fingerprint && fingerprintName(candidate.displayName) === fingerprint) return true;
      if (!domain) return false;
      return normalizeDomainHint(candidate.domain ?? candidate.website ?? null) === domain;
    });
  }

  /**
   * Read one active canonical organization visible to this tenant without
   * passing through PrismaService's generic tenant-model extension. That
   * extension correctly protects ordinary tenant tables, but CanonicalEntity
   * is deliberately mixed-scope: global_public rows have tenant_id NULL and
   * tenant_private rows have a tenant owner. The explicit SQL predicate is the
   * authoritative visibility boundary for this lookup.
   */
  private async findVisibleCanonicalOrganizationTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    canonicalEntityId: string,
  ): Promise<{ id: string; canonicalName: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string; canonicalName: string }>>`
      SELECT "id", "canonical_name" AS "canonicalName"
      FROM "canonical_entities"
      WHERE "id" = ${canonicalEntityId}::uuid
        AND "merged_into_entity_id" IS NULL
        AND "status" = 'active'
        AND "entity_type" = 'organization'
        AND ("identity_scope" = 'global_public' OR "tenant_id" = ${tenantId}::uuid)
      LIMIT 1`;
    return rows[0] ?? null;
  }

  /** Tenant-owned read outside a transaction (safe 404 on any miss). */
  private async findOwned(ctx: TenantContext, id: string): Promise<ProspectRow> {
    return this.prisma.withTenant(ctx.tenantId, (tx) => this.findOwnedTx(tx, ctx.tenantId, id));
  }

  /** Tenant-owned read inside a caller transaction. Explicit tenant predicate;
   * guessed/cross-tenant ids hit the identical NotFoundException. */
  private findOwnedTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
  ): Promise<ProspectRow> {
    return tx.businessDevelopmentProspect
      .findFirst({
        where: { id, tenantId },
        select: prospectSelect,
      })
      .then((row) => {
        if (!row) throw new NotFoundException(PROSPECT_NOT_FOUND);
        return row;
      });
  }

  /** Assert the user is an ACTIVE member of THIS tenant (same transaction). */
  private async assertActiveMember(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
  ): Promise<void> {
    const membership = await tx.tenantMembership.findFirst({
      where: { tenantId, userId, status: 'active' },
      select: { id: true },
    });
    if (!membership) {
      throw new BadRequestException('Owner is not an active member of this tenant');
    }
  }

  /** Prospect activity row (same transaction as the mutation). */
  private async activity(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    prospectId: string,
    kind:
      | 'note'
      | 'stage'
      | 'owner'
      | 'dismiss'
      | 'restore'
      | 'conflict'
      | 'watch'
      | 'convert'
      | 'identity',
    body: string,
    jsonb?: { before?: unknown; after?: unknown },
  ): Promise<void> {
    await tx.businessDevelopmentProspectActivity.create({
      data: {
        tenantId: ctx.tenantId,
        prospectId,
        actorUserId: ctx.userId,
        kind,
        body,
        beforeJsonb: (jsonb?.before ?? undefined) as Prisma.InputJsonValue | undefined,
        afterJsonb: (jsonb?.after ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  /** AuditLog row (same transaction as the mutation). */
  private async audit(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    action: string,
    entityType: string,
    entityId: string,
    before: Prisma.InputJsonValue | null,
    after: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        actorRole: ctx.role,
        action,
        entityType,
        entityId,
        before: before ?? undefined,
        after: JSON.parse(JSON.stringify(after)),
      },
    });
  }
}
