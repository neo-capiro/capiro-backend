import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { TrackerWatchlistService } from '../tracker/tracker-watchlist.service.js';

/**
 * P2-04 (Gate D phase e): PER-USER alert triage state (intel_alert_work_state).
 *
 * The intelligence EVENT stays global. `intel_alert.status` is the firm-wide
 * state of the event — read by DEFAULT_STATUSES and written by
 * dedupeStateActionAlerts and the emitter — so triage must NOT live there: one
 * analyst's dismiss would hide the alert from the whole firm and collide with
 * the suppression sweep. This service owns the per-user layer instead, and it
 * only ever NARROWS what a user sees. A suppressed alert stays suppressed.
 *
 * intel_* is tenant-scoped in app code as well as by RLS, so every query filters
 * tenantId and every entry point proves client ownership first.
 */

export const WORK_STATES = [
  'new',
  'in_review',
  'assigned',
  'actioned',
  'snoozed',
  'dismissed',
] as const;
export type WorkStateValue = (typeof WORK_STATES)[number];

/** States the default feed hides. A past `snoozedUntil` un-hides without a job. */
export const HIDDEN_WORK_STATES: WorkStateValue[] = ['dismissed', 'snoozed'];

/** Cap on one bulk call. The web chunks above this and reports the chunking. */
export const BULK_MAX = 200;

export interface WorkState {
  state: WorkStateValue;
  assignedTo: string | null;
  snoozedUntil: string | null;
  note: string | null;
}

export interface WorkStatePatch {
  state?: WorkStateValue;
  assignedTo?: string | null;
  snoozedUntil?: Date | null;
  note?: string | null;
}

@Injectable()
export class AlertWorkStateService {
  private readonly logger = new Logger(AlertWorkStateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly watchlist: TrackerWatchlistService,
  ) {}

  /**
   * An assigned alert with no assignee is the P1-11 empty-string problem again —
   * a field that renders as "assigned to nobody". Reject it at the boundary.
   */
  private assertAssignable(patch: WorkStatePatch): void {
    if (patch.state === 'assigned' && !patch.assignedTo) {
      throw new BadRequestException('assignedTo is required when state is "assigned"');
    }
  }

  /**
   * Upsert on (alertId, userId) — the table's unique index, so a repeated action
   * is idempotent rather than a duplicate row.
   */
  async setState(
    tenantId: string,
    clientId: string,
    alertId: string,
    userId: string,
    patch: WorkStatePatch,
  ): Promise<void> {
    await this.watchlist.assertClientInTenant(tenantId, clientId);
    this.assertAssignable(patch);

    const data = {
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.assignedTo !== undefined ? { assignedTo: patch.assignedTo } : {}),
      ...(patch.snoozedUntil !== undefined ? { snoozedUntil: patch.snoozedUntil } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      updatedBy: userId,
    };

    await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelAlertWorkState.upsert({
        where: { alertId_userId: { alertId, userId } },
        create: { tenantId, clientId, alertId, userId, state: patch.state ?? 'new', ...data },
        update: data,
      }),
    );
  }

  /**
   * Batch-load one feed page's work state for the current user. ONE query, no
   * N+1 — mirrors ActionItemService.summaryForAlerts.
   */
  async forAlerts(
    tenantId: string,
    userId: string,
    alertIds: string[],
  ): Promise<Map<string, WorkState>> {
    const out = new Map<string, WorkState>();
    if (!alertIds.length) return out;

    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelAlertWorkState.findMany({
        where: { tenantId, userId, alertId: { in: alertIds } },
        select: {
          alertId: true,
          state: true,
          assignedTo: true,
          snoozedUntil: true,
          note: true,
        },
      }),
    );
    for (const r of rows) {
      out.set(r.alertId, {
        state: r.state as WorkStateValue,
        assignedTo: r.assignedTo,
        snoozedUntil: r.snoozedUntil ? r.snoozedUntil.toISOString() : null,
        note: r.note,
      });
    }
    return out;
  }

  /**
   * The alert ids this user has actively hidden — dismissed, or snoozed with the
   * snooze still in the future. Feeds the feed's exclusion predicate.
   *
   * A snooze whose `snoozedUntil` has PASSED is not hidden, and that is computed
   * here in the predicate rather than by a background job, so an expired snooze
   * reappears with nothing running.
   *
   * Capped: an unbounded `NOT IN` list would degrade the feed's keyset query. On
   * hitting the cap we LOG it rather than silently truncating.
   */
  async hiddenAlertIds(
    tenantId: string,
    userId: string,
    clientId: string | null,
    cap = 5000,
  ): Promise<string[]> {
    const now = new Date();
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelAlertWorkState.findMany({
        where: {
          tenantId,
          userId,
          ...(clientId ? { clientId } : {}),
          OR: [
            { state: 'dismissed' },
            { state: 'snoozed', snoozedUntil: { gt: now } },
            // A snooze with no end date stays hidden until acted on.
            { state: 'snoozed', snoozedUntil: null },
          ],
        },
        select: { alertId: true },
        take: cap + 1,
      }),
    );
    if (rows.length > cap) {
      this.logger.warn(
        `hiddenAlertIds: user ${userId} has more than ${cap} hidden alerts; ` +
          `truncating the exclusion list — some dismissed/snoozed alerts will reappear in the feed.`,
      );
      return rows.slice(0, cap).map((r) => r.alertId);
    }
    return rows.map((r) => r.alertId);
  }

  /**
   * Apply one patch to many alerts. Capped at BULK_MAX so a 500-alert triage
   * cannot issue an unbounded statement; the caller chunks and reports it.
   */
  async bulkSetState(
    tenantId: string,
    clientId: string,
    alertIds: string[],
    userId: string,
    patch: WorkStatePatch,
  ): Promise<{ updated: number }> {
    await this.watchlist.assertClientInTenant(tenantId, clientId);
    this.assertAssignable(patch);

    const ids = Array.from(new Set(alertIds)).slice(0, BULK_MAX);
    if (!ids.length) return { updated: 0 };
    if (alertIds.length > BULK_MAX) {
      this.logger.warn(
        `bulkSetState: received ${alertIds.length} ids, capped at ${BULK_MAX}; caller must chunk.`,
      );
    }

    const data = {
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.assignedTo !== undefined ? { assignedTo: patch.assignedTo } : {}),
      ...(patch.snoozedUntil !== undefined ? { snoozedUntil: patch.snoozedUntil } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      updatedBy: userId,
    };

    return this.prisma.withTenant(tenantId, async (tx) => {
      // One UPDATE for the rows that exist…
      const updated = await tx.intelAlertWorkState.updateMany({
        where: { tenantId, userId, alertId: { in: ids } },
        data,
      });
      // …then one createMany for the rest. skipDuplicates makes a racing
      // concurrent write a no-op rather than a P2002 500.
      const existing = await tx.intelAlertWorkState.findMany({
        where: { tenantId, userId, alertId: { in: ids } },
        select: { alertId: true },
      });
      const have = new Set(existing.map((r) => r.alertId));
      const missing = ids.filter((id) => !have.has(id));
      if (missing.length) {
        await tx.intelAlertWorkState.createMany({
          data: missing.map((alertId) => ({
            tenantId,
            clientId,
            alertId,
            userId,
            state: patch.state ?? 'new',
            ...data,
          })),
          skipDuplicates: true,
        });
      }
      return { updated: updated.count + missing.length };
    });
  }
}
