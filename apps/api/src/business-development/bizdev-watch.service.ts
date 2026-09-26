import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AppConfig } from '../config/config.schema.js';
import { parseSourceFamilies } from './bizdev-watch-runner.js';

/**
 * Business Development Phase 5 — watch lifecycle + alert inbox service.
 *
 * HTTP-facing slice only: activation/patch/get of the per-prospect watch and
 * the tenant/prospect alert inboxes (list, unread count, read, dismiss,
 * read-all). The DB-only evaluator that produces alerts lives in
 * bizdev-watch-runner.ts and NEVER runs from an HTTP request; this module
 * performs ZERO provider fetches (INV-0) and reads only the new Phase 5
 * tenant tables plus the prospect row.
 *
 * Invariants:
 *   * every tenant read/write goes through prisma.withTenant with an explicit
 *     tenantId predicate — RLS is defense in depth only;
 *   * guessed cross-tenant ids 404 identically ('Watch not found' /
 *     'Alert not found' with the same shape as a missing row);
 *   * the EFFECTIVE activation owner (input → prospect owner → actor) is
 *     revalidated against an ACTIVE TenantMembership on every activation;
 *     a departed prospect owner falls back to the authenticated actor;
 *   * source states are created from the VALIDATED configured source-family
 *     allowlist (BIZDEV_WATCH_SOURCE_FAMILIES) — not a hardcoded list;
 *   * preference changes (pause/resume/end, mute, categories, owner) bump
 *     preferenceVersion ONLY when a value actually changes; true no-ops
 *     write no activity/audit rows and no version bump;
 *   * end clears the legacy prospect.watchRequested bit; activation sets it
 *     (also only on real change);
 *   * alert read/dismiss are genuinely idempotent: the FIRST read/dismiss
 *     timestamps are preserved across retries, activity is written only on
 *     the first state transition, and only the watch owner (the frozen
 *     recipient at activation) may mutate recipient state;
 *   * the unreadOnly filter and unread count are computed against the real
 *     in_app delivery rows of the current recipient and ignore dismissed
 *     rows;
 *   * read-all is a bounded bulk transaction (one bounded alert scan + one
 *     delivery read + one createMany + one updateMany), never a per-alert
 *     N+1 loop.
 */

const WATCH_NOT_FOUND = 'Watch not found';

/** Bounded read-all page: alerts considered per call (explicit bound). */
const READ_ALL_MAX_ALERTS = 1000;

/** Response shape for GET/POST/PATCH .../prospects/:prospectId/watch. */
export interface BizDevWatchResponse {
  watch: {
    status: string;
    categories: string[];
    ownerUserId: string | null;
    mutedUntil: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  sources: Array<{
    source: string;
    health: string;
    lastCheckedAt: string | null;
    detail: string | null;
  }>;
  lastCompletedCheckAt: string | null;
}

/** One alert row as returned to HTTP consumers (web contract shape). */
export interface BizDevAlertRow {
  id: string;
  title: string;
  summary: string | null;
  materiality: string | null;
  materialityLevel: string | null;
  company: string | null;
  sourceFamily: string | null;
  category: string | null;
  eventAt: string | null;
  effectiveAt: string | null;
  publishedAt: string | null;
  firstObservedAt: string | null;
  sourceLocator: string | null;
  implication: string | null;
  readAt: string | null;
  dismissedAt: string | null;
  prospectId: string | null;
}

@Injectable()
export class BizDevWatchService {
  private readonly logger = new Logger(BizDevWatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** The validated source-family allowlist for source-state creation. */
  private configuredSourceFamilies(): string[] {
    const raw = this.config.get('BIZDEV_WATCH_SOURCE_FAMILIES', { infer: true });
    // parseSourceFamilies throws on an unknown family — fail closed, the
    // surface cannot activate a watch with an unscannable family list.
    return parseSourceFamilies(raw);
  }

  /** GET .../prospects/:prospectId/watch — null watch means not activated. */
  async getWatch(ctx: TenantContext, prospectId: string): Promise<BizDevWatchResponse> {
    await this.assertProspect(ctx, prospectId);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const watch = await tx.businessDevelopmentWatch.findFirst({
        where: { tenantId: ctx.tenantId, prospectId },
      });
      return this.renderWatch(tx, ctx.tenantId, watch);
    });
  }

