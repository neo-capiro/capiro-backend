import type {
  LegiWatchPhase9BodyStatus,
  LegiWatchPhase9EvidenceSource,
  LegiWatchPhase9Gate,
  LegiWatchPhase9Mode,
  LegiWatchPhase9RunStatus,
} from './legiwatch-phase9.types.js';

export const TERMINAL_CAPTURE_STATES = new Set([
  'COMPLETE',
  'COMPLETE_WITH_GAPS',
  'FAILED',
  'CANCELED',
  'BLOCKED',
]);

export const TERMINAL_RESOLUTION_STATES = new Set([
  'READY',
  'LIVE',
  'ENDED',
  'NO_PUBLIC_STREAM',
  'POLICY_BLOCKED',
]);

export interface Phase9BodyClassificationInput {
  sourcesRegistered: number;
  sourcesHealthy: number;
  sourcesFailing: number;
  /// Count of this body's sources that are failing AND have a currently
  /// active, reviewed committee_source_exception row (generic — never keyed
  /// on source identity). These are excluded from `sourcesFailing`, so a
  /// reviewed, accepted access-block does not read as an unexplained defect.
  sourcesAcceptedException?: number;
  officialObservations: number;
  pendingObservations: number;
}

export interface Phase9CaptureOutcomeInput {
  captureStatus?: string | null;
  terminalReasonCode?: string | null;
  failureCode?: string | null;
  candidates: Array<{
    capturePolicy: string;
    resolutionState: string;
    failureReason?: string | null;
  }>;
}

export interface Phase9RuntimeFreshnessInput {
  enabled: boolean;
  scheduleEnabled: boolean;
  status: string;
  maxLagSeconds: number | null;
  lastHeartbeatAt: Date | null;
  now: Date;
}

export function percentage(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Number(((Math.max(0, numerator) / denominator) * 100).toFixed(2));
}

