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
}
export interface RecommendationsResponse {
  recommendations: RecommendationBill[];
  aboveFloorCount: number;
  total: number;
  floor: number;
}

export type TagPriority = 'low' | 'med' | 'high';
export type TagPosition = 'support' | 'oppose' | 'monitor';
export interface WatchlistTag {
  tag: string;
  issueArea?: string | null;
  synonyms: string[];
  relatedEntities: string[];
  riskTerms: string[];
  position?: TagPosition;
  priority: TagPriority;
}
export interface WatchlistPayload {
  issueAreas: string[];
  tags: WatchlistTag[];
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
}

export interface BillSearchResult {
  billId: string;
  displayNum: string;
  title: string;
  stage: BillStage;
  probability: number;
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
];
