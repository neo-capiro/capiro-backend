import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * "Today" in EASTERN time, as a SQL expression — for comparing against
 * `committee_hearing.date`.
 *
 * `CURRENT_DATE` is the SESSION date, and this cluster's session timezone is UTC:
 * verified 2026-07-29 that the `timezone` parameter on the capiro-dev Aurora
 * cluster parameter group is `UTC` (source `system`), no `TZ` is set on any task
 * definition or in any Dockerfile, and nothing in the codebase issues a
 * `SET TIME ZONE` / `set_config('TimeZone', ...)`. So from 8 PM ET until
 * midnight, `CURRENT_DATE` was already TOMORROW and every "upcoming hearings"
 * read silently dropped the remainder of that evening's Eastern schedule.
 *
 * `committee_hearing.date` stores the hearing's Eastern calendar day, so the
 * comparison must be against the Eastern day as well. A constant rather than four
 * copies, because getting one of them wrong is invisible until 8 PM.
 *
 * Interpolating this is safe under the file's binding invariant: it is a
 * compile-time literal with no caller input.
 */
const ET_TODAY_SQL = `(CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date`;

/**
 * SourceDataRepository — the single, audited home for READ-ONLY cross-schema
 * access to apps/api-owned GLOBAL tables (`congress_bill`, its children, and
 * `context_embeddings`). Phase 1 of the tracker→intel-api migration.
 *
 * Invariants (enforced by review — see plan §4 S8):
 *  - READ-ONLY. This class MUST NEVER `$executeRaw*` / insert / update / delete
 *    an apps/api-owned table (decision D2). intel-api owns only `intel_*` tables.
 *  - All scalar params are bound (`$1,$2,…`). The only value ever interpolated
 *    is the pgvector literal, which is self-generated floats from
 *    `vectorLiteral()` (no injection surface — same rationale as the upstream
 *    embedder).
 *  - GLOBAL / NULL-tenant reads set no tenant context: `congress_bill*` are
 *    RLS-free globals, and `context_embeddings` bill rows are NULL-tenant (the
 *    RLS policy `tenant_id IS NULL OR tenant_id = current_tenant_id` admits
 *    them to a no-tenant session). Tenant-scoped reads (`clients`,
 *    `client_capabilities`) go through `withSystem` with an explicit bound
 *    tenant_id WHERE clause — see the tenant-scoped section at the bottom.
 *
 * The constructor takes `PrismaService` (a PrismaClient subclass), so Nest DI
 * injects it in the running app AND the one-off `task` runner can construct it
 * directly with `new SourceDataRepository(new PrismaService())`.
 */
export interface SourceBill {
  actionTexts?: string[];
  id: string;
  congress: number | null;
  billType: string | null;
  billNumber: string | null;
  title: string | null;
  latestActionText: string | null;
  latestActionDate: Date | null;
  policyArea: string | null;
  subjects: string[] | null;
  peCodes: string[] | null;
  url: string | null;
  // LegiWatch B: canonical status + text-version + cosponsor-count signals the
  // action-text watermark can't see (populated by the Workstream-A truth layer).
  status: string | null;
  statusAt: Date | null;
  updateDateIncludingText: Date | null;
  cosponsorsCount: number | null;
  /**
   * Gate K (HP-02, e-1): the `legislator`/`committee` term routes
   * (term-routing.ts) were consequently inert on the shadow-detector rail —
   * SourceBill carried neither field even though congress_bill.sponsor_name
   * and the normalized congress_bill_committee table have always had them
   * (getBillDossierIdentity/getBillCommittees already read them elsewhere).
   */
  sponsorName: string | null;
  committees: string[] | null;
}

export interface SourceBillAction {
  id: string;
  billId: string;
  date: Date;
  text: string;
  type: string | null;
  chamber: string | null;
}

// LegiWatch B derived-emitter read shapes.
export interface SourceFiscalNote {
  cboId: string;
  billId: string;
  title: string;
  description: string | null;
  cboUrl: string;
  pubDate: Date | null;
}
export interface SourceCosponsorMomentum {
  billId: string;
  liveCount: number;
  new7d: number;
  recentNames: string[] | null;
}
export interface SourceRuleVote {
  targetBillId: string;
  ruleBillId: string;
  chamber: string | null;
  rollNumber: number | null;
  result: string | null;
  yeas: number | null;
  nays: number | null;
  question: string | null;
  sourceUrl: string | null;
  voteDate: Date | null;
}
export interface SourceHearingForBill {
  billId: string;
  hearingId: string;
  title: string | null;
  committeeName: string | null;
  chamber: string | null;
  date: Date | null;
  url: string | null;
}

export interface SourceBillCommittee {
  committeeName: string;
  committeeCode: string | null;
  chamber: string | null;
}

export interface UpcomingCommitteeHearing {
  id: string;
  title: string | null;
  committeeName: string;
  chamber: string;
  date: Date;
  /** True UTC instant when the official time is known; null for date-only. */
  startsAt: Date | null;
  time: string | null;
  location: string | null;
  type: string | null;
  url: string | null;
  timezone?: string | null;
  visibility?: string | null;
}

export interface SemanticScore {
  sourceId: string;
  score: number;
}

export interface RecommendationBillRow {
  status?: string | null;
  actionTexts?: string[];
  id: string;
  title: string | null;
  latestActionText: string | null;
  latestActionDate: Date | null;
  subjects: string[] | null;
  policyArea: string | null;
  sponsorName: string | null;
  sponsorParty: string | null;
  cosponsorsCount: number | null;
  /** Gate K (HP-02, e-4): the `program_element` term route was consequently
   *  inert on the recommendations rail even though congress_bill.pe_codes
   *  has always existed (the shadow detector's SourceBill.peCodes reads it). */
  peCodes: string[] | null;
}

export interface BillSearchRow {
  status?: string | null;
  actionTexts?: string[];
  id: string;
  title: string | null;
  latestActionText: string | null;
  latestActionDate: Date | null;
}

export interface ClientProfileRow {
  name: string | null;
  sectorTag: string | null;
}

export interface ClientCapabilityRow {
  tags: unknown; // JSONB — string[] by convention, validated by the caller
  sector: string | null;
}

// ── Bill 360 dossier read shapes (Release R1, §1.1) ──────────────────────────
export interface SourceBillIdentity {
  id: string;
  congress: number | null;
  billType: string | null;
  billNumber: string | null;
  title: string | null;
  originChamber: string | null;
  sponsorName: string | null;
  introducedDate: Date | null;
  status: string | null;
  statusAt: Date | null;
  latestActionText: string | null;
  latestActionDate: Date | null;
  policyArea: string | null;
  url: string | null;
  lastSyncedAt: Date | null;
  updateDate: Date | null;
  updateDateIncludingText: Date | null;
}

export interface SourceBillVote {
  id: string;
  chamber: string | null;
  billId: string | null;
  question: string | null;
  result: string | null;
  voteType: string | null;
  voteDate: Date | null;
  yeas: number;
  nays: number;
  present: number;
  notVoting: number;
  sourceUrl: string | null;
}

export interface SourceMemberVoteTally {
  voteId: string;
  party: string | null;
  voteCast: string;
  count: number;
}

export interface SourceGoverningRule {
  ruleBillId: string;
  targetBillId: string;
  voteId: string | null;
  chamber: string | null;
  rollNumber: number | null;
  result: string | null;
  yeas: number | null;
  nays: number | null;
  question: string | null;
  sourceUrl: string | null;
  voteDate: Date | null;
}

export interface SourceBillFreshness {
  billId: string;
  lastSyncedAt: Date | null;
  updateDate: Date | null;
  updateDateIncludingText: Date | null;
  latestActionDate: Date | null;
}

