import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SourceDataRepository, type SourceBill } from '../sourcedata/source-data.repository.js';
import {
  classifyChange,
  selectMaterialEvents,
  severityToMateriality,
  type ActionLike,
  type MaterialEvent,
} from './change-detector.util.js';
import { explainMatch, humanizeBillId, type WatchlistLike } from './relevance.util.js';
import { scoreShadowAlert } from '../intel-alert/alert-scorer.js';

/**
 * Shadow bill-change detector (Phase 3, plan §6.3) — a faithful port of legacy
 * `runDetectionCycle` with the DELIVERY leg severed. It reads tracked bills +
 * their live congress_bill state, classifies material moves, and writes
 * `intel_alert` rows with `status='new'` (never delivered). No alert/email/SMS
 * import, no IntelligenceChange emit — single-sender is preserved (legacy still
 * owns delivery). No Bedrock: detection is `classifyChange` + keyword
 * `explainMatch`; summaries/embeddings are Phase 4.
 *
 * All tables touched are RLS-free (`intel_*` have no RLS; `congress_bill*` are
 * GLOBAL), so no `withTenant`/`withSystem` is needed. Overlap safety relies on
 * the strictly-newer-than-snapshot filter + the 14-day dedup (plan §6.5: "
 * idempotency holds even without the lock"); a rare concurrent double-write is
 * caught by the dedup and surfaced in Phase 5 parity.
 */
