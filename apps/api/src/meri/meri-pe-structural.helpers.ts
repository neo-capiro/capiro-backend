/**
 * Deterministic structural validation for Program Element (PE) claims (P0-7).
 *
 * The grounding verifier (meri-verifier.helpers) answers "do the sources back
 * this claim?" — a retrieval question. It does NOT answer "is this the RIGHT
 * program, and is the strategic framing structurally coherent?" Those are
 * deterministic facts about a PE record (its appropriation type, its budget
 * activity, its mission/title) that an LLM fact-check can miss but a rule check
 * never does.
 *
 * Concretely, these rules catch the two error classes from the Perseus Defense
 * memo forensics:
 *   1. RDT&E-vs-procurement category error — a deliverable that proposes
 *      "directed procurement" of an end item through an RDT&E Program Element.
 *   2. Capability-vs-mission mismatch — a deliverable that anchors a missile/
 *      interceptor strategy to a fire-control-computer PE (the XM32 / LHMBC
 *      "Computer Ballistics" line is a mortar ballistic computer, not a missile).
 *
 * Pure (no I/O; the only import is the @capiro/shared money formatter) so it
 * unit-tests under the repo's `src/**.spec.ts` matcher; the orchestrating
 * service supplies the cited PEs + deliverable text.
 *
 */

import {
  defenseBudgetExhibitLabel,
  fmtFundingMillions,
  isProcurementBudgetLine,
  isRdteBudgetLine,
} from '@capiro/shared';

/** A PE record as returned by the `get_program_element` / search tools. */
export interface PeRecordForValidation {
  peCode: string;
  title?: string | null;
  service?: string | null;
  /** e.g. 'RDT&E', 'Procurement', 'O&M' — free text from the J-books. */
  appropriationType?: string | null;
  /** e.g. '02', '04', or 'BA 04' — the budget-activity code. */
  budgetActivity?: string | null;
  budgetActivityName?: string | null;
  /** Explicit exhibit/line classification when the source provides one. */
  lineType?: string | null;
}

export type PeWarningCode =
  | 'rdte_procurement_mismatch'
  | 'capability_mission_mismatch'
  | 'primary_vehicle_overclaim';

export interface PeStructuralWarning {
  code: PeWarningCode;
  peCode: string;
  /** Human-readable, ready to surface in the verification panel. */
  message: string;
}

/** True when the PE's appropriation/budget-activity marks it an RDT&E line. */
export function isRdtePe(pe: PeRecordForValidation): boolean {
  return isRdteBudgetLine(pe);
}

export function isProcurementPe(pe: PeRecordForValidation): boolean {
  return isProcurementBudgetLine(pe);
}

/** Canonical human exhibit label from @capiro/shared. */
export function budgetExhibitType(pe: PeRecordForValidation): string {
  return defenseBudgetExhibitLabel(pe);
}

/**
 * Phrases that indicate the deliverable is proposing END-ITEM PROCUREMENT
 * (buying units), as opposed to evaluation / demonstration / experimentation.
 */
const PROCUREMENT_INTENT_RE =
  /\b(directed\s+procurement|procurement\s+language|procure(?:ment|s|d|\s+of)?\s+(?:the\s+)?(?:system|missile|interceptor|unit|end[\s-]item)|buy\s+(?:units|systems|missiles)|production\s+procurement)\b/i;

/** Capability nouns that denote a kinetic/weapon end item (not a computer/service). Handles plurals. */
const KINETIC_CAPABILITY_RE =
  /\b(missile|interceptor|munition|kinetic|warhead|projectile|rocket)s?\b/i;

/**
 * PE titles that are clearly NOT a kinetic end item even when "ballistics" or
 * "fire control" appears — these are computers / calculators / software.
 */
const NON_KINETIC_TITLE_RE =
  /\b(computer|calculator|fire[\s-]control|ballistics?\s+computer|handheld|software|data\s+system)\b/i;

/**
 * Validate one cited PE against the deliverable text. Returns 0+ warnings.
 * Conservative: only emits a warning when the structural signal is unambiguous.
 */
export function validatePeAgainstDeliverable(
  pe: PeRecordForValidation,
  deliverableText: string,
): PeStructuralWarning[] {
  const out: PeStructuralWarning[] = [];
  const text = typeof deliverableText === 'string' ? deliverableText : '';

  // Rule 1: RDT&E line + procurement intent => category mismatch.
  if (isRdtePe(pe) && !isProcurementPe(pe) && PROCUREMENT_INTENT_RE.test(text)) {
    out.push({
      code: 'rdte_procurement_mismatch',
      peCode: pe.peCode,
      message:
        `Budget line ${pe.peCode} (${pe.title ?? 'untitled'}) is classified as ` +
        `${defenseBudgetExhibitLabel(pe)}` +
        `${pe.appropriationType ? ` under ${pe.appropriationType}` : ''}, not as a procurement line. ` +
        `The deliverable uses end-item procurement language against it. Use "directed requirement" ` +
        `or "evaluation/demonstration" framing for an RDT&E Program Element, or cite a ` +
        `P-1/P-40 procurement line item.`,
    });
  }

  // Rule 2: capability/mission mismatch — deliverable is about a kinetic end
  // item, but the PE title is a computer / fire-control / software line.
  const title = pe.title ?? '';
  if (
    KINETIC_CAPABILITY_RE.test(text) &&
    NON_KINETIC_TITLE_RE.test(title) &&
    !KINETIC_CAPABILITY_RE.test(title)
  ) {
    out.push({
      code: 'capability_mission_mismatch',
      peCode: pe.peCode,
      message:
        `Budget line ${pe.peCode} (${defenseBudgetExhibitLabel(pe)}) is titled "${title}", ` +
        `which is a fire-control / computer / software line — not a kinetic interceptor or ` +
        `missile program. The deliverable's capability (missile/interceptor/kinetic) does not ` +
        `match this line's mission. Verify the correct budget line before anchoring strategy to it.`,
    });
  }

  return out;
}

