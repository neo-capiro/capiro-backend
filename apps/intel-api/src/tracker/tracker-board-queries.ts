import type { TrackerBoardService } from './tracker-board.service.js';
import { humanizeStateBillKey } from '@capiro/shared';
import { billStage, passageProbability } from './bill-stage.util.js';
import { humanizeBillId } from './relevance.util.js';
import { billSearchPatterns, summarizeTrackedRows } from './tracker-board-presentation.js';
import type { BillSearchResult } from './tracker-board.contracts.js';
export class TrackerBoardQueries {
  /**
   * Lightweight board counts for the client-profile tab badge (Phase 7 —
   * repoints the legacy GET .../tracker/summary badge fetch). One tenant-scoped
   * SELECT of the `unread` bits, reduced by the pure summarizeTrackedRows.
   *
   * P2-01 (Gate D g-4): `hasWatchlist` is added here because the cold-start gate
   * needs an ALWAYS-AVAILABLE signal. The profile's own `watchlistQuery` is
   * `enabled: activePanel === 'config'`, so a cold-start check driven by it has
   * no data to run on — the chicken-and-egg that left the profile variant
   * defaulting to an empty Board instead of Configure. Enabling that query
   * unconditionally would add a request to every board load; this rides an
   * existing one.
   *
   * "Has a watchlist" means at least one topic OR one issue area — the same
   * two-part test the cold-start copy asks the user to complete.
   */
  async getTrackedStatus(
    host: TrackerBoardService,
    tenantId: string,
    clientId: string,
    billId: string,
  ) {
    const row = await host['prisma'].withTenant(tenantId, (tx) =>
      tx.trackedBill.findFirst({
        where: { tenantId, clientId, billId },
        select: { id: true, trackedAt: true },
      }),
    );
    return { tracked: Boolean(row), trackedAt: row?.trackedAt ?? null };
  }

  async getSummary(
    host: TrackerBoardService,
    tenantId: string,
    clientId: string,
  ): Promise<{
    boardCount: number;
    unread: number;
    hasWatchlist: boolean;
  }> {
    const [rows, watchlist] = await Promise.all([
      host['prisma'].withTenant(tenantId, (tx) =>
        tx.trackedBill.findMany({
          where: { tenantId, clientId },
          select: { unread: true },
        }),
      ),
      // One row + a topic count in a single read; WatchlistTopic keys on
      // watchlistId, so counting through the relation avoids a second lookup.
      host['prisma'].withTenant(tenantId, (tx) =>
        tx.watchlist.findFirst({
          where: { tenantId, clientId },
          select: { issueAreas: true, _count: { select: { topics: true } } },
        }),
      ),
    ]);
    return {
      ...summarizeTrackedRows(rows),
      hasWatchlist:
        (watchlist?._count?.topics ?? 0) > 0 || (watchlist?.issueAreas?.length ?? 0) > 0,
    };
  }

  /** Unpaginated per-client totals from the same tenant-owned rows as the board. */
  async getPortfolioCounts(
    host: TrackerBoardService,
    tenantId: string,
  ): Promise<{
    counts: Record<string, number>;
  }> {
    const rows = await host['prisma'].withTenant(tenantId, (tx) =>
      tx.trackedBill.groupBy({
        by: ['clientId'],
        where: { tenantId },
        _count: { _all: true },
      }),
    );
    return { counts: Object.fromEntries(rows.map((row) => [row.clientId, row._count._all])) };
  }

  /**
   * Add-bill-modal text search (P1.1, ported from apps/api
   * tracker.service.searchBills). <2 chars → []. Tenant-independent by design
   * (GLOBAL `congress_bill`/`state_bill`; auth is the route guards).
   *
   * The default searches the entire ingested corpus: every Congress and every
   * ingested state — a bounded suggestion list must not hide an older-session
   * or differently-jurisdiction bill. `jurisdictions` semantics, matching the
   * rest of LegiWatch: an EMPTY/absent list means everything, `['US']` means
   * federal only, and a list of state codes searches those states (plus
   * federal when 'US' is among them). Never "fix" an empty array to a default
   * list — MASTER §4.5.
   */
  async searchBills(
    host: TrackerBoardService,
    q: string,
    opts: {
      jurisdictions?: string[];
      limit?: number;
    },
  ): Promise<BillSearchResult[]> {
    const query = (q ?? '').trim();
    if (query.length < 2) return [];
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    const { titleLike, idLike } = billSearchPatterns(query);
    const juris = (opts.jurisdictions ?? []).map((j) => j.trim().toUpperCase()).filter(Boolean);
    const wantsAll = juris.length === 0;
    const wantsFederal = wantsAll || juris.includes('US');
    const states = juris.filter((j) => j !== 'US');
    const [federal, stateRows] = await Promise.all([
      wantsFederal ? host['repo'].searchBillRows(titleLike, idLike, null) : Promise.resolve([]),
      // The ingested state corpus is a handful of legislatures, so the state
      // rail searches them all unless the caller names a subset.
      wantsAll || states.length
        ? host['stateRepo'].searchStateBillRows(titleLike, idLike, states, limit)
        : Promise.resolve([]),
    ]);
    const out: BillSearchResult[] = federal.map((b) => ({
      billId: b.id,
      displayNum: humanizeBillId(b.id),
      title: b.title,
      stage: billStage(b.latestActionText, b.status, b.actionTexts),
      probability: passageProbability({
        latestActionText: b.latestActionText,
        status: b.status,
        actionTexts: b.actionTexts,
        title: b.title,
        latestActionDate: b.latestActionDate,
      }),
      jurisdiction: 'US',
    }));
    for (const b of stateRows) {
      out.push({
        billId: b.id,
        displayNum: humanizeStateBillKey(b.id),
        title: b.title,
        stage: billStage(b.latestActionText),
        probability: passageProbability({
          latestActionText: b.latestActionText,
          title: b.title,
          latestActionDate: b.latestActionDate,
        }),
        jurisdiction: b.state,
      });
    }
    return out.slice(0, limit);
  }
}
