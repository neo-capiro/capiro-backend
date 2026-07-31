/**
 * Domain grounding for the Workspace generation engine. The defense-budget
 * primer and line classifier come from @capiro/shared so Workspace, Meri, and
 * MeriV2 cannot drift.
 *
 * Three concerns:
 *  1. DOMAIN_PRIMER — budget-structure invariants (RDT&E vs procurement, NDAA vs
 *     appropriations, validate-the-PE) injected into the generation prompt so the
 *     WRITER has the structural knowledge ChatGPT had "for free".
 *  2. collectPeStructuralWarnings — deterministic post-generation checks that
 *     catch the Perseus-memo error classes (RDT&E/procurement category error,
 *     capability/mission mismatch, primary-vehicle overclaim) the model can
 *     still make.
 *  3. validatePrimaryVehicleClaim — Rule 3 (see below), given a same-portfolio
 *     amount comparison the CALLER assembles (PeResolverService derives
 *     PeAmountForComparison from AuthoritativePeRecord.years using the shared
 *     canonical funding precedence, since this engine's PE view carries only
 *     request/enacted/hascMark/sascMark, not the full appropriations ladder).
 */
import {
  DEFENSE_BUDGET_DOMAIN_PRIMER,
  defenseBudgetExhibitLabel,
  fmtFundingMillions,
  isProcurementBudgetLine,
  isRdteBudgetLine,
} from '@capiro/shared';

/** Canonical primer re-exported for existing generation-service imports. */
export const DOMAIN_PRIMER = DEFENSE_BUDGET_DOMAIN_PRIMER;

/** A PE record as carried on the draft config's linkedProgramElements. */
export interface PeRecordForValidation {
  peCode: string;
  title?: string | null;
  service?: string | null;
  appropriationType?: string | null;
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
  message: string;
}

export function isRdtePe(pe: PeRecordForValidation): boolean {
  return isRdteBudgetLine(pe);
}

export function isProcurementPe(pe: PeRecordForValidation): boolean {
  return isProcurementBudgetLine(pe);
}

const PROCUREMENT_INTENT_RE =
  /\b(directed\s+procurement|procurement\s+language|procure(?:ment|s|d|\s+of)?\s+(?:the\s+)?(?:system|missile|interceptor|unit|end[\s-]item)|buy\s+(?:units|systems|missiles)|production\s+procurement)\b/i;

const KINETIC_CAPABILITY_RE =
  /\b(missile|interceptor|munition|kinetic|warhead|projectile|rocket)s?\b/i;

const NON_KINETIC_TITLE_RE =
  /\b(computer|calculator|fire[\s-]control|ballistics?\s+computer|handheld|software|data\s+system)\b/i;

export function validatePeAgainstDeliverable(
  pe: PeRecordForValidation,
  deliverableText: string,
): PeStructuralWarning[] {
  const out: PeStructuralWarning[] = [];
  const text = typeof deliverableText === 'string' ? deliverableText : '';

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

// Extract distinct PE codes AND procurement line-item codes (BLINs) cited in
// text. Consolidated into @capiro/shared (RC2) so the accepted code shape can't
// drift between this generation engine, apps/api and the orchestrator;
// re-exported here so existing importers are unchanged.
export { extractCitedPeCodes } from '@capiro/shared';

/**
 * A PE dollar figure for size comparisons — $ MILLIONS (the project-wide money
 * convention), tagged with the fiscal year and stage it came from so the
 * warning message never presents an unlabeled or cross-vintage comparison.
 * Verbatim port of apps/api/src/meri/meri-pe-structural.helpers.ts's type.
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
 * portfolio. Comparisons are SAME-FISCAL-YEAR only. Verbatim port of
 * apps/api/src/meri/meri-pe-structural.helpers.ts's Rule 3.
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

/**
 * Aggregate PE structural warnings for a generated deliverable. `amounts`
 * (optional — omitted when the caller has no resolved figures) enables Rule 3
 * (primary-vehicle overclaim): every PE with an amount entry is checked
 * against every OTHER PE with an amount entry as its sibling pool.
 */
export function collectPeStructuralWarnings(
  pes: PeRecordForValidation[],
  deliverableText: string,
  amounts: PeAmountForComparison[] = [],
): PeStructuralWarning[] {
  const out: PeStructuralWarning[] = [];
  for (const pe of pes) out.push(...validatePeAgainstDeliverable(pe, deliverableText));
  for (const amt of amounts) {
    const warning = validatePrimaryVehicleClaim(
      amt,
      deliverableText,
      amounts.filter((s) => s.peCode !== amt.peCode),
    );
    if (warning) out.push(warning);
  }
  return out;
}
