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

/**
 * Program Element funding-movement facts (P0-08). Present only for
 * sourceType='program_element'. Every amount is in MILLIONS and every figure is
 * pre-computed upstream — the model is never asked to do budget arithmetic.
 *
 * `verification` and `linkedRef` are accepted but NOT yet emitted by intel-api's PE
 * change detector (it writes peCode/title/fiscalYear/deltaType/deltaTypeLabel/
 * fromRef/toRef/amounts/deltas/href). Their claims simply do not fire until a writer
 * supplies them.
 */
export interface AlertMemoProgramElement {
  peCode: string;
  title?: string | null;
  fiscalYear?: number | null;
  deltaType?: string | null;
  deltaTypeLabel?: string | null;
  fromRef?: string | null;
  toRef?: string | null;
  amountFromMillions?: number | null;
  amountToMillions?: number | null;
  deltaMillions?: number | null;
  deltaPct?: number | null;
  verification?: string | null;
  linkedRef?: string | null;
  href?: string | null;
}

/**
 * Agency rulemaking facts (§4.5). Present only for sourceType='regulation'. intel-api
 * writes these FLAT and normalizes them into one nested block on read
 * (normalize-evidence.ts), which is what makes a regulation memo groundable at all.
 */
export interface AlertMemoRegulation {
  ruleTitle?: string | null;
  agency?: string | null;
  /** e.g. 'Proposed Rule' | 'Rule' — drives the proposed-vs-final distinction. */
  ruleType?: string | null;
  commentEndDate?: string | null;
  effectiveDate?: string | null;
  docketId?: string | null;
  url?: string | null;
}

/**
 * State legislative deadline context (§4.5). The state-deadline emitter writes
 * cutoffDate/cutoffType/daysUntil (bill-change-detector.service.ts:793-797), which land
 * in the normalized evidence's `extra`.
 */
export interface AlertMemoDeadline {
  cutoffType?: string | null;
  cutoffDate?: string | null;
  daysUntil?: number | null;
}

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
  sourceType: 'bill' | 'hearing' | 'combined' | 'program_element' | 'state_bill' | 'regulation';
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
  /** P0-08: the funding facts a PE alert carries. Only for sourceType='program_element'. */
  programElement?: AlertMemoProgramElement;
  /** §4.5: 2-letter state code, or 'US' for federal. Drives the state-bill framing. */
  jurisdiction?: string | null;
  /** §4.5: state cutoff/crossover context, when the alert is a deadline warning. */
  deadline?: AlertMemoDeadline | null;
  /** §4.5: agency rulemaking facts. Only for sourceType='regulation'. */
  regulation?: AlertMemoRegulation;
}

export interface AlertMemoResult {
  title: string;
  /** full memo as markdown (for the composer + edit) */
  markdown: string;
  /** structured sections, each paragraph tagged with the claim ids it used */
  sections: Array<{ heading: string; paragraphs: Array<{ text: string; claimIds: string[] }> }>;
  /**
   * Cited sources: claim id → human label + url, plus (§4.6) when it was retrieved and
   * how well it is attested. `verification` is never 'verified' — nothing verifies these
   * today and an inflated label is worse than none.
   */
  sources: Array<{
    claimId: string;
    label: string;
    url?: string | null;
    retrievedAt?: string;
    verification?: 'official' | 'verified' | 'extracted' | 'unverified';
    page?: number;
  }>;
  /** the EngagementAttachment (client Documents) the memo was auto-filed as */
  document: { attachmentId: string; fileName: string } | null;
  usedTenantKey: boolean;
  model: string;
  /** true when grounding dropped everything and we fell back to a scaffold */
  lowConfidence: boolean;
  /** which client Memory files steered the voice (audit + "context used" UI) */
  memoryFilesUsed: string[];
  /**
   * §4.6: context the compiler SAW and withheld, with the reason (revoked / superseded /
   * expired / empty / over-budget). The packet always carried this; loadSteering used to
   * discard it, so the composer could show what steered a memo but not what did not.
   */
  contextExcluded: Array<{ title: string; reason: string }>;
  /**
   * true when the post-hoc auditor HELD the memo (enforce mode + a grounding
   * finding): the markdown is returned for review but was NOT auto-filed to the
   * client's Documents (document === null). Always false under shadow/annotate/
   * off, so the default flow is unaffected. (Phase 2.5-1.)
   */
  held: boolean;
  /** The pending review_request created when held, so the composer can link to it. Null unless held. */
  reviewRequestId: string | null;
  /** Human-readable auditor findings that caused the hold. Empty string unless held. */
  heldReason: string;
}
