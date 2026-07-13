/**
 * District-impact one-pager (Phase 1 M1.5, PD6) — an alert-memo variant
 * grounded in the District Impact Engine (M1's `RepresentationResolverService`)
 * instead of the client's Memory files alone. Works identically for a federal
 * bill alert or a state bill alert: the alert shape is the SAME
 * `AlertMemoAlertInput` the Feed already passes to `/alert-memo` — only the
 * grounding claims differ (facility + representation, not just the alert).
 */
export interface DistrictBriefResult {
  title: string;
  /** full brief as markdown (for the composer + edit) */
  markdown: string;
  sections: Array<{ heading: string; paragraphs: Array<{ text: string; claimIds: string[] }> }>;
  sources: Array<{ claimId: string; label: string; url?: string | null }>;
  /** the EngagementAttachment (client Documents) the brief was auto-filed as */
  document: { attachmentId: string; fileName: string } | null;
  usedTenantKey: boolean;
  model: string;
  /** true when grounding dropped everything and we fell back to a scaffold */
  lowConfidence: boolean;
  memoryFilesUsed: string[];
  /**
   * true when the grounding auditor HELD the brief (enforce mode + finding):
   * generated + returned for review but NOT auto-filed; a pending review_request
   * carries it until an admin/assigned reviewer approves (`document` is null).
   */
  held: boolean;
  /** which facility this brief covers, for the composer header */
  facility: { id: string; name: string; city: string | null; state: string | null };
}
