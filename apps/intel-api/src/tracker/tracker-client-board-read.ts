import type { TrackedBill } from '../../generated/prisma-client/index.js';
import { isStateBillKey } from '@capiro/shared';
import type { TrackerBoardService } from './tracker-board.service.js';
import type {
  BoardCard,
  BoardColumn,
  BoardPage,
  BoardQueryOpts,
  ChangeChip,
} from './tracker-board.contracts.js';
import type {
  TrackerBoardReadPolicy,
  BoardBills,
  BoardTopics,
} from './tracker-board-read.contracts.js';
import { b64decode, encodeBoardCursor } from './tracker-board-cursors.js';
import { toRelevanceBill } from './tracker-board-presentation.js';
import { BILL_STAGES, billStage, passageProbability, type BillStage } from './bill-stage.util.js';
import { scoreBillFit, highPriorityMatches } from './bill-fit.util.js';
import { isTerminalRisk, toneForChange } from './change-detector.util.js';

type ReadEnrichment = Awaited<ReturnType<TrackerClientBoardRead['readEnrichment']>>;
type Enrichment = [
  ReadEnrichment[0],
  Pick<BoardTopics, 'topics' | 'issueAreas'>,
  ReadEnrichment[2],
  ReadEnrichment[3],
];
interface CardContext {
  billById: BoardBills;
  topics: BoardTopics['topics'];
  issueAreas: BoardTopics['issueAreas'];
  chipByBill: Map<string, ChangeChip>;
  hearingCountByBill: Map<string, number>;
  nowMs: number;
}
export class TrackerClientBoardRead {
  constructor(private readonly policy: TrackerBoardReadPolicy) {}
  async getBoard(
    host: TrackerBoardService,
    tenantId: string,
    clientId: string,
    opts: BoardQueryOpts,
  ): Promise<{ columns: BoardColumn[] } & BoardPage> {
    const empty = () =>
      BILL_STAGES.map((s) => ({ id: s.id, label: s.label, cards: [] as BoardCard[] }));
    const take = Math.min(opts.limit ?? this.policy.pageSize, this.policy.pageSizeMax);
    const cur = opts.cursor ? b64decode(opts.cursor) : null;
    let changedIds: Set<string> | null = null;
    if (opts.filters?.changedWithinDays) {
      const days = opts.filters.changedWithinDays;
      const rows = await this.readChangedRows(host, tenantId, clientId, days);
      changedIds = new Set(rows.map((r) => r.sourceRef));
      if (!changedIds.size) {
        return { columns: empty(), nextCursor: null, hasMore: false, total: 0, withheld: 0 };
      }
    }
    const baseWhere: Record<string, unknown> = { tenantId, clientId };
    if (changedIds) baseWhere['billId'] = { in: [...changedIds] };
    if (opts.filters?.stages?.length) baseWhere['stage'] = { in: opts.filters.stages };
    else if (opts.filters?.activeOnly) baseWhere['stage'] = { not: 'enacted' };
    await host['alignStateStageFilter'](tenantId, clientId, baseWhere, opts.filters);
    const pageWhere: Record<string, unknown> = { ...baseWhere };
    if (cur) {
      pageWhere['OR'] = [
        { trackedAt: { lt: new Date(cur.t) } },
        { trackedAt: new Date(cur.t), billId: { lt: cur.id } },
      ];
    }
    const [tracked, total] = await this.readPage(host, tenantId, pageWhere, baseWhere, take);
    const hasMore = tracked.length > take;
    const page = hasMore ? tracked.slice(0, take) : tracked;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeBoardCursor({ trackedAt: last.trackedAt, billId: last.billId })
        : null;
    const withheld = Math.max(0, total - page.length);
    if (!page.length) return { columns: empty(), nextCursor, hasMore, total, withheld };
    const billIds = page.map((t) => t.billId);
    const [bills, { topics, issueAreas }, recentAlerts, hearingLinks] = await this.readEnrichment(
      host,
      tenantId,
      clientId,
      billIds,
    );
    return this.renderBoard(
      host,
      page,
      [bills, { topics, issueAreas }, recentAlerts, hearingLinks],
      empty,
      { nextCursor, hasMore, total, withheld },
    );
  }
  private readChangedRows(
    host: TrackerBoardService,
    tenantId: string,
    clientId: string,
    days: number,
  ) {
    return host['prisma'].withTenant(tenantId, (tx) =>
      tx.intelAlert.findMany({
        where: {
          tenantId,
          clientId,
          sourceType: { in: ['bill', 'state_bill'] },
          createdAt: { gte: new Date(Date.now() - days * this.policy.dayMs) },
        },
        select: { sourceRef: true },
        distinct: ['sourceRef'],
      }),
    );
  }
  private readPage(
    host: TrackerBoardService,
    tenantId: string,
    pageWhere: Record<string, unknown>,
    baseWhere: Record<string, unknown>,
    take: number,
  ) {
    return Promise.all([
      host['prisma'].withTenant(tenantId, (tx) =>
        tx.trackedBill.findMany({
          where: pageWhere,
          orderBy: [{ trackedAt: 'desc' }, { billId: 'desc' }],
          take: take + 1,
        }),
      ),
      host['prisma'].withTenant(tenantId, (tx) => tx.trackedBill.count({ where: baseWhere })),
    ]);
  }
  private readEnrichment(
    host: TrackerBoardService,
    tenantId: string,
    clientId: string,
    billIds: string[],
  ) {
    return Promise.all([
      host['fetchMergedBills'](billIds),
      host['compiledTopics'](tenantId, clientId),
      host['prisma'].withTenant(tenantId, (tx) =>
        tx.intelAlert.findMany({
          where: {
            tenantId,
            clientId,
            sourceType: { in: ['bill', 'state_bill'] },
            sourceRef: { in: billIds },
            createdAt: {
              gte: new Date(Date.now() - this.policy.recentChangeDays * this.policy.dayMs),
            },
          },
          orderBy: { createdAt: 'desc' },
          select: {
            sourceRef: true,
            changeType: true,
            title: true,
            createdAt: true,
            severity: true,
          },
        }),
      ),
      host['prisma'].withTenant(tenantId, (tx) =>
        tx.intelAlert.groupBy({
          by: ['sourceRef'],
          where: {
            tenantId,
            clientId,
            sourceType: 'combined',
            sourceRef: { in: billIds },
            status: { notIn: ['dismissed', 'snoozed', 'suppressed'] },
          },
          _count: { _all: true },
        }),
      ),
    ]);
  }
  private renderBoard(
    host: TrackerBoardService,
    page: TrackedBill[],
    enrichment: Enrichment,
    empty: () => BoardColumn[],
    pageInfo: BoardPage,
  ): { columns: BoardColumn[] } & BoardPage {
    const [bills, { topics, issueAreas }, recentAlerts, hearingLinks] = enrichment;
    const { nextCursor, hasMore, total, withheld } = pageInfo;
    const billById = bills;
    const chipByBill = new Map<string, ChangeChip>();
    for (const a of recentAlerts) {
      if (!chipByBill.has(a.sourceRef)) {
        chipByBill.set(a.sourceRef, {
          label: a.title,
          changeType: a.changeType,
          at: a.createdAt,
          severity: a.severity ?? null,
          tone: toneForChange(a.changeType, a.severity),
        });
      }
    }
    const hearingCountByBill = new Map<string, number>();
    for (const g of hearingLinks) hearingCountByBill.set(g.sourceRef, g._count._all);
    const nowMs = Date.now();
    const columns = empty();
    const colById = new Map(columns.map((c) => [c.id, c]));
    for (const t of page) {
      this.appendCard(
        host,
        t,
        { billById, topics, issueAreas, chipByBill, hearingCountByBill, nowMs },
        columns,
        colById,
      );
    }
    return { columns, nextCursor, hasMore, total, withheld };
  }
  private appendCard(
    host: TrackerBoardService,
    t: TrackedBill,
    context: CardContext,
    columns: BoardColumn[],
    colById: Map<BillStage, BoardColumn>,
  ): void {
    const { billById, topics, issueAreas, chipByBill, hearingCountByBill, nowMs } = context;
    const bill = billById.get(t.billId) ?? null;
    const latestActionText = bill?.latestActionText ?? t.lastSeenActionText ?? null;
    const latestActionDate = bill?.latestActionDate ?? t.lastSeenActionDate ?? null;
    const stage = isStateBillKey(t.billId)
      ? host['stateBoardStage'](bill, (t.stage as BillStage | null) ?? null)
      : bill
        ? billStage(latestActionText, bill.status, bill.actionTexts)
        : ((t.stage as BillStage | null) ?? billStage(latestActionText));
    const matchedTags = bill
      ? scoreBillFit(toRelevanceBill({ ...bill, id: t.billId }), topics, issueAreas, 0, false)
          .matchedTags
      : [];
    const hi = highPriorityMatches(matchedTags, topics);
    const card: BoardCard = {
      billId: t.billId,
      displayNum: host['displayNumFor'](t.billId),
      title: bill?.title ?? null,
      stage,
      passageProbability: passageProbability({
        latestActionText,
        title: bill?.title ?? null,
        latestActionDate,
        nowMs,
      }),
      latestActionText,
      latestActionDate,
      note: t.note ?? null,
      isManual: t.isManual,
      unread: t.unread,
      trackedAt: t.trackedAt,
      matchedTags,
      matchedHighPriorityTopics: hi.matchedHighPriorityTopics,
      matchedPosition: hi.matchedPosition,
      changeChip: chipByBill.get(t.billId) ?? null,
      canonicalStatus: host['canonicalStatusFor'](
        t.billId,
        chipByBill.get(t.billId) ?? null,
        bill?.status,
        stage,
      ),
      terminalRisk:
        isTerminalRisk(chipByBill.get(t.billId)?.changeType) ||
        host['isTerminalNegativeStateStatus'](t.billId, bill?.status),
      lastHearingSessionId: t.lastHearingSessionId ?? null,
      lastHearingAt: t.lastHearingAt ?? null,
      hearingCount: hearingCountByBill.get(t.billId) ?? 0,
      jurisdiction: host['jurisdictionFor'](t.billId),
      trackedBy: t.trackedBy ?? null,
    };
    (colById.get(stage) ?? columns[0]!).cards.push(card);
  }
}