/**
 * A PE dollar figure for size comparisons — $ MILLIONS (the project-wide money
 * convention), tagged with the fiscal year and stage it came from so the
 * warning message never presents an unlabeled or cross-vintage comparison
 * (RC1: every model-visible figure carries its {fy, stage, vehicle}).
 */
export interface PeAmountForComparison {
  peCode: string;
  title?: string | null;
  /** $ MILLIONS. */
  amountM: number | null;
  /** Fiscal year of the amount (e.g. 2027). Required — comparisons are same-FY only. */
  fy: number | null;
  /** Stage the amount came from (e.g. 'HAC-D mark', 'Enacted', 'Request'). */
  stageLabel?: string | null;
  /** Legislative vehicle: 'authorization' | 'appropriations' | 'request'. */
  vehicleLabel?: string | null;
  identifierKind?: 'pe' | 'procurement_line_item' | 'other' | null;
  budgetExhibitType?: string | null;
}

function comparisonLineLabel(p: PeAmountForComparison): string {
  const exhibit = (p.budgetExhibitType ?? '').toLowerCase();
  if (p.identifierKind === 'procurement_line_item' || exhibit.includes('procurement')) {
    return `procurement line item ${p.peCode}`;
  }
  if (p.identifierKind === 'pe' || /^\d{7}[A-Z][A-Z0-9]*$/i.test(p.peCode)) {
    return `PE ${p.peCode}`;
  }
  if (/^\d{4}[A-Z]{1,2}[0-9A-Z]{2,14}$/i.test(p.peCode)) {
    return `procurement line item ${p.peCode}`;
  }
  return `budget line ${p.peCode}`;
}

/** "$57.2M (FY27 HAC-D mark — appropriations)" — the labeled figure for messages. */
function describeComparisonAmount(p: PeAmountForComparison): string {
  const parts = [
    p.fy != null ? `FY${String(p.fy).slice(-2)}` : null,
    p.stageLabel ?? null,
    p.vehicleLabel ? `— ${p.vehicleLabel}` : null,
  ].filter(Boolean);
  return `${fmtFundingMillions(p.amountM)}${parts.length ? ` (${parts.join(' ')})` : ''}`;
}

/**
 * Flag a "primary funding vehicle" overclaim: the deliverable calls a PE the
 * "primary" lane, but a materially larger sibling PE exists in the same
 * portfolio. Comparisons are SAME-FISCAL-YEAR only — a sibling whose figure is
 * from a different (or unknown) FY is skipped rather than compared — and the
 * warning renders both sides with their FY + stage + vehicle labels so the
 * sizes being compared are never ambiguous. Amounts are $ MILLIONS.
 */
export function validatePrimaryVehicleClaim(
  citedPe: PeAmountForComparison,
  deliverableText: string,
  siblings: PeAmountForComparison[],
  // A sibling this many times larger makes "primary" indefensible.
  factor = 3,
): PeStructuralWarning | null {
  const text = typeof deliverableText === 'string' ? deliverableText : '';
  const claimsPrimary =
    /\bprimary\b[^.]*\b(vehicle|lane|line|account|program)\b/i.test(text) ||
    /\b(vehicle|lane|line|account|program)\b[^.]*\bprimary\b/i.test(text);
  if (!claimsPrimary) return null;
  const base = citedPe.amountM;
  // No amount, or no FY to anchor a same-vintage comparison → nothing to assert.
  if (base == null || base <= 0 || citedPe.fy == null) return null;
  const bigger = siblings
    .filter(
      (s) =>
        s.peCode !== citedPe.peCode &&
        s.amountM != null &&
        s.fy === citedPe.fy && // same-FY comparisons only — never cross-vintage
        s.amountM > base * factor,
    )
    .sort((a, b) => (b.amountM ?? 0) - (a.amountM ?? 0));
  if (!bigger.length) return null;
  const top = bigger[0];
  if (!top) return null;
  return {
    code: 'primary_vehicle_overclaim',
    peCode: citedPe.peCode,
    message:
      `The deliverable frames ${comparisonLineLabel(citedPe)} as the "primary" vehicle, but ` +
      `${comparisonLineLabel(top)}${top.title ? ` (${top.title})` : ''} is materially larger in the same fiscal year ` +
      `(${describeComparisonAmount(top)} vs ${describeComparisonAmount(citedPe)}). Drop the ` +
      `"primary" framing or re-anchor to the larger line.`,
  };
}

/** Aggregate all PE structural warnings for a deliverable. */
export function collectPeStructuralWarnings(
  pes: PeRecordForValidation[],
  deliverableText: string,
): PeStructuralWarning[] {
  const out: PeStructuralWarning[] = [];
  for (const pe of pes) out.push(...validatePeAgainstDeliverable(pe, deliverableText));
  return out;
}
