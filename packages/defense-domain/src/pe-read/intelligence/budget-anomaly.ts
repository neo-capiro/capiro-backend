/**
 * Budget-anomaly detector (product plan F9) — flags the "weird things" on a
 * budget line that make the best client questions. Pure rule set: no DB, no
 * I/O; the caller supplies the line's current-cycle numbers plus prior-year
 * request and link-graph flags. Every anomaly carries its evidence and a
 * render-safe sentence.
 *
 * Rule vocabulary (fixed literals; surfaces + alerting depend on them):
 *   'request_collapse'        request fell >50% vs prior year
 *   'request_surge'           request jumped >100% vs prior year
 *   'zeroed_after_funding'    prior funding, current request zero/absent
 *   'mark_add_on_zero_request' a chamber funds a line the budget didn't request
 *   'divergent_cut'           one chamber cuts >20% while the other supports
 *   'approps_defies_authorizers' HAC-D/SAC-D cut where both authorizers support
 *   'quantity_without_outyears'  procurement quantity but no FYDP funding after BY
 *   'om_without_procurement'  large O&M (>=$100M) with no linked procurement line
 *   'proc_without_rdte'       large procurement (>=$100M) with no linked RDT&E PE
 */

export interface AnomalyInput {
  appropriationType: string | null; // 'RDT&E' | 'PROC' | 'OM' | null
  /** Current budget-year request (millions); null = not stated. */
  request: number | null;
  priorYearRequest: number | null;
  hascMark: number | null;
  sascMark: number | null;
  hacDMark: number | null;
  sacDMark: number | null;
  /** Procurement only: quantity stated for the budget year. */
  quantity: number | null;
  /** Sum of stated FYDP funding AFTER the budget year (millions); null = no outyears stated. */
  outyearTotal: number | null;
  hasProcurementLink?: boolean;
  hasRdteLink?: boolean;
}

export type AnomalyType =
  | 'request_collapse'
  | 'request_surge'
  | 'zeroed_after_funding'
  | 'mark_add_on_zero_request'
  | 'divergent_cut'
  | 'approps_defies_authorizers'
  | 'quantity_without_outyears'
  | 'om_without_procurement'
  | 'proc_without_rdte';

export interface Anomaly {
  type: AnomalyType;
  /** 1 (notable) .. 3 (act now). */
  severity: 1 | 2 | 3;
  evidence: Record<string, number | null>;
  sentence: string;
}

const COLLAPSE = 0.5;
const SURGE = 1.0;
const DIVERGENT_CUT = 0.2;
const LARGE_M = 100;
const FLOOR_M = 1; // ignore sub-$1M noise entirely

function fmtM(v: number): string {
  return `$${Math.abs(v) >= 1000 ? (v / 1000).toFixed(2) + 'B' : v.toFixed(1) + 'M'}`;
}

export function detectAnomalies(x: AnomalyInput): Anomaly[] {
  const out: Anomaly[] = [];
  const req = x.request;
  const prior = x.priorYearRequest;
  const t = (x.appropriationType ?? '').toUpperCase();

  // Year-over-year request shape.
  if (prior !== null && prior >= FLOOR_M) {
    if ((req === null || req <= 0.05) && prior >= LARGE_M / 10) {
      out.push({
        type: 'zeroed_after_funding',
        severity: 3,
        evidence: { priorYearRequest: prior, request: req },
        sentence: `Line zeroed: ${fmtM(prior)} requested last year, nothing this year.`,
      });
    } else if (req !== null && req > 0.05) {
      const change = (req - prior) / prior;
      if (change <= -COLLAPSE) {
        out.push({
          type: 'request_collapse',
          severity: 2,
          evidence: { priorYearRequest: prior, request: req },
          sentence: `Request fell ${Math.round(-change * 100)}% year-over-year (${fmtM(prior)} → ${fmtM(req)}).`,
        });
      } else if (change >= SURGE) {
        out.push({
          type: 'request_surge',
          severity: 2,
          evidence: { priorYearRequest: prior, request: req },
          sentence: `Request jumped ${Math.round(change * 100)}% year-over-year (${fmtM(prior)} → ${fmtM(req)}).`,
        });
      }
    }
  }

  // Committee patterns.
  const marks: Array<[string, number | null]> = [
    ['HASC', x.hascMark],
    ['SASC', x.sascMark],
    ['HAC-D', x.hacDMark],
    ['SAC-D', x.sacDMark],
  ];
  if ((req === null || req <= 0.05)) {
    for (const [name, m] of marks) {
      if (m !== null && m >= FLOOR_M) {
        out.push({
          type: 'mark_add_on_zero_request',
          severity: 2,
          evidence: { request: req, mark: m },
          sentence: `${name} funded ${fmtM(m)} on a line the budget did not request.`,
        });
        break; // one sentence covers the pattern; evidence names the first adder
      }
    }
  }
  if (req !== null && req >= FLOOR_M && x.hascMark !== null && x.sascMark !== null) {
    const hCut = (req - x.hascMark) / req;
    const sCut = (req - x.sascMark) / req;
    if (hCut >= DIVERGENT_CUT && sCut <= 0.05) {
      out.push({
        type: 'divergent_cut',
        severity: 2,
        evidence: { request: req, hascMark: x.hascMark, sascMark: x.sascMark },
        sentence: `House cut ${Math.round(hCut * 100)}% while the Senate supports the line.`,
      });
    } else if (sCut >= DIVERGENT_CUT && hCut <= 0.05) {
      out.push({
        type: 'divergent_cut',
        severity: 2,
        evidence: { request: req, hascMark: x.hascMark, sascMark: x.sascMark },
        sentence: `Senate cut ${Math.round(sCut * 100)}% while the House supports the line.`,
      });
    }
  }
  if (req !== null && req >= FLOOR_M) {
    const authSupport =
      x.hascMark !== null && x.sascMark !== null && x.hascMark >= req * 0.95 && x.sascMark >= req * 0.95;
    const appropsCut =
      (x.hacDMark !== null && x.hacDMark < req * 0.8) || (x.sacDMark !== null && x.sacDMark < req * 0.8);
    if (authSupport && appropsCut) {
      out.push({
        type: 'approps_defies_authorizers',
        severity: 3,
        evidence: { request: req, hacDMark: x.hacDMark, sacDMark: x.sacDMark },
        sentence: 'Appropriators cut a line both authorizing committees support — appropriations engagement required.',
      });
    }
  }

  // Structure-of-money patterns (need the link graph; flags are tri-state —
  // undefined means "links unknown", and we stay silent rather than false-flag).
  if (t === 'PROC' && x.quantity !== null && x.quantity > 0 && x.outyearTotal !== null && x.outyearTotal <= 0.05) {
    out.push({
      type: 'quantity_without_outyears',
      severity: 2,
      evidence: { quantity: x.quantity, outyearTotal: x.outyearTotal },
      sentence: `Buying ${x.quantity} units in the budget year with zero stated outyear funding — one-and-done or a cliff.`,
    });
  }
  if (t === 'OM' && req !== null && req >= LARGE_M && x.hasProcurementLink === false) {
    out.push({
      type: 'om_without_procurement',
      severity: 1,
      evidence: { request: req },
      sentence: `${fmtM(req)} of O&M with no linked procurement line — sustainment without a visible buy.`,
    });
  }
  if (t === 'PROC' && req !== null && req >= LARGE_M && x.hasRdteLink === false) {
    out.push({
      type: 'proc_without_rdte',
      severity: 1,
      evidence: { request: req },
      sentence: `${fmtM(req)} of procurement with no linked RDT&E parent — development history not on the books we hold.`,
    });
  }

  return out;
}
