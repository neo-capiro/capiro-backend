/**
 * Business Development Phase 5 — watch/alert PURE DOMAIN TYPES.
 *
 * Deterministic, provider-agnostic contract for prospect watch diffs and
 * alerts. This module and its companion bizdev-watch-diff.ts deliberately
 * import NOTHING from the application, Prisma, HTTP clients, or any provider
 * package: Phase 5 reads EXISTING canonical projections (FederalAward,
 * FederalAssistanceAward, SamOpportunity / TangoResourceSnapshot, LdaFiling,
 * and the acquisition revision ledger) through adapters owned by later
 * packets. Dates are ISO-8601 strings so the contract stays serializable and
 * free of Prisma/runtime coupling.
 *
 * The golden rules encoded here:
 *   * normalize MEANING, never retrieval timestamps or raw key order —
 *     fetchedAt / lastSyncedAt / providerFetchedAt / raw payload noise must
 *     never surface as an alert;
 *   * an ambiguous identity resolves to REVIEW/SKIP, never a confident alert;
 *   * every alert carries a stable semantic fingerprint and dedupe key so the
 *     tenant-level uniques make redelivery impossible.
 */

// ── Closed vocabularies (SQL CHECK constraints mirror these exactly) ──────

export type BizDevWatchStatus = 'active' | 'paused' | 'ended';

/** Existing canonical projections only — no provider is added in Phase 5. */
export type BizDevWatchSourceFamily =
  | 'federal_award'
  | 'federal_assistance_award'
  | 'sam_opportunity'
  | 'tango_resource'
  | 'lda_filing'
  | 'acquisition_revision';

/** Per-watch, per-source runner health. 'partial'/'error' never advance a
 *  complete cursor (lastSuccessfulCompleteCheckAt / sourceWatermark). */
export type BizDevWatchSourceHealth =
  | 'pending'
  | 'healthy'
  | 'partial'
  | 'error'
  | 'stale'
  | 'paused';

export type BizDevAlertChangeKind =
  | 'new_record'
  | 'material_update'
  | 'correction'
  | 'backfill';

export type BizDevAlertMateriality = 'high' | 'medium' | 'low';

export type BizDevAlertReviewState = 'open' | 'review' | 'suppressed';

/** Coarse alert category derived from the source family, stored per alert so
 *  category preferences stay stable even if family mapping evolves. */
export type BizDevAlertCategory =
  | 'contract_award'
  | 'assistance_award'
  | 'opportunity'
  | 'lobbying'
  | 'acquisition'
  | 'entity_change'
  | 'other';

// ── Normalized source observation (pure data) ─────────────────────────────

/** JSON scalar/recursive value as stored in JSONB columns. */
export type BizDevJsonValue =
  | string
  | number
  | boolean
  | null
  | BizDevJsonValue[]
  | { [key: string]: BizDevJsonValue };

/**
 * Allowlisted MATERIAL fields per source family. Anything not on the list —
 * fetchedAt, lastSyncedAt, raw payloads, provider fetch metadata, internal
 * sync bookkeeping — is dropped BEFORE any comparison and can never produce
 * an alert. Adapters may only project these keys from the canonical rows;
 * the diff trusts but verifies (unknown material keys are ignored at diff
 * time too, so a sloppy adapter cannot invent alerts either).
 */
export const BIZDEV_WATCH_MATERIAL_FIELD_ALLOWLIST: Readonly<
  Record<BizDevWatchSourceFamily, readonly string[]>
> = {
  federal_award: [
    'awardUniqueId',
    'piid',
    'fain',
    'awardingAgency',
    'awardingSubTier',
    'contractorName',
    'recipientUei',
    'amount',
    'peCode',
    'dodAcqProgramCode',
    'fundingTas',
    'programActivityCode',
    'popState',
    'popCongressionalDistrict',
    'actionDate',
    'awardedAt',
    'baseAwardSignedDate',
    'latestActionDate',
    'popStartDate',
    'popEndDate',
    'description',
  ],
  federal_assistance_award: [
    'assistanceId',
    'recipientName',
    'recipientUei',
    'awardingAgency',
    'amount',
    'actionDate',
    'startDate',
    'endDate',
    'description',
  ],
  sam_opportunity: [
    'noticeId',
    'solicitationNumber',
    'title',
    'noticeType',
    'baseType',
    'agency',
    'subAgency',
    'office',
    'setAside',
    'setAsideCode',
    'pscCode',
    'naicsCode',
    'postedDate',
    'responseDeadline',
    'archiveDate',
    'active',
    'sourceUrl',
  ],
  tango_resource: [
    'resourceType',
    'externalId',
    'title',
    'name',
    'status',
    'amount',
    'postedAt',
    'deadlineAt',
    'sourceUpdatedAt',
    'sourceUrl',
    'description',
  ],
  lda_filing: [
    'filingUuid',
    'filingType',
    'filingYear',
    'filingPeriod',
    'income',
    'expenses',
    'dtPosted',
    'registrantId',
    'registrantName',
    'clientId',
    'clientName',
    'clientState',
    'issueCodes',
    'filingDocumentUrl',
  ],
  // The existing acquisition revision ledger keys records by revision; the
  // allowlist keeps stage/status/date/amount semantics exact.
  acquisition_revision: [
    'recordKey',
    'stage',
    'status',
    'amount',
    'effectiveAt',
    'publishedAt',
    'programCode',
    'office',
    'description',
  ],
};

