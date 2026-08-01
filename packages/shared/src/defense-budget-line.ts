/**
 * Shared defense-budget line identity + domain primer (Program Elements Phase 7 / Phase J).
 * One contract for apps/api Meri tools and Workspace generation. MeriV2-core is not edited
 * in this closeout PR; it may import the same helpers later via @capiro/shared.
 *
 * Rules: never classify RDT&E from BA4 alone; never call procurement lines Program Elements.
 */
export interface DefenseBudgetLineIdentity {
  peCode: string;
  appropriationType?: string | null;
  budgetActivity?: string | null;
  lineType?: string | null;
}

export type DefenseBudgetLineKind = 'rdte' | 'procurement' | 'unknown';

function normalizeDefenseBudgetToken(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function explicitDefenseBudgetLineKind(lineType: string | null | undefined): DefenseBudgetLineKind {
  const value = normalizeDefenseBudgetToken(lineType);
  if (!value) return 'unknown';
  if (
    value === 'rdte' ||
    value === 'rdt_and_e' ||
    value === 'r_d_t_e' ||
    value === 'r_1' ||
    value === 'r1' ||
    value === 'r_2' ||
    value === 'r2' ||
    value === 'program_element' ||
    value === 'rdte_program_element' ||
    value === 'rdte_pe' ||
    value === 'research_development_test_and_evaluation'
  ) {
    return 'rdte';
  }
  if (
    value === 'procurement' ||
    value === 'p_1' ||
    value === 'p1' ||
    value === 'p_40' ||
    value === 'p40' ||
    value === 'procurement_line' ||
    value === 'procurement_line_item' ||
    value === 'procurement_blin'
  ) {
    return 'procurement';
  }
  return 'unknown';
}

function appropriationDefenseBudgetLineKind(
  appropriationType: string | null | undefined,
): DefenseBudgetLineKind {
  const value = normalizeDefenseBudgetToken(appropriationType);
  if (!value) return 'unknown';
  if (
    value === 'rdte' ||
    value === 'rdt_and_e' ||
    value === 'r_d_t_e' ||
    value.includes('research_development') ||
    value.includes('research_and_development')
  ) {
    return 'rdte';
  }
  if (value === 'proc' || value.includes('procurement')) return 'procurement';
  return 'unknown';
}

function codeShapeDefenseBudgetLineKind(peCode: string): DefenseBudgetLineKind {
  const code = peCode.trim().toUpperCase();
  if (/^\d{7}[A-Z][A-Z0-9]*$/.test(code)) return 'rdte';
  if (/^\d{4}[A-Z]{1,2}[0-9A-Z]{2,14}$/.test(code)) return 'procurement';
  return 'unknown';
}

export function defenseBudgetLineKind(input: DefenseBudgetLineIdentity): DefenseBudgetLineKind {
  const explicit = explicitDefenseBudgetLineKind(input.lineType);
  if (explicit !== 'unknown') return explicit;
  const appropriation = appropriationDefenseBudgetLineKind(input.appropriationType);
  if (appropriation !== 'unknown') return appropriation;
  return codeShapeDefenseBudgetLineKind(input.peCode);
}

/** True only when explicit type, appropriation, or validated R-1/R-2 code shape supports RDT&E. */
export function isRdteBudgetLine(input: DefenseBudgetLineIdentity): boolean {
  return defenseBudgetLineKind(input) === 'rdte';
}

/** True only when explicit type, appropriation, or validated P-1/P-40 code shape supports procurement. */
export function isProcurementBudgetLine(input: DefenseBudgetLineIdentity): boolean {
  return defenseBudgetLineKind(input) === 'procurement';
}

/** Human-facing exhibit noun. It never calls an unclassified line a Program Element. */
export function defenseBudgetExhibitLabel(input: DefenseBudgetLineIdentity): string {
  const kind = defenseBudgetLineKind(input);
  if (kind === 'rdte') return 'R-1/R-2 RDT&E Program Element';
  if (kind === 'procurement') return 'P-1/P-40 procurement line item (NOT a Program Element)';
  return 'budget line (exhibit type not classified)';
}

/**
 * Canonical compact primer injected into every model-facing defense-budget surface.
 * Keep below 2,000 characters; tests enforce both the content and the bound.
 */
export const DEFENSE_BUDGET_DOMAIN_PRIMER = [
  'DEFENSE BUDGET STRUCTURE — validate, never assume:',
  '• A Program Element is the R-1/R-2 RDT&E construct. Confirm the line type and appropriation before calling any stored budget-line code a PE.',
  '• Procurement lines are P-1/P-40 line items, not Program Elements. Use the exhibit label returned by the tools.',
  '• RDT&E contains multiple budget activities; Budget Activity 4 alone does not establish that an otherwise unknown line is RDT&E.',
  '• Procurement accounts and budget activities vary; “Procurement BA 2” is not a universal classification rule.',
  '• Authorization and appropriations are separate tracks. NDAA policy or authorization language and appropriations programmatic or report-language requests may each be relevant; verify the current committee process, eligibility, and request window before recommending a pathway.',
  '• Cite only the fiscal year labeled current as the current request. A later request-only year is an FYDP outyear projection, not the current ask.',
  '• Never state why a mark changed without linked report-language evidence. Missing language means the justification is absent from Capiro’s loaded source coverage, not that no language exists.',
  '• Do not call a line the primary vehicle without a same-fiscal-year comparison to relevant sibling lines.',
  '• A procurement POC may be shown as program context but must never be recommended as a lobbying target.',
  '• Match the line’s stated mission to the client capability; a title or dollar delta alone is not evidence of fit.',
  '• Do not imply source families marked unsupported or blocked in the PE coverage matrix are loaded in Capiro.',
].join('\n');
