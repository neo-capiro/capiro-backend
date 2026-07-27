import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
    // Gate J (HP-06): setState had the client check but not the alert↔client
    // one — a triage write under client B's route for client A's alertId
    // would upsert a mismatched row (create stamps the URL clientId; forAlerts
    // reads it back under A's real client, but hiddenAlertIds filters by
    // clientId and never finds it, so a dismiss filed this way silently fails
    // to hide the alert).
    await this.watchlist.assertAlertInClient(tenantId, clientId, alertId);
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
   * The alert ids this user has a row in ANY of `states`, for this
   * (tenant[, client]) scope. `snoozed` is special-cased to mean an ACTIVE
   * snooze only — `snoozedUntil` in the future, or unset (a snooze with no end
   * date stays "snoozed" until acted on). An EXPIRED snooze (`snoozedUntil` in
   * the past) never matches `snoozed` here; per the RB-01 fix it is treated as
   * visible again, same as the default view already did.
   *
   * Deliberately uncapped (Gate F / MP-06): the prior `hiddenAlertIds` capped
   * at 5,000 and silently truncated past it, so some dismissed/snoozed alerts
   * would reappear for a heavy user. This is a per-(tenant,user[,client])
   * working set against an indexed scope (`intel_alert_work_state_scope_idx`
   * on (tenant_id, client_id, user_id, state)), not an unbounded table scan —
   * there is no volume at which capping is the safer choice over correctness.
   */
  async alertIdsInState(
    tenantId: string,
    userId: string,
    clientId: string | null,
    states: WorkStateValue[],
  ): Promise<string[]> {
    if (!states.length) return [];
    const now = new Date();
    const wantsSnoozed = states.includes('snoozed');
    const otherStates = states.filter((s) => s !== 'snoozed');
    // One flat { state: s } branch per non-snoozed state (not `state: { in: [...] }`)
    // — keeps every OR branch a simple state-equality clause, matching the shape
    // the snoozed branches below already use.
    const or: Record<string, unknown>[] = otherStates.map((s) => ({ state: s }));
    if (wantsSnoozed) {
      or.push({ state: 'snoozed', snoozedUntil: { gt: now } });
      or.push({ state: 'snoozed', snoozedUntil: null });
    }
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelAlertWorkState.findMany({
        where: {
          tenantId,
          userId,
          ...(clientId ? { clientId } : {}),
          OR: or,
        },
        select: { alertId: true },
      }),
    );
    return rows.map((r) => r.alertId);
  }

  /**
   * The alert ids this user has actively hidden — dismissed, or actively
   * snoozed. Feeds the feed's DEFAULT-view exclusion predicate. A thin,
   * semantically-named wrapper over alertIdsInState so getFeed's default
   * branch reads the same as it always did.
   */
  async hiddenAlertIds(
    tenantId: string,
    userId: string,
    clientId: string | null,
  ): Promise<string[]> {
    return this.alertIdsInState(tenantId, userId, clientId, ['dismissed', 'snoozed']);
  }

  /**
   * Apply one patch to many alerts. Capped at BULK_MAX so a 500-alert triage
   * cannot issue an unbounded statement; the caller chunks and reports it.
   *
   * Gate J (HP-06/J-3, §6 open decision 1): previously checked client
   * ownership but NOT that each alertId belonged to that client at all — the
   * update/create predicates below matched on `(tenantId, userId, alertId)`
   * only. Now proves every id up front and REJECTS THE WHOLE BATCH if any is
   * foreign, per the plan's recommendation: a partial bulk write is exactly
   * the mismatched state this gate exists to prevent, so this changes the
   * response shape from "always {updated: n}" to "throws, or {updated: n}
   * for a fully-owned batch" — never a partial success.
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

    const owned = await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelAlert.findMany({
        where: { id: { in: ids }, tenantId, clientId },
        select: { id: true },
      }),
    );
    const ownedIds = new Set(owned.map((a) => a.id));
    const foreign = ids.filter((id) => !ownedIds.has(id));
    if (foreign.length) {
      this.logger.warn(
        `bulkSetState rejected: ${foreign.length}/${ids.length} alert id(s) do not belong to ` +
          `client=${clientId} tenant=${tenantId} — no changes written.`,
      );
      throw new NotFoundException({
        code: 'ALERT_NOT_IN_CLIENT',
        message: 'One or more alerts do not belong to this client. No changes were made.',
      });
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
