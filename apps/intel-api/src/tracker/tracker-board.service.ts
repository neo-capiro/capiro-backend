import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SourceDataRepository } from '../sourcedata/source-data.repository.js';
import { StateSourceDataRepository } from '../sourcedata/state-source-data.repository.js';
import {
  TrackerWatchlistService,
  HEARING_TERMS_TOPIC_LABEL,
  isReservedTopicLabel,
} from './tracker-watchlist.service.js';
import {
  isStateBillKey,
  humanizeStateBillKey,
  stateBillStatusLabel,
  stateBillStatusRank,
} from '@capiro/shared';
import { embedText, normalize, vectorLiteral, EMBEDDING_MODEL } from '../embeddings/embedder.js';
import { compileWatchlist, type CompilerTopic, type CompilerTerm } from '../watchlist/watchlist-compiler.js';
import {
  highPriorityMatches,
  scoreBillFit,
  type CompiledTopicForFit,
  type MatchReason,
  type MatchReasonKind,
} from './bill-fit.util.js';
import {
  BILL_STAGES,
  billStage,
  congressFromBillId,
  currentCongress,
  passageProbability,
  type BillStage,
} from './bill-stage.util.js';
import { humanizeBillId, type RelevanceBill } from './relevance.util.js';
import { isTerminalRisk, toneForChange } from './change-detector.util.js';

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

interface BoardCursor {
  t: string;
  id: string;
}
const b64encode = (obj: unknown): string =>
  Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
/** Mirrors feed.service.ts's b64decode: a malformed or stale cursor is ignored (page 1), never thrown. */
const b64decode = (cur: string): BoardCursor | null => {
  try {
    const parsed = JSON.parse(Buffer.from(cur, 'base64url').toString('utf8')) as unknown;
    return parsed &&
      typeof (parsed as BoardCursor).t === 'string' &&
      typeof (parsed as BoardCursor).id === 'string'
      ? (parsed as BoardCursor)
      : null;
  } catch {
    return null;
  }
};
function encodeBoardCursor(row: { trackedAt: Date; billId: string }): string {
  return b64encode({ t: row.trackedAt.toISOString(), id: row.billId } satisfies BoardCursor);
}

/**
 * P1-18: server-side board filters (the audit's "default to active/recent/
 * changed bills rather than the entire history"). ALL default OFF — today's
 * default is "everything tracked"; silently narrowing it would make bills
 * vanish from an analyst's board (MASTER §4.5).
 */
export interface BoardFilters {
  /** Only bills with a bill/state_bill alert in the last N days. */
  changedWithinDays?: number;
  /**
   * Excludes the 'enacted' lane — a STAGE-based proxy for "terminal"
   * (enacted/failed/vetoed). The richer signal, `terminalRisk`, is derived
   * from alerts inside the 21-day RECENT_CHANGE_DAYS window (see
   * `canonicalStatusFor` below) and is therefore unknown for a bill that
   * went terminal longer ago than that — it cannot gate the paginated query
   * without a join this phase does not add. Documented, not silent.
   */
  activeOnly?: boolean;
  stages?: BillStage[];
  /** Tenant board (`_all`) only; `getBoard` ignores it (already one client). */
  clientIds?: string[];
}
export interface BoardQueryOpts {
  limit?: number;
  cursor?: string;
  filters?: BoardFilters;
}
export interface BoardPage {
  nextCursor: string | null;
  hasMore: boolean;
  total: number;
  withheld: number;
}

/** Editable Bill 360 client-bill context fields (Release R1, §1.3). All optional. */
export interface UpdateBillContextInput {
  position?: string;
  priority?: string;
  analystNote?: string;
  expectedMilestoneType?: string;
  expectedWindowStart?: string;
  expectedWindowEnd?: string;
  expectedConfidence?: string;
  expectedRationale?: string;
}
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

export interface RecommendationItem {
  billId: string;
  displayNum: string;
  title: string | null;
  stage: BillStage;
  stageLabel: string;
  passageProbability: number;
  latestActionText: string | null;
  latestActionDate: Date | null;
  sponsorName: string | null;
  sponsorParty: string | null;
  cosponsorsCount: number | null;
  fit: number;
  matchedTags: string[];
  /** Gate K (MP-09): topic ids behind matchedTags's topic entries (never
   *  issue areas) — see BillFit.matchedTopicIds. */
  matchedTopicIds: string[];
  why: string;
  whyKind: MatchReasonKind;
  matchReasons: MatchReason[];
  /** 'US' | <state code> (State Legislation Platform, S5/S7.2). Absent = 'US' — every pre-Phase-0 caller stays unaffected. */
  jurisdiction?: string;
  /** Official state deep link (a state candidate only) — new-match-detector's billUrl() prefers this over any congress.gov synthesis. */
  stateUrl?: string | null;
  /** LegiScan/OpenStates source link (a state candidate only) — the billUrl() fallback below stateUrl. */
  url?: string | null;
}

/** One Add-bill-modal search hit (P1.1 — exact legacy BillSearchResult shape). */
export interface BillSearchResult {
  billId: string;
  displayNum: string;
  title: string | null;
  stage: BillStage;
  probability: number;
  /** P1-17: 'US' or a 2-letter state code, so the Add Bill modal can label
   *  which rail each result came from. */
  jurisdiction?: string;
}

/**
 * Build the two bound LIKE patterns for bill search (P1.1, ported from
 * apps/api tracker.service.searchBills): a lowercase title substring, plus a
 * bill-id token — "H.R. 4455" → "%hr-4455%" (strip dots/spaces, hyphen between
 * the alpha type and the first digit) so the query matches the id form.
 * Exported for the pure-unit spec.
 */
