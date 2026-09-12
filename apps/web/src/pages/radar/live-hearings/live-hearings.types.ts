export type HearingChamber = 'HOUSE' | 'SENATE' | 'JOINT' | 'NO_CHAMBER' | string;
export type HearingEventStatus =
  | 'SCHEDULED'
  | 'RESCHEDULED'
  | 'POSTPONED'
  | 'CANCELED'
  | 'LIVE'
  | 'COMPLETED'
  | 'UNKNOWN'
  | string;
export type HearingPublicAccessStatus =
  | 'PUBLIC'
  | 'CLOSED'
  | 'CLASSIFIED'
  | 'NOT_STREAMED'
  | 'UNKNOWN'
  | string;
export type HearingCapturePolicy =
  | 'SERVER_CAPTURE_ALLOWED'
  | 'BROWSER_CAPTURE_ONLY'
  | 'LICENSE_REQUIRED'
  | 'BLOCKED'
  | 'REVIEW_REQUIRED'
  | string;
export type HearingStreamState =
  | 'NOT_CHECKED'
  | 'WAITING_FOR_STREAM'
  | 'READY'
  | 'LIVE'
  | 'ENDED'
  | 'NO_PUBLIC_STREAM'
  | 'BROWSER_ONLY'
  | 'POLICY_BLOCKED'
  | 'SOURCE_ERROR'
  | string;
export type HearingCaptureStatus =
  | 'NOT_SCHEDULED'
  | 'SCHEDULED'
  | 'PREPARING'
  | 'WAITING_FOR_BROADCAST'
  | 'RECORDING'
  | 'RECOVERING'
  | 'COMPLETE'
  | 'COMPLETE_WITH_GAPS'
  | 'FAILED'
  | 'CANCELED'
  | string;

export interface HearingCommitteeRef {
  id?: string;
  systemCode?: string;
  name: string;
  chamber?: HearingChamber;
  parentId?: string;
  parentName?: string;
}

export interface HearingMember {
  id: string;
  name: string;
  party?: string;
  state?: string;
  role?: string;
  rank?: number;
  profileUrl?: string;
}

export interface HearingWitness {
  id?: string;
  name: string;
  title?: string;
  organization?: string;
}

export interface HearingDocument {
  deadlines?: string[];
  contentHash?: string;
  id?: string;
  title: string;
  documentType?: string;
  sourceUrl: string;
  publishedAt?: string;
}

export interface HearingSiteUpdate {
  id: string;
  updateType: string;
  title: string;
  summary?: string;
  sourceUrl?: string;
  publishedAt?: string;
  firstSeenAt?: string;
  previousValue?: unknown;
  newValue?: unknown;
}

export interface HearingCaptureView {
  id?: string;
  status: HearingCaptureStatus;
  capturePolicy?: HearingCapturePolicy;
  streamState?: HearingStreamState;
  scheduledStart?: string;
  captureStartedAt?: string;
  captureEndedAt?: string;
  reconnectCount?: number;
  gapSeconds?: number;
  failureReason?: string;
}

export interface HearingSubscriptionView {
  scheduled: boolean;
  followed?: boolean;
  notifyOnStart?: boolean;
  notifyOnMention?: boolean;
  scheduledByUser?: boolean;
  scheduledByRule?: boolean;
}

export interface HearingIntelligenceEntity {
  entityType: string;
  label: string;
  canonicalId?: string;
}

export interface HearingIntelligenceItem {
  id: string;
  insightType:
    | 'QUESTION'
    | 'COMMITMENT'
    | 'DEADLINE'
    | 'FUNDING_AMOUNT'
    | 'BILL_REFERENCE'
    | 'PROGRAM_ELEMENT_REFERENCE'
    | 'AGENCY_REFERENCE'
    | 'POLICY_POSITION'
    | 'KEY_QUOTE'
    | 'MENTION'
    | string;
  title: string;
  summary: string;
  evidenceText?: string;
  segmentId?: string;
  startMs?: number;
  endMs?: number;
  speakerName?: string;
  confidence?: number;
  preliminary?: boolean;
  entities?: HearingIntelligenceEntity[];
  createdAt?: string;
}

/** Envelope from the phase8 intelligence route — status/jobs MUST reach the UI
 *  so it never claims "no intelligence was extracted" while extraction is
 *  pending (PR B §8/§9). Legacy consumers that destructure only the array keep
 *  working: HearingIntelligenceEnvelope extends Array. */