export function normalizeFingerprintPart(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function canonicalEventFingerprint(input: {
  chamber: string;
  committeeSystemCode?: string | null;
  subcommitteeSystemCode?: string | null;
  title: string;
  startsAt?: Date | null;
  calendarDate: Date;
}): string {
  const instant = input.startsAt
    ? input.startsAt.toISOString().slice(0, 16)
    : input.calendarDate.toISOString().slice(0, 10);
  return [
    normalizeFingerprintPart(input.chamber),
    normalizeFingerprintPart(input.subcommitteeSystemCode ?? input.committeeSystemCode),
    instant,
    normalizeFingerprintPart(input.title),
  ].join('\u001f');
}

export function classifyBodyCoverage(
  input: Phase9BodyClassificationInput,
): { status: LegiWatchPhase9BodyStatus; reasonCode: string; reason: string } {
  if (input.sourcesRegistered === 0) {
    return {
      status: 'UNAVAILABLE',
      reasonCode: 'NO_REGISTERED_SOURCE_PATH',
      reason: 'No direct, inherited parent, or chamber-wide official source is registered.',
    };
  }
  if (input.pendingObservations > 0) {
    return {
      status: 'REVIEW_REQUIRED',
      reasonCode: 'PENDING_OFFICIAL_OBSERVATIONS',
      reason: `${input.pendingObservations} official observation(s) still lack a canonical or explicit conflict disposition.`,
    };
  }
  if (input.sourcesHealthy === 0 && input.sourcesFailing > 0) {
    return {
      status: 'DEGRADED',
      reasonCode: 'ALL_SOURCE_PATHS_FAILING',
      reason: 'Every registered official source path is currently failing or degraded.',
    };
  }
  if (
    input.sourcesHealthy === 0 &&
    input.sourcesFailing === 0 &&
    (input.sourcesAcceptedException ?? 0) > 0
  ) {
    return {
      status: 'HEALTHY_WITH_ACCEPTED_EXCEPTION',
      reasonCode: 'ALL_SOURCE_PATHS_ACCEPTED_EXCEPTION',
      reason:
        'Every registered official source path is currently failing, but each failure has a ' +
        'reviewed, accepted exception (e.g. an upstream access block with no compliant ' +
        'alternative) rather than an unexplained defect.',
    };
  }
  if (input.sourcesHealthy === 0) {
    return {
      status: 'DEGRADED',
      reasonCode: 'SOURCE_HEALTH_NOT_PROVEN',
      reason: 'A source path exists, but no recent successful probe proves it healthy.',
    };
  }
  if (input.officialObservations === 0) {
    return {
      status: 'HEALTHY_NO_EVENTS_OBSERVED',
      reasonCode: 'SOURCE_HEALTHY_NO_EVENT_EVIDENCE',
      reason: 'The source path is healthy, but the audit window contains no official event observation.',
    };
  }
  if (input.sourcesFailing > 0) {
    return {
      status: 'DEGRADED',
      reasonCode: 'REDUNDANT_SOURCE_PATH_DEGRADED',
      reason: 'At least one official source is healthy, but another registered path is degraded.',
    };
  }
  return {
    status: 'HEALTHY',
    reasonCode: 'SOURCE_AND_EVENT_EVIDENCE_HEALTHY',
    reason: 'Official source health and observation disposition are explicit for this body.',
  };
}

export function assessCaptureOutcome(input: Phase9CaptureOutcomeInput): {
  complete: boolean;
  reasonCode: string;
} {
  const captureStatus = (input.captureStatus ?? '').toUpperCase();
  if (TERMINAL_CAPTURE_STATES.has(captureStatus)) {
    const reason = input.terminalReasonCode?.trim() || input.failureCode?.trim();
    return reason
      ? { complete: true, reasonCode: reason }
      : { complete: false, reasonCode: 'TERMINAL_CAPTURE_WITHOUT_REASON' };
  }

  if (!input.candidates.length) {
    return { complete: false, reasonCode: 'NO_STREAM_CANDIDATE_OR_CAPTURE_OUTCOME' };
  }

  const serverAllowed = input.candidates.some(
    (candidate) => candidate.capturePolicy === 'SERVER_CAPTURE_ALLOWED',
  );
  if (serverAllowed) {
    return { complete: false, reasonCode: 'SERVER_CAPTURE_ELIGIBLE_WITHOUT_TERMINAL_OUTCOME' };
  }

  const allExplicit = input.candidates.every((candidate) => {
    const policy = candidate.capturePolicy;
    const terminalPolicy = [
      'BROWSER_CAPTURE_ONLY',
      'LICENSE_REQUIRED',
      'BLOCKED',
    ].includes(policy);
    const terminalResolution = TERMINAL_RESOLUTION_STATES.has(candidate.resolutionState);
    return terminalPolicy && (terminalResolution || Boolean(candidate.failureReason?.trim()));
  });
  return allExplicit
    ? { complete: true, reasonCode: 'EXPLICIT_NON_SERVER_CAPTURE_DISPOSITION' }
    : { complete: false, reasonCode: 'STREAM_POLICY_STILL_REQUIRES_REVIEW' };
}

export function isRuntimeJobFresh(input: Phase9RuntimeFreshnessInput): boolean {
  if (!input.enabled || !input.scheduleEnabled) return false;
  if (input.status === 'failed' || input.status === 'disabled') return false;
  if (!input.lastHeartbeatAt || !input.maxLagSeconds) return false;
  return input.now.getTime() - input.lastHeartbeatAt.getTime() <= input.maxLagSeconds * 1_000;
}

export const CORE_READINESS_EVIDENCE_TYPES = [
  'RECOVERY_GAP',
  'DUPLICATE_SUPPRESSION',
  'BROWSER_FALLBACK',
  'POLICY_BLOCK',
  'TENANT_RLS',
  'INTELLIGENCE_LATENCY',
] as const;

export const CUTOVER_EVIDENCE_TYPES = [
  'LIVE_DISCOVERY',
  'LIVE_RESOLUTION',
  'LIVE_CAPTURE',
  'LIVE_DEEPGRAM',
  'RECOVERY_GAP',
  'WORKER_CRASH_RECOVERY',
  'NETWORK_RECOVERY',
  'DEEPGRAM_RECOVERY',
  'DUPLICATE_SUPPRESSION',
  'CONCURRENT_CAPTURES',
  'DELAYED_START',
  'CANCELLATION',
  'RESCHEDULE',
  'SOURCE_ROTATION',
  'COMMITTEE_SITE_CHANGE',
  'BROWSER_FALLBACK',
  'POLICY_BLOCK',
  'SILENCE_HANDLING',
  'SPEAKER_ATTRIBUTION',
  'TENANT_RLS',
  'INTELLIGENCE_LATENCY',
  'ROLLBACK',
] as const;

export function requiredEvidenceTypes(mode: LegiWatchPhase9Mode): readonly string[] {
  if (mode === 'CUTOVER_VERIFICATION') return CUTOVER_EVIDENCE_TYPES;
  if (mode === 'READINESS' || mode === 'CANARY') return CORE_READINESS_EVIDENCE_TYPES;
  return [];
}

export function evidenceSourceSatisfiesCutover(
  source: LegiWatchPhase9EvidenceSource,
): boolean {
  return source === 'LIVE' || source === 'MIXED';
}

export function deriveRunStatus(input: {
  mode: LegiWatchPhase9Mode;
  evidenceSource: LegiWatchPhase9EvidenceSource;
  officialObservations: number;
  canonicalEvents: number;
  gates: readonly LegiWatchPhase9Gate[];
}): LegiWatchPhase9RunStatus {
  if (
    input.evidenceSource === 'NONE' ||
    input.officialObservations === 0 ||
    input.canonicalEvents === 0
  ) {
    return 'BLOCKED';
  }
  const failedRequired = input.gates.some(
    (gate) => gate.required && gate.status !== 'PASS',
  );
  return failedRequired ? 'FAIL' : 'PASS';
}
