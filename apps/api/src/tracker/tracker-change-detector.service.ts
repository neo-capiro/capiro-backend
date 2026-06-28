import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { TrackerAlertService } from './notifications/tracker-alert.service.js';
import type {
  AlertSeverity,
  TrackerAlertEvent,
} from './notifications/tracker-notification.types.js';
import type { ChangeTone } from './tracker.types.js';
import { humanizeBillId } from './bill-stage.util.js';

interface ChangeClass {
  changeType: string;
  triggerKey: string;
  label: string;
  tone: ChangeTone;
  severity: AlertSeverity;
}

/**
 * Classify a tracked bill's NEW latest-action text into a material change, or
 * null for routine churn we don't alert on. Ordered most-significant first.
 */
function classifyChange(nextText: string | null): ChangeClass | null {
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

/**
 * Scans tracked bills for material legislative moves, snapshots each bill's
 * last-seen action so a move alerts exactly once, writes an IntelligenceChange
 * (for the in-app changes inbox + board change chip), and fans the alert out to
 * each user's email/SMS channels via TrackerAlertService.
 */
@Injectable()
export class TrackerChangeDetectorService {
  private readonly logger = new Logger(TrackerChangeDetectorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: TrackerAlertService,
  ) {}

  async runDetectionCycle(): Promise<{
    scanned: number;
    baseline: number;
    changed: number;
    alerted: number;
  }> {
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
    if (!tracked.length) return { scanned: 0, baseline: 0, changed: 0, alerted: 0 };

    const billIds = Array.from(new Set(tracked.map((t) => t.billId)));
    const bills = await this.prisma.congressBill.findMany({
      where: { id: { in: billIds } },
      select: {
        id: true,
        title: true,
        latestActionText: true,
        latestActionDate: true,
        url: true,
      },
    });
    const billById = new Map(bills.map((b) => [b.id, b]));

    // Client names for nicer alert copy (per tenant, cached).
    const clientNameById = new Map<string, string>();

    let baseline = 0;
    let changed = 0;
    let alerted = 0;

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

      const cls = classifyChange(bill.latestActionText);
      if (!cls) {
        // Routine churn (no material change) — safe to advance the snapshot now.
        await this.snapshot(row.tenantId, row.id, bill.latestActionText, bill.latestActionDate);
        continue;
      }

      // Wrap the per-row side effects so a transient DB failure neither aborts
      // the whole cycle nor advances the snapshot (the move re-triggers next run).
      try {
        const displayNum = humanizeBillId(row.billId);
        const actionDate = bill.latestActionDate
          ? bill.latestActionDate.toISOString().slice(0, 10)
          : null;

        // In-app surface: an IntelligenceChange (deduped per bill+changeType+client
        // within 14 days), mirroring emit-bill-alerts.
        await this.emitIntelligenceChange(row.clientId, row.billId, bill, cls, actionDate);

        // Resolve a client name for copy.
        let clientName = clientNameById.get(row.clientId) ?? null;
        if (clientName === null && !clientNameById.has(row.clientId)) {
          const c = await this.prisma.withTenant(row.tenantId, (tx) =>
            tx.client.findFirst({ where: { id: row.clientId }, select: { name: true } }),
          );
          clientName = c?.name ?? null;
          clientNameById.set(row.clientId, clientName ?? '');
        }

        const event: TrackerAlertEvent = {
          tenantId: row.tenantId,
          clientId: row.clientId,
          clientName,
          billId: row.billId,
          displayNum,
          billTitle: bill.title,
          changeType: cls.changeType,
          triggerKey: cls.triggerKey,
          label: cls.label,
          tone: cls.tone,
          severity: cls.severity,
          detail: bill.latestActionText ?? `${displayNum} — ${bill.title}`,
          actionDate,
          url: '', // filled by the alert service (boardUrl)
        };
        await this.alerts.fanOut(event);

        // Advance the snapshot ONLY after the move was durably surfaced + fanned
        // out. Re-running a row is safe: emitIntelligenceChange dedupes and the
        // NotificationLog claim is idempotent.
        await this.snapshot(row.tenantId, row.id, bill.latestActionText, bill.latestActionDate);
        changed += 1;
        alerted += 1;
      } catch (e) {
        this.logger.error(
          `Tracker fan-out failed for ${row.billId} (tenant ${row.tenantId}); leaving snapshot un-advanced to retry next cycle: ${(e as Error).message}`,
        );
      }
    }

    return { scanned: tracked.length, baseline, changed, alerted };
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
    bill: { title: string; latestActionText: string | null; url: string | null },
    cls: ChangeClass,
    actionDate: string | null,
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
        description: bill.latestActionText ?? `${label} — ${bill.title}`,
        relatedClientIds: [clientId],
        relatedIssues: [],
        data: {
          bill_id: billId,
          stage: cls.label,
          bill_title: bill.title,
          action_date: actionDate,
          url: bill.url ?? null,
          tracker: true,
        },
      },
    });
  }
}
