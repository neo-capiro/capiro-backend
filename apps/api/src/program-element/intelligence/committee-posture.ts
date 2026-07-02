/**
 * Committee-posture classifier (product plan F3 / F13) — turns a budget line's
 * FY mark vector into a government-affairs POSTURE plus a recommended action.
 *
 * Pure module: no DB, no I/O. Inputs are the canonical program_element_year
 * fields (all in MILLIONS). Every classification carries the dollar evidence it
 * was derived from, so surfaces can render "why" without re-deriving.
 *
 * Vocabulary (fixed — surfaces and specs depend on these literals):
 *   posture:
 *     'restoration_opportunity'  a chamber cut below request while another supports
 *     'cut_risk'                 both chambers (or approps) below request
 *     'conference_target'        chambers disagree — outcome decided in conference
 *     'appropriations_target'    authorization positive but HAC-D/SAC-D negative
 *     'plus_up_defense'          add(s) above request worth defending
 *     'aligned'                  marks agree with request (within tolerance)
 *     'insufficient_data'        fewer than two comparable positions
 *   action:
 *     'support_senate_position' | 'defend_house_add' | 'seek_restoration' |
 *     'shift_to_appropriations' | 'defend_add_in_conference' | 'monitor' | 'none'
 */

export interface MarkVector {
  /** President's-budget request for the FY (millions). Null when not stated. */
  request: number | null;
  hascMark: number | null;
  sascMark: number | null;
  hacDMark: number | null;
  sacDMark: number | null;
  conference: number | null;
  enacted: number | null;
}

export type Posture =
  | 'restoration_opportunity'
  | 'cut_risk'
  | 'conference_target'
  | 'appropriations_target'
  | 'plus_up_defense'
  | 'aligned'
  | 'insufficient_data';

export type RecommendedAction =
  | 'support_senate_position'
  | 'defend_house_add'
  | 'seek_restoration'
  | 'shift_to_appropriations'
  | 'defend_add_in_conference'
  | 'monitor'
  | 'none';

export interface PostureResult {
  posture: Posture;
  action: RecommendedAction;
  /** Dollar evidence behind the classification (millions; null = not stated). */
  evidence: {
    request: number | null;
    hascDelta: number | null;
    sascDelta: number | null;
    hacDDelta: number | null;
    sacDDelta: number | null;
    chamberSpreadM: number | null; // |HASC - SASC| when both stated
  };
  /** One-sentence human-readable rationale, safe to render verbatim. */
  rationale: string;
}

/**
 * Marks within this fraction of the request (or absolute floor) count as "at
 * request" — committee tables round and small technical adjustments are not
 * lobbying signals. Floor handles small lines where 1% is noise-level dollars.
 */
const TOLERANCE_FRACTION = 0.005;
const TOLERANCE_FLOOR_M = 0.5;

function delta(mark: number | null, request: number | null): number | null {
  if (mark === null || request === null) return null;
  return Math.round((mark - request) * 1000) / 1000;
}

function isAtRequest(mark: number | null, request: number | null): boolean {
  const d = delta(mark, request);
  if (d === null) return false;
  const tol = Math.max(Math.abs(request ?? 0) * TOLERANCE_FRACTION, TOLERANCE_FLOOR_M);
  return Math.abs(d) <= tol;
}

function fmtM(v: number): string {
  return `$${Math.abs(v) >= 1000 ? (v / 1000).toFixed(2) + 'B' : v.toFixed(1) + 'M'}`;
}

/**
 * Classify one budget line + FY. Deterministic; rules are evaluated in strict
 * priority order (first match wins) so the outcome is auditable.
 */
