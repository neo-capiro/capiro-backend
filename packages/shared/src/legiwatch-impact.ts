/** Shared Core contract. Exposure is analysis; position remains an analyst decision. */
export type LegiWatchImpactDirection = 'positive' | 'negative' | 'mixed' | 'uncertain';
export type LegiWatchImpactStatus = 'ready' | 'needs_evidence' | 'unavailable';
export type LegiWatchConfidence = 'high' | 'medium' | 'low';
export interface LegiWatchCitation {
  sourceId: string;
  sourceUrl: string | null;
  label: string;
  quote: string;
  locator: string;
  revision: string;
}
export interface LegiWatchClientFact {
  id: string;
  kind: 'product' | 'location' | 'program' | 'supplier' | 'threshold' | 'profile';
  label: string;
  value: string;
  revision: string;
  citations: LegiWatchCitation[];
}
export interface LegiWatchBillVersion {
  id: string;
  label: string;
  sourceUrl: string | null;
  publishedAt: string | null;
  contentHash: string;
  completeness: string;
  current: boolean;
}
export interface LegiWatchImpactFinding {
  title: string;
  direction: LegiWatchImpactDirection;
  mechanism: string;
  confidence: LegiWatchConfidence;
  provisions: LegiWatchCitation[];
  clientFacts: LegiWatchCitation[];
  conditions: string[];
  missingFacts: string[];
  nextAction: string;
}
export interface LegiWatchImpactAnalysis {
  status: LegiWatchImpactStatus;
  summary: string;
  direction: LegiWatchImpactDirection;
  confidence: LegiWatchConfidence;
  findings: LegiWatchImpactFinding[];
  missingFacts: string[];
  analyzedAt: string | null;
  inputFingerprint: string | null;
  stale: boolean;
  staleReason: string | null;
  model: string | null;
}
export interface LegiWatchTrackerRow {
  clientId: string;
  clientName: string;
  billId: string;
  displayNum: string;
  title: string;
  jurisdiction: string;
  status: string | null;
  stage: 'introduced' | 'committee' | 'passed' | 'enacted' | null;
  passageProbability: number | null;
  latestActionText: string | null;
  latestActionDate: string | null;
  sourceUrl: string | null;
  trackedAt: string;
  note: string | null;
  position: string | null;
  priority: string | null;
  trackerBackend: 'core' | 'intelligence';
  impact: LegiWatchImpactAnalysis;
}
export interface LegiWatchTrackerPage {
  trackerBackend: 'core' | 'intelligence';
  rows: LegiWatchTrackerRow[];
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
  clients: Array<{ id: string; name: string }>;
  asOf: string;
}
export interface LegiWatchImpactDetail {
  row: LegiWatchTrackerRow;
  actions: Array<{ date: string | null; text: string; sourceUrl: string | null }>;
  versions: LegiWatchBillVersion[];
  clientFacts: LegiWatchClientFact[];
  sourceCoverage: { billText: boolean; clientFacts: boolean; notes: string[] };
  refresh?: {
    state: 'queued' | 'running' | 'idle' | 'failed';
    requestedAt: string | null;
    nextCheckAt: string | null;
    errorCode: string | null;
  } | null;
}
