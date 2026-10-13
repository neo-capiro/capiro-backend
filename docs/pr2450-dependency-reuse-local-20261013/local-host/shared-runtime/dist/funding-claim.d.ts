/**
 * Program Elements Phase G — current-cycle, track-aware funding claim contract.
 *
 * Every API dollar figure that can become a headline MUST be representable as a
 * FundingClaim (value + FY + stage + vehicle + cycle class + projection flag).
 * Pure / DB-free. All money values are USD millions.
 *
 * Invariants:
 * - Zero is a real value (never treated as missing; never skipped by "latest nonzero").
 * - Authorization and appropriations never share a comparison series.
 * - Percentage deltas require identical fiscal years (and a non-zero base).
 * - Outyear (FYDP) rows are projections and cannot be labeled "the current request".
 * - Capability / movement KPIs disclose coverage denominators.
 */
export type FundingClaimStage = 'request' | 'hasc' | 'sasc' | 'ndaa_conference' | 'hacd' | 'sacd' | 'appropriations_conference' | 'enacted' | 'none';
/** Coarse class relative to the PE's (or portfolio's) live process year. */
export type FundingCycleClass = 'historical' | 'current' | 'outyear' | 'unknown';
/**
 * Legislative vehicle for a dollar claim. Intentionally finer than the older
 * FundingVehicle on the appropriations ladder alone so authorization conference
 * (NDAA) and appropriations conference (Defense Approps / JES) never collude.
 */
export type FundingClaimLegislativeVehicle = 'request' | 'authorization' | 'appropriations' | 'authorization_conference' | 'appropriations_conference' | 'enacted' | 'none';
export declare const FUNDING_CLAIM_STAGE_LABEL: Record<FundingClaimStage, string>;
export declare const FUNDING_CLAIM_VEHICLE: Record<FundingClaimStage, FundingClaimLegislativeVehicle>;
/** Shared claim shape for every PE funding dollar surface. */
export interface FundingClaim {
    /** USD millions. `null` means absent; `0` is present and real. */
    value: number | null;
    fiscalYear: number | null;
    stage: FundingClaimStage;
    stageLabel: string;
    legislativeVehicle: FundingClaimLegislativeVehicle;
    cycleClass: FundingCycleClass;
    /** True only when cycleClass === 'outyear' (FYDP projection). */
    isProjection: boolean;
    unit: 'USD millions';
    enactmentStatus?: 'enacted' | 'not_enacted' | 'unknown';
    vehicleType?: 'budget_request' | 'authorization' | 'appropriation' | 'unknown';
    originalUnit?: 'dollars' | 'thousands' | 'millions' | null;
    originalValue?: number | null;
    source?: FundingClaimSource;
}
export interface FundingClaimSource {
    sourceDocumentId: string | null;
    documentType: string | null;
    budgetCycle: string | null;
    publisher: string | null;
    sourceUrl: string | null;
    pageNumber: number | null;
    observedAt: string | null;
}
export declare function deriveEnactmentStatus(stage: FundingClaimStage, cycleClass: FundingCycleClass): NonNullable<FundingClaim['enactmentStatus']>;
export declare function deriveVehicleType(stage: FundingClaimStage): NonNullable<FundingClaim['vehicleType']>;
/**
 * Why a mark cell is empty (missing-mark taxonomy — plan Phase 4).
 * - present: value is on the row (including zero)
 * - not_applicable: stage does not apply to this line/vehicle class
 * - not_started: process has not reached this stage yet
 * - candidate_gap: peer mark present on the same track, this cell empty
 * - unknown_coverage: cannot tell applicability from stored evidence
 */
