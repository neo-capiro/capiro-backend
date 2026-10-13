"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MeasureConflationError = exports.FUNDING_CLAIM_VEHICLE = exports.FUNDING_CLAIM_STAGE_LABEL = void 0;
exports.deriveEnactmentStatus = deriveEnactmentStatus;
exports.deriveVehicleType = deriveVehicleType;
exports.sumAttributedMeasures = sumAttributedMeasures;
exports.classifyCycleClass = classifyCycleClass;
exports.buildFundingClaim = buildFundingClaim;
exports.selectLatestPreservingZero = selectLatestPreservingZero;
exports.currentCycleFyPreservingZero = currentCycleFyPreservingZero;
exports.percentDeltaSameFiscalYear = percentDeltaSameFiscalYear;
exports.canCompareClaimsForPct = canCompareClaimsForPct;
exports.percentDeltaBetweenClaims = percentDeltaBetweenClaims;
exports.fundingStageToClaimStage = fundingStageToClaimStage;
exports.claimFromLadderPick = claimFromLadderPick;
exports.classifyMissingMark = classifyMissingMark;
exports.coverageDenominator = coverageDenominator;
exports.buildMovementKpi = buildMovementKpi;
exports.buildCapabilityTotal = buildCapabilityTotal;
exports.partitionContractorEvidence = partitionContractorEvidence;
exports.sqlPresentIncludingZero = sqlPresentIncludingZero;
exports.sqlCurrentCycleFyExpr = sqlCurrentCycleFyExpr;
exports.markupMonitorTrackDivergence = markupMonitorTrackDivergence;
exports.listEnactedVsRequestDeltaPct = listEnactedVsRequestDeltaPct;
exports.FUNDING_CLAIM_STAGE_LABEL = {
    request: 'Request',
    hasc: 'HASC',
    sasc: 'SASC',
    ndaa_conference: 'NDAA conference report',
    hacd: 'HAC-D',
    sacd: 'SAC-D',
    appropriations_conference: 'Appropriations conference',
    enacted: 'Enacted',
    none: 'No data',
};
exports.FUNDING_CLAIM_VEHICLE = {
    request: 'request',
    hasc: 'authorization',
    sasc: 'authorization',
    ndaa_conference: 'authorization_conference',
    hacd: 'appropriations',
    sacd: 'appropriations',
    appropriations_conference: 'appropriations_conference',
    enacted: 'enacted',
    none: 'none',
};
function deriveEnactmentStatus(stage, cycleClass) {
    if (stage === 'enacted')
        return 'enacted';
    if (stage === 'none' || cycleClass === 'historical')
        return 'unknown';
    return cycleClass === 'current' || cycleClass === 'outyear' ? 'not_enacted' : 'unknown';
}
function deriveVehicleType(stage) {
    if (stage === 'request')
        return 'budget_request';
    if (stage === 'hasc' || stage === 'sasc' || stage === 'ndaa_conference')
        return 'authorization';
    if (stage === 'hacd' ||
        stage === 'sacd' ||
        stage === 'appropriations_conference' ||
        stage === 'enacted') {
        return 'appropriation';
    }
    return 'unknown';
}
/** Thrown when unlike measures would be aggregated into one figure. */
class MeasureConflationError extends Error {
    kinds;
    constructor(kinds) {
        super(`refusing to aggregate measures across provenance kinds [${[...kinds].sort().join(', ')}]: ` +
            'canonical snapshot value and live external observation are different financial measures ' +
            'and must be presented separately');
        this.kinds = kinds;
        this.name = 'MeasureConflationError';
    }
}
exports.MeasureConflationError = MeasureConflationError;
/**
 * Sum measures, refusing to cross a provenance boundary.
 *
 * The guard is a function rather than a convention because a convention cannot
 * fail a build. Any future code that wants one total must come through here,
 * and gets a loud error instead of a plausible wrong number. Summing within one
 * provenance kind stays legal — two USAspending windows may legitimately add.
 */
