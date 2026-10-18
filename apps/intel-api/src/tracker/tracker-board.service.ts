import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SourceDataRepository } from '../sourcedata/source-data.repository.js';
import { StateSourceDataRepository } from '../sourcedata/state-source-data.repository.js';
import { TrackerWatchlistService } from './tracker-watchlist.service.js';
import type { BillStage } from './bill-stage.util.js';
import type { CompiledTopicForFit } from './bill-fit.util.js';
import type {
  BoardFilters,
  BoardQueryOpts,
  BoardPage,
  UpdateBillContextInput,
  RecommendationItem,
  BillSearchResult,
  ChangeChip,
  BoardCard,
  BoardColumn,
} from './tracker-board.contracts.js';
import {
  billSearchPatterns as canonicalBillSearchPatterns,
  summarizeTrackedRows as canonicalSummarizeTrackedRows,
} from './tracker-board-presentation.js';
import { TrackerBoardTopics } from './tracker-board-topics.js';
import { TrackerBoardRecommendations } from './tracker-board-recommendations.js';
import { TrackerClientBoardRead } from './tracker-client-board-read.js';
import { TrackerTenantBoardRead } from './tracker-tenant-board-read.js';
import { TrackerBoardStateSupport } from './tracker-board-state-support.js';
import { TrackerBoardQueries } from './tracker-board-queries.js';
import { TrackerBoardCommands } from './tracker-board-commands.js';

export type {
  BoardFilters,
  BoardQueryOpts,
  BoardPage,
  UpdateBillContextInput,
  RecommendationItem,
  BillSearchResult,
  ChangeChip,
  BoardCard,
  BoardColumn,
} from './tracker-board.contracts.js';

/**
 * Recommendation feed + tracked-bill curation for the UNIFIED tracker (Phase 3
 * §6.2), ported from apps/api tracker.service.getRecommendations/getBoard/
 * trackBill/untrackBill. The relevance input is the compiled UNIFIED watchlist
 * (Phase 2 WatchlistCompiler) rather than the apps/api IntelligenceService.
 *
 * `intel_*` carries FORCE ROW LEVEL SECURITY (`20260706010000_intel_full_rls_hold`)
 * scoped to tenant_id; every read/write additionally filters by the
 * TenantGuard-resolved `tenantId` (+ clientId where applicable) in app code.
 * Gated by `tracker_owner_intel` at the
 * controller (404 when off) → during shadow only the internal tenant reaches
 * this, and apps/api stays source of truth (D6). Reads GLOBAL bill data
 * read-only via SourceDataRepository; writes only `intel_*`.
 */

/** Candidate floor for the semantic pre-filter (cosine ≥ this to be a candidate). */
export const EMBED_CANDIDATE_FLOOR = 0.3;

/**
 * State-candidate fit floor (DD6, S5.1) — LOWER than the federal
 * RECOMMENDATION_FLOOR (0.45) on purpose: state candidates never carry a
 * semantic component (embed-state-bills ships dark in P0), so scoreBillFit's
 * achievable max for a state bill is 0.60 (textMatch+exactEntity+
 * subjectMatch+priorityBoost), not 1.0 — the federal floor would starve
 * genuine matches. `fit.belowFloor` (computed against the federal floor) is
 * NOT used for state candidates; compare `fit.fit` against this constant
 * directly.
 */
export const LEGIWATCH_STATE_FIT_FLOOR = Number(process.env.LEGIWATCH_STATE_FIT_FLOOR ?? '0.40');

/** Change-chip lookback for the board (a tracked bill "changed recently"). */
const RECENT_CHANGE_DAYS = 21;

const DAY_MS = 86_400_000;

/**
 * P1-18: max tracked bills returned per board request. The code default IS
 * the intended production value — do not declare it in ECS; a deployment
 * that wants a different cap sets the env var explicitly.
 */
const BOARD_PAGE_SIZE = (() => {
  const n = Number(process.env.LEGIWATCH_BOARD_PAGE_SIZE);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
})();

const BOARD_PAGE_SIZE_MAX = 500;

