/**
 * Program Elements Phase L — honest source-family coverage matrix (Phase 7).
 *
 * Status values:
 * - loaded: product path + fixtures exist and may write owned canonical fields
 * - partial: some exhibits/FYs loaded; uncovered slices must stay non-canonical
 * - unsupported: no approved parser in this release; MUST NOT write canonical
 * - blocked: waiting on official fixture/authorization before implementation
 *
 * Unsupported/blocked families always fail closed for canonical writes.
 * Future work is one source family per PR (documented in futurePrHint).
 */
export type PeSourceFamilyStatus = 'loaded' | 'partial' | 'unsupported' | 'blocked';
export interface PeSourceFamilyCoverage {
    /** Stable id used in gates and docs. */
    id: string;
    /** Human label for model + operator surfaces. */
    label: string;
    status: PeSourceFamilyStatus;
    /** When false, no path may promote observations from this family to canonical PE years. */
    canWriteCanonical: boolean;
    notes: string;
    /** Speculative follow-on vehicle — never implies availability today. */
    futurePrHint?: string;
    /** Optional source-key prefixes that map into this family (normalized lowercase). */
    sourceKeyPrefixes?: readonly string[];
}
/**
 * Phase L decisions for closeout. Keep in sync with
 * docs/program-elements/source-coverage-matrix.md.
 */
export declare const PE_SOURCE_FAMILY_COVERAGE: readonly PeSourceFamilyCoverage[];
export declare function getPeSourceFamilyCoverage(id: string): PeSourceFamilyCoverage | undefined;
/** Families that must never become canonical from this release. */
export declare function unsupportedOrBlockedSourceFamilies(): readonly PeSourceFamilyCoverage[];
/**
 * Fail-closed gate: if a source key matches an unsupported/blocked family prefix,
 * canonical ownership is denied even when a looser authority heuristic might guess.
 */
export declare function sourceKeyForbiddenForCanonical(sourceKey: string | null | undefined): boolean;
/** Short model-facing caveat listing unavailable families (no false completeness). */
export declare function peSourceCoverageModelCaveat(): string;
//# sourceMappingURL=pe-source-coverage.d.ts.map