export function billSearchPatterns(query: string): { titleLike: string; idLike: string } {
  const titleLike = `%${query.toLowerCase()}%`;
  const idLike = `%${query
    .toLowerCase()
    .replace(/[.\s]+/g, '')
    .replace(/^([a-z]+)(\d)/, '$1-$2')}%`;
  return { titleLike, idLike };
}

/**
 * Pure reducer for the client-profile tab-badge summary — legacy-identical
 * `{ boardCount, unread }` (apps/api tracker.service.getSummary). The legacy
 * service derives `unread` per card from change events vs 'opened' feedback;
 * here `intel_tracked_bill.unread` already stores that bit (getBoard's cards
 * read it verbatim), so counting rows matches the board without paying for fit
 * scoring or alert lookups. Exported for the unit spec.
 */
export function summarizeTrackedRows(rows: Array<{ unread: boolean }>): {
  boardCount: number;
  unread: number;
} {
  let unread = 0;
  for (const r of rows) if (r.unread) unread += 1;
  return { boardCount: rows.length, unread };
}

/**
 * The most recent material change on a tracked bill, for the card's chip.
 *
 * P1-08: `severity` and `tone` are new. The web used to re-derive a tone from its
 * OWN copy of a narrow federal change-type list, so a failed governing rule or a
 * state veto rendered as an ordinary 'notable' chip. Both now come from the
 * server: `severity` straight off the `intel_alert` column, `tone` from the
 * detector's own vocabulary (`toneForChange`).
 */
export interface ChangeChip {
  label: string;
  changeType: string | null;
  at: Date;
  /** The detector's own classification: 'info' | 'notable' | 'critical'. */
  severity: string | null;
  /** 'success' | 'critical' | 'notable' | 'info' — distinguishes "Became law"
   *  (success) from "Failed / rejected" (critical), which severity alone cannot. */
  tone: string | null;
}

export interface BoardCard {
  billId: string;
  displayNum: string;
  title: string | null;
  stage: BillStage;
  passageProbability: number;
  latestActionText: string | null;
  latestActionDate: Date | null;
  note: string | null;
  isManual: boolean;
  unread: boolean;
  trackedAt: Date;
  matchedTags: string[];
  /**
   * P0-06: the subset of `matchedTags` whose topic priority is 'high'. The web's
   * High-fit filter reads THIS instead of deriving it from the watchlist query,
   * which is not enabled on the Bills surface at all — so the filter used to match
   * nothing there on a cold load.
   */
  matchedHighPriorityTopics: string[];
  /** The client's stance on the highest-priority matched topic: support|oppose|monitor|null. */
  matchedPosition: string | null;
  changeChip: ChangeChip | null;
  /**
   * P2-09: the bill's REAL status label, not the coarse lane it was bucketed
   * into. The board has four lanes but the detector classifies far more, so a
   * failed governing rule used to render as an ordinary card in the lane its
   * stage happened to map to.
   */
  canonicalStatus: string | null;
  /** P2-09: a failed rule / veto / failed vote / past-deadline state bill. */
  terminalRisk: boolean;
  // Phase 9 (Bill→Hearing interlink): "discussed in N hearings" chip. Presence
  // comes from the trackedBill hearing badge (set by the linker); the count is
  // the number of distinct `combined` alerts for this bill.
  lastHearingSessionId: string | null;
  lastHearingAt: Date | null;
  hearingCount: number;
  /** 'US' | <state code> (State Legislation Platform, S7.2). Absent = 'US'. */
  jurisdiction?: string;
  /**
   * MP-15 / Gate H phase d: the Clerk user id that tracked this bill — already
   * in memory from the unfiltered `findMany` above, just never projected.
   * Null for a row tracked before this column was populated (edge case 4).
   * A Clerk id, NOT a DB user UUID — the web resolves it to a name via
   * GET /api/users/tenant-members, never via useTeamMembers() (wrong id space).
   */
  trackedBy: string | null;
}
export interface BoardColumn {
  id: BillStage;
  label: string;
  cards: BoardCard[];
}

const stageLabelOf = (s: BillStage): string => BILL_STAGES.find((x) => x.id === s)?.label ?? s;

/**
 * P0-04: `id` and `sponsorName` are optional because `fetchMergedBills`'s
 * minimal common shape (board/getTenantBoard matchedTags) carries neither —
 * legislator routing is consequently inert on that rail. Callers that DO have
 * the underlying congress_bill/state bill row (recommendations) pass both.
 */
const toRelevanceBill = (b: {
  title: string | null;
  policyArea: string | null;
  subjects: string[] | null;
  latestActionText: string | null;
  id?: string;
  sponsorName?: string | null;
}): RelevanceBill => ({
  title: b.title ?? '',
  policyArea: b.policyArea,
  subjects: b.subjects,
  latestActionText: b.latestActionText,
  ...(b.id
    ? { billId: b.id, displayNum: isStateBillKey(b.id) ? humanizeStateBillKey(b.id) : humanizeBillId(b.id) }
    : {}),
  ...(b.sponsorName !== undefined ? { sponsorName: b.sponsorName } : {}),
});

