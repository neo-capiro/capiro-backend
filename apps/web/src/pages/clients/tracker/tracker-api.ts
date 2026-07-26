/**
 * Typed client + query keys for the client-profile Tracker tab.
 * Types mirror apps/api/src/tracker/tracker.types.ts.
 */

export type BillStage = 'introduced' | 'committee' | 'passed' | 'enacted';
export type ChangeTone = 'critical' | 'notable' | 'info' | 'success';
export type MatchReasonKind = 'keyword' | 'semantic' | 'entity' | 'subject' | 'issue_code';

export interface BoardBillChange {
  tone: ChangeTone;
  label: string;
  dot?: boolean;
}
export interface BoardBill {
  billId: string;
  displayNum: string;
  title: string;
  stage: BillStage;
  probability: number;
  tags: string[];
  isManual: true;
  trackedAt: string;
  unread: boolean;
  change: BoardBillChange | null;
  // Phase 9 (Bill→Hearing interlink): "discussed in N hearings" chip. Optional —
  // only the intel board (adaptBoard) populates it; the legacy board omits it.
  hearingCount?: number;
  lastHearingSessionId?: string | null;
  /** State Legislation Platform (S7.2) — 2-letter state code; absent/'US' = federal. */
  jurisdiction?: string;
  // Bill 360 (R2 §2.4): intel-api ALREADY returns these on every board card;
  // adaptBoard used to drop them on the floor. Optional so the legacy board and
  // any cached pre-R2 board response still render (§5 edge case 12).
  /** Latest official action text (Congress.gov / LegiScan verbatim). */
  latestActionText?: string | null;
  /** Latest official action date, ISO `YYYY-MM-DD`. */
  latestActionDate?: string | null;
  /** The analyst note on the tracked row (legacy `note` column). */
  note?: string | null;
}
export interface BoardColumn {
  id: BillStage;
  label: string;
  count: number;
  bills: BoardBill[];
}
export interface BoardResponse {
  columns: BoardColumn[];
  total: number;
}

export interface MatchReason {
  kind: MatchReasonKind;
  detail: string;
}
export interface RecommendationBill {
  billId: string;
  displayNum: string;
  title: string;
  stage: BillStage;
  probability: number;
  fit: number;
  belowFloor: boolean;
  matchedTags: string[];
  matchReasons: MatchReason[];
  whyKind: MatchReasonKind;
  why: string;
  latestAction: string | null;
  latestActionDate: string | null;
  sponsorName: string | null;
  sponsorParty: string | null;
  cosponsorsCount: number;
  /** State Legislation Platform (S7.2) — 2-letter state code; absent/'US' = federal. */
  jurisdiction?: string;
}
export interface RecommendationsResponse {
  recommendations: RecommendationBill[];
  aboveFloorCount: number;
  total: number;
  floor: number;
}

export type TagPriority = 'low' | 'med' | 'high';
export type TagPosition = 'support' | 'oppose' | 'monitor';

/**
 * The canonical set of watchlist term types (plan §5.2). These are the types the
 * unified editor exposes and the intel matcher/hearing compiler consume.
 *
 * The three implicit inputs on the Configure panel — Synonyms, Related entities,
 * Risk terms — persist as the LEGACY term types `synonym` / `entity` / `risk`
 * (see intel-tracker-api adapters). Those legacy types therefore still exist in
 * stored data and must round-trip; they are intentionally NOT in this list (the
 * chip inputs own them). Anything else (a canonical type below, or an unknown
 * hearing-native type) rides in `WatchlistTag.typedTerms` losslessly.
 */
export const TERM_TYPES = [
  'bill',
  'agency',
  'committee',
  'legislator',
  'company',
  'competitor',
  'topic',
  'risk_phrase',
  'support_language',
  'opposition_language',
  'program_element',
] as const;
export type TermType = (typeof TERM_TYPES)[number];

/** Human labels for the canonical term types (editor Select). */
export const TERM_TYPE_LABELS: Record<string, string> = {
  bill: 'Bill',
  agency: 'Agency',
  committee: 'Committee',
  legislator: 'Legislator',
  company: 'Company',
  competitor: 'Competitor',
  topic: 'Topic',
  risk_phrase: 'Risk phrase',
  support_language: 'Support language',
  opposition_language: 'Opposition language',
  program_element: 'Program element',
};

/** A single typed term (one of the 11 canonical types, or an unknown legacy/hearing type). */
export interface TypedTerm {
  termType: string;
  value: string;
}