function sumAttributedMeasures(measures) {
    const kinds = new Set();
    for (const measure of measures)
        kinds.add(measure.provenance.kind);
    if (kinds.size > 1)
        throw new MeasureConflationError([...kinds]);
    return measures.reduce((total, measure) => total + measure.amountM, 0);
}
function classifyCycleClass(fiscalYear, currentCycleFy) {
    if (fiscalYear == null || currentCycleFy == null)
        return 'unknown';
    if (fiscalYear < currentCycleFy)
        return 'historical';
    if (fiscalYear === currentCycleFy)
        return 'current';
    return 'outyear';
}
function buildFundingClaim(input) {
    const value = input.value == null || (typeof input.value === 'number' && !Number.isFinite(input.value))
        ? null
        : input.value;
    const fiscalYear = input.fiscalYear ?? null;
    const cycleClass = classifyCycleClass(fiscalYear, input.currentCycleFy ?? null);
    const stage = input.stage;
    const claim = {
        value,
        fiscalYear,
        stage,
        stageLabel: exports.FUNDING_CLAIM_STAGE_LABEL[stage],
        legislativeVehicle: exports.FUNDING_CLAIM_VEHICLE[stage],
        cycleClass,
        isProjection: cycleClass === 'outyear',
        unit: 'USD millions',
        enactmentStatus: deriveEnactmentStatus(stage, cycleClass),
        vehicleType: deriveVehicleType(stage),
    };
    if ('originalUnit' in input)
        claim.originalUnit = input.originalUnit ?? null;
    if ('originalValue' in input)
        claim.originalValue = input.originalValue ?? null;
    if (input.source !== undefined)
        claim.source = input.source;
    return claim;
}
/**
 * Pick the latest FY's value WITHOUT skipping zeros. A year whose value is
 * exactly 0 beats an older non-zero year. Null (missing) years are skipped.
 */
function selectLatestPreservingZero(years) {
    let best = null;
    for (const y of years) {
        if (y.value == null || (typeof y.value === 'number' && !Number.isFinite(y.value)))
            continue;
        if (best == null || y.fy > best.fy)
            best = y;
    }
    return best;
}
/**
 * Portfolio / PE "current cycle" FY from stage marks — DOES NOT skip zero marks.
 * Prefer latest FY with any non-null congressional mark (auth or approps track);
 * else latest FY with a non-null request (including 0). Null if nothing present.
 */
function currentCycleFyPreservingZero(years) {
    const hasMark = (y) => y.hascMark != null ||
        y.sascMark != null ||
        y.hacDMark != null ||
        y.sacDMark != null ||
        y.conference != null ||
        y.ndaaConference != null;
    const markFys = years.filter(hasMark).map((y) => y.fy);
    if (markFys.length)
        return Math.max(...markFys);
    const reqFys = years.filter((y) => y.request != null).map((y) => y.fy);
    return reqFys.length ? Math.max(...reqFys) : null;
}
/**
 * Percentage change only when both values share a fiscal year and the base is
 * a finite non-zero number. Refuses cross-FY identity theft.
 */
function percentDeltaSameFiscalYear(input) {
    const { value, base, valueFy, baseFy } = input;
    if (value == null || base == null || valueFy == null || baseFy == null)
        return null;
    if (valueFy !== baseFy)
        return null;
    if (!Number.isFinite(value) || !Number.isFinite(base) || base === 0)
        return null;
    return ((value - base) / base) * 100;
}
/** True when both claims can legally headline a % move. */
function canCompareClaimsForPct(a, b) {
    return (a.value != null &&
        b.value != null &&
        a.fiscalYear != null &&
        a.fiscalYear === b.fiscalYear &&
        a.legislativeVehicle !== 'none' &&
        b.legislativeVehicle !== 'none' &&
        // Never blend authorization track with appropriations track.
        sameMoneyTrack(a.legislativeVehicle, b.legislativeVehicle));
}
function sameMoneyTrack(a, b) {
    const track = (v) => {
        if (v === 'authorization' || v === 'authorization_conference')
            return 'auth';
        if (v === 'appropriations' || v === 'appropriations_conference' || v === 'enacted')
            return 'approps';
        if (v === 'request')
            return 'request';
        return 'other';
    };
    const ta = track(a);
    const tb = track(b);
    if (ta === 'other' || tb === 'other')
        return false;
    // request may compare against either track as the base; both non-request must match.
    if (ta === 'request' || tb === 'request')
        return true;
    return ta === tb;
}
function percentDeltaBetweenClaims(a, b) {
    if (!canCompareClaimsForPct(a, b))
        return null;
    // Treat `b` as base when comparing "a vs b".
    return percentDeltaSameFiscalYear({
        value: a.value,
        base: b.value,
        valueFy: a.fiscalYear,
        baseFy: b.fiscalYear,
    });
}
/**
 * Map DEV ladder stage keys (FundingStage) onto FundingClaimStage so legacy
 * currentFunding() picks can be promoted to claims without track loss.
 * 'conference' on the ladder is appropriations conference, never NDAA.
 */
