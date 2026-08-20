/**
 * Acquisition-maturity classifier (product plan F5) — places a budget line on
 * the RDT&E -> procurement -> sustainment pipeline from data signals only:
 *
 *   | Stage                | Signal                          |
 *   | early_rnd            | RDT&E BA 1-2                    |
 *   | prototype            | RDT&E BA 3-4                    |
 *   | system_development   | RDT&E BA 5                      |
 *   | support_fielded      | RDT&E BA 6-8                    |
 *   | procurement          | appropriation PROC (P-1 BLIN)   |
 *   | sustainment          | appropriation OM                |
 *   | unknown              | none of the above resolvable    |
 *
 * Pure module: no DB, no I/O. `hasProcurementLink` / `hasOmLink` (from the
 * cross-appropriation link graph) refine the RDT&E answer: an SDD-stage PE with
 * a live buy line answers the customer question "is this a science project or
 * is there a buy line?" affirmatively.
 */

export type MaturityStage =
  | 'early_rnd'
  | 'prototype'
  | 'system_development'
  | 'support_fielded'
  | 'procurement'
  | 'sustainment'
  | 'unknown';

export interface MaturityInput {
  /** 'RDT&E' | 'PROC' | 'OM' | null (canonical program_element.appropriation_type). */
  appropriationType: string | null;
  /** Raw budget_activity string as stored ('BA 03', '3', 'Budget Activity 4', null). */
  budgetActivity: string | null;
  /** The line has a linked procurement BLIN (cross-appropriation graph). */
  hasProcurementLink?: boolean;
  /** The line has a linked O&M sustainment line. */
  hasOmLink?: boolean;
}

export interface MaturityResult {
  stage: MaturityStage;
  /** True when the line (or its linked chain) reaches a procurement buy line. */
  hasBuyLine: boolean;
  /** Render-safe sentence. */
  rationale: string;
}

/** Parse the leading BA number out of any stored budget_activity spelling. */
export function parseBudgetActivity(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = /(\d{1,2})/.exec(raw);
  if (!m || m[1] === undefined) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 11 ? n : null;
}

export function classifyMaturity(input: MaturityInput): MaturityResult {
  const t = (input.appropriationType ?? '').toUpperCase();
  const hasBuyLine = t === 'PROC' || input.hasProcurementLink === true;

  if (t === 'PROC') {
    return {
      stage: 'procurement',
      hasBuyLine: true,
      rationale: 'Procurement line item — the program is buying, not just developing.',
    };
  }
  if (t === 'OM') {
    return {
      stage: 'sustainment',
      hasBuyLine,
      rationale: 'Operation & Maintenance line — fielded-system sustainment money.',
    };
  }
  if (t === 'RDT&E' || t.startsWith('RDT')) {
    const ba = parseBudgetActivity(input.budgetActivity);
    const linkNote = hasBuyLine
      ? ' A linked procurement line exists — there is a buy line.'
      : input.hasOmLink
        ? ' A linked O&M line exists — sustainment money is already flowing.'
        : '';
    if (ba === null) {
      return {
        stage: 'unknown',
        hasBuyLine,
        rationale: `RDT&E line without a stated budget activity — stage not classifiable.${linkNote}`,
      };
    }
    if (ba <= 2) {
      return {
        stage: 'early_rnd',
        hasBuyLine,
        rationale: `BA ${ba} — basic/applied research, far from a program of record.${linkNote}`,
      };
    }
    if (ba <= 4) {
      return {
        stage: 'prototype',
        hasBuyLine,
        rationale: `BA ${ba} — advanced technology development / prototyping.${linkNote}`,
      };
    }
    if (ba === 5) {
      return {
        stage: 'system_development',
        hasBuyLine,
        rationale: `BA 5 — system development & demonstration; the on-ramp to procurement.${linkNote}`,
      };
    }
    return {
      stage: 'support_fielded',
      hasBuyLine,
      rationale: `BA ${ba} — management support / operational-system development for fielded programs.${linkNote}`,
    };
  }
  return {
    stage: 'unknown',
    hasBuyLine,
    rationale: 'Appropriation type not stated — maturity not classifiable.',
  };
}
