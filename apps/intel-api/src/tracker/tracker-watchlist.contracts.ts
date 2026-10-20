/**
 * Read/write API for the UNIFIED tracker watchlist (Phase 2, plan §5.2).
 *
 * Operates on the deterministic-id watchlist `wl:<clientId>` + its topics/terms
 * and the per-user `intel_alert_preference`. Both carry FORCE ROW LEVEL
 * SECURITY (`20260706010000_intel_full_rls_hold`) scoped to `tenant_id`; every
 * query additionally filters by the TenantGuard-resolved `tenantId` in app
 * code (belt-and-braces, not the only defense). All routes are gated by
 * `tracker_owner_intel` (TrackerOwnerGuard, 404 when off), so during shadow
 * only the internal tenant can write here — apps/api stays source of truth (D6).
 */
export interface TrackerTermInput {
  termType: string;
  value: string;
}

export interface TrackerTopicInput {
  label: string;
  issueArea?: string | null;
  position?: string;
  priority?: string;
  terms?: TrackerTermInput[];
  /**
   * P0-03 item 5: the topic's PREVIOUS label, sent when the user renamed this tag.
   * The reconcile renames in place so the topic id — and therefore its terms and
   * any `WatchlistMatch.termId` reference to them — survives the rename. Absent
   * on a create or an unchanged topic.
   */
  renameFrom?: string;
}

export interface PutWatchlistInput {
  issueAreas?: string[];
  topics?: TrackerTopicInput[];
  /** State Legislation Platform (DD5) — empty = federal-only (unchanged default); non-empty also matches those states' bill corpus. */
  jurisdictions?: string[];
  /**
   * P1-02: optimistic-concurrency token — the `version` the client last read.
   * ABSENT is accepted (and logged): an un-updated browser bundle must not have
   * every save hard-broken the moment this deploys.
   */
  expectedVersion?: number;
}

export interface WatchlistView {
  clientId: string;
  issueAreas: string[];
  jurisdictions: string[];
  topics: Array<{
    /**
     * Gate K (MP-08): stable server id, so the web can key a tag by identity
     * instead of array position/label. Present on every PERSISTED topic;
     * absent only for the synthetic "Hearing terms" fold-back topic when no
     * such topic has ever been saved yet (it has no row to carry an id).
     */
    id?: string;
    label: string;
    issueArea: string | null;
    position: string;
    priority: string;
    terms: Array<{ termType: string; value: string; id?: string }>;
  }>;
  /**
   * P6 sector-default: the sector-derived issue area for a NEVER-configured client
   * (no `wl:` row), surfaced as a read-time SUGGESTION so a cold client isn't
   * blank. Never written on read, absent once a row exists (parity-safe — parity
   * compares persisted rows, not this hint).
   */
  suggestedIssueAreas?: string[];
  /** Same posture, for state jurisdictions (S5.1) — derived from client_facilities.state, shown only while the client's own jurisdictions are empty. */
  suggestedJurisdictions?: string[];
  /**
   * P0-03/P0-05: what the server refused to persist on the write that produced this
   * view, so the editor can show inline validation instead of the user believing a
   * blank tag or a 2-char fragment was saved. Absent on a pure GET.
   */
  rejected?: {
    topics: Array<{ index: number; label: string; reason: string }>;
    terms: Array<{ topicLabel: string; termType: string; value: string; reason: string }>;
  };
  /**
   * P1-02 optimistic concurrency. Targeting is SHARED firm-wide and the editor
   * autosaves the whole payload, so two analysts on one client used to silently
   * overwrite each other. The client echoes this back as `expectedVersion`; a
   * stale one gets a 409. `0` for a never-configured client, which is what makes
   * the first PUT's `expectedVersion: 0` correct against a row that does not exist.
   */
  version: number;
  /**
   * DISPLAY NAME of the last writer, resolved from `users`. The raw Clerk id is
   * deliberately absent from this shape, so the client physically cannot render it
   * (`user_2abc…` is worse than no attribution at all). Null when the writer has no
   * name on file, or when the caller skipped the lookup — `getCompiled` does, to
   * keep the recommendations hot path free of a users query.
   */
  updatedByName: string | null;
  updatedAt: string | null;
}

/** One row of the shared-targeting change log (P1-02). */
export interface WatchlistRevisionView {
  version: number;
  changedBy: string | null;
  createdAt: string;
  summary: unknown;
}

export interface PutAlertPrefsInput {
  triggers?: string[];
  materiality?: string;
  emailEnabled?: boolean;
  emailAddress?: string | null;
  emailCadence?: string;
  smsEnabled?: boolean;
  smsPhone?: string | null;
  smsCadence?: string;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  /** State Legislation Platform (DD5) — empty = ALL jurisdictions the client's watchlist produces. */
  jurisdictions?: string[];
}

// ── Normalize the payload into the desired state (step 3) ────────────────
export interface IncomingTopic {
  index: number;
  label: string;
  issueArea: string | null;
  position: string;
  priority: string;
  terms: Array<{ termType: string; value: string }>;
  renameFrom?: string;
  /** Set when a rename collided with a live label (§4.5): apply nothing. */
  skipped?: boolean;
}
export interface WatchlistReadPolicy {
  readonly uuid: RegExp;
  readonly hearingLabel: () => string;
}
export interface WatchlistReconcilePolicy {
  readonly requiredFrom: Date;
  readonly hearingLabel: () => string;
  readonly reservedLabel: (label: string) => boolean;
}
export interface WatchlistReadTopic {
  id: string;
  label: string;
  issueArea: string | null;
  position: string;
  priority: string;
}
export interface WatchlistReadTerm {
  id: string;
  topicId: string | null;
  termType: string;
  value: string;
}
export type RejectedTopics = NonNullable<WatchlistView['rejected']>['topics'];
export type RejectedTerms = NonNullable<WatchlistView['rejected']>['terms'];
export interface WatchlistReconcileContext {
  tenantId: string;
  clientId: string;
  userId: string;
  wlId: string;
  input: PutWatchlistInput;
  issueAreas: string[];
  jurisdictions: string[];
  incoming: IncomingTopic[];
  rejectedTopics: RejectedTopics;
  rejectedTerms: RejectedTerms;
}
export type WatchlistTopicIndex = Map<string, { id: string; label: string }>;
export type WatchlistTermIndex = Map<string, Set<string>>;
export type WatchlistTermKey = (term: {
  termType: string;
  value: string;
  weight: number;
}) => string;
