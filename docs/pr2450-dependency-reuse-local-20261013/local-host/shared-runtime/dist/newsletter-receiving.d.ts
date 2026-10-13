/** Pure receiving contracts. These parsers validate wire data, never authorize an action. */
import type { NewsletterCampaign, NewsletterCampaignConfig, NewsletterCheck, NewsletterDesign, NewsletterStage } from './newsletter.js';
/** Canonical immutable draft response vocabulary; policy remains in the Core owner. */
export type DraftGenerationStatus = 'generated' | 'manually_authored' | 'generation_failed';
export type DraftAuditStatus = 'not_required' | 'pending' | 'passed' | 'warning' | 'held' | 'unavailable';
export type DraftApprovalStatus = 'not_required' | 'pending' | 'approved' | 'rejected';
/** One check name + severity. Never spans, evidence or raw auditor internals. */
export interface DraftAuditCheckDto {
    check: string;
    severity: string;
}
export interface OutreachDraftVersionDto {
    id: string;
    artifactId: string;
    outreachRecordId: string;
    version: number;
    sourceVersionId: string | null;
    generationKey: string;
    recipientKey: string;
    audienceKind: string;
    subject: string;
    body: string;
    contentHash: string;
    generationStatus: DraftGenerationStatus;
    auditStatus: DraftAuditStatus;
    approvalStatus: DraftApprovalStatus;
    auditDecision: string | null;
    auditChecks: DraftAuditCheckDto[];
    reviewRequestId: string | null;
    provider: string | null;
    model: string | null;
    promptSpecVersion: string | null;
    /** Server-derived lifecycle fact, not a receiving-parser permission decision. */
    sendable: boolean;
    createdAt: string;
    contextNote?: string;
}
export interface NewsletterDocumentList {
    items: NewsletterCampaign[];
}
/** Saved-state rendering; the owner does not return a document/revision token here. */
export interface NewsletterPreview {
    html: string;
    plainText: string;
    checks: NewsletterCheck[];
}
export type NewsletterJson = null | boolean | number | string | NewsletterJson[] | NewsletterJsonObject;
export interface NewsletterJsonObject {
    [key: string]: NewsletterJson;
}
export interface NewsletterHtmlCheck {
    provider: 'Mailtrap';
    issues: string[];
    report: NewsletterJsonObject;
    revision: number;
    checkedAt: string;
}
/** Owned immutable rich-stage read, distinct from the Workspace creation receipt. */
export interface NewsletterOutreachStage {
    id: string;
    documentId: string;
    revision: number;
    name: string;
    config: NewsletterCampaignConfig;
    design: NewsletterDesign;
}
export interface NewsletterOutreachVersion extends OutreachDraftVersionDto {
    recipientEmail: string;
}
export interface NewsletterOutreachTest {
    id: string;
    requestKey: string;
    senderConnectionId: string;
    versionId: string;
}
export interface NewsletterOutreachRecord {
    id: string;
    /** The persisted Core field is a string, not a closed UI lifecycle enum. */
    status: string;
    name: string;
    stage: NewsletterOutreachStage;
    targets: NewsletterJsonObject[];
    senderConnectionId: string | null;
    subject: string;
    versions: NewsletterOutreachVersion[];
    intentId: string | null;
    excluded: string[];
    tests: NewsletterOutreachTest[];
}
export interface NewsletterReservedMetadata {
    newsletterStageId?: string;
    newsletterRevision?: number;
}
export type NewsletterRecordDiscriminator = {
    kind: 'ordinary';
    metadata: NewsletterReservedMetadata;
} | {
    kind: 'rich';
    metadata: NewsletterReservedMetadata & {
        newsletterStageId: string;
    };
};
export type NewsletterReceiveResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: {
        code: 'invalid_json' | 'invalid_shape' | 'limit_exceeded' | 'identity_mismatch';
        path: string;
    };
};
export interface NewsletterReceiveIdentity {
    documentId?: string;
    stageId?: string;
    recordId?: string;
    revision?: number;
    clientId?: string | null;
}
/**
 * Wire-snapshot budgets, independent of request normalization. String capacity includes large
 * image URLs, rendered HTML and a 100-document list; these are explicit receiving limits.
 * Design collections additionally use the current Workspace 500-block/6-level limits.
 */
export declare const NEWSLETTER_RECEIVE_LIMITS: Readonly<{
    jsonDepth: 64;
    jsonNodes: 2000000;
    objectKeys: 10000;
    arrayLength: 100000;
    stringLength: 200000000;
    totalStringLength: 1000000000;
}>;
/** Create, GET and CAS-save all return the same direct campaign shape; no wrapper is accepted. */
export declare function parseNewsletterCampaign(value: unknown, expected?: Pick<NewsletterReceiveIdentity, 'documentId' | 'revision' | 'clientId'>): NewsletterReceiveResult<NewsletterCampaign>;
export declare function parseNewsletterDocumentList(value: unknown): NewsletterReceiveResult<NewsletterDocumentList>;
export declare function parseNewsletterChecks(value: unknown): NewsletterReceiveResult<NewsletterCheck[]>;
/** HTML is wire text here. Rendering in a browser still requires the consumer's sanitation boundary. */
export declare function parseNewsletterPreview(value: unknown): NewsletterReceiveResult<NewsletterPreview>;
export declare function parseNewsletterHtmlCheck(value: unknown, expected?: Pick<NewsletterReceiveIdentity, 'revision'>): NewsletterReceiveResult<NewsletterHtmlCheck>;
export declare function parseNewsletterStageReceipt(value: unknown, expected?: Pick<NewsletterReceiveIdentity, 'stageId' | 'documentId' | 'revision'>): NewsletterReceiveResult<NewsletterStage>;
export declare function parseNewsletterOutreachStage(value: unknown, expected?: Pick<NewsletterReceiveIdentity, 'stageId' | 'documentId' | 'revision' | 'clientId'>): NewsletterReceiveResult<NewsletterOutreachStage>;
export declare function parseNewsletterOutreachRecord(value: unknown, expected?: NewsletterReceiveIdentity): NewsletterReceiveResult<NewsletterOutreachRecord>;
/** Unrelated metadata is deliberately projected away. Null/absent metadata has no rich hint. */
export declare function parseNewsletterReservedMetadata(value: unknown): NewsletterReceiveResult<NewsletterReservedMetadata>;
/** Wrong-type rich hints fail before a generic plain-text writer can select the record. */
export declare function parseNewsletterRecordDiscriminator(value: unknown): NewsletterReceiveResult<NewsletterRecordDiscriminator>;
//# sourceMappingURL=newsletter-receiving.d.ts.map