export type MissingMarkStatus = 'present' | 'not_applicable' | 'not_started' | 'candidate_gap' | 'unknown_coverage';
/**
 * Neo's decision, 2026-08-08, settled architecture — do not reopen.
 *
 * **One response may contain canonical snapshot data and live enrichment, but
 * they must remain separately typed, separately attributed, separately dated,
 * and never be silently aggregated.**
 *
 * This is the general model Phase 8 uses for *any* external enrichment, not a
 * one-off for contractors. It exists because `getContractors` used to compute
 * `acceptedDirectAmountM = directAwardM + namedPrimeM`, adding a
 * government-stated R-3 exhibit value to a rolling 24-month USAspending
 * obligation total and rendering the sum as one dollar figure. Those two
 * numbers differ in source, temporal semantics, financial meaning,
 * reproducibility, and update cadence. A reader given the sum cannot recover
 * any of that, and the sum is not reproducible tomorrow.
 *
 * `assertOneSnapshotV1` (Phase 7 Workstream M) is a different rule and remains
 * valid: it forbids two *canonical snapshots* in one response. It is silent on
 * snapshot-plus-external, which is why this contract is separate rather than an
 * extension of it.
 *
 * Note the deliberate non-goal: live external data is NOT forced into the
 * canonical snapshot to make an endpoint reproducible. Enrichment is allowed to
 * be live; it just has to say so.
 */
export type MeasureProvenanceKind = 'canonical_snapshot' | 'live_external' | 'legacy_compatibility';
/** A measure read out of an immutable, content-addressed canonical snapshot. */
export interface CanonicalSnapshotProvenance {
    kind: 'canonical_snapshot';
    /** Human-facing origin, e.g. 'R-3'. */
    source: string;
    /** Which snapshot produced it. Null only when serving the legacy path. */
    snapshotId: string | null;
    /** Snapshot activation instant — the "as of" a snapshot measure carries. */
    asOf: string | null;
}
/** A measure observed from a live external system that moves on its own clock. */
export interface LiveExternalProvenance {
    kind: 'live_external';
    /** Human-facing origin, e.g. 'USAspending'. */
    source: string;
    /** When this observation was taken. Never optional: freshness is the point. */
    asOf: string;
    /** Trailing window the observation covers, when it is a windowed total. */
    windowMonths?: number;
}
/**
 * A measure still read from the mutable legacy/compatibility tables.
 *
 * The third kind exists because it is the *honest* state of every read method
 * Workstream M has not migrated yet, and mislabelling one of those as
 * `canonical_snapshot` is the exact misattribution this contract prevents. A
 * measure is `canonical_snapshot` only when it was actually read out of a
 * snapshot — not when a snapshot merely happens to be active while the value
 * came from `program_element_*`.
 *
 * It is a distinct kind, so `sumAttributedMeasures` refuses to add it to either
 * of the others for free.
 */
export interface LegacyCompatibilityProvenance {
    kind: 'legacy_compatibility';
    /** Human-facing origin, e.g. 'R-3'. */
    source: string;
    /** The mutable table the value came from, named so the gap is auditable. */
    table: string;
    /**
     * Why this is not snapshot-backed yet. Required: an unmigrated read with no
     * stated reason is indistinguishable from one nobody has looked at.
     */
    reason: string;
}
export type MeasureProvenance = CanonicalSnapshotProvenance | LiveExternalProvenance | LegacyCompatibilityProvenance;
/** One dollar measure that knows where it came from and when. */
export interface AttributedMeasure {
    amountM: number;
    count: number;
    unit: 'USD millions';
    label: string;
    provenance: MeasureProvenance;
}
/** Thrown when unlike measures would be aggregated into one figure. */
export declare class MeasureConflationError extends Error {
    readonly kinds: readonly MeasureProvenanceKind[];
    constructor(kinds: readonly MeasureProvenanceKind[]);
}
/**
 * Sum measures, refusing to cross a provenance boundary.
 *
 * The guard is a function rather than a convention because a convention cannot
 * fail a build. Any future code that wants one total must come through here,
 * and gets a loud error instead of a plausible wrong number. Summing within one
 * provenance kind stays legal — two USAspending windows may legitimately add.
 */