export interface WatchlistTag {
  tag: string;
  issueArea?: string | null;
  /** Legacy `synonym`-typed terms (the "Synonyms" chip input). */
  synonyms: string[];
  /** Legacy `entity`-typed terms (the "Related entities" chip input). */
  relatedEntities: string[];
  /** Legacy `risk`-typed terms (the "Risk terms" chip input). */
  riskTerms: string[];
  /**
   * Every OTHER term type on this topic — the 11 canonical types plus any unknown
   * hearing-native type — kept verbatim so nothing is lost across a save. The
   * three legacy buckets above and this list together are the complete term set.
   */
  typedTerms: TypedTerm[];
  position?: TagPosition;
  priority: TagPriority;
  /**
   * P0-03 item 5: the tag's persisted name, captured on the FIRST keystroke of a
   * rename, so the server renames the topic in place (keeping its id, its terms,
   * and their createdAt) instead of deleting it and creating a new one. Never set
   * on a fresh read — `adaptWatchlist` does not emit it, so reloading clears it.
   * intel-api only; the legacy tracker replaces the whole watchlist anyway.
   */
  renameFrom?: string;
}
export interface WatchlistPayload {
  issueAreas: string[];
  tags: WatchlistTag[];
  /**
   * Sector-derived issue-area default for a never-configured client (P6). Present
   * only when the client has NO persisted watchlist row; the editor surfaces it
   * as a pre-selection suggestion. Not a persisted field — a read-time hint.
   */
  suggestedIssueAreas?: string[];
  /**
   * State Legislation Platform (S7.2, DD5) — 2-letter state codes this client's
   * watchlist also matches against. Empty/absent = federal-only (unchanged
   * default behavior).
   */
  jurisdictions?: string[];
  /** Sector/facility-derived jurisdiction suggestion (S5.1) — same read-time-hint posture as suggestedIssueAreas. */
  suggestedJurisdictions?: string[];
  /**
   * P0-03/P0-05: what the server refused to persist on the write that produced
   * this payload, so the editor can show inline validation instead of the user
   * believing a blank tag or a too-short term was saved. Absent on a pure GET.
   */
  rejected?: {
    topics: Array<{ index: number; label: string; reason: string }>;
    terms: Array<{ topicLabel: string; termType: string; value: string; reason: string }>;
  };
}

export type Materiality = 'low' | 'medium' | 'high';
export type EmailCadence = 'realtime' | 'daily' | 'weekly';
export type SmsCadence = 'realtime' | 'daily';
export interface AlertPrefsPayload {
  triggers: string[];
  materiality: Materiality;
  emailEnabled: boolean;
  emailAddress: string | null;
  emailCadence: EmailCadence;
  smsEnabled: boolean;
  smsPhone: string | null;
  smsPhoneVerified: boolean;
  smsCadence: SmsCadence;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  /** State Legislation Platform (S7.1, DD5) — empty = ALL jurisdictions the client's watchlist produces. */
  jurisdictions?: string[];
}

export interface BillSearchResult {
  billId: string;
  displayNum: string;
  title: string;
  stage: BillStage;
  probability: number;
}

export interface SeedSuggestions {
  tags: WatchlistTag[];
  issueAreas: string[];
}

export interface TrackerSummary {
  boardCount: number;
  unread: number;
}

const enc = encodeURIComponent;
const base = (clientId: string) => `/api/intelligence/clients/${enc(clientId)}/tracker`;

export const trackerPaths = {
  board: (c: string) => `${base(c)}/board`,
  summary: (c: string) => `${base(c)}/summary`,
  track: (c: string) => `${base(c)}/track`,
  untrack: (c: string, billId: string) => `${base(c)}/track/${enc(billId)}`,
  billSearch: (c: string) => `${base(c)}/bill-search`,
  recommendations: (c: string) => `${base(c)}/recommendations`,
  feedback: (c: string) => `${base(c)}/feedback`,
  watchlist: (c: string) => `${base(c)}/watchlist`,
  seedSuggestions: (c: string) => `${base(c)}/watchlist/seed-suggestions`,
  alertPrefs: (c: string) => `${base(c)}/alert-prefs`,
  smsStart: (c: string) => `${base(c)}/sms/verify/start`,
  smsConfirm: (c: string) => `${base(c)}/sms/verify/confirm`,
  testAlert: (c: string) => `${base(c)}/test-alert`,
  issueAreas: () => `/api/intelligence/issue-areas`,
};

export const trackerKeys = {
  board: (c: string) => ['tracker-board', c] as const,
  summary: (c: string) => ['tracker-summary', c] as const,
  recommendations: (c: string) => ['tracker-recommendations', c] as const,
  watchlist: (c: string) => ['tracker-watchlist', c] as const,
  compiled: (c: string) => ['tracker-compiled', c] as const,
  seed: (c: string) => ['tracker-seed', c] as const,
  alertPrefs: (c: string) => ['tracker-alert-prefs', c] as const,
  issueAreas: () => ['tracker-issue-areas'] as const,
};

/** Probability band → meter class (matches the mockup). */
export function probClass(p: number): 'hi' | 'mid' | 'lo' {
  const pct = p > 1 ? p : p * 100;
  return pct >= 70 ? 'hi' : pct >= 40 ? 'mid' : 'lo';
}

export const TRIGGER_LABELS: Record<string, string> = {
  newMatch: 'New matched bill',
  amendment: 'Amendment / text changed',
  hearing: 'Hearing scheduled',
  committeeVote: 'Committee vote / passed committee',
  floorVote: 'Floor vote / passed chamber',
  enactedFailed: 'Enacted or failed',
  fiscalNote: 'New fiscal note',
  sponsorMomentum: 'Sponsor / cosponsor momentum',
  companion: 'Companion bill moved',
  deadline: 'Deadline approaching (state bills)',
};
export const TRIGGER_ORDER = [
  'newMatch',
  'amendment',
  'hearing',
  'committeeVote',
  'floorVote',
  'enactedFailed',
  'fiscalNote',
  'sponsorMomentum',
  'companion',
  'deadline',
];
