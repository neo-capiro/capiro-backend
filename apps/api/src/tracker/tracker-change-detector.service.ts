import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TrackerService } from './tracker.service.js';
import { TrackerAlertService } from './notifications/tracker-alert.service.js';
import {
  clearsMateriality,
  type AlertSeverity,
  type TrackerAlertEvent,
} from './notifications/tracker-notification.types.js';
import type { ChangeTone } from './tracker.types.js';
import { humanizeBillId } from './bill-stage.util.js';
import { explainMatch, type WatchlistLike } from './tracker-relevance.util.js';
import { TrackerSummaryService } from './notifications/tracker-summary.service.js';

interface ChangeClass {
  changeType: string;
  triggerKey: string;
  label: string;
  tone: ChangeTone;
  severity: AlertSeverity;
}

/**
 * Classify a tracked bill's action text into a material change, or null for
 * routine churn we don't alert on. Ordered most-significant first. Exported so
 * the change selector + unit tests share the exact same cascade.
 */
export function classifyChange(nextText: string | null): ChangeClass | null {
  const t = (nextText ?? '').toLowerCase();
  if (!t) return null;
  if (/became (public )?law|public law no|signed by (the )?president|enacted/.test(t))
    return {
      changeType: 'bill_enacted',
      triggerKey: 'enactedFailed',
      label: 'Became law',
      tone: 'success',
      severity: 'critical',
    };
  if (/presented to (the )?president|cleared for white house/.test(t))
    return {
      changeType: 'bill_to_president',
      triggerKey: 'enactedFailed',
      label: 'Sent to President',
      tone: 'success',
      severity: 'critical',
    };
  if (/failed|rejected|motion to table agreed|veto|tabled/.test(t))
    return {
      changeType: 'bill_failed',
      triggerKey: 'enactedFailed',
      label: 'Failed / rejected',
      tone: 'critical',
      severity: 'critical',
    };
  if (
    /passed\/agreed to in (the )?(house|senate)|passed (the )?(house|senate)|on passage[^.]*passed|agreed to in (the )?(house|senate)/.test(
      t,
    )
  )
    return {
      changeType: 'bill_passed_chamber',
      triggerKey: 'floorVote',
      label: 'Passed a chamber',
      tone: 'success',
      severity: 'notable',
    };
  // House Rules Committee activity: a special rule reported / granted means the
  // bill cleared Rules and is headed to the floor. Must precede bill_reported so
  // a rule resolution's "Reported to House" isn't mislabeled a committee report;
  // floor passage above still wins for a combined "...under the rule and passed".
  if (
    /rules committee|committee on rules|provides for consideration|considered under the provisions|pursuant to (the provisions of )?(h\.? ?res|house resolution)|(closed|structured|open|special) rule/.test(
      t,
    )
  )
    return {
      changeType: 'bill_rule_reported',
      triggerKey: 'floorVote',
      label: 'Rule granted (floor scheduled)',
      tone: 'info',
      severity: 'notable',
    };
  if (/placed on (the )?(union |senate )?calendar|scheduled for (floor|consideration)/.test(t))
    return {
      changeType: 'bill_floor_scheduled',
      triggerKey: 'floorVote',
      label: 'Floor action scheduled',
      tone: 'info',
      severity: 'notable',
    };
  if (
    /ordered to be reported|reported (by|to|favorably)|committee agreed to seek consideration/.test(
      t,
    )
  )
    return {
      changeType: 'bill_reported',
      triggerKey: 'committeeVote',
      label: 'Passed committee',
      tone: 'success',
      severity: 'notable',
    };
  if (/markup|marked up|committee consideration and mark/.test(t))
    return {
      changeType: 'bill_markup',
      triggerKey: 'committeeVote',
      label: 'Markup',
      tone: 'info',
      severity: 'notable',
    };
  if (/hearing/.test(t))
    return {
      changeType: 'bill_hearing',
      triggerKey: 'hearing',
      label: 'Hearing scheduled',
      tone: 'info',
      severity: 'info',
    };
  if (/amendment|amended|substitute/.test(t))
    return {
      changeType: 'bill_amendment',
      triggerKey: 'amendment',
      label: 'Amended',
      tone: 'notable',
      severity: 'notable',
    };
  return null;
}