/** Fields that are RETRIEVAL NOISE by definition: never material, never
 *  compared, always safe to ignore wherever they appear. */
export const BIZDEV_WATCH_HARMLESS_FIELD_ALLOWLIST: ReadonlySet<string> =
  new Set(['fetchedAt', 'lastSyncedAt', 'providerFetchedAt', 'raw', 'rawJsonb']);

/**
 * One normalized observation of one EXTERNAL record from a canonical
 * projection. `recordId` is the stable source identifier (e.g. the USAsping
 * generated_unique_award_id, SAM noticeId, LDA filing_uuid, Tango
 * (resourceType, externalId), or revision ledger record key). Identity is
 * EXPLICIT: adapters must set identityConfidence honestly; a low value
 * routes to human review instead of a confident alert.
 */
export interface BizDevSourceObservation {
  sourceFamily: BizDevWatchSourceFamily;
  /** Stable source record identifier — never null for a diffable record. */
  recordId: string;
  /**
   * EXACT usable source locator (a real URL). REQUIRED — never descriptive
   * text. USAspending/SAM/LDA records get deterministic source URLs; Tango
   * and acquisition-revision adapters must supply the provider's own URL.
   */
  sourceLocator: string;
  /** Optional provider/source revision (ledger revision, content sha, …). */
  sourceRevision?: string | null;
  /** 0..1. Below IDENTITY_CONFIDENCE_REVIEW_THRESHOLD the diff returns
   *  'review' instead of an alert — INCLUDING during a baseline pass: an
   *  ambiguous observation must never become a trusted baseline fact. 1 =
   *  exact allowlisted-key match. */
  identityConfidence?: number;
  /** When the source says the record was published/modified, if it says. */
  publishedAt?: string | null;
  /** When the change is factually effective (action date, filing period…). */
  effectiveAt?: string | null;
  /** When the underlying event occurred, when distinguishable. */
  eventAt?: string | null;
  /** Exact allowlisted material fields only. */
  material: Record<string, BizDevJsonValue>;
}

// ── Baseline (per watch, per source family) ──────────────────────────────

/** QA-safe reason recorded on a baseline candidate suppressed from delivery. */
export type BizDevSuppressionReasonCode =
  | 'backfill'
  | 'category_not_selected'
  | 'watch_paused'
  | 'watch_muted'
  | 'prospect_conflict_excluded'
  | 'prospect_dismissed';

/** Baseline entry for ONE record inside a watch's source baseline. */
export interface BizDevWatchBaselineRecord {
  recordId: string;
  sourceRevision?: string | null;
  /** Monotonic sequence of accepted content states for this record within
   *  this watch: 0 at quiet baseline, incremented ONLY when content changes
   *  (i.e. exactly when an alert is produced). Persisted atomically with
   *  the alert + baseline, so replay-before-commit computes the same
   *  sequence/keys and a future A→B after B→A gets a larger sequence —
   *  the semantic fingerprint can never collide with an older transition. */
  semanticSequence?: number;
  /** CONTENT fingerprint: identity of the record's allowlisted material
   *  content. Baseline equality compares THIS; it is NOT the alert
   *  fingerprint. */
  fingerprint: string;
  effectiveAt?: string | null;
  publishedAt?: string | null;
  /** Present only when this accepted candidate was intentionally not
   * delivered. Stored in the existing tenant-private baseline JSON so QA can
   * sample quiet decisions without creating a second alert stream. */
  suppressionReason?: BizDevSuppressionReasonCode;
  /** Optional allowlisted material snapshot at baseline time. When present
   *  the diff produces exact per-field before/after states; when absent the
   *  alert carries the after state and per-field before is reported as
   *  unknown (never invented). */
  material?: Record<string, BizDevJsonValue>;
}

/**
 * The per-source baseline the runner persists in WatchSourceState.baselineState
 * and feeds back into the diff on the next pass. `records` is keyed by
 * recordId and MAY legitimately be empty: `initialized: true` with zero
 * records is an ESTABLISHED quiet baseline (e.g. a successful scan found
 * nothing) — the next new record alerts as new_record. `initialized: false`
 * (or a null/undefined baseline object) means "not baselined yet": the first
 * pass records records WITHOUT alerting (quiet initial baseline).
 */
