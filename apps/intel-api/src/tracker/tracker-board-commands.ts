import type { TrackerBoardService } from './tracker-board.service.js';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { isStateBillKey } from '@capiro/shared';
import { billStage, type BillStage } from './bill-stage.util.js';
import type { UpdateBillContextInput } from './tracker-board.contracts.js';
export class TrackerBoardCommands {
  constructor(private readonly allowedFeedbackSignals: ReadonlySet<string>) {}
  async trackCongressStage(
    host: TrackerBoardService,
    billId: string,
  ): Promise<{
    stage: BillStage;
    latestActionText: string | null;
    latestActionDate: Date | null;
  }> {
    const bill = await host['repo'].getBillById(billId);
    if (!bill) throw new NotFoundException(`Bill ${billId} not found`);
    return {
      stage: billStage(bill.latestActionText, bill.status, bill.actionTexts),
      latestActionText: bill.latestActionText,
      latestActionDate: bill.latestActionDate,
    };
  }

  async trackStateStage(
    host: TrackerBoardService,
    billId: string,
  ): Promise<{
    stage: BillStage;
    latestActionText: string | null;
    latestActionDate: Date | null;
  }> {
    const bill = await host['stateRepo'].getStateBillById(billId);
    if (!bill) throw new NotFoundException(`Bill ${billId} not found`);
    return {
      stage: host['stateStatusToBoardStage'](bill.status),
      latestActionText: bill.latestActionText,
      latestActionDate: bill.latestActionDate,
    };
  }

  /** Track a bill for a client (idempotent upsert). Verifies the bill exists. */
  async trackBill(
    host: TrackerBoardService,
    tenantId: string,
    clientId: string,
    userId: string,
    billId: string,
    opts?: {
      note?: string | null;
      source?: string;
      isManual?: boolean;
    },
  ) {
    // Cross-tenant guard (P1-03/P1-04): clientId is globally unique and RLS
    // alone does not prove CLIENT ownership within a tenant, so this must run
    // before any read or write below.
    await host['watchlists'].assertClientInTenant(tenantId, clientId);
    // State Legislation Platform (S4.5): a DD1-shaped id ("tx-2025-hb1234")
    // routes to the state-bill lookup + status-rank stage bucketing instead
    // of the congress path. `opts?.source` is honored when given, but the id
    // shape is the authoritative signal — a caller passing a state key
    // without opts.source='state' still tracks correctly.
    const isState = isStateBillKey(billId) || opts?.source === 'state';
    const stage = isState
      ? await host['trackStateStage'](billId)
      : await host['trackCongressStage'](billId);
    const tb = await host['prisma'].withTenant(tenantId, (tx) =>
      tx.trackedBill.upsert({
        where: { clientId_billId: { clientId, billId } },
        create: {
          tenantId,
          clientId,
          billId,
          source: isState ? 'state' : (opts?.source ?? 'congress'),
          note: opts?.note ?? null,
          isManual: opts?.isManual ?? false,
          trackedBy: userId,
          stage: stage.stage,
          lastSeenActionText: stage.latestActionText,
          lastSeenActionDate: stage.latestActionDate,
          lastSeenAt: new Date(),
        },
        update: opts?.note !== undefined ? { note: opts.note } : {},
      }),
    );
    await host['prisma']
      .withTenant(tenantId, (tx) =>
        tx.intelFeedback.create({
          data: {
            tenantId,
            clientId,
            userId,
            targetType: 'bill',
            targetRef: billId,
            signal: 'tracked',
          },
        }),
      )
      .catch(() => undefined);
    return tb;
  }

  /** Untrack a bill (pure removal — does NOT suppress future recommendations). */
  async untrackBill(host: TrackerBoardService, tenantId: string, clientId: string, billId: string) {
    // Cross-tenant guard (P1-03/P1-04) — must run before the delete below.
    await host['watchlists'].assertClientInTenant(tenantId, clientId);
    const res = await host['prisma'].withTenant(tenantId, (tx) =>
      tx.trackedBill.deleteMany({ where: { tenantId, clientId, billId } }),
    );
    return { ok: true, removed: res.count };
  }

