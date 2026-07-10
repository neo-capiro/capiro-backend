/**
 * Shared types + constants for the client-profile Tracker tab.
 * Mirrored by the web client in apps/web/src/pages/clients/tracker/tracker-api.ts.
 */
import type { BillStage } from './bill-stage.util.js';

// Capiro-managed issue-area taxonomy (a superset of the sector labels) lives in
// @capiro/shared so sectors ↔ issue areas have a single source of truth and
// relate by identity. Re-exported here so existing tracker imports are stable.
export { ISSUE_AREAS } from '@capiro/shared';

/** Alert-trigger keys (each maps to a deterministic change-detection rule). */
export const ALERT_TRIGGERS: readonly string[] = [
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

export const DEFAULT_TRIGGERS: readonly string[] = [
  'newMatch',
  'amendment',
  'hearing',
  'committeeVote',
  'floorVote',
  'enactedFailed',
  'companion',
];

export type TagPriority = 'low' | 'med' | 'high';
export type TagPosition = 'support' | 'oppose' | 'monitor';

/** A single client-authored watchlist tag (a "watchlist object", per the brief). */
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

export type MatchReasonKind = 'keyword' | 'semantic' | 'entity' | 'subject' | 'issue_code';

export interface MatchReason {
  kind: MatchReasonKind;
  detail: string;
}

export type ChangeTone = 'critical' | 'notable' | 'info' | 'success';

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
  probability: number; // 0..1
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

export interface RecommendationBill {
  billId: string;
  displayNum: string;
  title: string;
  stage: BillStage;
  probability: number; // 0..1
  fit: number; // 0..1 composite relevance score
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

export interface BillSearchResult {
  billId: string;
  displayNum: string;
  title: string;
  stage: BillStage;
  probability: number;
}