@Injectable()
export class TrackerBoardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: SourceDataRepository,
    private readonly watchlists: TrackerWatchlistService,
    private readonly stateRepo: StateSourceDataRepository,
  ) {}

  /** Bucket a state_bill status rank (0-9) into the board's 4 congress-shaped columns (S4.5 — no status ladder in P0; the drawer shows the real status). */
  private stateStatusToBoardStage(status: string | null): BillStage {
    const rank = stateBillStatusRank(status);
    if (rank >= 9) return 'enacted';
    if (rank >= 3) return 'passed';
    if (rank >= 1) return 'committee';
    return 'introduced';
  }

  /**
   * Batch-fetch bills for a jurisdiction-mixed set of ids, keyed by id — a DD1
   * key routes to StateSourceDataRepository, everything else to the congress
   * SourceDataRepository (S4.4/S7.6: board/recs are jurisdiction-mixed, no
   * separate state tab). ID shape alone disambiguates (congress ids start
   * with 2-3 digits; DD1 keys start with a 2-letter state code) — no need to
   * thread `source` through the caller.
   */
  private async fetchMergedBills(billIds: string[]): Promise<
    Map<
      string,
      {
        title: string | null;
        latestActionText: string | null;
        latestActionDate: Date | null;
        policyArea: string | null;
        subjects: string[] | null;
        /** P2-09: the state rail's canonical status. Null for federal bills,
         *  whose status is derived from the action text instead. */
        status?: string | null;
      }
    >
  > {
    const congressIds = billIds.filter((id) => !isStateBillKey(id));
    const stateIds = billIds.filter((id) => isStateBillKey(id));
    const [congressBills, stateBills] = await Promise.all([
      congressIds.length ? this.repo.fetchRecommendationBills(congressIds) : Promise.resolve([]),
      stateIds.length ? this.stateRepo.getStateBillsByIds(stateIds) : Promise.resolve([]),
    ]);
    const out = new Map<
      string,
      {
        title: string | null;
        latestActionText: string | null;
        latestActionDate: Date | null;
        policyArea: string | null;
        subjects: string[] | null;
        /** P2-09: the state rail's canonical status. Null for federal bills,
         *  whose status is derived from the action text instead. */
        status?: string | null;
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
  private canonicalStatusFor(
    billId: string,
    chip: ChangeChip | null,
    status: string | null | undefined,
    stage: BillStage,
  ): string | null {
    if (chip?.label) return chip.label;
    if (isStateBillKey(billId) && status) return stateBillStatusLabel(status);
    return BILL_STAGES.find((s) => s.id === stage)?.label ?? null;
  }

  private displayNumFor(billId: string): string {
    return isStateBillKey(billId) ? humanizeStateBillKey(billId) : humanizeBillId(billId);
  }

  /** 'US' | <state code>, derived from the id shape alone (the DD1 key's leading 2-letter segment). */
  private jurisdictionFor(billId: string): string {
    return isStateBillKey(billId) ? (billId.split('-')[0]?.toUpperCase() ?? 'US') : 'US';
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
    const compiled = await this.watchlists.getCompiled(tenantId, clientId);
    const topics: CompiledTopicForFit[] = compiled.billMatchSet.map((t) => ({
      id: t.id,
      label: t.label,
      issueArea: t.issueArea,
      priority: t.priority,
      // P0-06: already on the compiler's output — carried so the board can derive
      // matchedHighPriorityTopics/matchedPosition without a second watchlist read.
      position: t.position,
      keywords: t.keywords,
      synonyms: t.synonyms,
      entities: t.entities,
      riskPhrases: t.riskPhrases,
      routableTerms: t.routableTerms,
    }));
    const termSet = new Set<string>();
    for (const t of topics) {
      for (const v of [...t.keywords, ...t.synonyms, ...t.entities, ...t.riskPhrases])
        termSet.add(v);
    }
    for (const a of compiled.issueAreas) termSet.add(a);
    return {
      topics,
      issueAreas: compiled.issueAreas,
      terms: Array.from(termSet),
      jurisdictions: compiled.jurisdictions,
    };
  }

  /**
   * Ranked bill recommendations for a client. Union of semantic (Bedrock cosine)
   * + keyword/subject candidates in the current Congress, minus already-tracked
   * and dismissed bills, scored by the composite fit and floored at
   * RECOMMENDATION_FLOOR. Embeddings failure degrades to keyword-only.
   */
  async getRecommendations(
    tenantId: string,
    clientId: string,
    limit = 25,
  ): Promise<RecommendationItem[]> {
    const { topics, issueAreas, terms, jurisdictions } = await this.compiledTopics(
      tenantId,
      clientId,
    );
    if (!terms.length) return [];
    const congress = currentCongress();
    // §4.10 (Gate E phase f): per-topic dismissal signal — down-weights a
    // topic the analyst has repeatedly marked too-broad/wrong-issue. Empty
    // for a client with no such dismissals, which scores byte-identically to
    // pre-phase-f (bill-fit.util.ts topicWeight defaults every topic to 1.0).
    const feedback = await this.feedbackSignal(tenantId, clientId);

    // Semantic candidates (best-effort — keyword path still works if Bedrock is down).
    const semantic = new Map<string, number>();
    try {
      const vec = await embedText(normalize(terms.join('. ')));
      const scores = await this.repo.semanticBillScores(
        vectorLiteral(vec),
        EMBEDDING_MODEL,
        EMBED_CANDIDATE_FLOOR,
      );
      for (const s of scores) {
        if (congressFromBillId(s.sourceId) === congress) semantic.set(s.sourceId, s.score);
      }
    } catch {
      /* embeddings unavailable → keyword-only fallback */
    }

    const keywordIds = new Set(await this.repo.keywordCandidateIds(terms, congress));

    const [tracked, dismissed] = await this.prisma.withTenant(tenantId, (tx) =>
      Promise.all([
        tx.trackedBill.findMany({ where: { tenantId, clientId }, select: { billId: true } }),
        tx.intelFeedback.findMany({
          where: {
            tenantId,
            clientId,
            targetType: 'bill',
            signal: { in: ['dismissed', 'marked_irrelevant'] },
          },
          select: { targetRef: true },
        }),
      ]),
    );
    const excluded = new Set<string>([
      ...tracked.map((t) => t.billId),
      ...dismissed.map((d) => d.targetRef),
    ]);

    const candidateIds = Array.from(new Set<string>([...semantic.keys(), ...keywordIds])).filter(
      (id) => !excluded.has(id),
    );

    const nowMs = Date.now();
    const items: RecommendationItem[] = [];
    if (candidateIds.length) {
      const bills = await this.repo.fetchRecommendationBills(candidateIds);
      for (const b of bills) {
        const fit = scoreBillFit(
          toRelevanceBill(b),
          topics,
          issueAreas,
          semantic.get(b.id) ?? 0,
          keywordIds.has(b.id),
          feedback,
        );
        if (fit.fit <= 0 || fit.belowFloor) continue;
        const stage = billStage(b.latestActionText);
        items.push({
          billId: b.id,
          displayNum: humanizeBillId(b.id),
          title: b.title,
          stage,
          stageLabel: stageLabelOf(stage),
          passageProbability: passageProbability({
            latestActionText: b.latestActionText,
            title: b.title,
            latestActionDate: b.latestActionDate,
            nowMs,
          }),
          latestActionText: b.latestActionText,
          latestActionDate: b.latestActionDate,
          sponsorName: b.sponsorName,
          sponsorParty: b.sponsorParty,
          cosponsorsCount: b.cosponsorsCount,
          fit: fit.fit,
          matchedTags: fit.matchedTags,
          matchedTopicIds: fit.matchedTopicIds,
          why: fit.why,
          whyKind: fit.whyKind,
          matchReasons: fit.matchReasons,
        });
      }
    }

    // ── State Legislation Platform (S5.1): a second candidate pass, EXPLICIT
    // opt-in only — runs ONLY when the client's watchlist has jurisdictions
    // configured (never auto-matched from facility geography in P0;
    // suggestedJurisdictions is a hint, not an implicit filter). No semantic
    // component (DD6 — embed-state-bills ships dark), so compare against the
    // LOWER LEGIWATCH_STATE_FIT_FLOOR directly, not fit.belowFloor (the
    // federal floor would starve every state match).
    if (jurisdictions.length) {
      const stateCandidateIds = (
        await this.stateRepo.stateKeywordCandidateIds(terms, jurisdictions)
      ).filter((id) => !excluded.has(id));
      if (stateCandidateIds.length) {
        const stateBills = await this.stateRepo.getStateBillsByIds(stateCandidateIds);
        for (const b of stateBills) {
          const fit = scoreBillFit(
            toRelevanceBill({
              title: b.title,
              policyArea: null,
              subjects: b.subjects,
              latestActionText: b.latestActionText,
              id: b.id,
              sponsorName: b.sponsorName,
            }),
            topics,
            issueAreas,
            0,
            true,
            feedback,
          );
          if (fit.fit < LEGIWATCH_STATE_FIT_FLOOR) continue;
          const stage = this.stateStatusToBoardStage(b.status);
          items.push({
            billId: b.id,
            displayNum: humanizeStateBillKey(b.id),
            title: b.title,
            stage,
            stageLabel: stageLabelOf(stage),
            passageProbability: passageProbability({
              latestActionText: b.latestActionText,
              title: b.title,
              latestActionDate: b.latestActionDate,
              nowMs,
            }),
            latestActionText: b.latestActionText,
            latestActionDate: b.latestActionDate,
            sponsorName: b.sponsorName,
            sponsorParty: b.sponsorParty,
            cosponsorsCount: null, // state bills carry sponsorCount, not a cosponsor time series (S1.4)
            fit: fit.fit,
            matchedTags: fit.matchedTags,
            matchedTopicIds: fit.matchedTopicIds,
            why: fit.why,
            whyKind: fit.whyKind,
            matchReasons: fit.matchReasons,
            jurisdiction: b.state,
            stateUrl: b.stateUrl,
            url: b.url,
          });
        }
      }
    }

    items.sort((a, b) => b.fit - a.fit || b.passageProbability - a.passageProbability);
    return items.slice(0, limit);
  }

  /**
   * The curated tracker board: tracked bills bucketed by stage, newest-first per
   * column. P1-18: bounded by `opts.limit` (default `BOARD_PAGE_SIZE`, hard max
   * `BOARD_PAGE_SIZE_MAX`), keyset-paginated (no OFFSET) via `opts.cursor`, and
   * optionally narrowed by `opts.filters` — every filter defaults OFF.
   */
  async getBoard(
    tenantId: string,
    clientId: string,
    opts: BoardQueryOpts = {},
  ): Promise<{ columns: BoardColumn[] } & BoardPage> {
    const empty = () =>
      BILL_STAGES.map((s) => ({ id: s.id, label: s.label, cards: [] as BoardCard[] }));
    const take = Math.min(opts.limit ?? BOARD_PAGE_SIZE, BOARD_PAGE_SIZE_MAX);
    const cur = opts.cursor ? b64decode(opts.cursor) : null;

    // a-5: changedWithinDays needs the qualifying billId SET before the paginated
    // query can filter on it — a dependent lookup, run before (not parallel with)
    // the count/page queries below.
    let changedIds: Set<string> | null = null;
    if (opts.filters?.changedWithinDays) {
      const days = opts.filters.changedWithinDays;
      const rows = await this.prisma.withTenant(tenantId, (tx) =>
        tx.intelAlert.findMany({
          where: {
            tenantId,
            clientId,
            sourceType: { in: ['bill', 'state_bill'] },
            createdAt: { gte: new Date(Date.now() - days * DAY_MS) },
          },
          select: { sourceRef: true },
          distinct: ['sourceRef'],
        }),
      );
      changedIds = new Set(rows.map((r) => r.sourceRef));
      if (!changedIds.size) {
        return { columns: empty(), nextCursor: null, hasMore: false, total: 0, withheld: 0 };
      }
    }

    const baseWhere: Record<string, unknown> = { tenantId, clientId };
    if (changedIds) baseWhere['billId'] = { in: [...changedIds] };
    if (opts.filters?.stages?.length) baseWhere['stage'] = { in: opts.filters.stages };
    else if (opts.filters?.activeOnly) baseWhere['stage'] = { not: 'enacted' };
    const pageWhere: Record<string, unknown> = { ...baseWhere };
    if (cur) {
      pageWhere['OR'] = [
        { trackedAt: { lt: new Date(cur.t) } },
        { trackedAt: new Date(cur.t), billId: { lt: cur.id } },
      ];
    }

    const [tracked, total] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.trackedBill.findMany({
          where: pageWhere,
          orderBy: [{ trackedAt: 'desc' }, { billId: 'desc' }],
          take: take + 1,
        }),
      ),
      this.prisma.withTenant(tenantId, (tx) => tx.trackedBill.count({ where: baseWhere })),
    ]);
    const hasMore = tracked.length > take;
    const page = hasMore ? tracked.slice(0, take) : tracked;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeBoardCursor({ trackedAt: last.trackedAt, billId: last.billId }) : null;
    const withheld = Math.max(0, total - page.length);
    if (!page.length) return { columns: empty(), nextCursor, hasMore, total, withheld };

    const billIds = page.map((t) => t.billId);
    const [bills, { topics, issueAreas }, recentAlerts, hearingLinks] = await Promise.all([
      this.fetchMergedBills(billIds),
      this.compiledTopics(tenantId, clientId),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.intelAlert.findMany({
          where: {
            tenantId,
            clientId,
            sourceType: { in: ['bill', 'state_bill'] },
            sourceRef: { in: billIds },
            createdAt: { gte: new Date(Date.now() - RECENT_CHANGE_DAYS * DAY_MS) },
          },
          orderBy: { createdAt: 'desc' },
          // P1-08: `severity` is a real column and free to add here. `tone` is
          // NOT selected — it lives only inside the `evidence` JSON, and pulling
          // that whole column on the board read path is a cost this query does
          // not need; `toneForChange` derives it from the detector's own tables.
          select: {
            sourceRef: true,
            changeType: true,
            title: true,
            createdAt: true,
            severity: true,
          },
        }),
      ),
      // Phase 9: per-bill "discussed in N hearings" count from the linker's
      // `combined` alerts (tenant+client scoped; dismissed/snoozed excluded).
      this.prisma.withTenant(tenantId, (tx) =>
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
      const bill = billById.get(t.billId) ?? null;
      const latestActionText = bill?.latestActionText ?? t.lastSeenActionText ?? null;
      const latestActionDate = bill?.latestActionDate ?? t.lastSeenActionDate ?? null;
      const stage = (t.stage as BillStage | null) ?? billStage(latestActionText);
      const matchedTags = bill
        ? scoreBillFit(toRelevanceBill({ ...bill, id: t.billId }), topics, issueAreas, 0, false).matchedTags
        : [];
      // P0-06: from the SAME compiled topics — no extra query, no extra scoring pass.
      const hi = highPriorityMatches(matchedTags, topics);
      const card: BoardCard = {
        billId: t.billId,
        displayNum: this.displayNumFor(t.billId),
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
        // P2-09: the real status + a terminal-risk flag, so a failed rule never
        // renders as an ordinary card in whichever lane its stage maps to.
        canonicalStatus: this.canonicalStatusFor(
          t.billId,
          chipByBill.get(t.billId) ?? null,
          bill?.status,
          stage,
        ),
        terminalRisk: isTerminalRisk(chipByBill.get(t.billId)?.changeType),
        lastHearingSessionId: t.lastHearingSessionId ?? null,
        lastHearingAt: t.lastHearingAt ?? null,
        hearingCount: hearingCountByBill.get(t.billId) ?? 0,
        jurisdiction: this.jurisdictionFor(t.billId),
        trackedBy: t.trackedBy ?? null,
      };
      (colById.get(stage) ?? columns[0]!).cards.push(card);
    }
    return { columns, nextCursor, hasMore, total, withheld };
  }

  /**
   * LegiWatch v2 (L2b): the ALL-CLIENTS board roll-up — every client's tracked
   * bills in the same stage columns, each card labelled with its client (U4 /
   * Gherkin "All-clients board roll-up"). Tenant-scoped: every intel_* read goes
   * through `withTenant` (sets the RLS GUC — same as getBoard), so it returns
   * only this tenant's tracked bills + alerts. Change-chip and hearing
   * counts are keyed per (client, bill) since alerts are per-client; matchedTags
   * (the High-fit filter) use each card's OWN client's compiled watchlist,
   * batch-resolved per distinct client (bounded by client count, no per-row work).
   */
  async getTenantBoard(
    tenantId: string,
    opts: BoardQueryOpts = {},
  ): Promise<{
    columns: Array<{
      id: BillStage;
      label: string;
      cards: Array<BoardCard & { clientId: string; clientName: string | null }>;
    }>;
  } & BoardPage> {
    type Card = BoardCard & { clientId: string; clientName: string | null };
    const empty = () => BILL_STAGES.map((s) => ({ id: s.id, label: s.label, cards: [] as Card[] }));
    const take = Math.min(opts.limit ?? BOARD_PAGE_SIZE, BOARD_PAGE_SIZE_MAX);
    const cur = opts.cursor ? b64decode(opts.cursor) : null;

    // a-5: same dependent lookup as getBoard, tenant-wide (no clientId scope).
    let changedIds: Set<string> | null = null;
    if (opts.filters?.changedWithinDays) {
      const days = opts.filters.changedWithinDays;
      const rows = await this.prisma.withTenant(tenantId, (tx) =>
        tx.intelAlert.findMany({
          where: {
            tenantId,
            sourceType: { in: ['bill', 'state_bill'] },
            createdAt: { gte: new Date(Date.now() - days * DAY_MS) },
          },
          select: { sourceRef: true },
          distinct: ['sourceRef'],
        }),
      );
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
    const pageWhere: Record<string, unknown> = { ...baseWhere };
    if (cur) {
      pageWhere['OR'] = [
        { trackedAt: { lt: new Date(cur.t) } },
        { trackedAt: new Date(cur.t), billId: { lt: cur.id } },
      ];
    }

    const [tracked, total] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.trackedBill.findMany({
          where: pageWhere,
          orderBy: [{ trackedAt: 'desc' }, { billId: 'desc' }],
          take: take + 1,
        }),
      ),
      this.prisma.withTenant(tenantId, (tx) => tx.trackedBill.count({ where: baseWhere })),
    ]);
    const hasMore = tracked.length > take;
    const page = hasMore ? tracked.slice(0, take) : tracked;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeBoardCursor({ trackedAt: last.trackedAt, billId: last.billId }) : null;
    const withheld = Math.max(0, total - page.length);
    if (!page.length) return { columns: empty(), nextCursor, hasMore, total, withheld };

    const billIds = Array.from(new Set(page.map((t) => t.billId)));
    const clientIds = Array.from(new Set(page.map((t) => t.clientId)));
    const [bills, recentAlerts, hearingLinks, clientNames] = await Promise.all([
      this.fetchMergedBills(billIds),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.intelAlert.findMany({
          where: {
            tenantId,
            sourceType: { in: ['bill', 'state_bill'] },
            sourceRef: { in: billIds },
            createdAt: { gte: new Date(Date.now() - RECENT_CHANGE_DAYS * DAY_MS) },
          },
          orderBy: { createdAt: 'desc' },
          // P1-08: see getBoard — `severity` off the column, `tone` derived. The
          // evidence JSON is especially not worth pulling HERE: this roll-up is
          // unbounded by client count.
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
      this.prisma.withTenant(tenantId, (tx) =>
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
      this.repo.getClientNames(tenantId, clientIds).catch(() => new Map<string, string>()),
    ]);

    // a-6: per-client compiled watchlist (for matchedTags / the High-fit
    // filter), batch-resolved in a CONSTANT number of queries regardless of
    // client count — replaces the old one-`getCompiled`-call-per-client loop,
    // which was really 3 queries per client (watchlist + topics + terms via
    // getWatchlist). See compileTopicsForClients.
    const topicsByClient = await this.compileTopicsForClients(tenantId, clientIds);

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
      const bill = billById.get(t.billId) ?? null;
      const latestActionText = bill?.latestActionText ?? t.lastSeenActionText ?? null;
      const latestActionDate = bill?.latestActionDate ?? t.lastSeenActionDate ?? null;
      const stage = (t.stage as BillStage | null) ?? billStage(latestActionText);
      const ct = topicsByClient.get(t.clientId);
      const matchedTags =
        bill && ct
          ? scoreBillFit(toRelevanceBill({ ...bill, id: t.billId }), ct.topics, ct.issueAreas, 0, false).matchedTags
          : [];
      // P0-06: the `_all` roll-up already resolves each card's OWN client's compiled
      // watchlist above, so this adds no query (P1-18's batching is preserved).
      const hi = highPriorityMatches(matchedTags, ct?.topics ?? []);
      const card: Card = {
        billId: t.billId,
        displayNum: this.displayNumFor(t.billId),
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
        // P2-09: same treatment on the all-clients roll-up.
        canonicalStatus: this.canonicalStatusFor(
          t.billId,
          chipByCB.get(ck(t.clientId, t.billId)) ?? null,
          bill?.status,
          stage,
        ),
        terminalRisk: isTerminalRisk(chipByCB.get(ck(t.clientId, t.billId))?.changeType),
        lastHearingSessionId: t.lastHearingSessionId ?? null,
        lastHearingAt: t.lastHearingAt ?? null,
        hearingCount: hearingCountByCB.get(ck(t.clientId, t.billId)) ?? 0,
        jurisdiction: this.jurisdictionFor(t.billId),
        clientId: t.clientId,
        clientName: clientNames.get(t.clientId) ?? null,
        trackedBy: t.trackedBy ?? null,
      };
      (colById.get(stage) ?? columns[0]!).cards.push(card);
    }
    return { columns, nextCursor, hasMore, total, withheld };
  }

  /**
   * P1-18 (a-6): batch-resolve the compiled watchlist (for `matchedTags` / the
   * High-fit filter) for a SET of clients in a query count independent of
   * `clientIds.length` — 3 queries total (watchlist rows for issueAreas, all
   * topics, all terms), replacing a `getCompiled` call per client (itself 3
   * queries via `getWatchlist`). Faithfully replicates `getWatchlist`'s fold of
   * hearing-native FLAT terms (topicId NULL) into the reserved "Hearing terms"
   * topic (tracker-watchlist.service.ts:251-276) so a client with flat terms
   * scores identically to the per-client path.
   */
  private async compileTopicsForClients(
    tenantId: string,
    clientIds: string[],
  ): Promise<Map<string, { topics: CompiledTopicForFit[]; issueAreas: string[] }>> {
    const out = new Map<string, { topics: CompiledTopicForFit[]; issueAreas: string[] }>();
    if (!clientIds.length) return out;
    const watchlistIds = clientIds.map((c) => `wl:${c}`);

    const [watchlists, topics] = await this.prisma.withTenant(tenantId, (tx) =>
      Promise.all([
        tx.watchlist.findMany({
          where: { tenantId, clientId: { in: clientIds } },
          select: { clientId: true, issueAreas: true },
        }),
        tx.watchlistTopic.findMany({
          where: { tenantId, watchlistId: { in: watchlistIds } },
          select: {
            id: true,
            watchlistId: true,
            label: true,
            issueArea: true,
            position: true,
            priority: true,
          },
        }),
      ]),
    );
    const topicIds = topics.map((t) => t.id);
    const terms = await this.prisma.withTenant(tenantId, (tx) =>
      tx.watchlistTerm.findMany({
        where: {
          tenantId,
          watchlistId: { in: watchlistIds },
          OR: [...(topicIds.length ? [{ topicId: { in: topicIds } }] : []), { topicId: null }],
        },
        select: { watchlistId: true, topicId: true, termType: true, value: true, weight: true, id: true },
      }),
    );

    const issueAreasByClient = new Map(watchlists.map((w) => [w.clientId, w.issueAreas]));
    const topicsByWatchlist = new Map<string, typeof topics>();
    for (const t of topics) {
      const arr = topicsByWatchlist.get(t.watchlistId) ?? [];
      arr.push(t);
      topicsByWatchlist.set(t.watchlistId, arr);
    }
    const termsByTopicId = new Map<string, typeof terms>();
    const flatTermsByWatchlist = new Map<string, typeof terms>();
    for (const term of terms) {
      if (term.topicId) {
        const arr = termsByTopicId.get(term.topicId) ?? [];
        arr.push(term);
        termsByTopicId.set(term.topicId, arr);
      } else {
        const arr = flatTermsByWatchlist.get(term.watchlistId) ?? [];
        arr.push(term);
        flatTermsByWatchlist.set(term.watchlistId, arr);
      }
    }

    for (const clientId of clientIds) {
      const wlId = `wl:${clientId}`;
      const clientTopics = topicsByWatchlist.get(wlId) ?? [];
      const compilerTopics: CompilerTopic[] = clientTopics.map((t) => ({
        id: t.id,
        label: t.label,
        issueArea: t.issueArea,
        position: t.position,
        priority: t.priority,
      }));
      const compilerTerms: CompilerTerm[] = clientTopics.flatMap((t) =>
        (termsByTopicId.get(t.id) ?? []).map((term) => ({
          termType: term.termType,
          value: term.value,
          weight: term.weight,
          topicLabel: t.label,
          topicPriority: t.priority,
          termId: term.id,
        })),
      );
      // §4.3 fold — mirrors getWatchlist: merge flat terms into the existing
      // reserved-label topic if one exists, else synthesize it.
      const flat = flatTermsByWatchlist.get(wlId) ?? [];
      if (flat.length) {
        const host = clientTopics.find((t) => isReservedTopicLabel(t.label));
        const hostLabel = host?.label ?? HEARING_TERMS_TOPIC_LABEL;
        const hostPriority = host?.priority ?? 'med';
        if (!host) {
          compilerTopics.push({
            label: hostLabel,
            issueArea: null,
            position: 'monitor',
            priority: hostPriority,
          });
        }
        for (const term of flat) {
          compilerTerms.push({
            termType: term.termType,
            value: term.value,
            weight: term.weight,
            topicLabel: hostLabel,
            topicPriority: hostPriority,
            termId: term.id,
          });
        }
      }
      const compiled = compileWatchlist({
        issueAreas: issueAreasByClient.get(clientId) ?? [],
        topics: compilerTopics,
        terms: compilerTerms,
      });
      const topicsForFit: CompiledTopicForFit[] = compiled.billMatchSet.map((t) => ({
        id: t.id,
        label: t.label,
        issueArea: t.issueArea,
        priority: t.priority,
        position: t.position,
        keywords: t.keywords,
        synonyms: t.synonyms,
        entities: t.entities,
        riskPhrases: t.riskPhrases,
        routableTerms: t.routableTerms,
      }));
      out.set(clientId, { topics: topicsForFit, issueAreas: issueAreasByClient.get(clientId) ?? [] });
    }
    return out;
  }

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
  async getSummary(
    tenantId: string,
    clientId: string,
  ): Promise<{ boardCount: number; unread: number; hasWatchlist: boolean }> {
    const [rows, watchlist] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.trackedBill.findMany({
          where: { tenantId, clientId },
          select: { unread: true },
        }),
      ),
      // One row + a topic count in a single read; WatchlistTopic keys on
      // watchlistId, so counting through the relation avoids a second lookup.
      this.prisma.withTenant(tenantId, (tx) =>
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

  /**
   * Add-bill-modal text search (P1.1, ported from apps/api
   * tracker.service.searchBills). Current Congress only; <2 chars → []. Tenant-
   * independent by design (GLOBAL `congress_bill`; auth is the route guards).
   *
   * P1-17: this searched the federal corpus ONLY, while the modal's copy claimed
   * it searched the congressional record — so a client could enable state
   * jurisdictions, receive state recommendations, and still be unable to add a
   * state bill it had missed. It now searches both rails.
   *
   * `jurisdictions` semantics, matching the rest of LegiWatch: an EMPTY/absent
   * list means BOTH (federal + every state the caller passes nothing about),
   * `['US']` means federal only, and a list of state codes searches those states
   * (plus federal when 'US' is among them). Never "fix" an empty array to a
   * default list — MASTER §4.5.
   */
  async searchBills(
    q: string,
    opts: { jurisdictions?: string[]; limit?: number } = {},
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
      wantsFederal
        ? this.repo.searchBillRows(titleLike, idLike, currentCongress())
        : Promise.resolve([]),
      // With no jurisdictions named we cannot scan all 50 legislatures on a
      // 2-character query, so the state rail runs only when states are named.
      states.length
        ? this.stateRepo.searchStateBillRows(titleLike, idLike, states, limit)
        : Promise.resolve([]),
    ]);

    const out: BillSearchResult[] = federal.map((b) => ({
      billId: b.id,
      displayNum: humanizeBillId(b.id),
      title: b.title,
      stage: billStage(b.latestActionText),
      probability: passageProbability({
        latestActionText: b.latestActionText,
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

  private async trackCongressStage(
    billId: string,
  ): Promise<{ stage: BillStage; latestActionText: string | null; latestActionDate: Date | null }> {
    const bill = await this.repo.getBillById(billId);
    if (!bill) throw new NotFoundException(`Bill ${billId} not found`);
    return {
      stage: billStage(bill.latestActionText),
      latestActionText: bill.latestActionText,
      latestActionDate: bill.latestActionDate,
    };
  }

  private async trackStateStage(
    billId: string,
  ): Promise<{ stage: BillStage; latestActionText: string | null; latestActionDate: Date | null }> {
    const bill = await this.stateRepo.getStateBillById(billId);
    if (!bill) throw new NotFoundException(`Bill ${billId} not found`);
    return {
      stage: this.stateStatusToBoardStage(bill.status),
      latestActionText: bill.latestActionText,
      latestActionDate: bill.latestActionDate,
    };
  }

  /** Track a bill for a client (idempotent upsert). Verifies the bill exists. */
  async trackBill(
    tenantId: string,
    clientId: string,
    userId: string,
    billId: string,
    opts?: { note?: string | null; source?: string; isManual?: boolean },
  ) {
    // Cross-tenant guard (P1-03/P1-04): clientId is globally unique and RLS
    // alone does not prove CLIENT ownership within a tenant, so this must run
    // before any read or write below.
    await this.watchlists.assertClientInTenant(tenantId, clientId);
    // State Legislation Platform (S4.5): a DD1-shaped id ("tx-2025-hb1234")
    // routes to the state-bill lookup + status-rank stage bucketing instead
    // of the congress path. `opts?.source` is honored when given, but the id
    // shape is the authoritative signal — a caller passing a state key
    // without opts.source='state' still tracks correctly.
    const isState = isStateBillKey(billId) || opts?.source === 'state';
    const stage = isState
      ? await this.trackStateStage(billId)
      : await this.trackCongressStage(billId);
    const tb = await this.prisma.withTenant(tenantId, (tx) =>
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
    await this.prisma
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
  async untrackBill(tenantId: string, clientId: string, billId: string) {
    // Cross-tenant guard (P1-03/P1-04) — must run before the delete below.
    await this.watchlists.assertClientInTenant(tenantId, clientId);
    const res = await this.prisma.withTenant(tenantId, (tx) =>
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

    const res = await this.prisma.withTenant(tenantId, (tx) =>
      tx.trackedBill.updateMany({ where: { tenantId, clientId, billId }, data }),
    );
    if (!res.count) {
      throw new NotFoundException('CLIENT_BILL_NOT_TRACKED');
    }

    const row = await this.prisma.withTenant(tenantId, (tx) =>
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
    },
  ) {
    // Cross-tenant guard (P1-03/P1-04) — must run before the write below.
    await this.watchlists.assertClientInTenant(tenantId, clientId);
    if (!ALLOWED_FEEDBACK_SIGNALS.has(input.signal)) {
      throw new BadRequestException(`Unknown feedback signal "${input.signal}"`);
    }
    if (!input.targetRef?.trim()) throw new BadRequestException('targetRef is required');
    // Gate J (HP-06) a-7: input.alertId is optional and attacker-controlled body
    // input (not a path param) — previously written verbatim with no proof it
    // belongs to this client. Only validate when present; feedback on a bare
    // targetRef with no alertId is a legitimate, alert-less signal.
    if (input.alertId) {
      await this.watchlists.assertAlertInClient(tenantId, clientId, input.alertId);
    }
    await this.prisma.withTenant(tenantId, (tx) =>
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
   */
  async feedbackSignal(
    tenantId: string,
    clientId: string,
  ): Promise<Map<string, { total: number; byReason: Record<string, number> }>> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelFeedback.findMany({
        where: {
          tenantId,
          clientId,
          signal: 'marked_irrelevant',
          matchedTags: { isEmpty: false },
        },
        select: { matchedTags: true, reason: true },
      }),
    );
    const out = new Map<string, { total: number; byReason: Record<string, number> }>();
    for (const row of rows) {
      const reasonKey = row.reason ?? 'unspecified';
      for (const label of row.matchedTags) {
        const entry = out.get(label) ?? { total: 0, byReason: {} };
        entry.total += 1;
        entry.byReason[reasonKey] = (entry.byReason[reasonKey] ?? 0) + 1;
        out.set(label, entry);
      }
    }
    return out;
  }
}