export interface HearingIntelligenceEnvelope extends Array<HearingIntelligenceItem> {
  status?: 'READY' | 'PROCESSING' | 'DEGRADED' | 'FAILED' | 'EMPTY' | string;
  jobs?: { public?: Record<string, number>; tenant?: Record<string, number> };
  total?: number;
}

export interface PublicTranscriptSegment {
  id: string;
  sequence: number;
  startMs: number;
  endMs: number;
  text: string;
  speakerName?: string;
  speakerLabel?: string;
  confidence?: number;
  isFinal: boolean;
  gapBefore?: boolean;
}

export interface CanonicalHearingEvent {
  geographicJurisdiction?: string;
  legislativeSession?: string;
  stateCommitteeId?: string;
  calendarRevision?: number;
  calendarCheckedAt?: string;
  calendarCheckState?: string;
  timePrecision?: string;
  following?: boolean;
  agenda?: Array<{
    key: string;
    position: number;
    kind: string;
    title: string;
    sourceUrl: string;
    bill?: { id: string; scope: string; jurisdiction: string; session: string };
  }>;
  id: string;
  canonicalEventId?: string;
  congress?: number;
  title: string;
  chamber: HearingChamber;
  eventType: string;
  eventStatus: HearingEventStatus;
  publicAccessStatus: HearingPublicAccessStatus;
  scheduledStart?: string;
  actualStart?: string;
  actualEnd?: string;
  timeZone?: string;
  location?: string;
  officialPageUrl?: string;
  lastOfficialUpdate?: string;
  streamState: HearingStreamState;
  coverageStatus?: string;
  capturePolicy?: HearingCapturePolicy;
  committee: HearingCommitteeRef;
  subcommittee?: HearingCommitteeRef;
  witnessCount?: number;
  documentCount?: number;
  witnesses?: HearingWitness[];
  documents?: HearingDocument[];
  members?: HearingMember[];
  updates?: HearingSiteUpdate[];
  capture?: HearingCaptureView;
  subscription?: HearingSubscriptionView;
  intelligence?: HearingIntelligenceItem[];
  /**
   * Official Eastern calendar day `YYYY-MM-DD` from the canonical `date`
   * column (LW-QA-001). Display/bucketing ONLY — never parse it as an instant.
   * For date-only hearings (no scheduledStart) this is the authoritative day.
   */
  calendarDate?: string;
}

export interface LiveHearingCalendarPage {
  items: CanonicalHearingEvent[];
  total: number;
  nextCursor?: string | null;
  sourceHealth?: {
    complete?: boolean;
    healthy?: number;
    expected?: number;
    degraded?: number;
    failing?: number;
    reviewRequired?: number;
  };
}

export interface HearingCommitteeRoom {
  committee: HearingCommitteeRef;
  jurisdiction?: string;
  officialSiteUrl?: string;
  chair?: HearingMember;
  rankingMember?: HearingMember;
  members: HearingMember[];
  subcommittees: HearingCommitteeRef[];
  upcomingEvents: CanonicalHearingEvent[];
  recentEvents: CanonicalHearingEvent[];
  updates: HearingSiteUpdate[];
  sourceHealth?: string;
  lastSuccessfulSync?: string;
}

export interface PublicTranscriptPage {
  items: PublicTranscriptSegment[];
  total: number;
  nextCursor?: string | null;
  hasMore?: boolean;
}

/**
 * One official committee source as the coverage/source-health drawer renders
 * it. Every field is a real column off `committee_source` (or a best-effort
 * join / most-recent-candidate derivation) — see live-hearings.service.ts
 * `coverage()`. A null `recentCapturePolicy`/`recentResolutionState` means no
 * stream candidate has ever cited this source; render that truthfully rather
 * than guessing a status.
 */
export interface CommitteeSourceCoverage {
  id: string;
  committeeSystemCode?: string;
  committeeName?: string;
  chamber: string;
  sourceType: string;
  sourceUrl: string;
  adapterKey: string;
  enabled: boolean;
  priority: number;
  sourceHealth: string;
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  recentCapturePolicy?: string;
  recentResolutionState?: string;
}

export interface CommitteeSourceCoverageSummary {
  total: number;
  healthy: number;
  degraded: number;
  failing: number;
  unknown: number;
}

export interface LiveHearingsCoverage {
  summary: CommitteeSourceCoverageSummary;
  sources: CommitteeSourceCoverage[];
}