  /**
   * Bill 360 editable client-bill context (Release R1, §1.3). Updates ONLY the
   * new analyst context columns on the client's tracked row for this bill. It
   * deliberately:
   *  - NEVER touches `note` (legacy note is preserved) or the canonical bill
   *    status (that lives on apps/api-owned congress_bill, never written here);
   *  - builds the update `data` from ONLY the fields present in the body, so a
   *    partial PUT can't null unspecified context (mirrors trackBill's guard);
   *  - uses updateMany with the { tenantId, clientId, billId } predicate (NOT
   *    update({ clientId_billId }), whose unique key omits tenantId) — app-code
   *    tenant scoping stays mandatory belt-and-braces alongside RLS.
   *    res.count === 0 means the bill isn't tracked for that client (or wrong
   *    tenant) → 404.
   *  - end-before-start expected windows are rejected 400 (§1.3).
   */
  async updateBillContext(
    host: TrackerBoardService,
    tenantId: string,
    clientId: string,
    userId: string,
    billId: string,
    input: UpdateBillContextInput,
  ) {
    if (input.expectedWindowStart && input.expectedWindowEnd) {
      if (new Date(input.expectedWindowStart) > new Date(input.expectedWindowEnd)) {
        throw new BadRequestException('EXPECTED_WINDOW_END_BEFORE_START');
      }
    }
    const data: Record<string, unknown> = {};
    if (input.position !== undefined) data['position'] = input.position;
    if (input.priority !== undefined) data['priority'] = input.priority;
    if (input.analystNote !== undefined) data['analystNote'] = input.analystNote;
    let touchedExpected = false;
    if (input.expectedMilestoneType !== undefined) {
      data['expectedMilestoneType'] = input.expectedMilestoneType;
      touchedExpected = true;
    }
    if (input.expectedWindowStart !== undefined) {
      data['expectedWindowStart'] = input.expectedWindowStart
        ? new Date(input.expectedWindowStart)
        : null;
      touchedExpected = true;
    }
    if (input.expectedWindowEnd !== undefined) {
      data['expectedWindowEnd'] = input.expectedWindowEnd
        ? new Date(input.expectedWindowEnd)
        : null;
      touchedExpected = true;
    }
    if (input.expectedConfidence !== undefined) {
      data['expectedConfidence'] = input.expectedConfidence;
      touchedExpected = true;
    }
    if (input.expectedRationale !== undefined) {
      data['expectedRationale'] = input.expectedRationale;
      touchedExpected = true;
    }
    if (touchedExpected) {
      data['expectedUpdatedBy'] = userId;
      data['expectedUpdatedAt'] = new Date();
    }
    const res = await host['prisma'].withTenant(tenantId, (tx) =>
      tx.trackedBill.updateMany({ where: { tenantId, clientId, billId }, data }),
    );
    if (!res.count) {
      throw new NotFoundException('CLIENT_BILL_NOT_TRACKED');
    }
    const row = await host['prisma'].withTenant(tenantId, (tx) =>
      tx.trackedBill.findFirst({ where: { tenantId, clientId, billId } }),
    );
    return { ok: true, bill: row };
  }