/** A single bill action (DB row or the bill's rollup latest action). */
export interface ActionLike {
  date: Date | null;
  text: string | null;
}

/** A distinct material change selected for one detection cycle. */
export interface MaterialEvent {
  cls: ChangeClass;
  text: string;
  date: Date | null;
}

/**
 * Given a tracked bill's NEW actions since its snapshot (already filtered to
 * strictly-newer-than `lastSeenActionDate`) plus the bill's rollup latest
 * action, return the distinct material changes to alert on — one per changeType,
 * in chronological order.
 *
 * `latest` is always merged in so we never regress below the legacy
 * latest-action-only behavior when action rows are missing or stale. De-duping
 * by changeType means a burst that crosses several stages alerts each stage
 * once; the caller's NotificationLog/IntelligenceChange dedupe is the backstop
 * across runs.
 */
export function selectMaterialEvents(
  actions: ActionLike[],
  latest: ActionLike | null,
): MaterialEvent[] {
  const merged: ActionLike[] = [...actions];
  if (latest && latest.text) {
    const dup = merged.some(
      (a) =>
        (a.text ?? '') === (latest.text ?? '') &&
        (a.date?.getTime() ?? 0) === (latest.date?.getTime() ?? 0),
    );
    if (!dup) merged.push(latest);
  }
  merged.sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));

  const out: MaterialEvent[] = [];
  const seen = new Set<string>();
  for (const a of merged) {
    const cls = classifyChange(a.text);
    if (!cls) continue;
    if (seen.has(cls.changeType)) continue;
    seen.add(cls.changeType);
    out.push({ cls, text: a.text ?? '', date: a.date });
  }
  return out;
}

/**
 * Scans tracked bills for material legislative moves, snapshots each bill's
 * last-seen action so a move alerts exactly once, writes an IntelligenceChange
 * (for the in-app changes inbox + board change chip), and fans the alert out to
 * each user's email/SMS channels via TrackerAlertService.
 *
 * Two robustness layers beyond the original latest-action-only design:
 *  - Catch-up: scans congress_bill_action rows newer than the snapshot, so a
 *    skipped/failed run or a burst of actions never drops an intermediate move
 *    (TRACKER_SCAN_ACTION_HISTORY).
 *  - Enrichment: attaches a deterministic "why this matters to {client}" line +
 *    matched watchlist tags to each alert (TRACKER_ALERT_ENRICH).
 * Both are flag-guarded and fail-safe: any enrichment error degrades to a bare
 * alert rather than dropping it.
 */
@Injectable()
export class TrackerChangeDetectorService {
  private readonly logger = new Logger(TrackerChangeDetectorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: TrackerAlertService,
    private readonly tracker: TrackerService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly summaries: TrackerSummaryService,
  ) {}