export interface SourceBillProvision {
  provisionId: string;
  committee: string;
  fy: number;
  heading: string;
  text: string;
  pageStart: number | null;
  pageEnd: number | null;
  actionType: string | null;
  peCode: string | null;
  matchBasis: string | null;
  confidence: number | null;
  reviewStatus: string;
  /** Review state of the bill-to-PE edge that made this provision reachable. */
  billLinkStatus: string;
}

// ── Defense funding reads (Release R3, §3.5) — GLOBAL, read-only, bound params ──

/** One live funding_position for a bill, with its package context. */
export interface SourceFundingPosition {
  id: string;
  packageId: string;
  packageName: string;
  domain: string;
  vehicleId: string | null;
  vehicleLabel: string | null;
  vehicleTrack: string | null;
  vehicleStatus: string | null;
  fiscalYear: number;
  vehicleClass: string;
  stage: string;
  scope: string;
  amountMillions: string;
  effectiveDate: Date | null;
  sourceUrl: string | null;
  sourcePage: number | null;
  sourceDocumentTitle: string | null;
  sourceDocumentKey: string | null;
  sourceDocumentSha256: string | null;
  sourceDocumentCurrent: boolean | null;
  note: string | null;
  verificationStatus: string;
}

/** A PE line a bill touches, with the PE ladder for the package fiscal year. */
export interface SourceBillPeImpact {
  peCode: string;
  title: string | null;
  fiscalYear: number | null;
  vehicleTrack: string | null;
  vehicleStage: string | null;
  requestMillions: string | null;
  houseMillions: string | null;
  senateMillions: string | null;
  conferenceMillions: string | null;
  enactedMillions: string | null;
  requestSourceDocumentKey?: string | null;
  requestSourceDocumentSha256?: string | null;
  houseSourceDocumentKey?: string | null;
  houseSourceDocumentSha256?: string | null;
  senateSourceDocumentKey?: string | null;
  senateSourceDocumentSha256?: string | null;
  conferenceSourceDocumentKey?: string | null;
  conferenceSourceDocumentSha256?: string | null;
  enactedSourceDocumentKey?: string | null;
  enactedSourceDocumentSha256?: string | null;
  matchBasis: string;
  reviewStatus: string;
  confidence: number;
}

/** A sibling vehicle in the same budget package as the bill. */
export interface SourceRelatedVehicle {
  vehicleId: string;
  billId: string | null;
  label: string;
  track: string;
  stage: string;
  reportNumber: string | null;
  publicLaw: string | null;
  status: string;
}

/** The budget package a bill rides in. */
export interface SourceParentPackage {
  packageId: string;
  domain: string;
  fiscalYear: number;
  name: string;
  status: string;
  vehicleId: string;
  vehicleLabel: string;
  vehicleTrack: string;
  vehicleStage: string;
  vehicleStatus: string;
  vehicleChamber: string | null;
  sourceDocumentTitle: string | null;
  sourceDocumentKey: string | null;
  sourceDocumentSha256: string | null;
  sourceDocumentUrl: string | null;
  sourceDocumentCurrent: boolean | null;
}

/**
 * A recently-computed Program Element funding delta (R4 §4.3) — the atomic unit the
 * PE alert emitter fans out to clients whose watchlist names the PE.
 *
 * Read from the apps/api-owned `program_element_delta`, which the existing
 * compute-budget-deltas pipeline populates and supersedes. Only LIVE rows
 * (superseded_at IS NULL) are returned: a recomputed delta must not re-alert.
 */
export interface SourcePeDelta {
  deltaId: string;
  peCode: string;
  peTitle: string | null;
  assertedFy: number;
  deltaType: string;
  fromRef: string | null;
  toRef: string | null;
  amountFrom: string | null;
  amountTo: string | null;
  deltaAbs: string | null;
  deltaPct: number | null;
  explanation: string | null;
  materialityScore: number;
  computedAt: Date;
}

