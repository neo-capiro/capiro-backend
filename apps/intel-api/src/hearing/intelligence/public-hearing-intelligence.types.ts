export const PUBLIC_HEARING_INSIGHT_TYPES = [
  'QUESTION',
  'COMMITMENT',
  'DEADLINE',
  'FUNDING_AMOUNT',
  'BILL_REFERENCE',
  'PROGRAM_ELEMENT_REFERENCE',
  'AGENCY_REFERENCE',
  'POLICY_POSITION',
  'KEY_QUOTE',
  'MENTION',
] as const;

export type PublicHearingInsightType = (typeof PUBLIC_HEARING_INSIGHT_TYPES)[number];

export interface PublicHearingEntity {
  entityType:
    | 'BILL'
    | 'PROGRAM_ELEMENT'
    | 'AGENCY'
    | 'AMOUNT'
    | 'DATE'
    | 'PERSON'
    | 'ORGANIZATION'
    | 'OTHER';
  label: string;
  canonicalId?: string;
}

export interface PublicTranscriptSegmentInput {
  id: string;
  captureId: string;
  hearingId: string;
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

export interface PublicHearingContext {
  hearingId: string;
  geographicJurisdiction?: string | null;
  legislativeSession?: string | null;
  resolvedBills?: Array<{ id: string; number: string }>;
  title: string;
  chamber?: string;
  committeeId?: string;
  committeeName?: string;
  subcommitteeId?: string;
  subcommitteeName?: string;
  publicWitnesses?: Array<{
    id?: string;
    name: string;
    organization?: string;
  }>;
}

export interface PublicHearingInsightDraft {
  insightType: PublicHearingInsightType;
  title: string;
  summary: string;
  evidenceText?: string;
  speakerName?: string;
  confidence?: number;
  preliminary?: boolean;
  entities?: PublicHearingEntity[];
}

export interface PublicHearingInsight extends PublicHearingInsightDraft {
  id: string;
  hearingId: string;
  captureId: string;
  segmentId: string;
  sequence: number;
  startMs: number;
  endMs: number;
  extractor: string;
  extractorVersion: string;
  createdAt: string;
}

export interface PublicHearingInsightExtractor {
  readonly name: string;
  readonly version: string;
  extract(input: {
    segment: PublicTranscriptSegmentInput;
    context: PublicHearingContext;
  }): Promise<PublicHearingInsightDraft[]>;
}

export interface PublicHearingInsightSink {
  upsertMany(insights: readonly PublicHearingInsight[]): Promise<void>;
}

export interface PublicHearingInsightProcessingResult {
  insights: PublicHearingInsight[];
  extractorFailures: Array<{
    extractor: string;
    message: string;
  }>;
}

export interface TenantHearingClientContext {
  clientId: string;
  clientName?: string;
  keywords: string[];
  billIds: string[];
  programElementIds: string[];
  agencies: string[];
  committees: string[];
}

export interface TenantHearingRelevanceContext {
  tenantId: string;
  clients: TenantHearingClientContext[];
}

export interface TenantHearingRelevance {
  id: string;
  tenantId: string;
  clientId: string;
  clientName?: string;
  hearingId: string;
  insightId: string;
  score: number;
  matchedOn: Array<{
    kind: 'KEYWORD' | 'BILL' | 'PROGRAM_ELEMENT' | 'AGENCY' | 'COMMITTEE';
    value: string;
  }>;
  rationale: string;
  createdAt: string;
}

export interface TenantHearingRelevanceContextProvider {
  contextsForHearing(hearingId: string): Promise<TenantHearingRelevanceContext[]>;
}

export interface TenantHearingRelevanceSink {
  upsertMany(matches: readonly TenantHearingRelevance[]): Promise<void>;
}