function fundingStageToClaimStage(stage) {
    switch (stage) {
        case 'enacted':
            return 'enacted';
        case 'conference':
            return 'appropriations_conference';
        case 'sacd':
            return 'sacd';
        case 'hacd':
            return 'hacd';
        case 'sasc':
            return 'sasc';
        case 'hasc':
            return 'hasc';
        case 'request':
            return 'request';
        case 'ndaa_conference':
            return 'ndaa_conference';
        default:
            return 'none';
    }
}
function claimFromLadderPick(input) {
    return buildFundingClaim({
        value: input.value,
        fiscalYear: input.fiscalYear,
        stage: fundingStageToClaimStage(input.stage),
        currentCycleFy: input.currentCycleFy,
    });
}
/**
 * Missing-mark taxonomy for one chamber/stage cell on a cycle year row.
 * trackPeers: other marks on the SAME vehicle track (e.g. HASC vs SASC).
 */
function classifyMissingMark(input) {
    if (input.value != null)
        return 'present';
    if (!input.applicable)
        return 'not_applicable';
    if (!input.processReached)
        return 'not_started';
    if (input.peerPresentOnTrack)
        return 'candidate_gap';
    return 'unknown_coverage';
}
function coverageDenominator(populationSize, contributedCount, subject) {
    const pop = Math.max(0, populationSize);
    const contrib = Math.max(0, Math.min(contributedCount, pop || contributedCount));
    const missing = pop > 0 ? Math.max(0, pop - contrib) : null;
    const disclosure = pop > 0
        ? `${subject}: ${contrib} of ${pop} in filtered population` +
            (missing != null && missing > 0 ? ` (${missing} without a usable value)` : '')
        : `${subject}: ${contrib} contributed (population size not stated)`;
    return {
        populationSize: pop,
        contributedCount: contrib,
        missingCount: missing,
        disclosure,
    };
}
/**
 * Movement KPI over the FULL filtered population. Only same-row pairs in which
 * both request and enacted are non-null (zero allowed) contribute to sums;
 * coverage uses populationSize as the denominator.
 */
function buildMovementKpi(input) {
    let totalRequestM = 0;
    let totalEnactedM = 0;
    let contributed = 0;
    for (const p of input.pairs) {
        if (p.request == null || p.enacted == null)
            continue;
        if (!Number.isFinite(p.request) || !Number.isFinite(p.enacted))
            continue;
        totalRequestM += p.request;
        totalEnactedM += p.enacted;
        contributed += 1;
    }
    const totalDeltaM = contributed > 0 ? totalEnactedM - totalRequestM : null;
    const avgDeltaPct = contributed > 0 && totalRequestM !== 0
        ? ((totalEnactedM - totalRequestM) / totalRequestM) * 100
        : null;
    return {
        unit: 'USD millions',
        totalDeltaM,
        avgDeltaPct,
        totalRequestM,
        totalEnactedM,
        coverage: coverageDenominator(input.populationSize, contributed, 'Matched request/enacted pairs'),
    };
}
/**
 * Capability total at ONE fiscal year. Lines missing a request at that FY do
 * not invent zeros; they reduce coverage instead.
 */