export interface BizDevWatchBaseline {
  /** False until the runner has completed one successful baseline scan. */
  initialized: boolean;
  /** ISO timestamp of the baseline pass — records seen BEFORE this that only
   *  surface later are classified as 'backfill', not 'new_record'. */
  establishedAt: string;
  /** Optional explicit floor (e.g. previous watermark date). Falls back to
   *  establishedAt when absent. */
  effectiveFloorAt?: string | null;
  records: Readonly<Record<string, BizDevWatchBaselineRecord>>;
}

// ── Diff output ───────────────────────────────────────────────────────────

export type BizDevDiffOutcome =
  /** First pass: record the baseline, produce NO alert (quiet baseline). */
  | 'baseline'
  /** A material change worth surfacing (alertDraft is present). */
  | 'alert'
  /** No material change (harmless noise, identical content, key order). */
  | 'no_alert'
  /** Identity ambiguous — queue for human review, no confident alert. */
  | 'review'
  /** Malformed/unusable observation — skip silently, record the reason. */
  | 'skip';

export interface BizDevMaterialFieldChange {
  field: string;
  /** JSON-safe values only. Missing is represented as null, never undefined. */
  before: BizDevJsonValue;
  after: BizDevJsonValue;
}

/**
 * A complete, persistable alert draft. The runner stores this verbatim; the
 * `implication` field is EXPLICITLY labeled inference — it carries the
 * diff's deterministic human-language gloss, and the UI must present it as
 * inference, never as source fact.
 */
export interface BizDevAlertDraft {
  sourceFamily: BizDevWatchSourceFamily;
  category: BizDevAlertCategory;
  changeKind: BizDevAlertChangeKind;
  materiality: BizDevAlertMateriality;
  recordId: string;
  sourceRevision?: string | null;
  /** SEMANTIC CHANGE fingerprint: SHA-256 over prior content fingerprint,
   *  new content fingerprint, change kind and source revision. Distinct
   *  from the content fingerprint: a later A→B→A→B recurrence gets a NEW
   *  semantic fingerprint each time the content legitimately changes back,
   *  so it is never silently suppressed, while unchanged content (with new
   *  retrieval timestamps/revisions) never alerts at all. */
  fingerprint: string;
  /** Tenant-delivery dedupe key (family + record + fingerprint). */
  dedupeKey: string;
  beforeState: BizDevJsonValue;
  afterState: BizDevJsonValue;
  changes: BizDevMaterialFieldChange[];
  title: string;
  summary: string;
  /** Deterministic inference gloss — ALWAYS labeled inference downstream. */
  implication: string;
  /** Exact source locator (URL and/or canonical projection pointer). */
  sourceLocator: string;
  eventAt?: string | null;
  effectiveAt?: string | null;
  publishedAt?: string | null;
}

export interface BizDevWatchDiffResult {
  outcome: BizDevDiffOutcome;
  /** Present when outcome === 'alert'. */
  alertDraft?: BizDevAlertDraft;
  /** Baseline entry the runner should upsert for this record (present for
   *  'baseline', 'alert', 'no_alert' — every successfully processed record). */
  baselineUpdate?: BizDevWatchBaselineRecord;
  /** Human-readable reason for 'review' / 'skip' outcomes (internal only). */
  reason?: string;
}

/** Category default per source family. */
export const BIZDEV_ALERT_CATEGORY_BY_FAMILY: Readonly<
  Record<BizDevWatchSourceFamily, BizDevAlertCategory>
> = {
  federal_award: 'contract_award',
  federal_assistance_award: 'assistance_award',
  sam_opportunity: 'opportunity',
  tango_resource: 'entity_change',
  lda_filing: 'lobbying',
  acquisition_revision: 'acquisition',
};

/** Below this identity confidence the diff refuses to alert and returns
 *  'review'. Deliberately conservative: a wrong-identity alert is worse than
 *  a missing one. Checked BEFORE any baseline acceptance — ambiguous
 *  observations never become trusted baseline facts. */
export const BIZDEV_IDENTITY_CONFIDENCE_REVIEW_THRESHOLD = 0.6;

/** Deterministic EXACT source URLs for the canonical projections that have
 *  stable public pages. Adapters MUST use these (or the provider's own URL
 *  for Tango/ledger records); descriptive text is never a locator. */
export function bizdevSourceLocator(
  sourceFamily: BizDevWatchSourceFamily,
  recordId: string,
  fallbackUrl?: string | null,
): string {
  if (fallbackUrl && /^https?:\/\//i.test(fallbackUrl)) return fallbackUrl;
  switch (sourceFamily) {
    case 'federal_award':
    case 'federal_assistance_award':
      return `https://www.usaspending.gov/award/${encodeURIComponent(recordId)}`;
    case 'sam_opportunity':
      return `https://sam.gov/opp/${encodeURIComponent(recordId)}/view`;
    case 'lda_filing':
      return `https://lda.senate.gov/system/lod/${encodeURIComponent(recordId)}`;
    default:
      // tango_resource / acquisition_revision adapters must supply the
      // provider's own URL via fallbackUrl; without one the diff SKIPs.
      return '';
  }
}
