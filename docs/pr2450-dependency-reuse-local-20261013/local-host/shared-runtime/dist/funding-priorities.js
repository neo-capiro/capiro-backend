"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_FUNDING_PRIORITY_LENGTH = exports.MAX_FUNDING_PRIORITIES = void 0;
exports.normalizeFundingPriorities = normalizeFundingPriorities;
exports.fundingPrioritiesFromIntake = fundingPrioritiesFromIntake;
/** Concrete projects/outcomes a client wants to fund, stored in intakeData. */
exports.MAX_FUNDING_PRIORITIES = 20;
exports.MAX_FUNDING_PRIORITY_LENGTH = 120;
/**
 * Defensive reader for existing JSON. Writers validate the bounds before saving;
 * old or malformed intake data must never break matching or create unbounded work.
 */
function normalizeFundingPriorities(value) {
    if (!Array.isArray(value))
        return [];
    const priorities = [];
    const seen = new Set();
    for (const entry of value) {
        if (typeof entry !== 'string')
            continue;
        const phrase = entry.trim().replace(/\s+/g, ' ');
        if (!phrase || phrase.length > exports.MAX_FUNDING_PRIORITY_LENGTH)
            continue;
        const key = phrase.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        priorities.push(phrase);
        if (priorities.length === exports.MAX_FUNDING_PRIORITIES)
            break;
    }
    return priorities;
}
/** Read only the explicit priority list; legacy fundingAsk is a different field. */
function fundingPrioritiesFromIntake(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return [];
    return normalizeFundingPriorities(value.fundingPriorities);
}
//# sourceMappingURL=funding-priorities.js.map