  /**
   * Record a feedback signal (§Registry-2.4). `signal='dismissed'` /
   * `'marked_irrelevant'` suppress a bill from future recommendation feeds;
   * others are learning signals. Signal is allowlisted so the route can't write
   * arbitrary values into `intel_feedback`.
   */
  async recordFeedback(
    host: TrackerBoardService,
    tenantId: string,
    clientId: string,
    userId: string,
    input: {
      targetType?: string;
      targetRef: string;
      signal: string;
      alertId?: string | null;
      /** §4.10 (Gate E phase f): structured dismiss reason. */
      reason?: string | null;
      /** §4.10 (Gate E phase f): matched topic labels at dismissal time. */
      matchedTags?: string[];
      /** Gate K (MP-09): the topic ids behind matchedTags's topic entries
       *  (never issue areas) — the id-keyed twin feedbackSignal prefers. */
      matchedTopicIds?: string[];
    },
  ) {
    // Cross-tenant guard (P1-03/P1-04) — must run before the write below.
    await host['watchlists'].assertClientInTenant(tenantId, clientId);
    if (!this.allowedFeedbackSignals.has(input.signal)) {
      throw new BadRequestException(`Unknown feedback signal "${input.signal}"`);
    }
    if (!input.targetRef?.trim()) throw new BadRequestException('targetRef is required');
    // Gate J (HP-06) a-7: input.alertId is optional and attacker-controlled body
    // input (not a path param) — previously written verbatim with no proof it
    // belongs to this client. Only validate when present; feedback on a bare
    // targetRef with no alertId is a legitimate, alert-less signal.
    if (input.alertId) {
      await host['watchlists'].assertAlertInClient(tenantId, clientId, input.alertId);
    }
    await host['prisma'].withTenant(tenantId, (tx) =>
      tx.intelFeedback.create({
        data: {
          tenantId,
          clientId,
          userId,
          alertId: input.alertId ?? null,
          targetType: input.targetType ?? 'bill',
          targetRef: input.targetRef,
          signal: input.signal,
          reason: input.reason ?? null,
          matchedTags: input.matchedTags ?? [],
          matchedTopicIds: input.matchedTopicIds ?? [],
        },
      }),
    );
    return { ok: true };
  }

  /**
   * §4.10 (Gate E phase f): turn dismissals into a MEASURABLE signal instead
   * of only a per-bill exclusion. Returns per-topic-label dismissal counts by
   * reason for this client, so scoreBillFit can down-weight a topic that
   * keeps producing wrong-issue matches.
   *
   * Forward-only (§6 open decision 3, option (a)): `matchedTags` is only
   * populated going forward from this phase's `recordFeedback` change, so a
   * client with only pre-phase-f dismissals returns an empty map — not
   * because nothing was dismissed, but because the link did not exist yet.
   * Re-deriving it retroactively would re-match against the CURRENT
   * watchlist, which has likely changed since — answering a different
   * question than "what did the analyst actually see and reject".
   *
   * Gate K (MP-09, c-2): the map is keyed by topic ID when a row has one
   * (stable across a rename — see topicWeight in bill-fit.util.ts, which
   * looks up by id first), and falls back to LABEL keys for a row written
   * before `matched_topic_ids` existed. Also forward-only, same posture as
   * `matchedTags` itself — never backfilled by matching labels to ids,
   * which would risk mis-attributing a historical dismissal after a rename.
   */
  async feedbackSignal(
    host: TrackerBoardService,
    tenantId: string,
    clientId: string,
  ): Promise<
    Map<
      string,
      {
        total: number;
        byReason: Record<string, number>;
      }
    >
  > {
    const rows = await host['prisma'].withTenant(tenantId, (tx) =>
      tx.intelFeedback.findMany({
        where: {
          tenantId,
          clientId,
          signal: 'marked_irrelevant',
          matchedTags: { isEmpty: false },
        },
        select: { matchedTags: true, matchedTopicIds: true, reason: true },
      }),
    );
    const out = new Map<
      string,
      {
        total: number;
        byReason: Record<string, number>;
      }
    >();
    for (const row of rows) {
      const reasonKey = row.reason ?? 'unspecified';
      const keys = row.matchedTopicIds.length ? row.matchedTopicIds : row.matchedTags;
      for (const key of keys) {
        const entry = out.get(key) ?? { total: 0, byReason: {} };
        entry.total += 1;
        entry.byReason[reasonKey] = (entry.byReason[reasonKey] ?? 0) + 1;
        out.set(key, entry);
      }
    }
    return out;
  }
}
