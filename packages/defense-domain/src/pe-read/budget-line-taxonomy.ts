/**
 * Budget-line taxonomy: appropriation-type -> line type, and line type -> entry
 * wedge. Hoisted from the module-level `LINE_TYPE_FOR` / `WEDGE_FOR` constants in
 * `apps/api/src/program-element/budget-lines-read.service.ts`.
 *
 * NATIVE IDENTITY NOTE: `lineTypeForAppropriationType` CLASSIFIES a line by the
 * color of money its appropriation carries. It does NOT translate one identity
 * into another — it never derives a BLIN from a PE code, and the value it returns
 * is a category label ('PROCUREMENT_BLIN'), not an identifier. Any actual
 * PE <-> BLIN association must still go through a governed crosswalk with
 * provenance.
 */

export type BudgetLineType =
  | 'RDTE_PE'
  | 'PROCUREMENT_BLIN'
  | 'OM_BLI'
  | 'MILCON_PROJECT'
  | 'TRANSFER'
  | 'CLASSIFIED';

export function lineTypeForAppropriationType(
  appropriationType: string | null | undefined,
): string | null {
  const t = (appropriationType ?? '').toUpperCase();
  if (t.startsWith('RDT')) return 'RDTE_PE';
  if (t === 'PROC') return 'PROCUREMENT_BLIN';
  if (t === 'OM') return 'OM_BLI';
  return null;
}

/** Entry wedge (F25) implied by a line's type — how a seller gets in. */
export const WEDGE_FOR: Readonly<Record<string, string>> = {
  PROCUREMENT_BLIN: 'procurement-transition',
  RDTE_PE: 'rdte-eval',
  OM_BLI: 'om-services',
  MILCON_PROJECT: 'report-language',
  TRANSFER: 'ota-sbir-diu',
  CLASSIFIED: 'urgent-need',
};

/** apps/api's fallback when a line has no resolvable line type. */
export const DEFAULT_WEDGE = 'rdte-eval';

export function wedgeForLineType(lineType: string | null | undefined): string {
  return lineType ? (WEDGE_FOR[lineType] ?? DEFAULT_WEDGE) : DEFAULT_WEDGE;
}