/**
 * Feedback signals the API accepts (mirrors the `intel_feedback.signal` doc
 * set). Kept in exact lockstep with FEEDBACK_SIGNALS (tracker.dto.ts) — that
 * const is documented as DERIVED from this one.
 */
const ALLOWED_FEEDBACK_SIGNALS = new Set([
  'useful',
  'not_useful',
  'wrong_impact',
  'wrong_urgency',
  'false_positive',
  'missed',
  'tracked',
  'dismissed',
  'marked_irrelevant',
  'opened',
  'memo_generated',
  'memo_heavily_edited',
  'outreach_generated',
  'alert_ignored',
]);

/** §4.10 (Gate E phase f): the two dismiss reasons that mean the MATCH was
 *  over-broad, not just "handled" — see feedbackSignal/scoreBillFit. */
const MATCH_QUALITY_REASONS = new Set(['too_broad', 'wrong_issue']);

export function billSearchPatterns(query: string): { titleLike: string; idLike: string } {
  return canonicalBillSearchPatterns(query);
}

export function summarizeTrackedRows(rows: Array<{ unread: boolean }>): {
  boardCount: number;
  unread: number;
} {
  return canonicalSummarizeTrackedRows(rows);
}

const trackerBoardStateSupport = new TrackerBoardStateSupport();
const trackerBoardQueries = new TrackerBoardQueries();
const trackerBoardCommands = new TrackerBoardCommands(ALLOWED_FEEDBACK_SIGNALS);
const trackerBoardTopics = new TrackerBoardTopics();
const trackerBoardRecommendations = new TrackerBoardRecommendations({
  embedFloor: () => EMBED_CANDIDATE_FLOOR,
  stateFloor: () => LEGIWATCH_STATE_FIT_FLOOR,
});
const trackerBoardReadPolicy = {
  pageSize: BOARD_PAGE_SIZE,
  pageSizeMax: BOARD_PAGE_SIZE_MAX,
  recentChangeDays: RECENT_CHANGE_DAYS,
  dayMs: DAY_MS,
};
const trackerClientBoardRead = new TrackerClientBoardRead(trackerBoardReadPolicy);
const trackerTenantBoardRead = new TrackerTenantBoardRead(trackerBoardReadPolicy);

