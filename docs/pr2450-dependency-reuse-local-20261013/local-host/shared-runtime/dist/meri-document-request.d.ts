export interface MeriDocumentRequest {
    request: string;
    completeRead: boolean;
    contacts: boolean;
}
/**
 * The API appends each attachment's extracted text to the user's turn
 * ("Attached document …", filing references, unavailable notices, and the
 * compaction carry-over). Request classification must use what the user typed:
 * file text is data, and its words ("all", "list", "strategy", "$M") are not
 * the user's request.
 */
export declare function stripAppendedAttachmentText(text: string): string;
/** A location correction continues the preceding request, not a new assignment.
 * Only user text participates; document text and assistant guesses are excluded. */
export declare function isMeriDocumentLocationClarification(text: string): boolean;
export declare function resolveMeriDocumentRequest(messages: readonly {
    role?: unknown;
    text?: unknown;
}[]): MeriDocumentRequest | null;
//# sourceMappingURL=meri-document-request.d.ts.map