import type { TrackerBoardService } from './tracker-board.service.js';
import {
  isStateBillKey,
  humanizeStateBillKey,
  stateBillStatusLabel,
  stateBillStatusRank,
} from '@capiro/shared';
import { BILL_STAGES, type BillStage } from './bill-stage.util.js';
import { humanizeBillId } from './relevance.util.js';
import { stageLabelOf } from './tracker-board-presentation.js';
import type { BoardFilters, ChangeChip } from './tracker-board.contracts.js';
export class TrackerBoardStateSupport {
  /**
   * Bucket a canonical state_bill status into the board's 4 congress-shaped
   * columns (S4.5 — no status ladder in P0; the drawer shows the real status).
   *
   * Rank is terminal *position*, not outcome, so this maps on the explicit
   * canonical status rather than `stateBillStatusRank` alone (every rank-9
   * terminal used to collapse to 'enacted', rank-3 'floor' to 'passed').
   * Negative outcomes (failed / dead_by_deadline) claim zero progress
   * ('introduced'); 'floor' stays a positive pre-passage 'committee'.
   */
  stateStatusToBoardStage(host: TrackerBoardService, status: string | null): BillStage {
    if (status === 'enacted' || status === 'veto_overridden') return 'enacted';
    if (status === 'vetoed') return 'passed';
    if (
      status === 'failed' ||
      status === 'dead_by_deadline' ||
      status === 'superseded' ||
      status === null
    ) {
      return 'introduced';
    }
    // 'floor', 'committee', 'reported', and any rank>=4 positive status.
    const rank = stateBillStatusRank(status);
    if (rank >= 4) return 'passed';
    if (rank >= 1) return 'committee';
    return 'introduced';
  }

  /**
   * Corrected display stage for a STATE bill on the board: the canonical status
   * (already fetched on the read path) is authoritative, NOT the persisted
   * `t.stage` — rows tracked before the mapping fix may carry a wrong stage,
   * and this read-time derivation corrects them without a destructive backfill.
   * A terminal-negative bill floors at 'introduced' (its last-reached stage is
   * not derivable from the retained state columns); the truthful terminal label
   * still surfaces via `canonicalStatus`. If the source row is absent we fall
   * back to the persisted stage rather than invent one.
   */
  stateBoardStage(
    host: TrackerBoardService,
    bill: {
      status?: string | null;
    } | null,
    persisted: BillStage | null,
  ): BillStage {
    if (bill) return host['stateStatusToBoardStage'](bill.status ?? null);
    return persisted ?? 'introduced';
  }

  /**
   * Recommendation label for a state candidate. The coarse lane label actively
   * misleads for a terminal or specific status, so prefer the canonical state
   * label whenever it differs; an unknown/null status keeps the lane label.
   * Federal recommendations already label by stage.
   */
  stateStageLabel(host: TrackerBoardService, status: string | null, stage: BillStage): string {
    if (!status) return stageLabelOf(stage);
    const label = stateBillStatusLabel(status);
    return label === status ? stageLabelOf(stage) : label;
  }

  /**
   * Batch-fetch bills for a jurisdiction-mixed set of ids, keyed by id — a DD1
   * key routes to StateSourceDataRepository, everything else to the congress
   * SourceDataRepository (S4.4/S7.6: board/recs are jurisdiction-mixed, no
   * separate state tab). ID shape alone disambiguates (congress ids start
   * with 2-3 digits; DD1 keys start with a 2-letter state code) — no need to
   * thread `source` through the caller.
   */
  async fetchMergedBills(
    host: TrackerBoardService,
    billIds: string[],
  ): Promise<
    Map<
      string,
      {
        title: string | null;
        latestActionText: string | null;
        latestActionDate: Date | null;
        policyArea: string | null;
        subjects: string[] | null;
        /** Canonical status and federal action history preserve reached stages. */
        status?: string | null;
        actionTexts?: string[];
      }
    >
  > {
    const congressIds = billIds.filter((id) => !isStateBillKey(id));
    const stateIds = billIds.filter((id) => isStateBillKey(id));
    const [congressBills, stateBills] = await Promise.all([
      congressIds.length ? host['repo'].fetchRecommendationBills(congressIds) : Promise.resolve([]),
      stateIds.length ? host['stateRepo'].getStateBillsByIds(stateIds) : Promise.resolve([]),
    ]);
    const out = new Map<
      string,
      {
        title: string | null;
        latestActionText: string | null;
        latestActionDate: Date | null;
        policyArea: string | null;
        subjects: string[] | null;
        /** Canonical status and federal action history preserve reached stages. */
        status?: string | null;
        actionTexts?: string[];
      }
    >();
    for (const b of congressBills) out.set(b.id, b);
    for (const b of stateBills) {
      out.set(b.id, {
        title: b.title,
        latestActionText: b.latestActionText,
        latestActionDate: b.latestActionDate,
        policyArea: null,
        subjects: b.subjects,
        status: b.status,
      });
    }
    return out;
  }

  /**
   * P2-09: the bill's REAL status, for the card's chip.
   *
   * The board buckets into four coarse lanes, so the lane alone cannot tell a
   * failed governing rule from a bill that merely reached the floor. Precedence:
   * the most recent material change's own label (the most specific truth we
   * have), then the state rail's canonical status, then the lane label.
   * Reuses values already in scope — nothing is re-derived or re-queried.
   */
  canonicalStatusFor(
    host: TrackerBoardService,
    billId: string,
    chip: ChangeChip | null,
    status: string | null | undefined,
    stage: BillStage,
  ): string | null {
    if (chip?.label) return chip.label;
    if (isStateBillKey(billId) && status) return stateBillStatusLabel(status);
    return BILL_STAGES.find((s) => s.id === stage)?.label ?? null;
  }