  /**
   * POST .../prospects/:prospectId/watch — activate an existing watch
   * (re-activate a paused/ended one) or create one. The EFFECTIVE owner
   * (input → prospect owner → actor) is revalidated as an ACTIVE member of
   * this tenant; a departed prospect owner falls back to the actor. Source
   * states are created from the validated configured family allowlist
   * (health pending, no baseline — the runner establishes the quiet
   * baseline with ZERO alerts). A true no-op re-activation (already active,
   * same owner, same categories) bumps nothing and writes no audit rows.
   */
  async activateWatch(
    ctx: TenantContext,
    prospectId: string,
    input: { categories?: string[]; ownerUserId?: string },
  ): Promise<BizDevWatchResponse> {
    const prospect = await this.assertProspect(ctx, prospectId);
    // An EXPLICIT owner input must be an active member — no silent actor
    // substitution for an explicit bad choice. Only the stale prospect-owner
    // FALLBACK path may fall through to the authenticated actor.
    if (input.ownerUserId !== undefined) {
      if (!(await this.isActiveMember(ctx.tenantId, input.ownerUserId))) {
        throw new BadRequestException('Owner is not an active member of this tenant');
      }
    }
    const prospectOwner = prospect.ownerUserId ?? ctx.userId;
    const effectiveOwner =
      input.ownerUserId ??
      (await this.isActiveMember(ctx.tenantId, prospectOwner) ? prospectOwner : ctx.userId);

    const families = this.configuredSourceFamilies();

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.businessDevelopmentWatch.findFirst({
        where: { tenantId: ctx.tenantId, prospectId },
      });
      const nextCategories = input.categories ?? existing?.categories ?? [];

      let watch;
      let changed = true;
      if (!existing) {
        watch = await tx.businessDevelopmentWatch.create({
          data: {
            tenantId: ctx.tenantId,
            prospectId,
            ownerUserId: effectiveOwner,
            status: 'active',
            categories: nextCategories,
            requestedByUserId: ctx.userId,
          },
        });
      } else {
        const noop =
          existing.status === 'active' &&
          existing.ownerUserId === effectiveOwner &&
          this.sameCategories(existing.categories, nextCategories);
        changed = !noop;
        watch = await tx.businessDevelopmentWatch.update({
          where: { id: existing.id },
          data: {
            status: 'active',
            ownerUserId: effectiveOwner,
            categories: nextCategories,
            ...(changed ? { preferenceVersion: { increment: 1 } } : {}),
            ...(existing.mutedUntil && changed ? { mutedUntil: null } : {}),
          },
        });
      }

      // Source states from the VALIDATED allowlist only. Families outside
      // the allowlist get no row (they can never sit permanently pending);
      // the runner never claims a family it was not configured to scan.
      for (const family of families) {
        await tx.businessDevelopmentWatchSourceState.upsert({
          where: {
            tenantId_watchId_sourceFamily: {
              tenantId: ctx.tenantId,
              watchId: watch.id,
              sourceFamily: family,
            },
          },
          create: {
            tenantId: ctx.tenantId,
            watchId: watch.id,
            sourceFamily: family,
            health: 'pending',
          },
          update: {},
        });
      }

      if (!prospect.watchRequested) {
        await tx.businessDevelopmentProspect.update({
          where: { tenantId_id: { tenantId: ctx.tenantId, id: prospectId } },
          data: { watchRequested: true },
        });
      }

      if (changed) {
        await this.activity(tx, ctx, prospectId, 'watch', 'Watch activated', {
          after: { status: 'active', ownerUserId: effectiveOwner },
        });
        await this.audit(
          tx,
          ctx,
          'bizdev.watch.activate',
          'business_development_watches',
          watch.id,
          null,
          { status: 'active', ownerUserId: effectiveOwner },
        );
      }

      return this.renderWatch(tx, ctx.tenantId, watch);
    });
  }

  /**
   * PATCH .../prospects/:prospectId/watch — pause/resume/end, mute, category
   * and owner preferences. Every REAL change bumps preferenceVersion; a
   * no-op patch bumps nothing and writes no activity/audit rows. Resume
   * (→ active) clears mutedUntil and relies on the evaluator having advanced
   * baselines while suppressed — accumulated paused/muted changes can never
   * replay as alerts. End clears the legacy watchRequested bit.
   */
  async updateWatch(
    ctx: TenantContext,
    prospectId: string,
    input: {
      status?: 'active' | 'paused' | 'ended';
      mutedUntil?: string | null;
      categories?: string[];
      ownerUserId?: string | null;
    },
  ): Promise<BizDevWatchResponse> {
    if (
      input.status === undefined &&
      input.mutedUntil === undefined &&
      input.categories === undefined &&
      input.ownerUserId === undefined
    ) {
      throw new BadRequestException('No editable fields provided');
    }
    const prospect = await this.assertProspect(ctx, prospectId);
    // PATCH ownerUserId: reject null — watch ownership can never become null
    // (the recipient semantics of deliveries are frozen at activation).
    if (input.ownerUserId != null) {
      if (!(await this.isActiveMember(ctx.tenantId, input.ownerUserId))) {
        throw new BadRequestException('Owner is not an active member of this tenant');
      }
    } else if (input.ownerUserId === null) {
      throw new BadRequestException('ownerUserId cannot be null');
    }

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.businessDevelopmentWatch.findFirst({
        where: { tenantId: ctx.tenantId, prospectId },
      });
      if (!existing) throw new NotFoundException(WATCH_NOT_FOUND);

      const nextMutedUntil =
        input.mutedUntil === undefined
          ? existing.mutedUntil
          : input.mutedUntil === null
            ? null
            : new Date(input.mutedUntil);
      if (nextMutedUntil && Number.isNaN(nextMutedUntil.getTime())) {
        throw new BadRequestException('mutedUntil must be an ISO-8601 timestamp');
      }
      const nextCategories = input.categories ?? existing.categories;
      const nextOwner = input.ownerUserId === undefined ? existing.ownerUserId : input.ownerUserId;

      const statusChanged = input.status !== undefined && existing.status !== input.status;
      const muteChanged =
        input.mutedUntil !== undefined &&
        (existing.mutedUntil?.getTime() ?? null) !== (nextMutedUntil?.getTime() ?? null);
      const categoriesChanged = !this.sameCategories(existing.categories, nextCategories);
      const ownerChanged = (existing.ownerUserId ?? null) !== (nextOwner ?? null);
      // Treat an explicit `status: active` as a resume/unmute action even
      // when the row is already active. This lets the UI clear a mute without
      // needing to send an unrelated mutable field.
      const resumeClearsMute = input.status === 'active' && existing.mutedUntil != null;
      const changed = statusChanged || muteChanged || categoriesChanged || ownerChanged || resumeClearsMute;

      let watch = existing;
      if (changed) {
        watch = await tx.businessDevelopmentWatch.update({
          where: { id: existing.id },
          data: {
            ...(statusChanged ? { status: input.status! } : {}),
            // Resume clears the mute (evaluator advanced baselines while
            // suppressed; no accumulated replay).
            ...(input.status === 'active' && existing.mutedUntil ? { mutedUntil: null } : {}),
            ...(!statusChanged && muteChanged ? { mutedUntil: nextMutedUntil } : {}),
            ...(categoriesChanged ? { categories: nextCategories } : {}),
            ...(ownerChanged ? { ownerUserId: nextOwner } : {}),
            preferenceVersion: { increment: 1 },
          },
        });
      }

      if (statusChanged && input.status === 'ended') {
        if (prospect.watchRequested) {
          await tx.businessDevelopmentProspect.update({
            where: { tenantId_id: { tenantId: ctx.tenantId, id: prospectId } },
            data: { watchRequested: false },
          });
        }
      }
      // Resume (paused/ended → active) RESTORES the legacy request bit: an
      // active watch must never leave watchRequested=false behind.
      if (statusChanged && input.status === 'active' && !prospect.watchRequested) {
        await tx.businessDevelopmentProspect.update({
          where: { tenantId_id: { tenantId: ctx.tenantId, id: prospectId } },
          data: { watchRequested: true },
        });
      }

      if (changed) {
        await this.activity(
          tx,
          ctx,
          prospectId,
          'watch',
          this.watchChangeBody(existing, input, watch),
          {
            before: {
              status: existing.status,
              mutedUntil: existing.mutedUntil?.toISOString() ?? null,
            },
            after: { status: watch.status, mutedUntil: watch.mutedUntil?.toISOString() ?? null },
          },
        );
        await this.audit(
          tx,
          ctx,
          'bizdev.watch.update',
          'business_development_watches',
          watch.id,
          { status: existing.status },
          { status: watch.status, preferenceVersion: watch.preferenceVersion },
        );
      }

      return this.renderWatch(tx, ctx.tenantId, watch);
    });
  }

  // ── Prospect-local alert inbox ────────────────────────────────────────────

  /**
   * GET .../prospects/:prospectId/alerts — tenant alerts for one prospect,
   * newest first, keyset-paginated on (firstObservedAt DESC, id DESC).
   * unreadOnly filters at the QUERY against the current recipient's in_app
   * delivery rows.
   */
  async listProspectAlerts(
    ctx: TenantContext,
    prospectId: string,
    query: { limit?: number; cursor?: string; unreadOnly?: boolean },
  ): Promise<{ items: BizDevAlertRow[]; nextCursor: string | null; unreadCount: number }> {
    await this.assertProspect(ctx, prospectId);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const { items, nextCursor } = await this.pageAlerts(tx, ctx, {
        limit: query.limit ?? 25,
        cursor: query.cursor,
        prospectId,
        unreadOnly: query.unreadOnly === true,
      });
      const unreadCount = await this.countUnread(tx, ctx, { prospectId });
      return { items, nextCursor, unreadCount };
    });
  }

  /**
   * POST .../prospects/:prospectId/alerts/:alertId/read — idempotent on an
   * EXISTING in-app delivery for the CURRENT recipient. Authorization is
   * DELIVERY-centric: an existing (tenant, alert, recipient, in_app)
   * delivery row IS the authority to mutate recipient state — the frozen
   * recipient stays authorized even after watch ownership later changes,
   * and the current watch owner WITHOUT a delivery gets 403. A delivery is
   * never manufactured here (the evaluator's delivery is atomic). The
   * FIRST read timestamp is preserved across retries and the source-linked
   * activity entry is written only on the first unread→read transition.
   */
  async markAlertRead(
    ctx: TenantContext,
    prospectId: string,
    alertId: string,
  ): Promise<{ readAt: string }> {
    const alert = await this.assertAlert(ctx, prospectId, alertId);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.businessDevelopmentAlertDelivery.findUnique({
        where: this.deliveryKey(ctx, alertId),
      });
      // No current-recipient in_app delivery means NOT delivered to this
      // user — never manufactured, never mutated. 403 regardless of who the
      // current watch owner is (frozen recipient semantics).
      if (!existing) throw new ForbiddenException('No in-app delivery for this recipient');
      if (existing.readAt) return { readAt: existing.readAt.toISOString() };
      const now = new Date();
      // CONDITIONAL update: only the UNREAD delivery flips; a concurrent
      // read that won the race makes this match ZERO rows, so only ONE call
      // writes a timestamp and only ONE activity entry is appended.
      const flipped = await tx.businessDevelopmentAlertDelivery.updateMany({
        where: { ...this.deliveryWhere(ctx, alertId), readAt: null },
        data: { readAt: now },
      });
      if (flipped.count === 1) {
        await this.alertActivity(tx, ctx, prospectId, alert.title, alert.sourceLocator);
      }
      // Re-read for the PRESERVED first timestamp (a racing writer's
      // earlier readAt wins over `now`).
      const after = await tx.businessDevelopmentAlertDelivery.findUniqueOrThrow({
        where: this.deliveryKey(ctx, alertId),
      });
      return { readAt: (after.readAt ?? now).toISOString() };
    });
  }

  /**
   * POST .../prospects/:prospectId/alerts/:alertId/dismiss — idempotent on
   * an EXISTING in-app delivery for the CURRENT recipient; the delivery
   * row is the sole authorization (frozen recipient stays authorized after
   * ownership changes; no delivery = 403, never manufactured). Dismissal
   * implies read (SQL CHECK) and both first timestamps are preserved
   * across retries. Activity only on the first not-dismissed→dismissed
   * transition.
   */
  async dismissAlert(
    ctx: TenantContext,
    prospectId: string,
    alertId: string,
  ): Promise<{ readAt: string; dismissedAt: string }> {
    const alert = await this.assertAlert(ctx, prospectId, alertId);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.businessDevelopmentAlertDelivery.findUnique({
        where: this.deliveryKey(ctx, alertId),
      });
      // No current-recipient in_app delivery: never manufactured, never
      // mutated — 403 regardless of current watch ownership.
      if (!existing) throw new ForbiddenException('No in-app delivery for this recipient');
      if (existing.dismissedAt) {
        return {
          readAt: (existing.readAt ?? existing.dismissedAt).toISOString(),
          dismissedAt: existing.dismissedAt.toISOString(),
        };
      }
      const now = new Date();
      // One conditional SQL write preserves FIRST-read semantics even when a
      // separate mark-read request races this dismissal. COALESCE keeps the
      // winning read_at; the CHECK requiring dismissal >= read remains true.
      const flipped = await tx.$executeRaw`
        UPDATE "business_development_alert_deliveries"
        SET "read_at" = COALESCE("read_at", ${now}),
            "dismissed_at" = ${now},
            "dismissed_by_user_id" = ${ctx.userId}::uuid
        WHERE "tenant_id" = ${ctx.tenantId}::uuid
          AND "alert_id" = ${alertId}::uuid
          AND "recipient_user_id" = ${ctx.userId}::uuid
          AND "channel" = 'in_app'
          AND "dismissed_at" IS NULL
      `;
      if (flipped === 1) {
        await this.alertActivity(tx, ctx, prospectId, alert.title, alert.sourceLocator);
      }
      // Re-read for the PRESERVED first timestamps.
      const after = await tx.businessDevelopmentAlertDelivery.findUniqueOrThrow({
        where: this.deliveryKey(ctx, alertId),
      });
      return {
        readAt: (after.readAt ?? now).toISOString(),
        dismissedAt: (after.dismissedAt ?? now).toISOString(),
      };
    });
  }

  // ── Tenant top-bar inbox ──────────────────────────────────────────────────

  /**
   * GET /business-development/alerts — the CURRENT RECIPIENT's alerts,
   * newest first. Delivery-centric (frozen-recipient semantics): membership
   * is defined by an existing in_app delivery row for this user, NOT by
   * current watch ownership — the original recipient keeps their delivered
   * alerts after an ownership change; a new owner without deliveries sees
   * nothing. unreadOnly applies at the query on the delivery rows.
   */
  async listTenantAlerts(
    ctx: TenantContext,
    query: { limit?: number; cursor?: string; unreadOnly?: boolean },
  ): Promise<{
    items: BizDevAlertRow[];
    nextCursor: string | null;
    unreadCount: number;
  }> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const { items, nextCursor } = await this.pageAlerts(tx, ctx, {
        limit: query.limit ?? 25,
        cursor: query.cursor,
        deliveredToRecipient: true,
        unreadOnly: query.unreadOnly === true,
      });
      const unreadCount = await this.countUnread(tx, ctx, {});
      return { items, nextCursor, unreadCount };
    });
  }

  /**
   * POST /business-development/alerts/read-all — idempotent, bounded, BULK,
   * DELIVERY-centric. Only EXISTING current-recipient in_app delivery rows
   * are updated (the evaluator's delivery is atomic; a missing delivery
   * means not delivered and is never manufactured here, and current watch
   * ownership is irrelevant — the frozen recipient keeps their inbox). One
   * bounded alert scan (READ_ALL_MAX_ALERTS explicit bound) + one delivery
   * read + one updateMany. Never a per-alert N+1 loop, never synthetic
   * deliveries.
   */
  async markAllAlertsRead(ctx: TenantContext): Promise<{ readAt: string; marked: number }> {
    const now = new Date();
    const marked = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // DELIVERED-to-current-recipient alerts only (frozen recipient).
      const alerts = await tx.businessDevelopmentAlert.findMany({
        where: {
          tenantId: ctx.tenantId,
          deliveries: {
            some: { recipientUserId: ctx.userId, channel: 'in_app' },
          },
        },
        orderBy: [{ firstObservedAt: 'desc' }, { id: 'desc' }],
        take: READ_ALL_MAX_ALERTS,
        select: { id: true },
      });
      if (alerts.length === 0) return 0;
      const alertIds = alerts.map((a) => a.id);

      const deliveries = await tx.businessDevelopmentAlertDelivery.findMany({
        where: {
          tenantId: ctx.tenantId,
          alertId: { in: alertIds },
          recipientUserId: ctx.userId,
          channel: 'in_app',
          readAt: null,
        },
        select: { alertId: true, readAt: true },
      });
      const unread = deliveries.filter((d) => d.readAt == null).map((d) => d.alertId);
      if (unread.length === 0) return 0;
      // Return the ACTUAL transitioned count: an overlapping read-all (or a
      // concurrent single read) that already flipped some rows makes this
      // updateMany match fewer than `unread.length` — each invocation
      // reports only the rows IT actually transitioned.
      const updated = await tx.businessDevelopmentAlertDelivery.updateMany({
        where: {
          tenantId: ctx.tenantId,
          alertId: { in: unread },
          recipientUserId: ctx.userId,
          channel: 'in_app',
          readAt: null,
        },
        data: { readAt: now },
      });
      return updated.count;
    });
    return { readAt: now.toISOString(), marked };
  }

  // ── shared helpers ────────────────────────────────────────────────────────

  /** Prospect lookup with an explicit tenant predicate; 404 when missing. */
  private async assertProspect(
    ctx: TenantContext,
    prospectId: string,
  ): Promise<{ id: string; ownerUserId: string | null; watchRequested: boolean }> {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.businessDevelopmentProspect
        .findFirst({
          where: { tenantId: ctx.tenantId, id: prospectId },
          select: { id: true, ownerUserId: true, watchRequested: true },
        })
        .then((row) => {
          if (!row) throw new NotFoundException('Prospect not found');
          return row;
        }),
    );
  }

  /**
   * Alert lookup scoped to (tenant, prospect, alert); 404 when missing —
   * indistinguishable from a cross-tenant guess. Recipient authorization is
   * performed separately against the frozen delivery row.
   */
  private async assertAlert(
    ctx: TenantContext,
    prospectId: string,
    alertId: string,
  ): Promise<{ id: string; title: string; sourceLocator: string }> {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.businessDevelopmentAlert
        .findFirst({
          where: { tenantId: ctx.tenantId, prospectId, id: alertId },
          select: {
            id: true,
            title: true,
            sourceLocator: true,
          },
        })
        .then((row) => {
          if (!row) throw new NotFoundException('Alert not found');
          return { id: row.id, title: row.title, sourceLocator: row.sourceLocator };
        }),
    );
  }

  private deliveryKey(ctx: TenantContext, alertId: string) {
    return {
      tenantId_alertId_recipientUserId_channel: {
        tenantId: ctx.tenantId,
        alertId,
        recipientUserId: ctx.userId,
        channel: 'in_app',
      },
    };
  }

  /** Where-predicate form of the current-recipient in_app delivery key. */
  private deliveryWhere(ctx: TenantContext, alertId: string) {
    return {
      tenantId: ctx.tenantId,
      alertId,
      recipientUserId: ctx.userId,
      channel: 'in_app' as const,
    };
  }

  private sameCategories(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    return sa.every((v, i) => v === sb[i]);
  }

  /** ACTIVE TenantMembership of the same tenant. */
  private async isActiveMember(tenantId: string, userId: string): Promise<boolean> {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.tenantMembership
        .findFirst({ where: { tenantId, userId, status: 'active' }, select: { id: true } })
        .then((m) => m != null),
    );
  }

  /**
   * Keyset pagination over alerts, newest first, with per-recipient state.
   * unreadOnly is applied at the QUERY: only alerts with NO in_app delivery
   * row for the current recipient carrying a readAt (dismissed rows imply
   * read and are therefore excluded).
   */
  private async pageAlerts(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    opts: {
      limit: number;
      cursor?: string;
      prospectId?: string;
      watchIds?: string[];
      /** Delivery-centric scope: alerts DELIVERED to the current recipient. */
      deliveredToRecipient?: boolean;
      unreadOnly?: boolean;
    },
  ): Promise<{ items: BizDevAlertRow[]; nextCursor: string | null }> {
    const where: Prisma.BusinessDevelopmentAlertWhereInput = {
      tenantId: ctx.tenantId,
      ...(opts.prospectId ? { prospectId: opts.prospectId } : {}),
      ...(opts.watchIds ? { watchId: { in: opts.watchIds } } : {}),
    };
    if (opts.deliveredToRecipient) {
      // Frozen-recipient scope: membership is defined by an EXISTING in_app
      // delivery row for this user — NOT by current watch ownership. The
      // original recipient keeps their delivered alerts after an ownership
      // change; the new owner sees nothing until a NEW alert is delivered.
      where.deliveries = {
        some: {
          recipientUserId: ctx.userId,
          channel: 'in_app',
          ...(opts.unreadOnly ? { readAt: null, dismissedAt: null } : {}),
        },
      };
    } else if (opts.unreadOnly) {
      // unread = an EXISTING current-recipient in_app delivery that has
      // neither been read nor dismissed. A MISSING delivery means "not
      // delivered to me" — never personally unread for a non-recipient.
      where.deliveries = {
        some: {
          recipientUserId: ctx.userId,
          channel: 'in_app',
          readAt: null,
          dismissedAt: null,
        },
      };
    }
    if (opts.cursor) {
      const [ts, id] = decodeCursor(opts.cursor);
      where.AND = [
        {
          OR: [
            { firstObservedAt: { lt: ts } },
            { firstObservedAt: ts, id: { lt: id } },
          ],
        },
      ];
    }

    const rows = await tx.businessDevelopmentAlert.findMany({
      where,
      orderBy: [{ firstObservedAt: 'desc' }, { id: 'desc' }],
      take: opts.limit + 1,
      select: {
        id: true,
        prospectId: true,
        sourceFamily: true,
        category: true,
        materiality: true,
        title: true,
        summary: true,
        implication: true,
        sourceLocator: true,
        eventAt: true,
        effectiveAt: true,
        publishedAt: true,
        firstObservedAt: true,
        deliveries: {
          where: { recipientUserId: ctx.userId, channel: 'in_app' },
          select: { readAt: true, dismissedAt: true },
        },
        watch: { select: { prospect: { select: { displayName: true } } } },
      },
    });

    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    let nextCursor: string | null = null;
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1];
      if (last) {
        nextCursor = encodeCursor(last.firstObservedAt, last.id);
      }
    }
    return { items: page.map((row) => this.toAlertRow(row)), nextCursor };
  }

  /**
   * Unread count for the current recipient within the given scope: alerts
   * with NO in_app delivery row carrying a readAt for this recipient.
   * Dismissed rows imply read and are therefore never counted.
   */
  private async countUnread(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    scope: { prospectId?: string; watchIds?: string[] },
  ): Promise<number> {
    return tx.businessDevelopmentAlert.count({
      where: {
        tenantId: ctx.tenantId,
        ...(scope.prospectId ? { prospectId: scope.prospectId } : {}),
        ...(scope.watchIds ? { watchId: { in: scope.watchIds } } : {}),
        deliveries: {
          some: {
            recipientUserId: ctx.userId,
            channel: 'in_app',
            readAt: null,
            dismissedAt: null,
          },
        },
      },
    });
  }

  private toAlertRow(row: {
    id: string;
    prospectId: string;
    sourceFamily: string;
    category: string;
    materiality: string;
    title: string;
    summary: string;
    implication: string;
    sourceLocator: string;
    eventAt: Date | null;
    effectiveAt: Date | null;
    publishedAt: Date | null;
    firstObservedAt: Date;
    deliveries: Array<{ readAt: Date | null; dismissedAt: Date | null }>;
    watch: { prospect: { displayName: string } };
  }): BizDevAlertRow {
    const delivery = row.deliveries[0];
    return {
      id: row.id,
      title: row.title,
      summary: row.summary,
      materiality: row.materiality,
      materialityLevel: row.materiality,
      company: row.watch?.prospect?.displayName ?? null,
      sourceFamily: row.sourceFamily,
      category: row.category,
      eventAt: row.eventAt?.toISOString() ?? null,
      effectiveAt: row.effectiveAt?.toISOString() ?? null,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      firstObservedAt: row.firstObservedAt.toISOString(),
      sourceLocator: row.sourceLocator,
      implication: row.implication,
      readAt: delivery?.readAt?.toISOString() ?? null,
      dismissedAt: delivery?.dismissedAt?.toISOString() ?? null,
      prospectId: row.prospectId,
    };
  }

  /** Render the watch response incl. per-source health for the UI. */
  private async renderWatch(
    tx: Prisma.TransactionClient,
    tenantId: string,
    watch: {
      id: string;
      status: string;
      categories: string[];
      ownerUserId: string | null;
      mutedUntil: Date | null;
      createdAt: Date;
      updatedAt: Date;
    } | null,
  ): Promise<BizDevWatchResponse> {
    if (!watch) return { watch: null, sources: [], lastCompletedCheckAt: null };
    const states = await tx.businessDevelopmentWatchSourceState.findMany({
      where: { tenantId, watchId: watch.id },
      orderBy: { sourceFamily: 'asc' },
    });
    // lastCompletedCheckAt is the ALL-SOURCE boundary: null until EVERY
    // configured source state has a non-null lastSuccessfulCompleteCheckAt,
    // then the MINIMUM timestamp across them (the last moment at which the
    // whole configured surface was simultaneously complete). A max over
    // whatever happened to complete would overstate completeness when one
    // family is lagging.
    const completed = states
      .map((s) => s.lastSuccessfulCompleteCheckAt)
      .filter((d): d is Date => d != null);
    const allComplete = states.length > 0 && completed.length === states.length;
    const boundary = allComplete
      ? completed.reduce((min, d) => (d.getTime() < min.getTime() ? d : min))
      : null;
    return {
      watch: {
        status: watch.status,
        categories: watch.categories,
        ownerUserId: watch.ownerUserId,
        mutedUntil: watch.mutedUntil?.toISOString() ?? null,
        createdAt: watch.createdAt.toISOString(),
        updatedAt: watch.updatedAt.toISOString(),
      },
      sources: states.map((s) => ({
        source: s.sourceFamily,
        health: s.health,
        lastCheckedAt: s.lastSuccessfulCompleteCheckAt?.toISOString() ?? null,
        detail: s.lastError ?? null,
      })),
      lastCompletedCheckAt: boundary?.toISOString() ?? null,
    };
  }

  private watchChangeBody(
    before: { status: string; mutedUntil: Date | null },
    input: { status?: string },
    after: { status: string },
  ): string {
    if (input.status !== undefined && before.status !== input.status) {
      return input.status === 'paused'
        ? 'Watch paused'
        : input.status === 'ended'
          ? 'Watch ended'
          : 'Watch resumed';
    }
    return `Watch updated (${before.status} → ${after.status})`;
  }

  /** Prospect activity row (same transaction as the mutation). */
  private async activity(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    prospectId: string,
    kind: 'watch',
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

  /**
   * Source-linked alert activity entry: public title + exact source locator
   * only — no private data (no note bodies, no conflict reasons, no raw
   * payload fragments) ever reaches the shared activity feed.
   */
  private async alertActivity(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    prospectId: string,
    title: string,
    sourceLocator: string,
  ): Promise<void> {
    await tx.businessDevelopmentProspectActivity.create({
      data: {
        tenantId: ctx.tenantId,
        prospectId,
        actorUserId: ctx.userId,
        kind: 'watch',
        body: `Alert reviewed: ${title}`,
        afterJsonb: { sourceLocator } as Prisma.InputJsonValue,
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

/** Opaque keyset cursor: base64("ts|id"). */
export function encodeCursor(ts: Date, id: string): string {
  return Buffer.from(`${ts.toISOString()}|${id}`, 'utf8').toString('base64');
}

export function decodeCursor(cursor: string): [Date, string] {
  const raw = Buffer.from(cursor, 'base64').toString('utf8');
  const sep = raw.lastIndexOf('|');
  if (sep <= 0) throw new BadRequestException('Invalid cursor');
  const ts = new Date(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (Number.isNaN(ts.getTime()) || !id) throw new BadRequestException('Invalid cursor');
  return [ts, id];
}
