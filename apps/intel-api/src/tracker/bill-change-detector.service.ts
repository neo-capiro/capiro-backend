import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { humanizeStateBillKey, computeStateDeadlineRisk } from '@capiro/shared';
import {
  SourceDataRepository,
  type SourceBill,
  type SourceRuleVote,
  type SourceFiscalNote,
  type SourceCosponsorMomentum,
  type SourceHearingForBill,
} from '../sourcedata/source-data.repository.js';
import {
  StateSourceDataRepository,
  type SourceStateBill,
  type SourceStateSponsorMomentum,
  type SourceStateVote,
  type SourceMovedCompanion,
  type SourceStateSessionCalendar,
} from '../sourcedata/state-source-data.repository.js';
import {
  classifyChange,
  classifyStatusChange,
  classifyStateStatusChange,
  stateVoteRecordedClass,
  STATE_COMPANION_MOVED_CLASS,
  stateDeadlineClass,
  cosponsorMomentumClass,
  dedupeByChangeType,
  parseTally,
  selectMaterialEvents,
  severityToMateriality,
  FISCAL_NOTE_CLASS,
  TEXT_CHANGED_CLASS,
  HEARING_SCHEDULED_CLASS,
  type ActionLike,
  type MaterialEvent,
} from './change-detector.util.js';
import { explainMatch, humanizeBillId, type WatchlistLike } from './relevance.util.js';
import { scoreShadowAlert } from '../intel-alert/alert-scorer.js';

/** Minimum new-cosponsors-in-7d to fire a momentum alert (plan B8 default 5). */
const COSPONSOR_MOMENTUM_MIN_7D = (() => {
  const n = Number(process.env.LEGIWATCH_COSPONSOR_MIN_7D);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
})();
/** Rolling window (days) for the CBO-fiscal-note sweep — matches the 14-day alert dedup. */
const DERIVED_WINDOW_DAYS = 14;
const COSPONSOR_WINDOW_DAYS = 7;

