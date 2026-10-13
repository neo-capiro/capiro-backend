"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registrationConflicts = registrationConflicts;
exports.normalizeEin = normalizeEin;
exports.isValidEin = isValidEin;
exports.normalizeNaicsCodes = normalizeNaicsCodes;
exports.readRegistrationNaics = readRegistrationNaics;
exports.reconcileRegistrationNaics = reconcileRegistrationNaics;
function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
const key = (value) => value.trim().replace(/\s+/g, ' ').toLowerCase();
function registrationConflicts(profile) {
    const types = new Set((profile.applicantTypes ?? []).filter((v) => typeof v === 'string').map(key));
    const has = (value) => types.has(key(value));
    const sb = record(record(profile.intakeData).sbClassification);
    const smallClassification = ['sb', 'wosb', 'sdvosb', 'hubzone', 'eightA', 'eight_a', '8a'].some((flag) => sb[flag] === true) || Boolean(profile.setAsideCertifications?.length);
    const largeClassification = sb.large === true;
    const small = has('Small businesses') || smallClassification;
    const large = has('For profit organizations other than small businesses') || largeClassification;
    const nonprofitWith = has('Nonprofits having a 501(c)(3) status with the IRS, other than institutions of higher education');
    const nonprofitWithout = has('Nonprofits that do not have a 501(c)(3) status with the IRS, other than institutions of higher education');
    const conflicts = [];
    if (nonprofitWith && nonprofitWithout)
        conflicts.push({
            code: 'nonprofit-tax-status',
            blocking: true,
            message: 'Choose either nonprofit with or without 501(c)(3) status for this client; both tax statuses cannot apply to the same entity at the same time.',
        });
    if (has('Public and State controlled institutions of higher education') &&
        has('Private institutions of higher education'))
        conflicts.push({
            code: 'college-control',
            blocking: true,
            message: 'Choose the current public or private college/university category for this entity.',
        });
    if ((nonprofitWith || nonprofitWithout) &&
        (has('Small businesses') || has('For profit organizations other than small businesses')))
        conflicts.push({
            code: 'profit-status',
            blocking: true,
            message: 'For-profit and nonprofit selections conflict for one legal entity. Keep only the current organization type for this client.',
        });
    if ((nonprofitWith || nonprofitWithout) && (smallClassification || largeClassification))
        conflicts.push({
            code: 'nonprofit-business-classification',
            blocking: false,
            message: 'A nonprofit organization type and business classifications or set-aside certifications are both saved. Verify which facts belong to this legal entity, rather than an affiliate, before relying on eligibility.',
        });
    if (small && large)
        conflicts.push({
            code: 'business-size',
            blocking: false,
            message: 'Small and large business classifications are both saved. Size can vary by NAICS code; verify the applicable size standard and certifications before relying on eligibility.',
        });
    if (has('Individuals') && types.size > 1)
        conflicts.push({
            code: 'individual-organization',
            blocking: false,
            message: 'Individual and organization categories are both saved. Confirm whether applications belong to the person or the organization.',
        });
    if ((small || large) && [...types].some((value) => /governments|housing authorities/.test(value)))
        conflicts.push({
            code: 'government-business',
            blocking: false,
            message: 'Government and business classifications are both saved. Verify that these describe this legal entity, rather than its owner or an affiliate.',
        });
    return conflicts;
}
/** Empty is allowed. Accept the standard hyphenated or nine-digit form only. */
function normalizeEin(value) {
    if (value == null || (typeof value === 'string' && !value.trim()))
        return undefined;
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return /^\d{2}-?\d{7}$/.test(trimmed) ? trimmed.replace('-', '') : undefined;
}
function isValidEin(value) {
    return (value == null ||
        (typeof value === 'string' && (!value.trim() || normalizeEin(value) !== undefined)));
}
function normalizeNaicsCodes(value) {
    const entries = Array.isArray(value)
        ? value
        : typeof value === 'string'
            ? value.split(/[\s,;]+/)
            : [];
    return [
        ...new Set(entries
            .filter((v) => typeof v === 'string')
            .map((v) => v.trim().toUpperCase())
            .filter(Boolean)),
    ];
}
const primaryKeys = ['primaryNaics', 'primary_naics'];
const genericKeys = ['naics'];
const additionalKeys = ['additionalNaics', 'additional_naics'];
function legacyNaicsCodes(value) {
    // Older forms saved "541512 · Computer Systems Design Services". Only the
    // leading code is an identifier; words in its description are never codes.
    return [
        ...new Set((value ?? '').split(/[,;\n]+/).flatMap((part) => {
            if (/^\s*\d{2,6}(?:\s+\d{2,6})*\s*$/.test(part))
                return part.trim().split(/\s+/);
            const code = part.trim().match(/^(\d{2,6})(?=$|[\s·—–-])/);
            return code ? [code[1]] : [];
        })),
    ];
}
function legacyCodesForKeys(intake, keys) {
    return keys.flatMap((field) => legacyNaicsCodes(typeof intake[field] === 'string' ? intake[field] : undefined));
}
/** An existing canonical array (including []) always wins over legacy fields. */
function readRegistrationNaics(profile) {
    const intake = record(profile.intakeData);
    const primaryCodes = legacyCodesForKeys(intake, primaryKeys);
    const explicitPrimary = primaryCodes[0];
    // Legacy imports can carry several codes in any alias, including `naics`.
    // Retain every identifier while treating only an explicitly primary field
    // as evidence that a particular code was selected as primary.
    const legacy = normalizeNaicsCodes([
        ...primaryCodes,
        ...legacyCodesForKeys(intake, genericKeys),
        ...legacyCodesForKeys(intake, additionalKeys),
    ]);
    const canonical = Array.isArray(profile.naicsCodes);
    const codes = canonical ? normalizeNaicsCodes(profile.naicsCodes) : legacy;
    const primary = explicitPrimary && codes.includes(explicitPrimary) ? explicitPrimary : undefined;
    return {
        codes,
        primary,
        legacyCodes: legacy,
        legacyOnly: !canonical && legacy.length > 0,
        disagreement: canonical && legacy.some((code) => !codes.includes(code)),
    };
}
/** Keep an explicitly selected primary only while it remains in the saved list. */
function reconcileRegistrationNaics(intakeValue, codesValue) {
    const intake = { ...record(intakeValue) };
    const codes = normalizeNaicsCodes(codesValue);
    const explicitPrimary = legacyCodesForKeys(intake, primaryKeys)[0];
    for (const field of [...primaryKeys, ...genericKeys, ...additionalKeys])
        delete intake[field];
    if (explicitPrimary && codes.includes(explicitPrimary)) {
        intake.primaryNaics = explicitPrimary;
        const additional = codes.filter((code) => code !== explicitPrimary);
        if (additional.length)
            intake.additionalNaics = additional.join(', ');
    }
    return intake;
}
//# sourceMappingURL=client-registration-integrity.js.map