type TrackedRow = {
  id: string;
  tenantId: string;
  clientId: string;
  billId: string;
  lastSeenActionText: string | null;
  lastSeenActionDate: Date | null;
  lastSeenAt: Date | null;
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
  ) {}

  async runDetectionCycle(): Promise<DetectionSummary> {
    const scanHistory = ['true', '1', 'yes'].includes(
      (process.env.TRACKER_SCAN_ACTION_HISTORY ?? '').toLowerCase(),
    );
    const zero: DetectionSummary = { scanned: 0, baseline: 0, changed: 0, alertsWritten: 0, skippedDedup: 0, byType: {} };

    const tracked: TrackedRow[] = await this.prisma.trackedBill.findMany({
      select: { id: true, tenantId: true, clientId: true, billId: true, lastSeenActionText: true, lastSeenActionDate: true, lastSeenAt: true },
    });
    if (!tracked.length) return zero;

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

    const watchlistByClient = new Map<string, WatchlistLike>();
    let baseline = 0;
    let changed = 0;
    let alertsWritten = 0;
    let skippedDedup = 0;
    const byType: Record<string, number> = {};

    for (const row of tracked) {
      const bill = billById.get(row.billId);
      if (!bill) continue;

      // First sighting → baseline the snapshot, never alert on historical state.
      if (!row.lastSeenAt) {
        await this.snapshot(row.id, bill.latestActionText, bill.latestActionDate);
        baseline += 1;
        continue;
      }

      const textChanged = (bill.latestActionText ?? '') !== (row.lastSeenActionText ?? '');
      const dateAdvanced =
        bill.latestActionDate != null &&
        (row.lastSeenActionDate == null || bill.latestActionDate.getTime() > row.lastSeenActionDate.getTime());
      if (!textChanged && !dateAdvanced) continue;

      let events: MaterialEvent[];
      if (scanHistory) {
        const newActions = (actionsByBill.get(row.billId) ?? []).filter(
          (a) => a.date != null && (row.lastSeenActionDate == null || a.date.getTime() > row.lastSeenActionDate.getTime()),
        );
        const latest: ActionLike | null =
          bill.latestActionText != null || bill.latestActionDate != null
            ? { date: bill.latestActionDate, text: bill.latestActionText }
            : null;
        events = selectMaterialEvents(newActions, latest);
      } else {
        const cls = classifyChange(bill.latestActionText);
        events = cls ? [{ cls, text: bill.latestActionText ?? '', date: bill.latestActionDate }] : [];
      }

      if (!events.length) {
        // Routine churn — advance the snapshot, no alert.
        await this.snapshot(row.id, bill.latestActionText, bill.latestActionDate);
        continue;
      }

      const wl = await this.watchlistFor(row.clientId, watchlistByClient);
      try {
        const displayNum = humanizeBillId(row.billId);
        for (const ev of events) {
          const actionDate = ev.date ? ev.date.toISOString().slice(0, 10) : null;
          const detail = ev.text || `${displayNum} — ${bill.title ?? ''}`;
          const ex = explainMatch(
            { title: bill.title ?? '', policyArea: bill.policyArea, subjects: bill.subjects, latestActionText: bill.latestActionText },
            wl,
          );
          const wrote = await this.writeShadowAlert(row, bill, ev, detail, actionDate, ex.why, ex.matchedTags);
          if (wrote) {
            alertsWritten += 1;
            byType[ev.cls.changeType] = (byType[ev.cls.changeType] ?? 0) + 1;
          } else {
            skippedDedup += 1;
          }
        }
        // Advance snapshot only after every event was durably written (retry-safe).
        await this.snapshot(row.id, bill.latestActionText, bill.latestActionDate);
        changed += 1;
      } catch (e) {
        this.logger.error(`detect fan-out failed for ${row.billId} (tenant ${row.tenantId}); snapshot left un-advanced: ${(e as Error).message}`);
      }
    }

    return { scanned: tracked.length, baseline, changed, alertsWritten, skippedDedup, byType };
  }

  /** Write one shadow `intel_alert` (status='new', never delivered). 14-day dedup. Returns false when deduped. */
  private async writeShadowAlert(
    row: TrackedRow,
    bill: SourceBill,
    ev: MaterialEvent,
    detail: string,
    actionDate: string | null,
    why: string | null,
    matchedTags: string[],
  ): Promise<boolean> {
    const dedupeSince = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const existing = await this.prisma.intelAlert.findFirst({
      where: { tenantId: row.tenantId, sourceType: 'bill', changeType: ev.cls.changeType, sourceRef: row.billId, createdAt: { gte: dedupeSince } },
      select: { id: true },
    });
    if (existing) return false;
    const materiality = severityToMateriality(ev.cls.severity);
    const { score, band } = scoreShadowAlert({
      severity: ev.cls.severity,
      materiality,
      changeType: ev.cls.changeType,
      actionDate: ev.date,
      matchedTags,
    });
    await this.prisma.intelAlert.create({
      data: {
        tenantId: row.tenantId,
        clientId: row.clientId,
        sourceType: 'bill',
        sourceRef: row.billId,
        watchlistId: `wl:${row.clientId}`,
        kind: ev.cls.changeType,
        changeType: ev.cls.changeType,
        severity: ev.cls.severity,
        materiality,
        score, // Phase 4 AlertScorer weighted composite (§7.1)
        title: `${humanizeBillId(row.billId)}: ${ev.cls.label}`,
        whyItMatters: why,
        evidence: {
          stage: ev.cls.label,
          actionText: detail,
          actionDate,
          url: bill.url ?? null,
          why,
          matchedTags,
          tone: ev.cls.tone,
          band, // display band (score column is the parity field)
          triggerKey: ev.cls.triggerKey,
          billTitle: bill.title,
          displayNum: humanizeBillId(row.billId),
        },
        status: 'new',
      },
    });
    return true;
  }

  private async snapshot(trackedBillId: string, actionText: string | null, actionDate: Date | null): Promise<void> {
    await this.prisma.trackedBill.update({
      where: { id: trackedBillId },
      data: { lastSeenActionText: actionText, lastSeenActionDate: actionDate, lastSeenAt: new Date() },
    });
  }

  /** Build the keyword-match watchlist (WatchlistLike) from the unified intel watchlist. */
  private async watchlistFor(clientId: string, cache: Map<string, WatchlistLike>): Promise<WatchlistLike> {
    const cached = cache.get(clientId);
    if (cached) return cached;
    let wl: WatchlistLike = { issueAreas: [], tags: [] };
    try {
      const wlId = `wl:${clientId}`;
      const head = await this.prisma.watchlist.findFirst({ where: { id: wlId }, select: { issueAreas: true } });
      if (head) {
        const topics = await this.prisma.watchlistTopic.findMany({ where: { watchlistId: wlId }, select: { id: true, label: true } });
        const terms = topics.length
          ? await this.prisma.watchlistTerm.findMany({ where: { topicId: { in: topics.map((t) => t.id) } }, select: { topicId: true, termType: true, value: true } })
          : [];
        wl = {
          issueAreas: head.issueAreas,
          tags: topics.map((t) => ({
            tag: t.label,
            synonyms: terms.filter((x) => x.topicId === t.id && x.termType === 'synonym').map((x) => x.value),
            relatedEntities: terms.filter((x) => x.topicId === t.id && x.termType === 'entity').map((x) => x.value),
            riskTerms: terms.filter((x) => x.topicId === t.id && x.termType === 'risk').map((x) => x.value),
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
