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
