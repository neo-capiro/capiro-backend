"use strict";
// ---------------------------------------------------------------------------
// Canonical defense-budget money normalization
// ---------------------------------------------------------------------------
//
// ProgramElementYear and every downstream funding surface store USD millions.
// Extractors must preserve the exact printed value/unit separately, then call
// this helper before a value is allowed into a canonical money field.
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeMoneyToMillions = normalizeMoneyToMillions;
/**
 * Normalize a finite source value into the Program Elements canonical unit:
 * USD millions. Zero and negative values are real values and are preserved.
 */
function normalizeMoneyToMillions(value, unit) {
    if (!Number.isFinite(value)) {
        throw new TypeError(`Money value must be finite; received ${String(value)}`);
    }
    switch (unit) {
        case 'dollars':
            return {
                valueM: value / 1_000_000,
                originalValue: value,
                originalUnit: unit,
                conversion: 'dollars_to_millions',
            };
        case 'thousands':
            return {
                valueM: value / 1_000,
                originalValue: value,
                originalUnit: unit,
                conversion: 'thousands_to_millions',
            };
        case 'millions':
            return {
                valueM: value,
                originalValue: value,
                originalUnit: unit,
                conversion: 'identity',
            };
        default: {
            // TypeScript proves this unreachable for typed callers, but extractor units
            // originate in parsed PDF/vendor text. Without this branch an unrecognized
            // unit fell out of the switch and returned `undefined`, so a caller using
            // optional chaining or a default could turn an unconvertible figure into a
            // canonical funding value. Unknown units must fail loudly instead.
            const unrecognized = unit;
            throw new TypeError(`Unsupported money unit: ${JSON.stringify(unrecognized)}. Expected 'dollars', 'thousands', or 'millions'.`);
        }
    }
}
//# sourceMappingURL=money.js.map