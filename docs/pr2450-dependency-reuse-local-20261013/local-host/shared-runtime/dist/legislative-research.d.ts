/** Public, deterministic evidence contracts. Citation identity is never numeric. */
export type LegalReference = {
    jurisdiction: string;
    code: 'statute' | 'constitution' | 'administrative_rule';
    kind: 'chapter' | 'section' | 'subsection' | 'article' | 'rule';
    chapter: string | null;
    section: string | null;
    subdivisions: string[];
};
export declare function legalReferenceKey(ref: LegalReference): string;
export declare function parseFloridaCitation(raw: string): LegalReference | null;
export declare function parseFloridaConstitutionCitation(raw: string): LegalReference | null;
export declare function legalTargetMatches(target: LegalReference, occurrence: LegalReference, descendants: boolean): boolean;
export type LegalRelation = 'cites' | 'proposes_amend' | 'proposes_repeal' | 'proposes_create' | 'proposes_renumber' | 'reenacts' | 'unresolved';
export type CitationOccurrence = {
    reference: LegalReference;
    start: number;
    end: number;
    quote: string;
    relation: LegalRelation;
    basis: 'citation' | 'explicit_operative_wording';
};
/** Deliberately conservative: a title, analysis, or quoted existing text cannot establish an operative effect. */
export declare function floridaCitationOccurrences(text: string, kind: 'bill_text' | 'amendment_text' | 'analysis' | 'title'): {
    occurrences: CitationOccurrence[];
    unresolved: string[];
};
export type ResearchSection = {
    locator: string;
    text: string;
    hash: string;
};
export type ResearchVersion = {
    id: string;
    billId: string;
    jurisdiction: string;
    sessionKey: string;
    revision: string;
    contentHash: string;
    extractorVersion: string;
    sourceUrl: string | null;
    kind: string;
    publishedDate: string | null;
    observedAt: string;
    complete: boolean;
    sections: ResearchSection[];
};
export type ComparisonLine = {
    kind: 'unchanged' | 'removed' | 'added';
    text: string;
    left: {
        locator: string;
        start: number;
        end: number;
    } | null;
    right: {
        locator: string;
        start: number;
        end: number;
    } | null;
};
/** Bounded exact line comparison; original source offsets survive whitespace changes. */
export declare function compareResearchVersions(left: ResearchVersion, right: ResearchVersion, allowCrossBill?: boolean): {
    version: string;
    left: {
        sections: undefined;
        id: string;
        billId: string;
        jurisdiction: string;
        sessionKey: string;
        revision: string;
        contentHash: string;
        extractorVersion: string;
        sourceUrl: string | null;
        kind: string;
        publishedDate: string | null;
        observedAt: string;
        complete: boolean;
    };
    right: {
        sections: undefined;
        id: string;
        billId: string;
        jurisdiction: string;
        sessionKey: string;
        revision: string;
        contentHash: string;
        extractorVersion: string;
        sourceUrl: string | null;
        kind: string;
        publishedDate: string | null;
        observedAt: string;
        complete: boolean;
    };
    changes: ComparisonLine[];
    classification: string;
    warning: string;
};
export declare function validDateOnly(value: string): boolean;
//# sourceMappingURL=legislative-research.d.ts.map