@Injectable()
export class SourceDataRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** One `congress_bill` row (GLOBAL) by its string id (e.g. "119-hr-1234"), or null. */
  async getBillById(id: string): Promise<SourceBill | null> {
    const rows = await this.prisma.$queryRawUnsafe<SourceBill[]>(
      `SELECT id,
              congress,
              bill_type          AS "billType",
              bill_number        AS "billNumber",
              title, status,
              ARRAY(SELECT a.text FROM congress_bill_action a WHERE a.bill_id = congress_bill.id) AS "actionTexts",
              latest_action_text AS "latestActionText",
              latest_action_date AS "latestActionDate",
              policy_area        AS "policyArea",
              subjects,
              pe_codes           AS "peCodes",
              url
         FROM congress_bill
        WHERE id = $1
        LIMIT 1`,
      id,
    );
    return rows[0] ?? null;
  }

  /**
   * All actions for a bill, newest-first (uses index [bill_id, date]). Pass
   * `limit` to cap the result (the Bill 360 dossier reads 50); omit for all rows
   * so existing detector callers keep their unbounded behavior.
   */
  async getBillActions(billId: string, limit?: number): Promise<SourceBillAction[]> {
    const cap = typeof limit === 'number' && limit > 0 ? Math.min(Math.floor(limit), 500) : null;
    const sql =
      `SELECT id,
              bill_id AS "billId",
              date,
              text,
              type,
              chamber
         FROM congress_bill_action
        WHERE bill_id = $1
        ORDER BY date DESC` + (cap !== null ? ' LIMIT $2' : '');
    return cap !== null
      ? this.prisma.$queryRawUnsafe<SourceBillAction[]>(sql, billId, cap)
      : this.prisma.$queryRawUnsafe<SourceBillAction[]>(sql, billId);
  }

  /** Subject tags for a bill. */
  async getBillSubjects(billId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM congress_bill_subject WHERE bill_id = $1`,
      billId,
    );
    return rows.map((r) => r.name);
  }

  /** Committee assignments for a bill. */
  async getBillCommittees(billId: string): Promise<SourceBillCommittee[]> {
    return this.prisma.$queryRawUnsafe<SourceBillCommittee[]>(
      `SELECT committee_name AS "committeeName",
              committee_code AS "committeeCode",
              chamber
         FROM congress_bill_committee
        WHERE bill_id = $1`,
      billId,
    );
  }

  // ── Bill 360 dossier reads (Release R1, §1.1) — GLOBAL, read-only, bound params ──

  /** Full dossier header for one `congress_bill` (status/chamber/freshness), or null. */
  async getBillDossierIdentity(billId: string): Promise<SourceBillIdentity | null> {
    const rows = await this.prisma.$queryRawUnsafe<SourceBillIdentity[]>(
      `SELECT id,
              congress,
              bill_type                  AS "billType",
              bill_number                AS "billNumber",
              title,
              origin_chamber             AS "originChamber",
              sponsor_name               AS "sponsorName",
              introduced_date            AS "introducedDate",
              status,
              status_at                  AS "statusAt",
              latest_action_text         AS "latestActionText",
              latest_action_date         AS "latestActionDate",
              policy_area                AS "policyArea",
              url,
              last_synced_at             AS "lastSyncedAt",
              update_date                AS "updateDate",
              update_date_including_text AS "updateDateIncludingText"
         FROM congress_bill
        WHERE id = $1
        LIMIT 1`,
      billId,
    );
    return rows[0] ?? null;
  }

  /** Chamber-level roll-call votes ON the bill itself, newest-first (index [bill_id]). */
  async getBillVotes(billId: string, limit?: number): Promise<SourceBillVote[]> {
    const cap = typeof limit === 'number' && limit > 0 ? Math.min(Math.floor(limit), 200) : null;
    const sql =
      `SELECT id,
              chamber,
              bill_id       AS "billId",
              question,
              result,
              vote_type     AS "voteType",
              vote_date     AS "voteDate",
              yeas,
              nays,
              present,
              not_voting    AS "notVoting",
              source_url    AS "sourceUrl"
         FROM roll_call_vote
        WHERE bill_id = $1
        ORDER BY vote_date DESC` + (cap !== null ? ' LIMIT $2' : '');
    return cap !== null
      ? this.prisma.$queryRawUnsafe<SourceBillVote[]>(sql, billId, cap)
      : this.prisma.$queryRawUnsafe<SourceBillVote[]>(sql, billId);
  }

  /**
   * Per-vote party tallies for a set of roll-call votes, aggregated in ONE query
   * (no N+1). Returns one row per (vote, party, cast) so callers can build a
   * Majority/Minority yea-nay breakdown without pulling every member row.
   */
  async getBillMemberVoteSummary(voteIds: string[]): Promise<SourceMemberVoteTally[]> {
    if (!voteIds.length) return [];
    return this.prisma.$queryRawUnsafe<SourceMemberVoteTally[]>(
      `SELECT vote_id     AS "voteId",
              party,
              vote_cast   AS "voteCast",
              count(*)::int AS count
         FROM member_vote
        WHERE vote_id = ANY($1::text[])
        GROUP BY vote_id, party, vote_cast`,
      voteIds,
    );
  }

  /**
   * The governing RULE(s) for a target bill + each rule's most recent roll-call
   * vote (GLOBAL `bill_rule_link` LEFT JOIN `roll_call_vote`). A rule is an hres
   * whose adoption/failure gates floor consideration of the target — its outcome
   * controls the displayed status even when the target bill has no vote of its
   * own. LEFT JOIN so a rule link with no recorded vote yet still returns.
   */
  async getGoverningRules(billId: string): Promise<SourceGoverningRule[]> {
    return this.prisma.$queryRawUnsafe<SourceGoverningRule[]>(
      `SELECT DISTINCT ON (l.rule_bill_id)
              l.rule_bill_id   AS "ruleBillId",
              l.target_bill_id AS "targetBillId",
              v.id             AS "voteId",
              v.chamber,
              v.roll_number    AS "rollNumber",
              v.result,
              v.yeas,
              v.nays,
              v.question,
              v.source_url     AS "sourceUrl",
              v.vote_date      AS "voteDate"
         FROM bill_rule_link l
         LEFT JOIN roll_call_vote v ON v.bill_id = l.rule_bill_id
        WHERE l.target_bill_id = $1
        ORDER BY l.rule_bill_id, v.vote_date DESC NULLS LAST`,
      billId,
    );
  }

  /** CBO cost estimates (the federal "fiscal note") for a bill, newest-first. */
  async getBillFiscalNotes(billId: string, limit?: number): Promise<SourceFiscalNote[]> {
    const cap = typeof limit === 'number' && limit > 0 ? Math.min(Math.floor(limit), 100) : null;
    const sql =
      `SELECT id        AS "cboId",
              bill_id    AS "billId",
              title,
              description,
              cbo_url    AS "cboUrl",
              pub_date   AS "pubDate"
         FROM cbo_cost_estimate
        WHERE bill_id = $1
        ORDER BY pub_date DESC` + (cap !== null ? ' LIMIT $2' : '');
    return cap !== null
      ? this.prisma.$queryRawUnsafe<SourceFiscalNote[]>(sql, billId, cap)
      : this.prisma.$queryRawUnsafe<SourceFiscalNote[]>(sql, billId);
  }

  /** Source-freshness signals for a bill (Congress.gov change stamps + our last sync). */
  async getBillSourceFreshness(billId: string): Promise<SourceBillFreshness | null> {
    const rows = await this.prisma.$queryRawUnsafe<SourceBillFreshness[]>(
      `SELECT id                         AS "billId",
              last_synced_at             AS "lastSyncedAt",
              update_date                AS "updateDate",
              update_date_including_text AS "updateDateIncludingText",
              latest_action_date         AS "latestActionDate"
         FROM congress_bill
        WHERE id = $1
        LIMIT 1`,
      billId,
    );
    return rows[0] ?? null;
  }

  /**
   * Committee-report provisions reachable from a bill through its PE links
   * (`bill_budget_line_link` pe_code → `provision_pe_link` → `committee_report_provision`).
   * Provisions are keyed by committee+FY (not a bill_id), so this is the only
   * bill-scoped path to them. CONSUMED IN R3 (defense_funding_intel); the R1
   * dossier keeps `funding.provisions` empty. Bounded, read-only.
   */
  async getBillReportsAndProvisions(billId: string, limit = 50): Promise<SourceBillProvision[]> {
    const cap = Math.min(Math.max(Math.floor(limit), 1), 200);
    return this.prisma.$queryRawUnsafe<SourceBillProvision[]>(
      `SELECT DISTINCT
              p.id::text     AS "provisionId",
              p.committee,
              p.fy,
              p.heading,
              p.text,
              p.page_start   AS "pageStart",
              p.page_end     AS "pageEnd",
              p.action_type  AS "actionType",
              ppl.pe_code    AS "peCode",
              ppl.match_basis AS "matchBasis",
              ppl.confidence,
              ppl.review_status AS "reviewStatus"
         FROM bill_budget_line_link bll
         JOIN provision_pe_link ppl ON ppl.pe_code = bll.pe_code
         JOIN committee_report_provision p ON p.id = ppl.provision_id
        WHERE bll.bill_id = $1
        ORDER BY p.fy DESC, p.committee
        LIMIT $2`,
      billId,
      cap,
    );
  }

  // ── Defense funding reads (Release R3, §3.5) ────────────────────────────────
  //
  // All five are GLOBAL, read-only, bound-parameter, and bounded. intel-api NEVER
  // writes budget_package / funding_position — the curated loader and the parsers in
  // apps/api own every write.

  /**
   * LIVE funding positions for a bill (superseded rows excluded — those are audit
   * history, exposed by the apps/api package-history endpoint, not the dossier).
   * Joined to the package so every row carries its fiscal year and domain, and to
   * the vehicle so the UI can label which vehicle asserted the figure.
   */
  async getBillFundingPositions(billId: string, limit = 50): Promise<SourceFundingPosition[]> {
    const cap = Math.min(Math.max(Math.floor(limit), 1), 200);
    return this.prisma.$queryRawUnsafe<SourceFundingPosition[]>(
      `WITH current_vehicle AS (
              SELECT v.id,
                     v.package_id,
                     bp.fiscal_year
                FROM budget_package_vehicle v
                JOIN budget_package bp ON bp.id = v.package_id
               WHERE v.bill_id = $1
               ORDER BY bp.fiscal_year DESC,
                        CASE v.stage
                          WHEN 'enacted' THEN 5
                          WHEN 'conference' THEN 4
                          WHEN 'senate' THEN 3
                          WHEN 'house' THEN 2
                          WHEN 'president' THEN 1
                          ELSE 0
                        END DESC,
                        v.updated_at DESC
               LIMIT 1
            )
       SELECT fp.id,
              fp.package_id          AS "packageId",
              bp.name                AS "packageName",
              bp.domain,
              fp.vehicle_id          AS "vehicleId",
              v.label                AS "vehicleLabel",
              v.track                AS "vehicleTrack",
              v.status               AS "vehicleStatus",
              fp.fiscal_year         AS "fiscalYear",
              fp.vehicle_class       AS "vehicleClass",
              fp.stage,
              fp.scope,
              fp.amount_millions::text AS "amountMillions",
              fp.effective_date      AS "effectiveDate",
              COALESCE(fp.source_url, v.source_url, sd.source_url) AS "sourceUrl",
              fp.source_page         AS "sourcePage",
              sd.title               AS "sourceDocumentTitle",
              sd.source_key          AS "sourceDocumentKey",
              sd.sha256              AS "sourceDocumentSha256",
              CASE
                WHEN sd.id IS NULL THEN NULL
                ELSE sd.superseded_by_document_id IS NULL
              END                    AS "sourceDocumentCurrent",
              fp.note,
              fp.verification_status AS "verificationStatus"
         FROM current_vehicle cv
         JOIN funding_position fp
           ON fp.package_id = cv.package_id
          AND fp.fiscal_year = cv.fiscal_year
         JOIN budget_package bp ON bp.id = fp.package_id
         LEFT JOIN budget_package_vehicle v ON v.id = fp.vehicle_id
         LEFT JOIN source_document sd
                ON sd.id = COALESCE(fp.source_document_id, v.source_document_id)
        WHERE fp.verification_status <> 'superseded'
          AND (
            fp.vehicle_id = cv.id OR
            fp.bill_id = $1 OR
            fp.vehicle_class = 'request'
          )
        ORDER BY fp.fiscal_year DESC,
                 CASE WHEN fp.vehicle_id = cv.id THEN 0 WHEN fp.vehicle_class = 'request' THEN 1 ELSE 2 END,
                 fp.scope,
                 fp.stage
        LIMIT $2`,
      billId,
      cap,
    );
  }

  /**
   * Program Element / procurement lines this bill touches, with the PE ladder for
   * the fiscal year AND track of the bill's own budget-package vehicle. An NDAA
   * vehicle reads request/HASC/SASC/NDAA-conference; an appropriations vehicle reads
   * request/HAC-D/SAC-D/appropriations-conference/enacted. Unknown tracks fail
   * closed with null chamber marks instead of silently substituting another track.
   *
   * Rejected links are excluded; candidate links are returned WITH their review
   * status so the UI can label an inferred match rather than present it as fact.
   */
  async getBillProgramElementImpacts(billId: string, limit = 100): Promise<SourceBillPeImpact[]> {
    const cap = Math.min(Math.max(Math.floor(limit), 1), 300);
    return this.prisma.$queryRawUnsafe<SourceBillPeImpact[]>(
      `WITH current_vehicle AS (
              SELECT v.id,
                     v.package_id,
                     bp.fiscal_year,
                     v.track,
                     v.stage,
                     v.source_document_id
                FROM budget_package_vehicle v
                JOIN budget_package bp ON bp.id = v.package_id
               WHERE v.bill_id = $1
               ORDER BY bp.fiscal_year DESC,
                        CASE v.stage
                          WHEN 'enacted' THEN 5
                          WHEN 'conference' THEN 4
                          WHEN 'senate' THEN 3
                          WHEN 'house' THEN 2
                          WHEN 'president' THEN 1
                          ELSE 0
                        END DESC,
                        v.updated_at DESC
               LIMIT 1
            ),
            request_vehicle AS (
              SELECT v.source_document_id
                FROM current_vehicle cv
                JOIN budget_package_vehicle v ON v.package_id = cv.package_id
               WHERE v.track = 'request'
                 AND v.stage = 'president'
               ORDER BY v.updated_at DESC
               LIMIT 1
            ),
            house_vehicle AS (
              SELECT v.source_document_id
                FROM current_vehicle cv
                JOIN budget_package_vehicle v ON v.package_id = cv.package_id
               WHERE v.track = cv.track
                 AND v.stage = 'house'
               ORDER BY CASE WHEN v.id = cv.id THEN 0 ELSE 1 END, v.updated_at DESC
               LIMIT 1
            ),
            senate_vehicle AS (
              SELECT v.source_document_id
                FROM current_vehicle cv
                JOIN budget_package_vehicle v ON v.package_id = cv.package_id
               WHERE v.track = cv.track
                 AND v.stage = 'senate'
               ORDER BY CASE WHEN v.id = cv.id THEN 0 ELSE 1 END, v.updated_at DESC
               LIMIT 1
            ),
            conference_vehicle AS (
              SELECT v.source_document_id
                FROM current_vehicle cv
                JOIN budget_package_vehicle v ON v.package_id = cv.package_id
               WHERE v.track = cv.track
                 AND v.stage = 'conference'
               ORDER BY CASE WHEN v.id = cv.id THEN 0 ELSE 1 END, v.updated_at DESC
               LIMIT 1
            ),
            enacted_vehicle AS (
              SELECT v.source_document_id
                FROM current_vehicle cv
                JOIN budget_package_vehicle v ON v.package_id = cv.package_id
               WHERE v.track = cv.track
                 AND v.stage = 'enacted'
               ORDER BY CASE WHEN v.id = cv.id THEN 0 ELSE 1 END, v.updated_at DESC
               LIMIT 1
            )
       SELECT l.pe_code                 AS "peCode",
              pe.title,
              cv.fiscal_year             AS "fiscalYear",
              cv.track                  AS "vehicleTrack",
              cv.stage                  AS "vehicleStage",
              req.amount                 AS "requestMillions",
              house.amount               AS "houseMillions",
              senate.amount              AS "senateMillions",
              conference.amount          AS "conferenceMillions",
              enacted.amount             AS "enactedMillions",
              req.source_key              AS "requestSourceDocumentKey",
              req.sha256                  AS "requestSourceDocumentSha256",
              house.source_key            AS "houseSourceDocumentKey",
              house.sha256                AS "houseSourceDocumentSha256",
              senate.source_key           AS "senateSourceDocumentKey",
              senate.sha256               AS "senateSourceDocumentSha256",
              conference.source_key       AS "conferenceSourceDocumentKey",
              conference.sha256           AS "conferenceSourceDocumentSha256",
              enacted.source_key          AS "enactedSourceDocumentKey",
              enacted.sha256              AS "enactedSourceDocumentSha256",
              l.link_type               AS "matchBasis",
              l.status                  AS "reviewStatus",
              l.confidence
         FROM bill_budget_line_link l
         LEFT JOIN current_vehicle cv ON TRUE
         LEFT JOIN request_vehicle rv ON TRUE
         LEFT JOIN house_vehicle hv ON TRUE
         LEFT JOIN senate_vehicle sv ON TRUE
         LEFT JOIN conference_vehicle cfv ON TRUE
         LEFT JOIN enacted_vehicle ev ON TRUE
         LEFT JOIN program_element pe ON pe.pe_code = l.pe_code
         LEFT JOIN LATERAL (
           SELECT COALESCE(v.canonical_value_m, v.value_decimal)::text AS amount,
                  sd.source_key,
                  sd.sha256
             FROM program_element_year_source_value v
             JOIN source_document sd ON sd.id = v.source_document_id
            WHERE v.pe_code = l.pe_code
              AND v.fy = cv.fiscal_year
              AND v.field_name = 'request'
              AND v.source_document_id IN (cv.source_document_id, rv.source_document_id)
            ORDER BY CASE WHEN v.source_document_id = cv.source_document_id THEN 0 ELSE 1 END,
                     v.last_observed_at DESC
            LIMIT 1
         ) req ON TRUE
         LEFT JOIN LATERAL (
           SELECT COALESCE(v.canonical_value_m, v.value_decimal)::text AS amount,
                  sd.source_key,
                  sd.sha256
             FROM program_element_year_source_value v
             JOIN source_document sd ON sd.id = v.source_document_id
            WHERE v.pe_code = l.pe_code
              AND v.fy = cv.fiscal_year
              AND v.field_name = CASE cv.track
                    WHEN 'authorization' THEN 'hascMark'
                    WHEN 'appropriation' THEN 'hacDMark'
                    ELSE '__unsupported__'
                  END
              AND v.source_document_id = hv.source_document_id
              AND cv.stage IN ('house', 'senate', 'conference', 'enacted')
            ORDER BY v.last_observed_at DESC
            LIMIT 1
         ) house ON TRUE
         LEFT JOIN LATERAL (
           SELECT COALESCE(v.canonical_value_m, v.value_decimal)::text AS amount,
                  sd.source_key,
                  sd.sha256
             FROM program_element_year_source_value v
             JOIN source_document sd ON sd.id = v.source_document_id
            WHERE v.pe_code = l.pe_code
              AND v.fy = cv.fiscal_year
              AND v.field_name = CASE cv.track
                    WHEN 'authorization' THEN 'sascMark'
                    WHEN 'appropriation' THEN 'sacDMark'
                    ELSE '__unsupported__'
                  END
              AND v.source_document_id = sv.source_document_id
              AND cv.stage IN ('senate', 'conference', 'enacted')
            ORDER BY v.last_observed_at DESC
            LIMIT 1
         ) senate ON TRUE
         LEFT JOIN LATERAL (
           SELECT COALESCE(v.canonical_value_m, v.value_decimal)::text AS amount,
                  sd.source_key,
                  sd.sha256
             FROM program_element_year_source_value v
             JOIN source_document sd ON sd.id = v.source_document_id
            WHERE v.pe_code = l.pe_code
              AND v.fy = cv.fiscal_year
              AND v.field_name = CASE cv.track
                    WHEN 'authorization' THEN 'ndaaConference'
                    WHEN 'appropriation' THEN 'conference'
                    ELSE '__unsupported__'
                  END
              AND v.source_document_id = cfv.source_document_id
              AND cv.stage IN ('conference', 'enacted')
            ORDER BY v.last_observed_at DESC
            LIMIT 1
         ) conference ON TRUE
         LEFT JOIN LATERAL (
           SELECT COALESCE(v.canonical_value_m, v.value_decimal)::text AS amount,
                  sd.source_key,
                  sd.sha256
             FROM program_element_year_source_value v
             JOIN source_document sd ON sd.id = v.source_document_id
            WHERE v.pe_code = l.pe_code
              AND v.fy = cv.fiscal_year
              AND v.field_name = 'enacted'
              AND v.source_document_id = ev.source_document_id
              AND cv.track = 'appropriation'
              AND cv.stage = 'enacted'
            ORDER BY v.last_observed_at DESC
            LIMIT 1
         ) enacted ON TRUE
        WHERE l.bill_id = $1
          AND l.status <> 'rejected'
        ORDER BY l.confidence DESC, l.pe_code
        LIMIT $2`,
      billId,
      cap,
    );
  }

  /**
   * The OTHER vehicles in the same budget package — the authorization,
   * appropriations, conference, CR, and enacted siblings a reader needs in order to
   * see where this bill sits in the cycle. Excludes the bill's own vehicles.
   */
  async getRelatedBudgetVehicles(billId: string, limit = 25): Promise<SourceRelatedVehicle[]> {
    const cap = Math.min(Math.max(Math.floor(limit), 1), 100);
    return this.prisma.$queryRawUnsafe<SourceRelatedVehicle[]>(
      `SELECT sib.id            AS "vehicleId",
              sib.bill_id       AS "billId",
              sib.label,
              sib.track,
              sib.stage,
              sib.report_number AS "reportNumber",
              sib.public_law    AS "publicLaw",
              sib.status
         FROM budget_package_vehicle self
         JOIN budget_package_vehicle sib ON sib.package_id = self.package_id
        WHERE self.bill_id = $1
          AND (sib.bill_id IS DISTINCT FROM $1)
        ORDER BY sib.track, sib.stage, sib.label
        LIMIT $2`,
      billId,
      cap,
    );
  }

  /**
   * Committee-report provisions reachable from a bill that describe a FUNDING action
   * (adds / cuts / transfers / restricts). A narrower view of
   * {@link getBillReportsAndProvisions} for the dossier's Provisions tab, so
   * briefing-direction language does not crowd out dollar movements.
   */
  async getBillFundingProvisions(billId: string, limit = 50): Promise<SourceBillProvision[]> {
    const cap = Math.min(Math.max(Math.floor(limit), 1), 200);
    return this.prisma.$queryRawUnsafe<SourceBillProvision[]>(
      `WITH current_vehicle AS (
              SELECT bp.fiscal_year,
                     v.track,
                     v.stage,
                     v.source_document_id
                FROM budget_package_vehicle v
                JOIN budget_package bp ON bp.id = v.package_id
               WHERE v.bill_id = $1
               ORDER BY bp.fiscal_year DESC,
                        CASE v.stage
                          WHEN 'enacted' THEN 5
                          WHEN 'conference' THEN 4
                          WHEN 'senate' THEN 3
                          WHEN 'house' THEN 2
                          WHEN 'president' THEN 1
                          ELSE 0
                        END DESC,
                        v.updated_at DESC
               LIMIT 1
            )
       SELECT DISTINCT
              p.id::text        AS "provisionId",
              p.committee,
              p.fy,
              p.heading,
              p.text,
              p.page_start      AS "pageStart",
              p.page_end        AS "pageEnd",
              p.action_type     AS "actionType",
              ppl.pe_code       AS "peCode",
              ppl.match_basis   AS "matchBasis",
              ppl.confidence,
              ppl.review_status AS "reviewStatus",
              bll.status        AS "billLinkStatus"
         FROM bill_budget_line_link bll
         JOIN provision_pe_link ppl ON ppl.pe_code = bll.pe_code
         JOIN committee_report_provision p ON p.id = ppl.provision_id
         JOIN current_vehicle cv ON TRUE
        WHERE bll.bill_id = $1
          AND p.fy = cv.fiscal_year
          AND (
            (cv.track = 'authorization' AND (
              (cv.stage = 'house' AND p.committee = 'HASC') OR
              (cv.stage = 'senate' AND p.committee = 'SASC') OR
              (cv.stage IN ('conference', 'enacted') AND p.committee = 'CONF')
            )) OR
            (cv.track = 'appropriation' AND (
              (cv.stage = 'house' AND p.committee = 'HAC-D') OR
              (cv.stage = 'senate' AND p.committee = 'SAC-D') OR
              (cv.stage IN ('conference', 'enacted') AND p.committee = 'CONF')
            ))
          )
          AND (
            cv.source_document_id IS NULL OR
            p.source_document_id IS NULL OR
            p.source_document_id = cv.source_document_id
          )
          AND bll.status <> 'rejected'
          AND p.action_type IN ('adds', 'cuts', 'transfers', 'restricts')
        ORDER BY p.fy DESC, p.committee
        LIMIT $2`,
      billId,
      cap,
    );
  }

  /**
   * LIVE Program Element deltas computed within the window, most material first
   * (R4 §4.3). Superseded rows are excluded so a recompute never re-alerts, and a
   * materiality floor keeps rounding noise out of the client feed.
   */
  async getRecentPeDeltas(
    windowHours: number,
    materialityFloor = 0.3,
    limit = 200,
  ): Promise<SourcePeDelta[]> {
    const cap = Math.min(Math.max(Math.floor(limit), 1), 1000);
    const hours = Math.min(Math.max(Math.floor(windowHours), 1), 24 * 90);
    return this.prisma.$queryRawUnsafe<SourcePeDelta[]>(
      `SELECT d.id::text          AS "deltaId",
              d.pe_code           AS "peCode",
              pe.title            AS "peTitle",
              d.asserted_fy       AS "assertedFy",
              d.delta_type        AS "deltaType",
              d.from_ref          AS "fromRef",
              d.to_ref            AS "toRef",
              d.amount_from::text AS "amountFrom",
              d.amount_to::text   AS "amountTo",
              d.delta_abs::text   AS "deltaAbs",
              d.delta_pct         AS "deltaPct",
              d.explanation,
              d.materiality_score AS "materialityScore",
              d.computed_at       AS "computedAt"
         FROM program_element_delta d
         LEFT JOIN program_element pe ON pe.pe_code = d.pe_code
        WHERE d.superseded_at IS NULL
          AND d.computed_at >= now() - ($1 || ' hours')::interval
          AND d.materiality_score >= $2
        ORDER BY d.materiality_score DESC, d.computed_at DESC
        LIMIT $3`,
      String(hours),
      materialityFloor,
      cap,
    );
  }

  /** The budget package a bill rides in (newest fiscal year wins), or null. */
  async getParentBudgetPackage(billId: string): Promise<SourceParentPackage | null> {
    const rows = await this.prisma.$queryRawUnsafe<SourceParentPackage[]>(
      `SELECT bp.id          AS "packageId",
              bp.domain,
              bp.fiscal_year AS "fiscalYear",
              bp.name,
              bp.status,
              v.id           AS "vehicleId",
              v.label        AS "vehicleLabel",
              v.track        AS "vehicleTrack",
              v.stage        AS "vehicleStage",
              v.status       AS "vehicleStatus",
              v.chamber      AS "vehicleChamber",
              sd.title       AS "sourceDocumentTitle",
              sd.source_key  AS "sourceDocumentKey",
              sd.sha256      AS "sourceDocumentSha256",
              COALESCE(v.source_url, sd.source_url) AS "sourceDocumentUrl",
              CASE
                WHEN sd.id IS NULL THEN NULL
                ELSE sd.superseded_by_document_id IS NULL
              END            AS "sourceDocumentCurrent"
         FROM budget_package_vehicle v
         JOIN budget_package bp ON bp.id = v.package_id
         LEFT JOIN source_document sd ON sd.id = v.source_document_id
        WHERE v.bill_id = $1
        ORDER BY bp.fiscal_year DESC,
                 CASE v.stage
                   WHEN 'enacted' THEN 5
                   WHEN 'conference' THEN 4
                   WHEN 'senate' THEN 3
                   WHEN 'house' THEN 2
                   WHEN 'president' THEN 1
                   ELSE 0
                 END DESC,
                 v.updated_at DESC
        LIMIT 1`,
      billId,
    );
    return rows[0] ?? null;
  }

  /**
   * Cosine-rank the GLOBAL bill embeddings against a query vector.
   *
   * `queryVectorLiteral` MUST be the output of `vectorLiteral(await embedText(q))`
   * (a `[v0,…,v1023]` string). It is bound as `$1` and cast to `::vector`; no
   * value is string-interpolated. Ported verbatim from the live tracker's
   * `semanticScores` (apps/api tracker.service.ts) — bills are stored under
   * `source_type = 'bill'`.
   */
  async semanticBillScores(
    queryVectorLiteral: string,
    model: string,
    floor: number,
  ): Promise<SemanticScore[]> {
    const rows = await this.prisma.$queryRawUnsafe<SemanticScore[]>(
      `SELECT ce.source_id AS "sourceId",
              (1 - (ce.embedding <=> $1::vector))::float8 AS score
         FROM context_embeddings ce
        WHERE ce.source_type = 'bill' AND ce.model = $2
          AND ce.embedding IS NOT NULL
          AND (1 - (ce.embedding <=> $1::vector)) >= $3
        ORDER BY ce.embedding <=> $1::vector
        LIMIT 400`,
      queryVectorLiteral,
      model,
      floor,
    );
    return rows;
  }

  /**
   * Batch-read GLOBAL `congress_bill` rows by id (for the shadow change
   * detector). Gate K (HP-02, e-1): LEFT JOIN congress_bill_committee
   * (array_agg, same aggregation pattern as getCosponsorMomentum below) so
   * the `committee` term route has a real field to match against — mirrors
   * the per-bill getBillCommittees() shape (committeeName), just batched.
   */
  async getBillsByIds(ids: string[]): Promise<SourceBill[]> {
    if (!ids.length) return [];
    return this.prisma.$queryRawUnsafe<SourceBill[]>(
      `SELECT cb.id,
              cb.congress,
              cb.bill_type          AS "billType",
              cb.bill_number        AS "billNumber",
              cb.title,
              ARRAY(SELECT a.text FROM congress_bill_action a WHERE a.bill_id = cb.id) AS "actionTexts",
              cb.latest_action_text AS "latestActionText",
              cb.latest_action_date AS "latestActionDate",
              cb.policy_area        AS "policyArea",
              cb.subjects,
              cb.pe_codes           AS "peCodes",
              cb.url,
              cb.status,
              cb.status_at                    AS "statusAt",
              cb.update_date_including_text   AS "updateDateIncludingText",
              cb.cosponsors_count             AS "cosponsorsCount",
              cb.sponsor_name                 AS "sponsorName",
              c.committee_names               AS "committees"
         FROM congress_bill cb
         LEFT JOIN (
           SELECT bill_id, array_agg(DISTINCT committee_name) AS committee_names
             FROM congress_bill_committee
            WHERE bill_id = ANY($1::text[])
            GROUP BY bill_id
         ) c ON c.bill_id = cb.id
        WHERE cb.id = ANY($1::text[])`,
      ids,
    );
  }

  /**
   * LegiWatch B7 — CBO cost estimates for the given bills seen at/after a
   * watermark (GLOBAL `cbo_cost_estimate`, populated by apps/api sync-cbo). Read
   * only; intel-api never writes it. billId is nullable upstream (RSS rows may
   * lack it) — those can't join and are excluded by the `= ANY` filter.
   */
  async getNewFiscalNotes(billIds: string[], sinceIso: string): Promise<SourceFiscalNote[]> {
    if (!billIds.length) return [];
    return this.prisma.$queryRawUnsafe<SourceFiscalNote[]>(
      `SELECT id            AS "cboId",
              bill_id        AS "billId",
              title,
              description,
              cbo_url        AS "cboUrl",
              pub_date       AS "pubDate"
         FROM cbo_cost_estimate
        WHERE bill_id = ANY($1::text[])
          AND last_synced_at >= $2::timestamptz
        ORDER BY pub_date DESC`,
      billIds,
      sinceIso,
    );
  }

  /**
   * LegiWatch B8 — cosponsor-momentum snapshot: current live cosponsor count +
   * the count/names added within the last `days` (GLOBAL
   * `congress_bill_cosponsor`, sponsorshipDate time series; withdrawn excluded).
   * Rows with a null sponsorship_date can't be windowed (excluded from new7d).
   */
  async getCosponsorMomentum(billIds: string[], days: number): Promise<SourceCosponsorMomentum[]> {
    if (!billIds.length) return [];
    return this.prisma.$queryRawUnsafe<SourceCosponsorMomentum[]>(
      `SELECT bill_id AS "billId",
              count(*) FILTER (WHERE withdrawn_date IS NULL)::int AS "liveCount",
              count(*) FILTER (
                WHERE withdrawn_date IS NULL
                  AND sponsorship_date >= (CURRENT_DATE - ($2::int))
              )::int AS "new7d",
              (array_agg(full_name || ' (' || COALESCE(party,'?') || ')'
                         ORDER BY sponsorship_date DESC)
                 FILTER (WHERE withdrawn_date IS NULL
                           AND sponsorship_date >= (CURRENT_DATE - ($2::int)))
              )[1:10] AS "recentNames"
         FROM congress_bill_cosponsor
        WHERE bill_id = ANY($1::text[])
        GROUP BY bill_id`,
      billIds,
      days,
    );
  }

  /**
   * LegiWatch B5 — the governing RULE for each target bill + that rule's most
   * recent roll-call vote, so a rule_failed/rule_adopted alert can cite the roll
   * number + tally (GLOBAL `bill_rule_link` + `roll_call_vote`). Latest rule vote
   * per target.
   */
  async getGoverningRuleVotes(targetBillIds: string[]): Promise<SourceRuleVote[]> {
    if (!targetBillIds.length) return [];
    return this.prisma.$queryRawUnsafe<SourceRuleVote[]>(
      `SELECT DISTINCT ON (l.target_bill_id)
              l.target_bill_id AS "targetBillId",
              l.rule_bill_id   AS "ruleBillId",
              v.chamber,
              v.roll_number    AS "rollNumber",
              v.result,
              v.yeas,
              v.nays,
              v.question,
              v.source_url     AS "sourceUrl",
              v.vote_date      AS "voteDate"
         FROM bill_rule_link l
         JOIN roll_call_vote v ON v.bill_id = l.rule_bill_id
        WHERE l.target_bill_id = ANY($1::text[])
        ORDER BY l.target_bill_id, v.vote_date DESC`,
      targetBillIds,
    );
  }

  /**
   * LegiWatch B3 — upcoming committee hearings that list one of the given bills
   * on their agenda (GLOBAL `committee_hearing_bill` link + `committee_hearing`),
   * today or later. The link table is populated by apps/api `sync-hearings` from
   * the committee-meeting detail's agenda items. Returns [] (resiliently) if the
   * link table doesn't exist yet — a cross-app table this repo reads but never
   * creates (decision D2); deploy the apps/api migration first.
   */
  async getUpcomingHearingsForBills(billIds: string[]): Promise<SourceHearingForBill[]> {
    if (!billIds.length) return [];
    try {
      return await this.prisma.$queryRawUnsafe<SourceHearingForBill[]>(
        `SELECT hb.bill_id        AS "billId",
                h.id              AS "hearingId",
                h.title,
                h.committee_name  AS "committeeName",
                h.chamber,
                h.date,
                h.url
           FROM committee_hearing_bill hb
           JOIN federal_committee_hearing h ON h.id = hb.hearing_id
          WHERE hb.bill_id = ANY($1::text[])
            AND h.date >= ${ET_TODAY_SQL}
          ORDER BY h.date ASC`,
        billIds,
      );
    } catch (e) {
      // undefined_table (42P01): the apps/api migration that creates
      // committee_hearing_bill hasn't landed yet. Prisma wraps a raw-query DB
      // error as PrismaClientKnownRequestError code 'P2010' with the Postgres
      // SQLSTATE at `.meta.code` — so check both places (and the message) rather
      // than only `.code`, or the guard never matches and the whole detection
      // cycle throws before the table exists.
      const err = e as { code?: string; meta?: { code?: unknown }; message?: string };
      const isUndefinedTable =
        err.code === '42P01' ||
        (err.meta && (err.meta as { code?: unknown }).code === '42P01') ||
        /relation ".*" does not exist|42P01|undefined_table/i.test(err.message ?? '');
      if (isUndefinedTable) return [];
      throw e;
    }
  }

  /** Batch-read GLOBAL `congress_bill_action` rows for many bills, oldest-first (catch-up). */
  async getBillActionsByIds(ids: string[]): Promise<SourceBillAction[]> {
    if (!ids.length) return [];
    return this.prisma.$queryRawUnsafe<SourceBillAction[]>(
      `SELECT id,
              bill_id AS "billId",
              date,
              text,
              type,
              chamber
         FROM congress_bill_action
        WHERE bill_id = ANY($1::text[])
        ORDER BY date ASC`,
      ids,
    );
  }

  /**
   * Forward-looking committee-hearing schedule (GLOBAL `committee_hearing`,
   * populated daily by apps/api `sync-hearings`). Today or later, soonest first.
   *
   * This is the ENRICHED store: apps/api fans out the Congress.gov list stubs to
   * the per-meeting detail endpoint and resolves committee systemCode→name, so
   * `title`/`committee_name`/`date`/`time`/`type`/`location`/`url` are all real —
   * unlike the raw list endpoint (which carries only eventId/chamber/url and made
   * every Upcoming row collapse to the same "Committee meeting"/now). RLS-free
   * reference table, same as `congress_bill`; READ-ONLY.
   */
  async getUpcomingCommitteeHearings(limit: number): Promise<UpcomingCommitteeHearing[]> {
    return this.prisma.$queryRawUnsafe<UpcomingCommitteeHearing[]>(
      `SELECT id,
              title,
              committee_name AS "committeeName",
              chamber,
              date,
              starts_at AS "startsAt",
              time,
              location,
              type,
              url,
              "timezone",
              visibility::text AS visibility
         FROM federal_committee_hearing
        WHERE date >= ${ET_TODAY_SQL}
        ORDER BY date ASC, committee_name ASC
        LIMIT $1`,
      limit,
    );
  }

  /**
   * Browse the FULL committee-hearing corpus (GLOBAL `committee_hearing`), not
   * just the forward window. Powers the "all available hearings" view: the
   * Upcoming feed only surfaces `date >= today` (a handful during a recess),
   * while the table holds thousands of enriched rows (past + scheduled). Search
   * matches title/committee (ILIKE, bound), chamber filters exactly, and `scope`
   * selects the time window. Returns a page + the total for pagination. READ-ONLY.
   */
  async searchCommitteeHearings(opts: {
    search?: string | null;
    chamber?: string | null;
    scope: 'upcoming' | 'past' | 'all';
    limit: number;
    offset: number;
  }): Promise<{ rows: UpcomingCommitteeHearing[]; total: number }> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    const chamber = opts.chamber?.trim();
    if (chamber) {
      clauses.push(`chamber ILIKE $${i++}`);
      params.push(chamber);
    }
    const search = opts.search?.trim();
    if (search) {
      clauses.push(`(title ILIKE $${i} OR committee_name ILIKE $${i})`);
      params.push(`%${search}%`);
      i++;
    }
    if (opts.scope === 'upcoming') clauses.push(`date >= ${ET_TODAY_SQL}`);
    else if (opts.scope === 'past') clauses.push(`date < ${ET_TODAY_SQL}`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    // Upcoming reads soonest-first; past/all read most-recent-first.
    const order =
      opts.scope === 'upcoming' ? 'date ASC, committee_name ASC' : 'date DESC, committee_name ASC';

    const countRows = await this.prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM federal_committee_hearing ${where}`,
      ...params,
    );
    const total = countRows[0]?.count ?? 0;

    const rows = await this.prisma.$queryRawUnsafe<UpcomingCommitteeHearing[]>(
      `SELECT id,
              title,
              committee_name AS "committeeName",
              chamber,
              date,
              starts_at AS "startsAt",
              time,
              location,
              type,
              url,
              "timezone",
              visibility::text AS visibility
         FROM federal_committee_hearing
         ${where}
        ORDER BY ${order}
        LIMIT $${i} OFFSET $${i + 1}`,
      ...params,
      opts.limit,
      opts.offset,
    );
    return { rows, total };
  }

  /**
   * One `committee_hearing` row by its string id PK (GLOBAL, RLS-free, READ-ONLY),
   * or null. Used by the stream resolver's hearingId path — a bound-param SELECT
   * by id instead of a date-DESC top-N scan, so resolve-by-hearingId works for
   * ANY hearing in the corpus, not just the ~100 most recent.
   */
  async getCommitteeHearingById(id: string): Promise<UpcomingCommitteeHearing | null> {
    const rows = await this.prisma.$queryRawUnsafe<UpcomingCommitteeHearing[]>(
      `SELECT id,
              title,
              committee_name AS "committeeName",
              chamber,
              date,
              starts_at AS "startsAt",
              time,
              location,
              type,
              url,
              "timezone",
              visibility::text AS visibility
         FROM federal_committee_hearing
        WHERE id = $1
        LIMIT 1`,
      id,
    );
    return rows[0] ?? null;
  }

  /** Keyword/subject candidate bill ids, scoped to a Congress (§6.2 recommendations). */
  async keywordCandidateIds(terms: string[], congress: number): Promise<string[]> {
    const lower = terms.map((t) => t.toLowerCase()).filter((t) => t.length >= 3);
    if (!lower.length) return [];
    const patterns = lower.map((n) => `\\m${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\M`);
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT DISTINCT cb.id
         FROM congress_bill cb
         LEFT JOIN congress_bill_subject cbs ON cbs.bill_id = cb.id
        WHERE cb.congress = $1
          AND ( LOWER(cbs.name) = ANY($2::text[])
             OR LOWER(cbs.name) ~ ANY($3::text[])
             OR LOWER(cb.policy_area) = ANY($2::text[])
             OR LOWER(cb.title) ~ ANY($3::text[]) )
        LIMIT 300`,
      congress,
      lower,
      patterns,
    );
    return rows.map((r) => r.id);
  }

  /**
   * Add-bill-modal text search over the GLOBAL `congress_bill` corpus (P1.1 port
   * of apps/api tracker.service.searchBills). `titleLike`/`idLike` are caller-
   * built LIKE patterns (lowercased title substring + the "hr-4455" id token) —
   * bound, never interpolated, same as `keywordCandidateIds`. A null
   * `congress` searches every ingested Congress so the bounded suggestion
   * list never hides an older-session bill. Newest action first.
   */
  async searchBillRows(
    titleLike: string,
    idLike: string,
    congress: number | null,
  ): Promise<BillSearchRow[]> {
    return this.prisma.$queryRawUnsafe<BillSearchRow[]>(
      `SELECT cb.id,
              cb.title, cb.status,
              ARRAY(SELECT a.text FROM congress_bill_action a WHERE a.bill_id = cb.id) AS "actionTexts",
              cb.latest_action_text AS "latestActionText",
              cb.latest_action_date AS "latestActionDate"
         FROM congress_bill cb
        WHERE ($3::int IS NULL OR cb.congress = $3) AND (LOWER(cb.title) LIKE $1 OR LOWER(cb.id) LIKE $2)
        ORDER BY cb.latest_action_date DESC NULLS LAST
        LIMIT 20`,
      titleLike,
      idLike,
      congress,
    );
  }

  /** Bill rows with sponsor/cosponsor fields for the recommendations feed + board. */
  async fetchRecommendationBills(ids: string[]): Promise<RecommendationBillRow[]> {
    if (!ids.length) return [];
    return this.prisma.$queryRawUnsafe<RecommendationBillRow[]>(
      `SELECT id,
              title, status,
              ARRAY(SELECT a.text FROM congress_bill_action a WHERE a.bill_id = congress_bill.id) AS "actionTexts",
              latest_action_text AS "latestActionText",
              latest_action_date AS "latestActionDate",
              subjects,
              policy_area         AS "policyArea",
              sponsor_name        AS "sponsorName",
              sponsor_party       AS "sponsorParty",
              cosponsors_count    AS "cosponsorsCount",
              pe_codes            AS "peCodes"
         FROM congress_bill
        WHERE id = ANY($1::text[])`,
      ids,
    );
  }

  /**
   * Phase 5 parity ground truth: what the LEGACY apps/api tracker DECIDED to
   * fire, from durable `intelligence_change` rows (GLOBAL/RLS-free, like
   * congress_bill). source='congress_bill' + data.tracker=true isolates the
   * tracker's own emits; one row per (client, bill, changeType) via unnest of
   * related_client_ids. Subscription-independent (NOT notification_log). Read-only.
   */
  async legacyTrackerDecisions(
    clientIds: string[] | null,
    windowDays: number,
    changeTypes: string[],
  ): Promise<Array<{ clientId: string; billId: string; changeType: string; severity: string }>> {
    const scoped = Boolean(clientIds && clientIds.length);
    const sql = `
      SELECT DISTINCT
        c.client_id::text          AS "clientId",
        (ic.data->>'bill_id')      AS "billId",
        ic.change_type             AS "changeType",
        ic.severity                AS "severity"
      FROM intelligence_change ic,
           LATERAL unnest(ic.related_client_ids) AS c(client_id)
      WHERE ic.source = 'congress_bill'
        AND (ic.data->>'tracker') = 'true'
        AND (ic.data->>'bill_id') IS NOT NULL
        AND ic.change_type = ANY($1::text[])
        AND ic.detected_at >= now() - make_interval(days => $2::int)
        ${scoped ? 'AND c.client_id = ANY($3::uuid[])' : ''}`;
    const params: unknown[] = [changeTypes, windowDays];
    if (scoped) params.push(clientIds);
    return this.prisma.$queryRawUnsafe(sql, ...params);
  }

  /**
   * Map pilot tenants → their client ids, read under `withSystem` (cross-tenant,
   * bypass RLS) since `clients` is tenant-scoped. Used to scope both parity sides
   * to the same client population.
   */
  async clientTenantMap(
    tenantIds: string[],
  ): Promise<Array<{ clientId: string; tenantId: string }>> {
    if (!tenantIds.length) return [];
    return this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe(
        `SELECT id::text AS "clientId", tenant_id::text AS "tenantId"
           FROM clients
          WHERE tenant_id = ANY($1::uuid[])`,
        tenantIds,
      ),
    );
  }

  // ── Tenant-scoped reads (P1.1 aux endpoints) ───────────────────────────────
  // `clients`/`client_capabilities` are TENANT-SCOPED (Postgres RLS). These
  // reads use the same `withSystem` + explicit tenant_id/client_id WHERE-clause
  // pattern as `clientTenantMap` above: the TenantGuard-resolved tenantId is a
  // MANDATORY bound param, so no cross-tenant row can leak. Read-only (D2).

  /** One client's display name + sector tag, or null (seed-suggestions, test-alert). */
  async getClientProfile(tenantId: string, clientId: string): Promise<ClientProfileRow | null> {
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<ClientProfileRow[]>(
        `SELECT name, sector_tag AS "sectorTag"
           FROM clients
          WHERE tenant_id = $1::uuid AND id = $2::uuid
          LIMIT 1`,
        tenantId,
        clientId,
      ),
    );
    return rows[0] ?? null;
  }

  /**
   * Batch-resolve display names for a set of client ids in ONE tenant-scoped read
   * (used by the global cross-client feed roll-up to label each alert card). Same
   * `withSystem` + mandatory tenant_id bound-param pattern as getClientProfile, so
   * no cross-tenant row can leak. Returns a clientId→name map; ids with no `clients`
   * row (or a null name) are simply absent from the map.
   */
  async getClientNames(tenantId: string, clientIds: string[]): Promise<Map<string, string>> {
    const ids = Array.from(new Set(clientIds)).filter(Boolean);
    if (!ids.length) return new Map();
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ id: string; name: string | null }>>(
        `SELECT id::text AS id, name
           FROM clients
          WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])`,
        tenantId,
        ids,
      ),
    );
    const out = new Map<string, string>();
    for (const r of rows) if (r.name) out.set(r.id, r.name);
    return out;
  }

  /** A client's capability rows (tags + sector) for watchlist seed-suggestions. */
  async getClientCapabilities(tenantId: string, clientId: string): Promise<ClientCapabilityRow[]> {
    return this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<ClientCapabilityRow[]>(
        `SELECT tags_jsonb AS tags, sector
           FROM client_capabilities
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid`,
        tenantId,
        clientId,
      ),
    );
  }
}
