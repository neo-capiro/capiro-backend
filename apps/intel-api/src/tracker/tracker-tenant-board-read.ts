import type { TrackedBill } from '../../generated/prisma-client/index.js';
import { isStateBillKey } from '@capiro/shared';
import type { TrackerBoardService } from './tracker-board.service.js';
import type {
  BoardCard,
  BoardPage,
  BoardQueryOpts,
  ChangeChip,
} from './tracker-board.contracts.js';
import type {
  TrackerBoardReadPolicy,
  BoardBills,
  TenantBoardTopics,
} from './tracker-board-read.contracts.js';
import { b64decode, encodeTenantBoardCursor } from './tracker-board-cursors.js';
import { toRelevanceBill } from './tracker-board-presentation.js';
import { BILL_STAGES, billStage, passageProbability, type BillStage } from './bill-stage.util.js';
import { scoreBillFit, highPriorityMatches } from './bill-fit.util.js';
import { isTerminalRisk, toneForChange } from './change-detector.util.js';
type TenantBoardCard = BoardCard & { clientId: string; clientName: string | null };
type TenantBoardColumn = { id: BillStage; label: string; cards: TenantBoardCard[] };
type TenantBoardResult = { columns: TenantBoardColumn[] } & BoardPage;
type Enrichment = Awaited<ReturnType<TrackerTenantBoardRead['readEnrichment']>>;
interface CardContext {
  billById: BoardBills;
  topicsByClient: TenantBoardTopics;
  ck: (cid: string, bid: string) => string;
  chipByCB: Map<string, ChangeChip>;
  hearingCountByCB: Map<string, number>;
  nowMs: number;
  clientNames: Map<string, string>;
}
export class TrackerTenantBoardRead {
  constructor(private readonly policy: TrackerBoardReadPolicy) {}
  async getTenantBoard(
    host: TrackerBoardService,
    tenantId: string,
    opts: BoardQueryOpts,
  ): Promise<
    {
      columns: Array<{
        id: BillStage;
        label: string;
        cards: Array<BoardCard & { clientId: string; clientName: string | null }>;
      }>;
    } & BoardPage
  > {
    type Card = BoardCard & {
      clientId: string;
      clientName: string | null;
    };
    const empty = () => BILL_STAGES.map((s) => ({ id: s.id, label: s.label, cards: [] as Card[] }));
    const take = Math.min(opts.limit ?? this.policy.pageSize, this.policy.pageSizeMax);
    const cur = opts.cursor ? b64decode(opts.cursor) : null;
    let changedIds: Set<string> | null = null;
    if (opts.filters?.changedWithinDays) {
      const days = opts.filters.changedWithinDays;
      const rows = await this.readChangedRows(host, tenantId, days);
      changedIds = new Set(rows.map((r) => r.sourceRef));
      if (!changedIds.size) {
        return { columns: empty(), nextCursor: null, hasMore: false, total: 0, withheld: 0 };
      }
    }
    const baseWhere: Record<string, unknown> = { tenantId };
    if (changedIds) baseWhere['billId'] = { in: [...changedIds] };
    if (opts.filters?.clientIds?.length) baseWhere['clientId'] = { in: opts.filters.clientIds };
    if (opts.filters?.stages?.length) baseWhere['stage'] = { in: opts.filters.stages };
    else if (opts.filters?.activeOnly) baseWhere['stage'] = { not: 'enacted' };
    await host['alignStateStageFilter'](tenantId, null, baseWhere, opts.filters);
    const pageWhere: Record<string, unknown> = { ...baseWhere };
    if (cur) {
      pageWhere['OR'] = [
        { trackedAt: { lt: new Date(cur.t) } },
        { trackedAt: new Date(cur.t), billId: { lt: cur.id } },
        ...(cur.c ? [{ trackedAt: new Date(cur.t), billId: cur.id, clientId: { lt: cur.c } }] : []),
      ];
    }
    const [tracked, total] = await this.readPage(host, tenantId, pageWhere, baseWhere, take);
    const hasMore = tracked.length > take;
    const page = hasMore ? tracked.slice(0, take) : tracked;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeTenantBoardCursor({
            trackedAt: last.trackedAt,
            billId: last.billId,
            clientId: last.clientId,
          })
        : null;
    const withheld = Math.max(0, total - page.length);
    if (!page.length) return { columns: empty(), nextCursor, hasMore, total, withheld };
    const billIds = Array.from(new Set(page.map((t) => t.billId)));
    const clientIds = Array.from(new Set(page.map((t) => t.clientId)));
    const [bills, recentAlerts, hearingLinks, clientNames] = await this.readEnrichment(
      host,
      tenantId,
      billIds,
      clientIds,
    );
    const topicsByClient = await host['compileTopicsForClients'](tenantId, clientIds);
    return this.renderBoard(
      host,
      page,
      [bills, recentAlerts, hearingLinks, clientNames],
      topicsByClient,
      empty,
      { nextCursor, hasMore, total, withheld },
    );
  }
  private readChangedRows(host: TrackerBoardService, tenantId: string, days: number) {
    return host['prisma'].withTenant(tenantId, (tx) =>
      tx.intelAlert.findMany({
        where: {
          tenantId,
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
          orderBy: [{ trackedAt: 'desc' }, { billId: 'desc' }, { clientId: 'desc' }],
          take: take + 1,
        }),
      ),
      host['prisma'].withTenant(tenantId, (tx) => tx.trackedBill.count({ where: baseWhere })),
    ]);
  }
  private readEnrichment(
    host: TrackerBoardService,
    tenantId: string,
    billIds: string[],
    clientIds: string[],
  ) {
    return Promise.all([
      host['fetchMergedBills'](billIds),
      host['prisma'].withTenant(tenantId, (tx) =>
        tx.intelAlert.findMany({
          where: {
            tenantId,
            sourceType: { in: ['bill', 'state_bill'] },
            sourceRef: { in: billIds },
            createdAt: {
              gte: new Date(Date.now() - this.policy.recentChangeDays * this.policy.dayMs),
            },
          },
          orderBy: { createdAt: 'desc' },
          select: {
            sourceRef: true,
            clientId: true,
            changeType: true,
            title: true,
            createdAt: true,
            severity: true,
          },
        }),
      ),
      host['prisma'].withTenant(tenantId, (tx) =>
        tx.intelAlert.groupBy({
          by: ['sourceRef', 'clientId'],
          where: {
            tenantId,
            sourceType: 'combined',
            sourceRef: { in: billIds },
            status: { notIn: ['dismissed', 'snoozed', 'suppressed'] },
          },
          _count: { _all: true },
        }),
      ),
      host['repo'].getClientNames(tenantId, clientIds).catch(() => new Map<string, string>()),
    ]);
  }
  private renderBoard(
    host: TrackerBoardService,
    page: TrackedBill[],
    enrichment: Enrichment,
    topicsByClient: TenantBoardTopics,
    empty: () => TenantBoardColumn[],
    pageInfo: BoardPage,
  ): TenantBoardResult {
    const [bills, recentAlerts, hearingLinks, clientNames] = enrichment;
    const { nextCursor, hasMore, total, withheld } = pageInfo;
    const billById = bills;
    const ck = (cid: string, bid: string) => `${cid}:${bid}`;
    const chipByCB = new Map<string, ChangeChip>();
    for (const a of recentAlerts) {
      const k = ck(a.clientId, a.sourceRef);
      if (!chipByCB.has(k))
        chipByCB.set(k, {
          label: a.title,
          changeType: a.changeType,
          at: a.createdAt,
          severity: a.severity ?? null,
          tone: toneForChange(a.changeType, a.severity),
        });
    }
    const hearingCountByCB = new Map<string, number>();
    for (const g of hearingLinks) hearingCountByCB.set(ck(g.clientId, g.sourceRef), g._count._all);
    const nowMs = Date.now();
    const columns = empty();
    const colById = new Map(columns.map((c) => [c.id, c]));
    for (const t of page) {
      this.appendCard(
        host,
        t,
        { billById, topicsByClient, ck, chipByCB, hearingCountByCB, nowMs, clientNames },
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
    columns: TenantBoardColumn[],
    colById: Map<BillStage, TenantBoardColumn>,
  ): void {
    const { billById, topicsByClient, ck, chipByCB, hearingCountByCB, nowMs, clientNames } =
      context;
    const bill = billById.get(t.billId) ?? null;
    const latestActionText = bill?.latestActionText ?? t.lastSeenActionText ?? null;
    const latestActionDate = bill?.latestActionDate ?? t.lastSeenActionDate ?? null;
    const stage = isStateBillKey(t.billId)
      ? host['stateBoardStage'](bill, (t.stage as BillStage | null) ?? null)
      : bill
        ? billStage(latestActionText, bill.status, bill.actionTexts)
        : ((t.stage as BillStage | null) ?? billStage(latestActionText));
    const ct = topicsByClient.get(t.clientId);
    const matchedTags =
      bill && ct
        ? scoreBillFit(
            toRelevanceBill({ ...bill, id: t.billId }),
            ct.topics,
            ct.issueAreas,
            0,
            false,
          ).matchedTags
        : [];
    const hi = highPriorityMatches(matchedTags, ct?.topics ?? []);
    const card: TenantBoardCard = {
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
      changeChip: chipByCB.get(ck(t.clientId, t.billId)) ?? null,
      canonicalStatus: host['canonicalStatusFor'](
        t.billId,
        chipByCB.get(ck(t.clientId, t.billId)) ?? null,
        bill?.status,
        stage,
      ),
      terminalRisk:
        isTerminalRisk(chipByCB.get(ck(t.clientId, t.billId))?.changeType) ||
        host['isTerminalNegativeStateStatus'](t.billId, bill?.status),
      lastHearingSessionId: t.lastHearingSessionId ?? null,
      lastHearingAt: t.lastHearingAt ?? null,
      hearingCount: hearingCountByCB.get(ck(t.clientId, t.billId)) ?? 0,
      jurisdiction: host['jurisdictionFor'](t.billId),
      clientId: t.clientId,
      clientName: clientNames.get(t.clientId) ?? null,
      trackedBy: t.trackedBy ?? null,
    };
    (colById.get(stage) ?? columns[0]!).cards.push(card);
  }
}