export declare function sumAttributedMeasures(measures: readonly AttributedMeasure[]): number;
export type ContractorEvidenceClass = 'accepted_direct' | 'candidate' | 'unmatched_dollars';
export interface ContractorEvidenceBucket {
    evidenceClass: ContractorEvidenceClass;
    amountM: number;
    count: number;
    label: string;
}
export interface CoverageDenominator {
    /** Full filtered population size (denominator). */
    populationSize: number;
    /** Members that contributed a usable pair/value to the total. */
    contributedCount: number;
    /** populationSize - contributedCount when both known; else null. */
    missingCount: number | null;
    /** Human-readable disclosure for UI/trust surfaces. */
    disclosure: string;
}
export interface CapabilityTotalClaim {
    fiscalYear: number | null;
    unit: 'USD millions';
    /** Sum of request at the shared fiscal year (zeros included when present). */
    totalRequestM: number;
    lineCount: number;
    linesWithRequestAtFy: number;
    coverage: CoverageDenominator;
}
export interface MovementKpiClaim {
    unit: 'USD millions';
    /** Sum of (enacted - request) over pairs that qualify. */
    totalDeltaM: number | null;
    /** (Σenacted - Σrequest) / Σrequest * 100; null if base zero or no pairs. */
    avgDeltaPct: number | null;
    totalRequestM: number;
    totalEnactedM: number;
    coverage: CoverageDenominator;
}
export declare function classifyCycleClass(fiscalYear: number | null | undefined, currentCycleFy: number | null | undefined): FundingCycleClass;
export declare function buildFundingClaim(input: {
    value: number | null | undefined;
    fiscalYear: number | null | undefined;
    stage: FundingClaimStage;
    currentCycleFy?: number | null;
    originalUnit?: FundingClaim['originalUnit'];
    originalValue?: number | null;
    source?: FundingClaimSource;
}): FundingClaim;
/**
 * Pick the latest FY's value WITHOUT skipping zeros. A year whose value is
 * exactly 0 beats an older non-zero year. Null (missing) years are skipped.
 */
export declare function selectLatestPreservingZero<T extends {
    fy: number;
    value: number | null | undefined;
}>(years: readonly T[]): T | null;
/**
 * Portfolio / PE "current cycle" FY from stage marks — DOES NOT skip zero marks.
 * Prefer latest FY with any non-null congressional mark (auth or approps track);
 * else latest FY with a non-null request (including 0). Null if nothing present.
 */
export declare function currentCycleFyPreservingZero(years: readonly {
    fy: number;
    request?: number | null;
    hascMark?: number | null;
    sascMark?: number | null;
    hacDMark?: number | null;
    sacDMark?: number | null;
    conference?: number | null;
    ndaaConference?: number | null;
}[]): number | null;
/**
 * Percentage change only when both values share a fiscal year and the base is
 * a finite non-zero number. Refuses cross-FY identity theft.
 */
export declare function percentDeltaSameFiscalYear(input: {
    value: number | null | undefined;
    base: number | null | undefined;
    valueFy: number | null | undefined;
    baseFy: number | null | undefined;
}): number | null;
/** True when both claims can legally headline a % move. */
export declare function canCompareClaimsForPct(a: FundingClaim, b: FundingClaim): boolean;
export declare function percentDeltaBetweenClaims(a: FundingClaim, b: FundingClaim): number | null;
/**
 * Map DEV ladder stage keys (FundingStage) onto FundingClaimStage so legacy
 * currentFunding() picks can be promoted to claims without track loss.
 * 'conference' on the ladder is appropriations conference, never NDAA.
 */
export declare function fundingStageToClaimStage(stage: string | null | undefined): FundingClaimStage;
export declare function claimFromLadderPick(input: {
    value: number | null;
    stage: string;
    fiscalYear: number | null;
    currentCycleFy: number | null;
}): FundingClaim;
/**
 * Missing-mark taxonomy for one chamber/stage cell on a cycle year row.
 * trackPeers: other marks on the SAME vehicle track (e.g. HASC vs SASC).
 */
