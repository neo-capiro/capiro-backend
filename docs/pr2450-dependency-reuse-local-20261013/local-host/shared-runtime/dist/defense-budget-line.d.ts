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
export declare function defenseBudgetLineKind(input: DefenseBudgetLineIdentity): DefenseBudgetLineKind;
/** True only when explicit type, appropriation, or validated R-1/R-2 code shape supports RDT&E. */
export declare function isRdteBudgetLine(input: DefenseBudgetLineIdentity): boolean;
/** True only when explicit type, appropriation, or validated P-1/P-40 code shape supports procurement. */
export declare function isProcurementBudgetLine(input: DefenseBudgetLineIdentity): boolean;
/** Human-facing exhibit noun. It never calls an unclassified line a Program Element. */
export declare function defenseBudgetExhibitLabel(input: DefenseBudgetLineIdentity): string;
/**
 * Canonical compact primer injected into every model-facing defense-budget surface.
 * Keep below 2,000 characters; tests enforce both the content and the bound.
 */
export declare const DEFENSE_BUDGET_DOMAIN_PRIMER: string;
//# sourceMappingURL=defense-budget-line.d.ts.map