export function classifyPosture(v: MarkVector): PostureResult {
  const req = v.request;
  const hasc = v.hascMark;
  const sasc = v.sascMark;
  const hacD = v.hacDMark;
  const sacD = v.sacDMark;

  const hascDelta = delta(hasc, req);
  const sascDelta = delta(sasc, req);
  const hacDDelta = delta(hacD, req);
  const sacDDelta = delta(sacD, req);
  const evidence = {
    request: req,
    hascDelta,
    sascDelta,
    hacDDelta,
    sacDDelta,
    chamberSpreadM: hasc !== null && sasc !== null ? Math.round(Math.abs(hasc - sasc) * 1000) / 1000 : null,
  };

  const positions = [hasc, sasc, hacD, sacD].filter((x) => x !== null).length;
  const done = (posture: Posture, action: RecommendedAction, rationale: string): PostureResult => ({
    posture,
    action,
    evidence,
    rationale,
  });

  // 0. Not enough stated positions to say anything defensible.
  if (positions < 2 || req === null) {
    return done(
      'insufficient_data',
      positions >= 1 ? 'monitor' : 'none',
      positions >= 1
        ? 'Only one committee position is stated; watch for the remaining marks.'
        : 'No committee positions stated for this line yet.',
    );
  }

  const hascCut = hascDelta !== null && !isAtRequest(hasc, req) && hascDelta < 0;
  const sascCut = sascDelta !== null && !isAtRequest(sasc, req) && sascDelta < 0;
  const hascAdd = hascDelta !== null && !isAtRequest(hasc, req) && hascDelta > 0;
  const sascAdd = sascDelta !== null && !isAtRequest(sasc, req) && sascDelta > 0;
  const hascAt = isAtRequest(hasc, req);
  const sascAt = isAtRequest(sasc, req);
  const authPositive = hascAdd || sascAdd || (hascAt && sascAt);
  const appropsNegative =
    (hacDDelta !== null && !isAtRequest(hacD, req) && hacDDelta < 0) ||
    (sacDDelta !== null && !isAtRequest(sacD, req) && sacDDelta < 0);

  // 1. Authorization supportive but appropriators cutting — the money committee wins.
  if (authPositive && appropsNegative) {
    const cutter = hacDDelta !== null && hacDDelta < 0 ? 'HAC-D' : 'SAC-D';
    const cut = hacDDelta !== null && hacDDelta < 0 ? hacDDelta : sacDDelta;
    return done(
      'appropriations_target',
      'shift_to_appropriations',
      `Authorizers support the line but ${cutter} is ${fmtM(cut ?? 0)} below request — the engagement belongs with appropriations.`,
    );
  }

  // 2. Both chambers cutting = structural cut risk.
  if (hascCut && sascCut) {
    return done(
      'cut_risk',
      'seek_restoration',
      `Both chambers marked below request (HASC ${fmtM(hascDelta ?? 0)}, SASC ${fmtM(sascDelta ?? 0)}) — coordinated restoration case needed.`,
    );
  }

  // 3. One chamber cuts while the other holds/adds — classic conference restoration.
  if (hascCut && (sascAt || sascAdd)) {
    return done(
      'restoration_opportunity',
      'support_senate_position',
      `House is ${fmtM(hascDelta ?? 0)} below request while the Senate ${sascAdd ? `adds ${fmtM(sascDelta ?? 0)}` : 'supports the request'} — back the Senate number in conference.`,
    );
  }
  if (sascCut && (hascAt || hascAdd)) {
    return done(
      'restoration_opportunity',
      hascAdd ? 'defend_house_add' : 'monitor',
      `Senate is ${fmtM(sascDelta ?? 0)} below request while the House ${hascAdd ? `adds ${fmtM(hascDelta ?? 0)}` : 'supports the request'} — defend the House position in conference.`,
    );
  }

  // 4. One-chamber add the other didn't match — defend it into conference.
  if (hascAdd && !sascAdd) {
    return done(
      'plus_up_defense',
      'defend_house_add',
      `House added ${fmtM(hascDelta ?? 0)} above request without a matching Senate add — the add must survive conference.`,
    );
  }
  if (sascAdd && !hascAdd) {
    return done(
      'plus_up_defense',
      'defend_add_in_conference',
      `Senate added ${fmtM(sascDelta ?? 0)} above request without a matching House add — the add must survive conference.`,
    );
  }

  // 5. Both add — conference decides the number (different magnitudes), or a
  //    matched add that still has to survive conference (equal magnitudes).
  if (hascAdd && sascAdd) {
    if (!isAtRequest(hasc, sasc)) {
      return done(
        'conference_target',
        'defend_add_in_conference',
        `Both chambers added (HASC ${fmtM(hascDelta ?? 0)}, SASC ${fmtM(sascDelta ?? 0)}) — conference sets the final level.`,
      );
    }
    return done(
      'plus_up_defense',
      'defend_add_in_conference',
      `Both chambers added ${fmtM(hascDelta ?? 0)} above request — a strong position that still must be held through conference.`,
    );
  }

  // 6. Everything stated is at request.
  return done('aligned', 'none', 'Stated committee positions match the request.');
}
