/** Registration facts are user/source supplied; these checks do not verify legal identity. */
export interface RegistrationConflict {
    code: string;
    message: string;
    blocking: boolean;
}
export declare function registrationConflicts(profile: {
    applicantTypes?: readonly string[] | null;
    setAsideCertifications?: readonly string[] | null;
    intakeData?: unknown;
}): RegistrationConflict[];
/** Empty is allowed. Accept the standard hyphenated or nine-digit form only. */
export declare function normalizeEin(value: unknown): string | undefined;
export declare function isValidEin(value: unknown): boolean;
export declare function normalizeNaicsCodes(value: unknown): string[];
/** An existing canonical array (including []) always wins over legacy fields. */
export declare function readRegistrationNaics(profile: {
    naicsCodes?: readonly string[] | null;
    intakeData?: unknown;
}): {
    codes: string[];
    primary: string | undefined;
    legacyCodes: string[];
    legacyOnly: boolean;
    disagreement: boolean;
};
/** Keep an explicitly selected primary only while it remains in the saved list. */
export declare function reconcileRegistrationNaics(intakeValue: unknown, codesValue: unknown): Record<string, unknown>;
//# sourceMappingURL=client-registration-integrity.d.ts.map