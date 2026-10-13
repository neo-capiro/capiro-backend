/** Concrete projects/outcomes a client wants to fund, stored in intakeData. */
export declare const MAX_FUNDING_PRIORITIES = 20;
export declare const MAX_FUNDING_PRIORITY_LENGTH = 120;
/**
 * Defensive reader for existing JSON. Writers validate the bounds before saving;
 * old or malformed intake data must never break matching or create unbounded work.
 */
export declare function normalizeFundingPriorities(value: unknown): string[];
/** Read only the explicit priority list; legacy fundingAsk is a different field. */
export declare function fundingPrioritiesFromIntake(value: unknown): string[];
//# sourceMappingURL=funding-priorities.d.ts.map