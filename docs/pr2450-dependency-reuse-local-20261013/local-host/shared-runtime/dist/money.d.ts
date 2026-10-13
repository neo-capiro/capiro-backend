export type MoneyUnit = 'dollars' | 'thousands' | 'millions';
export interface NormalizedMoneyMillions {
    /** Canonical value in USD millions. Never rounded by this helper. */
    valueM: number;
    /** Exact numeric value supplied by the source/extractor. */
    originalValue: number;
    /** Unit printed by the source. */
    originalUnit: MoneyUnit;
    /** Explicit conversion applied to produce valueM. */
    conversion: 'identity' | 'dollars_to_millions' | 'thousands_to_millions';
}
/**
 * Normalize a finite source value into the Program Elements canonical unit:
 * USD millions. Zero and negative values are real values and are preserved.
 */
export declare function normalizeMoneyToMillions(value: number, unit: MoneyUnit): NormalizedMoneyMillions;
//# sourceMappingURL=money.d.ts.map