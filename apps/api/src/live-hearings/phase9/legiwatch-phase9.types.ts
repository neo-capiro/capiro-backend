export const LEGIWATCH_PHASE9_EVIDENCE_SOURCES = [
  'LIVE',
  'OFFICIAL_ARCHIVE',
  'LOCAL_FIXTURE',
  'MIXED',
  'NONE',
] as const;

export type LegiWatchPhase9EvidenceSource =
  (typeof LEGIWATCH_PHASE9_EVIDENCE_SOURCES)[number];

export const LEGIWATCH_PHASE9_MODES = [
  'SHADOW',
  'CANARY',
  'READINESS',
  'CUTOVER_VERIFICATION',
  'ROLLBACK_VERIFICATION',
] as const;

export type LegiWatchPhase9Mode = (typeof LEGIWATCH_PHASE9_MODES)[number];

export type LegiWatchPhase9RunStatus = 'PASS' | 'FAIL' | 'BLOCKED';
export type LegiWatchPhase9GateStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_APPLICABLE';
export type LegiWatchPhase9CutoverPhase =
  | 'SHADOW'
  | 'CANARY'
  | 'READY'
  | 'CUTOVER'
  | 'ROLLBACK';

export type LegiWatchPhase9BodyStatus =
  | 'HEALTHY'
  | 'HEALTHY_NO_EVENTS_OBSERVED'
  | 'HEALTHY_WITH_ACCEPTED_EXCEPTION'
  | 'DEGRADED'
  | 'REVIEW_REQUIRED'
  | 'UNAVAILABLE';

export type LegiWatchPhase9AuditScope = 'RUN' | 'BODY' | 'OBSERVATION' | 'EVENT';

export interface LegiWatchPhase9AuditOptions {
  now?: Date;
  lookbackDays?: number;
  lookaheadDays?: number;
  captureGraceMinutes?: number;
  intelligenceLagMinutes?: number;
  evidenceSource: LegiWatchPhase9EvidenceSource;
  mode?: LegiWatchPhase9Mode;
}

export interface LegiWatchPhase9BodyCoverage {
  systemCode: string;
  name: string;
  chamber: string;
  parentSystemCode: string | null;
  isSubcommittee: boolean;
  sourceInheritance: 'DIRECT' | 'PARENT' | 'CENTRAL' | 'NONE';
  sourcesRegistered: number;
  sourcesHealthy: number;
  sourcesFailing: number;
  lastSourceSuccessAt: string | null;
  hearingsObserved: number;
  officialObservations: number;
  representedObservations: number;
  explicitConflicts: number;
  pendingObservations: number;
  streamCandidates: number;
  serverCaptureCandidates: number;
  captureOutcomes: number;
  status: LegiWatchPhase9BodyStatus;
  reasonCode: string;
  reason: string;
}

export interface LegiWatchPhase9Gate {
  key: string;
  status: LegiWatchPhase9GateStatus;
  required: boolean;
  measured: number | string | boolean | null;
  target: number | string | boolean;
  reasonCode: string;
  message: string;
}

export interface LegiWatchPhase9Exception {
  scope?: LegiWatchPhase9AuditScope;
  hearingId?: string;
  observationId?: string;
  committeeSystemCode?: string;
  gateKey: string;
  status: 'FAIL' | 'CONFLICT' | 'NOT_APPLICABLE';
  reasonCode: string;
  details: Record<string, unknown>;
}

export interface LegiWatchPhase9Counts {
  parentBodies: number;
  subcommitteeBodies: number;
  totalBodies: number;
  officialObservations: number;
  representedObservations: number;
  explicitConflicts: number;
  ignoredInvalidObservations: number;
  pendingObservations: number;
  canonicalEvents: number;
  canonicalEventsWithProvenance: number;
  legacyOnlyCanonicalEvents: number;
  duePublicEvents: number;
  eligibleEvents: number;
  eventsWithOutcomes: number;
  duplicateCanonicalEvents: number;
  duplicateGlobalCaptures: number;
  unresolvedEvents: number;
  captureFailures: number;
  capturesWithGaps: number;
  gapsWithoutMarkers: number;
  duplicateTranscriptSequences: number;
  staleJobs: number;
  laggingIntelligenceJobs: number;
}

export interface LegiWatchPhase9ReadinessReport {
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  mode: LegiWatchPhase9Mode;
  evidenceSource: LegiWatchPhase9EvidenceSource;
  status: LegiWatchPhase9RunStatus;
  counts: LegiWatchPhase9Counts;
  percentages: {
    bodyStatusExplicit: number;
    observationDisposition: number;
    canonicalProvenance: number;
    captureOutcome: number;
  };
  gates: LegiWatchPhase9Gate[];
  bodies: LegiWatchPhase9BodyCoverage[];
  blockers: string[];
  exceptions: LegiWatchPhase9Exception[];
  summary: {
    sourceCoverageReady: boolean;
    officialCorpusRepresented: boolean;
    capturePathReady: boolean;
    transcriptContinuityReady: boolean;
    workersFresh: boolean;
    intelligenceFresh: boolean;
    cutoverEligible: boolean;
  };
}

export interface LegiWatchPhase9PersistedRun {
  id: string;
  mode: LegiWatchPhase9Mode;
  status: LegiWatchPhase9RunStatus;
  evidenceSource: LegiWatchPhase9EvidenceSource;
  createdAt: string;
}

export interface LegiWatchPhase9RolloutState {
  phase: LegiWatchPhase9CutoverPhase;
  productionDefault: boolean;
  schedulesEnabled: boolean;
  killSwitchEngaged: boolean;
  captureAllPublicEvents: boolean;
  minimumConsecutivePasses: number;
  minimumShadowHours: number;
  consecutivePasses: number;
  shadowStartedAt: string;
  canaryStartedAt: string | null;
  cutoverAt: string | null;
  rollbackAt: string | null;
  lastRunId: string | null;
  lastPassingRunId: string | null;
  updatedBy: string;
  updatedAt: string;
}

export interface LegiWatchPhase9RuntimeJob {
  jobKey: string;
  jobType: string;
  status: string;
  enabled: boolean;
  scheduleEnabled: boolean;
  expectedIntervalSeconds: number | null;
  maxLagSeconds: number | null;
  lastStartedAt: string | null;
  lastHeartbeatAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFinishedAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  metrics: Record<string, unknown>;
  stale: boolean;
}

export const LEGIWATCH_PHASE9_REQUIRED_JOB_KEYS = [
  'central-discovery',
  'committee-enrichment',
  'committee-updates',
  'source-probe',
  'coverage-audit',
  'stream-preflight',
  'capture-worker',
  'archive-reconciliation',
  'intelligence-worker',
  'parallel-comparison',
  'metrics',
] as const;

export const LEGIWATCH_PHASE9_CONFIRMATIONS = {
  CANARY: 'ENABLE LEGIWATCH CANARY',
  READY: 'MARK LEGIWATCH READY',
  CUTOVER: 'CUT OVER LEGIWATCH LIVE HEARINGS',
  ROLLBACK: 'ROLL BACK LEGIWATCH LIVE HEARINGS',
  SCHEDULES_ON: 'ENABLE LEGIWATCH SCHEDULES',
  SCHEDULES_OFF: 'DISABLE LEGIWATCH SCHEDULES',
  CAPTURE_ALL_ON: 'ENABLE LEGIWATCH CAPTURE ALL',
  CAPTURE_ALL_OFF: 'DISABLE LEGIWATCH CAPTURE ALL',
} as const;