  async runDetectionCycle(): Promise<{
    scanned: number;
    baseline: number;
    changed: number;
    alerted: number;
    suppressedOwned: number;
    byType: Record<string, number>;
  }> {
    const scanHistory = this.config.get('TRACKER_SCAN_ACTION_HISTORY', { infer: true });
    const enrich = this.config.get('TRACKER_ALERT_ENRICH', { infer: true });
    const singleSenderGuard = this.config.get('TRACKER_SINGLE_SENDER_GUARD', { infer: true });

    // Cross-tenant read of the board-membership rows.
    const tracked = await this.prisma.withSystem((tx) =>
      tx.trackedBill.findMany({
        select: {
          id: true,
          tenantId: true,
          clientId: true,
          billId: true,
          lastSeenActionText: true,
          lastSeenActionDate: true,
          lastSeenAt: true,
        },
      }),
    );
    if (!tracked.length)
      return { scanned: 0, baseline: 0, changed: 0, alerted: 0, suppressedOwned: 0, byType: {} };

    // Single-sender guard (Capiro Intelligence cutover, plan §8/Phase 8): the set
    // of tenants intel-api has taken DELIVERY ownership of. Read once per cycle;
    // on failure `intelOwnedTenantIds` THROWS and aborts the whole cycle (no
    // delivery this run, retried next) rather than risk sending from BOTH legacy
    // and intel — no-double-send is the paramount invariant. Empty (no-op) unless
    // TRACKER_SINGLE_SENDER_GUARD is on, so legacy behavior is unchanged today.
    const intelOwned = singleSenderGuard ? await this.intelOwnedTenantIds() : new Set<string>();
    if (singleSenderGuard && intelOwned.size) {
      this.logger.log(
        `single-sender guard ON: suppressing legacy delivery for ${intelOwned.size} intel-owned tenant(s)`,
      );
    }

    const billIds = Array.from(new Set(tracked.map((t) => t.billId)));
    const bills = await this.prisma.congressBill.findMany({
      where: { id: { in: billIds } },
      select: {
        id: true,
        title: true,
        latestActionText: true,
        latestActionDate: true,
        url: true,
        subjects: true,
        policyArea: true,
      },
    });
    const billById = new Map(bills.map((b) => [b.id, b]));

    // Catch-up: per-bill action history (only when enabled), grouped by bill.
    const actionsByBill = new Map<string, ActionLike[]>();
    if (scanHistory) {
      const actions = await this.prisma.congressBillAction.findMany({
        where: { billId: { in: billIds } },
        select: { billId: true, date: true, text: true },
        orderBy: { date: 'asc' },
      });
      for (const a of actions) {
        const arr = actionsByBill.get(a.billId) ?? [];
        arr.push({ date: a.date, text: a.text });
        actionsByBill.set(a.billId, arr);
      }
    }

    // Per-tenant caches for nicer copy + enrichment (one lookup per client).
    const clientNameById = new Map<string, string>();
    const watchlistByClient = new Map<string, WatchlistLike>();
    // One LLM summary per tenant+bill+changeType per run (multiple clients in a
    // tenant tracking the same bill reuse it — don't re-spend the tenant's key).
    const summaryByEvent = new Map<string, string | null>();

    let baseline = 0;
    let changed = 0;
    let alerted = 0;
    let suppressedOwned = 0;
    const byType: Record<string, number> = {};

    for (const row of tracked) {
      const bill = billById.get(row.billId);
      if (!bill) continue;

      // First time we see this tracked bill — record a baseline, never alert on
      // the historical state.
      if (!row.lastSeenAt) {
        await this.snapshot(row.tenantId, row.id, bill.latestActionText, bill.latestActionDate);
        baseline += 1;
        continue;
      }

      const textChanged = (bill.latestActionText ?? '') !== (row.lastSeenActionText ?? '');
      const dateAdvanced =
        bill.latestActionDate != null &&
        (row.lastSeenActionDate == null ||
          bill.latestActionDate.getTime() > row.lastSeenActionDate.getTime());
      if (!textChanged && !dateAdvanced) continue;

      // Build the material events to alert on. Strictly-newer-than-snapshot
      // action rows guarantee we never re-alert the baselined state.
      let events: MaterialEvent[];
      if (scanHistory) {
        const newActions = (actionsByBill.get(row.billId) ?? []).filter(
          (a) =>
            a.date != null &&
            (row.lastSeenActionDate == null || a.date.getTime() > row.lastSeenActionDate.getTime()),
        );
        const latest: ActionLike | null =
          bill.latestActionText != null || bill.latestActionDate != null
            ? { date: bill.latestActionDate, text: bill.latestActionText }
            : null;
        events = selectMaterialEvents(newActions, latest);
      } else {
        const cls = classifyChange(bill.latestActionText);
        events = cls
          ? [{ cls, text: bill.latestActionText ?? '', date: bill.latestActionDate }]
          : [];
      }

      if (!events.length) {
        // Routine churn (no material change) — safe to advance the snapshot now.
        await this.snapshot(row.tenantId, row.id, bill.latestActionText, bill.latestActionDate);
        continue;
      }

      // Resolve a client name for copy (cached).
      let clientName = clientNameById.get(row.clientId) ?? null;
      if (clientName === null && !clientNameById.has(row.clientId)) {
        const c = await this.prisma.withTenant(row.tenantId, (tx) =>
          tx.client.findFirst({ where: { id: row.clientId }, select: { name: true } }),
        );
        clientName = c?.name ?? null;
        clientNameById.set(row.clientId, clientName ?? '');
      }

      // Client-context enrichment — never let it break delivery.
      let why: string | null = null;
      let matchedTags: string[] = [];
      if (enrich) {
        try {
          const wl = await this.watchlistFor(row.tenantId, row.clientId, watchlistByClient);
          const ex = explainMatch(
            {
              title: bill.title,
              policyArea: bill.policyArea,
              subjects: bill.subjects,
              latestActionText: bill.latestActionText,
            },
            wl,
          );
          why = ex.why;
          matchedTags = ex.matchedTags;
        } catch (e) {
          this.logger.warn(
            `Enrichment failed for ${row.billId} (client ${row.clientId}); sending bare alert: ${(e as Error).message}`,
          );
        }
      }

      // Wrap the per-row side effects so a transient DB failure neither aborts
      // the whole cycle nor advances the snapshot (the move re-triggers next run).
      try {
        const displayNum = humanizeBillId(row.billId);
        for (const ev of events) {
          const actionDate = ev.date ? ev.date.toISOString().slice(0, 10) : null;
          const detail = ev.text || `${displayNum} — ${bill.title}`;

          // LLM "what happened" summary on the tenant's own Anthropic key
          // (cached per tenant+bill+changeType for this run). Fail-safe → null.
          const summaryKey = `${row.tenantId}:${row.billId}:${ev.cls.changeType}`;
          let summary = summaryByEvent.get(summaryKey) ?? null;
          if (!summaryByEvent.has(summaryKey)) {
            summary = await this.summaries.summarize({
              tenantId: row.tenantId,
              displayNum,
              billTitle: bill.title,
              label: ev.cls.label,
              actionText: detail,
            });
            summaryByEvent.set(summaryKey, summary);
          }

          // In-app surface: an IntelligenceChange (deduped per bill+changeType+
          // client within 14 days), mirroring emit-bill-alerts.
          await this.emitIntelligenceChange(
            row.clientId,
            row.billId,
            bill,
            ev.cls,
            detail,
            actionDate,
            why,
            matchedTags,
            summary,
          );

          const event: TrackerAlertEvent = {
            tenantId: row.tenantId,
            clientId: row.clientId,
            clientName,
            billId: row.billId,
            displayNum,
            billTitle: bill.title,
            changeType: ev.cls.changeType,
            triggerKey: ev.cls.triggerKey,
            label: ev.cls.label,
            tone: ev.cls.tone,
            severity: ev.cls.severity,
            detail,
            actionDate,
            url: '', // filled by the alert service (boardUrl)
            why,
            matchedTags,
            summary,
          };
          if (singleSenderGuard && intelOwned.has(row.tenantId)) {
            suppressedOwned += 1; // intel-api owns delivery for this tenant (cutover) — single-sender guard
          } else {
            await this.alerts.fanOut(event);
            alerted += 1;
          }

          byType[ev.cls.changeType] = (byType[ev.cls.changeType] ?? 0) + 1;
        }

        // Advance the snapshot ONLY after every move was durably surfaced +
        // fanned out. Re-running a row is safe: emitIntelligenceChange dedupes
        // and the NotificationLog claim is idempotent.
        await this.snapshot(row.tenantId, row.id, bill.latestActionText, bill.latestActionDate);
        changed += 1;
      } catch (e) {
        this.logger.error(
          `Tracker fan-out failed for ${row.billId} (tenant ${row.tenantId}); leaving snapshot un-advanced to retry next cycle: ${(e as Error).message}`,
        );
      }
    }

    return { scanned: tracked.length, baseline, changed, alerted, suppressedOwned, byType };
  }