export declare function classifyMissingMark(input: {
    value: number | null | undefined;
    /** Has the budget process reached a stage that implies this cell, for this FY? */
    processReached: boolean;
    /** Is this stage applicable to the line (e.g. auth marks on an R-1)? */
    applicable: boolean;
    /** Any peer on the same track has a present (incl. zero) value. */
    peerPresentOnTrack: boolean;
}): MissingMarkStatus;
export declare function coverageDenominator(populationSize: number, contributedCount: number, subject: string): CoverageDenominator;
/**
 * Movement KPI over the FULL filtered population. Only same-row pairs in which
 * both request and enacted are non-null (zero allowed) contribute to sums;
 * coverage uses populationSize as the denominator.
 */
export declare function buildMovementKpi(input: {
    populationSize: number;
    pairs: readonly {
        request: number | null;
        enacted: number | null;
    }[];
}): MovementKpiClaim;
/**
 * Capability total at ONE fiscal year. Lines missing a request at that FY do
 * not invent zeros; they reduce coverage instead.
 */
export declare function buildCapabilityTotal(input: {
    fiscalYear: number | null;
    /** One entry per matched line in the capability set. */
    lineRequestsAtFy: readonly (number | null | undefined)[];
}): CapabilityTotalClaim;
/**
 * Partition contractor/performer dollar evidence into the three honest classes.
 * Unmatched dollars stay visible and are never folded into accepted totals.
 *
 * Scope note (Neo, 2026-08-08): evidence *class* and measure *provenance* are
 * orthogonal axes, and this function only partitions the first. It must be fed
 * measures of a single provenance kind — in practice the federal-award side
 * alone. Feeding it `awardDollars + exhibitValue` is what produced the
 * conflated `accepted_direct` bucket this contract now forbids; see
 * `sumAttributedMeasures` above.
 */
export declare function partitionContractorEvidence(input: {
    acceptedDirectAmountM?: number;
    acceptedDirectCount?: number;
    candidateAmountM?: number;
    candidateCount?: number;
    unmatchedAmountM?: number;
    unmatchedCount?: number;
}): ContractorEvidenceBucket[];
/**
 * SQL predicate fragment helpers — trusted column expressions only.
 * Callers must never interpolate user input into these.
 */
/** "Value is present" — includes zero. Use instead of `col <> 0`. */
export declare function sqlPresentIncludingZero(columnSql: string): string;
/**
 * Catalog / PE current-cycle FY expression over program_element_year alias `y`
 * (or bare columns when alias is ''). Mirrors currentCycleFyPreservingZero —
 * includes NDAA conference (authorization track) as a real mark year.
 */
export declare function sqlCurrentCycleFyExpr(alias?: string): string;
/**
 * Track-aware chamber markup divergence vs request (Phase G / closeout B1).
 * Authorization (HASC↔SASC) and appropriations (HAC-D↔SAC-D) never blend into
 * one GREATEST/LEAST span. Missing chamber falls back to request so a single
 * chamber mark still measures movement vs PB, not vs the other track.
 *
 * `divergencePct` = max within-track % (headline sort key).
 * `divergenceTrack` tags which track produced the max (null when both 0/null).
 */
export declare function markupMonitorTrackDivergence(input: {
    request: number | null | undefined;
    hascMark?: number | null;
    sascMark?: number | null;
    hacDMark?: number | null;
    sacDMark?: number | null;
}): {
    authDivergencePct: number;
    appropsDivergencePct: number;
    divergencePct: number;
    divergenceTrack: 'authorization' | 'appropriations' | null;
};
/**
 * Finder list enacted-vs-request % uses the matched FY pair only:
 * enacted + request-at-enacted-FY. Bare latestRequest (any FY) must never be
 * the delta base — that is cross-FY identity theft when FYs differ.
 */
export declare function listEnactedVsRequestDeltaPct(input: {
    latestEnacted: number | null | undefined;
    latestEnactedFy: number | null | undefined;
    /** Request dollars at the enacted FY (SQL `ler`), not catalog-latest request. */
    requestAtEnactedFy: number | null | undefined;
}): number | null;
//# sourceMappingURL=funding-claim.d.ts.map