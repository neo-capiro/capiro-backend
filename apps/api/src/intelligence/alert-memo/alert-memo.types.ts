/**
 * Alert → client-memo generation (§ actionable recommendations plan).
 *
 * The alert originates in intel-api's unified Feed; the frontend passes its
 * salient content here so apps/api can generate a client-voiced, source-grounded
 * memo. apps/api is where the pieces live: the client Memory files (voice/
 * priorities/red-lines), per-tenant AI keys, docx rendering, and the client
 * Documents store. Generation is STATELESS: we produce the memo, auto-file it in
 * the client's Documents, and return it. The alert↔memo link/state is owned by
 * intel-api (intel_draft).
 */

/** A transcript/quote mention carried from a hearing alert. */
export interface AlertMemoQuote {
  text: string;
  speaker?: string;
  /** seconds offset into the hearing, if known */
  atSec?: number;
}

/** The salient alert content the memo is grounded in (passed from the Feed). */
export interface AlertMemoAlertInput {
  alertId: string;
  sourceType: 'bill' | 'hearing' | 'combined';
  /** headline, e.g. "H.R. 8800: Rule granted (floor scheduled)" */
  title: string;
  /** deterministic "why it matters to {client}" from the detector */
  whyItMatters?: string | null;
  severity?: string | null;
  band?: string | null;
  /** bill id / hearing session id the alert points at */
  sourceRef?: string | null;
  billDisplayNum?: string | null;
  billTitle?: string | null;
  /** the triggering official action text (bill alerts) */
  actionText?: string | null;
  actionDate?: string | null;
  committee?: string | null;
  hearingTitle?: string | null;
  /** matched hearing quotes (hearing/combined alerts) */
  quotes?: AlertMemoQuote[];
  /** public source URL (congress.gov event / bill) */
  url?: string | null;
  /** matched watchlist tags / issue areas */
  matchedTags?: string[];
}

export interface AlertMemoResult {
  title: string;
  /** full memo as markdown (for the composer + edit) */
  markdown: string;
  /** structured sections, each paragraph tagged with the claim ids it used */
  sections: Array<{ heading: string; paragraphs: Array<{ text: string; claimIds: string[] }> }>;
  /** cited sources: claim id → human label + url */
  sources: Array<{ claimId: string; label: string; url?: string | null }>;
  /** the EngagementAttachment (client Documents) the memo was auto-filed as */
  document: { attachmentId: string; fileName: string } | null;
  usedTenantKey: boolean;
  model: string;
  /** true when grounding dropped everything and we fell back to a scaffold */
  lowConfidence: boolean;
  /** which client Memory files steered the voice (audit + "context used" UI) */
  memoryFilesUsed: string[];
}