  /**
   * Tenants intel-api has taken DELIVERY ownership of for the tracker cutover:
   * an ENABLED `intel_feature_flag` row for feature='tracker_owner_intel'. Reads
   * the intel-api-owned table directly (shared Aurora), cross-tenant.
   *
   * MUST run under `withSystem` (RLS bypass): once the intel_full_rls_hold
   * migration FORCE-enables RLS on intel_feature_flag, a plain read on apps/api's
   * connection (which sets no tenant GUC) returns ZERO rows — apps/api would then
   * conclude NO tenant is intel-owned and keep delivering bill alerts for tenants
   * intel-api is ALSO delivering for = a silent DOUBLE-SEND to real recipients
   * (breaks the no-double-send invariant). withSystem sets app.bypass_rls so the
   * policy admits all rows regardless of tenant context.
   *
   * Deliberately does NOT honor intel-api's internal-tenant always-on hardcode
   * (CAPIRO_INTERNAL_TENANT_ID): intel does not DELIVER for the internal tenant
   * during shadow, so legacy must keep sending there; only an explicit per-tenant
   * flag row transfers delivery. THROWS on read failure so the caller aborts the
   * cycle rather than deliver from both senders (no-double-send invariant).
   */
  private async intelOwnedTenantIds(): Promise<Set<string>> {
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ tenant_id: string }>>(
        `SELECT tenant_id FROM intel_feature_flag WHERE feature = 'tracker_owner_intel' AND enabled = true`,
      ),
    );
    return new Set(rows.map((r) => r.tenant_id));
  }

  /**
   * READ-ONLY readiness report: per tenant, how many bills are tracked, how
   * many alert prefs have email enabled, how many tracked bills have a pending
   * material move (not yet snapshotted), and how many of those would actually
   * email someone under current gates. Sends nothing — answers "will the next
   * cycle do something, and is anyone configured to receive it?".
   */
  async readinessReport(): Promise<{
    tenants: {
      tenantId: string;
      trackedBills: number;
      emailEnabledPrefs: number;
      pendingChanges: number;
      wouldEmail: number;
    }[];
    totals: {
      trackedBills: number;
      emailEnabledPrefs: number;
      pendingChanges: number;
      wouldEmail: number;
    };
  }> {
    const scanHistory = this.config.get('TRACKER_SCAN_ACTION_HISTORY', { infer: true });

    const tracked = await this.prisma.withSystem((tx) =>
      tx.trackedBill.findMany({
        select: {
          tenantId: true,
          clientId: true,
          billId: true,
          lastSeenActionText: true,
          lastSeenActionDate: true,
          lastSeenAt: true,
        },
      }),
    );
    const prefs = await this.prisma.withSystem((tx) =>
      tx.alertPreference.findMany({
        select: {
          tenantId: true,
          clientId: true,
          emailEnabled: true,
          emailAddress: true,
          triggers: true,
          materiality: true,
        },
      }),
    );

    const byTenant = new Map<
      string,
      {
        trackedBills: number;
        emailEnabledPrefs: number;
        pendingChanges: number;
        wouldEmail: number;
      }
    >();
    const bump = (t: string) => {
      const e = byTenant.get(t) ?? {
        trackedBills: 0,
        emailEnabledPrefs: 0,
        pendingChanges: 0,
        wouldEmail: 0,
      };
      byTenant.set(t, e);
      return e;
    };

    for (const p of prefs) {
      if (p.emailEnabled && p.emailAddress) bump(p.tenantId).emailEnabledPrefs += 1;
    }

    const prefsByClient = new Map<string, typeof prefs>();
    for (const p of prefs) {
      const k = `${p.tenantId}:${p.clientId}`;
      const arr = prefsByClient.get(k) ?? [];
      arr.push(p);
      prefsByClient.set(k, arr);
    }

    const billIds = Array.from(new Set(tracked.map((t) => t.billId)));
    const bills = billIds.length
      ? await this.prisma.congressBill.findMany({
          where: { id: { in: billIds } },
          select: { id: true, latestActionText: true, latestActionDate: true },
        })
      : [];
    const billById = new Map(bills.map((b) => [b.id, b]));

    const actionsByBill = new Map<string, ActionLike[]>();
    if (scanHistory && billIds.length) {
      const actions = await this.prisma.congressBillAction.findMany({
        where: { billId: { in: billIds } },
        select: { billId: true, date: true, text: true },
        orderBy: { date: 'asc' },
      });
      for (const a of actions) {
        const arr = actionsByBill.get(a.billId) ?? [];
        arr.push({ date: a.date, text: a.text });
        actionsByBill.set(a.billId, arr);
      }
    }

    for (const row of tracked) {
      const e = bump(row.tenantId);
      e.trackedBills += 1;
      const bill = billById.get(row.billId);
      if (!bill || !row.lastSeenAt) continue; // unbaselined rows aren't "pending"

      let events: MaterialEvent[];
      if (scanHistory) {
        const newActions = (actionsByBill.get(row.billId) ?? []).filter(
          (a) =>
            a.date != null &&
            (row.lastSeenActionDate == null || a.date.getTime() > row.lastSeenActionDate.getTime()),
        );
        const latest: ActionLike | null =
          bill.latestActionText != null || bill.latestActionDate != null
            ? { date: bill.latestActionDate, text: bill.latestActionText }
            : null;
        events = selectMaterialEvents(newActions, latest);
      } else {
        const cls = classifyChange(bill.latestActionText);
        events = cls
          ? [{ cls, text: bill.latestActionText ?? '', date: bill.latestActionDate }]
          : [];
      }
      if (!events.length) continue;
      e.pendingChanges += 1;

      const clientPrefs = prefsByClient.get(`${row.tenantId}:${row.clientId}`) ?? [];
      const deliverable = clientPrefs.some(
        (p) =>
          p.emailEnabled &&
          p.emailAddress &&
          events.some(
            (ev) =>
              p.triggers.includes(ev.cls.triggerKey) &&
              clearsMateriality(ev.cls.severity, p.materiality),
          ),
      );
      if (deliverable) e.wouldEmail += 1;
    }

    const tenants = Array.from(byTenant.entries()).map(([tenantId, v]) => ({ tenantId, ...v }));
    const totals = tenants.reduce(
      (acc, t) => ({
        trackedBills: acc.trackedBills + t.trackedBills,
        emailEnabledPrefs: acc.emailEnabledPrefs + t.emailEnabledPrefs,
        pendingChanges: acc.pendingChanges + t.pendingChanges,
        wouldEmail: acc.wouldEmail + t.wouldEmail,
      }),
      { trackedBills: 0, emailEnabledPrefs: 0, pendingChanges: 0, wouldEmail: 0 },
    );
    return { tenants, totals };
  }

  /**
   * READ-ONLY per-bill alert diagnosis: is this bill in the congress DB, who
   * tracks it (and is it baselined), is there a pending material move now (using
   * the SAME unchanged-since-snapshot guard as detection), and — per tracking
   * client — the alert-pref gate breakdown showing exactly why each would or
   * wouldn't EMAIL a floor-vote-class event (Rules-report / passage). Answers
   * "will <bill> alert, to whom, and if not what's blocking it?". Sends nothing.
   */
  async billStatus(billId: string): Promise<{
    billId: string;
    inCongressDb: boolean;
    latestActionText: string | null;
    latestActionDate: string | null;
    pendingTypes: string[];
    trackedBy: {
      tenantId: string;
      clientId: string;
      clientName: string | null;
      baselined: boolean;
      lastSeenActionDate: string | null;
      currentlyPending: boolean;
      prefs: {
        emailEnabled: boolean;
        hasAddress: boolean;
        floorVoteTrigger: boolean;
        materiality: string;
        emailReady: boolean;
        blockedBy: string | null;
      }[];
    }[];
  }> {
    const scanHistory = this.config.get('TRACKER_SCAN_ACTION_HISTORY', { infer: true });

    const bill = await this.prisma.congressBill.findUnique({
      where: { id: billId },
      select: { id: true, latestActionText: true, latestActionDate: true },
    });

    const tracked = await this.prisma.withSystem((tx) =>
      tx.trackedBill.findMany({
        where: { billId },
        select: {
          tenantId: true,
          clientId: true,
          lastSeenAt: true,
          lastSeenActionText: true,
          lastSeenActionDate: true,
        },
      }),
    );

    const clientIds = Array.from(new Set(tracked.map((t) => t.clientId)));
    const [prefs, clients] = await Promise.all([
      clientIds.length
        ? this.prisma.withSystem((tx) =>
            tx.alertPreference.findMany({
              where: { clientId: { in: clientIds } },
              select: {
                tenantId: true,
                clientId: true,
                emailEnabled: true,
                emailAddress: true,
                triggers: true,
                materiality: true,
              },
            }),
          )
        : Promise.resolve([]),
      clientIds.length
        ? this.prisma.withSystem((tx) =>
            tx.client.findMany({
              where: { id: { in: clientIds } },
              select: { id: true, name: true },
            }),
          )
        : Promise.resolve([]),
    ]);
    const nameById = new Map(clients.map((c) => [c.id, c.name]));

    let actions: ActionLike[] = [];
    if (scanHistory && bill) {
      const rows = await this.prisma.congressBillAction.findMany({
        where: { billId },
        select: { date: true, text: true },
        orderBy: { date: 'asc' },
      });
      actions = rows.map((a) => ({ date: a.date, text: a.text }));
    }

    // Gate breakdown for a floor-vote-class (notable) event — the class a
    // Rules-report / passage emits. blockedBy names the FIRST failing gate.
    const gate = (p: (typeof prefs)[number]) => {
      const floorVoteTrigger = p.triggers.includes('floorVote');
      const hasAddress = !!p.emailAddress;
      let blockedBy: string | null = null;
      if (!p.emailEnabled) blockedBy = 'email_disabled';
      else if (!hasAddress) blockedBy = 'no_email_address';
      else if (!floorVoteTrigger) blockedBy = 'floorVote_trigger_off';
      else if (!clearsMateriality('notable', p.materiality)) blockedBy = 'materiality_too_high';
      return {
        emailEnabled: p.emailEnabled,
        hasAddress,
        floorVoteTrigger,
        materiality: p.materiality,
        emailReady: blockedBy == null,
        blockedBy,
      };
    };

    const pendingTypes = new Set<string>();
    const trackedBy = tracked.map((row) => {
      let events: MaterialEvent[] = [];
      const textChanged = (bill?.latestActionText ?? '') !== (row.lastSeenActionText ?? '');
      const dateAdvanced =
        bill != null &&
        bill.latestActionDate != null &&
        (row.lastSeenActionDate == null ||
          bill.latestActionDate.getTime() > row.lastSeenActionDate.getTime());
      // Match detection's guard: an unchanged-since-snapshot action is NOT pending.
      if (bill && row.lastSeenAt && (textChanged || dateAdvanced)) {
        if (scanHistory) {
          const newActions = actions.filter(
            (a) =>
              a.date != null &&
              (row.lastSeenActionDate == null ||
                a.date.getTime() > row.lastSeenActionDate.getTime()),
          );
          const latest: ActionLike | null =
            bill.latestActionText != null || bill.latestActionDate != null
              ? { date: bill.latestActionDate, text: bill.latestActionText }
              : null;
          events = selectMaterialEvents(newActions, latest);
        } else {
          const cls = classifyChange(bill.latestActionText);
          events = cls
            ? [{ cls, text: bill.latestActionText ?? '', date: bill.latestActionDate }]
            : [];
        }
      }
      events.forEach((ev) => pendingTypes.add(ev.cls.changeType));

      const clientPrefs = prefs.filter(
        (p) => p.tenantId === row.tenantId && p.clientId === row.clientId,
      );
      return {
        tenantId: row.tenantId,
        clientId: row.clientId,
        clientName: nameById.get(row.clientId) ?? null,
        baselined: row.lastSeenAt != null,
        lastSeenActionDate: row.lastSeenActionDate
          ? row.lastSeenActionDate.toISOString().slice(0, 10)
          : null,
        currentlyPending: events.length > 0,
        prefs: clientPrefs.map(gate),
      };
    });

    return {
      billId,
      inCongressDb: bill != null,
      latestActionText: bill?.latestActionText ?? null,
      latestActionDate: bill?.latestActionDate
        ? bill.latestActionDate.toISOString().slice(0, 10)
        : null,
      pendingTypes: Array.from(pendingTypes),
      trackedBy,
    };
  }

  /** Resolve + cache a client's watchlist (for enrichment). Never throws. */
  private async watchlistFor(
    tenantId: string,
    clientId: string,
    cache: Map<string, WatchlistLike>,
  ): Promise<WatchlistLike> {
    const cached = cache.get(clientId);
    if (cached) return cached;
    let wl: WatchlistLike = { issueAreas: [], tags: [] };
    try {
      wl = await this.tracker.getWatchlist(clientId, tenantId);
    } catch (e) {
      this.logger.warn(`getWatchlist failed for ${clientId}: ${(e as Error).message}`);
    }
    cache.set(clientId, wl);
    return wl;
  }

  private async snapshot(
    tenantId: string,
    trackedBillId: string,
    actionText: string | null,
    actionDate: Date | null,
  ): Promise<void> {
    await this.prisma.withSystem((tx) =>
      tx.trackedBill.update({
        where: { id: trackedBillId },
        data: {
          lastSeenActionText: actionText,
          lastSeenActionDate: actionDate,
          lastSeenAt: new Date(),
        },
      }),
    );
  }

  private async emitIntelligenceChange(
    clientId: string,
    billId: string,
    bill: { title: string; url: string | null },
    cls: ChangeClass,
    detail: string,
    actionDate: string | null,
    why: string | null,
    matchedTags: string[],
    summary: string | null,
  ): Promise<void> {
    const dedupeSince = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const existing = await this.prisma.intelligenceChange.findFirst({
      where: {
        source: 'congress_bill',
        changeType: cls.changeType,
        detectedAt: { gte: dedupeSince },
        relatedClientIds: { has: clientId },
        data: { path: ['bill_id'], equals: billId },
      },
      select: { id: true },
    });
    if (existing) return;
    const label = humanizeBillId(billId);
    await this.prisma.intelligenceChange.create({
      data: {
        source: 'congress_bill',
        changeType: cls.changeType,
        severity: cls.severity,
        title: `${label}: ${cls.label}`,
        description: detail || `${label} — ${bill.title}`,
        relatedClientIds: [clientId],
        relatedIssues: matchedTags ?? [],
        data: {
          bill_id: billId,
          stage: cls.label,
          bill_title: bill.title,
          action_date: actionDate,
          url: bill.url ?? null,
          tracker: true,
          why: why ?? null,
          matched_tags: matchedTags ?? [],
          summary: summary ?? null,
        },
      },
    });
  }
}