@Injectable()
export class TrackerBoardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: SourceDataRepository,
    private readonly watchlists: TrackerWatchlistService,
    private readonly stateRepo: StateSourceDataRepository,
  ) {}

  private stateStatusToBoardStage(status: string | null): BillStage {
    return trackerBoardStateSupport.stateStatusToBoardStage(this, status);
  }

  private stateBoardStage(
    bill: { status?: string | null } | null,
    persisted: BillStage | null,
  ): BillStage {
    return trackerBoardStateSupport.stateBoardStage(this, bill, persisted);
  }

  private stateStageLabel(status: string | null, stage: BillStage): string {
    return trackerBoardStateSupport.stateStageLabel(this, status, stage);
  }

  private async fetchMergedBills(billIds: string[]): Promise<
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
    return trackerBoardStateSupport.fetchMergedBills(this, billIds);
  }

  private canonicalStatusFor(
    billId: string,
    chip: ChangeChip | null,
    status: string | null | undefined,
    stage: BillStage,
  ): string | null {
    return trackerBoardStateSupport.canonicalStatusFor(this, billId, chip, status, stage);
  }

  private isTerminalNegativeStateStatus(
    billId: string,
    status: string | null | undefined,
  ): boolean {
    return trackerBoardStateSupport.isTerminalNegativeStateStatus(this, billId, status);
  }

  private displayNumFor(billId: string): string {
    return trackerBoardStateSupport.displayNumFor(this, billId);
  }

  private async alignStateStageFilter(
    tenantId: string,
    clientId: string | null,
    baseWhere: Record<string, unknown>,
    filters: BoardFilters | undefined,
  ): Promise<void> {
    return trackerBoardStateSupport.alignStateStageFilter(
      this,
      tenantId,
      clientId,
      baseWhere,
      filters,
    );
  }

  private jurisdictionFor(billId: string): string {
    return trackerBoardStateSupport.jurisdictionFor(this, billId);
  }

  private async compiledTopics(
    tenantId: string,
    clientId: string,
  ): Promise<{
    topics: CompiledTopicForFit[];
    issueAreas: string[];
    terms: string[];
    jurisdictions: string[];
  }> {
    return trackerBoardTopics.compiledTopics(this, tenantId, clientId);
  }

  async getRecommendations(
    tenantId: string,
    clientId: string,
    limit = 25,
  ): Promise<RecommendationItem[]> {
    return trackerBoardRecommendations.getRecommendations(this, tenantId, clientId, limit);
  }

  async getBoard(
    tenantId: string,
    clientId: string,
    opts: BoardQueryOpts = {},
  ): Promise<{ columns: BoardColumn[] } & BoardPage> {
    return trackerClientBoardRead.getBoard(this, tenantId, clientId, opts);
  }

  async getTenantBoard(
    tenantId: string,
    opts: BoardQueryOpts = {},
  ): Promise<
    {
      columns: Array<{
        id: BillStage;
        label: string;
        cards: Array<BoardCard & { clientId: string; clientName: string | null }>;
      }>;
    } & BoardPage
  > {
    return trackerTenantBoardRead.getTenantBoard(this, tenantId, opts);
  }

  private async compileTopicsForClients(
    tenantId: string,
    clientIds: string[],
  ): Promise<Map<string, { topics: CompiledTopicForFit[]; issueAreas: string[] }>> {
    return trackerBoardTopics.compileTopicsForClients(this, tenantId, clientIds);
  }

  async getTrackedStatus(tenantId: string, clientId: string, billId: string) {
    return trackerBoardQueries.getTrackedStatus(this, tenantId, clientId, billId);
  }

  async getSummary(
    tenantId: string,
    clientId: string,
  ): Promise<{ boardCount: number; unread: number; hasWatchlist: boolean }> {
    return trackerBoardQueries.getSummary(this, tenantId, clientId);
  }

  async getPortfolioCounts(tenantId: string): Promise<{ counts: Record<string, number> }> {
    return trackerBoardQueries.getPortfolioCounts(this, tenantId);
  }

  async searchBills(
    q: string,
    opts: { jurisdictions?: string[]; limit?: number } = {},
  ): Promise<BillSearchResult[]> {
    return trackerBoardQueries.searchBills(this, q, opts);
  }

  private async trackCongressStage(
    billId: string,
  ): Promise<{ stage: BillStage; latestActionText: string | null; latestActionDate: Date | null }> {
    return trackerBoardCommands.trackCongressStage(this, billId);
  }

  private async trackStateStage(
    billId: string,
  ): Promise<{ stage: BillStage; latestActionText: string | null; latestActionDate: Date | null }> {
    return trackerBoardCommands.trackStateStage(this, billId);
  }

  async trackBill(
    tenantId: string,
    clientId: string,
    userId: string,
    billId: string,
    opts?: { note?: string | null; source?: string; isManual?: boolean },
  ) {
    return trackerBoardCommands.trackBill(this, tenantId, clientId, userId, billId, opts);
  }

  async untrackBill(tenantId: string, clientId: string, billId: string) {
    return trackerBoardCommands.untrackBill(this, tenantId, clientId, billId);
  }

  async updateBillContext(
    tenantId: string,
    clientId: string,
    userId: string,
    billId: string,
    input: UpdateBillContextInput,
  ) {
    return trackerBoardCommands.updateBillContext(this, tenantId, clientId, userId, billId, input);
  }

  async recordFeedback(
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
    return trackerBoardCommands.recordFeedback(this, tenantId, clientId, userId, input);
  }

  async feedbackSignal(
    tenantId: string,
    clientId: string,
  ): Promise<Map<string, { total: number; byReason: Record<string, number> }>> {
    return trackerBoardCommands.feedbackSignal(this, tenantId, clientId);
  }
}