  /**
   * True when a STATE bill's canonical status is a terminal-negative outcome
   * (vetoed / failed / dead_by_deadline), independent of any recent change
   * chip. The chip signal only covers a bill that went terminal inside the
   * RECENT_CHANGE_DAYS window, so a bill that failed long ago (or whose
   * detector never fired) would otherwise render as an ordinary card. Only
   * terminal-NEGATIVE statuses qualify — 'enacted' and 'veto_overridden' are
   * successful terminal outcomes, not risk. Federal bills return false (their
   * terminal signal already flows through the chip change types).
   */
  isTerminalNegativeStateStatus(
    host: TrackerBoardService,
    billId: string,
    status: string | null | undefined,
  ): boolean {
    if (!isStateBillKey(billId) || !status) return false;
    return (
      status === 'vetoed' ||
      status === 'failed' ||
      status === 'dead_by_deadline' ||
      status === 'superseded'
    );
  }

  displayNumFor(host: TrackerBoardService, billId: string): string {
    return isStateBillKey(billId) ? humanizeStateBillKey(billId) : humanizeBillId(billId);
  }

  /**
   * Align the board query to the CORRECTED state stage. State rows display at
   * a stage derived from the canonical status (see `stateBoardStage`), not the
   * persisted `t.stage`, so the persisted `stage` WHERE on `activeOnly` /
   * `stages` cannot drive state-row selection or filter/count/pagination would
   * disagree with the corrected display.
   *
   * Scope: only the candidate set — the caller's own tracked ids intersected
   * with any changedWithinDays `billId IN` restriction (never an all-table
   * scan), plus one bounded `state_bill` lookup, only when the filter is set.
   * The stage constraint becomes `federalByStage OR keptStateId` under a single
   * AND: a FEDERAL row keeps the persisted-stage filter, a state row with a
   * canonical row is selected by its corrected stage, and a state row with NO
   * canonical row keeps the persisted-stage filter exactly like a federal row
   * (its display stage also falls back to persisted — filter and display agree).
   *
   * Mutates `baseWhere`. Always returns false — a void helper; an empty
   * candidate set yields an empty board through the same paginated query.
   */
  async alignStateStageFilter(
    host: TrackerBoardService,
    tenantId: string,
    clientId: string | null,
    baseWhere: Record<string, unknown>,
    filters: BoardFilters | undefined,
  ): Promise<void> {
    const isActiveOnly = !!filters?.activeOnly && !filters?.stages?.length;
    const isStages = !!filters?.stages?.length;
    if (!isActiveOnly && !isStages) return;
    const stageFilter = baseWhere['stage'];
    delete baseWhere['stage'];
    const existing = baseWhere['billId'] as
      | {
          in?: string[];
          notIn?: string[];
        }
      | undefined;
    delete baseWhere['billId'];
    // Candidate ids = tracked (tenant[+client]) ∩ existing billId.in.
    const trackedRows = await host['prisma'].withTenant(tenantId, (tx) =>
      tx.trackedBill.findMany({
        where: { tenantId, ...(clientId ? { clientId } : {}) },
        select: { billId: true },
        distinct: ['billId'],
      }),
    );
    let candidates = trackedRows.map((r) => r.billId);
    if (existing?.in) candidates = candidates.filter((id) => existing.in!.includes(id));
    if (existing?.notIn) candidates = candidates.filter((id) => !existing.notIn!.includes(id));
    const stateIds = candidates.filter((id) => isStateBillKey(id));
    const stateBills = stateIds.length ? await host['stateRepo'].getStateBillsByIds(stateIds) : [];
    const known = new Set(stateBills.map((b) => b.id));
    const keepState = new Set<string>();
    for (const b of stateBills) {
      const stage = host['stateStatusToBoardStage'](b.status ?? null);
      const keep = isActiveOnly
        ? // Preserve the standard terminal exclusion: drop the enacted lane AND
          // terminal-negative outcomes (which no longer occupy the enacted lane).
          stage !== 'enacted' && !host['isTerminalNegativeStateStatus'](b.id, b.status)
        : filters!.stages!.includes(stage);
      if (keep) keepState.add(b.id);
    }
    // Only a KNOWN state id bypasses the persisted-stage filter. An unknown id
    // (no canonical row) cannot be re-derived, so it joins the federal clause
    // below and keeps the persisted-stage filter — exactly like a federal row.
    const clauses: Array<Record<string, unknown>> = [];
    if (existing?.in) clauses.push({ billId: { in: existing.in } });
    if (existing?.notIn) clauses.push({ billId: { notIn: existing.notIn } });
    clauses.push({
      OR: [
        // Federal rows AND unknown state rows: persisted stage filter.
        { AND: [{ billId: { notIn: [...known] } }, stageFilter ? { stage: stageFilter } : {}] },
        // Known state rows: corrected stage decided above.
        { billId: { in: [...keepState] } },
      ],
    });
    baseWhere['AND'] = clauses;
  }

  /** 'US' | <state code>, derived from the id shape alone (the DD1 key's leading 2-letter segment). */
  jurisdictionFor(host: TrackerBoardService, billId: string): string {
    return isStateBillKey(billId) ? (billId.split('-')[0]?.toUpperCase() ?? 'US') : 'US';
  }
}