function buildCapabilityTotal(input) {
    const populationSize = input.lineRequestsAtFy.length;
    let totalRequestM = 0;
    let linesWithRequestAtFy = 0;
    for (const v of input.lineRequestsAtFy) {
        if (v == null || !Number.isFinite(v))
            continue;
        totalRequestM += v;
        linesWithRequestAtFy += 1;
    }
    return {
        fiscalYear: input.fiscalYear,
        unit: 'USD millions',
        totalRequestM,
        lineCount: populationSize,
        linesWithRequestAtFy,
        coverage: coverageDenominator(populationSize, linesWithRequestAtFy, input.fiscalYear != null
            ? `Capability request total at FY${input.fiscalYear}`
            : 'Capability request total (FY unset)'),
    };
}
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
function partitionContractorEvidence(input) {
    return [
        {
            evidenceClass: 'accepted_direct',
            amountM: input.acceptedDirectAmountM ?? 0,
            count: input.acceptedDirectCount ?? 0,
            label: 'Accepted / direct evidence (named prime or PE-coded award)',
        },
        {
            evidenceClass: 'candidate',
            amountM: input.candidateAmountM ?? 0,
            count: input.candidateCount ?? 0,
            label: 'Candidate evidence (program-linked or unreviewed match)',
        },
        {
            evidenceClass: 'unmatched_dollars',
            amountM: input.unmatchedAmountM ?? 0,
            count: input.unmatchedCount ?? 0,
            label: 'Unmatched dollars (not attributed to this PE)',
        },
    ];
}
/**
 * SQL predicate fragment helpers — trusted column expressions only.
 * Callers must never interpolate user input into these.
 */
/** "Value is present" — includes zero. Use instead of `col <> 0`. */
function sqlPresentIncludingZero(columnSql) {
    return `${columnSql} IS NOT NULL`;
}
/**
 * Catalog / PE current-cycle FY expression over program_element_year alias `y`
 * (or bare columns when alias is ''). Mirrors currentCycleFyPreservingZero —
 * includes NDAA conference (authorization track) as a real mark year.
 */
function sqlCurrentCycleFyExpr(alias = 'y') {
    const p = alias ? `${alias}.` : '';
    return `COALESCE(
    MAX(${p}fy) FILTER (WHERE ${p}hasc_mark IS NOT NULL OR ${p}sasc_mark IS NOT NULL
      OR ${p}ndaa_conference IS NOT NULL
      OR ${p}hac_d_mark IS NOT NULL OR ${p}sac_d_mark IS NOT NULL OR ${p}conference IS NOT NULL),
    MAX(${p}fy) FILTER (WHERE ${p}request IS NOT NULL)
  )`;
}
/**
 * Track-aware chamber markup divergence vs request (Phase G / closeout B1).
 * Authorization (HASC↔SASC) and appropriations (HAC-D↔SAC-D) never blend into
 * one GREATEST/LEAST span. Missing chamber falls back to request so a single
 * chamber mark still measures movement vs PB, not vs the other track.
 *
 * `divergencePct` = max within-track % (headline sort key).
 * `divergenceTrack` tags which track produced the max (null when both 0/null).
 */
function markupMonitorTrackDivergence(input) {
    const trackPct = (a, b, request) => {
        if (request == null || !Number.isFinite(request) || request === 0)
            return 0;
        const lo = Math.min(a ?? request, b ?? request);
        const hi = Math.max(a ?? request, b ?? request);
        return ((hi - lo) / request) * 100;
    };
    const authDivergencePct = trackPct(input.hascMark, input.sascMark, input.request);
    const appropsDivergencePct = trackPct(input.hacDMark, input.sacDMark, input.request);
    const divergencePct = Math.max(authDivergencePct, appropsDivergencePct);
    let divergenceTrack = null;
    if (divergencePct > 0) {
        divergenceTrack =
            authDivergencePct >= appropsDivergencePct ? 'authorization' : 'appropriations';
    }
    return { authDivergencePct, appropsDivergencePct, divergencePct, divergenceTrack };
}
/**
 * Finder list enacted-vs-request % uses the matched FY pair only:
 * enacted + request-at-enacted-FY. Bare latestRequest (any FY) must never be
 * the delta base — that is cross-FY identity theft when FYs differ.
 */
function listEnactedVsRequestDeltaPct(input) {
    return percentDeltaSameFiscalYear({
        value: input.latestEnacted,
        base: input.requestAtEnactedFy,
        valueFy: input.latestEnactedFy,
        baseFy: input.latestEnactedFy,
    });
}
//# sourceMappingURL=funding-claim.js.map