/** YYYY-MM-DD for `computeStateDeadlineRisk` (M2.3) — null-safe. */
function toDateOnly(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/**
 * Shadow bill-change detector (Phase 3, plan §6.3) — a faithful port of legacy
 * `runDetectionCycle` with the DELIVERY leg severed. It reads tracked bills +
 * their live congress_bill state, classifies material moves, and writes
 * `intel_alert` rows with `status='new'` (never delivered). No alert/email/SMS
 * import, no IntelligenceChange emit — single-sender is preserved (legacy still
 * owns delivery). No Bedrock: detection is `classifyChange` + keyword
 * `explainMatch`; summaries/embeddings are Phase 4.
 *
 * RLS (G3): the top-level tracked-bill scan is cross-tenant (reads every
 * tenant's tracked bills to fan out) → `withSystem`; the per-row writes
 * (snapshot, shadow-alert dedup+create) and per-client watchlist reads are
 * scoped to that row's tenant → `withTenant(row.tenantId)`. `congress_bill*`
 * reads are GLOBAL (via SourceDataRepository) and RLS-free. Overlap safety
 * relies on the strictly-newer-than-snapshot filter + the 14-day dedup (plan
 * §6.5: "idempotency holds even without the lock"); a rare concurrent
 * double-write is caught by the dedup and surfaced in Phase 5 parity.
 */
type TrackedRow = {
  id: string;
  tenantId: string;
  clientId: string;
  billId: string;
  source: string;
  lastSeenActionText: string | null;
  lastSeenActionDate: Date | null;
  lastSeenAt: Date | null;
  // LegiWatch B derived-signal watermarks (advance atomically with the action
  // watermark in snapshot()); null on legacy rows until the first sweep baselines.
  lastSeenStatus: string | null;
  lastSeenCosponsors: number | null;
  lastSeenTextDate: Date | null;
  // Last-alerted CBO estimate id / soonest-hearing id — B7/B3 fire only on a new
  // id, so a pre-existing estimate/hearing can't false-alert and neither re-fires
  // every time the 14-day alert-dedup window lapses.
  lastSeenFiscalId: string | null;
  lastSeenHearingKey: string | null;
};

/** The watermarks snapshot() persists together (retry-safe: only after every event is durably written). */
type Watermark = {
  actionText: string | null;
  actionDate: Date | null;
  status: string | null;
  cosponsors: number | null;
  textDate: Date | null;
  fiscalId: string | null;
  hearingKey: string | null;
};

export interface DetectionSummary {
  scanned: number;
  baseline: number;
  changed: number;
  alertsWritten: number;
  skippedDedup: number;
  byType: Record<string, number>;
}

@Injectable()
export class BillChangeDetectorService {
  private readonly logger = new Logger(BillChangeDetectorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly source: SourceDataRepository,
    private readonly stateSource: StateSourceDataRepository,
  ) {}

  async runDetectionCycle(): Promise<DetectionSummary> {
    const scanHistory = ['true', '1', 'yes'].includes(
      (process.env.TRACKER_SCAN_ACTION_HISTORY ?? '').toLowerCase(),
    );
    const zero: DetectionSummary = {
      scanned: 0,
      baseline: 0,
      changed: 0,
      alertsWritten: 0,
      skippedDedup: 0,
      byType: {},
    };

    // Cross-tenant scan: read EVERY tenant's tracked bills to fan out; each
    // row's writes below re-scope to row.tenantId. Under RLS this MUST bypass.
    const allTracked: TrackedRow[] = await this.prisma.withSystem((tx) =>
      tx.trackedBill.findMany({
        select: {
          id: true,
          tenantId: true,
          clientId: true,
          billId: true,
          source: true,
          lastSeenActionText: true,
          lastSeenActionDate: true,
          lastSeenAt: true,
          lastSeenStatus: true,
          lastSeenCosponsors: true,
          lastSeenTextDate: true,
          lastSeenFiscalId: true,
          lastSeenHearingKey: true,
        },
      }),
    );
    if (!allTracked.length) return zero;

    // DD3 (Phase 0 plan): partition by source, resolve each partition against
    // its own reads. The 8 lastSeen* watermarks are jurisdiction-agnostic and
    // reused as-is by both partitions.
    const tracked = allTracked.filter((t) => t.source !== 'state');
    const stateTracked = allTracked.filter((t) => t.source === 'state');
    const stateSummary = await this.runStateDetectionCycle(stateTracked);
    if (!tracked.length) {
      return {
        scanned: allTracked.length,
        baseline: stateSummary.baseline,
        changed: stateSummary.changed,
        alertsWritten: stateSummary.alertsWritten,
        skippedDedup: stateSummary.skippedDedup,
        byType: stateSummary.byType,
      };
    }

    const billIds = Array.from(new Set(tracked.map((t) => t.billId)));
    const bills = await this.source.getBillsByIds(billIds);
    const billById = new Map(bills.map((b) => [b.id, b]));

    const actionsByBill = new Map<string, ActionLike[]>();
    if (scanHistory) {
      const actions = await this.source.getBillActionsByIds(billIds);
      for (const a of actions) {
        const arr = actionsByBill.get(a.billId) ?? [];
        arr.push({ date: a.date, text: a.text });
        actionsByBill.set(a.billId, arr);
      }
    }

    // ── LegiWatch B: batch-fetch the GLOBAL derived signals the action-text
    // watermark can't see. All keyed by billId; RLS-free reads (SourceDataRepo).
    const ruleVoteByBill = new Map<string, SourceRuleVote>();
    for (const rv of await this.source.getGoverningRuleVotes(billIds)) {
      ruleVoteByBill.set(rv.targetBillId, rv); // DISTINCT ON gives the latest rule vote per target
    }
    const fiscalByBill = new Map<string, SourceFiscalNote>();
    const fiscalSince = new Date(Date.now() - DERIVED_WINDOW_DAYS * 86_400_000).toISOString();
    for (const fn of await this.source.getNewFiscalNotes(billIds, fiscalSince)) {
      if (fn.billId && !fiscalByBill.has(fn.billId)) fiscalByBill.set(fn.billId, fn); // newest-first → keep first
    }
    const cosponsorByBill = new Map<string, SourceCosponsorMomentum>();
    for (const cm of await this.source.getCosponsorMomentum(billIds, COSPONSOR_WINDOW_DAYS)) {
      cosponsorByBill.set(cm.billId, cm);
    }
    const hearingByBill = new Map<string, SourceHearingForBill[]>();
    for (const h of await this.source.getUpcomingHearingsForBills(billIds)) {
      const arr = hearingByBill.get(h.billId) ?? [];
      arr.push(h);
      hearingByBill.set(h.billId, arr);
    }

    const watchlistByClient = new Map<string, WatchlistLike>();
    let baseline = 0;
    let changed = 0;
    let alertsWritten = 0;
    let skippedDedup = 0;
    const byType: Record<string, number> = {};

    for (const row of tracked) {
      const bill = billById.get(row.billId);
      if (!bill) continue;

      const cm = cosponsorByBill.get(row.billId);
      const fn = fiscalByBill.get(row.billId);
      // The soonest upcoming hearing for this bill (B3) — computed once here so
      // the watermark and the emitter agree on which hearing is "current".
      const hearings = hearingByBill.get(row.billId);
      const soonestHearing =
        hearings && hearings.length
          ? hearings.reduce((a, b) =>
              (a.date?.getTime() ?? Infinity) <= (b.date?.getTime() ?? Infinity) ? a : b,
            )
          : undefined;
      // The watermark we'll persist for this row this cycle (all signals). Fiscal
      // and hearing keep their prior value when nothing current exists, so an
      // estimate aging out of the 14-day window / a hearing passing is not seen
      // as a "change".
      const target: Watermark = {
        actionText: bill.latestActionText,
        actionDate: bill.latestActionDate,
        status: bill.status ?? null,
        cosponsors: cm?.liveCount ?? bill.cosponsorsCount ?? null,
        textDate: bill.updateDateIncludingText,
        fiscalId: fn?.cboId ?? row.lastSeenFiscalId ?? null,
        hearingKey: soonestHearing?.hearingId ?? row.lastSeenHearingKey ?? null,
      };

      // First sighting → baseline ALL watermarks, never alert on historical state.
      if (!row.lastSeenAt) {
        await this.snapshot(row.tenantId, row.id, target);
        baseline += 1;
        continue;
      }

      // Legacy rows predate the B watermarks (all three null). Their action
      // watermark is already baselined, so the action-text path runs as before,
      // but we suppress derived emission on this first B-sweep — the derived
      // signals get baselined by the snapshot below instead of alerting on
      // pre-existing state (Workstream-E "baseline then detect").
      const derivedBaselined =
        row.lastSeenStatus != null ||
        row.lastSeenCosponsors != null ||
        row.lastSeenTextDate != null;

      // ── action-text events (unchanged legacy behavior) ──
      const textChanged = (bill.latestActionText ?? '') !== (row.lastSeenActionText ?? '');
      const dateAdvanced =
        bill.latestActionDate != null &&
        (row.lastSeenActionDate == null ||
          bill.latestActionDate.getTime() > row.lastSeenActionDate.getTime());
      let actionEvents: MaterialEvent[] = [];
      if (textChanged || dateAdvanced) {
        if (scanHistory) {
          const newActions = (actionsByBill.get(row.billId) ?? []).filter(
            (a) =>
              a.date != null &&
              (row.lastSeenActionDate == null ||
                a.date.getTime() > row.lastSeenActionDate.getTime()),
          );
          const latest: ActionLike | null =
            bill.latestActionText != null || bill.latestActionDate != null
              ? { date: bill.latestActionDate, text: bill.latestActionText }
              : null;
          actionEvents = selectMaterialEvents(newActions, latest);
        } else {
          const cls = classifyChange(bill.latestActionText);
          actionEvents = cls
            ? [{ cls, text: bill.latestActionText ?? '', date: bill.latestActionDate }]
            : [];
        }
        // B4: enrich committee/floor-vote events with the {yeas, nays} tally the
        // action text carries, so the alert quote shows the numbers. No-op for
        // non-vote actions (parseTally requires a vote phrase + dash tally).
        for (const ev of actionEvents) {
          const tally = parseTally(ev.text);
          if (tally) ev.extra = { ...(ev.extra ?? {}), yeas: tally.yeas, nays: tally.nays };
        }
      }

      // ── derived events (B5 rule status, B7 fiscal, B8 momentum, B2 text, B3 hearing) ──
      const derivedEvents = derivedBaselined
        ? this.buildDerivedEvents(row, bill, cm, fn, soonestHearing, ruleVoteByBill)
        : [];

      // Derived changeTypes are disjoint from action-text ones; dedupe defensively,
      // derived-first so the more-specific signal wins any future collision.
      const events = dedupeByChangeType([...derivedEvents, ...actionEvents]);

      const watermarkMoved =
        target.actionText !== (row.lastSeenActionText ?? null) ||
        (target.actionDate?.getTime() ?? null) !== (row.lastSeenActionDate?.getTime() ?? null) ||
        target.status !== (row.lastSeenStatus ?? null) ||
        target.cosponsors !== (row.lastSeenCosponsors ?? null) ||
        (target.textDate?.getTime() ?? null) !== (row.lastSeenTextDate?.getTime() ?? null) ||
        target.fiscalId !== (row.lastSeenFiscalId ?? null) ||
        target.hearingKey !== (row.lastSeenHearingKey ?? null);

      if (!events.length) {
        // No material event. Advance the watermark if anything moved, or if we
        // still owe this row its derived baseline; otherwise fast-path skip.
        if (watermarkMoved || !derivedBaselined) {
          await this.snapshot(row.tenantId, row.id, target);
        }
        continue;
      }

      const wl = await this.watchlistFor(row.tenantId, row.clientId, watchlistByClient);
      try {
        const displayNum = humanizeBillId(row.billId);
        for (const ev of events) {
          const actionDate = ev.date ? ev.date.toISOString().slice(0, 10) : null;
          const detail = ev.text || `${displayNum} — ${bill.title ?? ''}`;
          const ex = explainMatch(
            {
              title: bill.title ?? '',
              policyArea: bill.policyArea,
              subjects: bill.subjects,
              latestActionText: bill.latestActionText,
              // P0-04: SourceBill has no sponsorName/committees — legislator
              // and committee routing are consequently inert on this rail.
              displayNum,
              billId: row.billId,
              programElements: bill.peCodes,
            },
            wl,
          );
          const wrote = await this.writeShadowAlert(
            row,
            bill,
            ev,
            detail,
            actionDate,
            ex.why,
            ex.matchedTags,
          );
          if (wrote) {
            alertsWritten += 1;
            byType[ev.cls.changeType] = (byType[ev.cls.changeType] ?? 0) + 1;
          } else {
            skippedDedup += 1;
          }
        }
        // Advance snapshot only after every event was durably written (retry-safe).
        await this.snapshot(row.tenantId, row.id, target);
        changed += 1;
      } catch (e) {
        this.logger.error(
          `detect fan-out failed for ${row.billId} (tenant ${row.tenantId}); snapshot left un-advanced: ${(e as Error).message}`,
        );
      }
    }

    for (const [k, v] of Object.entries(stateSummary.byType)) {
      byType[k] = (byType[k] ?? 0) + v;
    }
    return {
      scanned: allTracked.length,
      baseline: baseline + stateSummary.baseline,
      changed: changed + stateSummary.changed,
      alertsWritten: alertsWritten + stateSummary.alertsWritten,
      skippedDedup: skippedDedup + stateSummary.skippedDedup,
      byType,
    };
  }

  /**
   * The state-rail partition of `runDetectionCycle` (State Legislation
   * Platform Phase 0 S4.3). Same watermark/dedup/fan-out shape as the
   * congress loop above, resolved against `StateSourceDataRepository` instead
   * — DD3: one detector, partitioned by source, not a forked service.
   * `fiscalId` stays null in P0 (state fiscal notes are a Phase 2 item, $2).
   */
  private async runStateDetectionCycle(tracked: TrackedRow[]): Promise<DetectionSummary> {
    const zero: DetectionSummary = {
      scanned: 0,
      baseline: 0,
      changed: 0,
      alertsWritten: 0,
      skippedDedup: 0,
      byType: {},
    };
    if (!tracked.length) return zero;

    const scanHistory = ['true', '1', 'yes'].includes(
      (process.env.TRACKER_SCAN_ACTION_HISTORY ?? '').toLowerCase(),
    );

    const billKeys = Array.from(new Set(tracked.map((t) => t.billId)));
    const bills = await this.stateSource.getStateBillsByIds(billKeys);
    const billById = new Map(bills.map((b) => [b.id, b]));

    const actionsByBill = new Map<string, ActionLike[]>();
    if (scanHistory) {
      const actions = await this.stateSource.getStateBillActionsByIds(billKeys);
      for (const a of actions) {
        const arr = actionsByBill.get(a.billId) ?? [];
        arr.push({ date: a.date, text: a.text });
        actionsByBill.set(a.billId, arr);
      }
    }

    const sponsorByBill = new Map<string, SourceStateSponsorMomentum>();
    for (const sm of await this.stateSource.getStateSponsorMomentum(
      billKeys,
      COSPONSOR_WINDOW_DAYS,
    )) {
      sponsorByBill.set(sm.billKey, sm);
    }
    const voteByBill = new Map<string, SourceStateVote>();
    for (const v of await this.stateSource.getStateVotesForBills(billKeys)) {
      voteByBill.set(v.billKey, v);
    }
    const eventsByBill = new Map<string, SourceHearingForBill[]>();
    for (const h of await this.stateSource.getUpcomingStateEventsForBills(billKeys)) {
      const arr = eventsByBill.get(h.billId) ?? [];
      arr.push(h);
      eventsByBill.set(h.billId, arr);
    }
    const companionsByBill = new Map<string, SourceMovedCompanion[]>();
    for (const c of await this.stateSource.getMovedCompanions(billKeys)) {
      const arr = companionsByBill.get(c.billKey) ?? [];
      arr.push(c);
      companionsByBill.set(c.billKey, arr);
    }
    const calendarByBill = new Map<string, SourceStateSessionCalendar>();
    for (const cal of await this.stateSource.getStateSessionCalendars(billKeys)) {
      calendarByBill.set(cal.billKey, cal);
    }

    const watchlistByClient = new Map<string, WatchlistLike>();
    let baseline = 0;
    let changed = 0;
    let alertsWritten = 0;
    let skippedDedup = 0;
    const byType: Record<string, number> = {};

    for (const row of tracked) {
      const bill = billById.get(row.billId);
      if (!bill) continue;

      const sm = sponsorByBill.get(row.billId);
      const rowEvents = eventsByBill.get(row.billId);
      const soonestEvent =
        rowEvents && rowEvents.length
          ? rowEvents.reduce((a, b) =>
              (a.date?.getTime() ?? Infinity) <= (b.date?.getTime() ?? Infinity) ? a : b,
            )
          : undefined;

      const target: Watermark = {
        actionText: bill.latestActionText,
        actionDate: bill.latestActionDate,
        status: bill.status ?? null,
        cosponsors: sm?.liveCount ?? bill.sponsorCount ?? null,
        textDate: bill.textDate,
        fiscalId: row.lastSeenFiscalId ?? null,
        hearingKey: soonestEvent?.hearingId ?? row.lastSeenHearingKey ?? null,
      };

      // First sighting → baseline ALL watermarks, never alert on historical state.
      if (!row.lastSeenAt) {
        await this.snapshot(row.tenantId, row.id, target);
        baseline += 1;
        continue;
      }

      const derivedBaselined =
        row.lastSeenStatus != null ||
        row.lastSeenCosponsors != null ||
        row.lastSeenTextDate != null;

      // ── action-text events — reuse classifyChange as-is (S4.3) ──
      const textChanged = (bill.latestActionText ?? '') !== (row.lastSeenActionText ?? '');
      const dateAdvanced =
        bill.latestActionDate != null &&
        (row.lastSeenActionDate == null ||
          bill.latestActionDate.getTime() > row.lastSeenActionDate.getTime());
      let actionEvents: MaterialEvent[] = [];
      if (textChanged || dateAdvanced) {
        if (scanHistory) {
          const newActions = (actionsByBill.get(row.billId) ?? []).filter(
            (a) =>
              a.date != null &&
              (row.lastSeenActionDate == null ||
                a.date.getTime() > row.lastSeenActionDate.getTime()),
          );
          const latest: ActionLike | null =
            bill.latestActionText != null || bill.latestActionDate != null
              ? { date: bill.latestActionDate, text: bill.latestActionText }
              : null;
          actionEvents = selectMaterialEvents(newActions, latest);
        } else {
          const cls = classifyChange(bill.latestActionText);
          actionEvents = cls
            ? [{ cls, text: bill.latestActionText ?? '', date: bill.latestActionDate }]
            : [];
        }
      }

      // ── derived events (status/vote/text/sponsor/hearing/companion) ──
      const derivedEvents = derivedBaselined
        ? this.buildStateDerivedEvents(
            row,
            bill,
            sm,
            voteByBill.get(row.billId),
            soonestEvent,
            companionsByBill.get(row.billId) ?? [],
            calendarByBill.get(row.billId),
          )
        : [];

      // A coded state_bill status TRANSITION (classifyStateStatusChange,
      // applied inside buildStateDerivedEvents above) is authoritative for
      // its triggerKey — suppress any action-text event (classifyChange) on
      // the SAME triggerKey this cycle, so one transition never double-emits
      // as both a correctly-labeled coded alert AND a text-regex-derived
      // alert that can mislabel it (e.g. a veto read as "Failed / rejected"
      // by classifyChange's generic /veto/ match). Federal's
      // `classifyStatusChange` already returns null for every status
      // `classifyChange` covers, for exactly this reason (see
      // buildDerivedEvents' B5 comment); the state coded classifier instead
      // covers EVERY status (S4.3), so the mutual-exclusivity has to be
      // enforced here, at merge time, rather than inside the classifier.
      // Scoped to triggerKey (not changeType) because the two classifiers
      // use disjoint naming conventions (`state_bill_*` vs `bill_*`) that
      // dedupeByChangeType's changeType-based dedup can never collide on.
      const statusChanged = (bill.status ?? null) !== (row.lastSeenStatus ?? null);
      const suppressedTriggerKey =
        derivedBaselined && statusChanged
          ? (classifyStateStatusChange(bill.status)?.triggerKey ?? null)
          : null;
      const filteredActionEvents = suppressedTriggerKey
        ? actionEvents.filter((ev) => ev.cls.triggerKey !== suppressedTriggerKey)
        : actionEvents;

      const events = dedupeByChangeType([...derivedEvents, ...filteredActionEvents]).map((ev) => ({
        ...ev,
        extra: { ...(ev.extra ?? {}), jurisdiction: bill.state },
      }));

      const watermarkMoved =
        target.actionText !== (row.lastSeenActionText ?? null) ||
        (target.actionDate?.getTime() ?? null) !== (row.lastSeenActionDate?.getTime() ?? null) ||
        target.status !== (row.lastSeenStatus ?? null) ||
        target.cosponsors !== (row.lastSeenCosponsors ?? null) ||
        (target.textDate?.getTime() ?? null) !== (row.lastSeenTextDate?.getTime() ?? null) ||
        target.hearingKey !== (row.lastSeenHearingKey ?? null);

      if (!events.length) {
        if (watermarkMoved || !derivedBaselined) {
          await this.snapshot(row.tenantId, row.id, target);
        }
        continue;
      }

      const wl = await this.watchlistFor(row.tenantId, row.clientId, watchlistByClient);
      try {
        const displayNum = humanizeStateBillKey(row.billId);
        for (const ev of events) {
          const actionDate = ev.date ? ev.date.toISOString().slice(0, 10) : null;
          const detail = ev.text || `${displayNum} — ${bill.title ?? ''}`;
          const ex = explainMatch(
            {
              title: bill.title ?? '',
              policyArea: null,
              subjects: bill.subjects,
              latestActionText: bill.latestActionText,
              // P0-04: SourceStateBill has no committees/PE codes — committee
              // and program_element routing are consequently inert on this rail.
              displayNum,
              billId: row.billId,
              sponsorName: bill.sponsorName,
            },
            wl,
          );
          // W2.1 + Wave-2 closure: the deadline emitter packs 4 cutoffs
          // (committeeCutoff/crossover/secondCommitteeCutoff/sineDie) AND 3
          // severity bands (info/notable/critical, by daysUntil) into ONE
          // changeType. Sub-key the 14-day dedup on BOTH cutoffType AND severity
          // so (a) a later, different cutoff still fires, and (b) the SAME cutoff
          // escalating info→critical as it approaches still fires the critical
          // <3-day warning instead of the day-~14 'info' row swallowing it.
          // Cast: `events`' mapped literal (line ~529) widens `extra` to just
          // `{ jurisdiction: string }` under TS's spread inference, even though
          // it carries `cutoffType` at runtime.
          const isDeadline = ev.cls.changeType === 'state_bill_deadline_approaching';
          const evExtra = ev.extra as Record<string, unknown> | undefined;
          const dedupEvidenceKey =
            isDeadline && typeof evExtra?.cutoffType === 'string'
              ? { path: 'cutoffType', value: evExtra.cutoffType }
              : undefined;
          const wrote = await this.writeShadowAlert(
            row,
            bill,
            ev,
            detail,
            actionDate,
            ex.why,
            ex.matchedTags,
            {
              sourceType: 'state_bill',
              displayNum,
              jurisdiction: bill.state,
              dedupEvidenceKey,
              dedupSeverity: isDeadline ? ev.cls.severity : undefined,
            },
          );
          if (wrote) {
            alertsWritten += 1;
            byType[ev.cls.changeType] = (byType[ev.cls.changeType] ?? 0) + 1;
          } else {
            skippedDedup += 1;
          }
        }
        await this.snapshot(row.tenantId, row.id, target);
        changed += 1;
      } catch (e) {
        this.logger.error(
          `state detect fan-out failed for ${row.billId} (tenant ${row.tenantId}); snapshot left un-advanced: ${(e as Error).message}`,
        );
      }
    }

    return { scanned: tracked.length, baseline, changed, alertsWritten, skippedDedup, byType };
  }

  /**
   * Build the derived (non-action-text) state events for one tracked row
   * (S4.3's event inventory): status transition, vote recorded, text/version
   * changed, sponsor momentum, hearing/agenda scheduled, companion moved.
   */
  private buildStateDerivedEvents(
    row: TrackedRow,
    bill: SourceStateBill,
    sm: SourceStateSponsorMomentum | undefined,
    vote: SourceStateVote | undefined,
    soonestEvent: SourceHearingForBill | undefined,
    companions: SourceMovedCompanion[],
    calendar: SourceStateSessionCalendar | undefined,
  ): MaterialEvent[] {
    const out: MaterialEvent[] = [];
    const displayNum = humanizeStateBillKey(row.billId);

    // Status transition — the primary state signal (coded facts, not regex).
    const statusChanged = (bill.status ?? null) !== (row.lastSeenStatus ?? null);
    const scls = classifyStateStatusChange(bill.status);
    if (statusChanged && scls) {
      out.push({
        cls: scls,
        text: `${displayNum}: ${scls.label}.`,
        date: bill.statusAt ?? null,
        sourceUrl: bill.stateUrl ?? bill.url ?? null,
      });
    }

    // Vote recorded — fires even when it doesn't move canonical status (e.g. a
    // failed floor vote that doesn't yet flip `status`). First-sight via
    // lastSyncedAt > lastSeenAt (votes are immutable, upsert-once).
    if (vote && vote.lastSyncedAt.getTime() > row.lastSeenAt!.getTime()) {
      const isFinalPassage = /third reading|final passage|on passage|do pass|concur|adoption/i.test(
        vote.motion ?? '',
      );
      const tally = `${vote.yeas}-${vote.nays}`;
      out.push({
        cls: stateVoteRecordedClass(isFinalPassage),
        text: `${displayNum}: ${vote.motion ?? 'Vote recorded'} — ${tally}${vote.passed != null ? (vote.passed ? ' (passed)' : ' (failed)') : ''}.`,
        date: vote.date,
        sourceUrl: vote.sourceUrl ?? bill.stateUrl ?? bill.url ?? null,
        extra: {
          motion: vote.motion,
          yeas: vote.yeas,
          nays: vote.nays,
          passed: vote.passed,
          chamber: vote.chamber,
        },
      });
    }

    // Sponsor momentum — reuses the federal class factory as-is.
    if (
      sm &&
      sm.liveCount > (row.lastSeenCosponsors ?? 0) &&
      sm.new7d >= COSPONSOR_MOMENTUM_MIN_7D
    ) {
      const names = (sm.recentNames ?? []).slice(0, 6).join('; ');
      out.push({
        cls: cosponsorMomentumClass(sm.new7d),
        text:
          `+${sm.new7d} sponsors in the last ${COSPONSOR_WINDOW_DAYS} days ` +
          `(now ${sm.liveCount})${names ? ` — ${names}` : ''}`,
        date: null,
        sourceUrl: bill.stateUrl ?? bill.url ?? null,
        extra: { new7d: sm.new7d, liveCount: sm.liveCount, newSponsors: sm.recentNames ?? [] },
      });
    }

    // Text/version changed — reuses TEXT_CHANGED_CLASS as-is (same changeType
    // as federal B2; parent plan §5 S4.3).
    const textDateAdvanced =
      bill.textDate != null &&
      (row.lastSeenTextDate == null || bill.textDate.getTime() > row.lastSeenTextDate.getTime());
    if (textDateAdvanced) {
      out.push({
        cls: TEXT_CHANGED_CLASS,
        text: `Bill text updated${bill.title ? ` — ${bill.title}` : ''}`,
        date: bill.textDate,
        sourceUrl: bill.stateUrl ?? bill.url ?? null,
      });
    }

    // Hearing/agenda scheduled — reuses HEARING_SCHEDULED_CLASS as-is.
    if (soonestEvent && soonestEvent.hearingId !== (row.lastSeenHearingKey ?? null)) {
      const when = soonestEvent.date ? soonestEvent.date.toISOString().slice(0, 10) : 'TBD';
      out.push({
        cls: HEARING_SCHEDULED_CLASS,
        text: `Scheduled for a ${soonestEvent.title ?? 'hearing'} ${when}`,
        date: soonestEvent.date ?? null,
        sourceUrl: soonestEvent.url ?? bill.stateUrl ?? bill.url ?? null,
        extra: {
          eventType: soonestEvent.title,
          eventDate: soonestEvent.date ? soonestEvent.date.toISOString().slice(0, 10) : null,
        },
      });
    }

    // Companion moved — first-ever emitter for the `companion` trigger key
    // (S4.3). Fires when the related bill's status advanced past THIS row's
    // own lastSeenAt watermark (a per-row cutoff, not a global one).
    for (const c of companions) {
      if (!c.relatedStatusAt || !row.lastSeenAt) continue;
      if (c.relatedStatusAt.getTime() <= row.lastSeenAt.getTime()) continue;
      out.push({
        cls: STATE_COMPANION_MOVED_CLASS,
        text: `Companion ${c.relatedDisplay ?? c.relatedBillKey} (${c.linkType}) advanced to ${c.relatedStatus ?? 'a new status'}.`,
        date: c.relatedStatusAt,
        sourceUrl: bill.stateUrl ?? bill.url ?? null,
        extra: {
          relatedBillKey: c.relatedBillKey,
          relatedDisplay: c.relatedDisplay,
          relatedStatus: c.relatedStatus,
          linkType: c.linkType,
        },
      });
      break; // at most one companion-moved event per cycle, same "one event per type" contract
    }

    // Deadline approaching — first emitter for the `deadline` trigger key
    // (M2.3, PD5). `bill_dead_by_deadline` (the retroactive twin) already
    // fires above via classifyStateStatusChange on the EXISTING enactedFailed
    // key; this is only the upcoming-deadline warning. Re-fires every cycle
    // while within the window — the generic 14-day dedup in writeShadowAlert
    // (same changeType/sourceRef) is what limits it to "once per (bill,
    // cutoff, 14-day window)" (M2-C), not a bespoke watermark here.
    if (calendar) {
      const risk = computeStateDeadlineRisk({
        status: bill.status,
        session: {
          committeeCutoffDate: toDateOnly(calendar.committeeCutoffDate),
          crossoverDate: toDateOnly(calendar.crossoverDate),
          secondCommitteeCutoffDate: toDateOnly(calendar.secondCommitteeCutoffDate),
          sineDie: toDateOnly(calendar.sineDie),
        },
        today: toDateOnly(new Date())!,
      });
      if (risk && !risk.isPastCutoff && risk.daysUntil <= 14) {
        out.push({
          cls: stateDeadlineClass(risk.daysUntil, risk.cutoffType),
          text: `${displayNum}: ${risk.daysUntil} day(s) until its ${risk.cutoffType} (${risk.cutoffDate}).`,
          date: null,
          sourceUrl: bill.stateUrl ?? bill.url ?? null,
          extra: {
            cutoffDate: risk.cutoffDate,
            cutoffType: risk.cutoffType,
            daysUntil: risk.daysUntil,
          },
        });
      }
    }

    return out;
  }

  /**
   * Build the derived (non-action-text) events for one tracked row against its
   * watermark. Each returns at most one event per type; the emit loop applies
   * the 14-day per-(client,bill,changeType) dedup on top. Detail strings become
   * the alert's `evidence.actionText` (the "from the record" quote in Workstream C).
   */
  private buildDerivedEvents(
    row: TrackedRow,
    bill: SourceBill,
    cm: SourceCosponsorMomentum | undefined,
    fn: SourceFiscalNote | undefined,
    soonestHearing: SourceHearingForBill | undefined,
    ruleVoteByBill: Map<string, SourceRuleVote>,
  ): MaterialEvent[] {
    const out: MaterialEvent[] = [];
    const displayNum = humanizeBillId(row.billId);

    // B5 — canonical status transition the action-text timeline never shows:
    // a governing rule failing (stalls the bill) or being adopted (→ floor).
    const statusChanged = (bill.status ?? null) !== (row.lastSeenStatus ?? null);
    const scls = classifyStatusChange(bill.status);
    if (statusChanged && scls) {
      const rv = ruleVoteByBill.get(row.billId);
      out.push({
        cls: scls,
        text: rv ? this.ruleVoteSentence(displayNum, rv) : `${displayNum}: ${scls.label}.`,
        date: rv?.voteDate ?? bill.statusAt ?? null,
        sourceUrl: rv?.sourceUrl ?? null,
        extra: rv
          ? {
              ruleBillId: rv.ruleBillId,
              rollNumber: rv.rollNumber,
              chamber: rv.chamber,
              result: rv.result,
              yeas: rv.yeas,
              nays: rv.nays,
              question: rv.question,
            }
          : undefined,
      });
    }

    // B7 — a NEW CBO cost estimate for this bill: fire only when the estimate id
    // differs from the last one we alerted (the watermark). A pre-existing
    // estimate present at baseline shares the id we snapshot, so it never
    // false-alerts, and it can't re-fire every 14 days.
    if (fn && fn.cboId !== (row.lastSeenFiscalId ?? null)) {
      const firstSentence = (fn.description ?? '').split(/(?<=[.!?])\s/)[0]?.trim() ?? '';
      out.push({
        cls: FISCAL_NOTE_CLASS,
        text: `CBO cost estimate — ${fn.title}${firstSentence ? `: ${firstSentence}` : ''}`,
        date: fn.pubDate ?? null,
        sourceUrl: fn.cboUrl ?? null,
        extra: { cboId: fn.cboId, cboUrl: fn.cboUrl, fiscalTitle: fn.title },
      });
    }

    // B8 — cosponsor momentum: only when the live count GREW since the last
    // snapshot AND the 7-day surge clears the floor (default 5). Snapshotting the
    // new count below stops it re-firing until the next surge.
    if (
      cm &&
      cm.liveCount > (row.lastSeenCosponsors ?? 0) &&
      cm.new7d >= COSPONSOR_MOMENTUM_MIN_7D
    ) {
      const names = (cm.recentNames ?? []).slice(0, 6).join('; ');
      out.push({
        cls: cosponsorMomentumClass(cm.new7d),
        text:
          `+${cm.new7d} cosponsors in the last ${COSPONSOR_WINDOW_DAYS} days ` +
          `(now ${cm.liveCount})${names ? ` — ${names}` : ''}`,
        date: null,
        sourceUrl: bill.url ?? null,
        extra: { new7d: cm.new7d, liveCount: cm.liveCount, newCosponsors: cm.recentNames ?? [] },
      });
    }

    // B2 — bill TEXT changed even though no action fired (updateDateIncludingText
    // advanced). Distinct from the regex `bill_amendment` action-text signal.
    const textDateAdvanced =
      bill.updateDateIncludingText != null &&
      (row.lastSeenTextDate == null ||
        bill.updateDateIncludingText.getTime() > row.lastSeenTextDate.getTime());
    if (textDateAdvanced) {
      out.push({
        cls: TEXT_CHANGED_CLASS,
        text: `Bill text updated${bill.title ? ` — ${bill.title}` : ''}`,
        date: bill.updateDateIncludingText,
        sourceUrl: bill.url ?? null,
      });
    }

    // B3 — a NEW upcoming committee hearing has this bill on its agenda (via the
    // committee_hearing_bill link; empty until sync-hearings populates it). Gated
    // on the hearing id differing from the watermark, so a still-upcoming hearing
    // doesn't re-alert every 14 days and a pre-existing one baselines silently.
    if (soonestHearing && soonestHearing.hearingId !== (row.lastSeenHearingKey ?? null)) {
      const soonest = soonestHearing;
      const when = soonest.date ? soonest.date.toISOString().slice(0, 10) : 'TBD';
      out.push({
        cls: HEARING_SCHEDULED_CLASS,
        text:
          `Scheduled for a hearing ${when}` +
          `${soonest.committeeName ? ` — ${soonest.committeeName}` : ''}` +
          `${soonest.title ? ` (${soonest.title})` : ''}`,
        date: soonest.date ?? null,
        sourceUrl: soonest.url ?? bill.url ?? null,
        extra: {
          hearingId: soonest.hearingId,
          committeeName: soonest.committeeName,
          chamber: soonest.chamber,
          hearingDate: soonest.date ? soonest.date.toISOString().slice(0, 10) : null,
        },
      });
    }

    return out;
  }

  /** Verbatim "from the record" sentence for a governing-rule roll-call vote (B5 context). */
  private ruleVoteSentence(targetDisplayNum: string, rv: SourceRuleVote): string {
    const rule = humanizeBillId(rv.ruleBillId);
    const tally = rv.yeas != null && rv.nays != null ? ` ${rv.yeas}–${rv.nays}` : '';
    const roll = rv.rollNumber != null ? `, Roll no. ${rv.rollNumber}` : '';
    const q = rv.question ? `${rv.question}: ` : '';
    const outcome = rv.result ?? 'voted';
    // e.g. "Governing rule H. Res. 1398 (On agreeing to the resolution: Not agreed to 198–224, Roll no. 232) — H.R. 8800 is stalled on the floor."
    return `Governing rule ${rule} (${q}${outcome}${tally}${roll}) — ${targetDisplayNum}.`;
  }

  /**
   * Write one shadow `intel_alert` (status='new', never delivered). 14-day
   * dedup. Returns false when deduped. `sourceType`/`displayNum`/`jurisdiction`
   * are parameterized (S4.3) so the exact same watermark/dedup/fan-out
   * machinery serves both rails — 'bill'|'US' for congress (the defaults) or
   * 'state_bill'|<state code> for state.
   */
  private async writeShadowAlert(
    row: TrackedRow,
    bill: { url: string | null; title: string | null },
    ev: MaterialEvent,
    detail: string,
    actionDate: string | null,
    why: string | null,
    matchedTags: string[],
    opts: {
      sourceType?: string;
      displayNum?: string;
      jurisdiction?: string;
      /**
       * 2026-07-10 (W2.1, hardened in Wave-2 closure): sub-key the 14-day dedup
       * so distinct sub-events sharing ONE changeType each fire once within the
       * window, instead of the first occurrence suppressing every later one.
       * The deadline emitter (`state_bill_deadline_approaching`) needs BOTH
       * dimensions, and neither alone is sufficient:
       *   - dedupEvidenceKey (cutoffType): a bill's committee cutoff vs its later
       *     crossover deadline are the same changeType but distinct events.
       *   - dedupSeverity: the SAME cutoff escalates info→notable→critical as it
       *     approaches (stateDeadlineClass buckets by daysUntil: <3 critical /
       *     <=7 notable / else info). Without this, the day-~14 'info' row claims
       *     the slot and the day-2 'critical' warning — the single signal the
       *     feature exists to surface — is deduped away for the whole window.
       * Combined key = (bill, changeType, cutoffType, severity, 14d): each
       * (cutoff × severity-band) fires exactly once; a same-cutoff/same-band
       * re-run within 14d still dedups (no per-cycle spam). `severity` is a
       * real intel_alert column, so that dimension is a plain column predicate.
       */
      dedupEvidenceKey?: { path: string; value: string };
      dedupSeverity?: string;
    } = {},
  ): Promise<boolean> {
    const sourceType = opts.sourceType ?? 'bill';
    const displayNum = opts.displayNum ?? humanizeBillId(row.billId);
    const jurisdiction = opts.jurisdiction ?? 'US';
    const dedupeSince = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    // Dedup is PER CLIENT: the alert is client-specific (its own board/feed row,
    // its own subscribers), and legacy emits one intelligence_change per client
    // (relatedClientIds carries the clientId). Omitting clientId here would drop
    // alerts for every client but the first that tracks a shared bill (e.g. NDAA)
    // — diverging from legacy and failing the Phase-5 parity recall gate.
    const existing = await this.prisma.withTenant(row.tenantId, (tx) =>
      tx.intelAlert.findFirst({
        where: {
          tenantId: row.tenantId,
          clientId: row.clientId,
          sourceType,
          changeType: ev.cls.changeType,
          sourceRef: row.billId,
          createdAt: { gte: dedupeSince },
          ...(opts.dedupEvidenceKey
            ? {
                evidence: {
                  path: [opts.dedupEvidenceKey.path],
                  equals: opts.dedupEvidenceKey.value,
                },
              }
            : {}),
          ...(opts.dedupSeverity ? { severity: opts.dedupSeverity } : {}),
        },
        select: { id: true },
      }),
    );
    if (existing) return false;
    const materiality = severityToMateriality(ev.cls.severity);
    const { score, band } = scoreShadowAlert({
      severity: ev.cls.severity,
      materiality,
      changeType: ev.cls.changeType,
      actionDate: ev.date,
      matchedTags,
    });
    await this.prisma.withTenant(row.tenantId, (tx) =>
      tx.intelAlert.create({
        data: {
          tenantId: row.tenantId,
          clientId: row.clientId,
          sourceType,
          sourceRef: row.billId,
          watchlistId: `wl:${row.clientId}`,
          kind: ev.cls.changeType,
          changeType: ev.cls.changeType,
          severity: ev.cls.severity,
          materiality,
          score, // Phase 4 AlertScorer weighted composite (§7.1)
          title: `${displayNum}: ${ev.cls.label}`,
          whyItMatters: why,
          evidence: {
            // Event-specific structured fields (tally, party splits, cosponsor
            // names, cbo url, fit, …) first — so the fixed keys below always win.
            ...(ev.extra ?? {}),
            stage: ev.cls.label,
            actionText: detail, // the verbatim "from the record" quote (Workstream C)
            actionDate,
            url: ev.sourceUrl ?? bill.url ?? null,
            sourceUrl: ev.sourceUrl ?? bill.url ?? null, // canonical deep link (Workstream C)
            why,
            matchedTags,
            tone: ev.cls.tone,
            band, // display band (score column is the parity field)
            triggerKey: ev.cls.triggerKey,
            billTitle: bill.title,
            displayNum,
            jurisdiction,
          },
          status: 'new',
        },
      }),
    );
    return true;
  }

  /** Persist all watermarks together (action text/date + status + cosponsors + text-date + fiscal id + hearing id). */
  private async snapshot(tenantId: string, trackedBillId: string, wm: Watermark): Promise<void> {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.trackedBill.update({
        where: { id: trackedBillId },
        data: {
          lastSeenActionText: wm.actionText,
          lastSeenActionDate: wm.actionDate,
          lastSeenStatus: wm.status,
          lastSeenCosponsors: wm.cosponsors,
          lastSeenTextDate: wm.textDate,
          lastSeenFiscalId: wm.fiscalId,
          lastSeenHearingKey: wm.hearingKey,
          lastSeenAt: new Date(),
        },
      }),
    );
  }

  /** Build the keyword-match watchlist (WatchlistLike) from the unified intel watchlist. */
  private async watchlistFor(
    tenantId: string,
    clientId: string,
    cache: Map<string, WatchlistLike>,
  ): Promise<WatchlistLike> {
    const cached = cache.get(clientId);
    if (cached) return cached;
    let wl: WatchlistLike = { issueAreas: [], tags: [] };
    try {
      const wlId = `wl:${clientId}`;
      const built = await this.prisma.withTenant(tenantId, async (tx) => {
        const head = await tx.watchlist.findFirst({
          where: { id: wlId },
          select: { issueAreas: true },
        });
        if (!head) return null;
        const topics = await tx.watchlistTopic.findMany({
          where: { watchlistId: wlId },
          select: { id: true, label: true, priority: true },
        });
        const terms = topics.length
          ? await tx.watchlistTerm.findMany({
              where: { topicId: { in: topics.map((t) => t.id) } },
              select: { id: true, topicId: true, termType: true, value: true },
            })
          : [];
        return { head, topics, terms };
      });
      if (built) {
        const { head, topics, terms } = built;
        wl = {
          issueAreas: head.issueAreas,
          tags: topics.map((t) => ({
            tag: t.label,
            synonyms: terms
              .filter((x) => x.topicId === t.id && x.termType === 'synonym')
              .map((x) => x.value),
            relatedEntities: terms
              .filter((x) => x.topicId === t.id && x.termType === 'entity')
              .map((x) => x.value),
            riskTerms: terms
              .filter((x) => x.topicId === t.id && x.termType === 'risk')
              .map((x) => x.value),
            // P0-04: every OTHER typed term — the legacy three above already
            // have their own dedicated fields, so exclude them here to avoid
            // double-counting the same term through two match paths.
            topicId: t.id,
            priority: t.priority,
            typedTerms: terms
              .filter((x) => x.topicId === t.id && !['synonym', 'entity', 'risk'].includes(x.termType))
              .map((x) => ({ termType: x.termType, value: x.value, id: x.id })),
          })),
        };
      }
    } catch (e) {
      this.logger.warn(`watchlistFor ${clientId} failed: ${(e as Error).message}`);
    }
    cache.set(clientId, wl);
    return wl;
  }
}
