import type { ReportAudience } from "./dto/report-export.dto.js";
import type { ReportContextDocument, ReportContextFact, ReportNarrativeSection } from "./report.types.js";
export interface ReportContextDocumentInput {
    id: string;
    title: string;
    templateKey: string;
    content: string;
    frontmatter: unknown;
    validUntil: Date | null;
    updatedAt: Date;
    facts: Array<{
        id: string;
        fact: string;
        sourceRef: string;
        authority: string | null;
        asOf: Date | null;
        confidence: number | null;
    }>;
}
/**
 * Convert active context-pack documents into complete, audience-safe executive
 * briefing material. This is deliberately deterministic: it preserves authored
 * statements and table rows without asking an LLM to fill gaps or infer facts.
 * Capacity enforcement belongs to the snapshot loader so an oversized report
 * fails explicitly instead of this assembler silently sampling approved input.
 */
export declare function assembleReportContext(documents: readonly ReportContextDocumentInput[], audience: ReportAudience, asOf: string): {
    documents: ReportContextDocument[];
    facts: ReportContextFact[];
    sections: ReportNarrativeSection[];
    excludedDocuments: number;
};
export declare function isClientSafeContextFrontmatter(frontmatter: unknown): boolean;
//# sourceMappingURL=report-context.d.ts.map